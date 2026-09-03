/**
 * IndexedDB & Local Storage Manager
 * Persistent auto-save, recent files list, and version history.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { DocumentSession } from '../core/types';
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

export async function openDocumentSession(name: string, fileData: Uint8Array): Promise<string> {
  const id = `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  try {
    const db = await getDB();
    const session: DocumentSession = {
      id,
      name,
      fileData: fileData ? new Uint8Array(fileData) : undefined,
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
      lastOpenedAt: Date.now()
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

export async function saveDocumentSession(session: DocumentSession): Promise<void> {
  try {
    const db = await getDB();
    const cleanSession: DocumentSession = {
      ...session,
      fileData: session.fileData ? new Uint8Array(session.fileData) : undefined
    };
    await db.put('documents', cleanSession);
    await db.put('recent', {
      id: session.id,
      name: session.name,
      pageCount: session.pageCount,
      lastOpenedAt: Date.now()
    });
  } catch (err) {
    console.warn('Could not auto-save document to IndexedDB:', err);
  }
}

export async function getRecentDocuments(): Promise<Array<{ id: string; name: string; pageCount: number; lastOpenedAt: number }>> {
  try {
    const db = await getDB();
    const all = await db.getAll('recent');
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } catch (err) {
    return [];
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
