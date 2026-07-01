'use strict';

/* ===========================================================================
   WorkHub renderer — tabs, sections, webview management, dockable/resizable
   sidebar, lite-mode tab sleeping, settings, and Alt+right-click "Add to Links".
   =========================================================================== */

const api = window.workhub;

let state = {
  sites: [],            // [{ id, name, url, group? }]
  settings: null,
  activeId: null
};

const webviews = new Map();   // id -> <webview> element
const tabMeta = new Map();    // id -> { lastActive, asleep, lastUrl }
let sleepTimer = null;
let webviewPreloadUrl = null;   // fetched from main (sandbox-safe)
let dragId = null;              // id of the tab currently being dragged

// Present embedded sites with a clean, current desktop-Chrome UA so apps like
// Slack/Teams don't reject the browser (Slack refuses anything advertising
// "Electron", and some apps gate on Chrome version). Keep this roughly in step
// with the Chromium your Electron version actually ships.
const WEBVIEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function sidebarLocked() {
  return !!(state.settings && state.settings.sidebar && state.settings.sidebar.locked);
}

function clearDropMarks() {
  document.querySelectorAll('.drop-target').forEach((e) => e.classList.remove('drop-target'));
  document.querySelectorAll('.tab.drop-before, .tab.drop-after').forEach((e) => e.classList.remove('drop-before', 'drop-after'));
}

function markGroupTarget(group) {
  clearDropMarks();
  document.querySelectorAll('[data-group]').forEach((e) => { if (e.dataset.group === group) e.classList.add('drop-target'); });
}

function attachGroupDrop(el, group) {
  el.addEventListener('dragover', (e) => { if (dragId == null) return; e.preventDefault(); markGroupTarget(group); });
  el.addEventListener('drop', (e) => { if (dragId == null) return; e.preventDefault(); reorderSite(dragId, null, false, group); clearDropMarks(); });
}

function reorderSite(id, targetId, after, newGroup) {
  const di = state.sites.findIndex((s) => s.id === id);
  if (di < 0) return;
  const moved = state.sites.splice(di, 1)[0];
  if (newGroup) moved.group = newGroup; else delete moved.group;
  if (targetId) {
    const ti = state.sites.findIndex((s) => s.id === targetId);
    if (ti < 0) state.sites.push(moved);
    else state.sites.splice(after ? ti + 1 : ti, 0, moved);
  } else {
    let lastIdx = -1;
    for (let i = 0; i < state.sites.length; i++) if ((state.sites[i].group || '') === (newGroup || '')) lastIdx = i;
    if (lastIdx < 0) state.sites.push(moved); else state.sites.splice(lastIdx + 1, 0, moved);
  }
  renderTabs();
  persistSites();
}

/* ---- DOM refs ---- */
const $ = (id) => document.getElementById(id);
const appEl = () => document.querySelector('.app');
const tabList = $('tabList');
const webviewStack = $('webviewStack');
const emptyState = $('emptyState');
const navbar = $('navbar');
const urlText = $('urlText');

/* ---- Office Apps suite presets ---- */
const OFFICE_GROUP = 'Office Apps';
const OFFICE_SUITES = {
  google: {
    label: 'Google Workspace',
    apps: [
      { name: 'Gmail', url: 'https://mail.google.com', icon: 'gmail' },
      { name: 'Drive', url: 'https://drive.google.com', icon: 'drive' },
      { name: 'Docs', url: 'https://docs.google.com', icon: 'docs' },
      { name: 'Sheets', url: 'https://sheets.google.com', icon: 'sheets' },
      { name: 'Slides', url: 'https://slides.google.com', icon: 'slides' },
      { name: 'Calendar', url: 'https://calendar.google.com', icon: 'gcal' }
    ]
  },
  microsoft: {
    label: 'Microsoft 365',
    apps: [
      { name: 'Outlook', url: 'https://outlook.office.com/mail', icon: 'outlook' },
      { name: 'Word', url: 'https://www.office.com/launch/word', icon: 'word' },
      { name: 'Excel', url: 'https://www.office.com/launch/excel', icon: 'excel' },
      { name: 'PowerPoint', url: 'https://www.office.com/launch/powerpoint', icon: 'powerpoint' },
      { name: 'OneDrive', url: 'https://onedrive.live.com', icon: 'onedrive' },
      { name: 'Teams', url: 'https://teams.microsoft.com', icon: 'teams' }
    ]
  }
};

/* ---- High-quality app icons (crisp SVG, brand colours) ---- */
const APP_ICONS = {
  docs:       { bg: '#2563eb', t: 'lines' },
  sheets:     { bg: '#15a35a', t: 'grid' },
  slides:     { bg: '#f5a623', t: 'slide' },
  drive:      { bg: '#1aa260', t: 'drive' },
  gmail:      { bg: '#ea4335', t: 'mail' },
  gcal:       { bg: '#1a73e8', t: 'cal' },
  word:       { bg: '#2b579a', t: 'W' },
  excel:      { bg: '#217346', t: 'X' },
  powerpoint: { bg: '#c43e1c', t: 'P' },
  outlook:    { bg: '#0f6cbd', t: 'mail' },
  onedrive:   { bg: '#0f6cbd', t: 'cloud' },
  teams:      { bg: '#5059c9', t: 'T' },
  slack:      { bg: '#611f69', t: 'S' }
};

function appIconSvg(key) {
  const a = APP_ICONS[key];
  if (!a) return '';
  const glyphs = {
    lines: '<path d="M8 8.5h8M8 12h8M8 15.5h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
    grid:  '<path d="M7.5 7.5h9v9h-9z" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M7.5 11h9M7.5 14h9M11 7.5v9M14 7.5v9" stroke="#fff" stroke-width="1.1"/>',
    slide: '<rect x="6" y="7.5" width="12" height="8.5" rx="1" fill="none" stroke="#fff" stroke-width="1.5"/>',
    mail:  '<path d="M5.5 8.5h13v7h-13z" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M5.5 8.5l6.5 4.5 6.5-4.5" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>',
    cal:   '<rect x="5.5" y="6.5" width="13" height="12" rx="1.5" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M5.5 10.5h13M9 5.2v3M15 5.2v3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
    cloud: '<path d="M8.5 16.5h8a3 3 0 0 0 .2-6A4.3 4.3 0 0 0 8.7 9.4 3.4 3.4 0 0 0 8.5 16.5Z" fill="#fff"/>',
    drive: '<path d="M9.7 5.5h4.6L19.5 14h-4.6zM9.4 5.8 4.5 14.2l2.3 4 4.9-8.4zM7.2 18.4h9.3l2.2-3.8H9.4z" fill="#fff"/>'
  };
  let inner;
  if (a.t.length === 1) {
    inner = '<text x="12" y="16" font-size="11" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI, Arial, sans-serif">' + a.t + '</text>';
  } else {
    inner = glyphs[a.t] || '';
  }
  return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="' + a.bg + '"/>' + inner + '</svg>';
}

function guessIcon(url) {
  const map = {
    'mail.google.com': 'gmail', 'drive.google.com': 'drive', 'docs.google.com': 'docs',
    'sheets.google.com': 'sheets', 'slides.google.com': 'slides', 'calendar.google.com': 'gcal',
    'outlook.office.com': 'outlook', 'onedrive.live.com': 'onedrive', 'teams.microsoft.com': 'teams',
    'app.slack.com': 'slack'
  };
  return map[hostOf(url)] || null;
}

function siteHasAppIcon(site) {
  const key = site.icon || guessIcon(site.url);
  return !!(key && APP_ICONS[key]);
}

const iconFetching = new Set();
let _persistTimer = null;
function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persistTimer = null; persistSites(); }, 800);
}

function setTabIconData(id, dataUrl) {
  const el = document.querySelector(`.tab[data-id="${id}"] .tab-favicon`);
  if (!el) return;
  el.classList.remove('has-app-icon');
  const img = document.createElement('img');
  img.alt = '';
  img.onload = () => { el.textContent = ''; el.innerHTML = ''; el.appendChild(img); };
  img.src = dataUrl;
}

// Download + persist a favicon as a data URL so it survives restarts / offline.
async function cacheSiteIcon(site, srcUrl) {
  if (!srcUrl || siteHasAppIcon(site) || iconFetching.has(site.id) || !api.fetchIcon) return;
  iconFetching.add(site.id);
  try {
    const dataUrl = await api.fetchIcon(srcUrl);
    if (dataUrl && dataUrl !== site.favicon) {
      site.favicon = dataUrl;
      schedulePersist();
      setTabIconData(site.id, dataUrl);
    }
  } catch (e) { /* ignore */ } finally {
    iconFetching.delete(site.id);
  }
}

