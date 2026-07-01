'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain,
  shell, session, screen, net, powerMonitor, dialog, Notification, safeStorage
} = require('electron');
const path = require('path');
const fs = require('fs');
const { URL, pathToFileURL } = require('url');
const tcp = require('net');   // Node TCP, for reachability probe

// Optional auto-updater (only meaningful in the packaged app). Lazy + guarded
// so the app still runs even if the dependency isn't installed (e.g. fresh dev
// checkout before `npm install`).
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { autoUpdater = null; }

// ---------------------------------------------------------------------------
// Single instance lock — clicking the tray / relaunching focuses the one window
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Config store (plain JSON in the OS user-data dir, no extra dependency)
// ---------------------------------------------------------------------------
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'workhub-config.json');

const DEFAULT_CONFIG = {
  sites: [],
  settings: {
    theme: 'dark',                       // 'dark' | 'light'
    scheme: 'blue',                      // accent colour scheme
    font: 'system',                      // UI font family
    showAddressBar: true,                // back/forward/reload/URL bar above each app
    appIconColor: null,                  // WorkHub logo colour; null = follow theme accent
    profile: { name: '', avatar: null, avatarColor: null },
    customLists: [],
    collapsed: {},
    launchAtStartup: false,
    exportIncludesWidgets: false,        // include sticky notes + to-do lists in workspace export
    useSystemFrame: false,               // true = OS native window frame; false = WorkHub's custom titlebar
    passwords: { enabled: true, autofill: true },   // remember + auto-fill site logins (encrypted)
    showMissedOnLaunch: true,            // show the "What have I missed?" digest on launch
    lastSeenVersion: '',                 // last version whose "What's New" the user has seen
    updates: { autoCheck: true, autoInstall: true },   // autoInstall: download + restart to update with no wizard
    notifications: { os: true, apps: {}, snoozeUntil: 0 },   // os = master toggle; apps[siteId]=false to mute; snoozeUntil = suppress OS toasts until this time
    sidebar: {
      dock: 'left',                      // 'left' | 'right' | 'top' | 'bottom'
      size: 248,                         // px — width (left/right) or height (top/bottom)
      compact: false,                    // icon-only
      locked: false                      // prevent drag-reorder + resize
    },
    performance: {
      // Discard (sleep) inactive tabs to release their Chromium process and
      // reclaim memory. This is the single biggest lever for a "lite" feel.
      sleepInactiveTabs: true,
      sleepAfterMinutes: 15,             // 0 = never sleep
      reduceAnimations: false,
      // Hardware acceleration: on by default (smoother, lower CPU for
      // scrolling/video). Turning it off saves the GPU process (~80-150 MB)
      // on low-end machines. Requires a restart to take effect.
      hardwareAcceleration: true
    },
    smoothwall: {
      enabled: true,
      loginUrl: 'https://192.168.1.2/iclogin',
      checkUrl: 'http://connectivitycheck.gstatic.com/generate_204',
      checkIntervalSeconds: 60
    }
  },
  slack: { clientId: '', redirectUri: 'https://0mattsmith.github.io/workhub/slack-callback.html' },
  notes: [],     // sticky notes
  todos: [],     // to-do lists
  notifLog: []   // persisted notification history (powers the "What have I missed?" digest)
};

// Suggestions shown on the empty state. Purely cosmetic shortcuts.
const SITE_SUGGESTIONS = [
  { name: 'Gmail', url: 'https://mail.google.com' },
  { name: 'Google Drive', url: 'https://drive.google.com' },
  { name: 'Google Classroom', url: 'https://classroom.google.com' },
  { name: 'Google Calendar', url: 'https://calendar.google.com' },
  { name: 'Outlook', url: 'https://outlook.office.com/mail' },
  { name: 'Microsoft 365', url: 'https://www.office.com' },
  { name: 'Microsoft Teams', url: 'https://teams.microsoft.com' },
  { name: 'Slack', url: 'https://app.slack.com' },
  { name: 'OneDrive', url: 'https://onedrive.live.com' },
  { name: 'ClassCharts', url: 'https://www.classcharts.com/teacher/login' },
  { name: 'SIMS / Arbor', url: 'https://login.arbor.sc' },
  { name: 'Google', url: 'https://www.google.com' },
  { name: 'BBC Bitesize', url: 'https://www.bbc.co.uk/bitesize' }
];

