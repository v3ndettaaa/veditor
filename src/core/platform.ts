/**
 * Runtime detection of the desktop shell (Tauri or Electron) vs. the browser extension.
 * The extension and desktop builds share one frontend bundle; this is the
 * single switch that lets code opt into native-only APIs (file system,
 * window events, native dialogs) without breaking the extension build.
 */

export interface ElectronFileNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ElectronFileNode[];
}

export interface ElectronDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ElectronBridge {
  readonly isElectron: true;
  readonly platform: string;
  getVersion(): Promise<string>;
  takeStartupFile(): Promise<string | null>;
  openPdfDialog(): Promise<{ path: string; bytes: Uint8Array } | null>;
  savePdfDialog(suggestedName: string): Promise<string | null>;
  confirmDialog(message: string, title?: string): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
  readFile(filePath: string): Promise<Uint8Array | null>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<boolean>;
  readDir(dirPath: string): Promise<ElectronDirEntry[]>;
  buildFileTree(rootPath: string): Promise<ElectronFileNode | null>;
  renameFile(oldPath: string, newPath: string): Promise<boolean>;
  removeFile(targetPath: string): Promise<boolean>;
  revealPath(targetPath: string): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(active: boolean): Promise<boolean>;
  closeWindow(): Promise<void>;
  forceCloseWindow(): Promise<void>;
  onFullscreenChanged(callback: (isFullscreen: boolean) => void): () => void;
  onOpenFilePath(callback: (filePath: string) => void): () => void;
  onCloseRequested(callback: () => Promise<boolean>): () => void;
}

declare global {
  interface Window {
    __VEDITOR_ELECTRON__?: ElectronBridge;
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__VEDITOR_ELECTRON__?.isElectron);
}

export function getElectronBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__VEDITOR_ELECTRON__?.isElectron ? window.__VEDITOR_ELECTRON__ : null;
}

export function isDesktop(): boolean {
  return isTauri() || isElectron();
}