function paintIcon(boxEl, site) {
  const key = site.icon || guessIcon(site.url);
  if (key && APP_ICONS[key]) {
    boxEl.classList.add('has-app-icon');
    boxEl.innerHTML = appIconSvg(key);
    return;
  }
  if (site.favicon) {                          // cached data URL — instant + offline-safe
    const img = document.createElement('img');
    img.alt = '';
    boxEl.textContent = '';
    boxEl.appendChild(img);
    img.src = site.favicon;
    return;
  }
  applyFavicon(boxEl, faviconUrl(site.url), site.name);   // live favicon (initial shown first)
  cacheSiteIcon(site, faviconUrl(site.url));              // …then cache it for next time
}

/* ===========================================================================
   Helpers
   =========================================================================== */
/* ---- Appearance: colour schemes (Slack-style) + fonts ---- */
const SCHEMES = {
  blue:      { accent: '#3b82f6', hover: '#2563eb', soft: 'rgba(59,130,246,0.16)',  sidebar: '#0b1322' },
  aubergine: { accent: '#a855f7', hover: '#9333ea', soft: 'rgba(168,85,247,0.16)',  sidebar: '#1c1430' },
  forest:    { accent: '#22c55e', hover: '#16a34a', soft: 'rgba(34,197,94,0.16)',   sidebar: '#0c1d16' },
  teal:      { accent: '#14b8a6', hover: '#0d9488', soft: 'rgba(20,184,166,0.16)',  sidebar: '#0a1f1d' },
  ember:     { accent: '#fb923c', hover: '#f97316', soft: 'rgba(251,146,60,0.16)',  sidebar: '#241710' },
  rose:      { accent: '#f43f5e', hover: '#e11d48', soft: 'rgba(244,63,94,0.16)',   sidebar: '#261018' },
  graphite:  { accent: '#94a3b8', hover: '#64748b', soft: 'rgba(148,163,184,0.16)', sidebar: '#111726' }
};
const FONTS = {
  system:    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  verdana:   'Verdana, Geneva, sans-serif',
  tahoma:    'Tahoma, Geneva, sans-serif',
  trebuchet: '"Trebuchet MS", Tahoma, sans-serif',
  century:   '"Century Gothic", "URW Gothic", "Apple SD Gothic Neo", sans-serif',
  comic:     '"Comic Sans MS", "Comic Sans", "Chalkboard SE", sans-serif'
};

function applyAppearance() {
  const s = state.settings || {};
  const theme = s.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const root = document.documentElement.style;
  const sc = SCHEMES[s.scheme] || SCHEMES.blue;
  root.setProperty('--accent', sc.accent);
  root.setProperty('--accent-hover', sc.hover);
  root.setProperty('--accent-soft', sc.soft);
  if (theme === 'dark' && sc.sidebar) root.setProperty('--sidebar', sc.sidebar);
  else root.removeProperty('--sidebar');
  root.setProperty('--app-font', FONTS[s.font] || FONTS.system);
}

/* ---- Profile: name + avatar ---- */
const AVATAR_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
const BRAND_SHIELD = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 4.8a1.6 1.6 0 0 1 1.6-1.6h12.8A1.6 1.6 0 0 1 20 4.8v8.4L12 21l-8-7.8V4.8Z" fill="currentColor"/><circle cx="12" cy="10" r="3" fill="#fff"/><circle cx="12" cy="10" r="1.25" fill="currentColor"/></svg>';

function avatarColorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function applyProfile() {
  const p = (state.settings && state.settings.profile) || {};
  const mark = document.getElementById('brandMark');
  const nameEl = document.getElementById('brandName');
  if (nameEl) nameEl.textContent = p.name ? `${p.name}'s WorkHub` : 'WorkHub';
  if (mark) {
    if (p.avatar) {
      mark.innerHTML = '<img class="avatar-img" alt="" src="' + p.avatar + '">';
    } else if (p.name) {
      const c = p.avatarColor || avatarColorFor(p.name);
      mark.innerHTML = '<span class="avatar-circle" style="background:' + c + '">' + initials(p.name) + '</span>';
    } else {
      mark.innerHTML = BRAND_SHIELD;
    }
  }
  fitBrandName();
  applyAppIcon();
}

// Shrink the brand name to fit the sidebar width, down to a floor, then ellipsis.
function fitBrandName() {
  const el = document.getElementById('brandName');
  if (!el || !el.parentElement) return;
  if (appEl().classList.contains('compact')) { el.style.fontSize = ''; return; }
  el.style.fontSize = '16px';
  const avail = el.parentElement.clientWidth;
  if (!avail) return;
  let size = 16, guard = 0;
  while (el.scrollWidth > avail && size > 11 && guard < 40) { size -= 0.5; el.style.fontSize = size + 'px'; guard++; }
}

// Recolour the WorkHub logo (sidebar + empty state). null/empty = follow accent.
function applyAppIcon() {
  const c = state.settings && state.settings.appIconColor;
  if (c) document.documentElement.style.setProperty('--app-icon', c);
  else document.documentElement.style.removeProperty('--app-icon');
}

function renderAvatarPreview() {
  const el = document.getElementById('avatarPreview');
  if (!el) return;
  const p = state.settings.profile || {};
  if (p.avatar) {
    el.innerHTML = '<img class="avatar-img" alt="" src="' + p.avatar + '">';
  } else {
    const nm = p.name || '';
    const c = p.avatarColor || (nm ? avatarColorFor(nm) : '#64748b');
    el.innerHTML = '<span class="avatar-circle" style="background:' + c + '">' + (nm ? initials(nm) : '?') + '</span>';
  }
}

function loadAvatarFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      if (!state.settings.profile) state.settings.profile = { name: '', avatar: null, avatarColor: null };
      state.settings.profile.avatar = canvas.toDataURL('image/png');
      applyProfile();
      renderAvatarPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function uid() { return 'site_' + Math.random().toString(36).slice(2, 9); }

function meta(id) {
  if (!tabMeta.has(id)) tabMeta.set(id, { lastActive: 0, asleep: false, lastUrl: null });
  return tabMeta.get(id);
}

function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); return u; } catch (e) { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function faviconUrl(url) {
  const host = hostOf(url);
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : '';
}

function initials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

function defaultSidebarSize(dock) {
  return (dock === 'top' || dock === 'bottom') ? 60 : 248;
}

/* ===========================================================================
   Persistence
   =========================================================================== */
async function persistSites() {
  state.sites = await api.setSites(state.sites);
}

/* ===========================================================================
   Webviews
   =========================================================================== */
function ensureWebview(site) {
  if (webviews.has(site.id)) return webviews.get(site.id);
  const m = meta(site.id);
  const startUrl = m.lastUrl || site.url;   // resume where we left off if woken
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:workhub');   // shared session => SSO across apps
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('webpreferences', 'backgroundThrottling=yes,spellcheck=no');
  wv.setAttribute('useragent', WEBVIEW_UA);   // look like desktop Chrome (Slack/Teams compatibility)
  if (webviewPreloadUrl) wv.setAttribute('preload', webviewPreloadUrl);
  wv.setAttribute('src', startUrl);
  wv.dataset.id = site.id;
  webviewStack.appendChild(wv);
  webviews.set(site.id, wv);
  m.asleep = false;

  wv.addEventListener('did-navigate', () => { if (site.id === state.activeId) syncNav(); });
  wv.addEventListener('did-navigate-in-page', () => { if (site.id === state.activeId) syncNav(); });
  wv.addEventListener('page-title-updated', (e) => {
    if (site.id === state.activeId) api.setWindowTitle(e.title || site.name);
    meta(site.id).badge = parseBadge(e.title);
    updateTabBadge(site.id, effectiveBadge(site.id));
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    if (site.iconFrozen) return;                 // user pinned this icon — don't let the page change it
    if (e.favicons && e.favicons.length && !siteHasAppIcon(site)) {
      const best = e.favicons[e.favicons.length - 1];   // usually the highest-res one
      setTabFavicon(site.id, best);
      cacheSiteIcon(site, best);                          // upgrade the cached copy
    }
  });
  // Messages bubbled up from the per-site preload (Alt+right-click gesture).
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'workhub-link-menu') showLinkMenu(e.args[0], wv);
    else if (e.channel === 'workhub-dismiss-menu') hideLinkMenu();
    else if (e.channel === 'workhub-notification') addNotification(site, e.args[0]);
    else if (e.channel === 'workhub-cred-captured') maybeOfferSavePassword(e.args[0]);
    else if (e.channel === 'workhub-cred-request') handleCredFillRequest(wv, e.args[0]);
  });
  return wv;
}

function syncNav() {
  const wv = webviews.get(state.activeId);
  if (!wv) return;
  try {
    $('backBtn').disabled = !wv.canGoBack();
    $('fwdBtn').disabled = !wv.canGoForward();
    urlText.textContent = wv.getURL();
  } catch (e) { /* webview not ready */ }
}

/* ===========================================================================
   Tab sleeping (lite mode)
   =========================================================================== */
