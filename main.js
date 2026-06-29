'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain,
  shell, session, screen, net, powerMonitor, dialog
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
    profile: { name: '', avatar: null, avatarColor: null },
    customLists: [],
    collapsed: {},
    launchAtStartup: false,
    updates: { autoCheck: true },
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
  }
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
  app.commandLine.appendSwitch(
    'disable-features',
    'HardwareMediaKeyHandling,MediaSessionService'
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
function probeReachable(cb) {
  const { host, port } = smoothwallTarget();
  const socket = new tcp.Socket();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; try { socket.destroy(); } catch (e) {} cb(ok); };
  socket.setTimeout(2500);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
  try { socket.connect(port, host); } catch (e) { finish(false); }
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
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
  });

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
ipcMain.handle('config:get', () => config);

ipcMain.handle('config:getSuggestions', () => SITE_SUGGESTIONS);

ipcMain.handle('sites:set', (_e, sites) => {
  config.sites = Array.isArray(sites) ? sites : [];
  saveConfig(config);
  return config.sites;
});

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

ipcMain.handle('window:setTitle', (_e, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title ? `WorkHub — ${title}` : 'WorkHub');
  }
  return true;
});

ipcMain.handle('app:webviewPreloadUrl', () => {
  return pathToFileURL(path.join(__dirname, 'src', 'webview-preload.js')).href;
});

ipcMain.handle('updates:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, supported: !!autoUpdater }));
ipcMain.handle('updates:check', () => { checkForUpdates(true); return true; });
ipcMain.handle('updates:install', () => {
  if (autoUpdater && app.isPackaged) { isQuitting = true; autoUpdater.quitAndInstall(); }
  return true;
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
app.on('second-instance', () => { showMainWindow(); });

app.whenReady().then(() => {
  session.fromPartition('persist:workhub');

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

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (!config.settings.smoothwall.enabled && process.platform !== 'darwin') {
    app.quit();
  }
});
