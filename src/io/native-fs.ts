/**
 * Thin wrapper around Tauri's native dialog/fs/app/window APIs.
 * Every export is a safe no-op (returns null/false) outside the desktop
 * shell, so callers can use these unconditionally without duplicating
 * `isDesktop()` checks, and the browser/extension bundle never has to load
 * `@tauri-apps/*` at all (dynamic imports keep it out of that bundle).
 */
import { isDesktop } from '../core/platform';

export async function nativeOpenPdfDialog(): Promise<{ path: string; bytes: Uint8Array } | null> {
  if (!isDesktop()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    multiple: false,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (!path || Array.isArray(path)) return null;
  const bytes = await nativeReadFile(path);
  if (!bytes) return null;
  return { path, bytes };
}

export async function nativeReadFile(path: string): Promise<Uint8Array | null> {
  if (!isDesktop()) return null;
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    return await readFile(path);
  } catch (e) {
    console.warn('Native read failed:', e);
    return null;
  }
}

export async function nativeWriteFile(path: string, bytes: Uint8Array): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return true;
  } catch (e) {
    console.warn('Native write failed:', e);
    return false;
  }
}

/** Native "Save As" location picker. Returns the chosen absolute path, or null if cancelled. */
export async function nativeSaveAsDialog(suggestedName: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  return path ?? null;
}

/** Native-look confirm dialog; falls back to `window.confirm` outside desktop. */
export async function nativeConfirm(message: string, title = 'veditor'): Promise<boolean> {
  if (!isDesktop()) return window.confirm(message);
  try {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return await confirm(message, { title });
  } catch {
    return window.confirm(message);
  }
}

/** Recursively lists directory entries (files + folders) under `path`. */
export interface NativeDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export async function nativePickDirectory(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ directory: true, multiple: false });
  if (!path || Array.isArray(path)) return null;
  return path;
}

export async function nativeReadDir(path: string): Promise<NativeDirEntry[]> {
  if (!isDesktop()) return [];
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const entries = await readDir(path);
    return Promise.all(entries.map(async (e: any) => ({
      name: e.name,
      path: await join(path, e.name),
      isDirectory: !!e.isDirectory
    })));
  } catch (e) {
    console.warn('Native readDir failed:', e);
    return [];
  }
}

/** Resolves once with the path from `take_startup_file`, or null if launched without a file argument. */
export async function takeStartupFilePath(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('take_startup_file');
  } catch {
    return null;
  }
}

/** Fires `handler(path)` whenever a second app launch (file association / "Open with") hands off a file. */
export function onNativeOpenFilePath(handler: (path: string) => void): void {
  if (!isDesktop()) return;
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<string>('open-file-path', (event) => handler(event.payload));
  });
}

/**
 * Intercepts the OS window-close request (title-bar X, Alt+F4, Cmd+Q).
 * `handler` resolves `true` to allow the close, `false` to cancel it.
 */
export async function onWindowCloseRequested(handler: () => Promise<boolean>): Promise<void> {
  if (!isDesktop()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    const canClose = await handler();
    if (!canClose) event.preventDefault();
  });
}

export async function nativeCloseWindow(): Promise<void> {
  if (!isDesktop()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().destroy();
}
