// Reamlet — Electron main process
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

import type { BrowserWindow as BW, NativeImage, IpcMainInvokeEvent, IpcMainEvent, Event as ElectronEvent } from 'electron';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
const { exec } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');

// ── Window factory ─────────────────────────────────────────────

const isMac = process.platform === 'darwin';

function createWindow(openFilePath: string | null, showInactive = false): BW {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: 'Reamlet',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
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

  win.once('ready-to-show', () => {
    if (showInactive) win.showInactive();
    else win.show();
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Ask renderer to handle the close so it can prompt for unsaved changes
  win.on('close', (e: ElectronEvent) => {
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
      } catch { /* ignore */ }
    });
  }

  return win;
}

function buildMenu(): void {
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
        { label: 'Extension ID…', click: () => fw()?.webContents.send('menu-extension-id') },
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

let _dragIcon: NativeImage | null = null;
function getDragIcon(): NativeImage {
  if (_dragIcon) return _dragIcon;
  _dragIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return _dragIcon!;
}

// ── IPC handlers ───────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async (event: IpcMainInvokeEvent) => {
  const win    = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title:      'Open PDF',
    filters:    [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.map((filePath: string) => ({
    filePath,
    buffer: Buffer.from(fs.readFileSync(filePath)),
  }));
});

ipcMain.handle('save-file', async (event: IpcMainInvokeEvent, filePath: string, arrayBuffer: ArrayBuffer) => {
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
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('save-file-copy', async (event: IpcMainInvokeEvent, arrayBuffer: ArrayBuffer, defaultPath?: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // Default to the user's Downloads folder so saves land somewhere sensible.
  const fallbackDir = app.getPath('downloads');
  const resolvedDefault = defaultPath ?? path.join(fallbackDir, 'document.pdf');
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Copy',
    defaultPath: resolvedDefault,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(arrayBuffer));
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Open a new Reamlet window, optionally pre-loading a file
ipcMain.handle('open-new-window', (_event: IpcMainInvokeEvent, filePath?: string) => {
  createWindow(filePath || null);
  return { ok: true };
});

// Return the BrowserWindow ID so the renderer can tag its drags
ipcMain.handle('get-window-id', (event: IpcMainInvokeEvent) => {
  return BrowserWindow.fromWebContents(event.sender)?.id ?? null;
});

// Read a file from disk and return its buffer (used for cross-window tab drops)
ipcMain.handle('open-file-from-path', (_event: IpcMainInvokeEvent, filePath: string) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { filePath, buffer: Buffer.from(buffer) };
  } catch {
    return null;
  }
});

// Show a native message box and return the index of the button pressed
ipcMain.handle('show-message-box', async (event: IpcMainInvokeEvent, options: Electron.MessageBoxOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, options);
  return response;
});

// Bring this window to the front (called when an external drag hovers over it)
ipcMain.handle('focus-window', (event: IpcMainInvokeEvent) => {
  BrowserWindow.fromWebContents(event.sender)?.focus();
  return { ok: true };
});

// Destroy window unconditionally (after renderer confirms close is OK)
ipcMain.handle('force-close', (event: IpcMainInvokeEvent) => {
  BrowserWindow.fromWebContents(event.sender)?.destroy();
  return { ok: true };
});

// Custom window controls
ipcMain.handle('minimize-window',  (event: IpcMainInvokeEvent) => { BrowserWindow.fromWebContents(event.sender)?.minimize();  return { ok: true }; });
ipcMain.handle('toggle-maximize',  (event: IpcMainInvokeEvent) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) { if (w.isMaximized()) { w.unmaximize(); } else { w.maximize(); } } return { ok: true }; });
ipcMain.handle('close-window',     (event: IpcMainInvokeEvent) => { BrowserWindow.fromWebContents(event.sender)?.close();     return { ok: true }; });

// Tell the source window to close the tab that was dragged into another window
ipcMain.handle('notify-tab-transferred', (_event: IpcMainInvokeEvent, sourceWindowId: number, filePath: string) => {
  const win = BrowserWindow.fromId(sourceWindowId);
  if (win) win.webContents.send('close-tab-by-filepath', filePath);
  return { ok: true };
});

ipcMain.on('open-devtools', (event: IpcMainEvent) => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
});

// Copy a file to the system clipboard via PowerShell so it can be pasted
// into Windows Explorer, email clients, etc.
ipcMain.handle('copy-file-to-clipboard', (_event: IpcMainInvokeEvent, filePath: string) => {
  const escaped = filePath.replace(/'/g, "''");
  const cmd = `powershell -command "Set-Clipboard -Path '${escaped}'"`;
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    exec(cmd, (error: Error | null) => {
      if (error) resolve({ ok: false, error: error.message });
      else resolve({ ok: true });
    });
  });
});

