/**
 * Core PDF Engine powered by Mozilla PDF.js
 * High-performance, offline-first PDF rendering and parsing.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { importNativeAnnotations, stripImportedNativeAnnotations } from './native-annotations';
import { Annotation, PageInfo, PDFBookmarkItem, PDFLinkItem, PenAnnotation, HighlighterAnnotation, StrokePoint, UserBookmarkItem } from './types';
import { extensionApi } from '../utils/browser-compat';
import { store } from './store';
import {
  ADAPTIVE_CANVAS_MAX_DIMENSION,
  ADAPTIVE_CANVAS_MAX_PIXELS,
  resolveAdaptiveCanvasDpr,
  resolveRenderDpr
} from '../utils/dpi';
import {
  stripNativeInkAnnotations,
  extractNativeInkToolMap,
  extractNativeInkMetaMap,
  bytesMayContainInkAnnotations
} from './native-ink';
import { extractPageTextLayout, getTextRangeRects, PageTextLayout } from './pdf-text-layout';
import pdfWorkerAssetUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Backing-store multiplier over CSS pixels for the current target DPI. */
function effectiveDpr(): number {
  try {
    return resolveRenderDpr(store.appSettings.targetDPI);
  } catch (_) {
    return resolveRenderDpr();
  }
}

function resolveAssetUrl(path: string): string {
  try {
    const extUrl = extensionApi.runtime.getURL(path);
    if (extUrl && extUrl !== path) {
      return extUrl;
    }
  } catch (_) {
    // ignore
  }
  if (typeof window !== 'undefined' && window.location?.href) {
    try {
      return new URL(path || './', window.location.href).href;
    } catch (_) {
      // ignore
    }
  }
  return path ? `./${path.replace(/^\.?\//, '')}` : './';
}

function resolveWorkerSrc(): string {
  try {
    const extUrl = extensionApi.runtime.getURL('pdf.worker.min.mjs');
    if (extUrl && /^(chrome-extension|moz-extension|safari-web-extension):/i.test(extUrl)) {
      return extUrl;
    }
  } catch (_) {
    // ignore
  }
  if (pdfWorkerAssetUrl) {
    if (typeof window !== 'undefined' && window.location?.href) {
      try {
        return new URL(pdfWorkerAssetUrl, window.location.href).href;
      } catch (_) {
        // ignore
      }
    }
    return pdfWorkerAssetUrl;
  }
  return resolveAssetUrl('pdf.worker.min.mjs');
}

// Configure offline worker
pdfjsLib.GlobalWorkerOptions.workerSrc = resolveWorkerSrc();

