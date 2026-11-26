/**
 * Save / Save As service.
 * Save writes annotation changes back into the opened PDF (same document);
 * Save As prompts for a new file/location.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { viewportManager } from '../core/viewport';
import { pdfExporter } from './export-pdf';
import type { PDFExportOptions } from './export-pdf';
import { imageExporter } from './export-image';
import { dataExporter } from './export-data';
import { buildZipBlob } from './zip';
import { saveDocumentSession } from './storage';
import { showToast } from '../ui/components/toast';
import { openSaveAsDialog, type SaveAsOptions } from '../ui/components/save-as-dialog';
import { isDesktop } from '../core/platform';
import { isPdfDisplayedDark } from './save-policy';
import { nativeSaveAsDialog, nativeWriteFile } from './native-fs';
import { tr } from '../ui/i18n';

const fileHandles = new Map<string, any>();
let pendingSessionPersist: Promise<void> = Promise.resolve();

/**
 * Waits for any in-flight background IndexedDB session persistence to finish
 * (called before desktop app close so nothing is ever lost).
 */
export function flushPendingSessionSave(): Promise<void> {
  return pendingSessionPersist;
}

function persistSessionInBackground(doc: any): void {
  pendingSessionPersist = pendingSessionPersist
    .catch(() => {})
    .then(() => saveDocumentSession(doc, { includeBytes: true }))
    .catch((err) => {
      console.warn('Background session persist failed:', err);
    });
}

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

function hasUserPageRotations(): boolean {
  for (const rot of Object.values(store.pageRotations)) {
    if (((rot || 0) % 360 + 360) % 360 !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Fast metadata-only rotation pass on already-built PDF bytes so rotated saves
 * never pay for a second full annotation sync + image encode pass.
 */
async function bakeRotationsIntoBytes(baseBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(baseBytes, { ignoreEncryption: true, updateMetadata: false });
  const pdfPages = pdfDoc.getPages();
  let modified = false;
  for (let idx = 0; idx < pdfPages.length; idx++) {
    const userRot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
    if (userRot !== 0) {
      const nativeRot = ((pdfPages[idx].getRotation().angle % 360) + 360) % 360;
      pdfPages[idx].setRotation(degrees((nativeRot + userRot) % 360));
      modified = true;
    }
  }
  if (!modified) return baseBytes;
  return await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function buildSavedBytes(opts?: Partial<PDFExportOptions>): Promise<Uint8Array> {
  return pdfExporter.exportPDF({
    flatten: opts?.flatten ?? false,
    dpi: opts?.dpi ?? 150,
    pageRange: opts?.pageRange,
    pageIndices: opts?.pageIndices,
    darkMode: opts?.darkMode === true,
    embedCompositeAnnotations: opts?.embedCompositeAnnotations ?? true,
    bakePageRotations: opts?.bakePageRotations ?? true,
    password: opts?.password
  });
}

async function refreshEngineFromSavedBytes(docId: string, bytes: Uint8Array): Promise<void> {
  // Atomic hot-swap so cached proxies/bitmaps match the saved file without blanking the viewport.
  const meta = await pdfEngine.loadFromBytes(bytes.slice(0), docId, true);
  const doc = store.openDocuments.get(docId) ?? store.activeDocument;
  if (doc && doc.id === docId) {
    doc.pageCount = meta.pageCount;
    doc.pages = meta.pages;
    doc.bookmarks = meta.bookmarks;
  }
  // Ensure rendered page caches are invalidated so pages re-rasterize cleanly
  (window as any)?.app?.invalidateAfterEngineReload?.(docId, meta.pageCount);
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
    showToast(tr('No PDF document loaded to save', 'هیچ سند PDF برای ذخیره باز نیست'), 'error');
    return false;
  }

  try {
    // 1. Resolve target destination first so cancelling the dialog leaves state untouched
    let desktopPath = doc.nativeFilePath;
    let browserHandle = fileHandles.get(doc.id);

    if (isDesktop()) {
      if (!desktopPath) {
        const filename = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`;
        desktopPath = (await nativeSaveAsDialog(filename)) ?? undefined;
        if (!desktopPath) {
          showToast(tr('Save cancelled', 'ذخیره‌سازی لغو شد'), 'info');
          return false;
        }
      }
    } else if (!browserHandle && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        const filename = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`;
        browserHandle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'PDF Document',
            accept: { 'application/pdf': ['.pdf'] }
          }]
        });
        if (browserHandle) {
          rememberFileHandle(doc.id, browserHandle);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          showToast(tr('Save cancelled', 'ذخیره‌سازی لغو شد'), 'info');
          return false;
        }
      }
    }

    showToast(tr('Saving…', 'در حال ذخیره…'), 'progress');

    // Build session bytes ONCE (un-flattened, un-rotated); if pages are rotated,
    // apply /Rotate metadata in a fast ~5ms pass instead of rebuilding everything twice.
    const sessionBytes = await buildSavedBytes({
      flatten: false,
      embedCompositeAnnotations: true,
      bakePageRotations: false
    });
    const diskBytes = hasUserPageRotations()
      ? await bakeRotationsIntoBytes(sessionBytes)
      : sessionBytes;

    doc.fileData = sessionBytes;

    if (isDesktop() && desktopPath) {
      const wrote = await nativeWriteFile(desktopPath, diskBytes);
      if (wrote) {
        doc.nativeFilePath = desktopPath;
        doc.name = desktopPath.split(/[\\/]/).pop() || doc.name;
        const now = Date.now();
        doc.lastModifiedAt = now;
        doc.lastSavedAt = now;
        showToast(tr('Saved', 'ذخیره شد'), 'success');
        persistSessionInBackground(doc);
      } else {
        persistSessionInBackground(doc);
        showToast(
          tr('Could not write to the original file (saved in session only)', 'امکان نوشتن در فایل اصلی نبود (فقط در نشست برنامه ذخیره شد)'),
          'error'
        );
      }
      store.notify();
      return wrote;
    }

    if (browserHandle) {
      const wrote = await writeHandle(browserHandle, diskBytes);
      const now = Date.now();
      doc.lastModifiedAt = now;
      if (wrote) {
        doc.lastSavedAt = now;
        showToast(tr('Saved directly to original file', 'مستقیماً در فایل اصلی ذخیره شد'), 'success');
      } else {
        showToast(tr('Saved in session', 'در نشست برنامه ذخیره شد'), 'success');
      }
      persistSessionInBackground(doc);
    } else {
      await pdfExporter.saveToFile(diskBytes, doc.name);
      const now = Date.now();
      doc.lastModifiedAt = now;
      doc.lastSavedAt = now;
      showToast(tr('Saved', 'ذخیره شد'), 'success');
      persistSessionInBackground(doc);
    }
    store.notify();
    return true;
  } catch (e: any) {
    console.error('Save failed:', e);
    showToast(tr(`Save failed: ${e.message}`, `خطا در ذخیره‌سازی: ${e.message}`), 'error');
    return false;
  }
}

