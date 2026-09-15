/**
 * Core PDF Engine powered by Mozilla PDF.js
 * High-performance, offline-first PDF rendering and parsing.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PageInfo, PDFBookmarkItem } from './types';
import { extensionApi } from '../utils/browser-compat';
import { store } from './store';
import { MAX_RENDER_DIMENSION, resolveRenderDpr } from '../utils/dpi';

/** Backing-store multiplier over CSS pixels for the current target DPI. */
function effectiveDpr(): number {
  try {
    return resolveRenderDpr(store.appSettings.targetDPI);
  } catch (_) {
    return resolveRenderDpr();
  }
}

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

interface CachedBitmap {
  pageIndex: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  canvas: HTMLCanvasElement;
}

interface CachedDocSession {
  doc: pdfjsLib.PDFDocumentProxy;
  pageCache: Map<number, pdfjsLib.PDFPageProxy>;
  /** Keyed by page+scale+rotation so zooming back hits cache instantly. */
  renderedBitmaps: Map<string, CachedBitmap>;
  meta: {
    pageCount: number;
    pages: PageInfo[];
    bookmarks: PDFBookmarkItem[];
  };
}

function bitmapKey(pageIndex: number, scale: number, rotation: number): string {
  return `${pageIndex}@${scale.toFixed(3)}:${Math.round(((rotation % 360) + 360) % 360)}`;
}

export class PDFEngine {
  private _pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  private _pageCache: Map<number, pdfjsLib.PDFPageProxy> = new Map();
  private _activeRenderTasks: Map<number, any> = new Map();
  private _renderedBitmaps = new Map<string, CachedBitmap>();
  private _docSessions: Map<string, CachedDocSession> = new Map();
  private _currentDocId: string | null = null;
  private _dimListeners: Set<(docId: string) => void> = new Set();

  /** Main subscribes so background dimension fills can re-lay-out without polling. */
  public onDimensionsUpdated(listener: (docId: string) => void): () => void {
    this._dimListeners.add(listener);
    return () => this._dimListeners.delete(listener);
  }

  private emitDimensionsUpdated(docId: string): void {
    for (const l of this._dimListeners) {
      try { l(docId); } catch (e) { console.warn('dimension listener failed', e); }
    }
  }

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

    const localBase = (() => {
      try { return extensionApi.runtime.getURL(''); } catch (_) { return './'; }
    })();
    const loadingTask = pdfjsLib.getDocument({
      data: dataCopy,
      // Bundled locally (vite copies cmaps/ + standard_fonts/) so offline
      // and extension CSP never hit the network on the critical path.
      cMapUrl: `${localBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${localBase}standard_fonts/`
    });

    this._pdfDoc = await loadingTask.promise;
    this._pageCache = new Map();
    this._renderedBitmaps = new Map();
    const pageCount = this._pdfDoc.numPages;
    const pages: PageInfo[] = [];

    // Extract first page dimensions for instant layout initialization (<50ms).
    // Remaining pages start as placeholders and heal in the background so
    // first paint never waits for 49 worker round-trips.
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

    const meta = { pageCount, pages, bookmarks: [] as PDFBookmarkItem[] };
    if (docId) {
      this._docSessions.set(docId, {
        doc: this._pdfDoc,
        pageCache: this._pageCache,
        renderedBitmaps: this._renderedBitmaps,
        meta
      });
      this._currentDocId = docId;
      // Fill true sizes + outline off the critical path; listeners re-layout.
      void this.fillMetadataBackground(docId);
    } else {
      void this.fillMetadataBackground(null, { doc: this._pdfDoc, meta } as any);
    }

