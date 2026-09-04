/**
 * Core PDF Engine powered by Mozilla PDF.js
 * High-performance, offline-first PDF rendering and parsing.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PageInfo, PDFBookmarkItem } from './types';
import { extensionApi } from '../utils/browser-compat';

// Configure offline worker
try {
  const workerUrl = extensionApi.runtime.getURL('pdf.worker.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
} catch (e) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';
}

export interface RenderTaskToken {
  cancel(): void;
}

interface CachedDocSession {
  doc: pdfjsLib.PDFDocumentProxy;
  pageCache: Map<number, pdfjsLib.PDFPageProxy>;
  renderedBitmaps: Map<number, { width: number; height: number; scale: number; rotation: number; canvas: HTMLCanvasElement }>;
  meta: {
    pageCount: number;
    pages: PageInfo[];
    bookmarks: PDFBookmarkItem[];
  };
}

export class PDFEngine {
  private _pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  private _pageCache: Map<number, pdfjsLib.PDFPageProxy> = new Map();
  private _activeRenderTasks: Map<number, any> = new Map();
  private _renderedBitmaps = new Map<number, { width: number; height: number; scale: number; rotation: number; canvas: HTMLCanvasElement }>();
  private _docSessions: Map<string, CachedDocSession> = new Map();
  private _currentDocId: string | null = null;

  /**
   * Loads a PDF document from raw binary bytes, with multi-document tab caching.
   */
  public async loadFromBytes(data: Uint8Array, docId?: string): Promise<{
    pageCount: number;
    pages: PageInfo[];
    bookmarks: PDFBookmarkItem[];
  }> {
    // If this document is already cached in memory, switch to it instantly (<1ms)
    if (docId && this._docSessions.has(docId)) {
      if (this._currentDocId === docId) {
        return this._docSessions.get(docId)!.meta;
      }

      // Save previous active session state
      if (this._currentDocId && this._docSessions.has(this._currentDocId)) {
        const prev = this._docSessions.get(this._currentDocId)!;
        prev.pageCache = this._pageCache;
        prev.renderedBitmaps = this._renderedBitmaps;
      }

      // Cancel any ongoing rendering tasks from previous document
      for (const [, task] of this._activeRenderTasks) {
        try { task.cancel(); } catch (e) {}
      }
      this._activeRenderTasks.clear();

      // Switch active references
      const cached = this._docSessions.get(docId)!;
      this._pdfDoc = cached.doc;
      this._pageCache = cached.pageCache;
      this._renderedBitmaps = cached.renderedBitmaps;
      this._currentDocId = docId;

      return cached.meta;
    }

    // Cancel ongoing render tasks
    for (const [, task] of this._activeRenderTasks) {
      try { task.cancel(); } catch (e) {}
    }
    this._activeRenderTasks.clear();

    // Save previous active session before replacing
    if (this._currentDocId && this._docSessions.has(this._currentDocId)) {
      const prev = this._docSessions.get(this._currentDocId)!;
      prev.pageCache = this._pageCache;
      prev.renderedBitmaps = this._renderedBitmaps;
    }

    // Pass a fresh slice so PDF.js worker transfer never detaches the original buffer!
    const dataCopy = data.slice(0);

    const loadingTask = pdfjsLib.getDocument({
      data: dataCopy,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/standard_fonts/'
    });

    this._pdfDoc = await loadingTask.promise;
    this._pageCache = new Map();
    this._renderedBitmaps = new Map();
    const pageCount = this._pdfDoc.numPages;
    const pages: PageInfo[] = [];

    // Extract first page dimensions for instant layout initialization (<50ms)
    let defaultWidth = 612;
    let defaultHeight = 792;
    let defaultRotation = 0;

    try {
      const firstPage = await this._pdfDoc.getPage(1);
      this._pageCache.set(0, firstPage);
      const vp = firstPage.getViewport({ scale: 1.0 });
      defaultWidth = vp.width;
      defaultHeight = vp.height;
      defaultRotation = vp.rotation;
    } catch (e) {
      console.warn('Error loading first page dimensions:', e);
    }

    for (let i = 1; i <= pageCount; i++) {
      pages.push({
        pageIndex: i - 1,
        pageNumber: i,
        width: defaultWidth,
        height: defaultHeight,
        originalWidth: defaultWidth,
        originalHeight: defaultHeight,
        rotation: defaultRotation
      });
    }

    // Pre-extract individual page dimensions for pages up to 50 pages so mixed-orientation/size PDFs never scramble
    const fetchLimit = Math.min(pageCount, 50);
    const pagePromises: Promise<any>[] = [];
    for (let i = 2; i <= fetchLimit; i++) {
      pagePromises.push(this._pdfDoc.getPage(i).catch(() => null));
    }
    const fetchedPages = await Promise.all(pagePromises);
    for (let idx = 0; idx < fetchedPages.length; idx++) {
      const p = fetchedPages[idx];
      if (p) {
        const pageIdx = idx + 1;
        this._pageCache.set(pageIdx, p);
        const vp = p.getViewport({ scale: 1.0 });
        if (pages[pageIdx]) {
          pages[pageIdx].width = vp.width;
          pages[pageIdx].height = vp.height;
          pages[pageIdx].originalWidth = vp.width;
          pages[pageIdx].originalHeight = vp.height;
          pages[pageIdx].rotation = vp.rotation;
        }
      }
    }

    // Extract bookmarks / outline cleanly
    let bookmarks: PDFBookmarkItem[] = [];
    try {
      const outline = await this._pdfDoc.getOutline();
      if (outline && Array.isArray(outline)) {
        bookmarks = this.formatOutline(outline);
      }
    } catch (err) {
      console.warn('Could not extract outline:', err);
    }

    const meta = { pageCount, pages, bookmarks };
    if (docId) {
      this._docSessions.set(docId, {
        doc: this._pdfDoc,
        pageCache: this._pageCache,
        renderedBitmaps: this._renderedBitmaps,
        meta
      });
      this._currentDocId = docId;
    }

    return meta;
  }

  private formatOutline(items: any[]): PDFBookmarkItem[] {
    if (!items || !Array.isArray(items)) return [];
    return items.map(item => ({
      title: typeof item.title === 'string' ? item.title : String(item.title || ''),
      pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : undefined,
      items: item.items && Array.isArray(items.items) ? this.formatOutline(item.items) : undefined
    }));
  }

  /**
   * Renders a specific page onto an HTML5 Canvas with high-DPI scaling.
   */
  public cancelPageRender(pageIndex: number): void {
    if (this._activeRenderTasks.has(pageIndex)) {
      try {
        this._activeRenderTasks.get(pageIndex).cancel();
      } catch (e) {
        // ignored
      }
      this._activeRenderTasks.delete(pageIndex);
    }
  }

  public clearBitmapCache(): void {
    this._renderedBitmaps.clear();
  }

  public async renderPageToCanvas(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number = 1.0,
    rotation: number = 0
  ): Promise<void> {
    if (!this._pdfDoc) return;

    const dpr = window.devicePixelRatio || 1;

    let page = this._pageCache.get(pageIndex);
    if (!page) {
      page = await this._pdfDoc.getPage(pageIndex + 1);
      // Evict oldest page when cache gets large without killing active document
      if (this._pageCache.size >= 50) {
        for (const k of this._pageCache.keys()) {
          if (k !== pageIndex) {
            this._pageCache.delete(k);
            break;
          }
        }
      }
      this._pageCache.set(pageIndex, page);
    }

    const totalRotation = ((page.rotate || 0) + (rotation || 0) + 3600) % 360;
    const viewport = page.getViewport({ scale: scale * dpr, rotation: totalRotation });

    const targetWidth = Math.floor(viewport.width);
    const targetHeight = Math.floor(viewport.height);

    // Zero-blank frame double buffering: If a cached bitmap exists (even at a different zoom),
    // display it immediately scaled to fit so the user never sees white canvas space while re-rendering
    const cached = this._renderedBitmaps.get(pageIndex);
    if (cached) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        canvas.style.width = `${Math.floor(targetWidth / dpr)}px`;
        canvas.style.height = `${Math.floor(targetHeight / dpr)}px`;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx?.drawImage(cached.canvas, 0, 0, targetWidth, targetHeight);

      if (cached.scale === scale && cached.rotation === totalRotation && cached.width === targetWidth && cached.height === targetHeight) {
        return;
      }
    }

    // Cancel existing render on this page if running
    this.cancelPageRender(pageIndex);

    // Double-buffered rendering: render completely to isolated offscreen canvas first
    const offscreen = document.createElement('canvas');
    offscreen.width = targetWidth;
    offscreen.height = targetHeight;
    const offCtx = offscreen.getContext('2d', { alpha: false });
    if (!offCtx) return;

    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, targetWidth, targetHeight);

    const renderContext = {
      canvasContext: offCtx,
      viewport: viewport,
      intent: 'display'
    };

    const task = page.render(renderContext);
    this._activeRenderTasks.set(pageIndex, task);

    try {
      await task.promise;

      // Verify canvas is still mounted and bound to this pageIndex before committing blit
      if (canvas.dataset.pageIndex && canvas.dataset.pageIndex !== String(pageIndex)) {
        return;
      }

      // Keep recent bitmaps in memory for instant scroll navigation
      if (this._renderedBitmaps.size >= 25) {
        const oldestKey = this._renderedBitmaps.keys().next().value;
        if (oldestKey !== undefined) this._renderedBitmaps.delete(oldestKey);
      }
      this._renderedBitmaps.set(pageIndex, {
        width: targetWidth,
        height: targetHeight,
        scale,
        rotation: totalRotation,
        canvas: offscreen
      });

      // Atomic blit to visible canvas with zero flicker and zero blank frame
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        canvas.style.width = `${Math.floor(targetWidth / dpr)}px`;
        canvas.style.height = `${Math.floor(targetHeight / dpr)}px`;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx?.drawImage(offscreen, 0, 0);
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Error rendering page ${pageIndex}:`, err);
      }
    } finally {
      if (this._activeRenderTasks.get(pageIndex) === task) {
        this._activeRenderTasks.delete(pageIndex);
      }
    }
  }

  /**
   * Extracts text items for search and selection.
   */
  public async getPageText(pageIndex: number): Promise<{ text: string; items: any[] }> {
    if (!this._pdfDoc) return { text: '', items: [] };

    let page = this._pageCache.get(pageIndex);
    if (!page) {
      page = await this._pdfDoc.getPage(pageIndex + 1);
      this._pageCache.set(pageIndex, page);
    }

    const textContent = await page.getTextContent();
    const fullText = textContent.items.map((item: any) => item.str).join(' ');
    return { text: fullText, items: textContent.items };
  }

  /**
   * Releases and cleans up a specific cached document session (when a tab is closed).
   */
  public unloadDoc(docId: string): void {
    if (this._docSessions.has(docId)) {
      const session = this._docSessions.get(docId)!;
      try {
        session.pageCache.clear();
        session.renderedBitmaps.clear();
        if (typeof (session.doc as any).cleanup === 'function') {
          (session.doc as any).cleanup();
        }
        if (session.doc.loadingTask && typeof (session.doc.loadingTask as any).destroy === 'function') {
          (session.doc.loadingTask as any).destroy();
        }
      } catch (e) {
        // ignored
      }
      this._docSessions.delete(docId);
    }

    if (this._currentDocId === docId) {
      this._pdfDoc = null;
      this._pageCache.clear();
      this._renderedBitmaps.clear();
      this._currentDocId = null;
    }
  }

  /**
   * Cleans up all document instances and caches.
   */
  public destroy() {
    for (const [id] of this._docSessions) {
      this.unloadDoc(id);
    }
    this._docSessions.clear();

    for (const [, task] of this._activeRenderTasks) {
      try {
        task.cancel();
      } catch (e) {
        // ignored
      }
    }
    this._activeRenderTasks.clear();
    this._pageCache.clear();
    this._renderedBitmaps.clear();
    if (this._pdfDoc) {
      try {
        if (typeof (this._pdfDoc as any).cleanup === 'function') {
          (this._pdfDoc as any).cleanup();
        }
        if (this._pdfDoc.loadingTask && typeof (this._pdfDoc.loadingTask as any).destroy === 'function') {
          (this._pdfDoc.loadingTask as any).destroy();
        }
      } catch (e) {
        // ignored
      }
      this._pdfDoc = null;
    }
    this._currentDocId = null;
  }
}

export const pdfEngine = new PDFEngine();