function discardTab(id) {
  if (id === state.activeId) return;
  const wv = webviews.get(id);
  if (!wv) return;
  try {
    if (typeof wv.isCurrentlyAudible === 'function' && wv.isCurrentlyAudible()) return;
    meta(id).lastUrl = wv.getURL() || meta(id).lastUrl;
  } catch (e) { /* ignore */ }
  wv.remove();
  webviews.delete(id);
  meta(id).asleep = true;
  markTabAsleep(id, true);
}

function sleepSweep() {
  const perf = state.settings.performance || {};
  if (!perf.sleepInactiveTabs || !perf.sleepAfterMinutes) return;
  const cutoff = Date.now() - perf.sleepAfterMinutes * 60 * 1000;
  for (const [id] of webviews) {
    if (id === state.activeId) continue;
    if (meta(id).lastActive <= cutoff) discardTab(id);
  }
}

function applyPerformance() {
  const perf = state.settings.performance || {};
  document.body.classList.toggle('no-anim', !!perf.reduceAnimations);
  if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
  if (perf.sleepInactiveTabs && perf.sleepAfterMinutes > 0) {
    sleepTimer = setInterval(sleepSweep, 60 * 1000);
  }
}

function markTabAsleep(id, asleep) {
  const tab = document.querySelector(`.tab[data-id="${id}"]`);
  if (tab) tab.classList.toggle('asleep', asleep);
}

/* ===========================================================================
   Sidebar layout (dock / resize / compact)
   =========================================================================== */
function applySidebar() {
  const sb = state.settings.sidebar || { dock: 'left', size: 248, compact: false };
  const app = appEl();
  app.setAttribute('data-dock', sb.dock || 'left');
  app.classList.toggle('compact', !!sb.compact);
  app.classList.toggle('locked', !!sb.locked);
  const horizontal = (sb.dock === 'top' || sb.dock === 'bottom');
  let size = sb.size || defaultSidebarSize(sb.dock);
  size = horizontal ? Math.max(48, Math.min(size, 240)) : Math.max(64, Math.min(size, 420));
  document.documentElement.style.setProperty('--sidebar-size', size + 'px');
  fitBrandName();
}

/* ===========================================================================
   Rendering
   =========================================================================== */
function applyFavicon(boxEl, src, name) {
  if (!boxEl) return;
  boxEl.textContent = initials(name);
  if (!src) return;
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => { boxEl.textContent = ''; boxEl.appendChild(img); });
  img.addEventListener('error', () => { /* keep the initial */ });
  img.src = src;
}

function setTabFavicon(id, src) {
  const el = document.querySelector(`.tab[data-id="${id}"] .tab-favicon`);
  if (el) {
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('load', () => { el.textContent = ''; el.innerHTML = ''; el.appendChild(img); });
    img.src = src;
  }
}

function parseBadge(title) {
  if (!title) return 0;
  let m = title.match(/\((\d+)\+?\)/);
  if (m) return parseInt(m[1], 10);
  m = title.match(/^\s*(\d+)\s/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

// Highest of: count parsed from the page title, and unread captured notifications.
function effectiveBadge(id) {
  const m = meta(id);
  return Math.max(m.badge || 0, m.unread || 0);
}

function updateTabBadge(id, count) {
  const tab = document.querySelector(`.tab[data-id="${id}"]`);
  if (!tab) return;
  const b = tab.querySelector('.tab-badge');
  if (!b) return;
  b.textContent = count > 99 ? '99+' : String(count);
  b.hidden = !count;
}

function makeTab(site) {
  const m = meta(site.id);
  const tab = document.createElement('div');
  tab.className = 'tab' + (site.id === state.activeId ? ' active' : '') + (m.asleep ? ' asleep' : '');
  tab.dataset.id = site.id;
  tab.setAttribute('role', 'tab');
  tab.title = m.asleep ? `${site.name} (asleep — click to wake)` : site.name;

  const fav = document.createElement('div');
  fav.className = 'tab-favicon';
  paintIcon(fav, site);

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = site.name;

  const edit = document.createElement('button');
  edit.className = 'tab-edit';
  edit.title = 'Edit';
  edit.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  edit.addEventListener('click', (e) => { e.stopPropagation(); openSiteModal(site); });

  const badge = document.createElement('span');
  badge.className = 'tab-badge';
  const bc = meta(site.id).badge || 0;
  badge.textContent = bc > 99 ? '99+' : String(bc);
  badge.hidden = !bc;

  tab.appendChild(fav);
  tab.appendChild(name);
  tab.appendChild(badge);
  tab.appendChild(edit);
  tab.addEventListener('click', () => activateSite(site.id));
  tab.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTabMenu(e.clientX, e.clientY, site); });

  tab.draggable = !sidebarLocked();
  tab.addEventListener('dragstart', (e) => {
    if (sidebarLocked()) { e.preventDefault(); return; }
    dragId = site.id;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', site.id); } catch (_) {}
  });
  tab.addEventListener('dragend', () => { dragId = null; clearDropMarks(); tab.classList.remove('dragging'); });
  tab.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault(); e.stopPropagation();
    clearDropMarks();
    const r = tab.getBoundingClientRect();
    tab.classList.add(((e.clientY - r.top) > r.height / 2) ? 'drop-after' : 'drop-before');
  });
  tab.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault(); e.stopPropagation();
    const r = tab.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    if (dragId !== site.id) reorderSite(dragId, site.id, after, site.group || '');
    clearDropMarks();
  });
  return tab;
}

function sitesInGroup(group) {
  return state.sites.filter((s) => (s.group || '') === group);
}

function listOrder() {
  const present = new Set(state.sites.map((s) => s.group || ''));
  const customs = state.settings.customLists || [];
  const out = [{ label: 'Your Apps', group: '' }];
  if (present.has(OFFICE_GROUP)) out.push({ label: OFFICE_GROUP, group: OFFICE_GROUP });
  for (const c of customs) if (c && c !== OFFICE_GROUP) out.push({ label: c, group: c });
  for (const g of present) {
    if (g === '' || g === OFFICE_GROUP) continue;
    if (!customs.includes(g) && !out.find((o) => o.group === g)) out.push({ label: g, group: g });
  }
  return out;
}

async function toggleSection(name) {
  if (!state.settings.collapsed) state.settings.collapsed = {};
  state.settings.collapsed[name] = !state.settings.collapsed[name];
  renderTabs();
  await api.setSettings({ collapsed: state.settings.collapsed });
}

function renderTabs() {
  tabList.innerHTML = '';
  const collapsed = state.settings.collapsed || {};
  const customs = state.settings.customLists || [];
  for (const sec of listOrder()) {
    const items = sitesInGroup(sec.group);
    const isCustom = customs.includes(sec.label);
    if (sec.group === '' && items.length === 0) continue;
    if (sec.group !== '' && items.length === 0 && !isCustom) continue;
    const isCol = !!collapsed[sec.label];
    const header = document.createElement('button');
    header.className = 'section-header collapsible' + (isCol ? ' collapsed' : '');
    header.innerHTML = '<svg class="chev" viewBox="0 0 24 24" width="12" height="12"><path d="M8 5l8 7-8 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const lab = document.createElement('span');
    lab.textContent = sec.label;
    header.appendChild(lab);
    header.title = sec.label;
    header.addEventListener('click', () => toggleSection(sec.label));
    header.dataset.group = sec.group;
    attachGroupDrop(header, sec.group);
    tabList.appendChild(header);
    const wrap = document.createElement('div');
    wrap.className = 'section-items' + (isCol ? ' collapsed' : '');
    wrap.dataset.group = sec.group;
    attachGroupDrop(wrap, sec.group);
    for (const s of items) wrap.appendChild(makeTab(s));
    tabList.appendChild(wrap);
  }
}

function updateEmptyState() {
  const hasSites = state.sites.length > 0;
  emptyState.hidden = hasSites;
  navbar.hidden = !hasSites || state.settings.showAddressBar === false;
  webviewStack.style.display = hasSites ? 'block' : 'none';
}

/* ===========================================================================
   Office Apps
   =========================================================================== */
async function addSuite(key) {
  const suite = OFFICE_SUITES[key];
  if (!suite) return;
  let added = 0;
  for (const app of suite.apps) {
    const exists = state.sites.some((s) => s.group === OFFICE_GROUP && s.url === app.url);
    if (exists) continue;
    state.sites.push({ id: uid(), name: app.name, url: app.url, group: OFFICE_GROUP });
    added++;
  }
  await persistSites();
  renderTabs();
  updateEmptyState();
  showToast(added ? `Added ${suite.label} — ${added} app${added === 1 ? '' : 's'}` : `${suite.label} already added`);
}

