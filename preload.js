// PDFox — preload script
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File open dialog → [{ filePath, buffer }] or null
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  // Overwrite file at filePath
  saveFile: (filePath, arrayBuffer) => ipcRenderer.invoke('save-file', filePath, arrayBuffer),

  // Save-as dialog
  saveFileCopy: (arrayBuffer) => ipcRenderer.invoke('save-file-copy', arrayBuffer),

  // Open a new window, optionally preloading a file path
  openNewWindow: (filePath) => ipcRenderer.invoke('open-new-window', filePath),

  // This window's Electron BrowserWindow ID (for cross-window drag tagging)
  getWindowId: () => ipcRenderer.invoke('get-window-id'),

  // Read a PDF from disk (for cross-window tab drag target)
  openFileFromPath: (filePath) => ipcRenderer.invoke('open-file-from-path', filePath),

  // Tell the source window to close the tab that was just accepted here
  notifyTabTransferred: (sourceWindowId, filePath) =>
    ipcRenderer.invoke('notify-tab-transferred', sourceWindowId, filePath),

  // Subscribe to menu events
  onMenuEvent: (callback) => {
    ['menu-open', 'menu-save', 'menu-save-copy', 'menu-close-tab', 'menu-reopen-tab']
      .forEach(ev => ipcRenderer.on(ev, () => callback(ev)));
  },

  // File data pushed from main when a new window opens with a pre-selected file
  onOpenFileData: (callback) => {
    ipcRenderer.on('open-file-data', (_e, data) => callback(data));
  },

  // Main relays this when another window accepted one of our tabs via drag
  onCloseTabByFilepath: (callback) => {
    ipcRenderer.on('close-tab-by-filepath', (_e, filePath) => callback(filePath));
  },

  // Initiate a native OS file drag (for dragging into Outlook, Explorer, etc.)
  startDrag: (filePath) => ipcRenderer.send('start-drag', filePath),

  // Scale the entire UI (webFrame zoom, 1.0 = 100%)
  setUiZoom: (factor) => webFrame.setZoomFactor(factor),
  getUiZoom: () => webFrame.getZoomFactor(),

  // Custom window controls (used because frame: false removes native chrome)
  minimizeWindow:  () => ipcRenderer.invoke('minimize-window'),
  toggleMaximize:  () => ipcRenderer.invoke('toggle-maximize'),
  closeWindow:     () => ipcRenderer.invoke('close-window'),

  // Current platform — lets the renderer apply Mac-specific UI adjustments
  platform: process.platform,

  // Toggle DevTools for the current window
  openDevTools: () => ipcRenderer.send('open-devtools'),

  // Bring this window to the front (used when an external tab drag hovers over it)
  focusWindow: () => ipcRenderer.invoke('focus-window'),

  // Destroy window after renderer confirms close (for unsaved-changes dialog)
  forceClose: () => ipcRenderer.invoke('force-close'),

  // Main fires this when the OS close button is pressed
  onBeforeClose: (callback) => {
    ipcRenderer.on('before-close', () => callback());
  },
});