function deepMerge(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    if (
      typeof override[k] === 'object' && override[k] !== null && !Array.isArray(override[k]) &&
      typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Lite / performance switches — MUST run before app is ready
// ---------------------------------------------------------------------------
(function applyEngineFlags() {
  const perf = (config.settings && config.settings.performance) || {};
  app.commandLine.appendSwitch(
    'enable-features',
    'PageFreeze,HighEfficiencyModeAvailable,WebContentsDiscard'
  );
  // Also disable User-Agent Client Hints so browser-sniffing apps (Slack/Teams)
  // fall back to our spoofed UA string instead of seeing the real Chromium.
  app.commandLine.appendSwitch(
    'disable-features',
    'HardwareMediaKeyHandling,MediaSessionService,UserAgentClientHint'
  );
  if (perf.hardwareAcceleration === false) {
    app.disableHardwareAcceleration();   // drops the GPU process entirely
  }
})();

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let smoothwallWindow = null;
let smoothwallStatus = 'offnet';       // 'offnet' | 'ok' | 'bad' | 'unknown'
let statusTimer = null;
let isQuitting = false;

const ICONS = {
  app:     path.join(__dirname, 'build', 'icons', 'icon.png'),
  ok:      path.join(__dirname, 'build', 'icons', 'tray-ok.png'),
  bad:     path.join(__dirname, 'build', 'icons', 'tray-bad.png'),
  unknown: path.join(__dirname, 'build', 'icons', 'tray-unknown.png')
};

function trayIconFor(status) {
  const img = nativeImage.createFromPath(ICONS[status] || ICONS.app);
  if (process.platform === 'darwin') {
    return img.resize({ width: 18, height: 18 });
  }
  return img;
}

// ---------------------------------------------------------------------------
// Smoothwall: trust the appliance's self-signed cert ONLY for its host.
// ---------------------------------------------------------------------------
function smoothwallHost() {
  try {
    return new URL(config.settings.smoothwall.loginUrl).host;
  } catch (e) {
    return '192.168.1.2';
  }
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    if (new URL(url).host === smoothwallHost()) {
      event.preventDefault();
      callback(true);          // trust the appliance's self-signed cert
      return;
    }
  } catch (e) { /* fall through */ }
  callback(false);             // default: reject untrusted certs
});

// ---------------------------------------------------------------------------
// Connectivity / captive-portal status check
// ---------------------------------------------------------------------------
function smoothwallTarget() {
  try {
    const u = new URL(config.settings.smoothwall.loginUrl);
    return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443) };
  } catch (e) {
    return { host: '192.168.1.2', port: 443 };
  }
}

// Is the Smoothwall appliance even on this network? (quick TCP probe)
// Tries the URL's port, then falls back to the other common port (80/443),
// so it works whether the appliance answers on http or https.
function probeReachable(cb) {
  const { host, port } = smoothwallTarget();
  const alt = port === 443 ? 80 : (port === 80 ? 443 : null);
  const tryPort = (p, next) => {
    const socket = new tcp.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { socket.destroy(); } catch (e) {} ok ? cb(true) : next(); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(p, host); } catch (e) { finish(false); }
  };
  tryPort(port, () => { if (alt) tryPort(alt, () => cb(false)); else cb(false); });
}

function checkSmoothwallStatus() {
  if (!config.settings.smoothwall.enabled) { setSmoothwallStatus('offnet'); return; }
  probeReachable((reachable) => {
    if (!reachable) { setSmoothwallStatus('offnet'); return; }  // off the school network -> hide
    doAuthCheck();
  });
}

function doAuthCheck() {
  const checkUrl = config.settings.smoothwall.checkUrl;
  let settled = false;
  const finish = (status) => { if (settled) return; settled = true; setSmoothwallStatus(status); };
  let request;
  try {
    request = net.request({ url: checkUrl, redirect: 'manual', useSessionCookies: false });
  } catch (e) { finish('unknown'); return; }
  const timeout = setTimeout(() => { try { request.abort(); } catch (e) {} finish('unknown'); }, 6000);
  request.on('response', (response) => {
    clearTimeout(timeout);
    const code = response.statusCode;
    if (code === 204) finish('ok');
    else if (code >= 300 && code < 400) finish('bad');
    else if (code === 200) finish('bad');
    else finish('unknown');
    response.on('data', () => {});
    response.on('end', () => {});
  });
  request.on('error', () => { clearTimeout(timeout); finish('unknown'); });
  request.end();
}

