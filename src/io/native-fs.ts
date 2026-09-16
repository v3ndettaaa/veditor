/**
 * Thin wrapper around Tauri's native dialog/fs/app/window APIs.
 * Every export is a safe no-op (returns null/false) outside the desktop
 * shell, so callers can use these unconditionally without duplicating
 * `isDesktop()` checks.
 */
import { isDesktop } from '../core/platform';

export interface FileNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export interface NativeDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Prevents path traversal vulnerability against unauthorized scope escaping. */
export function sanitizePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(p => p !== '.' && p !== '');
  const safeParts: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      safeParts.pop();
    } else {
      safeParts.push(part);
    }
  }
  return safeParts.join('/');
}

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

export async function nativeSaveAsDialog(suggestedName: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  return path ?? null;
}

export async function nativeConfirm(message: string, title = 'veditor'): Promise<boolean> {
  if (!isDesktop()) return window.confirm(message);
  try {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return await confirm(message, { title });
  } catch {
    return window.confirm(message);
  }
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

/**
 * PIPE_5: Recursive crawl of directory tree filtering .pdf files.
 * Sorted [dirs_first: true, alpha: asc].
 */
export async function nativeBuildFileTree(rootPath: string): Promise<FileNode | null> {
  if (!isDesktop()) return null;
  const safeRoot = sanitizePath(rootPath);

  async function crawl(dirPath: string): Promise<FileNode[]> {
    const entries = await nativeReadDir(dirPath);
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) {
        const children = await crawl(entry.path);
        nodes.push({
          id: entry.path,
          name: entry.name,
          path: entry.path,
          isDirectory: true,
          children
        });
      } else if (entry.name.toLowerCase().endsWith('.pdf')) {
        nodes.push({
          id: entry.path,
          name: entry.name,
          path: entry.path,
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

  const rootName = safeRoot.split(/[\\/]/).pop() || safeRoot;
  const children = await crawl(rootPath);
  return {
    id: rootPath,
    name: rootName,
    path: rootPath,
    isDirectory: true,
    children
  };
}

export async function nativeRenameFile(oldPath: string, newPath: string): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { rename } = await import('@tauri-apps/plugin-fs');
    await rename(oldPath, newPath);
    return true;
  } catch (e) {
    console.warn('Native rename failed:', e);
    return false;
  }
}

export async function nativeRemoveFile(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(path);
    return true;
  } catch (e) {
    console.warn('Native remove failed:', e);
    return false;
  }
}

export async function takeStartupFilePath(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('take_startup_file');
  } catch {
    return null;
  }
}

export function onNativeOpenFilePath(handler: (path: string) => void): void {
  if (!isDesktop()) return;
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<string>('open-file-path', (event) => handler(event.payload));
  });
}

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
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch (e) {
    console.warn('Could not close window via Tauri window API:', e);
  }
}
