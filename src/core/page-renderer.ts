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
  beginEngineNavigation,
  closeEngineDocument,
  engineTileSpec,
  fetchEngineMetrics,
  isEngineStaleError,
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

  // Navigation state for server generation invalidation: bumped on doc /
  // zoom / rotation change and on distant page jumps (>2 pages from anything
  // recently requested). Same-view scrolls reuse the generation so useful
  // queued work survives.
  private navGen = new Map<string, number>();
  private navKey = new Map<string, string>();
  private recentPages = new Map<string, number[]>();

  async renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<void> {
    try {
      await this.renderPageViaEngine(pageIndex, canvas, zoom, rotation);
    } catch (e) {
      // Stale-generation rejections mean a newer navigation owns the canvas:
      // silent abort, no fallback (fallback would paint obsolete content).
      if (isEngineStaleError(e)) return;
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
    // Bounded layout wait: on fresh mount (document open, random-page jump)
    // the render pass can fire before geometry sizes the canvas. Poll for a
    // valid laid-out size (~10 rAF frames, ~500 ms max) instead of failing
    // immediately — a throw here consumes `needsRaster` and the page stays
    // blank with no retry. Past the bound, throw to the existing fallback.
    let cssW = canvas.clientWidth;
    let devW = canvas.width;
    let devH = canvas.height;
    for (let frame = 0; !(cssW > 0 && devW > 0 && devH > 0) && frame < 10; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      // Abort the wait if a newer navigation already owns this canvas.
      if (store.activeDocument?.id !== doc.id || store.zoom !== zoom) return;
      cssW = canvas.clientWidth;
      devW = canvas.width;
      devH = canvas.height;
    }
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
    // Navigation generation: invalidate obsolete server work on jumps and
    // zoom/rotation commits, before requesting this generation's tiles.
    const key = `${zoom.toFixed(4)}|${rotation}`;
    let gen = this.navGen.get(doc.id) ?? 0;
    const recent = this.recentPages.get(doc.id) ?? [];
    const jumped =
      this.navKey.get(doc.id) !== key ||
      (recent.length > 0 && recent.every(p => Math.abs(p - pageIndex) > 2));
    if (jumped) {
      try {
        gen = await beginEngineNavigation(doc.id);
      } catch {
        // Engine without navigation support (or not yet opened): proceed on
        // generation 0; the server treats unknown docs as errors per tile.
        gen = this.navGen.get(doc.id) ?? 0;
      }
      this.navGen.set(doc.id, gen);
      this.navKey.set(doc.id, key);
    }
    recent.push(pageIndex);
    this.recentPages.set(doc.id, recent.slice(-8));
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
    // Priority: 1 visible, 2 entering/adjacent, 4 background rest. The server
    // queue serves lower numbers first and drops stale generations.
    const inViewGrid = new Set<string>();
    const order: Array<{ tx: number; ty: number; prio: number }> = [];
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
        if (inView) inViewGrid.add(`${tx},${ty}`);
        order.push({ tx, ty, prio: inView ? 1 : 4 });
      }
    }
    for (const t of order) {
      if (t.prio !== 1) {
        const adj =
          inViewGrid.has(`${t.tx - 1},${t.ty}`) ||
          inViewGrid.has(`${t.tx + 1},${t.ty}`) ||
          inViewGrid.has(`${t.tx},${t.ty - 1}`) ||
          inViewGrid.has(`${t.tx},${t.ty + 1}`);
        if (adj) t.prio = 2;
      }
    }
    order.sort((a, b) => a.prio - b.prio);
    // Bounded parallelism: tiles are position-independent, so arrival order
    // is irrelevant. 6 in flight keeps the single Rust worker saturated
    // without queue pile-up (Day-3: priority queue + cancellation).
    const CONCURRENCY = 6;
    const t0 = performance.now();
    let drawn = 0;
    let ipcSum = 0;
    let decodeSum = 0;
    for (let i = 0; i < order.length; i += CONCURRENCY) {
      if (!coherent()) return;
      const wave = order.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        wave.map(async ({ tx, ty, prio }) => {
          const spec = engineTileSpec(doc.id, pageIndex, zoom, dpr, rotation, tx, ty);
          const tile = await renderEngineTile(spec, prio, gen);
          return { tx, ty, tile };
        })
      );
      if (!coherent()) {
        results.forEach(r => r.tile.bitmap.close());
        return;
      }
      for (const { tx, ty, tile } of results) {
        ctx.drawImage(tile.bitmap, tx * ENGINE_TILE_PX, ty * ENGINE_TILE_PX);
        ipcSum += tile.ipcMs;
        decodeSum += tile.decodeMs;
        tile.bitmap.close();
        drawn++;
      }
    }
    // TEMPORARY probe: per-page resolve time + segment means (benchmark data).
    // ipc = Rust render+encode+transport; decode = browser PNG decode.
    const n = Math.max(1, drawn);
    console.info(
      `[mupdf] page=${pageIndex} gen=${gen} resolved ${drawn}/${order.length} tiles in ${(performance.now() - t0).toFixed(0)}ms ` +
      `(ipc~${(ipcSum / n).toFixed(0)}ms decode~${(decodeSum / n).toFixed(0)}ms/tile)`
    );
    // TEMPORARY probe: server counters per page (queue/cache/render reality).
    void fetchEngineMetrics(doc.id).then(m => {
      if (!m) return;
      console.info(
        `[mupdf] metrics q=${m.queue_depth} cancelled=${m.queue_cancelled} ` +
        `hit=${(m.cache.hit_rate * 100).toFixed(0)}% evict=${m.cache.evictions} ` +
        `cache=${(m.cache.used_bytes / 1048576).toFixed(1)}MB renders=${m.renders_total} ` +
        `lastTile(rs=${m.last_tile_render_ms} enc=${m.last_tile_encode_ms})ms`
      );
    });
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