function setSmoothwallStatus(status) {
  smoothwallStatus = status;
  if (tray) {
    tray.setImage(trayIconFor(status));
    const label = {
      ok: 'Smoothwall: signed in',
      bad: 'Smoothwall: not signed in',
      unknown: 'Smoothwall: status unknown'
    }[status];
    tray.setToolTip(label ? `WorkHub — ${label}` : 'WorkHub');
    rebuildTrayMenu();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('smoothwall:status', status);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  if (!config.settings.smoothwall.enabled) {
    setSmoothwallStatus('offnet');
    return;
  }
  checkSmoothwallStatus();
  const secs = Math.max(15, config.settings.smoothwall.checkIntervalSeconds || 60);
  statusTimer = setInterval(checkSmoothwallStatus, secs * 1000);
}

function stopStatusPolling() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ---------------------------------------------------------------------------
// Smoothwall popover (small, mobile-sized login window anchored to the tray)
// ---------------------------------------------------------------------------
function toggleSmoothwallWindow() {
  if (smoothwallWindow && !smoothwallWindow.isDestroyed()) {
    if (smoothwallWindow.isVisible()) { smoothwallWindow.hide(); return; }
    smoothwallWindow.show();
    smoothwallWindow.focus();
    return;
  }

  smoothwallWindow = new BrowserWindow({
    width: 400,
    height: 640,
    show: false,
    frame: true,
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    title: 'Smoothwall sign-in',
    backgroundColor: '#0f172a',
    icon: ICONS.app,
    webPreferences: {
      partition: 'persist:smoothwall',
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
  smoothwallWindow.setMenuBarVisibility(false);
  smoothwallWindow.loadURL(config.settings.smoothwall.loginUrl, { userAgent: MOBILE_UA });

  let shownOnce = false;
  const showPopover = () => {
    if (shownOnce || !smoothwallWindow || smoothwallWindow.isDestroyed()) return;
    shownOnce = true;
    positionPopover(smoothwallWindow);
    smoothwallWindow.show();
    smoothwallWindow.focus();
  };

  smoothwallWindow.webContents.on('did-navigate', () => {
    setTimeout(checkSmoothwallStatus, 1500);
  });
  smoothwallWindow.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    const host = smoothwallTarget().host;
    const html = '<body style="margin:0;font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px"><div><div style="font-size:38px">\uD83D\uDCF6</div><h3 style="margin:12px 0 6px">Smoothwall not reachable</h3><p style="color:#94a3b8;font-size:13px;line-height:1.5">Couldn\'t reach <b>' + host + '</b>.<br>You may be off the school network.</p></div></body>';
    smoothwallWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    showPopover();
  });

  smoothwallWindow.once('ready-to-show', showPopover);
  setTimeout(showPopover, 1500);

  smoothwallWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      smoothwallWindow.hide();
      setTimeout(checkSmoothwallStatus, 1500);
    }
  });

  smoothwallWindow.on('blur', () => {
    if (smoothwallWindow && smoothwallWindow.isVisible()) smoothwallWindow.hide();
  });
}

