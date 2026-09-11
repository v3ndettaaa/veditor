/**
 * IndexedDB & Local Storage Manager
 * Persistent auto-save, recent files list, and version history.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { DocumentSession, PDFFolder, RecentDocItem } from '../core/types';
import { store } from '../core/store';

interface VeditorDB extends DBSchema {
  documents: {
    key: string;
    value: DocumentSession;
  };
  recent: {
    key: string;
    value: {
      id: string;
      name: string;
      pageCount: number;
      lastOpenedAt: number;
      folderId?: string | null;
      thumbnailDataUrl?: string;
    };
  };
  signatures: {
    key: string;
    value: {
      id: string;
      name: string;
      dataUrl: string;
      createdAt: number;
    };
  };
  versions: {
    key: string;
    value: {
      id: string;
      docId: string;
      timestamp: number;
      description: string;
      annotations: any;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<VeditorDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<VeditorDB>('veditor-db', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('recent')) {
          db.createObjectStore('recent', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('signatures')) {
          db.createObjectStore('signatures', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('versions')) {
          db.createObjectStore('versions', { keyPath: 'id' });
        }
      }
    });
  }
  return dbPromise;
}

export function createDocumentId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

export async function openDocumentSession(name: string, fileData: Uint8Array, folderId?: string | null, existingId?: string): Promise<string> {
  const id = existingId || createDocumentId();

  try {
    const db = await getDB();
    const session: DocumentSession = {
      id,
      name,
      // Note: idb structured-clones on put; no extra JS copy needed here.
      fileData,
      pageCount: 0,
      pages: [],
      bookmarks: [],
      annotations: {},
      layers: {},
      activePageIndex: 0,
      createdAt: Date.now(),
      lastModifiedAt: Date.now()
    };

    await db.put('documents', session);
    await db.put('recent', {
      id,
      name,
      pageCount: 0,
      lastOpenedAt: Date.now(),
      folderId: folderId || null
    });
  } catch (err) {
    console.warn('Could not persist document to IndexedDB (continuing in-memory):', err);
  }

  return id;
}

export async function getDocumentSession(id: string): Promise<DocumentSession | undefined> {
  try {
    const db = await getDB();
    return await db.get('documents', id);
  } catch (err) {
    console.warn('Could not get document from IndexedDB:', err);
    return undefined;
  }
}

export async function saveDocumentSession(session: DocumentSession, opts?: { includeBytes?: boolean }): Promise<void> {
  try {
    const db = await getDB();
    let fileData = session.fileData;
    if (!opts?.includeBytes) {
      // Autosave / metadata path: never rewrite large PDF bytes. Preserve
      // whatever is already stored so annotation saves stay cheap.
      try {
        const existing = await db.get('documents', session.id);
        if (existing?.fileData) fileData = existing.fileData;
        else if (fileData && existing && !('fileData' in existing)) fileData = fileData;
        // If no existing bytes and caller omitted them, keep current (may be undefined).
      } catch (_) {}
    }
    const cleanSession: DocumentSession = {
      ...session,
      fileData
    };
    await db.put('documents', cleanSession);

    const existingRecent = await db.get('recent', session.id);
    await db.put('recent', {
      id: session.id,
      name: session.name,
      pageCount: session.pageCount,
      lastOpenedAt: Date.now(),
      folderId: existingRecent?.folderId || null
    });
  } catch (err) {
    console.warn('Could not auto-save document to IndexedDB:', err);
  }
}

export async function getRecentDocuments(): Promise<RecentDocItem[]> {
  try {
    const db = await getDB();
    const all = await db.getAll('recent');
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } catch (err) {
    return [];
  }
}

export async function deleteRecentDocument(docId: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('recent', docId);
    await db.delete('documents', docId);
  } catch (err) {
    console.warn('Could not delete recent document:', err);
  }
}

const FOLDERS_STORAGE_KEY = 'veditor_pdf_folders';

export const DEFAULT_FOLDERS: PDFFolder[] = [
  { id: 'folder-work', name: 'Work & Projects', color: '#3b82f6', icon: 'briefcase', createdAt: 1 },
  { id: 'folder-study', name: 'Study & Notes', color: '#10b981', icon: 'book', createdAt: 2 },
  { id: 'folder-starred', name: 'Important & Starred', color: '#f59e0b', icon: 'star', createdAt: 3 }
];

let _memoryFolders: PDFFolder[] | null = null;

function getStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
      // Test read/write to ensure it does not throw
      const testKey = '__veditor_test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return localStorage;
    }
  } catch (_) {}
  return null;
}

export function resetFoldersCache(folders?: PDFFolder[]) {
  _memoryFolders = folders ? [...folders] : null;
  const storage = getStorageSafe();
  if (storage) {
    try {
      storage.removeItem(FOLDERS_STORAGE_KEY);
    } catch (_) {}
  }
}

export async function getFolders(): Promise<PDFFolder[]> {
  try {
    const storage = getStorageSafe();
    if (storage) {
      const raw = storage.getItem(FOLDERS_STORAGE_KEY);
      if (!raw) {
        storage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(DEFAULT_FOLDERS));
        return [...DEFAULT_FOLDERS];
      }
      return JSON.parse(raw);
    }
  } catch (e) {}

  if (!_memoryFolders) {
    _memoryFolders = [...DEFAULT_FOLDERS];
  }
  return [..._memoryFolders];
}

export async function saveFolder(folder: PDFFolder): Promise<void> {
  try {
    const folders = await getFolders();
    const existingIdx = folders.findIndex(f => f.id === folder.id);
    if (existingIdx >= 0) {
      folders[existingIdx] = folder;
    } else {
      folders.push(folder);
    }
    _memoryFolders = [...folders];
    const storage = getStorageSafe();
    if (storage) {
      storage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    }
  } catch (e) {
    console.warn('Could not save folder:', e);
  }
}

export async function deleteFolder(folderId: string): Promise<void> {
  try {
    let folders = await getFolders();
    folders = folders.filter(f => f.id !== folderId);
    _memoryFolders = [...folders];
    const storage = getStorageSafe();
    if (storage) {
      storage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    }

    // Unassign documents that were in this folder
    const db = await getDB();
    const recent = await db.getAll('recent');
    for (const doc of recent) {
      if (doc.folderId === folderId) {
        doc.folderId = null;
        await db.put('recent', doc);
      }
    }
  } catch (e) {
    console.warn('Could not delete folder:', e);
  }
}

export async function assignDocToFolder(docId: string, folderId: string | null): Promise<void> {
  try {
    const db = await getDB();
    const doc = await db.get('recent', docId);
    if (doc) {
      doc.folderId = folderId;
      await db.put('recent', doc);
    }
  } catch (e) {
    console.warn('Could not assign document to folder:', e);
  }
}

// Auto-save debouncer
let autoSaveTimer: any = null;

export function triggerAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    const doc = store.activeDocument;
    if (doc) {
      doc.lastModifiedAt = Date.now();
      await saveDocumentSession(doc);
    }
  }, 1500);
}

export async function clearAllStorage(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear('documents');
    await db.clear('recent');
    await db.clear('signatures');
    await db.clear('versions');
    const storage = getStorageSafe();
    if (storage) {
      storage.removeItem(FOLDERS_STORAGE_KEY);
      storage.removeItem('veditor_tool_settings');
      storage.removeItem('veditor_app_settings');
    }
    _memoryFolders = null;
  } catch (e) {
    console.warn('Could not clear storage:', e);
  }
}