    return meta;
  }

  /**
   * Background pass: true per-page sizes (prevents overlap of mixed-size docs)
   * + outline. Mutates the already-returned meta in place so callers that hold
   * the reference (store sessions) see corrections without re-parse.
   */
  private async fillMetadataBackground(docId: string | null, ephemeral?: { doc: pdfjsLib.PDFDocumentProxy; meta: { pageCount: number; pages: PageInfo[]; bookmarks: PDFBookmarkItem[] } }): Promise<void> {
    try {
      const session = docId ? this._docSessions.get(docId) : undefined;
      const doc = session?.doc ?? ephemeral?.doc ?? null;
      const meta = session?.meta ?? ephemeral?.meta ?? null;
      if (!doc || !meta) return;
      const pageCount = meta.pageCount;

      // Near pages first (visible viewport heals fastest), then the tail in
      // small batches with yields so scrolling stays at 60fps.
      const headLimit = Math.min(pageCount, 30);
      let dimsChanged = false;
      const fetchOne = async (pageNum: number): Promise<void> => {
        if (docId && !this._docSessions.has(docId)) return;
        try {
          const cached = session?.pageCache.get(pageNum - 1);
          const p = cached ?? await doc.getPage(pageNum);
          if (session && !session.pageCache.has(pageNum - 1)) {
            if (session.pageCache.size >= 60) {
              const oldest = session.pageCache.keys().next().value;
              if (oldest !== undefined && oldest !== pageNum - 1) session.pageCache.delete(oldest);
            }
            session.pageCache.set(pageNum - 1, p);
          }
          const vp = p.getViewport({ scale: 1.0 });
          const info = meta.pages[pageNum - 1];
          if (info && (Math.abs(info.originalWidth - vp.width) > 0.5 || Math.abs(info.originalHeight - vp.height) > 0.5 || info.rotation !== vp.rotation)) {
            info.width = vp.width;
            info.height = vp.height;
            info.originalWidth = vp.width;
            info.originalHeight = vp.height;
            info.rotation = vp.rotation;
            dimsChanged = true;
          }
        } catch (_) {}
      };

      const batch = async (from: number, to: number) => {
        const jobs: Promise<void>[] = [];
        for (let n = from; n <= to; n++) jobs.push(fetchOne(n));
        await Promise.all(jobs);
      };

      if (pageCount >= 2) {
        await batch(2, headLimit);
        if (dimsChanged && docId) this.emitDimensionsUpdated(docId);
      }
      // Tail in chunks of 20 with a macrotask yield between chunks.
      for (let start = headLimit + 1; start <= pageCount; start += 20) {
        if (docId && !this._docSessions.has(docId)) return;
        const end = Math.min(pageCount, start + 19);
        await batch(start, end);
        await new Promise(r => setTimeout(r, 0));
        if (dimsChanged && docId) {
          this.emitDimensionsUpdated(docId);
          dimsChanged = false;
        }
      }
      if (dimsChanged && docId) this.emitDimensionsUpdated(docId);

      // Outline last: never blocks paint.
      try {
        const outline = await doc.getOutline();
        if (outline && Array.isArray(outline)) {
          meta.bookmarks = this.formatOutline(outline);
          if (docId) this.emitDimensionsUpdated(docId);
        }
      } catch (err) {
        console.warn('Could not extract outline:', err);
      }
    } catch (e) {
      console.warn('Background metadata fill failed:', e);
    }
  }

  private formatOutline(items: any[]): PDFBookmarkItem[] {
    if (!items || !Array.isArray(items)) return [];
    return items.map(item => ({
      title: typeof item.title === 'string' ? item.title : String(item.title || ''),
      pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : undefined,
      items: item.items && Array.isArray(item.items) ? this.formatOutline(item.items) : undefined
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

  /** Any cached scale of a page, for instant stale upscale while re-rendering. */
  private findAnyBitmap(pageIndex: number): CachedBitmap | undefined {
    const prefix = `${pageIndex}@`;
    for (const [key, entry] of this._renderedBitmaps) {
      if (key.startsWith(prefix)) return entry;
    }
    return undefined;
  }

  public async renderPageToCanvas(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number = 1.0,
    rotation: number = 0
  ): Promise<void> {
    if (!this._pdfDoc) return;
    const renderDocId = this._currentDocId;

    const dpr = effectiveDpr();

    let page = this._pageCache.get(pageIndex);
    if (!page) {
      try {
        page = await this._pdfDoc.getPage(pageIndex + 1);
      } catch (e) {
        return;
      }
      // Stale fetch after a tab switch must not pollute the new doc's cache.
      if (renderDocId !== this._currentDocId) return;
      if (!canvas.isConnected) return;
      // Evict oldest page when cache gets large without killing active document
      if (this._pageCache.size >= 60) {
        for (const k of this._pageCache.keys()) {
          if (k !== pageIndex) {
            this._pageCache.delete(k);
            break;
          }
        }
      }
      this._pageCache.set(pageIndex, page);
      // Heal placeholder geometry: a lazy fetch is proof the layout used a
      // wrong size (pages beyond the background head). Correct the session
      // meta so tops below stop overlapping.
      try {
        const session = renderDocId ? this._docSessions.get(renderDocId) : undefined;
        const info = session?.meta.pages[pageIndex];
        if (info) {
          const vp1 = page.getViewport({ scale: 1.0 });
          if (Math.abs(info.originalWidth - vp1.width) > 0.5 || Math.abs(info.originalHeight - vp1.height) > 0.5) {
            info.width = vp1.width;
            info.height = vp1.height;
            info.originalWidth = vp1.width;
            info.originalHeight = vp1.height;
            info.rotation = vp1.rotation;
            if (renderDocId) this.emitDimensionsUpdated(renderDocId);
          }
        }
      } catch (_) {}
    }

    // NOTE: getViewport's `rotation` already defaults to the PDF's native
    // page rotation, so only the USER rotation is passed here. Adding
    // page.rotate again double-rotated content out of its layout box and into
    // neighbouring pages on rotated documents.
    const totalRotation = ((rotation || 0) % 360 + 360) % 360;
    const rawViewport = page.getViewport({ scale: scale * dpr, rotation: totalRotation });

    // Cap backing-store size at extreme zoom/dpr to avoid multi-hundred-MB
    // canvases; CSS style stays at layout size so output upscales cleanly.
    let renderScale = scale * dpr;
    const rawW = Math.floor(rawViewport.width);
    const rawH = Math.floor(rawViewport.height);
    const largest = Math.max(rawW, rawH);
    if (largest > MAX_RENDER_DIMENSION && largest > 0) {
      renderScale *= MAX_RENDER_DIMENSION / largest;
    }
    const viewport = largest > MAX_RENDER_DIMENSION
      ? page.getViewport({ scale: renderScale, rotation: totalRotation })
      : rawViewport;

    const targetWidth = Math.max(1, Math.floor(viewport.width));
    const targetHeight = Math.max(1, Math.floor(viewport.height));

    // Zero-blank frame double buffering: paint any cached bitmap for this page
    // immediately (even at a different zoom) so the user never sees white
    // canvas space while re-rendering. CSS size is owned by main.ts layout —
    // only the backing store is touched here to avoid ±1px seam drift.
    const exactKey = bitmapKey(pageIndex, scale, totalRotation);
    const cached = this._renderedBitmaps.get(exactKey) ?? this.findAnyBitmap(pageIndex);
    if (cached) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (ctx) {
        // Scaled placeholder blit: bicubic-quality resampling minimizes both
        // shimmer when upscaling and moiré when downscaling a cached frame.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(cached.canvas, 0, 0, targetWidth, targetHeight);
      }

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
      // pdf.js v6 accepts either `canvas` or a raw 2d context; the offscreen
      // element is passed explicitly to satisfy the stricter typings.
      canvas: offscreen,
      canvasContext: offCtx,
      viewport: viewport,
      intent: 'display'
    };

    const task = page.render(renderContext);
    this._activeRenderTasks.set(pageIndex, task);

    try {
      await task.promise;

      // Verify canvas is still mounted and bound to this page/doc before blit.
      // Same pageIndex is reused across docs/zooms, so doc + connection checks
      // stop a stale render from painting into a recycled canvas (ghost pages).
      if (!canvas.isConnected) return;
      if (renderDocId !== this._currentDocId) return;
      if (canvas.dataset.pageIndex && canvas.dataset.pageIndex !== String(pageIndex)) {
        return;
      }
      if (canvas.dataset.docId && renderDocId && canvas.dataset.docId !== renderDocId) {
        return;
      }

      // Keep recent bitmaps (across a few zoom levels) for instant navigation.
      if (this._renderedBitmaps.size >= 25) {
        const oldestKey = this._renderedBitmaps.keys().next().value;
        if (oldestKey !== undefined) this._renderedBitmaps.delete(oldestKey);
      }
      this._renderedBitmaps.set(exactKey, {
        pageIndex,
        width: targetWidth,
        height: targetHeight,
        scale,
        rotation: totalRotation,
        canvas: offscreen
      });

      // Atomic blit to visible canvas with zero flicker and zero blank frame.
      // Backing store only — CSS size stays owned by the viewport layout.
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
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
   * Renders a small preview of a page for the sidebar thumbnail list.
   *
   * Deliberately independent of `renderPageToCanvas`: that method owns the
   * shared page-render task map and the full-resolution bitmap cache, so
   * reusing it here would let a thumbnail cancel a visible page's render and
   * would evict high-resolution bitmaps in favour of tiny ones.
   */
  /**
   * Instant thumbnail from an already-rendered main-view bitmap: one
   * synchronous downscale blit, no pdf.js render pass at all. Returns null
   * when the page has never been rasterised (caller falls back to
   * `renderThumbnail`). Quality matches or beats a direct thumbnail render
   * because the source is a full-resolution page bitmap.
   */
  public thumbnailFromCache(pageIndex: number, maxWidth = 120, maxHeight = 156): HTMLCanvasElement | null {
    const cached = this.findAnyBitmap(pageIndex);
    if (!cached || cached.width <= 0 || cached.height <= 0) return null;
    const scale = Math.min(maxWidth / cached.width, maxHeight / cached.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cached.width * scale));
    canvas.height = Math.max(1, Math.round(cached.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cached.canvas, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  public async renderThumbnail(pageIndex: number, maxWidth = 120, maxHeight = 156): Promise<HTMLCanvasElement | null> {
    if (!this._pdfDoc) return null;

    const page = this._pageCache.get(pageIndex) || await this._pdfDoc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
    const scale = Math.min(maxWidth / base.width, maxHeight / base.height);
    const viewport = page.getViewport({ scale, rotation: page.rotate || 0 });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    try {
      await page.render({ canvas, canvasContext: ctx, viewport, intent: 'display' }).promise;
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Error rendering thumbnail ${pageIndex}:`, err);
      }
      return null;
    }

    return canvas;
  }

  /**
   * Renders a page directly to an offscreen canvas at a specified scale and rotation.
   * Independent of viewport cache to prevent evictions.
   */
  public async renderPageAtScale(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number,
    rotation: number = 0
  ): Promise<boolean> {
    if (!this._pdfDoc) return false;

    try {
      const page = this._pageCache.get(pageIndex) || await this._pdfDoc.getPage(pageIndex + 1);
      const totalRotation = ((rotation || 0) % 360 + 360) % 360;
      const viewport = page.getViewport({ scale, rotation: totalRotation });

      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return false;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        intent: 'display'
      }).promise;
      return true;
    } catch (err: any) {
      console.error(`Error rendering page ${pageIndex} to canvas:`, err);
      return false;
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
