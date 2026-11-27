'use strict';
// Minimal, secret-free preload. The renderer gets no Node, no filesystem and no tokens.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('daming', {
  shell: 'daming-desktop',
  version: process.env.DAMING_DESKTOP_VERSION || '0.0.0',
  // Width (CSS px) the native caption buttons occupy in the top-right corner,
  // so the web top bar can reserve exactly that much and never host UI beneath
  // the close/minimise/maximise buttons. 0 when the platform draws its own
  // traffic lights on the left (macOS) or the window is fullscreen.
  captionInset: () => ipcRenderer.invoke('daming:caption-inset'),
  // Report the resolved theme so the native window chrome (caption buttons /
  // background) repaints with the page instead of staying light in night mode.
  setTheme: (theme) => ipcRenderer.invoke('daming:set-theme', theme),
  chooseDirectory: (options) => ipcRenderer.invoke('daming:choose-directory', options || {}),
  // Close-button behaviour: 'tray' hides to the system tray, 'quit' closes the app.
  getCloseBehavior: () => ipcRenderer.invoke('daming:get-close-behavior'),
  setCloseBehavior: (behavior) => ipcRenderer.invoke('daming:set-close-behavior', behavior),
  onMenu: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('daming:menu', listener);
    return () => ipcRenderer.removeListener('daming:menu', listener);
  },
});