/** Writes exported bytes to disk, native path first, browser picker/download otherwise. */
async function writeExportedBytes(
  bytes: Uint8Array,
  suggestedFilename: string
): Promise<{ chosenName: string; nativeFilePath?: string; handle?: any; cancelled: boolean }> {
  if (isDesktop()) {
    const path = await nativeSaveAsDialog(suggestedFilename);
    if (!path) return { chosenName: suggestedFilename, cancelled: true };
    const wrote = await nativeWriteFile(path, bytes);
    if (!wrote) {
      showToast(tr('Could not write the file to disk', 'امکان نوشتن فایل روی دیسک نبود'), 'error');
      return { chosenName: suggestedFilename, cancelled: true };
    }
    return { chosenName: path.split(/[\\/]/).pop() || suggestedFilename, nativeFilePath: path, cancelled: false };
  }
  const { handle, cancelled } = await pdfExporter.saveToFileWithResult(bytes, suggestedFilename);
  if (cancelled) return { chosenName: suggestedFilename, cancelled: true };
  return { chosenName: (handle as any)?.name || suggestedFilename, handle, cancelled: false };
}

/**
 * Prompts the user to pick a `.json` annotation backup file and imports
 * annotations & layers into the currently active document.
 */
export function promptImportAnnotationsJson(): void {
  const doc = store.activeDocument;
  if (!doc) {
    showToast(tr('Open a PDF document before importing annotations', 'ابتدا یک سند PDF باز کنید'), 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const text = await file.text();
      const ok = dataExporter.importFromJSON(text);
      if (ok) {
        const now = Date.now();
        doc.lastModifiedAt = now;
        await saveDocumentSession(doc, { includeBytes: false });
        store.notify();
        (window as any).app?.repaintAllVisibleAnnotations?.();
        showToast(tr('Annotations imported successfully', 'حاشیه‌نویسی‌ها با موفقیت وارد شدند'), 'success');
      } else {
        showToast(tr('Invalid annotations JSON file', 'فایل JSON حاشیه‌نویسی نامعتبر است'), 'error');
      }
    } catch (err: any) {
      showToast(tr(`Import failed: ${err?.message || err}`, `خطا در وارد کردن: ${err?.message || err}`), 'error');
    }
  });

  input.click();
}