async function addCustomOffice(name, urlRaw) {
  const url = normalizeUrl(urlRaw);
  if (!url) { showToast('Enter a valid web address'); return; }
  const nm = (name || '').trim() || hostOf(url);
  state.sites.push({ id: uid(), name: nm, url, group: OFFICE_GROUP });
  await persistSites();
  renderTabs();
  updateEmptyState();
  showToast(`Added “${nm}” to Office Apps`);
}

function renderOfficeChecklist() {
  const wrap = $('officeChecklist');
  if (!wrap) return;
  const suite = OFFICE_SUITES[$('officeSuite').value];
  wrap.innerHTML = '';
  if (!suite) return;
  for (const app of suite.apps) {
    const present = state.sites.some((s) => s.group === OFFICE_GROUP && s.url === app.url);
    const row = document.createElement('label');
    row.className = 'check-row';
    const ic = document.createElement('span');
    ic.className = 'check-icon';
    ic.innerHTML = appIconSvg(app.icon);
    const nm = document.createElement('span');
    nm.className = 'check-name';
    nm.textContent = app.name;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = present;
    cb.addEventListener('change', () => setOfficeApp(app, cb.checked));
    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(cb);
    wrap.appendChild(row);
  }
}

async function setOfficeApp(app, on) {
  const existing = state.sites.find((s) => s.group === OFFICE_GROUP && s.url === app.url);
  if (on && !existing) {
    state.sites.push({ id: uid(), name: app.name, url: app.url, group: OFFICE_GROUP, icon: app.icon });
  } else if (!on && existing) {
    state.sites = state.sites.filter((s) => s.id !== existing.id);
    const wv = webviews.get(existing.id);
    if (wv) { wv.remove(); webviews.delete(existing.id); }
    tabMeta.delete(existing.id);
    if (state.activeId === existing.id) state.activeId = state.sites[0] ? state.sites[0].id : null;
  } else {
    return;
  }
  await persistSites();
  renderTabs();
  updateEmptyState();
  if (state.activeId) activateSite(state.activeId);
  else api.setWindowTitle('');
}

/* ===========================================================================
   Activation
   =========================================================================== */
function activateSite(id) {
  const site = state.sites.find((s) => s.id === id);
  if (!site) return;
  state.activeId = id;
  meta(id).lastActive = Date.now();
  meta(id).asleep = false;
  meta(id).unread = 0;                    // opening the app clears its unread bubble
  updateTabBadge(id, effectiveBadge(id));

  ensureWebview(site);
  for (const [wid, wv] of webviews) wv.classList.toggle('active', wid === id);

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.id === id);
    if (t.dataset.id === id) t.classList.remove('asleep');
  });
  api.setWindowTitle(site.name);
  setTimeout(syncNav, 50);
}

/* ===========================================================================
   Add / Edit modal
   =========================================================================== */
let editingId = null;

function openSiteModal(site) {
  editingId = site ? site.id : null;
  $('siteModalTitle').textContent = site ? 'Edit site' : 'Add site';
  $('siteName').value = site ? site.name : '';
  $('siteUrl').value = site ? site.url : '';
  populateListSelect(site ? (site.group || '') : '');
  $('deleteSiteBtn').hidden = !site;
  $('siteError').hidden = true;
  $('siteModal').hidden = false;
  setTimeout(() => $('siteName').focus(), 30);
}

function closeSiteModal() { $('siteModal').hidden = true; editingId = null; }

async function saveSite() {
  const name = $('siteName').value.trim();
  const url = normalizeUrl($('siteUrl').value);
  if (!name) return showSiteError('Please enter a name.');
  if (!url) return showSiteError('Please enter a valid web address.');

  if (editingId) {
    const site = state.sites.find((s) => s.id === editingId);
    if (site) {
      const urlChanged = site.url !== url;
      site.name = name; site.url = url;
      const g = $('siteList').value; if (g) site.group = g; else delete site.group;
      if (urlChanged) {
        meta(site.id).lastUrl = null;
        delete site.favicon;   // stale cached icon — let it re-fetch for the new URL
        if (webviews.has(site.id)) webviews.get(site.id).setAttribute('src', url);
      }
    }
  } else {
    const site = { id: uid(), name, url };
    const g = $('siteList').value; if (g) site.group = g;
    state.sites.push(site);
    await persistSites();
    renderTabs(); updateEmptyState();
    activateSite(site.id);
    closeSiteModal();
    return;
  }
  await persistSites();
  renderTabs(); updateEmptyState();
  if (state.activeId) activateSite(state.activeId);
  closeSiteModal();
}

function showSiteError(msg) { const e = $('siteError'); e.textContent = msg; e.hidden = false; }

async function deleteSite() {
  if (!editingId) return;
  const id = editingId;
  state.sites = state.sites.filter((s) => s.id !== id);
  const wv = webviews.get(id);
  if (wv) { wv.remove(); webviews.delete(id); }
  tabMeta.delete(id);
  await persistSites();

  if (state.activeId === id) {
    state.activeId = state.sites[0] ? state.sites[0].id : null;
  }
  renderTabs(); updateEmptyState();
  if (state.activeId) activateSite(state.activeId);
  else { api.setWindowTitle(''); }
  closeSiteModal();
}

/* ===========================================================================
   Settings modal
   =========================================================================== */
function openSettings() {
  const s = state.settings;
  const perf = s.performance || {};
  const sb = s.sidebar || { dock: 'left', compact: false, size: 248 };

  setTheme(s.theme);
  document.querySelectorAll('#themeToggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.theme === s.theme));
  document.querySelectorAll('#schemeSwatches button').forEach((b) =>
    b.classList.toggle('active', b.dataset.scheme === (s.scheme || 'blue')));
  document.querySelectorAll('#appIconSwatches button').forEach((b) =>
    b.classList.toggle('active', (b.dataset.color || '') === (s.appIconColor || '')));
  $('fontSelect').value = s.font || 'system';
  const prof = s.profile || {};
  $('profileName').value = prof.name || '';
  document.querySelectorAll('#avatarSwatches button').forEach((b) =>
    b.classList.toggle('active', b.dataset.color === prof.avatarColor));
  renderAvatarPreview();
  $('startupToggle').checked = !!s.launchAtStartup;

  document.querySelectorAll('#dockToggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.dock === (sb.dock || 'left')));
  $('compactToggle').checked = !!sb.compact;
  $('lockToggle').checked = !!sb.locked;
  $('addressBarToggle').checked = s.showAddressBar !== false;
  $('exportWidgetsToggle').checked = !!s.exportIncludesWidgets;

  $('sleepToggle').checked = !!perf.sleepInactiveTabs;
  $('sleepMinutes').value = String(perf.sleepAfterMinutes != null ? perf.sleepAfterMinutes : 15);
  $('reduceAnimToggle').checked = !!perf.reduceAnimations;
  $('hwAccelToggle').checked = perf.hardwareAcceleration !== false;

  $('smoothwallToggle').checked = !!s.smoothwall.enabled;
  $('smoothwallUrl').value = s.smoothwall.loginUrl || '';
  renderOfficeChecklist();
  renderListsManager();
  refreshUpdateUI();
  $('osNotifyToggle').checked = !(s.notifications && s.notifications.os === false);
  renderNotifyApps();
  refreshSnoozeUI();
  const pw = s.passwords || {};
  $('pwEnabledToggle').checked = pw.enabled !== false;
  $('pwAutofillToggle').checked = pw.autofill !== false;
  renderSavedLogins();
  setSettingsPane(currentSettingsPane);
  $('settingsModal').hidden = false;
}

let currentSettingsPane = 'profile';
function setSettingsPane(name) {
  currentSettingsPane = name || 'profile';
  document.querySelectorAll('#settingsNav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === currentSettingsPane);
  });
  document.querySelectorAll('.settings-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === currentSettingsPane);
  });
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
}

function closeSettings() { $('settingsModal').hidden = true; }

