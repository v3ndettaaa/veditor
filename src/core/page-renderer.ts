/**
 * TEMPORARY migration boundary — delete after the MuPDF migration is complete.
 *
 * This module owns the ONLY renderer-kind branch in the viewer. Everything
 * else (mounting, geometry, eviction, annotation repaint) is renderer-agnostic.
 * Removal: delete this file with `core/config.ts` and revert the single
 * delegation call in `VeditorApp.renderVisiblePages` to `pdfEngine`.
 */

import { getRendererKind, type RendererKind } from './config';
import { pdfEngine } from './pdf-engine';
import { store } from './store';
import { viewportManager } from './viewport';
import {
  ENGINE_TILE_PX,
  closeEngineDocument,
  engineTileSpec,
  openEngineDocument,
  renderEngineTile,
} from '../io/engine-tiles';

export interface PageRenderer {
  readonly kind: RendererKind;
  renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<void>;
}

class PdfJsPageRenderer implements PageRenderer {
  readonly kind = 'pdfjs' as const;

  renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<void> {
    return pdfEngine.renderPageToCanvas(pageIndex, canvas, zoom, rotation);
  }
}

/**
 * Rust/MuPDF tile renderer (Day-2 Path B).
 *
 * Renders the page as a grid of 512px engine tiles drawn into the existing
 * `pdfCanvas` (whose backing store the geometry pass already sized). Any
 * engine failure falls back to pdf.js for that page so flag-on without a
 * native backend never blanks the viewer — the fallback is temporary and
 * logs loudly.
 */
class MupdfTileRenderer implements PageRenderer {
  readonly kind = 'mupdf' as const;
  private openedDocs = new Set<string>();
  // In-flight opens, keyed by doc: concurrent page passes must await the
  // SAME open instead of each re-parsing the document (which also wipes the
  // Rust tile cache on every pass). Settles true when this instance opened it.
  private openingDocs = new Map<string, Promise<boolean>>();
  // Last fully-rendered bitmap per page for stale placeholders: backing
  // resizes wipe the canvas before the first new tile arrives, so blit the
  // previous zoom as a stand-in first (same trick as the pdf.js stale blit).
  private lastGood = new Map<number, { canvas: HTMLCanvasElement; docId: string }>();

  async renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<void> {
    try {
      await this.renderPageViaEngine(pageIndex, canvas, zoom, rotation);
    } catch (e) {
      console.warn(`[mupdf] tile render failed for page ${pageIndex}, pdf.js fallback:`, e);
      await pdfEngine.renderPageToCanvas(pageIndex, canvas, zoom, rotation);
    }
  }

