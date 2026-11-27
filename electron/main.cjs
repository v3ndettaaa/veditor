'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Enable native Wayland (when active) and touchpad pinch / smooth scrolling on Linux.
if (process.platform === 'linux') {
  const hasExplicitOzone = process.argv.some((arg) => arg.startsWith('--ozone-platform'));
  const isWaylandSession = Boolean(
    process.env.WAYLAND_DISPLAY ||
      (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
  );
  if (!hasExplicitOzone) {
    if (isWaylandSession) {
      app.commandLine.appendSwitch('ozone-platform', 'wayland');
    } else {
      app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    }
  }
  app.commandLine.appendSwitch('enable-pinch');
  app.commandLine.appendSwitch('enable-smooth-scrolling');
  app.commandLine.appendSwitch(
    'enable-features',
    'UseOzonePlatform,TouchpadOverscrollHistoryNavigation'
  );
}

// Register a stable privileged custom origin (`app://veditor`) BEFORE app is ready.
// This ensures IndexedDB & localStorage persist reliably across Linux AppImage launches
// (whose mount path `/tmp/.mount_*` changes every run) and allows ES modules & PDF.js
// web workers to load without `file://` CORS limitations.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
  '.pdf': 'application/pdf'
};

function getWebRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web');
  }
  return path.resolve(__dirname, '..', 'dist', 'desktop');
}

function getWindowIconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'web', 'icons', 'icon-128.png')]
    : [
        path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.png'),
        path.resolve(__dirname, '..', 'public', 'icons', 'icon-128.png')
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function extractPdfArg(argv) {
  const startIdx = app.isPackaged ? 1 : 2;
  for (let i = startIdx; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-')) continue;
    if (arg.toLowerCase().endsWith('.pdf')) {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}

let mainWindow = null;
let startupFilePath = extractPdfArg(process.argv);
let hasCloseGuard = false;
let forceClosing = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const pdfPath = extractPdfArg(commandLine);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (pdfPath) {
        mainWindow.webContents.send('native:open-file-path', pdfPath);
      }
    } else if (pdfPath) {
      startupFilePath = pdfPath;
    }
  });
}

