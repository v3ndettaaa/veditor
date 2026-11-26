'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__VEDITOR_ELECTRON__', {
  isElectron: true,
  platform: process.platform,

  getVersion: () => ipcRenderer.invoke('app:get-version'),
  takeStartupFile: () => ipcRenderer.invoke('app:take-startup-file'),

  openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdf'),
  savePdfDialog: (suggestedName) => ipcRenderer.invoke('dialog:save-pdf', suggestedName),
  confirmDialog: (message, title) => ipcRenderer.invoke('dialog:confirm', message, title),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),

  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('fs:write-file', filePath, bytes),
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  buildFileTree: (rootPath) => ipcRenderer.invoke('fs:build-file-tree', rootPath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  removeFile: (targetPath) => ipcRenderer.invoke('fs:remove', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal-path', targetPath),

  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setFullscreen: (active) => ipcRenderer.invoke('window:set-fullscreen', active),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  forceCloseWindow: () => ipcRenderer.invoke('window:force-close'),

  onFullscreenChanged: (callback) => {
    const listener = (_event, isFullscreen) => callback(Boolean(isFullscreen));
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },

  onOpenFilePath: (callback) => {
    const listener = (_event, filePath) => {
      if (typeof filePath === 'string' && filePath) callback(filePath);
    };
    ipcRenderer.on('native:open-file-path', listener);
    return () => ipcRenderer.removeListener('native:open-file-path', listener);
  },

  onCloseRequested: (callback) => {
    ipcRenderer.send('window:register-close-guard');
    const listener = async () => {
      try {
        const canClose = await callback();
        if (canClose) {
          await ipcRenderer.invoke('window:force-close');
        }
      } catch (err) {
        console.error('Close confirmation handler failed:', err);
      }
    };
    ipcRenderer.on('window:close-requested', listener);
    return () => ipcRenderer.removeListener('window:close-requested', listener);
  }
});
