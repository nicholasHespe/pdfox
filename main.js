// PDFox — Electron main process
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Window factory ─────────────────────────────────────────────

const isMac = process.platform === 'darwin';

function createWindow(openFilePath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: 'PDFox',
    icon: path.join(__dirname, 'assets', 'pdfox_logo.png'),
    backgroundColor: '#1e1e1e',
    // Mac: use native traffic lights with hidden titlebar; Windows: fully custom frame
    ...(isMac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 13 } }
      : { frame: false }
    ),
    autoHideMenuBar: true, // hide native menu bar; accelerators still work
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ask renderer to handle the close so it can prompt for unsaved changes
  win.on('close', (e) => {
    e.preventDefault();
    win.webContents.send('before-close');
  });

  if (openFilePath) {
    win.webContents.once('did-finish-load', () => {
      try {
        const buffer = fs.readFileSync(openFilePath);
        win.webContents.send('open-file-data', {
          filePath: openFilePath,
          buffer:   buffer.buffer,
        });
      } catch (_) { /* ignore */ }
    });
  }

  return win;
}

function buildMenu() {
  const fw = () => BrowserWindow.getFocusedWindow();
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…',       accelerator: 'CmdOrCtrl+O',       click: () => fw()?.webContents.send('menu-open') },
        { label: 'Save',        accelerator: 'CmdOrCtrl+S',       click: () => fw()?.webContents.send('menu-save') },
        { label: 'Save Copy…',  accelerator: 'CmdOrCtrl+Shift+S', click: () => fw()?.webContents.send('menu-save-copy') },
        { type: 'separator' },
        { label: 'Close Tab',       accelerator: 'CmdOrCtrl+W',           click: () => fw()?.webContents.send('menu-close-tab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T',  click: () => fw()?.webContents.send('menu-reopen-tab') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Drag icon (created once, reused for all native file drags) ──

let _dragIcon = null;
function getDragIcon() {
  if (_dragIcon) return _dragIcon;
  _dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'pdfox_logo.png'));
  return _dragIcon;
}

// ── IPC handlers ───────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async (event) => {
  const win    = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title:      'Open PDF',
    filters:    [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.map(filePath => ({
    filePath,
    buffer: Buffer.from(fs.readFileSync(filePath)),
  }));
});

ipcMain.handle('save-file', async (event, filePath, arrayBuffer) => {
  if (!filePath) return { ok: false, error: 'no file path' };
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Replace', 'Cancel'],
    defaultId: 0, cancelId: 1,
    title: 'Save', message: `Replace "${path.basename(filePath)}"?`,
    detail: 'The existing file will be overwritten with your annotated version.',
  });
  if (response !== 0) return { ok: false, error: 'cancelled' };
  try {
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-copy', async (event, arrayBuffer) => {
  const win    = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Copy', filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(arrayBuffer));
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Open a new PDFox window, optionally pre-loading a file
ipcMain.handle('open-new-window', (_event, filePath) => {
  createWindow(filePath || null);
  return { ok: true };
});

// Return the BrowserWindow ID so the renderer can tag its drags
ipcMain.handle('get-window-id', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.id ?? null;
});

// Read a file from disk and return its buffer (used for cross-window tab drops)
ipcMain.handle('open-file-from-path', (_event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { filePath, buffer: Buffer.from(buffer) };
  } catch (_) {
    return null;
  }
});

// Bring this window to the front (called when an external drag hovers over it)
ipcMain.handle('focus-window', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.focus();
  return { ok: true };
});

// Destroy window unconditionally (after renderer confirms close is OK)
ipcMain.handle('force-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.destroy();
  return { ok: true };
});

// Custom window controls
ipcMain.handle('minimize-window',  (event) => { BrowserWindow.fromWebContents(event.sender)?.minimize();  return { ok: true }; });
ipcMain.handle('toggle-maximize',  (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); return { ok: true }; });
ipcMain.handle('close-window',     (event) => { BrowserWindow.fromWebContents(event.sender)?.close();     return { ok: true }; });

// Tell the source window to close the tab that was dragged into another window
ipcMain.handle('notify-tab-transferred', (_event, sourceWindowId, filePath) => {
  const win = BrowserWindow.fromId(sourceWindowId);
  if (win) win.webContents.send('close-tab-by-filepath', filePath);
  return { ok: true };
});

ipcMain.on('open-devtools', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
});

// Initiate a native OS file drag so external apps (Outlook, Explorer, etc.) can receive the file.
// Must be ipcMain.on (synchronous) — startDrag() must be called in the same tick as the IPC event.
ipcMain.on('start-drag', (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  event.sender.startDrag({ file: filePath, icon: getDragIcon() });
});

// ── App lifecycle ──────────────────────────────────────────────

// On macOS, file-open requests arrive via this event (not argv).
// It can fire before app is ready, so queue the path if needed.
let _pendingOpenFile = null;

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (!app.isReady()) {
    _pendingOpenFile = filePath;
    return;
  }
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const win = wins[0];
    if (win.isMinimized()) win.restore();
    win.focus();
    try {
      const buffer = fs.readFileSync(filePath);
      win.webContents.send('open-file-data', { filePath, buffer: buffer.buffer });
    } catch { /* ignore */ }
  } else {
    createWindow(filePath);
  }
});

// Extract a .pdf path from an argv array (skips flags and the executable itself)
function getArgvFile(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a && !a.startsWith('-') && a.toLowerCase().endsWith('.pdf')) {
      try { if (fs.existsSync(a)) return a; } catch { /* ignore */ }
    }
  }
  return null;
}

// Single-instance lock: if another PDFox is already running, forward the
// file to it and quit, so the user always ends up with one window.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = getArgvFile(argv);
    // Find the existing window, bring it forward, and open the file as a new tab
    const wins = BrowserWindow.getAllWindows();
    const win  = wins[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (filePath) {
      try {
        const buffer = fs.readFileSync(filePath);
        win.webContents.send('open-file-data', { filePath, buffer: buffer.buffer });
      } catch { /* ignore */ }
    }
  });

  app.whenReady().then(() => {
    createWindow(_pendingOpenFile || getArgvFile(process.argv));
    _pendingOpenFile = null;
    buildMenu();
  });

  // Mac: keep the app running when the last window is closed (dock icon stays)
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  // Mac: re-open a window when the dock icon is clicked with none open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
  });
}
