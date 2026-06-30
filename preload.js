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
  onActivateSite:   (cb) => {
    const handler = (_e, id) => cb(id);
    ipcRenderer.on('activate-site', handler);
    return () => ipcRenderer.removeListener('activate-site', handler);
  },

  // ---- misc ----
  openExternal:     (url) => ipcRenderer.invoke('app:openExternal', url),
  setWindowTitle:   (title) => ipcRenderer.invoke('window:setTitle', title),
  onOpenUrlIntent:  (cb) => {
    const handler = (_e, url) => cb(url);
    ipcRenderer.on('open-url-external-intent', handler);
    return () => ipcRenderer.removeListener('open-url-external-intent', handler);
  }
});