function positionPopover(win) {
  try {
    const bounds = win.getBounds();
    const trayBounds = tray ? tray.getBounds() : null;
    const display = screen.getDisplayNearestPoint(
      trayBounds && trayBounds.width ? { x: trayBounds.x, y: trayBounds.y } : screen.getCursorScreenPoint()
    );
    const area = display.workArea;
    let x, y;
    if (process.platform === 'darwin' && trayBounds && trayBounds.width) {
      x = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2);
      y = Math.round(area.y + 4);
    } else {
      x = area.x + area.width - bounds.width - 12;
      y = area.y + area.height - bounds.height - 12;
      if (trayBounds && trayBounds.width) {
        x = Math.min(x, trayBounds.x - bounds.width / 2);
      }
    }
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - bounds.width - 4));
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - bounds.height - 4));
    win.setPosition(Math.round(x), Math.round(y), false);
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function rebuildTrayMenu() {
  if (!tray) return;
  const onNet = config.settings.smoothwall.enabled && smoothwallStatus !== 'offnet';
  const template = [
    { label: 'Open WorkHub', click: showMainWindow },
    { type: 'separator' }
  ];
  if (onNet) {
    const statusLabel = {
      ok: '●  Signed in to Smoothwall',
      bad: '●  Not signed in to Smoothwall',
      unknown: '●  Smoothwall status unknown'
    }[smoothwallStatus];
    template.push({ label: statusLabel, enabled: false });
    template.push({ label: 'Sign in to Smoothwall…', click: toggleSmoothwallWindow });
    template.push({ label: 'Re-check status now', click: checkSmoothwallStatus });
    template.push({ type: 'separator' });
  }
  const snoozed = snoozeActive();
  const snoozeUntil = (config.settings.notifications && config.settings.notifications.snoozeUntil) || 0;
  const untilLabel = snoozed ? new Date(snoozeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  template.push({
    label: snoozed ? `Notifications snoozed until ${untilLabel}` : 'Snooze notifications',
    submenu: [
      { label: 'Snooze for 30 minutes', click: () => setSnooze(Date.now() + 30 * 60000) },
      { label: 'Snooze for 1 hour', click: () => setSnooze(Date.now() + 60 * 60000) },
      { label: 'Snooze for 4 hours', click: () => setSnooze(Date.now() + 4 * 60 * 60000) },
      { label: 'Snooze until tomorrow (8am)', click: () => setSnooze(tomorrowMorning()) },
      { type: 'separator' },
      { label: 'Resume notifications', enabled: snoozed, click: () => setSnooze(0) }
    ]
  });
  template.push({ type: 'separator' });
  template.push({ label: 'Check for updates…', click: () => { showMainWindow(); checkForUpdates(true); } });
  template.push({ type: 'separator' });
  template.push({ label: 'Quit WorkHub', click: () => { isQuitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(trayIconFor(smoothwallStatus));
  tray.setToolTip('WorkHub');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (config.settings.smoothwall.enabled && smoothwallStatus !== 'offnet') toggleSmoothwallWindow();
    else showMainWindow();
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const useSystemFrame = !!config.settings.useSystemFrame;
  const opts = {
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,                        // reveal once maximized to avoid a flash
    backgroundColor: config.settings.theme === 'light' ? '#f8fafc' : '#0f172a',
    title: 'WorkHub',
    icon: ICONS.app,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,                 // we embed sites with <webview>
      backgroundThrottling: true,       // throttle timers when window hidden
      spellcheck: false                 // no dictionary download / overhead
    }
  };
  if (!useSystemFrame) {
    if (isMac) { opts.titleBarStyle = 'hiddenInset'; opts.trafficLightPosition = { x: 12, y: 14 }; } // keep native traffic lights
    else { opts.frame = false; }        // Windows/Linux: draw our own titlebar
  }
  mainWindow = new BrowserWindow(opts);

  mainWindow.once('ready-to-show', () => { mainWindow.maximize(); mainWindow.show(); });   // start maximized
  const sendMax = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:maxchange', mainWindow.isMaximized()); };
  mainWindow.on('maximize', sendMax);
  mainWindow.on('unmaximize', sendMax);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      mainWindow.webContents.send('open-url-external-intent', url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && config.settings.smoothwall.enabled) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// Startup behaviour
// ---------------------------------------------------------------------------
function applyLaunchAtStartup() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.settings.launchAtStartup,
      openAsHidden: true
    });
  } catch (e) { /* not supported on some platforms */ }
}

// ---------------------------------------------------------------------------
// Auto-update (GitHub Releases via electron-updater)
// ---------------------------------------------------------------------------
function sendUpdateStatus(state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:status', Object.assign({ state }, extra || {}));
  }
}

let updatesWired = false;
function setupAutoUpdater() {
  if (!autoUpdater || updatesWired) return;
  updatesWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('none'));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('progress', { percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info && info.version }));
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: String((err && err.message) || err) }));
}

function checkForUpdates() {
  if (!app.isPackaged) { sendUpdateStatus('dev'); return; }     // nothing to update in `npm start`
  if (!autoUpdater) { sendUpdateStatus('unsupported'); return; }
  setupAutoUpdater();
  try { autoUpdater.checkForUpdates(); } catch (e) { sendUpdateStatus('error', { message: String(e) }); }
}