async function saveSettings() {
  const theme = document.querySelector('#themeToggle button.active').dataset.theme;
  const dock = document.querySelector('#dockToggle button.active').dataset.dock;
  const activeScheme = document.querySelector('#schemeSwatches button.active');
  const activeIcon = document.querySelector('#appIconSwatches button.active');
  const next = {
    theme,
    scheme: activeScheme ? activeScheme.dataset.scheme : (state.settings.scheme || 'blue'),
    appIconColor: activeIcon ? (activeIcon.dataset.color || null) : (state.settings.appIconColor || null),
    font: $('fontSelect').value,
    profile: {
      name: $('profileName').value.trim(),
      avatar: state.settings.profile ? state.settings.profile.avatar : null,
      avatarColor: state.settings.profile ? state.settings.profile.avatarColor : null
    },
    launchAtStartup: $('startupToggle').checked,
    showAddressBar: $('addressBarToggle').checked,
    exportIncludesWidgets: $('exportWidgetsToggle').checked,
    passwords: {
      enabled: $('pwEnabledToggle').checked,
      autofill: $('pwAutofillToggle').checked
    },
    updates: { autoCheck: $('autoUpdateToggle').checked, autoInstall: $('autoInstallToggle').checked },
    notifications: {
      os: $('osNotifyToggle').checked,
      apps: (state.settings.notifications && state.settings.notifications.apps) || {}
    },
    sidebar: {
      dock,
      compact: $('compactToggle').checked,
      locked: $('lockToggle').checked,
      size: state.settings.sidebar ? state.settings.sidebar.size : defaultSidebarSize(dock)
    },
    performance: {
      sleepInactiveTabs: $('sleepToggle').checked,
      sleepAfterMinutes: parseInt($('sleepMinutes').value, 10) || 0,
      reduceAnimations: $('reduceAnimToggle').checked,
      hardwareAcceleration: $('hwAccelToggle').checked
    },
    smoothwall: {
      enabled: $('smoothwallToggle').checked,
      loginUrl: normalizeUrl($('smoothwallUrl').value) || state.settings.smoothwall.loginUrl
    }
  };
  state.settings = await api.setSettings(next);
  setTheme(state.settings.theme);
  applyProfile();
  applySidebar();
  applyPerformance();
  updateSmoothwallDot(await api.getSmoothwallStatus());
  closeSettings();
}

function setTheme() { applyAppearance(); }   // thin alias — appearance reads state.settings

/* ===========================================================================
   Smoothwall indicator
   =========================================================================== */
function updateSmoothwallDot(status) {
  const btn = $('smoothwallBtn');
  if (!btn) return;
  if (status === 'offnet') { btn.style.display = 'none'; return; }   // off the school network -> hide
  btn.style.display = '';
  const dot = $('swDot');
  dot.dataset.status = status || 'unknown';
  const label = { ok: 'signed in', bad: 'not signed in', unknown: 'status unknown' }[status] || 'status unknown';
  btn.title = `Smoothwall: ${label} — click to sign in`;
}

/* ===========================================================================
   Sidebar resize (drag the inner edge)
   =========================================================================== */
function wireResize() {
  const handle = $('resizeHandle');
  if (!handle) return;
  let overlay = null;

  const onMove = (e) => {
    const sb = state.settings.sidebar;
    const dock = sb.dock || 'left';
    const rect = appEl().getBoundingClientRect();
    let size;
    if (dock === 'left') size = e.clientX - rect.left;
    else if (dock === 'right') size = rect.right - e.clientX;
    else if (dock === 'top') size = e.clientY - rect.top;
    else size = rect.bottom - e.clientY;
    const horizontal = (dock === 'top' || dock === 'bottom');
    size = horizontal ? Math.max(48, Math.min(size, 240)) : Math.max(64, Math.min(size, 420));
    sb.size = Math.round(size);
    document.documentElement.style.setProperty('--sidebar-size', sb.size + 'px');
    fitBrandName();
  };

  const onUp = async () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (overlay) { overlay.remove(); overlay = null; }
    await api.setSettings({ sidebar: state.settings.sidebar });
  };

  handle.addEventListener('mousedown', (e) => {
    if (sidebarLocked()) return;
    e.preventDefault();
    // Full-window overlay so the drag keeps receiving mouse events even over a webview.
    overlay = document.createElement('div');
    overlay.className = 'drag-overlay';
    const dock = (state.settings.sidebar.dock || 'left');
    overlay.style.cursor = (dock === 'top' || dock === 'bottom') ? 'ns-resize' : 'ew-resize';
    document.body.appendChild(overlay);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

/* ===========================================================================
   Wiring
   =========================================================================== */
function wireEvents() {
  $('addBtn').addEventListener('click', () => openSiteModal(null));
  $('emptyAddBtn').addEventListener('click', () => openSiteModal(null));
  $('saveSiteBtn').addEventListener('click', saveSite);
  $('cancelSiteBtn').addEventListener('click', closeSiteModal);
  $('deleteSiteBtn').addEventListener('click', deleteSite);
  $('siteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSite(); });
  $('siteName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('siteUrl').focus(); });

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsNav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pane]');
    if (btn) setSettingsPane(btn.dataset.pane);
  });
  $('pwClearAll').addEventListener('click', async () => {
    await api.pwClear();
    renderSavedLogins();
  });
  $('snoozeSelect').addEventListener('change', onSnoozeSelectChange);
  api.onSnooze(updateSnoozeUI);
  refreshSnoozeUI();
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('resetSitesBtn').addEventListener('click', resetSites);
  $('exportWsBtn').addEventListener('click', exportWorkspace);
  $('importWsBtn').addEventListener('click', importWorkspace);

  $('checkUpdatesBtn').addEventListener('click', () => { setUpdateStatus('Checking for updates…'); api.checkForUpdates(); });
  $('installUpdateBtn').addEventListener('click', () => api.installUpdate());
  $('viewReleasesBtn').addEventListener('click', () => api.openExternal('https://github.com/0mattsmith/workhub/releases'));
  $('autoUpdateToggle').addEventListener('change', () => {
    if (!state.settings.updates) state.settings.updates = { autoCheck: true };
    state.settings.updates.autoCheck = $('autoUpdateToggle').checked;
  });
  $('autoInstallToggle').addEventListener('change', () => {
    if (!state.settings.updates) state.settings.updates = { autoCheck: true };
    state.settings.updates.autoInstall = $('autoInstallToggle').checked;
  });
  api.onUpdateStatus(handleUpdateStatus);

  document.querySelectorAll('#themeToggle button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#themeToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.settings.theme = b.dataset.theme; applyAppearance();
    });
  });

  // Colour scheme swatches + font (live preview)
  document.querySelectorAll('#schemeSwatches button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#schemeSwatches button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.settings.scheme = b.dataset.scheme;
      applyAppearance();
    });
  });
  document.querySelectorAll('#appIconSwatches button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#appIconSwatches button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.settings.appIconColor = b.dataset.color || null;
      applyAppIcon();
    });
  });
  $('fontSelect').addEventListener('change', () => {
    state.settings.font = $('fontSelect').value;
    applyAppearance();
  });

  // Profile: name, avatar photo, avatar colour
  $('profileName').addEventListener('input', () => {
    if (!state.settings.profile) state.settings.profile = { name: '', avatar: null, avatarColor: null };
    state.settings.profile.name = $('profileName').value.trim();
    applyProfile();
    renderAvatarPreview();
  });
  $('avatarFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadAvatarFile(file);
    e.target.value = '';
  });
  $('avatarRemove').addEventListener('click', () => {
    if (!state.settings.profile) state.settings.profile = { name: '', avatar: null, avatarColor: null };
    state.settings.profile.avatar = null;
    applyProfile();
    renderAvatarPreview();
  });
  document.querySelectorAll('#avatarSwatches button').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.settings.profile) state.settings.profile = { name: '', avatar: null, avatarColor: null };
      const next = (state.settings.profile.avatarColor === b.dataset.color) ? null : b.dataset.color;
      state.settings.profile.avatarColor = next;
      document.querySelectorAll('#avatarSwatches button').forEach((x) => x.classList.toggle('active', x.dataset.color === next));
      applyProfile();
      renderAvatarPreview();
    });
  });

  // Sidebar dock buttons (live preview)
  document.querySelectorAll('#dockToggle button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#dockToggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const dock = b.dataset.dock;
      state.settings.sidebar.dock = dock;
      state.settings.sidebar.size = defaultSidebarSize(dock);
      applySidebar();
    });
  });
  $('compactToggle').addEventListener('change', () => {
    state.settings.sidebar.compact = $('compactToggle').checked;
    applySidebar();
  });
  $('lockToggle').addEventListener('change', () => {
    state.settings.sidebar.locked = $('lockToggle').checked;
    applySidebar();
    renderTabs();
  });
  $('addressBarToggle').addEventListener('change', () => {
    state.settings.showAddressBar = $('addressBarToggle').checked;
    updateEmptyState();
  });

  // Office Apps
  $('officeSuite').addEventListener('change', renderOfficeChecklist);
  $('addListBtn').addEventListener('click', addCustomList);
  $('newListName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomList(); });
  $('addCustomOfficeBtn').addEventListener('click', () => {
    addCustomOffice($('customOfficeName').value, $('customOfficeUrl').value);
    $('customOfficeName').value = '';
    $('customOfficeUrl').value = '';
  });

  $('smoothwallBtn').addEventListener('click', () => api.openSmoothwall());
  $('notifBtn').addEventListener('click', toggleNotifications);
  $('notifClose').addEventListener('click', hideNotifPanel);
  $('notifClear').addEventListener('click', clearNotifications);

  // Navbar
  $('backBtn').addEventListener('click', () => { const w = webviews.get(state.activeId); if (w && w.canGoBack()) w.goBack(); });
  $('fwdBtn').addEventListener('click', () => { const w = webviews.get(state.activeId); if (w && w.canGoForward()) w.goForward(); });
  $('reloadBtn').addEventListener('click', () => { const w = webviews.get(state.activeId); if (w) w.reload(); });
  $('homeBtn').addEventListener('click', () => {
    const site = state.sites.find((s) => s.id === state.activeId);
    const w = webviews.get(state.activeId);
    if (site && w) { meta(site.id).lastUrl = null; w.loadURL(site.url); }
  });
  $('openExternalBtn').addEventListener('click', () => {
    const w = webviews.get(state.activeId);
    if (w) api.openExternal(w.getURL());
  });

  // Modal dismiss
  $('siteModal').addEventListener('click', (e) => { if (e.target.id === 'siteModal') closeSiteModal(); });
  $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSiteModal(); closeSettings(); hideLinkMenu(); hideNotifPanel(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest || !e.target.closest('.ctx-menu')) hideLinkMenu();
    if (e.target.closest && !e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) hideNotifPanel();
  }, true);

  api.onSmoothwallStatus(updateSmoothwallDot);
  api.onOpenUrlIntent((url) => api.openExternal(url));
  api.onActivateSite((id) => { activateSite(id); hideNotifPanel(); });

  $('osNotifyToggle').addEventListener('change', () => {
    if (!state.settings.notifications) state.settings.notifications = { os: true, apps: {} };
    state.settings.notifications.os = $('osNotifyToggle').checked;
  });

  // Right-click an empty part of the sidebar -> quick Compact toggle
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) sidebarEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab') || e.target.closest('.resize-handle')) return;
    e.preventDefault();
    showSidebarMenu(e.clientX, e.clientY);
  });

  // Right-click the address bar -> hide it
  const navbarEl = document.getElementById('navbar');
  if (navbarEl) navbarEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showAddressBarMenu(e.clientX, e.clientY);
  });

  window.addEventListener('resize', fitBrandName);
  wireResize();
}