// Show the file in its containing folder in Windows Explorer / Finder
ipcMain.handle('reveal-in-explorer', (_event: IpcMainInvokeEvent, filePath: string) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
});

// Read / write the extension ID in the native messaging host manifest.
// The manifest lives next to the Reamlet exe (installed and portable builds).
function getManifestPath(): string {
  return path.join(path.dirname(process.execPath), 'com.reamlet.chromebridge.json');
}

ipcMain.handle('get-extension-id', () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(getManifestPath(), 'utf8'));
    const origins: string[] = manifest.allowed_origins ?? [];
    const id = origins.map((o: string) => {
      const m = o.match(/^chrome-extension:\/\/([^/]+)\/$/);
      return m ? m[1] : null;
    }).filter(Boolean)[0] ?? '';
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('set-extension-id', (_event: IpcMainInvokeEvent, id: string) => {
  try {
    const p = getManifestPath();
    const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
    manifest.allowed_origins = [`chrome-extension://${id}/`];
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Initiate a native OS file drag so external apps (Outlook, Explorer, etc.) can receive the file.
// Must be ipcMain.on (synchronous) — startDrag() must be called in the same tick as the IPC event.
ipcMain.on('start-drag', (event: IpcMainEvent, filePath: string) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  event.sender.startDrag({ file: filePath, icon: getDragIcon() });
});

// ── App lifecycle ──────────────────────────────────────────────

// On macOS, file-open requests arrive via this event (not argv).
// It can fire before app is ready, so queue the path if needed.
let _pendingOpenFile: string | null = null;

app.on('open-file', (e: ElectronEvent, filePath: string) => {
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

// ── URL / file argument helpers ────────────────────────────────

function isHttpUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

// Extract the first useful argument: an http/https URL, or a local .pdf path.
function getArgvTarget(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    if (isHttpUrl(a)) return a;
    if (a.toLowerCase().endsWith('.pdf')) {
      try { if (fs.existsSync(a)) return a; } catch { /* ignore */ }
    }
  }
  return null;
}

// Delete files in %TEMP%\ReamletDownloads that are older than 24 hours.
function _cleanupTempDownloads() {
  const tempDir = path.join(os.tmpdir(), 'ReamletDownloads');
  const oneDayMs = 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(tempDir)) {
      const filePath = path.join(tempDir, file);
      try {
        if (now - fs.statSync(filePath).mtimeMs > oneDayMs) fs.unlinkSync(filePath);
      } catch { /* file in use or already gone */ }
    }
  } catch { /* dir doesn't exist yet */ }
}

_cleanupTempDownloads();
setInterval(_cleanupTempDownloads, 60 * 60 * 1000);

// Download a remote PDF to %TEMP%\ReamletDownloads and return the local path.
// Follows up to 5 redirects. Rejects on HTTP errors or network failures.
function downloadPdfToTemp(url: string, redirectsLeft = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }

    const tempDir = path.join(os.tmpdir(), 'ReamletDownloads');
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch { /* already exists */ }

    const protocol = url.startsWith('https://') ? https : http;
    const req = protocol.get(url, (res: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> }) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const location = res.headers['location'];
        if (location) {
          resolve(downloadPdfToTemp(location, redirectsLeft - 1));
          return;
        }
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let fileName: string;
      try {
        const base = path.basename(new URL(url).pathname) || 'download';
        fileName = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
      } catch {
        fileName = 'download.pdf';
      }
      const filePath = path.join(tempDir, fileName);
      const fileStream = fs.createWriteStream(filePath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(filePath); });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Resolve a target (URL or local path) to a local file path ready for opening.
async function resolveTarget(target: string): Promise<string | null> {
  if (isHttpUrl(target)) {
    try { return await downloadPdfToTemp(target); } catch { return null; }
  }
  return target;
}

// Single-instance lock: if another Reamlet is already running, forward the
// file to it and quit, so the user always ends up with one window.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event: ElectronEvent, argv: string[]) => {
    const target     = getArgvTarget(argv);
    const background = argv.includes('--background');
    // Find the existing window, bring it forward, and open the file as a new tab
    const wins = BrowserWindow.getAllWindows();
    const win  = wins[0];
    if (!win) return;
    if (!background) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (target) {
      const filePath = await resolveTarget(target);
      if (filePath) {
        try {
          const buffer = fs.readFileSync(filePath);
          win.webContents.send('open-file-data', { filePath, buffer: buffer.buffer });
        } catch { /* ignore */ }
      }
    }
  });

  app.whenReady().then(async () => {
    const pendingTarget = _pendingOpenFile || getArgvTarget(process.argv);
    _pendingOpenFile = null;
    const openPath   = pendingTarget ? await resolveTarget(pendingTarget) : null;
    const background = process.argv.includes('--background');
    createWindow(openPath, background);
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
