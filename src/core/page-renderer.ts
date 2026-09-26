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
  isEngineStaleError,
  openEngineDocument,
  renderEngineTile,
  type EngineTile,
} from '../io/engine-tiles';

/**
 * Day-4 zoom smoothness, TUNABLE: longest side (px) of a last-good snapshot.
 * Placeholders are drawn scaled to the live backing size, so a capped copy
 * stays visually useful while bounding memory (an uncapped zoom-8 snapshot is
 * ~4665x6144 ≈ 115 MB). Raise if placeholders look soft at 100–1600% zoom.
 */
const LASTGOOD_MAX_DIM = 1600;

export interface PageRenderer {
  readonly kind: RendererKind;
  /**
   * Day-6 stranded-rest re-arm seam (MuPDF only). Invoked exactly once when a
   * deferred-rest batch aborts as stale — the page's rest tiles were never
   * requested by anyone, so without a re-arm it stays white until an
   * unrelated scroll/zoom schedules a pass. Optional; null/absent = no owner.
   */
  onDeferredRestStale?: ((pageIndex: number) => void) | null;
  /**
   * Render one page. Returns true when the call is terminal for this pass
   * (painted, fell back, or superseded). Returns false ONLY for a transient
   * "not ready yet" state (e.g. canvas without layout on fresh mount) — the
   * caller should re-arm `needsRaster` and schedule one more pass instead of
   * leaving the page blank.
   */
  renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<boolean>;
}

class PdfJsPageRenderer implements PageRenderer {
  readonly kind = 'pdfjs' as const;