// ---------------------------------------------------------------------------
// IPC API (renderer <-> main)
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => {
  const c = JSON.parse(JSON.stringify(config));
  if (c.slack) { delete c.slack.secretEnc; delete c.slack.tokenEnc; }   // never expose secrets to the renderer
  return c;
});

ipcMain.handle('config:getSuggestions', () => SITE_SUGGESTIONS);

ipcMain.handle('sites:set', (_e, sites) => {
  config.sites = Array.isArray(sites) ? sites : [];
  saveConfig(config);
  return config.sites;
});

ipcMain.handle('notes:set', (_e, notes) => {
  config.notes = Array.isArray(notes) ? notes : [];
  saveConfig(config);
  return config.notes;
});

ipcMain.handle('todos:set', (_e, todos) => {
  config.todos = Array.isArray(todos) ? todos : [];
  saveConfig(config);
  return config.todos;
});

ipcMain.handle('notifLog:set', (_e, log) => {
  config.notifLog = Array.isArray(log) ? log.slice(0, 300) : [];
  saveConfig(config);
  return config.notifLog;
});

// Parse CHANGELOG.md into [{ version, lines[] }] for the "What's New" window.
ipcMain.handle('updates:changelog', () => {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    const out = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const h = raw.match(/^##\s+(?:v)?(\d+\.\d+\.\d+)/i);   // "## 1.2.3" or "## v1.2.3 - date"
      if (h) { cur = { version: h[1], lines: [] }; out.push(cur); continue; }
      if (cur) {
        const li = raw.match(/^\s*[-*]\s+(.*)$/);            // bullet lines
        if (li && li[1].trim()) cur.lines.push(li[1].trim());
      }
    }
    return out;
  } catch (e) { return []; }
});

// ---- password vault ----
ipcMain.handle('pw:available', () => pwAvailable());
ipcMain.handle('pw:save', (_e, { origin, username, password } = {}) => pwSave(origin, username, password));
ipcMain.handle('pw:fill', (_e, origin) => {                 // returns plaintext for auto-fill (exact origin only)
  if (!config.settings.passwords || config.settings.passwords.enabled === false) return null;
  if (config.settings.passwords.autofill === false) return null;
  const c = pwBestForOrigin(origin);
  return c ? { username: c.username, password: c.password } : null;
});
ipcMain.handle('pw:isNever', (_e, origin) => (pwVault.never || []).includes(origin));
ipcMain.handle('pw:setNever', (_e, origin) => {
  if (origin && !pwVault.never.includes(origin)) pwVault.never.push(origin);
  return savePasswords();
});
ipcMain.handle('pw:list', () => {                            // usernames only — never expose passwords to the UI list
  return Object.keys(pwVault.origins).map((origin) => ({
    origin,
    accounts: (pwVault.origins[origin] || []).map((c) => ({ username: c.username, savedAt: c.savedAt }))
  }));
});
ipcMain.handle('pw:delete', (_e, { origin, username } = {}) => {
  if (!origin) return false;
  if (username === undefined) { delete pwVault.origins[origin]; }
  else {
    pwVault.origins[origin] = (pwVault.origins[origin] || []).filter((c) => c.username !== username);
    if (!pwVault.origins[origin].length) delete pwVault.origins[origin];
  }
  return savePasswords();
});
ipcMain.handle('pw:clear', () => { pwVault = { origins: {}, never: [] }; return savePasswords(); });

ipcMain.handle('sites:reset', () => {
  config.sites = JSON.parse(JSON.stringify(DEFAULT_CONFIG.sites)); // empty by design
  saveConfig(config);
  return config.sites;
});

ipcMain.handle('settings:set', (_e, settings) => {
  const before = JSON.stringify(config.settings.smoothwall);
  config.settings = deepMerge(config.settings, settings || {});
  saveConfig(config);
  applyLaunchAtStartup();
  if (JSON.stringify(config.settings.smoothwall) !== before) {
    startStatusPolling();
    rebuildTrayMenu();
  }
  return config.settings;
});

ipcMain.handle('smoothwall:open', () => { toggleSmoothwallWindow(); return true; });
ipcMain.handle('smoothwall:check', () => { checkSmoothwallStatus(); return smoothwallStatus; });
ipcMain.handle('smoothwall:getStatus', () => smoothwallStatus);

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