async function resetSites() {
  if (!confirm('Remove all pinned sites? This cannot be undone.')) return;
  state.sites = await api.resetSites();
  for (const [, wv] of webviews) wv.remove();
  webviews.clear();
  tabMeta.clear();
  state.activeId = null;
  renderTabs(); updateEmptyState(); api.setWindowTitle('');
  closeSettings();
}

async function exportWorkspace() {
  const r = await api.exportWorkspace();
  if (r && r.ok) showToast('Workspace exported');
}

async function importWorkspace() {
  const r = await api.importWorkspace();
  if (!r || !r.ok) { if (r && r.error) showToast('Import failed'); return; }
  state.sites = r.config.sites || [];
  state.settings = r.config.settings;
  if (!state.settings.sidebar) state.settings.sidebar = { dock: 'left', size: 248, compact: false };
  for (const [, wv] of webviews) wv.remove();
  webviews.clear(); tabMeta.clear();
  state.activeId = null;
  applyAppearance(); applySidebar(); applyPerformance();
  renderTabs(); updateEmptyState();
  if (state.sites[0]) activateSite(state.sites[0].id);
  else api.setWindowTitle('');
  showToast('Workspace imported');
  closeSettings();
}

function renderSuggestions(suggestions) {
  const wrap = $('suggestionChips');
  wrap.innerHTML = '';
  for (const s of suggestions) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    const img = document.createElement('img');
    img.className = 'chip-fav';
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    img.src = faviconUrl(s.url);
    chip.appendChild(img);
    chip.appendChild(document.createTextNode(' ' + s.name));
    chip.addEventListener('click', async () => {
      const site = { id: uid(), name: s.name, url: s.url };
      state.sites.push(site);
      await persistSites();
      renderTabs(); updateEmptyState(); activateSite(site.id);
    });
    wrap.appendChild(chip);
  }
}

function populateListSelect(current) {
  const sel = $('siteList');
  if (!sel) return;
  const customs = state.settings.customLists || [];
  const opts = [{ v: '', l: 'Your Apps' }, { v: OFFICE_GROUP, l: OFFICE_GROUP }];
  for (const c of customs) if (c !== OFFICE_GROUP) opts.push({ v: c, l: c });
  if (current && !opts.find((o) => o.v === current)) opts.push({ v: current, l: current });
  sel.innerHTML = '';
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.v; el.textContent = o.l;
    if (o.v === current) el.selected = true;
    sel.appendChild(el);
  }
}

function renderListsManager() {
  const wrap = $('listsManager');
  if (!wrap) return;
  const customs = state.settings.customLists || [];
  wrap.innerHTML = '';
  if (!customs.length) {
    const p = document.createElement('div');
    p.className = 'lists-empty';
    p.textContent = 'No custom lists yet.';
    wrap.appendChild(p);
  }
  for (const name of customs) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const lab = document.createElement('span');
    lab.className = 'list-name';
    lab.textContent = name;
    const del = document.createElement('button');
    del.className = 'text-btn danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteCustomList(name));
    row.appendChild(lab);
    row.appendChild(del);
    wrap.appendChild(row);
  }
}

function renderNotifyApps() {
  const wrap = $('notifApps');
  if (!wrap) return;
  const nt = state.settings.notifications || (state.settings.notifications = { os: true, apps: {} });
  if (!nt.apps) nt.apps = {};
  wrap.innerHTML = '';
  if (!state.sites.length) {
    const p = document.createElement('div');
    p.className = 'lists-empty';
    p.textContent = 'No apps yet.';
    wrap.appendChild(p);
    return;
  }
  for (const s of state.sites) {
    const row = document.createElement('label');
    row.className = 'check-row';
    const ic = document.createElement('span');
    ic.className = 'check-icon';
    if (siteHasAppIcon(s)) ic.innerHTML = appIconSvg(s.icon || guessIcon(s.url));
    const nm = document.createElement('span');
    nm.className = 'check-name';
    nm.textContent = s.name;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = nt.apps[s.id] !== false;
    cb.addEventListener('change', () => { nt.apps[s.id] = cb.checked; });
    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(cb);
    wrap.appendChild(row);
  }
}

async function addCustomList() {
  const inp = $('newListName');
  const name = (inp.value || '').trim();
  if (!name) return;
  if (!state.settings.customLists) state.settings.customLists = [];
  if (name === OFFICE_GROUP || name === 'Your Apps' || state.settings.customLists.includes(name)) {
    showToast('That list already exists');
    return;
  }
  state.settings.customLists.push(name);
  inp.value = '';
  await api.setSettings({ customLists: state.settings.customLists });
  renderListsManager();
  renderTabs();
  showToast(`Created list “${name}”`);
}

async function deleteCustomList(name) {
  state.settings.customLists = (state.settings.customLists || []).filter((c) => c !== name);
  for (const s of state.sites) if (s.group === name) delete s.group;
  await api.setSettings({ customLists: state.settings.customLists });
  await persistSites();
  renderListsManager();
  renderTabs();
  updateEmptyState();
}

/* ===========================================================================
   Link context menu — Alt + right-click a hyperlink → "Add to Links"
   =========================================================================== */
function hideLinkMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.remove();
}

