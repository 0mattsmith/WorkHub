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
