/**
 * Save / Save As service.
 * Save writes annotation changes back into the opened PDF (same document);
 * Save As prompts for a new file/location.
 */

import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { viewportManager } from '../core/viewport';
import { pdfExporter } from './export-pdf';
import type { PDFExportOptions } from './export-pdf';
import { saveDocumentSession } from './storage';
import { showToast } from '../ui/components/toast';
import { openSaveAsDialog, type SaveAsOptions } from '../ui/components/save-as-dialog';

const fileHandles = new Map<string, any>();

export function rememberFileHandle(docId: string, handle: any): void {
  if (handle) fileHandles.set(docId, handle);
}

export function forgetFileHandle(docId: string): void {
  fileHandles.delete(docId);
}

/** Dirty when edits happened after the last successful Save/load. */
export function isDocumentDirty(docId: string): boolean {
  const doc = store.openDocuments.get(docId) ?? (store.activeDocument?.id === docId ? store.activeDocument : null);
  if (!doc) return false;
  return (doc.lastModifiedAt ?? 0) > (doc.lastSavedAt ?? doc.createdAt ?? 0);
}

async function buildSavedBytes(opts?: Partial<PDFExportOptions>): Promise<Uint8Array> {
  const isDarkMode = store.appSettings.invertDocumentOled || document.body.classList.contains('invert-pdf-document');
  // Same high-fidelity path as Export so Save matches what users see.
  return pdfExporter.exportPDF({
    flatten: opts?.flatten ?? true,
    dpi: opts?.dpi ?? 150,
    applyRedactions: opts?.applyRedactions ?? true,
    pageRange: opts?.pageRange,
    darkMode: opts?.darkMode ?? isDarkMode
  });
}

function hasPendingRedactions(): boolean {
  const doc = store.activeDocument;
  if (!doc) return false;
  for (const key of Object.keys(doc.annotations)) {
    const anns = doc.annotations[Number(key)] || [];
    if (anns.some(a => a.type === 'redaction')) return true;
  }
  return false;
}

async function refreshEngineFromSavedBytes(docId: string, bytes: Uint8Array): Promise<void> {
  // Reload so cached proxies/bitmaps match the saved file (notebook pattern).
  pdfEngine.unloadDoc(docId);
  const meta = await pdfEngine.loadFromBytes(bytes.slice(0), docId);
  const doc = store.openDocuments.get(docId) ?? store.activeDocument;
  if (doc && doc.id === docId) {
    doc.pageCount = meta.pageCount;
    doc.pages = meta.pages;
    doc.bookmarks = meta.bookmarks;
  }
}

async function writeHandle(handle: any, bytes: Uint8Array): Promise<boolean> {
  try {
    const perm = await handle.queryPermission?.({ mode: 'readwrite' });
    if (perm === 'denied') return false;
    if (perm !== 'granted') {
      const req = await handle.requestPermission?.({ mode: 'readwrite' });
      if (req !== 'granted') return false;
    }
    const writable = await handle.createWritable();
    await writable.write(bytes as any);
    await writable.close();
    return true;
  } catch (e: any) {
    if (e?.name === 'AbortError') return false;
    console.warn('File handle write failed:', e);
    return false;
  }
}

/**
 * Save: writes writings directly into the same PDF that was opened.
 * Retains and writes through the disk file handle without creating copies.
 */
export async function saveActiveDocument(): Promise<boolean> {
  const doc = store.activeDocument;
  if (!doc?.fileData) {
    showToast('No PDF document loaded to save', 'error');
    return false;
  }
  if (hasPendingRedactions()) {
    const ok = window.confirm('This document contains redactions. Saving burns them in permanently. Continue?');
    if (!ok) return false;
  }
  showToast('Saving…', 'progress');
  try {
    const bytes = await buildSavedBytes();
    doc.fileData = bytes;
    doc.lastModifiedAt = Date.now();
    doc.lastSavedAt = Date.now();
    await saveDocumentSession(doc, { includeBytes: true });
    await refreshEngineFromSavedBytes(doc.id, bytes);

    let handle = fileHandles.get(doc.id);
    if (!handle && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      // First save without retained handle: link directly to original disk file
      try {
        const filename = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`;
        handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'PDF Document',
            accept: { 'application/pdf': ['.pdf'] }
          }]
        });
        if (handle) {
          rememberFileHandle(doc.id, handle);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          showToast('Save cancelled', 'info');
          return false;
        }
      }
    }

    if (handle) {
      const wrote = await writeHandle(handle, bytes);
      if (wrote) {
        showToast('Saved directly to original file', 'success');
      } else {
        showToast('Saved in session', 'success');
      }
    } else {
      await pdfExporter.saveToFile(bytes, doc.name);
      showToast('Saved', 'success');
    }
    store.notify();
    viewportManager.updateLayout(true);
    return true;
  } catch (e: any) {
    console.error('Save failed:', e);
    showToast(`Save failed: ${e.message}`, 'error');
    return false;
  }
}

/**
 * Save As: opens the options dialog (name, location hint, quality, pages),
 * then always prompts for file/location via the OS picker or download.
 * Cancelling anywhere touches nothing. The saved copy becomes active.
 */
export async function saveActiveDocumentAs(): Promise<boolean> {
  const doc = store.activeDocument;
  if (!doc?.fileData) {
    showToast('No PDF document loaded to save', 'error');
    return false;
  }
  const suggested = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`;
  const hasRed = hasPendingRedactions();
  const pageCount = doc.pageCount;
  const supportsPicker = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  return new Promise<boolean>((resolve) => {
    openSaveAsDialog({
      defaultFilename: suggested,
      pageCount,
      hasRedactions: hasRed,
      supportsPicker,
      onClose: () => resolve(false),
      onSubmit: async (opts: SaveAsOptions) => {
        try {
          showToast('Preparing Save As…', 'progress');
          const bytes = await buildSavedBytes({
            dpi: opts.dpi,
            flatten: opts.flatten,
            applyRedactions: opts.applyRedactions,
            pageRange: opts.pageRange
          });
          const { handle, cancelled } = await pdfExporter.saveToFileWithResult(bytes, opts.filename);
          if (cancelled) {
            resolve(false);
            return;
          }
          const chosenName: string = (handle as any)?.name || opts.filename;

          doc.fileData = bytes;
          doc.name = chosenName;
          doc.lastModifiedAt = Date.now();
          doc.lastSavedAt = Date.now();
          const tabs = (store as any)._documentTabs as Array<{ id: string; name: string }> | undefined;
          const tab = tabs?.find(t => t.id === doc.id);
          if (tab) tab.name = chosenName;
          if (handle) rememberFileHandle(doc.id, handle);
          await saveDocumentSession(doc, { includeBytes: true });
          await refreshEngineFromSavedBytes(doc.id, bytes);
          store.notify();
          viewportManager.updateLayout(true);
          showToast(`Saved as ${chosenName}`, 'success');
          resolve(true);
        } catch (e: any) {
          console.error('Save As failed:', e);
          showToast(`Save As failed: ${e.message}`, 'error');
          resolve(false);
        }
      }
    });
  });
}