// Download a favicon and return it as a data URL, so the renderer can cache it
// (the main process isn't subject to the browser's cross-origin canvas limits).
ipcMain.handle('icon:fetch', async (_e, url) => {
  if (!/^https?:\/\//i.test(url || '')) return null;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    try {
      const req = net.request(url);
      const chunks = [];
      let size = 0;
      let type = 'image/png';
      const to = setTimeout(() => { try { req.abort(); } catch (e) {} finish(null); }, 6000);
      req.on('response', (res) => {
        let ct = res.headers['content-type'] || 'image/png';
        if (Array.isArray(ct)) ct = ct[0];
        type = String(ct).split(';')[0].trim() || 'image/png';
        if (res.statusCode !== 200 || !/^image\//.test(type)) {
          clearTimeout(to); res.on('data', () => {}); res.on('end', () => {}); finish(null); return;
        }
        res.on('data', (c) => {
          size += c.length;
          if (size > 512 * 1024) { try { req.abort(); } catch (e) {} clearTimeout(to); finish(null); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(to);
          if (!chunks.length) return finish(null);
          finish('data:' + type + ';base64,' + Buffer.concat(chunks).toString('base64'));
        });
      });
      req.on('error', () => { clearTimeout(to); finish(null); });
      req.end();
    } catch (e) { finish(null); }
  });
});

// ---------------------------------------------------------------------------
// Slack — native OAuth (Stage 1: connect + secure token storage)
// ---------------------------------------------------------------------------
let slackPendingState = null;
const SLACK_USER_SCOPES = 'channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read,chat:write';

function slackEnc(text) {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(text).toString('base64');
    }
  } catch (e) { /* fall through */ }
  return 'raw:' + Buffer.from(text || '', 'utf8').toString('base64');
}
function slackDec(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch (e) { /* ignore */ }
  return '';
}

// ---------------------------------------------------------------------------
// Password vault — saved site logins, encrypted at rest with the OS keychain
// (Windows DPAPI / macOS Keychain / Linux libsecret) via Electron safeStorage.
// The whole vault is one encrypted blob in a separate file (never in the JSON
// config, never in a workspace export). Plaintext passwords only leave the main
// process to auto-fill the exact origin they were saved for.
// ---------------------------------------------------------------------------
const PW_FILE = () => path.join(app.getPath('userData'), 'workhub-passwords.bin');
let pwVault = { origins: {}, never: [] };   // origins[origin] = [{username, password, savedAt}]

function pwAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}
function loadPasswords() {
  try {
    if (!fs.existsSync(PW_FILE())) return;
    const raw = fs.readFileSync(PW_FILE());
    const json = safeStorage.decryptString(raw);
    const parsed = JSON.parse(json);
    pwVault = { origins: parsed.origins || {}, never: parsed.never || [] };
  } catch (e) { pwVault = { origins: {}, never: [] }; }
}
function savePasswords() {
  try {
    if (!pwAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(pwVault));
    fs.writeFileSync(PW_FILE(), enc);
    return true;
  } catch (e) { return false; }
}
function pwSave(origin, username, password) {
  if (!origin || !password) return false;
  username = username || '';
  const list = pwVault.origins[origin] || [];
  const existing = list.find((c) => c.username === username);
  if (existing) { existing.password = password; existing.savedAt = Date.now(); }
  else list.push({ username, password, savedAt: Date.now() });
  pwVault.origins[origin] = list;
  return savePasswords();
}
function pwBestForOrigin(origin) {
  const list = pwVault.origins[origin] || [];
  if (!list.length) return null;
  return list.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];   // most recent
}

function slackStatus() {
  const s = config.slack || {};
  return {
    connected: !!s.tokenEnc,
    user: s.userName || null,
    team: s.teamName || null,
    hasCreds: !!(s.clientId && s.secretEnc),
    clientId: s.clientId || '',
    redirectUri: s.redirectUri || ''
  };
}
function sendSlackStatus(extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slack:status', Object.assign(slackStatus(), extra || {}));
  }
}

function slackPost(url, formObj) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'POST', url });
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      const chunks = [];
      req.on('response', (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve({ ok: false, error: 'bad_json' }); } });
      });
      req.on('error', () => resolve({ ok: false, error: 'network' }));
      req.write(new URLSearchParams(formObj).toString());
      req.end();
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });
}
function slackGet(url, token) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'GET', url });
      req.setHeader('Authorization', 'Bearer ' + token);
      const chunks = [];
      req.on('response', (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve({ ok: false }); } });
      });
      req.on('error', () => resolve({ ok: false }));
      req.end();
    } catch (e) { resolve({ ok: false }); }
  });
}