  async renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<boolean> {
    await pdfEngine.renderPageToCanvas(pageIndex, canvas, zoom, rotation);
    return true;
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
  onDeferredRestStale: ((pageIndex: number) => void) | null = null;
  private openedDocs = new Set<string>();
  // In-flight opens, keyed by doc: concurrent page passes must await the
  // SAME open instead of each re-parsing the document (which also wipes the
  // Rust tile cache on every pass). Settles true when this instance opened it.
  private openingDocs = new Map<string, Promise<boolean>>();
  // Last fully-rendered bitmap per page for stale placeholders: backing
  // resizes wipe the canvas before the first new tile arrives, so blit the
  // previous zoom as a stand-in first (same trick as the pdf.js stale blit).
  private lastGood = new Map<number, { canvas: HTMLCanvasElement; docId: string; rotation: number }>();

  // Navigation state for server generation invalidation: bumped on doc /
  // zoom / rotation change and on distant page jumps (>2 pages from anything
  // recently requested). Same-view scrolls reuse the generation so useful
  // queued work survives.
  private navGen = new Map<string, number>();
  private navKey = new Map<string, string>();
  private recentPages = new Map<string, number[]>();
  // Deferred rest-tile timers per page (gesture-aware deferral): a new pass
  // for the page cancels its pending timer — the new pass owns the remainder.
  private deferredTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Render deferred rest tiles after a quiet period; drops silently unless
   * the snapshot (doc/zoom/rotation/renderer/canvas size) still matches, in
   * which case the settled pass (not this one) owns coverage. */
  private async renderDeferredRest(
    snap: {
      docId: string;
      pageIndex: number;
      zoom: number;
      rotation: number;
      renderer: RendererKind;
      dpr: number;
      devW: number;
      devH: number;
      gen: number;
      rest: Array<{ tx: number; ty: number; prio: number }>;
      canvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      t0: number;
    }
  ): Promise<void> {
    const { docId, pageIndex, zoom, rotation, renderer, dpr, devW, devH, gen, rest, canvas, ctx } = snap;
    // Day-4: detached (evicted) canvases must not draw or poison lastGood.
    // Day-5: a renderer switch aborts deferred batches (stale paint guard);
    // a newer rotation does too (older orientation must never paint over).
    if (
      !canvas.isConnected ||
      store.activeDocument?.id !== docId ||
      store.zoom !== zoom ||
      (store.pageRotations[pageIndex] || 0) !== rotation ||
      getRendererKind() !== renderer ||
      canvas.width !== devW ||
      canvas.height !== devH
    ) {
      return;
    }
    let drawn = 0;
    for (let i = 0; i < rest.length; i += 6) {
      if (
        !canvas.isConnected ||
        store.activeDocument?.id !== docId ||
        store.zoom !== zoom ||
        (store.pageRotations[pageIndex] || 0) !== rotation ||
        getRendererKind() !== renderer ||
        canvas.width !== devW ||
        canvas.height !== devH
      ) {
        return;
      }
      const wave = rest.slice(i, i + 6);
      let results: Array<{ tx: number; ty: number; tile: EngineTile }>;
      try {
        results = await Promise.all(
          wave.map(async ({ tx, ty, prio }) => {
            const spec = engineTileSpec(docId, pageIndex, zoom, dpr, rotation, tx, ty);
            const tile = await renderEngineTile(spec, prio, gen);
            return { tx, ty, tile };
          })
        );
      } catch (e) {
        // Day-4: a newer navigation invalidates this deferred batch mid-flight
        // (the standard case mid-cascade). Quiet abort — the newer pass
        // re-requested vis and deferred its own rest, so coverage converges.
        // Never throw: this runs in a bare setTimeout, where a rejection is
        // both an unhandled error and silently lost rest tiles.
        if (isEngineStaleError(e)) {
          // Day-6 stranded rest: no pass will ever request these tiles, so
          // hand the page back to the normal scheduling path (no retry here,
          // no generation refresh — the next pass re-derives everything).
          this.onDeferredRestStale?.(pageIndex);
          return;
        }
        console.warn(`[mupdf] deferred rest failed for page ${pageIndex}:`, e);
        return;
      }
      if (
        !canvas.isConnected ||
        store.activeDocument?.id !== docId ||
        store.zoom !== zoom ||
        (store.pageRotations[pageIndex] || 0) !== rotation ||
        getRendererKind() !== renderer ||
        canvas.width !== devW ||
        canvas.height !== devH
      ) {
        results.forEach(r => r.tile.bitmap.close());
        return;
      }
      for (const { tx, ty, tile } of results) {
        ctx.drawImage(tile.bitmap, tx * ENGINE_TILE_PX, ty * ENGINE_TILE_PX);
        tile.bitmap.close();
        drawn++;
      }
    }
    this.snapshotLastGood(pageIndex, docId, canvas, devW, devH, rotation);
  }

  /** Shareable last-good snapshot (complete coherent renders only). */
  private snapshotLastGood(
    pageIndex: number,
    docId: string,
    canvas: HTMLCanvasElement,
    devW: number,
    devH: number,
    rotation: number
  ): void {
    // Capped copy: placeholders draw scaled, so half-res+ is fine and memory
    // stays bounded regardless of zoom (see LASTGOOD_MAX_DIM).
    const snapScale = Math.min(1, LASTGOOD_MAX_DIM / Math.max(1, Math.max(devW, devH)));
    const sw = Math.max(1, Math.round(devW * snapScale));
    const sh = Math.max(1, Math.round(devH * snapScale));
    let s = this.lastGood.get(pageIndex);
    if (!s || s.canvas.width !== sw || s.canvas.height !== sh || s.docId !== docId || s.rotation !== rotation) {
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      this.lastGood.set(pageIndex, { canvas: c, docId, rotation });
      s = { canvas: c, docId, rotation };
    }
    const sctx = s.canvas.getContext('2d');
    if (sctx) sctx.drawImage(canvas, 0, 0, sw, sh);
    while (this.lastGood.size > 8) {
      const oldest = this.lastGood.keys().next();
      if (oldest.done) break;
      this.lastGood.delete(oldest.value);
    }
  }

  // Day-4 zoom smoothness: identical concurrent renders (same doc/page/zoom/
  // rotation/canvas) share one flight — rapid commit passes otherwise render
  // the same page 2-4x concurrently (measured dedup=144 tile storms). Keyed
  // by canvas identity so a remounted canvas still renders; cleared in
  // `finally` so failures and stale-abort retries re-enter normally.
  private inflightRenders = new Map<string, HTMLCanvasElement>();

  async renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<boolean> {
    const docId = store.activeDocument?.id;
    const flightKey = `${docId}|${pageIndex}|${zoom.toFixed(4)}|${rotation}`;
    if (docId && this.inflightRenders.get(flightKey) === canvas) return true;
    if (docId) this.inflightRenders.set(flightKey, canvas);
    try {
      const ready = await this.renderPageViaEngine(pageIndex, canvas, zoom, rotation);
      // Transient "canvas not laid out yet": ask the caller for another pass
      // instead of consuming this one (a throw here would leave the page
      // blank with no retry — the measured fresh-open/random-jump blanks).
      if (!ready) return false;
    } catch (e) {
      // Stale-generation rejections mean a newer navigation began mid-render:
      // re-arm (false) instead of reporting success, so the bounded retry in
      // the caller re-renders the page. Returning true here consumed
      // `needsRaster` and left partially-drawn pages blank/partial forever on
      // the same zoom. The retry's same-canvas check dedups against a newer
      // pass that already owns the canvas.
      if (isEngineStaleError(e)) return false;
      // Day-5: the document may have been closed mid-render — never run the
      // pdf.js fallback onto a canvas whose document is gone (the close path
      // owns cleanup; painting here would only resurrect detached content).
      if (!docId || !store.openDocuments.has(docId)) return true;
      console.warn(`[mupdf] tile render failed for page ${pageIndex}, pdf.js fallback:`, e);
      try {
        await pdfEngine.renderPageToCanvas(pageIndex, canvas, zoom, rotation);
      } catch (e2) {
        // Both paths failed (e.g. transient mount + broken JPX fallback):
        // terminal for this pass — a later scroll/zoom pass retries naturally.
        console.warn(`[mupdf] pdf.js fallback also failed for page ${pageIndex}:`, e2);
      }
      return true;
    } finally {
      if (docId && this.inflightRenders.get(flightKey) === canvas) {
        this.inflightRenders.delete(flightKey);
      }
    }
    return true;
  }

  private async renderPageViaEngine(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    zoom: number,
    rotation: number
  ): Promise<boolean> {
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
    // valid laid-out size (~10 rAF frames, ~500 ms max) and report transient
    // (false) so the caller schedules another pass — a throw here would
    // consume `needsRaster` and leave the page blank with no retry.
    let cssW = canvas.clientWidth;
    let devW = canvas.width;
    let devH = canvas.height;
    for (let frame = 0; !(cssW > 0 && devW > 0 && devH > 0) && frame < 10; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      // A newer navigation owns this canvas now: terminal, do NOT retry old
      // zoom/rotation (the newer pass paints). The rotation check closes the
      // rapid-rotation hole where a superseded pass snapshots the already
      // resized canvas and paints stale-orientation tiles over the new ones.
      if (store.activeDocument?.id !== doc.id || store.zoom !== zoom ||
          (store.pageRotations[pageIndex] || 0) !== rotation) return true;
      cssW = canvas.clientWidth;
      devW = canvas.width;
      devH = canvas.height;
    }
    if (!(cssW > 0 && devW > 0 && devH > 0 && zoom > 0)) {
      return false;
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
    // Day-4: capture whether this pass changed zoom/rotation before the jump
    // block refreshes navKey — a change means older queued server work is
    // obsolete and gets invalidated below.
    const zoomCommit = this.navKey.get(doc.id) !== key;
    const jumped =
      zoomCommit ||
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
      // Day-5 rotation polish (cosmetic only): when the snapshot predates a
      // ±90° rotation, paint it rotated into the new geometry instead of
      // stretching the old orientation (transient wide/soft flash). 0°/180°
      // draw as before. Tiles overwrite the placeholder within ~a second.
      const delta = ((rotation - (prev.rotation ?? rotation)) % 360 + 360) % 360;
      if (delta === 90 || delta === 270) {
        ctx.save();
        ctx.translate(devW / 2, devH / 2);
        ctx.rotate((delta * Math.PI) / 180);
        ctx.drawImage(prev.canvas, -devH / 2, -devW / 2, devH, devW);
        ctx.restore();
      } else {
        ctx.drawImage(prev.canvas, 0, 0, devW, devH);
      }
    }
    // Coherence snapshot: render passes routinely race zoom/scroll/rotation
    // commits, which resize the canvas and bump store.zoom mid-loop. Drawing
    // tiles from a stale (zoom, rotation, size) tuple mixes orientations on
    // one canvas — abort quietly instead; the newer pass owns the canvas now.
    // The rotation axis closes the rapid-rotation hole (older rotation must
    // never paint over a newer one); canvas dims alone cannot catch it when
    // the superseding pass resized the canvas before this pass woke up.
    const snap = { docId: doc.id, zoom, rotation, devW, devH, renderer: getRendererKind() };
    const coherent = () =>
      store.activeDocument?.id === snap.docId &&
      store.zoom === snap.zoom &&
      (store.pageRotations[pageIndex] || 0) === snap.rotation &&
      getRendererKind() === snap.renderer &&
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
        // Day-4: a null vis means genuinely off-viewport (buffer page) — the
        // whole grid stays background priority so prefetch never competes
        // with on-screen tiles in the single Rust worker. The previous `!vis`
        // fallback rendered full 35-tile grids at top priority (measured
        // firstVis 3-8s). When the page scrolls into view a new pass
        // re-requests with a fresh vis.
        const inView =
          vis !== null &&
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
    // A new pass supersedes any deferred remainder for this page: cancel it
    // (the new pass re-requests what is still needed, or re-defers).
    const pendingTimer = this.deferredTimers.get(pageIndex);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      this.deferredTimers.delete(pageIndex);
    }
    // Day-4 vis-first policy: EVERY pass requests visible + adjacent tiles
    // now and defers background rest until 300 ms of quiet. A single MuPDF
    // worker serializes all tiles, so any rest work requested up front delays
    // visible pixels (measured fresh-open firstVis 4570ms behind 105 queued
    // tiles). Fully off-screen pages (no prio<=2 tile) defer their whole grid
    // — prefetch is preserved, it just never competes with visible work. A
    // newer pass cancels the pending timer and re-defers; the settled state
    // always converges because quiet always comes.
    let requestOrder = order;
    {
      const now = order.filter(t => t.prio <= 2);
      const rest = order.filter(t => t.prio > 2);
      if (rest.length > 0 && (now.length > 0 || rest.length === order.length)) {
        const snapDefer = {
          docId: doc.id,
          pageIndex,
          zoom,
          rotation,
          renderer: getRendererKind(),
          dpr,
          devW,
          devH,
          gen,
          rest,
          canvas,
          ctx,
          t0: performance.now(),
        };
        const timer = setTimeout(() => {
          this.deferredTimers.delete(pageIndex);
          void this.renderDeferredRest(snapDefer);
        }, 300);
        this.deferredTimers.set(pageIndex, timer);
        requestOrder = now;
      }
    }
    // Bounded parallelism: tiles are position-independent, so arrival order
    // is irrelevant. 6 in flight keeps the single Rust worker saturated
    // without queue pile-up (Day-3: priority queue + cancellation).
    const CONCURRENCY = 6;
    let drawn = 0;
    for (let i = 0; i < requestOrder.length; i += CONCURRENCY) {
      // Superseded mid-loop: terminal (a newer pass owns the canvas).
      if (!coherent()) return true;
      const wave = requestOrder.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        wave.map(async ({ tx, ty, prio }) => {
          const spec = engineTileSpec(doc.id, pageIndex, zoom, dpr, rotation, tx, ty);
          const tile = await renderEngineTile(spec, prio, gen);
          return { tx, ty, prio, tile };
        })
      );
      if (!coherent()) {
        results.forEach(r => r.tile.bitmap.close());
        return true;
      }
      for (const { tx, ty, tile } of results) {
        ctx.drawImage(tile.bitmap, tx * ENGINE_TILE_PX, ty * ENGINE_TILE_PX);
        tile.bitmap.close();
        drawn++;
      }
    }
    // Snapshot for the next render's stale placeholder (only complete,
    // coherent renders qualify — aborted passes must not poison it).
    // NOTE: a pass that deferred its rest still snapshots: the visible part
    // is complete and coherent, and the deferred remainder overwrites the
    // snapshot when it lands.
    if (drawn === requestOrder.length && requestOrder.length > 0 && coherent()) {
      this.snapshotLastGood(pageIndex, doc.id, canvas, devW, devH, rotation);
    }
    return true;
  }

  /**
   * Day-5: release ALL document-scoped engine state on tab close / document
   * removal. Rust side (registry entry, bytes, MuPDF ownership, tile cache,
   * render queue) via closeEngineDocument; TS side generations, nav keys,
   * recent pages, open tracking, and this doc's last-good snapshots.
   * Deferred timers and in-flight renders carry the doc id and abort on
   * mismatch, so they need no purge — and purging them by page index could
   * touch another open document's state. Safe to call for docs never opened
   * in the engine (all deletes no-op; the command tolerates unknown ids).
   */
  closeDocument(docId: string): void {
    this.openedDocs.delete(docId);
    this.openingDocs.delete(docId);
    this.navGen.delete(docId);
    this.navKey.delete(docId);
    this.recentPages.delete(docId);
    for (const [pageIndex, snap] of this.lastGood) {
      if (snap.docId === docId) this.lastGood.delete(pageIndex);
    }
    void closeEngineDocument(docId);
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

/**
 * Day-6: register the stranded-rest re-arm callback on the MuPDF singleton
 * directly. (getPageRenderer() returns whichever kind is current — at startup
 * that is Legacy — so registering through it would miss the MuPDF instance.)
 */
export function onMupdfDeferredRestStale(cb: ((pageIndex: number) => void) | null): void {
  mupdfRenderer.onDeferredRestStale = cb;
}

/**
 * Day-5: release all engine-side and renderer-side state for a closed or
 * removed document (Rust registry entry, bytes, cache, queue, generations,
 * snapshots, open tracking). Safe for documents never opened in the engine.
 */
export function releaseEngineDocument(docId: string): void {
  mupdfRenderer.closeDocument(docId);
}
