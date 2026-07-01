'use strict';

/* ===========================================================================
   WorkHub — per-site preload
   Runs inside every embedded website. Its only job is to power the
   "Add to Links" gesture: Alt + right-click on a hyperlink. It reports the
   link up to the WorkHub host UI (the window that embeds this <webview>),
   which then shows the context menu. No page content is ever read or sent
   beyond the clicked link's URL and visible text.
   =========================================================================== */

const { ipcRenderer } = require('electron');

// Ask the browser to keep this site's storage (cookies / localStorage /
// IndexedDB) persistent, so logins aren't evicted under memory pressure and
// you stay signed in.
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

// Spoof User-Agent Client Hints in the page's own world so apps like Slack
// (which read navigator.userAgentData, not just the UA string) see a current
// Chrome and stop showing "this browser is no longer supported". Runs at
// document-start via an injected <script> so it lands before the app's checks.
try {
  const V = '137';
  const s = document.createElement('script');
  s.textContent = '(' + function (v) {
    try {
      var brands = [
        { brand: 'Not/A)Brand', version: '24' },
        { brand: 'Chromium', version: v },
        { brand: 'Google Chrome', version: v }
      ];
      var data = {
        brands: brands, mobile: false, platform: 'Windows',
        getHighEntropyValues: function () {
          return Promise.resolve({
            brands: brands, mobile: false, platform: 'Windows', platformVersion: '15.0.0',
            architecture: 'x86', bitness: '64', model: '', uaFullVersion: v + '.0.0.0',
            fullVersionList: brands.map(function (b) { return { brand: b.brand, version: b.version + '.0.0.0' }; })
          });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: 'Windows' }; }
      };
      Object.defineProperty(navigator, 'userAgentData', { get: function () { return data; }, configurable: true });
    } catch (e) {}
  }.toString() + ')("' + V + '");';
  (document.documentElement || document.head || document).appendChild(s);
  s.remove();
} catch (e) {}

// Alt + right-click on a hyperlink -> tell the host to show our menu.
window.addEventListener('contextmenu', (e) => {
  if (!e.altKey) return;                              // only our gesture
  const anchor = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
  if (!anchor) return;                                // only over real links
  const href = anchor.href;                           // resolved absolute URL
  if (!/^https?:/i.test(href)) return;                // only web links
  e.preventDefault();
  e.stopPropagation();
  ipcRenderer.sendToHost('workhub-link-menu', {
    x: e.clientX,
    y: e.clientY,
    href,
    text: (anchor.textContent || anchor.getAttribute('aria-label') || '').trim().slice(0, 80)
  });
}, true);

// Clicking normally anywhere in the page closes any open WorkHub menu.
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;                          // left-click only
  ipcRenderer.sendToHost('workhub-dismiss-menu');
}, true);

// Capture the page's web Notifications so WorkHub can badge + list them.
try {
  const Orig = window.Notification;
  if (Orig) {
    const Wrapped = function (title, options) {
      try {
        ipcRenderer.sendToHost('workhub-notification', {
          title: String(title || ''),
          body: (options && options.body) || '',
          ts: Date.now()
        });
      } catch (e) {}
      return new Orig(title, options);
    };
    Wrapped.requestPermission = function () { return Orig.requestPermission.apply(Orig, arguments); };
    try { Object.defineProperty(Wrapped, 'permission', { get: function () { return Orig.permission; } }); } catch (e) {}
    Wrapped.prototype = Orig.prototype;
    window.Notification = Wrapped;
  }
} catch (e) {}

/* ---------------------------------------------------------------------------
   Password capture & auto-fill
   On submit/login we report the entered username+password to the host (which
   offers to save them, encrypted). On load we ask the host for any saved login
   for this exact origin and fill empty fields. Plaintext never touches disk
   here — it only flows through the host to/from the encrypted main-process vault.
   --------------------------------------------------------------------------- */
(function () {
  function findLoginFields() {
    const pw = document.querySelector('input[type="password"]');
    if (!pw) return null;
    let user = null;
    const all = Array.from(document.querySelectorAll('input'));
    const pwIdx = all.indexOf(pw);
    for (let i = pwIdx - 1; i >= 0; i--) {                       // nearest text/email field before the password
      const t = (all[i].type || 'text').toLowerCase();
      if (t === 'text' || t === 'email' || t === 'tel' || !all[i].type) { user = all[i]; break; }
    }
    if (!user) {
      user = document.querySelector('input[type="email"], input[type="text"], input[autocomplete="username"]');
    }
    return { user: user, pw: pw };
  }

  function report() {
    try {
      const f = findLoginFields();
      if (!f || !f.pw || !f.pw.value) return;
      ipcRenderer.sendToHost('workhub-cred-captured', {
        origin: location.origin,
        username: f.user ? (f.user.value || '') : '',
        password: f.pw.value
      });
    } catch (e) {}
  }

  // Capture submissions a few different ways (plain forms + SPA login buttons).
  window.addEventListener('submit', report, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.type === 'password') report();
  }, true);
  window.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
    if (btn) setTimeout(report, 0);
  }, true);

  // Auto-fill -----------------------------------------------------------------
  let filled = false;
  function requestFill() {
    if (filled) return;
    try {
      const f = findLoginFields();
      if (f && f.pw) ipcRenderer.sendToHost('workhub-cred-request', { origin: location.origin });
    } catch (e) {}
  }
  ipcRenderer.on('workhub-cred-fill', (_e, data) => {
    try {
      if (!data || !data.password || filled) return;
      const f = findLoginFields();
      if (!f || !f.pw) return;
      if (f.user && data.username && !f.user.value) {
        f.user.value = data.username;
        f.user.dispatchEvent(new Event('input', { bubbles: true }));
        f.user.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (!f.pw.value) {
        f.pw.value = data.password;
        f.pw.dispatchEvent(new Event('input', { bubbles: true }));
        f.pw.dispatchEvent(new Event('change', { bubbles: true }));
      }
      filled = true;
    } catch (e) {}
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', requestFill);
  else requestFill();
  window.addEventListener('load', requestFill);
  setTimeout(requestFill, 1200);
  setTimeout(requestFill, 3000);

  // Best-effort one-line "what's here" summary for the launch digest.
  function pageSummary() {
    try {
      const parts = [];
      const um = (document.title || '').match(/\((\d+)\+?\)/);
      if (um) parts.push(um[1] + ' unread');
      const h = document.querySelector('h1, [role="heading"][aria-level="1"], [role="heading"]');
      if (h && h.textContent && h.textContent.trim()) parts.push(h.textContent.trim().replace(/\s+/g, ' ').slice(0, 80));
      return parts.join(' · ');
    } catch (e) { return ''; }
  }
  function reportSummary() {
    try { ipcRenderer.sendToHost('workhub-page-summary', { summary: pageSummary() }); } catch (e) {}
  }
  window.addEventListener('load', function () { setTimeout(reportSummary, 1500); });
})();