async function finishSlackOAuth(code, state) {
  if (!code) { sendSlackStatus({ error: 'No authorization code returned.' }); return; }
  if (slackPendingState && state !== slackPendingState) { sendSlackStatus({ error: 'State mismatch — please try again.' }); return; }
  const s = config.slack || {};
  const secret = slackDec(s.secretEnc);
  if (!s.clientId || !secret) { sendSlackStatus({ error: 'Missing credentials.' }); return; }
  const resp = await slackPost('https://slack.com/api/oauth.v2.access', {
    client_id: s.clientId, client_secret: secret, code, redirect_uri: s.redirectUri
  });
  if (!resp.ok || !resp.authed_user || !resp.authed_user.access_token) {
    sendSlackStatus({ error: 'Slack sign-in failed: ' + (resp.error || 'unknown') }); return;
  }
  const token = resp.authed_user.access_token;
  config.slack = Object.assign({}, s, {
    tokenEnc: slackEnc(token),
    userId: resp.authed_user.id,
    teamName: (resp.team && resp.team.name) || s.teamName || '',
    connectedAt: Date.now()
  });
  const who = await slackGet('https://slack.com/api/auth.test', token);
  if (who && who.ok) { config.slack.userName = who.user || config.slack.userName; if (who.team) config.slack.teamName = who.team; }
  saveConfig(config);
  slackPendingState = null;
  showMainWindow();
  sendSlackStatus();
}

function handleAppProtocol(url) {
  try {
    if (!url || url.indexOf('workhub://') !== 0) return;
    if (url.indexOf('slack-callback') !== -1) {
      const u = new URL(url);
      finishSlackOAuth(u.searchParams.get('code'), u.searchParams.get('state'));
    }
  } catch (e) { /* ignore */ }
}

ipcMain.handle('slack:getStatus', () => slackStatus());
ipcMain.handle('slack:setCreds', (_e, creds) => {
  creds = creds || {};
  config.slack = Object.assign({}, config.slack || {}, {
    clientId: (creds.clientId || '').trim(),
    redirectUri: (creds.redirectUri || '').trim()
  });
  if (creds.secret) config.slack.secretEnc = slackEnc(creds.secret.trim());
  saveConfig(config);
  return slackStatus();
});
ipcMain.handle('slack:connect', () => {
  const s = config.slack || {};
  if (!s.clientId || !s.secretEnc || !s.redirectUri) {
    return { ok: false, error: 'Enter Client ID, Client Secret and Redirect URL first.' };
  }
  slackPendingState = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const u = 'https://slack.com/oauth/v2/authorize'
    + '?client_id=' + encodeURIComponent(s.clientId)
    + '&user_scope=' + encodeURIComponent(SLACK_USER_SCOPES)
    + '&redirect_uri=' + encodeURIComponent(s.redirectUri)
    + '&state=' + encodeURIComponent(slackPendingState);
  shell.openExternal(u);
  return { ok: true };
});
ipcMain.handle('slack:disconnect', () => {
  if (config.slack) {
    delete config.slack.tokenEnc;
    delete config.slack.userName;
    delete config.slack.userId;
    saveConfig(config);
  }
  return slackStatus();
});

ipcMain.handle('window:setTitle', (_e, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title ? `WorkHub — ${title}` : 'WorkHub');
  }
  return true;
});

// ---- custom titlebar window controls ----
ipcMain.handle('window:chrome', () => ({
  platform: process.platform,
  custom: !config.settings.useSystemFrame,
  maximized: mainWindow ? mainWindow.isMaximized() : true
}));
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); return true; });
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); return true; });

ipcMain.handle('app:webviewPreloadUrl', () => {
  return pathToFileURL(path.join(__dirname, 'src', 'webview-preload.js')).href;
});