  private async renderPageViaEngine(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<void> {
    const doc = store.activeDocument;
    if (!doc) throw new Error('no active document');
    if (!this.openedDocs.has(doc.id)) {
      let opening = this.openingDocs.get(doc.id);
      if (!opening) {
        opening = (async () => {
          const t0 = performance.now();
          const bytes = doc.fileData instanceof Uint8Array ? doc.fileData : undefined;
          // TEMPORARY probe: transfer mode + size (huge JSON byte arrays are
          // a prime startup-freeze suspect when nativeFilePath is absent).
          console.info(
            `[mupdf] open doc=${doc.id} via=${doc.nativeFilePath ? 'path' : `bytes(${(bytes?.length ?? 0)}B)`}`
          );
          await openEngineDocument(doc.id, { path: doc.nativeFilePath, bytes });
          this.openedDocs.add(doc.id);
          console.info(`[mupdf] open doc=${doc.id} took=${(performance.now() - t0).toFixed(0)}ms`);
          return true;
        })();
        this.openingDocs.set(doc.id, opening);
        try {
          await opening;
        } finally {
          if (this.openingDocs.get(doc.id) === opening) this.openingDocs.delete(doc.id);
        }
      } else {
        await opening;
      }
    }
    const cssW = canvas.clientWidth;
    const devW = canvas.width;
    const devH = canvas.height;
    if (!(cssW > 0 && devW > 0 && devH > 0 && zoom > 0)) {
      throw new Error('page canvas has no laid-out size yet');
    }
    // Scale contract (see TileId): devScale IS the final geometry backing
    // multiplier (target-DPI factor already included), so it is the `dpr`
    // the backend expects — do NOT divide by zoom (the backend multiplies
    // zoom*dpr itself; dividing here double-counts and shrinks every tile).
    const devScale = devW / cssW;
    const dpr = devScale;
    // TEMPORARY Day-2 validation probe (delete with the migration flag):
    // proves per render which backend painted and at what scale/grid.
    console.info(
      `[mupdf] page=${pageIndex} zoom=${zoom} devScale=${devScale.toFixed(4)} ` +
      `grid=${Math.ceil(devW / ENGINE_TILE_PX)}x${Math.ceil(devH / ENGINE_TILE_PX)} ` +
      `canvas=${devW}x${devH}`
    );
    const cols = Math.ceil(devW / ENGINE_TILE_PX);
    const rows = Math.ceil(devH / ENGINE_TILE_PX);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    // Stale placeholder: backing resizes wipe the canvas, so paint the last
    // fully-rendered bitmap (previous zoom) scaled to fill before streaming
    // new tiles. A briefly soft image beats a white flash; tiles overwrite it.
    const prev = this.lastGood.get(pageIndex);
    if (!prev || prev.docId !== doc.id) {
      if (prev) this.lastGood.delete(pageIndex);
    } else {
      ctx.drawImage(prev.canvas, 0, 0, devW, devH);
    }
    // Coherence snapshot: render passes routinely race zoom/scroll commits,
    // which resize the canvas and bump store.zoom mid-loop. Drawing tiles
    // from a stale (zoom, size) pair mixes scales on one canvas and trips
    // out-of-bounds fallbacks — abort quietly instead; the newer pass owns
    // the canvas now.
    const snap = { docId: doc.id, zoom, rotation, devW, devH };
    const coherent = () =>
      store.activeDocument?.id === snap.docId &&
      store.zoom === snap.zoom &&
      canvas.width === snap.devW &&
      canvas.height === snap.devH;
    // Progressive replace (no clearRect): keep the previous-zoom pixels
    // visible while new tiles stream in — a briefly stale scale beats a
    // white flash on every zoom step (Day-2 Phase 10 requirement).
    // Visible-first ordering: tiles intersecting the viewport render before
    // off-screen ones, so the visible region resolves in the first wave.
    const vis = viewportManager.getVisibleRectForPage(pageIndex);
    const order: Array<{ tx: number; ty: number; vis: boolean }> = [];
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x0 = tx * ENGINE_TILE_PX;
        const y0 = ty * ENGINE_TILE_PX;
        const inView =
          !vis ||
          (x0 < (vis.x + vis.width) * devScale &&
            x0 + ENGINE_TILE_PX > vis.x * devScale &&
            y0 < (vis.y + vis.height) * devScale &&
            y0 + ENGINE_TILE_PX > vis.y * devScale);
        order.push({ tx, ty, vis: inView });
      }
    }
    order.sort((a, b) => Number(!a.vis) - Number(!b.vis));
    // Bounded parallelism: tiles are position-independent, so arrival order
    // is irrelevant. 6 in flight keeps the single Rust worker saturated
    // without queue pile-up (Day-3: priority queue + cancellation).
    const CONCURRENCY = 6;
    const t0 = performance.now();
    let drawn = 0;
    for (let i = 0; i < order.length; i += CONCURRENCY) {
      if (!coherent()) return;
      const wave = order.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        wave.map(async ({ tx, ty }) => {
          const spec = engineTileSpec(doc.id, pageIndex, zoom, dpr, rotation, tx, ty);
          const tile = await renderEngineTile(spec);
          return { tx, ty, tile };
        })
      );
      if (!coherent()) {
        results.forEach(r => r.tile.bitmap.close());
        return;
      }
      for (const { tx, ty, tile } of results) {
        ctx.drawImage(tile.bitmap, tx * ENGINE_TILE_PX, ty * ENGINE_TILE_PX);
        tile.bitmap.close();
        drawn++;
      }
    }
    // TEMPORARY probe: per-page resolve time (benchmark data).
    console.info(`[mupdf] page=${pageIndex} resolved ${drawn}/${order.length} tiles in ${(performance.now() - t0).toFixed(0)}ms`);
    // Snapshot for the next render's stale placeholder (only complete,
    // coherent renders qualify — aborted passes must not poison it).
    if (drawn === order.length && order.length > 0 && coherent()) {
      let snap = this.lastGood.get(pageIndex);
      if (!snap || snap.canvas.width !== devW || snap.canvas.height !== devH) {
        const c = document.createElement('canvas');
        c.width = devW;
        c.height = devH;
        this.lastGood.set(pageIndex, { canvas: c, docId: doc.id });
        snap = { canvas: c, docId: doc.id };
      }
      const sctx = snap.canvas.getContext('2d');
      if (sctx) sctx.drawImage(canvas, 0, 0);
      // Bound memory: full-page bitmaps are MBs each; keep only recent ones.
      while (this.lastGood.size > 8) {
        const oldest = this.lastGood.keys().next();
        if (oldest.done) break;
        this.lastGood.delete(oldest.value);
      }
    }
  }

  /** Drop engine documents on tab close (best-effort; engine also GCs). */
  voidClose(docId: string): void {
    if (this.openedDocs.delete(docId)) {
      void closeEngineDocument(docId);
    }
  }
}

// Module singletons: getPageRenderer() is called per page per pass, so fresh
// instances would re-open the engine document every pass (full re-parse +
// cache wipe + owner-thread churn). Singletons keep openedDocs alive.
const pdfJsRenderer = new PdfJsPageRenderer();
const mupdfRenderer = new MupdfTileRenderer();

export function getPageRenderer(): PageRenderer {
  if (getRendererKind() === 'mupdf') {
    return mupdfRenderer;
  }
  return pdfJsRenderer;
}
