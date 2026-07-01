'use strict';

// This preload runs sandboxed, so it must NOT require Node core modules such as
// 'path' — only 'electron' is guaranteed available. (Doing so previously made
// the whole bridge fail, leaving the UI unclickable.) The webview-preload path
// is computed in the main process and fetched over IPC instead.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workhub', {
  getWebviewPreloadUrl: () => ipcRenderer.invoke('app:webviewPreloadUrl'),

  // ---- config / sites ----
  getConfig:        () => ipcRenderer.invoke('config:get'),
  getSuggestions:   () => ipcRenderer.invoke('config:getSuggestions'),
  setSites:         (sites) => ipcRenderer.invoke('sites:set', sites),
  resetSites:       () => ipcRenderer.invoke('sites:reset'),
  setSettings:      (settings) => ipcRenderer.invoke('settings:set', settings),

  // ---- sticky notes / to-do lists ----
  setNotes:         (notes) => ipcRenderer.invoke('notes:set', notes),
  setTodos:         (todos) => ipcRenderer.invoke('todos:set', todos),

  // ---- password vault ----
  pwAvailable:      () => ipcRenderer.invoke('pw:available'),
  pwSave:           (cred) => ipcRenderer.invoke('pw:save', cred),
  pwFill:           (origin) => ipcRenderer.invoke('pw:fill', origin),
  pwIsNever:        (origin) => ipcRenderer.invoke('pw:isNever', origin),
  pwSetNever:       (origin) => ipcRenderer.invoke('pw:setNever', origin),
  pwList:           () => ipcRenderer.invoke('pw:list'),
  pwDelete:         (target) => ipcRenderer.invoke('pw:delete', target),
  pwClear:          () => ipcRenderer.invoke('pw:clear'),

  // ---- smoothwall ----
  openSmoothwall:   () => ipcRenderer.invoke('smoothwall:open'),
  checkSmoothwall:  () => ipcRenderer.invoke('smoothwall:check'),
  getSmoothwallStatus: () => ipcRenderer.invoke('smoothwall:getStatus'),
  onSmoothwallStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('smoothwall:status', handler);
    return () => ipcRenderer.removeListener('smoothwall:status', handler);
  },

  // ---- workspace import / export ----
  exportWorkspace:  () => ipcRenderer.invoke('workspace:export'),
  importWorkspace:  () => ipcRenderer.invoke('workspace:import'),

  // ---- updates ----
  getUpdateInfo:    () => ipcRenderer.invoke('updates:info'),
  checkForUpdates:  () => ipcRenderer.invoke('updates:check'),
  installUpdate:    () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus:   (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },

  // ---- desktop notifications ----
  notifyOs:         (payload) => ipcRenderer.invoke('notify:os', payload),
  getSnooze:        () => ipcRenderer.invoke('notify:getSnooze'),
  setSnooze:        (payload) => ipcRenderer.invoke('notify:setSnooze', payload),
  onSnooze:         (cb) => {
    const handler = (_e, until) => cb(until);
    ipcRenderer.on('notify:snooze', handler);
    return () => ipcRenderer.removeListener('notify:snooze', handler);
  },
  onActivateSite:   (cb) => {
    const handler = (_e, id) => cb(id);
    ipcRenderer.on('activate-site', handler);
    return () => ipcRenderer.removeListener('activate-site', handler);
  },

  // ---- slack (native OAuth) ----
  slackStatus:      () => ipcRenderer.invoke('slack:getStatus'),
  slackSetCreds:    (creds) => ipcRenderer.invoke('slack:setCreds', creds),
  slackConnect:     () => ipcRenderer.invoke('slack:connect'),
  slackDisconnect:  () => ipcRenderer.invoke('slack:disconnect'),
  onSlackStatus:    (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('slack:status', handler);
    return () => ipcRenderer.removeListener('slack:status', handler);
  },

  // ---- misc ----
  fetchIcon:        (url) => ipcRenderer.invoke('icon:fetch', url),
  openExternal:     (url) => ipcRenderer.invoke('app:openExternal', url),
  setWindowTitle:   (title) => ipcRenderer.invoke('window:setTitle', title),
  onOpenUrlIntent:  (cb) => {
    const handler = (_e, url) => cb(url);
    ipcRenderer.on('open-url-external-intent', handler);
    return () => ipcRenderer.removeListener('open-url-external-intent', handler);
  }
});