/**
 * Save As & Export: opens the unified options dialog (format, name, quality, pages),
 * then exports as PDF, PNG, JPEG, XFDF, or JSON.
 */
export async function saveActiveDocumentAs(): Promise<boolean> {
  const doc = store.activeDocument;
  if (!doc?.fileData) {
    showToast(tr('No PDF document loaded to save', 'هیچ سند PDF برای ذخیره باز نیست'), 'error');
    return false;
  }
  const suggested = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`;
  const pageCount = doc.pageCount;
  const supportsPicker = isDesktop() || (typeof window !== 'undefined' && 'showSaveFilePicker' in window);

  return new Promise<boolean>((resolve) => {
    openSaveAsDialog({
      defaultFilename: suggested,
      pageCount,
      activePageIndex: store.activePageIndex,
      selectedPageIndices: [...store.selectedPageIndices],
      supportsPicker,
      displayedDark: isPdfDisplayedDark(
        store.appSettings.invertDocumentOled,
        document.body.classList.contains('invert-pdf-document')
      ),
      onImportJson: () => promptImportAnnotationsJson(),
      onClose: () => resolve(false),
      onSubmit: async (opts: SaveAsOptions) => {
        try {
          if (opts.format === 'xfdf') {
            const xml = dataExporter.exportToXFDF();
            if (opts.password) {
              const xfdfBytes = new TextEncoder().encode(xml);
              const baseName = opts.filename.replace(/\.xfdf$/i, '') || 'annotations';
              const zipBlob = buildZipBlob([{ name: opts.filename, data: xfdfBytes }], opts.password);
              imageExporter.downloadImage(zipBlob, `${baseName}-xfdf.zip`);
              showToast(tr(`Exported password-protected XFDF ZIP`, `فایل XFDF رمزگذاری‌شده در ZIP ذخیره شد`), 'success');
            } else {
              dataExporter.downloadTextFile(xml, opts.filename, 'application/vnd.adobe.xfdf');
              showToast(tr(`Exported XFDF as ${opts.filename}`, `فایل XFDF با نام ${opts.filename} ذخیره شد`), 'success');
            }
            resolve(true);
            return;
          }

          if (opts.format === 'json') {
            const json = dataExporter.exportToJSON();
            dataExporter.downloadTextFile(json, opts.filename, 'application/json');
            showToast(tr(`Exported JSON backup as ${opts.filename}`, `فایل پشتیبان JSON با نام ${opts.filename} ذخیره شد`), 'success');
            resolve(true);
            return;
          }

          if (opts.format === 'png' || opts.format === 'jpeg') {
            showToast(tr('Rendering high-DPI image…', 'در حال رندر تصویر با کیفیت بالا…'), 'progress');
            let targetPages: number[] = [];
            if (opts.pageIndices && opts.pageIndices.length > 0) {
              targetPages = opts.pageIndices;
            } else if (opts.pageRange) {
              for (let p = opts.pageRange.start - 1; p <= opts.pageRange.end - 1; p++) {
                if (p >= 0 && p < doc.pageCount) targetPages.push(p);
              }
            } else {
              targetPages = Array.from({ length: doc.pageCount }, (_, i) => i);
            }
            if (targetPages.length === 0) targetPages = [store.activePageIndex];

            const baseName = opts.filename.replace(/\.(png|jpe?g|zip)$/i, '') || 'document';
            const ext = opts.format === 'png' ? 'png' : 'jpg';
            const darkMode = opts.darkMode === true;

            if (targetPages.length === 1 && !opts.password) {
              const blob = await imageExporter.exportPageToImage(targetPages[0], {
                format: opts.format,
                dpi: opts.dpi,
                quality: 0.92,
                includeAnnotations: true,
                darkMode
              });
              imageExporter.downloadImage(blob, `${baseName}.${ext}`);
            } else {
              const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
              const padDigits = String(doc.pageCount).length;
              for (const pageIdx of targetPages) {
                const blob = await imageExporter.exportPageToImage(pageIdx, {
                  format: opts.format,
                  dpi: opts.dpi,
                  quality: 0.92,
                  includeAnnotations: true,
                  darkMode
                });
                const buf = new Uint8Array(await blob.arrayBuffer());
                const pageLabel = String(pageIdx + 1).padStart(padDigits, '0');
                const entryName = targetPages.length === 1
                  ? `${baseName}.${ext}`
                  : `${baseName}-page-${pageLabel}.${ext}`;
                zipEntries.push({ name: entryName, data: buf });
              }
              const zipBlob = buildZipBlob(zipEntries, opts.password);
              const zipName = targetPages.length === 1
                ? `${baseName}-${ext}.zip`
                : `${baseName}-${ext}-pages.zip`;
              imageExporter.downloadImage(zipBlob, zipName);
            }

            showToast(
              opts.password
                ? tr(`Exported password-protected ZIP (${opts.format.toUpperCase()})`, `فایل ZIP رمزگذاری‌شده (${opts.format.toUpperCase()}) ذخیره شد`)
                : targetPages.length > 1
                  ? tr(`Bundled ${targetPages.length} pages into ZIP (${opts.format.toUpperCase()})`, `${targetPages.length} صفحه با فرمت ${opts.format.toUpperCase()} در یک فایل ZIP ذخیره شد`)
                  : tr(`Exported ${targetPages.length} page as ${opts.format.toUpperCase()}`, `${targetPages.length} صفحه با فرمت ${opts.format.toUpperCase()} ذخیره شد`),
              'success'
            );
            resolve(true);
            return;
          }

          showToast(tr('Preparing Save As…', 'در حال آماده‌سازی فایل…'), 'progress');
          const diskBytes = await buildSavedBytes({
            dpi: opts.dpi,
            flatten: opts.flatten,
            darkMode: opts.darkMode === true,
            pageRange: opts.pageRange,
            pageIndices: opts.pageIndices,
            embedCompositeAnnotations: true,
            bakePageRotations: true,
            password: opts.password
          });
          const result = await writeExportedBytes(diskBytes, opts.filename);
          if (result.cancelled) {
            resolve(false);
            return;
          }
          const chosenName = result.chosenName;
          const isPartialPageExport = Boolean(opts.pageRange || opts.pageIndices?.length);

          // Export-only variants (flattened, dark-mode baked, partial page subset,
          // or password-encrypted copies) write the new file to disk while keeping
          // the currently open editable document, pages, and annotations 100% intact!
          if (isPartialPageExport || opts.flatten || opts.darkMode || opts.password) {
            const label = isPartialPageExport
              ? tr(`Saved selected pages as ${chosenName}`, `صفحات انتخابی با نام ${chosenName} ذخیره شد`)
              : opts.flatten
                ? tr(`Saved flattened copy as ${chosenName}`, `نسخه Flatten شده با نام ${chosenName} ذخیره شد`)
                : tr(`Saved copy as ${chosenName}`, `نسخه جدید با نام ${chosenName} ذخیره شد`);
            showToast(label, 'success');
            resolve(true);
            return;
          }

          // Standard editable Save As: update active document reference without breaking the live engine
          const sessionBytes = hasUserPageRotations()
            ? await buildSavedBytes({
                dpi: opts.dpi,
                flatten: false,
                darkMode: false,
                embedCompositeAnnotations: true,
                bakePageRotations: false
              })
            : diskBytes;
          doc.fileData = sessionBytes;
          doc.name = chosenName;
          if (result.nativeFilePath) doc.nativeFilePath = result.nativeFilePath;
          const now = Date.now();
          doc.lastModifiedAt = now;
          doc.lastSavedAt = now;
          const tabs = (store as any)._documentTabs as Array<{ id: string; name: string }> | undefined;
          const tab = tabs?.find(t => t.id === doc.id);
          if (tab) tab.name = chosenName;
          if (result.handle) rememberFileHandle(doc.id, result.handle);
          persistSessionInBackground(doc);
          store.notify();
          showToast(tr(`Saved as ${chosenName}`, `با نام ${chosenName} ذخیره شد`), 'success');
          resolve(true);
        } catch (e: any) {
          console.error('Save As failed:', e);
          showToast(tr(`Save As failed: ${e.message}`, `خطا در ذخیره با نام جدید: ${e.message}`), 'error');
          resolve(false);
        }
      }
    });
  });
}

// Keep helper exported/available for any future full-document reload paths
export { refreshEngineFromSavedBytes, viewportManager };