ipcMain.handle('updates:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, supported: !!autoUpdater }));
ipcMain.handle('updates:check', () => { checkForUpdates(true); return true; });
ipcMain.handle('updates:install', () => {
  // isSilent=true (no installer window), isForceRunAfter=true (relaunch after installing)
  if (autoUpdater && app.isPackaged) { isQuitting = true; autoUpdater.quitAndInstall(true, true); }
  return true;
});

// ---- notification snooze (suppress Windows/macOS toasts for a while) -------
function snoozeActive() {
  const u = (config.settings.notifications && config.settings.notifications.snoozeUntil) || 0;
  return u > Date.now();
}
function setSnooze(until) {
  config.settings.notifications = config.settings.notifications || {};
  config.settings.notifications.snoozeUntil = until || 0;
  saveConfig(config);
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify:snooze', config.settings.notifications.snoozeUntil);
  }
}
function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

ipcMain.handle('notify:getSnooze', () => (config.settings.notifications && config.settings.notifications.snoozeUntil) || 0);
ipcMain.handle('notify:setSnooze', (_e, payload) => {
  let until = 0;
  if (payload && payload.until) until = payload.until;
  else if (payload && payload.minutes) until = Date.now() + payload.minutes * 60000;
  else if (payload && payload.tomorrow) until = tomorrowMorning();
  setSnooze(until);
  return until;
});

ipcMain.handle('notify:os', (_e, payload) => {
  try {
    if (snoozeActive()) return { ok: false, snoozed: true };   // toasts are snoozed; in-app panel still records it
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: (payload && payload.title) || 'WorkHub',
      body: (payload && payload.body) || '',
      icon: ICONS.app,
      silent: false
    });
    n.on('click', () => {
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && payload && payload.siteId) {
        mainWindow.webContents.send('activate-site', payload.siteId);
      }
    });
    n.show();
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('workspace:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export WorkHub workspace',
    defaultPath: 'workhub-workspace.json',
    filters: [{ name: 'WorkHub workspace', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  try {
    const payload = {
      app: 'WorkHub', schema: 1, exportedAt: new Date().toISOString(),
      sites: config.sites, settings: config.settings
    };
    if (config.settings && config.settings.exportIncludesWidgets) {
      payload.notes = config.notes;   // opt-in: carry sticky notes + to-do lists across machines
      payload.todos = config.todos;
    }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('workspace:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import WorkHub workspace',
    filters: [{ name: 'WorkHub workspace', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (Array.isArray(parsed.sites)) config.sites = parsed.sites;
    if (parsed.settings) config.settings = deepMerge(DEFAULT_CONFIG.settings, parsed.settings);
    if (Array.isArray(parsed.notes)) config.notes = parsed.notes;   // present only if the export opted in
    if (Array.isArray(parsed.todos)) config.todos = parsed.todos;
    saveConfig(config);
    startStatusPolling();
    rebuildTrayMenu();
    return { ok: true, config };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', (event, argv) => {
  const url = (argv || []).find((a) => typeof a === 'string' && a.indexOf('workhub://') === 0);
  if (url) handleAppProtocol(url);
  showMainWindow();
});

app.on('open-url', (event, url) => { event.preventDefault(); handleAppProtocol(url); });   // macOS

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.workhub.app');  // proper Windows toast identity
  loadPasswords();
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('workhub', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('workhub');
    }
  } catch (e) { /* ignore */ }
  const launchUrl = process.argv.find((a) => typeof a === 'string' && a.indexOf('workhub://') === 0);
  if (launchUrl) setTimeout(() => handleAppProtocol(launchUrl), 1500);
  session.fromPartition('persist:workhub');
  // Periodically flush cookies to disk so an unclean exit doesn't drop logins.
  setInterval(() => { try { session.fromPartition('persist:workhub').cookies.flushStore(); } catch (e) {} }, 5 * 60 * 1000);

  createMainWindow();
  createTray();
  applyLaunchAtStartup();
  startStatusPolling();

  if (autoUpdater && app.isPackaged && !(config.settings.updates && config.settings.updates.autoCheck === false)) {
    setTimeout(() => checkForUpdates(false), 4000);
  }

  try {
    powerMonitor.on('suspend', stopStatusPolling);
    powerMonitor.on('resume', () => { setSmoothwallStatus('unknown'); startStatusPolling(); });
  } catch (e) { /* powerMonitor unavailable on some platforms */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  try { session.fromPartition('persist:workhub').cookies.flushStore(); } catch (e) {}  // persist logins
});

app.on('window-all-closed', () => {
  if (!config.settings.smoothwall.enabled && process.platform !== 'darwin') {
    app.quit();
  }
});