function showSidebarMenu(x, y) {
  hideLinkMenu();
  if (!state.settings.sidebar) state.settings.sidebar = { dock: 'left', size: 248, compact: false };
  const sb = state.settings.sidebar;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  const item = document.createElement('button');
  item.className = 'ctx-item' + (sb.compact ? ' primary' : '');
  item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M4 12h9M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const span = document.createElement('span');
  span.textContent = (sb.compact ? '\u2713  ' : '') + 'Compact sidebar';
  item.appendChild(span);
  item.addEventListener('click', async () => {
    sb.compact = !sb.compact;
    applySidebar();
    hideLinkMenu();
    await api.setSettings({ sidebar: sb });
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  let mx = x, my = y;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (mx + mw > window.innerWidth - 8) mx = window.innerWidth - mw - 8;
  if (my + mh > window.innerHeight - 8) my = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, mx) + 'px';
  menu.style.top = Math.max(8, my) + 'px';
}

function showAddressBarMenu(x, y) {
  hideLinkMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  const item = document.createElement('button');
  item.className = 'ctx-item';
  item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const span = document.createElement('span');
  span.textContent = 'Hide address bar';
  item.appendChild(span);
  item.addEventListener('click', async () => {
    state.settings.showAddressBar = false;
    updateEmptyState();
    hideLinkMenu();
    await api.setSettings({ showAddressBar: false });
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  let mx = x, my = y;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (mx + mw > window.innerWidth - 8) mx = window.innerWidth - mw - 8;
  if (my + mh > window.innerHeight - 8) my = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, mx) + 'px';
  menu.style.top = Math.max(8, my) + 'px';
}

function showTabMenu(x, y, site) {
  hideLinkMenu();
  const frozen = !!site.iconFrozen;
  const items = [
    {
      label: frozen ? 'Unfreeze icon' : 'Freeze icon',
      svg: frozen
        ? '<path d="M6 10V7a6 6 0 0 1 12 0v3" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="10" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>'
        : '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      action: async () => {
        site.iconFrozen = !frozen;
        if (site.iconFrozen && !site.favicon && !siteHasAppIcon(site)) {
          await cacheSiteIcon(site, faviconUrl(site.url));   // capture the current icon so it can't vanish
        }
        schedulePersist();
        showToast(site.iconFrozen ? 'Icon frozen' : 'Icon unfrozen');
      }
    },
    {
      label: 'Edit…',
      svg: '<path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      action: () => openSiteModal(site)
    }
  ];

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  for (const it of items) {
    const el = document.createElement('button');
    el.className = 'ctx-item';
    el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${it.svg}</svg>`;
    const span = document.createElement('span');
    span.textContent = it.label;
    el.appendChild(span);
    el.addEventListener('click', () => { it.action(); hideLinkMenu(); });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let mx = x, my = y;
  if (mx + mw > window.innerWidth - 8) mx = window.innerWidth - mw - 8;
  if (my + mh > window.innerHeight - 8) my = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, mx) + 'px';
  menu.style.top = Math.max(8, my) + 'px';
}

function showLinkMenu(payload, wv) {
  hideLinkMenu();
  if (!payload || !payload.href) return;

  const link = payload.href;
  const text = payload.text || '';

  const items = [
    {
      label: 'Add to Links', primary: true,
      svg: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      action: () => addLinkToSidebar(link, text)
    },
    {
      label: 'Copy link address',
      svg: '<path d="M9 9h9v9H9zM6 15H5V6h9v1" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      action: () => { if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {}); }
    },
    {
      label: 'Open in browser',
      svg: '<path d="M14 4h6v6M20 4l-9 9M19 14v5H5V5h5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      action: () => api.openExternal(link)
    }
  ];

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  for (const it of items) {
    const el = document.createElement('button');
    el.className = 'ctx-item' + (it.primary ? ' primary' : '');
    el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${it.svg}</svg>`;
    const span = document.createElement('span');
    span.textContent = it.label;
    el.appendChild(span);
    el.addEventListener('click', () => { it.action(); hideLinkMenu(); });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);

  const rect = wv.getBoundingClientRect();
  let x = rect.left + (payload.x || 0);
  let y = rect.top + (payload.y || 0);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
}

async function addLinkToSidebar(href, text) {
  let name = (text || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) name = hostOf(href) || 'New link';
  const site = { id: uid(), name, url: href };
  state.sites.push(site);
  await persistSites();
  renderTabs();
  updateEmptyState();
  showToast(`Added “${name}” to Links`);
}

let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

/* ---- Notification snooze ---- */
function fmtClock(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
}
function updateSnoozeUI(until) {
  const active = until && until > Date.now();
  const statusEl = $('snoozeStatus');
  if (statusEl) statusEl.textContent = active ? ('Snoozed until ' + fmtClock(until) + ' — no desktop toasts.') : 'Off — toasts are showing.';
  const sel = $('snoozeSelect');
  if (sel && !active) sel.value = '0';
  const note = $('notifSnoozeNote');
  if (note) {
    note.hidden = !active;
    note.textContent = active ? ('Snoozed until ' + fmtClock(until)) : '';
  }
}
async function refreshSnoozeUI() {
  try { updateSnoozeUI(await api.getSnooze()); } catch (e) { updateSnoozeUI(0); }
}
function onSnoozeSelectChange() {
  const v = $('snoozeSelect').value;
  if (v === '0') api.setSnooze({ until: 0 });
  else if (v === 'tomorrow') api.setSnooze({ tomorrow: true });
  else api.setSnooze({ minutes: parseInt(v, 10) });
}

/* ---- Password vault ---- */
const pwSessionSeen = new Map();   // origin -> "username\npassword" already saved/dismissed this session (avoids re-prompting)

async function handleCredFillRequest(wv, data) {
  try {
    if (!data || !data.origin) return;
    if (state.settings.passwords && state.settings.passwords.enabled === false) return;
    const cred = await api.pwFill(data.origin);
    if (cred && cred.password) wv.send('workhub-cred-fill', cred);
  } catch (e) {}
}

async function maybeOfferSavePassword(data) {
  try {
    if (!data || !data.origin || !data.password) return;
    if (state.settings.passwords && state.settings.passwords.enabled === false) return;
    const key = (data.username || '') + '\n' + data.password;
    if (pwSessionSeen.get(data.origin) === key) return;         // already handled this exact login
    if (await api.pwIsNever(data.origin)) return;               // user said never for this site
    showSavePasswordPrompt(data);
  } catch (e) {}
}

function showSavePasswordPrompt(data) {
  const existing = document.getElementById('pwPrompt');
  if (existing) existing.remove();
  const host = (() => { try { return new URL(data.origin).hostname; } catch (e) { return data.origin; } })();

  const box = document.createElement('div');
  box.className = 'pw-prompt';
  box.id = 'pwPrompt';
  box.innerHTML =
    '<div class="pw-prompt-head">' +
      '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 10V8a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="10" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' +
      '<strong>Save password?</strong>' +
      '<button class="pw-x" id="pwPromptX" aria-label="Dismiss">&times;</button>' +
    '</div>' +
    '<div class="pw-prompt-body">Save your login for <b>' + escapeHtml(host) + '</b>' +
      (data.username ? ' (<span>' + escapeHtml(data.username) + '</span>)' : '') + '?</div>' +
    '<div class="pw-prompt-actions">' +
      '<button class="text-btn" id="pwNever">Never for this site</button>' +
      '<span class="spacer"></span>' +
      '<button class="text-btn" id="pwNotNow">Not now</button>' +
      '<button class="primary-btn" id="pwSave">Save</button>' +
    '</div>';
  document.body.appendChild(box);

  const done = () => { box.remove(); };
  const remember = () => pwSessionSeen.set(data.origin, (data.username || '') + '\n' + data.password);

  box.querySelector('#pwSave').addEventListener('click', async () => {
    remember();
    await api.pwSave({ origin: data.origin, username: data.username || '', password: data.password });
    done();
  });
  box.querySelector('#pwNotNow').addEventListener('click', () => { remember(); done(); });
  box.querySelector('#pwPromptX').addEventListener('click', () => { remember(); done(); });
  box.querySelector('#pwNever').addEventListener('click', async () => { remember(); await api.pwSetNever(data.origin); done(); });

  clearTimeout(showSavePasswordPrompt._t);
  showSavePasswordPrompt._t = setTimeout(() => { if (document.getElementById('pwPrompt') === box) done(); }, 20000);
}

async function renderSavedLogins() {
  const wrap = $('savedLogins');
  if (!wrap) return;
  wrap.innerHTML = '';
  let list = [];
  try { list = await api.pwList(); } catch (e) { list = []; }
  if (!list.length) { wrap.innerHTML = '<div class="wid-empty">No saved passwords yet.</div>'; return; }
  for (const entry of list) {
    const host = (() => { try { return new URL(entry.origin).hostname; } catch (e) { return entry.origin; } })();
    for (const acc of entry.accounts) {
      const row = document.createElement('div');
      row.className = 'saved-login';
      const info = document.createElement('div');
      info.className = 'saved-login-info';
      info.innerHTML = '<strong>' + escapeHtml(host) + '</strong><span>' + escapeHtml(acc.username || '(no username)') + '</span>';
      const del = document.createElement('button');
      del.className = 'text-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => { await api.pwDelete({ origin: entry.origin, username: acc.username }); renderSavedLogins(); });
      row.appendChild(info);
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- Updates ---- */
function setUpdateStatus(msg) { const e = $('updateStatus'); if (e) e.textContent = msg; }

async function refreshUpdateUI() {
  try {
    const info = await api.getUpdateInfo();
    const v = $('appVersion'); if (v) v.textContent = 'v' + info.version;
    const tog = $('autoUpdateToggle');
    if (tog) tog.checked = !(state.settings.updates && state.settings.updates.autoCheck === false);
    const autoInst = $('autoInstallToggle');
    if (autoInst) autoInst.checked = !(state.settings.updates && state.settings.updates.autoInstall === false);
    const inst = $('installUpdateBtn'); if (inst) inst.hidden = true;
    if (!info.packaged) setUpdateStatus('Dev mode — updates apply to the installed app.');
    else if (!info.supported) setUpdateStatus("Auto-update isn't available in this build.");
    else setUpdateStatus('Click to check for a newer version.');
  } catch (e) { /* ignore */ }
}

function setUpdateProgress(percent) {
  const wrap = $('updateProgress'), fill = $('updateProgressFill');
  if (wrap) wrap.hidden = (percent == null);
  if (fill && percent != null) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function handleUpdateStatus(d) {
  const inst = $('installUpdateBtn');
  const autoInstall = !(state.settings.updates && state.settings.updates.autoInstall === false);
  switch (d && d.state) {
    case 'checking': setUpdateStatus('Checking for updates…'); setUpdateProgress(null); break;
    case 'available':
      setUpdateStatus('Update found' + (d.version ? ' (v' + d.version + ')' : '') + ' — downloading…');
      setUpdateProgress(0);
      break;
    case 'progress':
      setUpdateStatus('Downloading update… ' + (d.percent || 0) + '%');
      setUpdateProgress(d.percent || 0);
      break;
    case 'downloaded':
      setUpdateStatus('Update ready' + (d.version ? ' (v' + d.version + ')' : '') + '.');
      setUpdateProgress(100);
      if (inst) inst.hidden = false;
      if (autoInstall) startUpdateCountdown(d.version);
      else showToast('Update downloaded — restart to install');
      break;
    case 'none': setUpdateStatus("You're on the latest version."); setUpdateProgress(null); break;
    case 'dev': setUpdateStatus('Dev mode — updates apply to the installed app.'); setUpdateProgress(null); break;
    case 'unsupported': setUpdateStatus("Auto-update isn't available in this build."); setUpdateProgress(null); break;
    case 'error': setUpdateStatus('Update check failed: ' + (d.message || 'unknown')); setUpdateProgress(null); break;
  }
}

// When an update finishes downloading, restart automatically after a short,
// cancelable countdown so the user is never yanked out of their work.
let updateCountdownTimer = null;
function startUpdateCountdown(version) {
  if (document.getElementById('updateCountdown')) return;
  let secs = 10;
  const card = document.createElement('div');
  card.className = 'pw-prompt';
  card.id = 'updateCountdown';
  card.innerHTML =
    '<div class="pw-prompt-head">' +
      '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 12a8 8 0 1 0 8-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 4V1L8 5l4 4V6" fill="currentColor"/></svg>' +
      '<strong>Update ready' + (version ? ' (v' + version + ')' : '') + '</strong>' +
      '<button class="pw-x" id="updateCancelX" aria-label="Later">&times;</button>' +
    '</div>' +
    '<div class="pw-prompt-body">Restarting to install in <b id="updateSecs">' + secs + '</b>s…</div>' +
    '<div class="pw-prompt-actions">' +
      '<button class="text-btn" id="updateLater">Later</button>' +
      '<span class="spacer"></span>' +
      '<button class="primary-btn" id="updateNow">Restart now</button>' +
    '</div>';
  document.body.appendChild(card);

  const stop = () => { clearInterval(updateCountdownTimer); updateCountdownTimer = null; card.remove(); };
  card.querySelector('#updateNow').addEventListener('click', () => { clearInterval(updateCountdownTimer); api.installUpdate(); });
  card.querySelector('#updateLater').addEventListener('click', stop);
  card.querySelector('#updateCancelX').addEventListener('click', stop);

  updateCountdownTimer = setInterval(() => {
    secs -= 1;
    const el = document.getElementById('updateSecs');
    if (el) el.textContent = secs;
    if (secs <= 0) { clearInterval(updateCountdownTimer); api.installUpdate(); }
  }, 1000);
}

/* ---- Notifications ---- */
const notifications = [];
let notifUnread = 0;
let notifSeq = 0;

function isNotifOpen() {
  const p = document.getElementById('notifPanel');
  return p && !p.hidden;
}

function hideNotifPanel() {
  const p = document.getElementById('notifPanel');
  if (p) p.hidden = true;
}

function updateNotifBadge() {
  const b = document.getElementById('notifBadge');
  if (!b) return;
  b.textContent = notifUnread > 99 ? '99+' : String(notifUnread);
  b.hidden = !notifUnread;
}

function osNotifyAllowed(siteId) {
  const nt = (state.settings && state.settings.notifications) || {};
  if (nt.os === false) return false;
  return !(nt.apps && nt.apps[siteId] === false);
}

function addNotification(site, n) {
  if (!n) return;
  notifications.unshift({ id: ++notifSeq, siteId: site.id, site: site.name, title: n.title || '', body: n.body || '', ts: n.ts || Date.now() });
  if (notifications.length > 200) notifications.pop();
  if (!isNotifOpen()) { notifUnread++; updateNotifBadge(); }
  else renderNotifications();

  // Red count bubble on the app's sidebar icon (unless you're already on it).
  if (!(document.hasFocus() && site.id === state.activeId)) {
    meta(site.id).unread = (meta(site.id).unread || 0) + 1;
    updateTabBadge(site.id, effectiveBadge(site.id));
  }

  // Mirror to a Windows toast (unless muted, or the app is already focused+active)
  if (osNotifyAllowed(site.id) && !(document.hasFocus() && site.id === state.activeId)) {
    const body = (n.title && n.body) ? (n.title + ' — ' + n.body) : (n.title || n.body || '');
    api.notifyOs({ title: site.name, body, siteId: site.id });
  }
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;
  list.innerHTML = '';
  if (!notifications.length) {
    const e = document.createElement('div');
    e.className = 'notif-empty';
    e.textContent = 'No notifications yet.';
    list.appendChild(e);
    return;
  }
  for (const n of notifications) {
    const row = document.createElement('div');
    row.className = 'notif-item';
    const x = document.createElement('button');
    x.className = 'notif-dismiss';
    x.title = 'Dismiss';
    x.textContent = '\u00d7';
    x.addEventListener('click', (e) => { e.stopPropagation(); dismissNotification(n.id); });
    row.appendChild(x);
    if (n.siteId) {
      row.classList.add('clickable');
      row.addEventListener('click', () => { activateSite(n.siteId); hideNotifPanel(); });
    }
    const top = document.createElement('div');
    top.className = 'notif-top';
    const src = document.createElement('span');
    src.className = 'notif-src';
    src.textContent = n.site;
    const time = document.createElement('span');
    time.className = 'notif-time';
    time.textContent = fmtTime(n.ts);
    top.appendChild(src);
    top.appendChild(time);
    const ttl = document.createElement('div');
    ttl.className = 'notif-title';
    ttl.textContent = n.title;
    row.appendChild(top);
    row.appendChild(ttl);
    if (n.body) {
      const bd = document.createElement('div');
      bd.className = 'notif-body';
      bd.textContent = n.body;
      row.appendChild(bd);
    }
    list.appendChild(row);
  }
}

function toggleNotifications() {
  const p = document.getElementById('notifPanel');
  if (!p) return;
  if (!p.hidden) { p.hidden = true; return; }
  p.classList.toggle('mac', /Mac/i.test(navigator.platform || navigator.userAgent || ''));
  renderNotifications();
  p.hidden = false;
  notifUnread = 0;
  updateNotifBadge();
  const btn = document.getElementById('notifBtn');
  const r = btn ? btn.getBoundingClientRect() : { right: 60, left: 0, top: 80 };
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let x = r.right + 8;
  if (x + pw > window.innerWidth - 8) x = r.left - pw - 8;
  if (x < 8) x = 8;
  let y = r.top;
  if (y + ph > window.innerHeight - 8) y = window.innerHeight - ph - 8;
  if (y < 8) y = 8;
  p.style.left = x + 'px';
  p.style.top = y + 'px';
}

function dismissNotification(id) {
  const i = notifications.findIndex((n) => n.id === id);
  if (i >= 0) notifications.splice(i, 1);
  renderNotifications();
}

function clearNotifications() {
  notifications.length = 0;
  notifUnread = 0;
  updateNotifBadge();
  renderNotifications();
}

/* ===========================================================================
   Boot
   =========================================================================== */
async function boot() {
  const cfg = await api.getConfig();
  state.sites = cfg.sites || [];
  state.settings = cfg.settings;
  try { webviewPreloadUrl = await api.getWebviewPreloadUrl(); } catch (e) { webviewPreloadUrl = null; }
  if (!state.settings.sidebar) state.settings.sidebar = { dock: 'left', size: 248, compact: false };
  if (!state.settings.scheme) state.settings.scheme = 'blue';
  if (!state.settings.font) state.settings.font = 'system';
  if (!state.settings.profile) state.settings.profile = { name: '', avatar: null, avatarColor: null };
  if (!state.settings.updates) state.settings.updates = { autoCheck: true };
  if (!state.settings.notifications) state.settings.notifications = { os: true, apps: {} };
  if (state.settings.showAddressBar === undefined) state.settings.showAddressBar = true;
  if (state.settings.appIconColor === undefined) state.settings.appIconColor = null;

  setTheme(state.settings.theme);
  applySidebar();
  applyProfile();
  applyPerformance();

  const suggestions = await api.getSuggestions();
  renderSuggestions(suggestions);

  wireEvents();
  renderTabs();
  updateEmptyState();
  updateSmoothwallDot(await api.getSmoothwallStatus());

  if (state.sites[0]) activateSite(state.sites[0].id);
}

boot();