function registerAppProtocol() {
  const webRoot = path.resolve(getWebRoot());

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let reqPath = decodeURIComponent(url.pathname || '/');
      if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
      }

      const resolved = path.resolve(webRoot, '.' + reqPath);
      if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      let targetPath = resolved;
      let stat;
      try {
        stat = await fsp.stat(targetPath);
        if (stat.isDirectory()) {
          targetPath = path.join(targetPath, 'index.html');
          stat = await fsp.stat(targetPath);
        }
      } catch {
        return new Response('Not Found', { status: 404 });
      }

      const data = await fsp.readFile(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stat.size)
        }
      });
    } catch (err) {
      console.error('app:// protocol error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  });
}

async function buildFileTree(rootPath) {
  async function crawl(dirPath) {
    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const children = await crawl(fullPath);
        nodes.push({
          id: fullPath,
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          children
        });
      } else if (entry.name.toLowerCase().endsWith('.pdf')) {
        nodes.push({
          id: fullPath,
          name: entry.name,
          path: fullPath,
          isDirectory: false
        });
      }
    }

    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });

    return nodes;
  }

  const normalizedRoot = path.resolve(rootPath);
  const rootName = path.basename(normalizedRoot) || normalizedRoot;
  const children = await crawl(normalizedRoot);

  return {
    id: normalizedRoot,
    name: rootName,
    path: normalizedRoot,
    isDirectory: true,
    children
  };
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('app:take-startup-file', () => {
    const file = startupFilePath;
    startupFilePath = null;
    return file;
  });

  ipcMain.handle('dialog:open-pdf', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    try {
      const buf = await fsp.readFile(filePath);
      return { path: filePath, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
    } catch (err) {
      console.warn('dialog:open-pdf read failed:', err);
      return null;
    }
  });

  ipcMain.handle('dialog:save-pdf', async (_event, suggestedName) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showSaveDialog(win || undefined, {
      defaultPath: typeof suggestedName === 'string' && suggestedName ? suggestedName : 'document.pdf',
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('dialog:confirm', async (_event, message, title) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showMessageBox(win || undefined, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      title: typeof title === 'string' && title ? title : 'veditor',
      message: typeof message === 'string' ? message : ''
    });
    return result.response === 1;
  });

  ipcMain.handle('dialog:pick-directory', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:read-file', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null;
    try {
      const buf = await fsp.readFile(filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      console.warn('fs:read-file failed:', err);
      return null;
    }
  });

  ipcMain.handle('fs:write-file', async (_event, filePath, bytes) => {
    if (typeof filePath !== 'string' || !filePath || !bytes) return false;
    try {
      const buffer =
        bytes instanceof Uint8Array
          ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : Buffer.from(new Uint8Array(bytes));
      await fsp.writeFile(filePath, buffer);
      return true;
    } catch (err) {
      console.warn('fs:write-file failed:', err);
      return false;
    }
  });

  ipcMain.handle('fs:read-dir', async (_event, dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return [];
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory()
      }));
    } catch (err) {
      console.warn('fs:read-dir failed:', err);
      return [];
    }
  });

  ipcMain.handle('fs:build-file-tree', async (_event, rootPath) => {
    if (typeof rootPath !== 'string' || !rootPath) return null;
    try {
      return await buildFileTree(rootPath);
    } catch (err) {
      console.warn('fs:build-file-tree failed:', err);
      return null;
    }
  });

  ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !oldPath || !newPath) return false;
    try {
      await fsp.rename(oldPath, newPath);
      return true;
    } catch (err) {
      console.warn('fs:rename failed:', err);
      return false;
    }
  });

  ipcMain.handle('fs:remove', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return false;
    try {
      await fsp.rm(targetPath, { recursive: true, force: false });
      return true;
    } catch (err) {
      console.warn('fs:remove failed:', err);
      return false;
    }
  });

  ipcMain.handle('shell:reveal-path', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return false;
    try {
      shell.showItemInFolder(targetPath);
      return true;
    } catch (err) {
      console.warn('shell:reveal-path failed:', err);
      return false;
    }
  });

  ipcMain.handle('window:is-fullscreen', () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    return win ? win.isFullScreen() : false;
  });

  ipcMain.handle('window:set-fullscreen', (_event, active) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return false;
    win.setFullScreen(Boolean(active));
    return win.isFullScreen();
  });

  ipcMain.on('window:register-close-guard', () => {
    hasCloseGuard = true;
  });

  ipcMain.handle('window:close', () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.close();
  });

  ipcMain.handle('window:force-close', () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) {
      forceClosing = true;
      win.close();
    }
  });
}

function createMainWindow() {
  hasCloseGuard = false;
  forceClosing = false;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: 'veditor',
    backgroundColor: '#050507',
    autoHideMenuBar: true,
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow = win;

  // Allow Chromium visual zoom limits > 1 (like Chrome) so Wayland/touchpad pinch
  // gestures are synthesized into ctrl+wheel events for veditor's PDF canvas.
  // Preload prevents non-PDF UI chrome from zooming on unhandled ctrl+wheel events.
  const applyVisualZoomLimits = () => {
    if (win.isDestroyed()) return;
    win.webContents.setVisualZoomLevelLimits(1, 3).catch(() => {});
    win.webContents.setZoomFactor(1);
  };
  applyVisualZoomLimits();
  win.webContents.on('dom-ready', applyVisualZoomLimits);
  win.webContents.on('did-finish-load', applyVisualZoomLimits);

  // Fallback: if Chromium routes a pinch/zoom gesture through WebContents zoom-changed
  // instead of a cancelable wheel event, keep the app chrome at 1:1 and forward it to
  // the PDF viewport in preload.
  win.webContents.on('zoom-changed', (_event, zoomDirection) => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(1);
    win.webContents.send('native:pinch-zoom-fallback', zoomDirection);
  });

  // Route external links (`target="_blank"`, `window.open`) safely to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block top-level navigation away from the local app origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://veditor/')) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      }
    }
  });

  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:fullscreen-changed', true);
    }
  });

  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:fullscreen-changed', false);
    }
  });

  win.on('close', (event) => {
    if (forceClosing || !hasCloseGuard || win.isDestroyed()) return;
    event.preventDefault();
    win.webContents.send('window:close-requested');
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  void win.loadURL('app://veditor/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