let workerPreloadPromise: Promise<void> | null = null;
async function ensurePdfWorkerReady(): Promise<void> {
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = resolveWorkerSrc();
  }
  if ((globalThis as any).pdfjsWorker?.WorkerMessageHandler) return;
  if (!workerPreloadPromise) {
    workerPreloadPromise = (async () => {
      let workerReachable = typeof Worker !== 'undefined';
      if (workerReachable && typeof window !== 'undefined' && typeof fetch === 'function') {
        try {
          const src = pdfjsLib.GlobalWorkerOptions.workerSrc;
          const res = await fetch(src, { cache: 'force-cache' });
          const ct = res.headers.get('content-type') || '';
          if (!res.ok || /html/i.test(ct)) {
            workerReachable = false;
          }
        } catch (_) {
          workerReachable = false;
        }
      }
      if (!workerReachable) {
        const mod = await import('pdfjs-dist/build/pdf.worker.mjs');
        (globalThis as any).pdfjsWorker = mod;
      }
    })().catch(() => {
      workerPreloadPromise = null;
    });
  }
  await workerPreloadPromise;
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
  private _activeChunkTasks: Map<number, any> = new Map();
  private _renderedBitmaps = new Map<string, CachedBitmap>();
  private _textLayoutCache = new Map<string, PageTextLayout>();
  private _textLayoutInFlight = new Map<string, Promise<PageTextLayout | null>>();
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

  public get pdfDocument(): pdfjsLib.PDFDocumentProxy | null {
    return this._pdfDoc;
  }

  /**
   * Loads a PDF document from raw binary bytes, with multi-document tab caching.
   */
  public async loadFromBytes(
    data: Uint8Array,
    docId?: string,
    forceReload: boolean = false,
    password?: string
  ): Promise<{
    pageCount: number;
    pages: PageInfo[];
    bookmarks: PDFBookmarkItem[];
  }> {
    // If this document is already cached in memory and not force-reloading, switch to it instantly (<1ms)
    if (!forceReload && docId && this._docSessions.has(docId)) {
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

    // Save previous active session before replacing (only if switching to a different doc)
    if (this._currentDocId && this._currentDocId !== docId && this._docSessions.has(this._currentDocId)) {
      const prev = this._docSessions.get(this._currentDocId)!;
      prev.pageCache = this._pageCache;
      prev.renderedBitmaps = this._renderedBitmaps;
    }

    // Clone bytes and strip native /Ink + VEditor annotations from the render copy
    // in a single pass so PDF.js does not bake them into the base raster underneath
    // our editable vector strokes (caller's original Uint8Array stays untouched).
    let dataCopy: Uint8Array = data.slice(0);
    try {
      const renderDocument = await PDFDocument.load(dataCopy, { ignoreEncryption: true, updateMetadata: false });
      if (!renderDocument.isEncrypted) {
        const inkStripped = stripNativeInkAnnotations(renderDocument);
        const nativeStripped = stripImportedNativeAnnotations(renderDocument);
        if (inkStripped || nativeStripped) {
          dataCopy = new Uint8Array(await renderDocument.save({ useObjectStreams: false }));
        }
      }
    } catch (e) {
      console.warn('Could not strip native annotations for rendering:', e);
    }

    await ensurePdfWorkerReady();
    const localBase = resolveAssetUrl('');
    const loadingTask = pdfjsLib.getDocument({
      data: dataCopy,
      ...(password ? { password } : {}),
      // Bundled locally (vite copies cmaps/ + standard_fonts/) so offline
      // and extension CSP never hit the network on the critical path.
      cMapUrl: `${localBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${localBase}standard_fonts/`,
      verbosity: 0
    });

    const newPdfDoc = await loadingTask.promise;
    const newPageCache = new Map<number, pdfjsLib.PDFPageProxy>();
    const newRenderedBitmaps = new Map<string, CachedBitmap>();
    const pageCount = newPdfDoc.numPages;
    const pages: PageInfo[] = [];

    // Instant load: only page 1 is awaited; pages 2..N start with page 1's box
    // as a placeholder and are filled in the background so a 500-page PDF
    // opens in one round-trip instead of 500.
    let defaultWidth = 612;
    let defaultHeight = 792;
    let defaultRotation = 0;

    try {
      const firstPage = await newPdfDoc.getPage(1);
      newPageCache.set(0, firstPage);
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

    // Cancel any ongoing rendering tasks and atomically swap out the old session
    for (const [, task] of this._activeRenderTasks) {
      try { task.cancel(); } catch (e) {}
    }
    this._activeRenderTasks.clear();
    for (const [, task] of this._activeChunkTasks) {
      try { task.cancel(); } catch (e) {}
    }
    this._activeChunkTasks.clear();

    if (docId) {
      this.clearLinkCache(docId);
      const oldSession = this._docSessions.get(docId);
      if (oldSession && oldSession.doc !== newPdfDoc) {
        try {
          oldSession.pageCache.clear();
          for (const [, entry] of oldSession.renderedBitmaps) {
            if (entry.canvas) {
              entry.canvas.width = 1;
              entry.canvas.height = 1;
            }
          }
          oldSession.renderedBitmaps.clear();
          if (typeof (oldSession.doc as any).cleanup === 'function') {
            (oldSession.doc as any).cleanup();
          }
          if (oldSession.doc.loadingTask && typeof (oldSession.doc.loadingTask as any).destroy === 'function') {
            (oldSession.doc.loadingTask as any).destroy();
          }
        } catch (_) {}
      }
    }

    this._pdfDoc = newPdfDoc;
    this._pageCache = newPageCache;
    this._renderedBitmaps = newRenderedBitmaps;

    const meta = { pageCount, pages, bookmarks: [] as PDFBookmarkItem[] };
    if (docId) {
      this._docSessions.set(docId, {
        doc: this._pdfDoc,
        pageCache: this._pageCache,
        renderedBitmaps: this._renderedBitmaps,
        meta
      });
      this._currentDocId = docId;
      void this.fillMetadataBackground(docId);
    } else {
      void this.fillMetadataBackground(null, { doc: this._pdfDoc, meta } as any);
    }

    return meta;
  }

  /**
   * Background pass: true per-page sizes (head batch of 30, then tail in
   * yielding chunks of 20) + outline. Mutates the already-returned meta in
   * place and notifies `onDimensionsUpdated` whenever a page differs from the
   * page-1 placeholder.
   */
  private async fillMetadataBackground(
    docId: string | null,
    ephemeral?: { doc: pdfjsLib.PDFDocumentProxy; meta: { pageCount: number; pages: PageInfo[]; bookmarks: PDFBookmarkItem[] } }
  ): Promise<void> {
    try {
      const session = docId ? this._docSessions.get(docId) : undefined;
      const doc = session?.doc ?? ephemeral?.doc ?? null;
      const meta = session?.meta ?? ephemeral?.meta ?? null;
      if (!doc || !meta) return;
      const pageCount = meta.pageCount;

      const headLimit = Math.min(pageCount, 30);
      let dimsChanged = false;
      const fetchOne = async (pageNum: number): Promise<void> => {
        if (docId && !this._docSessions.has(docId)) return;
        try {
          const cached = session?.pageCache.get(pageNum - 1);
          const p = cached ?? await doc.getPage(pageNum);
          if (session && !session.pageCache.has(pageNum - 1)) {
            if (session.pageCache.size >= 24) {
              const oldest = session.pageCache.keys().next().value;
              if (oldest !== undefined && oldest !== pageNum - 1) {
                const oldPage = session.pageCache.get(oldest);
                session.pageCache.delete(oldest);
                if (!this._activeRenderTasks.has(oldest) && !this._activeChunkTasks.has(oldest)) {
                  try { oldPage?.cleanup(); } catch (_) {}
                }
              }
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
          meta.bookmarks = await this.resolveOutlineItems(doc, outline);
          if (docId) {
            const openDoc = store.openDocuments.get(docId);
            if (openDoc) {
              openDoc.bookmarks = meta.bookmarks;
            }
            if (store.activeDocument?.id === docId) {
              store.activeDocument.bookmarks = meta.bookmarks;
              store.notify();
            }
            this.emitDimensionsUpdated(docId);
          }
        }
      } catch (err) {
        console.warn('Could not extract outline:', err);
      }
    } catch (e) {
      console.warn('Background metadata fill failed:', e);
    }
  }

  private async resolveOutlineItems(doc: pdfjsLib.PDFDocumentProxy, items: any[]): Promise<PDFBookmarkItem[]> {
    if (!items || !Array.isArray(items)) return [];
    const resolved: PDFBookmarkItem[] = [];
    for (const item of items) {
      let pageIndex: number | undefined = typeof item.pageIndex === 'number' ? item.pageIndex : undefined;
      if (pageIndex === undefined && item.dest) {
        try {
          const destArray = typeof item.dest === 'string'
            ? await doc.getDestination(item.dest)
            : (Array.isArray(item.dest) ? item.dest : null);
          if (destArray && destArray.length > 0) {
            const ref = destArray[0];
            if (typeof ref === 'number' && Number.isFinite(ref)) {
              pageIndex = Math.max(0, Math.min(doc.numPages - 1, ref));
            } else if (ref && typeof ref === 'object') {
              const idx = await doc.getPageIndex(ref);
              if (typeof idx === 'number' && Number.isFinite(idx)) {
                pageIndex = Math.max(0, Math.min(doc.numPages - 1, idx));
              }
            }
          }
        } catch (_) {
          // Some malformed outline items have invalid destinations; keep title & children intact
        }
      }
      const children = item.items && Array.isArray(item.items) && item.items.length > 0
        ? await this.resolveOutlineItems(doc, item.items)
        : undefined;
      resolved.push({
        title: typeof item.title === 'string' ? item.title : String(item.title || ''),
        dest: item.dest,
        pageIndex,
        items: children
      });
    }
    return resolved;
  }

  /**
   * Reconstructs any native /Ink annotations in `bytes` as veditor pen
   * strokes, reading their raw vector /InkList points (never the /AP raster)
   * so they render through the same smoothed, resolution-independent spline
   * pipeline as strokes drawn in the app. Pure and side-effect free —
   * callers decide whether/where to add the results; called once per file
   * open, never on every reload, so re-opening a session never duplicates
   * strokes that were already imported.
   */
  private _lastExtractedBookmarks: UserBookmarkItem[] = [];
  private _lastExtractedFormValues: Record<string, string | boolean> = {};

  public getLastExtractedUserBookmarks(): UserBookmarkItem[] {
    return this._lastExtractedBookmarks;
  }

  public getLastExtractedFormValues(): Record<string, string | boolean> {
    return this._lastExtractedFormValues;
  }

  private parseVEditorStateFromDoc(pdfDoc: PDFDocument): {
    userBookmarks: UserBookmarkItem[];
    compositeAnnotations: Array<{ pageIndex: number; annotation: Annotation }>;
    formValues: Record<string, string | boolean>;
  } {
    const userBookmarks: UserBookmarkItem[] = [];
    const compositeAnnotations: Array<{ pageIndex: number; annotation: Annotation }> = [];
    const formValues: Record<string, string | boolean> = {};
    try {
      const rawObj = pdfDoc.context.lookup(pdfDoc.catalog.get(PDFName.of('VEditorState')));
      const jsonStr =
        rawObj instanceof PDFHexString || rawObj instanceof PDFString
          ? rawObj.decodeText()
          : undefined;
      if (!jsonStr) return { userBookmarks, compositeAnnotations, formValues };
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed?.userBookmarks)) {
        for (const bm of parsed.userBookmarks) {
          if (bm && typeof bm.id === 'string' && typeof bm.title === 'string' && typeof bm.pageIndex === 'number') {
            userBookmarks.push({
              id: bm.id,
              title: bm.title,
              pageIndex: bm.pageIndex,
              ...(typeof bm.note === 'string' && bm.note.trim() ? { note: bm.note.trim() } : {}),
              createdAt: typeof bm.createdAt === 'number' ? bm.createdAt : Date.now(),
              ...(typeof bm.updatedAt === 'number' ? { updatedAt: bm.updatedAt } : {})
            });
          }
        }
      }
      if (parsed?.compositeAnnotations && typeof parsed.compositeAnnotations === 'object') {
        for (const [pageKey, list] of Object.entries(parsed.compositeAnnotations)) {
          const pageIndex = Number(pageKey);
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Array.isArray(list)) continue;
          for (const ann of list) {
            if (ann && typeof ann === 'object' && typeof (ann as any).id === 'string' && typeof (ann as any).type === 'string') {
              compositeAnnotations.push({ pageIndex, annotation: { ...(ann as Annotation), pageIndex } });
            }
          }
        }
      }
      if (parsed?.formValues && typeof parsed.formValues === 'object') {
        for (const [key, val] of Object.entries(parsed.formValues)) {
          if (typeof val === 'string' || typeof val === 'boolean') {
            formValues[key] = val;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to parse VEditorState from PDF catalog:', e);
    }
    return { userBookmarks, compositeAnnotations, formValues };
  }

  public async extractNativeAnnotations(bytes: Uint8Array, password?: string) {
    let toolMap: Map<string, 'pen' | 'highlighter'> | undefined;
    let metaMap: Map<string, { tool?: 'pen' | 'highlighter'; tipShape?: 'chisel' | 'round'; opacity?: number }> | undefined;
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (bytesMayContainInkAnnotations(bytes)) {
      try {
        toolMap = extractNativeInkToolMap(pdfDoc);
        metaMap = extractNativeInkMetaMap(pdfDoc);
      } catch (_) {}
    }
    const { userBookmarks, compositeAnnotations, formValues } = this.parseVEditorStateFromDoc(pdfDoc);
    this._lastExtractedBookmarks = userBookmarks;
    this._lastExtractedFormValues = formValues;
    const inkStrokes = await this.extractNativeInkStrokes(bytes, toolMap, metaMap, password);
    return [...inkStrokes, ...importNativeAnnotations(pdfDoc), ...compositeAnnotations];
  }

  public async extractNativeInkStrokes(
    bytes: Uint8Array,
    toolMap?: Map<string, 'pen' | 'highlighter'>,
    metaMap?: Map<string, { tool?: 'pen' | 'highlighter'; tipShape?: 'chisel' | 'round'; opacity?: number }>,
    password?: string
  ): Promise<Array<{ pageIndex: number; annotation: PenAnnotation | HighlighterAnnotation }>> {
    if (!bytesMayContainInkAnnotations(bytes)) return [];
    const results: Array<{ pageIndex: number; annotation: PenAnnotation | HighlighterAnnotation }> = [];
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    try {
      await ensurePdfWorkerReady();
      const localBase = resolveAssetUrl('');
      loadingTask = pdfjsLib.getDocument({
        data: bytes.slice(0),
        ...(password ? { password } : {}),
        cMapUrl: `${localBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${localBase}standard_fonts/`,
        verbosity: 0
      });
      const doc = await loadingTask.promise;

      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
        const inkAnnotations = annotations.filter((a: any) => a.subtype === 'Ink' && Array.isArray(a.inkLists) && a.inkLists.length > 0);
        if (inkAnnotations.length === 0) continue;

        const viewport = page.getViewport({ scale: 1.0 });
        for (const a of inkAnnotations) {
          const rawColor = (a as any).color ?? (a as any).C;
          const colorEntries = rawColor != null
            ? Array.from(rawColor as ArrayLike<number>)
            : [];
          const color = colorEntries.length >= 3
            ? `#${colorEntries.slice(0, 3).map((c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`
            : '#000000';
          const width = Number.isFinite(a.borderStyle?.width) && a.borderStyle.width > 0 ? a.borderStyle.width : 1.5;
          const annotationName = typeof a.annotationName === 'string' && a.annotationName
            ? a.annotationName
            : (typeof a.id === 'string' && a.id ? a.id : '');
          const inkMeta = annotationName ? metaMap?.get(annotationName) : undefined;
          const opacity = typeof inkMeta?.opacity === 'number' && Number.isFinite(inkMeta.opacity)
            ? inkMeta.opacity
            : (Number.isFinite(a.opacity) ? a.opacity : 1);

          const isHighlighter =
            inkMeta?.tool === 'highlighter' ||
            (annotationName && toolMap?.get(annotationName) === 'highlighter') ||
            (opacity <= 0.5 && width >= 10);

          const lists = a.inkLists as number[][];
          for (let listIndex = 0; listIndex < lists.length; listIndex++) {
            const list = lists[listIndex];
            const points: StrokePoint[] = [];
            for (let p = 0; p + 1 < list.length; p += 2) {
              const [vx, vy] = viewport.convertToViewportPoint(list[p], list[p + 1]);
              points.push({ x: vx, y: vy, pressure: 0.5 });
            }
            if (points.length < 2) continue;

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of points) {
              if (pt.x < minX) minX = pt.x;
              if (pt.y < minY) minY = pt.y;
              if (pt.x > maxX) maxX = pt.x;
              if (pt.y > maxY) maxY = pt.y;
            }

            const now = Date.now();
            const annotId = lists.length > 1
              ? `${annotationName || `ink_${Math.random().toString(36).slice(2, 10)}_${now.toString(36)}`}#${listIndex}`
              : (annotationName || `ink_${Math.random().toString(36).slice(2, 10)}_${now.toString(36)}`);

            if (isHighlighter) {
              const effOpacity = Math.max(0.05, Math.min(1, opacity));
              const hlColor = color.startsWith('#') && color.length === 7
                ? `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${effOpacity})`
                : color;
              results.push({
                pageIndex: n - 1,
                annotation: {
                  id: annotId,
                  pageIndex: n - 1,
                  layerId: 'default',
                  type: 'highlighter',
                  box: { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
                  createdAt: now,
                  updatedAt: now,
                  opacity: effOpacity,
                  points,
                  color: hlColor,
                  strokeWidth: width,
                  blendMode: 'source-over',
                  tipShape: inkMeta?.tipShape || 'round'
                }
              });
            } else {
              results.push({
                pageIndex: n - 1,
                annotation: {
                  id: annotId,
                  pageIndex: n - 1,
                  layerId: 'default',
                  type: 'pen',
                  box: { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
                  createdAt: now,
                  updatedAt: now,
                  opacity,
                  points,
                  color,
                  strokeWidth: width,
                  pressureEnabled: false,
                  smoothing: false,
                  strokeSmoothing: 'none'
                }
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not import native ink annotations:', e);
    } finally {
      try { await loadingTask?.destroy(); } catch (_) {}
    }
    return results;
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
    this.cancelPageChunkRender(pageIndex);
  }

  public cancelPageChunkRender(pageIndex: number): void {
    if (this._activeChunkTasks.has(pageIndex)) {
      try {
        this._activeChunkTasks.get(pageIndex).cancel();
      } catch (e) {
        // ignored
      }
      this._activeChunkTasks.delete(pageIndex);
    }
  }

  public clearBitmapCache(): void {
    for (const [, entry] of this._renderedBitmaps) {
      if (entry.canvas) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    }
    this._renderedBitmaps.clear();
  }

  public hasCachedBitmap(pageIndex: number): boolean {
    return this.findAnyBitmap(pageIndex) !== undefined;
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
    const totalRotation = ((rotation || 0) % 360 + 360) % 360;

    // Fast path: if we already have an exact cached bitmap for this page/scale/rotation,
    // blit it synchronously without waiting for any async work.
    const exactKey = bitmapKey(pageIndex, scale, totalRotation);
    const exactCached = this._renderedBitmaps.get(exactKey);
    if (exactCached && exactCached.width > 0 && exactCached.height > 0) {
      if (canvas.width !== exactCached.width || canvas.height !== exactCached.height) {
        canvas.width = exactCached.width;
        canvas.height = exactCached.height;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx?.drawImage(exactCached.canvas, 0, 0);
      return;
    }

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
      // Evict oldest page when cache gets large and release its PDF.js internal resources
      if (this._pageCache.size >= 24) {
        for (const k of this._pageCache.keys()) {
          if (k !== pageIndex && !this._activeRenderTasks.has(k) && !this._activeChunkTasks.has(k)) {
            const evicted = this._pageCache.get(k);
            this._pageCache.delete(k);
            try { evicted?.cleanup(); } catch (_) {}
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
    const rawViewport = page.getViewport({ scale: scale * dpr, rotation: totalRotation });

    // Cap backing-store size and total pixel budget at high zoom/dpr so
    // integrated GPUs and WebKitGTK never allocate multi-hundred-MB canvases.
    let renderScale = scale * dpr;
    const rawW = Math.floor(rawViewport.width);
    const rawH = Math.floor(rawViewport.height);
    const largest = Math.max(rawW, rawH);
    const maxDim = scale > 2.2 ? 1536 : ADAPTIVE_CANVAS_MAX_DIMENSION;
    const maxPixels = scale > 2.2 ? 1536 * 1536 : ADAPTIVE_CANVAS_MAX_PIXELS;
    if (largest > maxDim && largest > 0) {
      renderScale *= maxDim / largest;
    }
    const cappedArea = (rawW * (renderScale / (scale * dpr))) * (rawH * (renderScale / (scale * dpr)));
    if (cappedArea > maxPixels && cappedArea > 0) {
      renderScale *= Math.sqrt(maxPixels / cappedArea);
    }
    const viewport = renderScale !== scale * dpr
      ? page.getViewport({ scale: renderScale, rotation: totalRotation })
      : rawViewport;

    const targetWidth = Math.max(1, Math.floor(viewport.width));
    const targetHeight = Math.max(1, Math.floor(viewport.height));

    // Zero-blank frame double buffering: paint any cached bitmap for this page
    // immediately (even at a different zoom) so the user never sees white
    // canvas space while re-rendering. CSS size is owned by main.ts layout —
    // only the backing store is touched here to avoid ±1px seam drift.
    const cached = this._renderedBitmaps.get(exactKey) ?? this.findAnyBitmap(pageIndex);
    if (cached) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
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
    if (!offCtx) {
      offscreen.width = 1;
      offscreen.height = 1;
      return;
    }

    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, targetWidth, targetHeight);

    const renderContext = {
      // pdf.js v6 accepts either `canvas` or a raw 2d context; the offscreen
      // element is passed explicitly to satisfy the stricter typings.
      canvas: offscreen,
      canvasContext: offCtx,
      viewport: viewport,
      intent: 'display',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE
    };

    const task = page.render(renderContext);
    this._activeRenderTasks.set(pageIndex, task);
    let storedInCache = false;

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

      // Evict any older zoom/rotation scale of this SAME pageIndex so multi-step
      // zooming never accumulates multiple full-page bitmaps for the same page.
      for (const [k, entry] of this._renderedBitmaps) {
        if (entry.pageIndex === pageIndex && k !== exactKey) {
          if (entry.canvas) {
            entry.canvas.width = 0;
            entry.canvas.height = 0;
          }
          this._renderedBitmaps.delete(k);
        }
      }

      // Scale bitmap cache pool with the user's configured Off-screen Page Preload Buffer
      // so pre-rendered pages stay hot in memory and blit in <1ms when scrolling.
      const bufferPages = Math.max(1, Math.min(8, store.appSettings.maxRenderBufferPages || 3));
      const maxCachedBitmaps = store.zoom > 2.4 ? Math.max(4, bufferPages + 2) : Math.max(6, bufferPages * 2 + 3);
      while (this._renderedBitmaps.size >= maxCachedBitmaps && !this._renderedBitmaps.has(exactKey)) {
        const oldestKey = this._renderedBitmaps.keys().next().value;
        if (oldestKey === undefined) break;
        const entry = this._renderedBitmaps.get(oldestKey);
        if (entry?.canvas) {
          entry.canvas.width = 0;
          entry.canvas.height = 0;
        }
        this._renderedBitmaps.delete(oldestKey);
      }

      const prevExact = this._renderedBitmaps.get(exactKey);
      if (prevExact?.canvas && prevExact.canvas !== offscreen) {
        prevExact.canvas.width = 0;
        prevExact.canvas.height = 0;
      }

      this._renderedBitmaps.set(exactKey, {
        pageIndex,
        width: targetWidth,
        height: targetHeight,
        scale,
        rotation: totalRotation,
        canvas: offscreen
      });
      storedInCache = true;

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
      if (!storedInCache) {
        offscreen.width = 0;
        offscreen.height = 0;
      }
      if (this._activeRenderTasks.get(pageIndex) === task) {
        this._activeRenderTasks.delete(pageIndex);
      }
    }
  }

  /**
   * Returns true when the full-page base canvas is resolution-capped at the given
   * `scale`, meaning a High-DPI Viewport Chunk should be rendered over the visible
   * portion of the page for 100% razor-sharp text & vectors.
   */
  public needsViewportChunk(pageIndex: number, scale: number, rotation: number = 0): boolean {
    if (scale <= 1.35) return false;
    const dpr = effectiveDpr();
    const totalRotation = ((rotation || 0) % 360 + 360) % 360;
    const page = this._pageCache.get(pageIndex);
    let w: number;
    let h: number;
    if (page) {
      const vp = page.getViewport({ scale: scale * dpr, rotation: totalRotation });
      w = Math.floor(vp.width);
      h = Math.floor(vp.height);
    } else {
      const info = store.activeDocument?.pages[pageIndex];
      const baseW = info?.originalWidth || info?.width || 612;
      const baseH = info?.originalHeight || info?.height || 792;
      const swapped = totalRotation === 90 || totalRotation === 270;
      w = Math.floor((swapped ? baseH : baseW) * scale * dpr);
      h = Math.floor((swapped ? baseW : baseH) * scale * dpr);
    }
    return (
      scale > 2.2 ||
      Math.max(w, h) > ADAPTIVE_CANVAS_MAX_DIMENSION ||
      w * h > ADAPTIVE_CANVAS_MAX_PIXELS
    );
  }

  /**
   * Renders ONLY the visible viewport intersection chunk `(rect.x, rect.y, rect.width, rect.height)`
   * (in CSS pixels relative to the page container) at full native DPI using PDF.js's
   * `offsetX`/`offsetY` viewport clipping. Keeps high-zoom (200%-800%) pages vector-sharp
   * while using only ~2-3 megapixels of VRAM instead of 100+ MB.
   */
  public async renderPageChunkToCanvas(
    pageIndex: number,
    chunkCanvas: HTMLCanvasElement,
    scale: number,
    rotation: number,
    rect: { x: number; y: number; width: number; height: number }
  ): Promise<void> {
    if (!this._pdfDoc || rect.width < 8 || rect.height < 8) return;
    const renderDocId = this._currentDocId;
    const totalRotation = ((rotation || 0) % 360 + 360) % 360;

    let page = this._pageCache.get(pageIndex);
    if (!page) {
      try {
        page = await this._pdfDoc.getPage(pageIndex + 1);
      } catch (_) {
        return;
      }
      if (renderDocId !== this._currentDocId || !chunkCanvas.isConnected) return;
      this._pageCache.set(pageIndex, page);
    }

    const chunkDpr = resolveAdaptiveCanvasDpr(rect.width, rect.height, store.appSettings.targetDPI);
    const chunkPixelX = Math.round(rect.x * chunkDpr);
    const chunkPixelY = Math.round(rect.y * chunkDpr);
    const chunkPixelW = Math.max(1, Math.round(rect.width * chunkDpr));
    const chunkPixelH = Math.max(1, Math.round(rect.height * chunkDpr));

    const chunkKey = `${scale.toFixed(4)}|${totalRotation}|${chunkPixelX},${chunkPixelY},${chunkPixelW},${chunkPixelH}`;
    if (chunkCanvas.dataset.chunkKey === chunkKey && chunkCanvas.style.display !== 'none') {
      return;
    }

    this.cancelPageChunkRender(pageIndex);

    const chunkViewport = page.getViewport({
      scale: scale * chunkDpr,
      rotation: totalRotation,
      offsetX: -chunkPixelX,
      offsetY: -chunkPixelY
    });

    const offscreen = document.createElement('canvas');
    offscreen.width = chunkPixelW;
    offscreen.height = chunkPixelH;
    const offCtx = offscreen.getContext('2d', { alpha: false });
    if (!offCtx) {
      offscreen.width = 1;
      offscreen.height = 1;
      return;
    }

    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, chunkPixelW, chunkPixelH);

    const task = page.render({
      canvas: offscreen,
      canvasContext: offCtx,
      viewport: chunkViewport,
      intent: 'display',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE
    });
    this._activeChunkTasks.set(pageIndex, task);

    try {
      await task.promise;
      if (!chunkCanvas.isConnected || renderDocId !== this._currentDocId) return;

      chunkCanvas.style.left = `${rect.x}px`;
      chunkCanvas.style.top = `${rect.y}px`;
      chunkCanvas.style.width = `${rect.width}px`;
      chunkCanvas.style.height = `${rect.height}px`;
      if (chunkCanvas.width !== chunkPixelW || chunkCanvas.height !== chunkPixelH) {
        chunkCanvas.width = chunkPixelW;
        chunkCanvas.height = chunkPixelH;
      }
      chunkCanvas.dataset.chunkKey = chunkKey;
      chunkCanvas.dataset.baseZoom = String(scale);
      chunkCanvas.dataset.baseLeft = String(rect.x);
      chunkCanvas.dataset.baseTop = String(rect.y);
      chunkCanvas.dataset.baseWidth = String(rect.width);
      chunkCanvas.dataset.baseHeight = String(rect.height);
      chunkCanvas.style.display = 'block';

      const ctx = chunkCanvas.getContext('2d', { alpha: false });
      ctx?.drawImage(offscreen, 0, 0);
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Error rendering chunk for page ${pageIndex}:`, err);
      }
    } finally {
      // Immediately collapse the temporary offscreen canvas to 0x0 so its
      // 15–25MB GPU texture is freed deterministically without waiting for GC.
      offscreen.width = 0;
      offscreen.height = 0;
      if (this._activeChunkTasks.get(pageIndex) === task) {
        this._activeChunkTasks.delete(pageIndex);
      }
    }
  }

  /**
   * PIPE_4: ASYNC RENDER SCHEDULER
   * Cancels all in-flight rendering tasks for pages not in the visible window.
   */
  public cancelOutdatedRenderTasks(visibleWindow: Set<number>): void {
    for (const [pageIndex, task] of this._activeRenderTasks) {
      if (!visibleWindow.has(pageIndex)) {
        try {
          task.cancel();
        } catch (_) {}
        this._activeRenderTasks.delete(pageIndex);
      }
    }
    for (const [pageIndex, task] of this._activeChunkTasks) {
      if (!visibleWindow.has(pageIndex)) {
        try {
          task.cancel();
        } catch (_) {}
        this._activeChunkTasks.delete(pageIndex);
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

  public async renderThumbnail(pageIndex: number, maxWidth = 136, maxHeight = 176): Promise<HTMLCanvasElement | null> {
    if (!this._pdfDoc) return null;

    let page = this._pageCache.get(pageIndex);
    if (!page) {
      try {
        page = await this._pdfDoc.getPage(pageIndex + 1);
        if (this._pageCache.size < 24) {
          this._pageCache.set(pageIndex, page);
        }
      } catch (_) {
        return null;
      }
    }
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
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        intent: 'display',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE
      }).promise;
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
        intent: 'display',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE
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

  private textLayoutKey(pageIndex: number, rotationOverride?: number): string {
    const docId = this._currentDocId || store.activeDocument?.id || 'ephemeral';
    const userRot = rotationOverride ?? (store.pageRotations[pageIndex] || 0);
    const normRot = ((userRot % 360) + 360) % 360;
    return `${docId}:${pageIndex}:${normRot}`;
  }

  public getCachedPageTextLayout(pageIndex: number, rotationOverride?: number): PageTextLayout | null {
    const key = this.textLayoutKey(pageIndex, rotationOverride);
    return this._textLayoutCache.get(key) ?? null;
  }

  public async getPageTextLayout(pageIndex: number, rotationOverride?: number): Promise<PageTextLayout | null> {
    if (!this._pdfDoc) return null;
    const key = this.textLayoutKey(pageIndex, rotationOverride);
    const cached = this._textLayoutCache.get(key);
    if (cached) return cached;

    const existingPromise = this._textLayoutInFlight.get(key);
    if (existingPromise) return existingPromise;

    const userRot = rotationOverride ?? (store.pageRotations[pageIndex] || 0);
    const promise = extractPageTextLayout(this._pdfDoc, pageIndex, userRot)
      .then((layout) => {
        this._textLayoutCache.set(key, layout);
        this._textLayoutInFlight.delete(key);
        return layout;
      })
      .catch((err) => {
        console.warn(`Failed to extract text layout for page ${pageIndex}:`, err);
        this._textLayoutInFlight.delete(key);
        return null;
      });

      this._textLayoutInFlight.set(key, promise);
    return promise;
  }

  private _linkCache = new Map<string, PDFLinkItem[]>();

  /**
   * 3-Layer Universal Link & Reference Detector:
   *  1. PDF.js `/Link` annotations (external URLs, named actions, explicit/named destinations)
   *  2. Raw PDF `/Annots` dictionary inspector via `pdf-lib` (catches custom/legacy PDF generators)
   *  3. Text-Layer Smart Scanner (turns plain-text URLs, emails, DOIs, and explicit page/section
   *     references into interactive hotspots when not already covered by a `/Link` annotation)
   */
  public async getPageLinks(pageIndex: number, rotationOverride?: number): Promise<PDFLinkItem[]> {
    if (!this._pdfDoc) return [];
    const key = this.textLayoutKey(pageIndex, rotationOverride);
    const cached = this._linkCache.get(key);
    if (cached) return cached;

    const doc = this._pdfDoc;
    const renderDocId = this._currentDocId;

    try {
      let page = this._pageCache.get(pageIndex);
      if (!page) {
        page = await doc.getPage(pageIndex + 1);
        if (renderDocId === this._currentDocId && this._pageCache.size < 24) {
          this._pageCache.set(pageIndex, page);
        }
      }

      const userRot = rotationOverride ?? (store.pageRotations[pageIndex] || 0);
      const totalRotation = (((page.rotate || 0) + (userRot || 0)) % 360 + 360) % 360;
      const vp = page.getViewport({ scale: 1.0, rotation: totalRotation });
      if (vp.width <= 0 || vp.height <= 0) return [];

      const rawAnnotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
      const links: PDFLinkItem[] = [];

      const normalizeExternalUrl = (raw: string): string | null => {
        const trimmed = raw.trim().replace(/[.,;:!?)]+$/, '');
        if (!trimmed) return null;
        if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
        if (/^www\.[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
        if (/^doi\s*:\s*(10\.\d{4,9}\/\S+)/i.test(trimmed)) {
          const m = trimmed.match(/^doi\s*:\s*(10\.\d{4,9}\/\S+)/i);
          return m ? `https://doi.org/${m[1]}` : null;
        }
        if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(trimmed)) {
          return `https://doi.org/${trimmed}`;
        }
        if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) {
          return `mailto:${trimmed}`;
        }
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S+/i.test(trimmed)) {
          return `https://${trimmed}`;
        }
        return null;
      };

      const overlapsExisting = (nx: number, ny: number, nw: number, nh: number): boolean => {
        const cx = nx + nw / 2;
        const cy = ny + nh / 2;
        for (const ex of links) {
          if (cx >= ex.nx && cx <= ex.nx + ex.nw && cy >= ex.ny && cy <= ex.ny + ex.nh) {
            return true;
          }
          const ox = Math.max(0, Math.min(nx + nw, ex.nx + ex.nw) - Math.max(nx, ex.nx));
          const oy = Math.max(0, Math.min(ny + nh, ex.ny + ex.nh) - Math.max(ny, ex.ny));
          const inter = ox * oy;
          if (inter > 0) {
            const minArea = Math.min(nw * nh, ex.nw * ex.nh);
            if (minArea > 0 && inter / minArea > 0.35) return true;
          }
        }
        return false;
      };

      const convertPdfRectToNormalized = (rect: number[]) => {
        let x1 = rect[0], y1 = rect[1], x2 = rect[2], y2 = rect[3];
        if (typeof vp.convertToViewportPoint === 'function') {
          const [vx1, vy1] = vp.convertToViewportPoint(x1, y1);
          const [vx2, vy2] = vp.convertToViewportPoint(x2, y2);
          x1 = vx1; y1 = vy1; x2 = vx2; y2 = vy2;
        } else if (typeof (vp as any).convertToViewportRectangle === 'function') {
          const r = (vp as any).convertToViewportRectangle(rect);
          x1 = r[0]; y1 = r[1]; x2 = r[2]; y2 = r[3];
        } else {
          y1 = vp.height - rect[1];
          y2 = vp.height - rect[3];
        }
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const nx = Math.max(0, Math.min(1, minX / vp.width));
        const ny = Math.max(0, Math.min(1, minY / vp.height));
        const nw = Math.max(0.002, Math.min(1 - nx, (maxX - minX) / vp.width));
        const nh = Math.max(0.002, Math.min(1 - ny, (maxY - minY) / vp.height));
        return { nx, ny, nw, nh };
      };

      // --- LAYER 1: PDF.js Annotation Layer ---
      for (let i = 0; i < rawAnnotations.length; i++) {
        const annot: any = rawAnnotations[i];
        if (!annot || annot.subtype !== 'Link' || !Array.isArray(annot.rect) || annot.rect.length < 4) {
          continue;
        }

        const { nx, ny, nw, nh } = convertPdfRectToNormalized(annot.rect);

        const rawUrl = typeof annot.url === 'string' && annot.url.trim()
          ? annot.url.trim()
          : (typeof annot.unsafeUrl === 'string' && annot.unsafeUrl.trim() ? annot.unsafeUrl.trim() : '');

        const normalizedUrl = rawUrl ? normalizeExternalUrl(rawUrl) : null;
        if (normalizedUrl) {
          links.push({
            id: String(annot.id || `link_${pageIndex}_${i}`),
            pageIndex,
            nx,
            ny,
            nw,
            nh,
            url: normalizedUrl,
            title: normalizedUrl
          });
          continue;
        }

        // Support PDF /Named actions (FirstPage, LastPage, NextPage, PrevPage)
        if (typeof annot.action === 'string' && annot.action) {
          let namedTarget: number | undefined;
          if (annot.action === 'FirstPage') namedTarget = 0;
          else if (annot.action === 'LastPage') namedTarget = doc.numPages - 1;
          else if (annot.action === 'NextPage') namedTarget = Math.min(doc.numPages - 1, pageIndex + 1);
          else if (annot.action === 'PrevPage') namedTarget = Math.max(0, pageIndex - 1);
          if (namedTarget !== undefined) {
            links.push({
              id: String(annot.id || `link_${pageIndex}_${i}`),
              pageIndex,
              nx,
              ny,
              nw,
              nh,
              destPageIndex: namedTarget
            });
            continue;
          }
        }

        // Resolve internal destination
        let destArray: any[] | null = null;
        if (typeof annot.dest === 'string' && annot.dest) {
          try {
            destArray = await doc.getDestination(annot.dest);
          } catch (_) {}
          if (!destArray) {
            // Heuristic fallback if named destination string encodes a page number (e.g. "page.3" or "Page3")
            const pageMatch = annot.dest.match(/(?:page[._\-\s]*|^p)(\d+)$/i);
            if (pageMatch) {
              const pNum = parseInt(pageMatch[1], 10);
              if (pNum >= 1 && pNum <= doc.numPages) {
                destArray = [pNum - 1, { name: 'XYZ' }, null, null, null];
              }
            }
          }
        } else if (Array.isArray(annot.dest)) {
          destArray = annot.dest;
        }

        if (destArray && destArray.length > 0) {
          let destPageIndex: number | undefined;
          const ref = destArray[0];
          try {
            if (typeof ref === 'number' && Number.isFinite(ref)) {
              destPageIndex = Math.max(0, Math.min(doc.numPages - 1, ref));
            } else if (ref && typeof ref === 'object') {
              const idx = await doc.getPageIndex(ref);
              if (typeof idx === 'number' && Number.isFinite(idx)) {
                destPageIndex = Math.max(0, Math.min(doc.numPages - 1, idx));
              }
            }
          } catch (_) {}

          if (destPageIndex !== undefined) {
            let destOffsetYRatio: number | undefined;
            const kindName = destArray[1]?.name;
            if ((kindName === 'XYZ' || kindName === 'FitH' || kindName === 'FitBH') && typeof destArray[3] === 'number') {
              try {
                const targetPageInfo = store.activeDocument?.pages[destPageIndex];
                const pageH = targetPageInfo?.originalHeight || vp.height || 792;
                destOffsetYRatio = Math.max(0, Math.min(0.95, 1 - destArray[3] / pageH));
              } catch (_) {}
            } else if ((kindName === 'FitH' || kindName === 'FitBH') && typeof destArray[2] === 'number') {
              try {
                const targetPageInfo = store.activeDocument?.pages[destPageIndex];
                const pageH = targetPageInfo?.originalHeight || vp.height || 792;
                destOffsetYRatio = Math.max(0, Math.min(0.95, 1 - destArray[2] / pageH));
              } catch (_) {}
            }

            links.push({
              id: String(annot.id || `link_${pageIndex}_${i}`),
              pageIndex,
              nx,
              ny,
              nw,
              nh,
              destPageIndex,
              destOffsetYRatio
            });
          }
        }
      }

      // --- LAYER 2: Raw PDF Page `/Annots` Dictionary Inspector via pdf-lib ---
      if (store.activeDocument?.fileData) {
        try {
          const pdfLibDoc = await PDFDocument.load(store.activeDocument.fileData, {
            ignoreEncryption: true,
            updateMetadata: false
          });
          const pdfPages = pdfLibDoc.getPages();
          if (pageIndex >= 0 && pageIndex < pdfPages.length) {
            const refToPageIdx = new Map<string, number>();
            pdfPages.forEach((p, idx) => {
              if (p.ref) refToPageIdx.set(p.ref.toString(), idx);
            });
            const lookupKey = (dict: any, keyName: string): any => {
              if (!dict || typeof dict.lookup !== 'function') return undefined;
              try {
                const byName = dict.lookup(PDFName.of(keyName)) ?? dict.get?.(PDFName.of(keyName));
                if (byName !== undefined) return byName;
              } catch (_) {}
              try {
                return dict.lookup(pdfLibDoc.context.obj(keyName)) ?? dict.get?.(pdfLibDoc.context.obj(keyName));
              } catch (_) {
                return undefined;
              }
            };

            const annotsArr = pdfPages[pageIndex].node.Annots();
            if (annotsArr) {
              for (let i = 0; i < annotsArr.size(); i++) {
                const dict: any = annotsArr.lookup(i);
                if (!dict || typeof dict.get !== 'function') continue;
                const subtypeObj = lookupKey(dict, 'Subtype');
                const subtypeStr = String(subtypeObj?.decodeText?.() ?? subtypeObj?.asString?.() ?? subtypeObj?.toString?.() ?? '');
                if (!/Link/i.test(subtypeStr)) continue;

                const rectArr: any = lookupKey(dict, 'Rect');
                if (!rectArr || typeof rectArr.size !== 'function' || rectArr.size() < 4) continue;
                const rNums = [0, 1, 2, 3].map(k => Number(rectArr.lookup(k)?.asNumber?.() ?? 0));
                const { nx, ny, nw, nh } = convertPdfRectToNormalized(rNums);
                if (overlapsExisting(nx, ny, nw, nh)) continue;

                const actionDict: any = lookupKey(dict, 'A');
                if (actionDict && typeof actionDict.lookup === 'function') {
                  const uriObj: any = lookupKey(actionDict, 'URI');
                  const uriRaw = String(uriObj?.decodeText?.() ?? uriObj?.asString?.() ?? '').trim();
                  const normalizedUri = uriRaw ? normalizeExternalUrl(uriRaw) : null;
                  if (normalizedUri) {
                    links.push({
                      id: `pdflib_link_${pageIndex}_${i}`,
                      pageIndex,
                      nx,
                      ny,
                      nw,
                      nh,
                      url: normalizedUri,
                      title: normalizedUri
                    });
                    continue;
                  }
                }

                // Check direct /Dest on annotation OR /D inside /A << /S /GoTo /D ... >>
                const destArr: any = lookupKey(dict, 'Dest') ?? (actionDict ? lookupKey(actionDict, 'D') : undefined);
                if (destArr && typeof destArr.size === 'function' && destArr.size() > 0) {
                  const rawRef = destArr.get(0);
                  let destPageIndex = rawRef ? refToPageIdx.get(rawRef.toString()) : undefined;
                  if (destPageIndex === undefined) {
                    const numPage = Number(destArr.lookup(0)?.asNumber?.() ?? NaN);
                    if (Number.isFinite(numPage) && numPage >= 0 && numPage < pdfPages.length) {
                      destPageIndex = numPage;
                    }
                  }
                  if (destPageIndex !== undefined) {
                    const topNum = destArr.size() >= 4 ? Number(destArr.lookup(3)?.asNumber?.() ?? NaN) : NaN;
                    const pageH = vp.height || 792;
                    const destOffsetYRatio = Number.isFinite(topNum)
                      ? Math.max(0, Math.min(0.95, 1 - topNum / pageH))
                      : undefined;
                    links.push({
                      id: `pdflib_link_${pageIndex}_${i}`,
                      pageIndex,
                      nx,
                      ny,
                      nw,
                      nh,
                      destPageIndex,
                      destOffsetYRatio
                    });
                  }
                }
              }
            }
          }
        } catch (_) {}
      }

      // --- LAYER 3: Smart Text-Layer Link & Reference Scanner ---
      // Detects plain-text URLs, emails, DOIs, and explicit page/section references
      // that lack PDF `/Link` annotation boxes in the file.
      try {
        const textLayout = this.getCachedPageTextLayout(pageIndex, userRot)
          ?? await this.getPageTextLayout(pageIndex, userRot);
        if (textLayout && textLayout.fullText && textLayout.width > 0 && textLayout.height > 0) {
          const fullText = textLayout.fullText;
          const toAsciiDigits = (s: string) =>
            s.replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
             .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));

          const addTextMatchHotspots = (
            startOffset: number,
            endOffset: number,
            payload: { url?: string; title?: string; destPageIndex?: number; destOffsetYRatio?: number },
            idPrefix: string
          ) => {
            const rects = getTextRangeRects(textLayout, startOffset, endOffset);
            for (let rIdx = 0; rIdx < rects.length; rIdx++) {
              const r = rects[rIdx];
              const nx = Math.max(0, Math.min(1, r.x / textLayout.width));
              const ny = Math.max(0, Math.min(1, r.y / textLayout.height));
              const nw = Math.max(0.004, Math.min(1 - nx, r.width / textLayout.width));
              const nh = Math.max(0.004, Math.min(1 - ny, r.height / textLayout.height));
              if (overlapsExisting(nx, ny, nw, nh)) continue;
              links.push({
                id: `${idPrefix}_${pageIndex}_${startOffset}_${rIdx}`,
                pageIndex,
                nx,
                ny,
                nw,
                nh,
                ...payload
              });
            }
          };

          // 3a. Plain-text URLs, bare common domains, DOIs, and email addresses
          const urlEmailDoiRegex = /\b(?:https?:\/\/[^\s<>()"'\]）】]+|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s<>()"'\]）】]*|(?:github\.com|gitlab\.com|arxiv\.org|doi\.org|wikipedia\.org|stackoverflow\.com|youtube\.com|youtu\.be|t\.me|linkedin\.com|medium\.com|docs\.google\.com|drive\.google\.com)\/[^\s<>()"'\]）】]+|doi\s*:\s*10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+|10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
          let match: RegExpExecArray | null;
          while ((match = urlEmailDoiRegex.exec(fullText)) !== null) {
            let rawToken = match[0];
            let endOff = match.index + rawToken.length;
            while (rawToken.length > 0 && /[.,;:!?)'"\]）】]$/.test(rawToken)) {
              rawToken = rawToken.slice(0, -1);
              endOff--;
            }
            const url = normalizeExternalUrl(rawToken);
            if (url && endOff > match.index) {
              addTextMatchHotspots(match.index, endOff, { url, title: url }, 'txt_url');
            }
          }

          // 3b. Explicit Internal Page References (e.g. "Page 3", "page 2", "p. 3", "صفحه ۲")
          if (doc.numPages > 1) {
            const pageRefRegex = /(?:^|[\s([«"'])(?:[Pp]ages?|[Pp]p?\.|صفحه|صفحات)\s*([0-9۰-۹٠-٩]{1,4})\b/g;
            while ((match = pageRefRegex.exec(fullText)) !== null) {
              const numStr = toAsciiDigits(match[1]);
              const targetPageNum = parseInt(numStr, 10);
              if (Number.isFinite(targetPageNum) && targetPageNum >= 1 && targetPageNum <= doc.numPages) {
                const targetIdx = targetPageNum - 1;
                if (targetIdx !== pageIndex) {
                  const fullMatch = match[0];
                  const trimLead = fullMatch.match(/^[\s([«"']/)?.[0]?.length ?? 0;
                  const sOff = match.index + trimLead;
                  const eOff = match.index + fullMatch.length;
                  addTextMatchHotspots(sOff, eOff, { destPageIndex: targetIdx }, 'txt_pg');
                }
              }
            }
          }

          // 3c. Outline / Bookmark Section References (e.g. "Section 2", "Chapter 3", "بخش ۲")
          const bookmarks = store.activeDocument?.bookmarks;
          if (bookmarks && bookmarks.length > 0 && doc.numPages > 1) {
            const flatBookmarks: Array<{ title: string; pageIndex: number }> = [];
            const walkBm = (items: PDFBookmarkItem[]) => {
              for (const it of items) {
                if (typeof it.pageIndex === 'number' && it.title) {
                  flatBookmarks.push({ title: it.title.trim(), pageIndex: it.pageIndex });
                }
                if (it.items?.length) walkBm(it.items);
              }
            };
            walkBm(bookmarks);

            if (flatBookmarks.length > 0) {
              const secRefRegex = /(?:^|[\s([«"'])(?:[Ss]ection|[Cc]hapter|[Pp]art|بخش|فصل)\s+([0-9۰-۹٠-٩]+(?:\.[0-9۰-۹٠-٩]+)*)\b/g;
              while ((match = secRefRegex.exec(fullText)) !== null) {
                const secNum = toAsciiDigits(match[1]);
                const bm = flatBookmarks.find(b =>
                  b.title.startsWith(`${secNum}.`) ||
                  b.title.startsWith(`${secNum} `) ||
                  b.title.includes(` ${secNum} `)
                );
                if (bm && bm.pageIndex !== pageIndex) {
                  const fullMatch = match[0];
                  const trimLead = fullMatch.match(/^[\s([«"']/)?.[0]?.length ?? 0;
                  const sOff = match.index + trimLead;
                  const eOff = match.index + fullMatch.length;
                  addTextMatchHotspots(sOff, eOff, { destPageIndex: bm.pageIndex }, 'txt_sec');
                }
              }
            }
          }
        }
      } catch (_) {}

      this._linkCache.set(key, links);
      return links;
    } catch (e) {
      console.warn(`Could not extract links for page ${pageIndex}:`, e);
      return [];
    }
  }

  public clearLinkCache(docId?: string): void {
    if (!docId) {
      this._linkCache.clear();
      this._textLayoutCache.clear();
      return;
    }
    const prefix = `${docId}:`;
    for (const k of this._linkCache.keys()) {
      if (k.startsWith(prefix)) this._linkCache.delete(k);
    }
    for (const k of this._textLayoutCache.keys()) {
      if (k.startsWith(prefix)) this._textLayoutCache.delete(k);
    }
  }

  /**
   * Releases and cleans up a specific cached document session (when a tab is closed).
   */
  public unloadDoc(docId: string): void {
    this.clearLinkCache(docId);
    if (this._docSessions.has(docId)) {
      const session = this._docSessions.get(docId)!;
      try {
        session.pageCache.clear();
        for (const [, entry] of session.renderedBitmaps) {
          if (entry.canvas) {
            entry.canvas.width = 1;
            entry.canvas.height = 1;
          }
        }
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
      this.clearBitmapCache();
      this._currentDocId = null;
    }
  }

  /**
   * Cleans up all document instances and caches.
   */
  public destroy() {
    this.clearLinkCache();
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
