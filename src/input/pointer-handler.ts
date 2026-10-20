/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType, ToolOptionKey, Annotation, BoundingBox, ShapeAnnotation, TextAnnotation, StickyNoteAnnotation, StickyNoteStroke } from '../core/types';
import { store } from '../core/store';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ReplaceAnnotationsCommand, BulkModifyCommand, ModifyAnnotationCommand } from '../core/history';
import { mergeBoundingBoxes, computePointsBoundingBox, findNearestVertex, distance, distanceToSegment } from '../utils/geometry';
import { resolveAdaptiveCanvasDpr } from '../utils/dpi';
import { fitStroke, type FittedShape } from '../utils/shape-fit';
import { renderLiveStroke } from '../annotations/spline';
import { tween, easeOutCubic, type TweenHandle } from '../utils/tween';
import { annotationEngine } from '../annotations/engine';
import { PressureEngine } from './pressure';
import { palmRejection } from './palm-rejection';
import { penTool } from '../annotations/tools/pen';
import { highlighterTool } from '../annotations/tools/highlighter';
import { eraserTool } from '../annotations/tools/eraser';
import { shapesTool } from '../annotations/tools/shapes';
import { textTool } from '../annotations/tools/text';
import { stickyNoteTool } from '../annotations/tools/sticky-note';
import { stampTool } from '../annotations/tools/stamp';
import { measureTool } from '../annotations/tools/measure';
import { redactionTool } from '../annotations/tools/redaction';
import {
  selectionManager,
  normalizeDragBox,
  cloneAnnotation,
  transformAnnotation,
  rotatePoint,
  boxCenter,
  BoxTransform,
  HandleType,
  getAnnotationSelectionBox,
  moveAnnotationEndpoint
} from '../annotations/selection';
import { floatingPropsBar } from '../ui/components/floating-props';
import { openInlineEditor } from '../ui/components/inline-editor';

export class PointerHandler {
  private _isPointerDown: boolean = false;
  private _activePageIndex: number = -1;
  private _pageScratchCanvas: HTMLCanvasElement | null = null;
  private _pageScratchCtx: CanvasRenderingContext2D | null = null;
  /** Cached bounding rect for the active scratchpad canvas during a stroke to avoid layout reflows on 240Hz pointermove. */
  private _activeCanvasRect: DOMRect | null = null;
  /** Last painted device-pixel bounding box on the scratchpad for O(1) dirty-rect clearing. */
  private _scratchDirtyRect: BoundingBox | null = null;
  /** Coalesced rAF id for live pen/highlighter scratchpad rendering. */
  private _scratchRafId: number | null = null;
  private _lastPointerTime: number = 0;
  private _lastPointerX: number = 0;
  private _lastPointerY: number = 0;
  private _simulatedVelocityPressure: number = 0.5;
  /**
   * Effective tool for the in-progress stroke (may differ from
   * `store.activeTool` when the stylus inverted tail auto-selects eraser).
   * Using the latched value in move/up fixes pen-drawn-instead-of-erased
   * strokes with hardware eraser tips.
   */
  private _strokeTool: ToolType | null = null;
  /**
   * Live eraser session: original page annotations at stroke start. Moves
   * mutate the document directly with zero history/notify cost for instant
   * feedback; pointer-up commits ONE undo step for the whole drag.
   */
  private _eraserSession: { pageIndex: number; original: Annotation[] } | null = null;
    /**
   * Selection drag: moving the selection body or resizing via a transform
   * handle. Mutates live (like the eraser) and commits ONE undo step.
   */
  private _selectDrag: {
    mode: 'move' | 'resize' | 'rotate';
    handle: Exclude<HandleType, null>;
    pageIndex: number;
    originals: Map<string, Annotation>;
    merged: BoundingBox;
    startPt: Point;
  } | null = null;
  /** Region-marquee rubber band (Shift extends the selection). */
  private _marquee: { pageIndex: number; start: Point; current: Point; additive: boolean } | null = null;
  /** Freehand lasso path (the Lasso tool, or Alt+drag in Select). */
  private _lasso: { pageIndex: number; points: Point[]; additive: boolean } | null = null;
  /** Drag-to-size or click-to-place state when creating a new Sticky Note. */
  private _stickyCreateDrag: { pageIndex: number; start: Point; current: Point } | null = null;
  /** Tracks active polygon creation inside an expanded Sticky Note mini-board. */
  private _activeStickyPolygonNoteId: string | null = null;
  /** Active in-note tool session (pen, highlighter, eraser, or shape) clipped to an expanded Sticky Note. */
  private _activeStickyStroke: {
    pageIndex: number;
    noteId: string;
    mode: 'pen' | 'highlighter' | 'eraser' | 'shape';
    shapeTool?: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';
    points: StrokePoint[];
    color: string;
    strokeWidth: number;
    opacity?: number;
    pressureEnabled?: boolean;
    pressureCurve?: 'linear' | 'soft' | 'firm' | 'exponential';
    pressureStrength?: 'light' | 'balanced' | 'strong';
    smoothing?: 'none' | 'subtle' | 'medium' | 'high' | 'light' | 'heavy';
    blendMode?: 'multiply' | 'source-over';
    tipShape?: 'round' | 'chisel';
    straightLine?: boolean;
    originalNote: StickyNoteAnnotation;
  } | null = null;
  /** Tracks whether a collapsed sticky note was already selected before pointerdown in Select mode. */
  private _wasCollapsedNoteSelectedOnDown: string | null = null;

  /**
   * Draw-and-hold shape recognition (pen only): holding the pointer nearly
   * still briefly snaps the live stroke to a geometric primitive on lift.
   * Never runs on the move hot path — one timer, one fit per hold.
   */
  private _holdTimer: number | null = null;
  private _holdAnchor: Point | null = null;
  private _holdFired: boolean = false;
  private _holdShape: FittedShape | null = null;
  /** In-flight raw-ink -> fitted-shape crossfade on the scratch canvas. */
  private _morphHandle: TweenHandle | null = null;
  /** Vertex the active shape/polygon point is currently magnet-snapped to. */
  private _snapTarget: Point | null = null;
  private static readonly HOLD_DELAY_MS = 320;
  /** Settle-in duration for the recognized shape. */
  private static readonly MORPH_MS = 220;
  private static readonly HOLD_RADIUS = 8;
  private static readonly HOLD_MIN_SIZE = 12;

  /** Returns the base width unchanged (zoom-lens compensation removed). */
  private lensWidth(base: number): number {
    return base;
  }

  /**
   * Selects a newly created annotation while keeping transient panels closed.
   * Transform handles still appear; inspector/sidebar state is untouched.
   */
  private selectCreatedAnnotation(id: string): void {
    store.setSuppressAutoPanels(true);
    try {
      store.selectAnnotation(id);
    } finally {
      store.setSuppressAutoPanels(false);
      floatingPropsBar?.hideForProgrammaticSelection();
    }
  }

  private _scratchNeedsTrailingPaint: boolean = false;

  /**
   * Resolves the active visual rendering canvas for live strokes. When a page
   * is at high zoom and its High-DPI viewport scratchpad chunk (`_chunkCanvas`)
   * is active, live strokes render onto that viewport-clipped canvas at 100%
   * native display DPI while `scratchCanvas` remains the full-page event target.
   */
  private resolveRenderScratchCanvas(scratchCanvas: HTMLCanvasElement): HTMLCanvasElement {
    const chunk = (scratchCanvas as HTMLCanvasElement & { _chunkCanvas?: HTMLCanvasElement })._chunkCanvas;
    if (chunk && chunk.style.display === 'block' && chunk.width > 1 && chunk.height > 1) {
      return chunk;
    }
    return scratchCanvas;
  }

  /**
   * Applies the viewport-chunk pixel offset (`-offsetX * dpr, -offsetY * dpr`)
   * when rendering onto a High-DPI viewport scratchpad chunk. No-op on a
   * standard full-page scratchpad.
   */
  private withScratchOffset(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement | null,
    fn: () => void
  ): void {
    const ox = canvas ? parseFloat(canvas.dataset.offsetX || '0') : 0;
    const oy = canvas ? parseFloat(canvas.dataset.offsetY || '0') : 0;
    if ((ox !== 0 || oy !== 0) && Number.isFinite(ox) && Number.isFinite(oy)) {
      const dpr = this.renderDpr();
      ctx.save();
      ctx.translate(-ox * dpr, -oy * dpr);
      try {
        fn();
      } finally {
        ctx.restore();
      }
    } else {
      fn();
    }
  }

  /**
   * Exact backing-store multiplier matching the page canvases (`c.width / cssW`).
   * Guarantees 100% pixel identity between live scratchpad strokes and committed
   * annotations at every zoom level (20% to 800%), even when the canvas backing
   * store is capped by the adaptive VRAM budget.
   */
  private renderDpr(): number {
    const c = this._pageScratchCanvas;
    if (!c) return resolveAdaptiveCanvasDpr(612, 792, store.appSettings.targetDPI);
    const cssW = parseFloat(c.dataset.baseWidth || '') || parseFloat(c.style.width) || c.clientWidth || c.width;
    if (cssW > 0 && c.width > 1) {
      return c.width / cssW;
    }
    const cssH = parseFloat(c.dataset.baseHeight || '') || parseFloat(c.style.height) || c.clientHeight || c.height;
    return resolveAdaptiveCanvasDpr(cssW, cssH, store.appSettings.targetDPI);
  }

  /** Clears either the dirty sub-rectangle or the full scratchpad canvas. */
  private clearScratchpadDirty(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const d = this._scratchDirtyRect;
    if (d) {
      const x = Math.max(0, Math.floor(d.x) - 2);
      const y = Math.max(0, Math.floor(d.y) - 2);
      const w = Math.min(canvas.width - x, Math.ceil(d.width) + 4);
      const h = Math.min(canvas.height - y, Math.ceil(d.height) + 4);
      if (w > 0 && h > 0) {
        ctx.clearRect(x, y, w, h);
      }
      this._scratchDirtyRect = null;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  private setScratchpadDirtyFromPageBox(pageBox: BoundingBox | null, renderScale: number): void {
    if (!pageBox) {
      this._scratchDirtyRect = null;
      return;
    }
    const cv = this._pageScratchCanvas;
    const ox = cv ? parseFloat(cv.dataset.offsetX || '0') : 0;
    const oy = cv ? parseFloat(cv.dataset.offsetY || '0') : 0;
    const dpr = this.renderDpr();
    this._scratchDirtyRect = {
      x: pageBox.x * renderScale - ox * dpr,
      y: pageBox.y * renderScale - oy * dpr,
      width: pageBox.width * renderScale,
      height: pageBox.height * renderScale
    };
  }

  private cancelScratchRaf(): void {
    if (this._scratchRafId !== null) {
      cancelAnimationFrame(this._scratchRafId);
      this._scratchRafId = null;
    }
    this._scratchNeedsTrailingPaint = false;
  }

  /**
   * Geometry vertices already on the page that a new shape point can snap to:
   * line/arrow/polygon/freeform points plus rectangle/redaction corners.
   */
  private collectShapeVertices(pageIndex: number): Point[] {
    const doc = store.activeDocument;
    if (!doc) return [];
    const out: Point[] = [];
    for (const a of (doc.annotations[pageIndex] || [])) {
      if (a.type === 'line' || a.type === 'arrow' || a.type === 'polygon' || a.type === 'freeform-shape') {
        const pts = (a as { points?: Point[] }).points;
        if (pts) for (const p of pts) out.push({ x: p.x, y: p.y });
      } else if (a.type === 'rectangle' || a.type === 'redaction') {
        const b = a.box;
        out.push(
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
          { x: b.x, y: b.y + b.height }
        );
      }
    }
    return out;
  }

  /**
   * Magnetic vertex snapping: binds `pt` to a nearby existing vertex and
   * records it for the on-canvas target indicator. Tolerance is screen-space
   * (8 CSS px) so it feels the same at every zoom.
   */
  private snapToVertex(pt: Point, pageIndex: number): Point {
    const tolPage = 8 / Math.max(store.zoom, 0.0001);
    const hit = findNearestVertex(pt, this.collectShapeVertices(pageIndex), tolPage);
    this._snapTarget = hit;
    return hit ?? pt;
  }

  /**
   * Merges a freshly drawn line/arrow with any existing line/arrow that shares
   * an endpoint (transitively), producing one open multi-point path. Returns
   * null when nothing connects.
   */
  private tryConnectLines(
    pageIndex: number,
    ann: ShapeAnnotation
  ): { remove: Annotation[]; add: ShapeAnnotation } | null {
    const doc = store.activeDocument;
    if (!doc || !ann.points || ann.points.length < 2) return null;
    const tol = 8 / Math.max(store.zoom, 0.0001);
    const candidates = (doc.annotations[pageIndex] || []).filter(a =>
      (a.type === 'line' || a.type === 'arrow') &&
      Array.isArray((a as ShapeAnnotation).points) &&
      (a as ShapeAnnotation).points!.length >= 2
    ) as ShapeAnnotation[];
    if (candidates.length === 0) return null;

    const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    let chain: Point[] = ann.points.map(p => ({ x: p.x, y: p.y }));
    const connected: ShapeAnnotation[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of candidates) {
        if (connected.includes(c) || !c.points) continue;
        const pts = c.points;
        const a0 = pts[0];
        const a1 = pts[pts.length - 1];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (dist(a0, tail) <= tol) {
          chain = chain.concat(pts.slice(1).map(p => ({ x: p.x, y: p.y })));
          connected.push(c); changed = true;
        } else if (dist(a1, tail) <= tol) {
          chain = chain.concat(pts.slice(0, -1).reverse().map(p => ({ x: p.x, y: p.y })));
          connected.push(c); changed = true;
        } else if (dist(a1, head) <= tol) {
          chain = pts.slice(0, -1).map(p => ({ x: p.x, y: p.y })).concat(chain);
          connected.push(c); changed = true;
        } else if (dist(a0, head) <= tol) {
          chain = pts.slice(1).reverse().map(p => ({ x: p.x, y: p.y })).concat(chain);
          connected.push(c); changed = true;
        }
      }
    }
    if (connected.length === 0) return null;

    const merged: ShapeAnnotation = {
      ...ann,
      id: Math.random().toString(36).substring(2, 9),
      type: 'line',
      points: chain,
      box: computePointsBoundingBox(chain, ann.strokeWidth),
      arrowEnd: false,
      updatedAt: Date.now()
    };
    return { remove: connected, add: merged };
  }

  /** Draws the magnetic snap target as a screen-constant ring. */
  private renderSnapTarget(ctx: CanvasRenderingContext2D, renderScale: number): void {
    const target = this._snapTarget;
    if (!target) return;
    ctx.save();
    ctx.scale(renderScale, renderScale);
    const r = 6 / Math.max(store.zoom, 0.0001);
    ctx.beginPath();
    ctx.arc(target.x, target.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5 / Math.max(store.zoom, 0.0001);
    ctx.stroke();
    ctx.restore();
  }

  /** (Re)starts the draw-and-hold snap timer anchored at the given point. */
  private startHoldTimer(anchor: Point): void {
    this.clearHoldTimer();
    this._holdAnchor = { ...anchor };
    this._holdTimer = window.setTimeout(() => this.onHoldFire(), PointerHandler.HOLD_DELAY_MS);
  }

  private clearHoldTimer(): void {
    if (this._holdTimer !== null) {
      window.clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    this._holdAnchor = null;
  }

  /** Fires while the pointer is still down: fits the live stroke once. */
  private onHoldFire(): void {
    this._holdTimer = null;
    if (!this._isPointerDown || (this._strokeTool ?? store.activeTool) !== 'pen') return;
    if (this._holdFired) return;
    const pts = penTool.getActivePoints();
    if (pts.length < 8) return;
    const box = computePointsBoundingBox([...pts]);
    const minSizePage = PointerHandler.HOLD_MIN_SIZE / Math.max(store.zoom, 0.25);
    if (Math.hypot(box.width, box.height) < minSizePage) return;
    const fit = fitStroke(pts.map(p => ({ x: p.x, y: p.y })));
    if (!fit) return;
    this._holdFired = true;
    this._holdShape = fit;
    const canvas = this._pageScratchCanvas;
    const ctx = this._pageScratchCtx;
    if (!ctx || !canvas) return;
    const preview = this.buildHoldShapeAnnotation(fit, this._activePageIndex, 'layer-default');
    if (!preview) return;

    const renderScale = store.zoom * this.renderDpr();
    const rawPts: StrokePoint[] = penTool.getActivePoints().map(p => ({ ...p }));
    const rawColor = store.toolSettings.penColor;
    const rawWidth = this.lensWidth(store.toolSettings.penWidth);
    // The fading ink has to reproduce the live stroke exactly — same pressure
    // model — or the ribbon visibly changes width the instant the hold fires.
    const rawCurve = store.toolSettings.pressureCurve;
    const rawPressure = store.toolSettings.pressureSensitivityEnabled !== false;
    const rawStrength = store.toolSettings.pressureStrength;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Recognition feedback: the fitted shape "settles" into place — it fades
    // in while relaxing from a slightly enlarged version of itself back to
    // 100%, centered on the stroke. The raw ink drops away quickly underneath.
    // No dashes or glow rectangles; the settle motion itself is the cue.
    const shapeCx = preview.box.x + preview.box.width / 2;
    const shapeCy = preview.box.y + preview.box.height / 2;
    this._morphHandle?.cancel();
    this._morphHandle = tween({
      durationMs: PointerHandler.MORPH_MS,
      easing: (t) => t,
      onUpdate: (t) => {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        if (!c || !cv) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);

        // Ink clears in the first 40% so the settle reads on a clean page.
        const inkAlpha = 1 - easeOutCubic(Math.min(1, t / 0.4));
        if (inkAlpha > 0.01) {
          this.withScratchOffset(c, cv, () => {
            c.save();
            c.globalAlpha = inkAlpha;
            c.scale(renderScale, renderScale);
            renderLiveStroke(c, rawPts, rawColor, rawWidth, rawCurve, rawPressure, rawStrength);
            c.restore();
          });
        }

        const settle = easeOutCubic(t);
        const scaleFactor = 1.06 - 0.06 * settle;
        this.withScratchOffset(c, cv, () => {
          c.save();
          c.globalAlpha = settle;
          // Grow/settle around the shape's own center, in page units.
          c.scale(renderScale, renderScale);
          c.translate(shapeCx, shapeCy);
          c.scale(scaleFactor, scaleFactor);
          c.translate(-shapeCx, -shapeCy);
          // Already scaled to page units above: render at scale 1.
          annotationEngine.renderSingleAnnotation(c, preview, 1);
          c.restore();
        });
      },
      onComplete: () => {
        this._morphHandle = null;
        // Settle on the final shape so nothing flickers when the tween ends.
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        if (!c || !cv) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);
        this.withScratchOffset(c, cv, () => {
          annotationEngine.renderSingleAnnotation(c, preview, renderScale);
        });
      }
    });
  }

  /**
   * Builds the snapped ShapeAnnotation. Draw-and-hold recognition is a pen
   * gesture, so the recognized shape inherits the active pen brush (color,
   * width) rather than the shape tool's settings — the stroke must not change
   * color or thickness the moment it snaps.
   */
  private buildHoldShapeAnnotation(fit: FittedShape, pageIndex: number, layerId: string): ShapeAnnotation | null {
    const s = store.toolSettings;
    const strokeWidth = this.lensWidth(s.penWidth);
    const base = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      strokeColor: s.penColor,
      fillColor: 'transparent',
      strokeWidth,
      outline: true,
      strokeStyle: 'solid' as const,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as const;
    if (fit.kind === 'line' || fit.kind === 'arrow') {
      const points = [{ ...fit.p0 }, { ...fit.p1 }];
      return {
        ...base,
        type: fit.kind,
        points,
        box: computePointsBoundingBox(points, strokeWidth),
        arrowEnd: fit.kind === 'arrow'
      };
    }
    if (fit.kind === 'rectangle') {
      return { ...base, type: 'rectangle', box: { ...fit.box } };
    }
    if (fit.kind === 'ellipse') {
      const w = Math.max(4, fit.rx * 2);
      const h = Math.max(4, fit.ry * 2);
      return { ...base, type: 'ellipse', box: { x: fit.cx - w / 2, y: fit.cy - h / 2, width: w, height: h } };
    }
    if (fit.points.length < 3) return null;
    return {
      ...base,
      type: 'polygon',
      points: fit.points.map(p => ({ ...p })),
      box: computePointsBoundingBox(fit.points, strokeWidth)
    };
  }

  public handlePointerDown(
    e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    const tSettings = store.toolSettings;

    // Check palm rejection
    if (tSettings.palmRejectionEnabled && palmRejection.registerPointer(e)) {
      return;
    }

    this.cancelScratchRaf();
    this._isPointerDown = true;
    this._activePageIndex = pageIndex;
    const renderCanvas = this.resolveRenderScratchCanvas(scratchCanvas);
    this._pageScratchCanvas = renderCanvas;
    this._pageScratchCtx = renderCanvas.getContext('2d');
    this._activeCanvasRect = scratchCanvas.getBoundingClientRect();
    this._scratchDirtyRect = null;
    this._lastPointerTime = performance.now();
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    this._simulatedVelocityPressure = 0.5;

    const pt = this.getPointInPage(e, scratchCanvas);
    let tool = store.activeTool;

    // Auto-detect stylus eraser tip (buttons === 32 or button === 5)
    if (tSettings.stylusInvertedEraserEnabled && e.pointerType === 'pen' && (e.buttons === 32 || (e as any).button === 5)) {
      tool = 'eraser';
    }
    this._strokeTool = tool;
    this._wasCollapsedNoteSelectedOnDown = null;

    const defaultLayerId = 'layer-default';
    const pageAnns = store.activeDocument?.annotations[pageIndex] || [];

    // 1. Check if clicking the top-right collapse button of any expanded Sticky Note
    for (let i = pageAnns.length - 1; i >= 0; i--) {
      const cand = pageAnns[i];
      if (cand.type === 'sticky-note' && !cand.collapsed && !cand.locked) {
        if (stickyNoteTool.hitTestCollapseButton(cand, pt)) {
          this._isPointerDown = false;
          this._strokeTool = null;
          this._activePageIndex = -1;
          this._pageScratchCanvas = null;
          this._pageScratchCtx = null;
          this._activeCanvasRect = null;
          this._activeStickyPolygonNoteId = null;
          const nextNote: StickyNoteAnnotation = {
            ...cand,
            collapsed: true,
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, cand, nextNote));
          store.selectAnnotation(cand.id);
          onNeedRepaint();
          return;
        }
        if (stickyNoteTool.hitTest(cand, pt)) {
          break;
        }
      }
    }

    // 2. Check if using any drawing/annotation tool inside an expanded Sticky Note mini-board
    const stickyTarget = this.findExpandedStickyNoteForInk(pt, pageAnns, tool);
    if (stickyTarget) {
      const note = stickyTarget.note;
      const mode = stickyTarget.mode;

      if (mode === 'text') {
        this._isPointerDown = false;
        this._strokeTool = null;
        this._activePageIndex = -1;
        this._pageScratchCanvas = null;
        this._pageScratchCtx = null;
        this._activeCanvasRect = null;
        const clampedPt = stickyNoteTool.clampPointToNote(note, pt, 10);
        this.beginNewTextInStickyNote(note, clampedPt, pageIndex, scratchCanvas, onNeedRepaint);
        return;
      }

      if (mode === 'shape' && stickyTarget.shapeTool) {
        const sTool = stickyTarget.shapeTool;
        const shapeW = this.lensWidth(tSettings.shapeWidth);
        const clampedPt = stickyNoteTool.clampPointToNote(note, pt, Math.max(2, shapeW / 2));

        if (sTool === 'polygon') {
          const polySnap = e.shiftKey || this.toolOpt('polygon', 'snapAngle15');
          if (shapesTool.isPolygonActive() && this._activeStickyPolygonNoteId === note.id) {
            shapesTool.move(clampedPt, e.shiftKey, polySnap);
            const closed = shapesTool.addPolygonVertex(clampedPt);
            if (closed) {
              const polyAnn = shapesTool.finish(defaultLayerId);
              if (polyAnn) {
                const updatedNote: StickyNoteAnnotation = {
                  ...note,
                  items: [...(note.items || []), polyAnn],
                  updatedAt: Date.now()
                };
                history.execute(new ModifyAnnotationCommand(pageIndex, note, updatedNote));
              }
              this._activeStickyPolygonNoteId = null;
              this._snapTarget = null;
              if (this._pageScratchCtx && this._pageScratchCanvas) {
                this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
              }
              onNeedRepaint();
              return;
            }
            if (this._pageScratchCtx && this._pageScratchCanvas) {
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas;
              const rs = store.zoom * this.renderDpr();
              c.clearRect(0, 0, cv.width, cv.height);
              this.withScratchOffset(c, cv, () => {
                stickyNoteTool.withNoteClip(c, note, rs, () => {
                  shapesTool.renderScratchpad(c, rs);
                });
              });
            }
            return;
          }

          this._activeStickyPolygonNoteId = note.id;
          this._snapTarget = null;
          shapesTool.start(
            clampedPt,
            pageIndex,
            'polygon',
            tSettings.shapeColor,
            tSettings.shapeFillColor,
            shapeW,
            tSettings.shapeStyle,
            tSettings.shapeOutline !== false,
            tSettings.shapeFillOpacity ?? 1.0
          );
          this._activeStickyStroke = {
            pageIndex,
            noteId: note.id,
            mode: 'shape',
            shapeTool: 'polygon',
            points: [clampedPt],
            color: tSettings.shapeColor,
            strokeWidth: shapeW,
            originalNote: cloneAnnotation(note)
          };
          return;
        }

        shapesTool.start(
          clampedPt,
          pageIndex,
          sTool,
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          shapeW,
          tSettings.shapeStyle,
          tSettings.shapeOutline !== false,
          tSettings.shapeFillOpacity ?? 1.0
        );
        this._activeStickyStroke = {
          pageIndex,
          noteId: note.id,
          mode: 'shape',
          shapeTool: sTool,
          points: [clampedPt],
          color: tSettings.shapeColor,
          strokeWidth: shapeW,
          originalNote: cloneAnnotation(note)
        };
        return;
      }

      const isHighlighter = mode === 'highlighter';
      const strokeColor = isHighlighter
        ? (tSettings.highlighterColor || '#fde047')
        : (tSettings.penColor || note.textColor || '#3b2f1e');
      const strokeW = isHighlighter
        ? (tSettings.highlighterWidth || 18)
        : (tSettings.penWidth || 2.5);
      const strokeOpacity = isHighlighter
        ? (tSettings.highlighterOpacity ?? 0.45)
        : 1.0;
      const clampedPt = stickyNoteTool.clampPointToNote(note, pt, 2);

      this._activeStickyStroke = {
        pageIndex,
        noteId: note.id,
        mode,
        points: [clampedPt],
        color: strokeColor,
        strokeWidth: strokeW,
        opacity: strokeOpacity,
        pressureEnabled: tSettings.pressureSensitivityEnabled !== false,
        pressureCurve: tSettings.pressureCurve || 'linear',
        pressureStrength: tSettings.pressureStrength || 'balanced',
        smoothing: tSettings.strokeSmoothing || 'medium',
        blendMode: tSettings.highlighterBlendMode || 'multiply',
        tipShape: tSettings.highlighterTipShape || 'chisel',
        straightLine: tSettings.highlighterStraightLine === true,
        originalNote: cloneAnnotation(note)
      };
      if (mode === 'eraser') {
        this.applyStickyNoteEraser([pt], pageIndex, note.id, Math.max(8, tSettings.eraserWidth / 2));
        onNeedRepaint();
      } else if (this._pageScratchCtx && this._pageScratchCanvas) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const rs = store.zoom * this.renderDpr();
        c.clearRect(0, 0, cv.width, cv.height);
        this.withScratchOffset(c, cv, () => {
          stickyNoteTool.renderLiveStrokeInNote(c, note, [clampedPt], strokeColor, strokeW, strokeOpacity, rs, {
            tool: mode,
            pressureEnabled: this._activeStickyStroke?.pressureEnabled,
            pressureCurve: this._activeStickyStroke?.pressureCurve,
            pressureStrength: this._activeStickyStroke?.pressureStrength,
            smoothing: this._activeStickyStroke?.smoothing,
            blendMode: this._activeStickyStroke?.blendMode,
            tipShape: this._activeStickyStroke?.tipShape
          });
        });
      }
      return;
    }

    switch (tool) {
      case 'pen': {
        penTool.start(
          pt,
          pageIndex,
          tSettings.penColor,
          tSettings.penWidth,
          tSettings.pressureCurve,
          tSettings.pressureSensitivityEnabled !== false,
          tSettings.pressureStrength || 'balanced',
          tSettings.strokeSmoothing || 'medium'
        );
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            penTool.renderScratchpad(c, rs);
          });
          this.setScratchpadDirtyFromPageBox(penTool.getLiveBoundingBox(), rs);
        }
        this.startHoldTimer({ x: pt.x, y: pt.y });
        break;
      }

      case 'highlighter': {
        highlighterTool.start(
          pt,
          pageIndex,
          tSettings.highlighterColor,
          tSettings.highlighterWidth,
          tSettings.highlighterBlendMode,
          tSettings.highlighterStraightLine,
          tSettings.highlighterTipShape,
          tSettings.highlighterOpacity ?? 0.45
        );
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            highlighterTool.renderScratchpad(c, rs);
          });
          this.setScratchpadDirtyFromPageBox(highlighterTool.getLiveBoundingBox(), rs);
        }
        break;
      }

      case 'eraser': {
        eraserTool.start(pt, tSettings.eraserWidth / 2, tSettings.eraserMode);
        this.beginEraserSession(pageIndex);
        this.applyEraserDirect([pt], pageIndex);
        onNeedRepaint();
        break;
      }

      case 'polygon': {
        const polySnap = e.shiftKey || this.toolOpt('polygon', 'snapAngle15');
        if (shapesTool.isPolygonActive()) {
          const placed = this.snapToVertex(pt, pageIndex);
          // move() records the snap-angle flag that addPolygonVertex reads.
          shapesTool.move(placed, e.shiftKey, polySnap);
          const closed = shapesTool.addPolygonVertex(placed);
          if (closed) {
            const polyAnn = shapesTool.finish(defaultLayerId);
            if (polyAnn) {
              history.execute(new AddAnnotationCommand(pageIndex, polyAnn));
            }
            this._snapTarget = null;
          if (this._pageScratchCtx && this._pageScratchCanvas) {
            this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
          }
          onNeedRepaint();
          return;
        }
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          c.clearRect(0, 0, cv.width, cv.height);
          this.withScratchOffset(c, cv, () => {
            shapesTool.renderScratchpad(c, store.zoom * this.renderDpr());
          });
        }
        return;
      }

      this._snapTarget = null;
      shapesTool.start(
        pt,
        pageIndex,
        'polygon',
        tSettings.shapeColor,
        tSettings.shapeFillColor,
        this.lensWidth(tSettings.shapeWidth),
        tSettings.shapeStyle,
        tSettings.shapeOutline !== false,
        tSettings.shapeFillOpacity ?? 1.0
      );
      break;
    }

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'freeform-shape': {
        // Anchor the first point to a nearby existing vertex when present.
        const startPt = this.snapToVertex(pt, pageIndex);
        shapesTool.start(
          startPt,
          pageIndex,
          tool,
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          this.lensWidth(tSettings.shapeWidth),
          tSettings.shapeStyle,
          tSettings.shapeOutline !== false,
          tSettings.shapeFillOpacity ?? 1.0
        );
        break;
      }

      case 'text': {
        // Release pointer state immediately so moving the cursor into the
        // floating inline textarea does not trigger drag/move handlers.
        this._isPointerDown = false;
        this._strokeTool = null;
        this._activePageIndex = -1;
        this._pageScratchCanvas = null;
        this._pageScratchCtx = null;
        this._activeCanvasRect = null;

        const existingAnns = store.activeDocument?.annotations[pageIndex] || [];
        const hit = selectionManager.findAnnotationAtPoint(pt, existingAnns);
        if (hit && hit.type === 'text') {
          store.setActiveTool('select');
          this.selectCreatedAnnotation(hit.id);
          this.editExistingTextAnnotation(hit, pageIndex, scratchCanvas, onNeedRepaint);
          return;
        }

        this.beginNewTextAnnotation(pt, pageIndex, scratchCanvas, onNeedRepaint);
        return;
      }

      case 'sticky-note': {
        const existingAnns = store.activeDocument?.annotations[pageIndex] || [];
        const hit = selectionManager.findAnnotationAtPoint(pt, existingAnns);
        if (hit && hit.type === 'sticky-note') {
          this._isPointerDown = false;
          this._strokeTool = null;
          this._activePageIndex = -1;
          this._pageScratchCanvas = null;
          this._pageScratchCtx = null;
          this._activeCanvasRect = null;
          if (hit.collapsed) {
            const expanded: StickyNoteAnnotation = { ...hit, collapsed: false, updatedAt: Date.now() };
            history.execute(new ModifyAnnotationCommand(pageIndex, hit, expanded));
            store.setActiveTool('select');
            store.selectAnnotation(hit.id);
            onNeedRepaint();
          } else {
            store.setActiveTool('select');
            this.selectCreatedAnnotation(hit.id);
            this.editExistingStickyNote(hit, pageIndex, scratchCanvas, onNeedRepaint);
          }
          return;
        }
        this._stickyCreateDrag = {
          pageIndex,
          start: { x: pt.x, y: pt.y },
          current: { x: pt.x, y: pt.y }
        };
        break;
      }

      case 'stamp':
        const stampBase = stampTool.createPresetStamp(pt, pageIndex, defaultLayerId, tSettings.stampPreset || 'APPROVED');
        history.execute(new AddAnnotationCommand(pageIndex, stampBase));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(stampBase.id);
        onNeedRepaint();
        break;

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        measureTool.start(
          pt,
          pageIndex,
          tool,
          tSettings.measureUnit,
          tSettings.measureScale,
          '#2563eb'
        );
        break;

      case 'redaction':
        redactionTool.start(pt, pageIndex, tSettings.redactionColor || '#000000');
        break;

      case 'lasso': {
        // Freehand selection loop. Same session as Alt+drag in Select, so both
        // paths share the commit logic on pointer-up. Dropping the old
        // selection here would defeat the additive union on pointer-up, so it
        // only happens for a plain (non-additive) lasso.
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        // A press on the current selection's handles or body is a transform,
        // never a new lasso — the controls behave identically to Select.
        if (!additive && this.tryBeginSelectDrag(pt, pageIndex)) break;
        if (!additive) store.clearSelection();
        this._lasso = {
          pageIndex,
          points: [{ x: pt.x, y: pt.y }],
          additive
        };
        onNeedRepaint();
        break;
      }

      case 'select': {
        const doc = store.activeDocument;
        if (!doc) break;
        const pageAnns = doc.annotations[pageIndex] || [];

        const hitBeforeDrag = selectionManager.findAnnotationAtPoint(pt, pageAnns);
        if (hitBeforeDrag && hitBeforeDrag.type === 'sticky-note' && hitBeforeDrag.collapsed && store.selectedAnnotationIds.has(hitBeforeDrag.id)) {
          this._wasCollapsedNoteSelectedOnDown = hitBeforeDrag.id;
        }

        // Ctrl/Cmd-click adds to the selection exactly like Shift-click, so it
        // must not start a drag — otherwise multi-selecting for bulk delete
        // is impossible once something is already selected.
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        // 1. Grab a transform handle or the selection body to start a drag.
        if (!additive && this.tryBeginSelectDrag(pt, pageIndex)) break;

        // 2. Click an annotation to (multi-)select it.
        const ann = hitBeforeDrag;
        if (ann) {
          store.selectAnnotation(ann.id, additive);
          onNeedRepaint();
        } else if ((e as MouseEvent).altKey === true) {
          // 3a. Alt+drag: freehand lasso loop around arbitrary ink/shapes.
          this._lasso = {
            pageIndex,
            points: [{ x: pt.x, y: pt.y }],
            additive
          };
        } else {
          // 3b. Empty press: rubber-band region select (tiny drag = click).
          this._marquee = {
            pageIndex,
            start: { x: pt.x, y: pt.y },
            current: { x: pt.x, y: pt.y },
            additive
          };
        }
        break;
      }
    }
  }

  /**
   * Starts a move/resize/rotate drag when the point grabs the current
   * selection's handles or body. Shared by the Select and Lasso tools so the
   * transform controls behave the same regardless of the active tool.
   */
  private tryBeginSelectDrag(pt: Point, pageIndex: number): boolean {
    const doc = store.activeDocument;
    if (!doc) return false;
    const pageAnns = doc.annotations[pageIndex] || [];
    const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
    if (selected.length === 0) return false;

    const merged = mergeBoundingBoxes(selected.map(getAnnotationSelectionBox));
    // Lone rotated annotations hit-test in their rotated frame.
    const singleRot = selected.length === 1 ? selected[0].rotation || 0 : 0;
    const hit = selectionManager.hitTestSelection(
      pt, selected, store.zoom * this.renderDpr()
    );
    if (!hit) return false;

    const originals = new Map(selected.map(a => [a.id, cloneAnnotation(a)] as [string, Annotation]));
    // Resizing a rotated annotation works in its unrotated frame.
    const startPt = singleRot && hit !== 'body' && hit !== 'rot' && hit !== 'start' && hit !== 'end'
      ? rotatePoint(pt, boxCenter(merged), -singleRot)
      : { x: pt.x, y: pt.y };
    this._selectDrag = {
      mode: hit === 'body' ? 'move' : hit === 'rot' ? 'rotate' : 'resize',
      handle: hit,
      pageIndex,
      originals,
      merged: { ...merged },
      startPt
    };
    return true;
  }

  public handlePointerMove(
    e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    // Polygon hover: between clicks there is no button down, but the elastic
    // segment has to follow the cursor exactly like the line tool's does. This
    // runs before the pressed-only guard below and repaints nothing but the
    // scratch layer.
    if (
      !this._isPointerDown &&
      store.activeTool === 'polygon' &&
      shapesTool.isPolygonActive() &&
      shapesTool.activePageIndex === pageIndex
    ) {
      const renderCanvas = this.resolveRenderScratchCanvas(scratchCanvas);
      const ctx = renderCanvas.getContext('2d');
      if (ctx) {
        this._pageScratchCanvas = renderCanvas;
        const hoverPt = this.getPointInPage(e, scratchCanvas);
        const polyNote = this._activeStickyPolygonNoteId
          ? store.activeDocument?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === this._activeStickyPolygonNoteId && a.type === 'sticky-note'
            )
          : undefined;
        const placed = polyNote
          ? stickyNoteTool.clampPointToNote(polyNote, hoverPt, 2)
          : this.snapToVertex(hoverPt, pageIndex);
        shapesTool.move(placed, e.shiftKey, e.shiftKey || this.toolOpt('polygon', 'snapAngle15'));
        ctx.clearRect(0, 0, renderCanvas.width, renderCanvas.height);
        const rs = store.zoom * this.renderDpr();
        this.withScratchOffset(ctx, renderCanvas, () => {
          if (polyNote) {
            stickyNoteTool.withNoteClip(ctx, polyNote, rs, () => {
              shapesTool.renderScratchpad(ctx, rs);
            });
          } else {
            shapesTool.renderScratchpad(ctx, rs);
            this.renderSnapTarget(ctx, rs);
          }
        });
      }
      return;
    }

    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    // Use coalesced events for extreme pen drawing smoothness, but batch them
    // into a SINGLE composite per animation frame:
    // - drawing tools push all points, then render once (avoids O(n^2)
    //   full-stroke redraws and multiply overdraw darkening per sub-event)
    // - eraser merges all hits into one history command + one repaint + one
    //   preview circle (fixes lag and trailing circles left behind mid-frame)
    const coalescedEvents = (e as any).getCoalescedEvents ? (e as any).getCoalescedEvents() : [e];
    const tool = this._strokeTool ?? store.activeTool;
    const ctx = this._pageScratchCtx;
    if (!ctx) return;

    const dpr = this.renderDpr();
    const renderScale = store.zoom * dpr;
    const pts = coalescedEvents.map((evt: PointerEvent) => this.getPointInPage(evt, scratchCanvas));
    if (pts.length === 0) return;
    const lastPt = pts[pts.length - 1];
    const shiftKey = (e as MouseEvent).shiftKey === true;

    // Handle active in-note tool session inside an expanded Sticky Note mini-board
    if (this._activeStickyStroke && this._activeStickyStroke.pageIndex === pageIndex) {
      const s = this._activeStickyStroke;
      const doc = store.activeDocument;
      const currentNote = doc?.annotations[pageIndex]?.find(
        (a): a is StickyNoteAnnotation => a.id === s.noteId && a.type === 'sticky-note'
      );
      if (currentNote) {
        const activeScratch = this._pageScratchCanvas || scratchCanvas;
        if (s.mode === 'eraser') {
          this.applyStickyNoteEraser(pts, pageIndex, s.noteId, Math.max(8, store.toolSettings.eraserWidth / 2));
          onNeedRepaint();
          ctx.clearRect(0, 0, activeScratch.width, activeScratch.height);
          const clampedLast = stickyNoteTool.clampPointToNote(currentNote, lastPt, 2);
          this.withScratchOffset(ctx, activeScratch, () => {
            stickyNoteTool.withNoteClip(ctx, currentNote, renderScale, () => {
              eraserTool.renderScratchpad(ctx, clampedLast, renderScale);
            });
          });
        } else if (s.mode === 'shape' && s.shapeTool) {
          if (s.shapeTool !== 'polygon') {
            const snapAngle = shiftKey || this.toolOpt(s.shapeTool, 'snapAngle15');
            for (const rawPt of pts) {
              const clamped = stickyNoteTool.clampPointToNote(currentNote, rawPt, Math.max(2, s.strokeWidth / 2));
              shapesTool.move(clamped, shiftKey, snapAngle);
            }
          }
          ctx.clearRect(0, 0, activeScratch.width, activeScratch.height);
          this.withScratchOffset(ctx, activeScratch, () => {
            stickyNoteTool.withNoteClip(ctx, currentNote, renderScale, () => {
              shapesTool.renderScratchpad(ctx, renderScale);
            });
          });
        } else {
          const minDist = 0.65 / Math.max(1, store.zoom);
          for (const rawPt of pts) {
            const clamped = stickyNoteTool.clampPointToNote(currentNote, rawPt, 2);
            if (s.mode === 'highlighter' && (s.straightLine || shiftKey) && s.points.length >= 1) {
              const startPt = s.points[0];
              if (shiftKey) {
                const dx = clamped.x - startPt.x;
                const dy = clamped.y - startPt.y;
                const angle = Math.atan2(dy, dx);
                const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
                const dist = Math.hypot(dx, dy);
                const snapped = stickyNoteTool.clampPointToNote(currentNote, {
                  ...clamped,
                  x: startPt.x + Math.cos(snapAngle) * dist,
                  y: startPt.y + Math.sin(snapAngle) * dist
                }, 2);
                s.points = [startPt, snapped];
              } else {
                s.points = [startPt, clamped];
              }
            } else {
              const prev = s.points[s.points.length - 1];
              if (!prev || Math.hypot(clamped.x - prev.x, clamped.y - prev.y) >= minDist) {
                s.points.push(clamped);
              }
            }
          }
          ctx.clearRect(0, 0, activeScratch.width, activeScratch.height);
          this.withScratchOffset(ctx, activeScratch, () => {
            stickyNoteTool.renderLiveStrokeInNote(
              ctx,
              currentNote,
              s.points,
              s.color,
              s.strokeWidth,
              s.opacity ?? 1.0,
              renderScale,
              {
                tool: s.mode === 'highlighter' ? 'highlighter' : 'pen',
                pressureEnabled: s.pressureEnabled,
                pressureCurve: s.pressureCurve,
                pressureStrength: s.pressureStrength,
                smoothing: s.smoothing,
                blendMode: s.blendMode,
                tipShape: s.tipShape
              }
            );
          });
        }
      }
      return;
    }

    // Zero-latency synchronous paint for freehand ink & highlighter
    if (tool === 'pen') {
      for (const pt of pts) penTool.move(pt, store.zoom);
      const holdRadiusPage = PointerHandler.HOLD_RADIUS / Math.max(store.zoom, 0.25);
      if (this._holdAnchor && Math.hypot(lastPt.x - this._holdAnchor.x, lastPt.y - this._holdAnchor.y) > holdRadiusPage) {
        this._holdFired = false;
        this._holdShape = null;
        this._morphHandle?.cancel();
        this._morphHandle = null;
        this.startHoldTimer({ x: lastPt.x, y: lastPt.y });
      }
      if (this._isPointerDown && this._pageScratchCtx && this._pageScratchCanvas) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const rs = store.zoom * this.renderDpr();
        if (this._holdFired && this._holdShape) {
          c.clearRect(0, 0, cv.width, cv.height);
          this._scratchDirtyRect = null;
          const preview = this.buildHoldShapeAnnotation(this._holdShape, pageIndex, 'layer-default');
          if (preview) {
            this.withScratchOffset(c, cv, () => {
              annotationEngine.renderSingleAnnotation(c, preview, rs);
            });
          }
        } else {
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            penTool.renderScratchpad(c, rs);
          });
          this.setScratchpadDirtyFromPageBox(penTool.getLiveBoundingBox(), rs);
        }
      }
      return;
    }

    if (tool === 'highlighter') {
      for (const pt of pts) highlighterTool.move(pt, shiftKey, store.zoom);
      if (this._isPointerDown && this._pageScratchCtx && this._pageScratchCanvas) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const rs = store.zoom * this.renderDpr();
        this.clearScratchpadDirty(c, cv);
        this.withScratchOffset(c, cv, () => {
          highlighterTool.renderScratchpad(c, rs);
        });
        this.setScratchpadDirtyFromPageBox(highlighterTool.getLiveBoundingBox(), rs);
      }
      return;
    }

    if (tool === 'eraser') {
      eraserTool.move(lastPt);
      if (this.applyEraserDirect(pts, pageIndex)) {
        onNeedRepaint();
      }
      const paintEraser = () => {
        if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const rs = store.zoom * this.renderDpr();
        this.clearScratchpadDirty(c, cv);
        const livePt = eraserTool.getLiveBoundingBox();
        if (livePt) {
          this.withScratchOffset(c, cv, () => {
            eraserTool.renderScratchpad(c, { x: livePt.x + livePt.width / 2, y: livePt.y + livePt.height / 2 }, rs);
          });
          this.setScratchpadDirtyFromPageBox(livePt, rs);
        }
      };
      if (this._scratchRafId === null) {
        paintEraser();
        this._scratchNeedsTrailingPaint = false;
        this._scratchRafId = requestAnimationFrame(() => {
          this._scratchRafId = null;
          if (this._scratchNeedsTrailingPaint) {
            this._scratchNeedsTrailingPaint = false;
            paintEraser();
          }
        });
      } else {
        this._scratchNeedsTrailingPaint = true;
      }
      return;
    }

    // Clear scratchpad canvas once per frame for non-ink interactive tools
    const activeScratch = this._pageScratchCanvas || scratchCanvas;
    this.clearScratchpadDirty(ctx, activeScratch);

    switch (tool) {
      // Lasso shares Select's whole move path: an active transform drag takes
      // priority, then the growing lasso loop, then the marquee.
      case 'lasso':
      case 'select': {
        if (this._selectDrag && this._selectDrag.pageIndex === pageIndex) {
          // Absolute transform from drag start applied to pristine originals:
          // idempotent per frame, zero drift.
          const drag = this._selectDrag;
          const doc = store.activeDocument;
          if (doc?.annotations[pageIndex]) {
            if (drag.handle === 'start' || drag.handle === 'end') {
              const handle = drag.handle;
              doc.annotations[pageIndex] = doc.annotations[pageIndex].map(a => {
                const orig = drag.originals.get(a.id);
                return orig && (orig.type === 'line' || orig.type === 'arrow')
                  ? moveAnnotationEndpoint(orig, handle, lastPt)
                  : a;
              });
              doc.lastModifiedAt = Date.now();
            } else if (drag.mode === 'rotate') {
              this.applyRotationDrag(drag, lastPt, shiftKey, doc.annotations[pageIndex]);
              doc.lastModifiedAt = Date.now();
            } else {
              // Resizing a lone rotated annotation maps the cursor back into
              // its unrotated frame (start was stored mapped the same way).
              let effLast = lastPt;
              if (drag.mode === 'resize' && drag.originals.size === 1) {
                const orig = [...drag.originals.values()][0];
                if (orig.rotation) effLast = rotatePoint(lastPt, boxCenter(drag.merged), -orig.rotation);
              }
              const t = this.selectTransformFor(drag, effLast, shiftKey);
              doc.annotations[pageIndex] = doc.annotations[pageIndex].map(a => {
                const orig = drag.originals.get(a.id);
                return orig ? (transformAnnotation(orig, t) as typeof a) : a;
              });
              doc.lastModifiedAt = Date.now();
            }
          }
          onNeedRepaint();
        } else if (this._lasso && this._lasso.pageIndex === pageIndex) {
          this.withScratchOffset(ctx, activeScratch, () => {
            this.growLasso(pts, pageIndex, ctx, renderScale);
          });
        } else if (this._marquee && this._marquee.pageIndex === pageIndex) {
          this._marquee.current = { ...lastPt };
          this.withScratchOffset(ctx, activeScratch, () => {
            this.renderMarquee(ctx, renderScale);
          });
        }
        break;
      }

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'polygon':
      case 'freeform-shape': {
        // Shift constrains drag shapes (square / circle / 15° line). The
        // per-tool Snap-15° option enables it for the vertex tools too.
        const snapAngle = shiftKey || this.toolOpt(tool, 'snapAngle15');
        const magnetic = tool === 'line' || tool === 'arrow' ||
          tool === 'polygon' || tool === 'freeform-shape';
        this._snapTarget = null;
        for (const pt of pts) {
          const p = magnetic ? this.snapToVertex(pt, pageIndex) : pt;
          shapesTool.move(p, shiftKey, snapAngle);
        }
        this.withScratchOffset(ctx, activeScratch, () => {
          shapesTool.renderScratchpad(ctx, renderScale);
          if (magnetic) this.renderSnapTarget(ctx, renderScale);
        });
        break;
      }

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        for (const pt of pts) measureTool.move(pt);
        this.withScratchOffset(ctx, activeScratch, () => {
          measureTool.renderScratchpad(ctx, renderScale);
        });
        break;

      case 'redaction':
        for (const pt of pts) redactionTool.move(pt);
        this.withScratchOffset(ctx, activeScratch, () => {
          redactionTool.renderScratchpad(ctx, renderScale);
        });
        break;

      case 'sticky-note':
        if (this._stickyCreateDrag && this._stickyCreateDrag.pageIndex === pageIndex) {
          this._stickyCreateDrag.current = { ...lastPt };
          const d = distance(this._stickyCreateDrag.start, this._stickyCreateDrag.current);
          if (d > 10) {
            const rawBox = normalizeDragBox(this._stickyCreateDrag.start, this._stickyCreateDrag.current);
            const previewBox: BoundingBox = {
              x: rawBox.x,
              y: rawBox.y,
              width: Math.max(180, rawBox.width),
              height: Math.max(150, rawBox.height)
            };
            const ts = store.toolSettings;
            this.withScratchOffset(ctx, activeScratch, () => {
              stickyNoteTool.renderPreview(
                ctx,
                previewBox,
                renderScale,
                ts.noteColor || '#ebd09e',
                ts.noteAuthor !== undefined ? ts.noteAuthor : 'Kia Gh',
                ts.noteTextColor || '#3b2f1e'
              );
            });
          }
        }
        break;
    }
  }

  public handlePointerUp(
    _e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    this.cancelScratchRaf();
    this._isPointerDown = false;
    this._activeCanvasRect = null;
    this._scratchDirtyRect = null;
    const tool = this._strokeTool ?? store.activeTool;
    const defaultLayerId = 'layer-default';

    if (tool === 'polygon') {
      this._isPointerDown = false;
      this._strokeTool = null;
      // Polygons remain active across clicks until closed or completed
      if (this._pageScratchCtx && this._pageScratchCanvas && shapesTool.isPolygonActive()) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        this.withScratchOffset(c, cv, () => {
          shapesTool.renderScratchpad(c, store.zoom * this.renderDpr());
        });
      }
      return;
    }

    // Clear scratchpad canvas
    if (this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }

    // Commit active in-note tool session if one was in flight
    if (this._activeStickyStroke && this._activeStickyStroke.pageIndex === pageIndex) {
      const s = this._activeStickyStroke;
      this._activeStickyStroke = null;
      const doc = store.activeDocument;
      const currentNote = doc?.annotations[pageIndex]?.find(
        (a): a is StickyNoteAnnotation => a.id === s.noteId && a.type === 'sticky-note'
      );
      if (s.mode === 'shape' && s.shapeTool === 'polygon') {
        this._isPointerDown = false;
        this._strokeTool = null;
        if (this._pageScratchCtx && this._pageScratchCanvas && shapesTool.isPolygonActive() && currentNote) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.withScratchOffset(c, cv, () => {
            stickyNoteTool.withNoteClip(c, currentNote, rs, () => {
              shapesTool.renderScratchpad(c, rs);
            });
          });
        }
        return;
      }
      if (currentNote) {
        if (s.mode === 'eraser') {
          const origStrokes = s.originalNote.strokes?.length ?? 0;
          const curStrokes = currentNote.strokes?.length ?? 0;
          const origItems = s.originalNote.items?.length ?? 0;
          const curItems = currentNote.items?.length ?? 0;
          if (origStrokes !== curStrokes || origItems !== curItems) {
            history.pushCommitted(new ModifyAnnotationCommand(pageIndex, s.originalNote, { ...currentNote }));
          }
        } else if (s.mode === 'shape') {
          const shapeAnn = shapesTool.finish(defaultLayerId);
          if (shapeAnn) {
            const updatedNote: StickyNoteAnnotation = {
              ...currentNote,
              items: [...(currentNote.items || []), shapeAnn],
              updatedAt: Date.now()
            };
            history.execute(new ModifyAnnotationCommand(pageIndex, s.originalNote, updatedNote));
          }
        } else if (s.points.length >= 1) {
          const newStroke: StickyNoteStroke = {
            id: 'nstroke_' + Math.random().toString(36).substring(2, 9),
            tool: s.mode === 'highlighter' ? 'highlighter' : 'pen',
            points: s.points.length === 1
              ? [s.points[0], { ...s.points[0], x: s.points[0].x + 0.5, y: s.points[0].y + 0.5 }]
              : s.points,
            color: s.color,
            strokeWidth: s.strokeWidth,
            opacity: s.opacity ?? 1.0,
            pressureEnabled: s.pressureEnabled,
            pressureCurve: s.pressureCurve,
            pressureStrength: s.pressureStrength,
            smoothing: s.smoothing,
            blendMode: s.blendMode,
            tipShape: s.tipShape
          };
          const updatedNote: StickyNoteAnnotation = {
            ...currentNote,
            strokes: [...(currentNote.strokes || []), newStroke],
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, s.originalNote, updatedNote));
        }
      }
      this._isPointerDown = false;
      this._strokeTool = null;
      this._activePageIndex = -1;
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
      onNeedRepaint();
      return;
    }

    switch (tool) {
      case 'select':
      case 'lasso': {
        const dragBeforeCommit = this._selectDrag;
        const clickUpPt = this.getPointInPage(_e, scratchCanvas);
        const wasTinyClick = dragBeforeCommit
          ? distance(dragBeforeCommit.startPt, clickUpPt) < 4
          : false;
        this.commitSelectDrag();
        // If user clicked an already-selected collapsed Sticky Note icon without dragging, expand it
        if (wasTinyClick && this._wasCollapsedNoteSelectedOnDown) {
          const doc = store.activeDocument;
          const collapsedNote = doc?.annotations[pageIndex]?.find(
            (a): a is StickyNoteAnnotation => a.id === this._wasCollapsedNoteSelectedOnDown && a.type === 'sticky-note' && a.collapsed === true
          );
          this._wasCollapsedNoteSelectedOnDown = null;
          if (collapsedNote && !collapsedNote.locked) {
            const expanded: StickyNoteAnnotation = {
              ...collapsedNote,
              collapsed: false,
              updatedAt: Date.now()
            };
            history.execute(new ModifyAnnotationCommand(pageIndex, collapsedNote, expanded));
            onNeedRepaint();
            break;
          }
        }
        this._wasCollapsedNoteSelectedOnDown = null;
        if (this._lasso) {
          const lasso = this._lasso;
          this._lasso = null;
          const doc = store.activeDocument;
          if (doc?.annotations[lasso.pageIndex]) {
            const hits = selectionManager
              .findAnnotationsInPolygon(lasso.points, doc.annotations[lasso.pageIndex])
              .map(a => a.id);
            if (hits.length === 0) {
              if (!lasso.additive) store.clearSelection();
            } else if (lasso.additive) {
              store.setSelectedAnnotationIds([...new Set([...store.selectedAnnotationIds, ...hits])]);
            } else {
              store.setSelectedAnnotationIds(hits);
            }
          }
        } else if (this._marquee) {
          const mq = this._marquee;
          this._marquee = null;
          const w = Math.abs(mq.current.x - mq.start.x);
          const h = Math.abs(mq.current.y - mq.start.y);
          const doc = store.activeDocument;
          if (w < 4 && h < 4) {
            // Plain click on empty canvas.
            if (!mq.additive) {
              store.clearSelection();
            }
          } else if (doc?.annotations[mq.pageIndex]) {
            const hits = selectionManager
              .findAnnotationsInRect(normalizeDragBox(mq.start, mq.current), doc.annotations[mq.pageIndex])
              .map(a => a.id);
            if (mq.additive) {
              store.setSelectedAnnotationIds([...new Set([...store.selectedAnnotationIds, ...hits])]);
            } else {
              store.setSelectedAnnotationIds(hits);
            }
          }
        }
        break;
      }

      case 'pen': {
        const snapped = this._holdFired ? this._holdShape : null;
        const holdPage = this._activePageIndex;
        this._morphHandle?.cancel();
        this._morphHandle = null;
        this.clearHoldTimer();
        if (snapped) {
          // Two-step history: add the raw freehand stroke, then replace it
          // with the recognized shape. Undo #1 restores the original ink;
          // undo #2 removes it entirely.
          const penAnn = penTool.finish(defaultLayerId);
          const shapeAnn = this.buildHoldShapeAnnotation(snapped, holdPage, defaultLayerId);
          this._holdFired = false;
          this._holdShape = null;
          if (penAnn) history.execute(new AddAnnotationCommand(holdPage, penAnn));
          // Recognition is deliberately silent: the tool stays on the pen and
          // nothing gets selected. Yanking the user into Select mid-flow broke
          // the rhythm of drawing; they can pick the shape up themselves.
          if (shapeAnn) {
            history.execute(new ReplaceAnnotationsCommand(
              holdPage,
              penAnn ? [penAnn] : [],
              [shapeAnn]
            ));
          }
        } else {
          const penAnn = penTool.finish(defaultLayerId);
          if (penAnn) {
            history.execute(new AddAnnotationCommand(pageIndex, penAnn));
          }
        }
        break;
      }

      case 'highlighter': {
        const highAnn = highlighterTool.finish(defaultLayerId);
        if (highAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, highAnn));
        }
        break;
      }

      case 'eraser': {
        eraserTool.finish();
        this.commitEraserSession(pageIndex);
        break;
      }

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'freeform-shape': {
        const shapeAnn = shapesTool.finish(defaultLayerId);
        if (shapeAnn) {
          // "Connect Lines": fold coincident line/arrow endpoints into one
          // continuous multi-point path instead of stacking separate objects.
          const connected = this.toolOpt(shapeAnn.type, 'connectLines') &&
            (shapeAnn.type === 'line' || shapeAnn.type === 'arrow')
            ? this.tryConnectLines(pageIndex, shapeAnn)
            : null;
          if (connected) {
            history.execute(new ReplaceAnnotationsCommand(pageIndex, connected.remove, [connected.add]));
          } else {
            history.execute(new AddAnnotationCommand(pageIndex, shapeAnn));
          }
        }
        break;
      }

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        const measureAnn = measureTool.finish(defaultLayerId);
        if (measureAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, measureAnn));
        }
        break;

      case 'redaction':
        const redAnn = redactionTool.finish(defaultLayerId);
        if (redAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, redAnn));
        }
        break;

      case 'sticky-note': {
        const drag = this._stickyCreateDrag;
        this._stickyCreateDrag = null;
        const startPt = drag ? drag.start : this.getPointInPage(_e, scratchCanvas);
        const endPt = drag ? drag.current : startPt;
        const dist = distance(startPt, endPt);
        const ts = store.toolSettings;
        let customBox: BoundingBox | undefined;
        if (dist > 14) {
          const raw = normalizeDragBox(startPt, endPt);
          customBox = {
            x: raw.x,
            y: raw.y,
            width: Math.max(180, raw.width),
            height: Math.max(150, raw.height)
          };
        }
        const noteAnn = stickyNoteTool.createStickyNote(pageIndex, startPt, {
          layerId: defaultLayerId,
          box: customBox,
          color: ts.noteColor || '#ebd09e',
          textColor: ts.noteTextColor || '#3b2f1e',
          fontSize: ts.noteFontSize || 24,
          fontFamily: ts.fontFamily || 'Inter',
          textAlign: ts.textAlign || 'left',
          author: ts.noteAuthor !== undefined ? ts.noteAuthor : 'Kia Gh'
        });
        history.execute(new AddAnnotationCommand(pageIndex, noteAnn));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(noteAnn.id);
        onNeedRepaint();
        this.editExistingStickyNote(noteAnn, pageIndex, scratchCanvas, onNeedRepaint);
        break;
      }
    }

    if (this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }
    this._isPointerDown = false;
    this._strokeTool = null;
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    onNeedRepaint();
  }

  public finishPolygon(pageIndex: number, defaultLayerId: string = 'layer-default', onNeedRepaint?: () => void): boolean {
    if (shapesTool.isPolygonActive()) {
      const polyAnn = shapesTool.finish(defaultLayerId);
      const stickyNoteId = this._activeStickyPolygonNoteId;
      this._activeStickyPolygonNoteId = null;
      if (polyAnn) {
        const doc = store.activeDocument;
        const targetNote = stickyNoteId
          ? doc?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === stickyNoteId && a.type === 'sticky-note'
            )
          : undefined;
        if (targetNote) {
          const updatedNote: StickyNoteAnnotation = {
            ...targetNote,
            items: [...(targetNote.items || []), polyAnn],
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, targetNote, updatedNote));
        } else {
          history.execute(new AddAnnotationCommand(pageIndex, polyAnn));
        }
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
        }
        this._pageScratchCanvas = null;
        this._pageScratchCtx = null;
        onNeedRepaint?.();
        return true;
      }
    }
    return false;
  }

  /** Aborts an in-progress lasso loop without selecting. Returns true if one was active. */
  public cancelLasso(): boolean {
    if (!this._lasso) return false;
    this._lasso = null;
    if (this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }
    this._isPointerDown = false;
    this._strokeTool = null;
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    return true;
  }

  /**
   * Builds the merged-box-relative transform for a selection drag: plain
   * translation for body moves; per-handle scaling (opposite edge anchored,
   * 8px minimum) for resizes.
   */
  private selectTransformFor(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    cur: Point,
    shiftKey: boolean = false
  ): BoxTransform {
    const m = drag.merged;
    if (drag.mode === 'move') {
      return {
        dx: cur.x - drag.startPt.x,
        dy: cur.y - drag.startPt.y,
        scaleX: 1,
        scaleY: 1,
        originX: m.x,
        originY: m.y
      };
    }

    const dx = cur.x - drag.startPt.x;
    const dy = cur.y - drag.startPt.y;
    let x1 = m.x;
    let y1 = m.y;
    let x2 = m.x + m.width;
    let y2 = m.y + m.height;
    const h = drag.handle;

    // Stamps are effectively images: corner resizing preserves aspect by
    // default (Shift frees it). Other annotations keep free scaling by
    // default and use Shift to lock.
    const isCorner = h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';
    const allStamps = drag.originals.size > 0 &&
      [...drag.originals.values()].every(a => a.type === 'stamp');
    const lockAspect = isCorner && (allStamps ? !shiftKey : shiftKey);

    if (lockAspect) {
      const origAspect = m.width > 0 && m.height > 0 ? m.width / m.height : 1;
      const primaryDelta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if (h === 'se') {
        x2 = m.x + m.width + primaryDelta;
        y2 = m.y + (x2 - m.x) / origAspect;
      } else if (h === 'nw') {
        x1 = m.x + primaryDelta;
        y1 = (m.y + m.height) - (m.x + m.width - x1) / origAspect;
      } else if (h === 'ne') {
        x2 = m.x + m.width + primaryDelta;
        y1 = (m.y + m.height) - (x2 - m.x) / origAspect;
      } else if (h === 'sw') {
        x1 = m.x + primaryDelta;
        y2 = m.y + (m.x + m.width - x1) / origAspect;
      }
    } else {
      if (h.includes('e')) x2 += dx;
      if (h.includes('s')) y2 += dy;
      if (h.includes('w')) x1 += dx;
      if (h.includes('n')) y1 += dy;
    }

    // Enforce minimum size by clamping the dragged edge.
    if (x2 - x1 < 8) {
      if (h.includes('w')) x1 = x2 - 8; else x2 = x1 + 8;
    }
    if (y2 - y1 < 8) {
      if (h.includes('n')) y1 = y2 - 8; else y2 = y1 + 8;
    }
    return {
      dx: x1 - m.x,
      dy: y1 - m.y,
      scaleX: m.width > 0.5 ? (x2 - x1) / m.width : 1,
      scaleY: m.height > 0.5 ? (y2 - y1) / m.height : 1,
      originX: m.x,
      originY: m.y
    };
  }

  /**
   * Rotates every dragged annotation around the merged-box pivot by the angle
   * swept since drag start (Shift snaps to 15°). Single selections spin in
   * place; groups orbit their shared center, each keeping its own rotation.
   * Absolute from drag start: idempotent per frame, zero drift.
   */
  private applyRotationDrag(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    cur: Point,
    snap: boolean,
    pageAnns: Annotation[]
  ): void {
    const center = boxCenter(drag.merged);
    const a0 = Math.atan2(drag.startPt.y - center.y, drag.startPt.x - center.x);
    const a1 = Math.atan2(cur.y - center.y, cur.x - center.x);
    let delta = a1 - a0;
    // Normalize to [-PI, PI] so crossing the -x axis doesn't spin backwards.
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (snap) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
    if (delta === 0) return;

    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    for (let i = 0; i < pageAnns.length; i++) {
      const orig = drag.originals.get(pageAnns[i].id);
      if (!orig) continue;
      const oldC = boxCenter(orig.box);
      const relX = oldC.x - center.x;
      const relY = oldC.y - center.y;
      const moved = transformAnnotation(orig, {
        dx: center.x + relX * cos - relY * sin - oldC.x,
        dy: center.y + relX * sin + relY * cos - oldC.y,
        scaleX: 1,
        scaleY: 1,
        originX: oldC.x,
        originY: oldC.y
      });
      moved.rotation = (orig.rotation || 0) + delta;
      pageAnns[i] = moved;
    }
  }

  /** Commits an in-progress selection drag as ONE undo step. No-op otherwise. */
  private commitSelectDrag(): void {
    const drag = this._selectDrag;
    this._selectDrag = null;
    if (!drag) return;
    const doc = store.activeDocument;
    if (!doc?.annotations[drag.pageIndex]) return;
    const pairs: Array<{ prev: Annotation; next: Annotation }> = [];
    for (const [id, prev] of drag.originals) {
      const next = doc.annotations[drag.pageIndex].find(a => a.id === id);
      if (next && JSON.stringify(next) !== JSON.stringify(prev)) {
        pairs.push({ prev, next: { ...next } });
      }
    }
    if (pairs.length > 0) {
      history.pushCommitted(new BulkModifyCommand(drag.pageIndex, pairs));
    }
  }

  /** Renders the dashed rubber band for region selection. */
  private renderMarquee(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this._marquee) return;
    const box = normalizeDragBox(this._marquee.start, this._marquee.current);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(79, 70, 229, 0.08)';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }

  /** Renders the freehand lasso loop for region selection. */
  private renderLassoPath(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this._lasso || this._lasso.points.length < 2) return;
    const pts = this._lasso.points;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(79, 70, 229, 0.08)';
    ctx.fill();
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Extends the active lasso loop with a frame's worth of points and redraws
   * it. Shared by the Lasso tool and the Alt+drag shortcut in Select so both
   * behave identically.
   */
  private growLasso(points: Point[], pageIndex: number, ctx: CanvasRenderingContext2D, renderScale: number): void {
    if (!this._lasso || this._lasso.pageIndex !== pageIndex) return;
    const path = this._lasso.points;
    for (const pt of points) {
      const prev = path[path.length - 1];
      // Drop sub-pixel jitter so the loop stays lean.
      if (!prev || Math.abs(pt.x - prev.x) + Math.abs(pt.y - prev.y) > 1.5) {
        path.push({ x: pt.x, y: pt.y });
      }
    }
    this.renderLassoPath(ctx, renderScale);
  }

  /** Per-tool drawing option (Snap-15° / Connect-lines), defaulted off. */
  private toolOpt(tool: ToolType, key: ToolOptionKey): boolean {
    return store.toolOption(tool, key);
  }

  public cancelPolygon(): void {
    if (shapesTool.isPolygonActive()) {
      shapesTool.reset();
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
      }
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
    }
  }

  public isStrokeActive(): boolean {
    return this._isPointerDown;
  }

  get isPointerDown(): boolean {
    return this._isPointerDown;
  }

  get activePageIndex(): number {
    return this._activePageIndex;
  }

  public isPolygonActiveOnPage(pageIndex: number): boolean {
    return shapesTool.isPolygonActive() && shapesTool.activePageIndex === pageIndex;
  }

  public handleHover(e: PointerEvent, pageIndex: number, canvas: HTMLCanvasElement): void {
    if (store.selectedAnnotationIds.size === 0) return;

    const doc = store.activeDocument;
    if (!doc) return;
    const pageAnns = doc.annotations[pageIndex] || [];
    const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
    if (selected.length === 0) return;

    const pt = this.getPointInPage(e, canvas);
    if (selected.length === 1 && selected[0].type === 'sticky-note' && !selected[0].collapsed) {
      if (stickyNoteTool.hitTestCollapseButton(selected[0], pt)) {
        canvas.style.cursor = 'pointer';
        floatingPropsBar?.setHoverState(true);
        return;
      }
    }

    const merged = mergeBoundingBoxes(selected.map(getAnnotationSelectionBox));
    const hit = selectionManager.hitTestSelection(
      pt, selected, store.zoom * this.renderDpr()
    );
    const cursorByHandle: Record<Exclude<HandleType, null>, string> = {
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize',
      n: 'ns-resize',
      s: 'ns-resize',
      e: 'ew-resize',
      w: 'ew-resize',
      rot: 'crosshair',
      start: 'crosshair',
      end: 'crosshair',
      body: 'move'
    };
    if (hit) canvas.style.cursor = cursorByHandle[hit];

    const isNearOrOver = hit !== null || (
      pt.x >= merged.x - 10 &&
      pt.x <= merged.x + merged.width + 10 &&
      pt.y >= merged.y - 10 &&
      pt.y <= merged.y + merged.height + 10
    );

    floatingPropsBar?.setHoverState(isNearOrOver);
  }

  /**
   * Selection controls are an interaction layer, not a tool. This lets a user
   * grab an existing selection while the hand or lasso tool is active instead
   * of accidentally starting another pan/selection loop.
   */
  public isSelectionControlAt(e: PointerEvent, pageIndex: number, canvas: HTMLCanvasElement): boolean {
    const doc = store.activeDocument;
    if (!doc || store.selectedAnnotationIds.size === 0) return false;
    const selected = (doc.annotations[pageIndex] || [])
      .filter(annotation => store.selectedAnnotationIds.has(annotation.id));
    if (selected.length === 0) return false;
    const point = this.getPointInPage(e, canvas);
    return selectionManager.hitTestSelection(
      point, selected, store.zoom * this.renderDpr()
    ) !== null;
  }

  /**
   * Aborts the in-progress press without committing anything — used when a
   * second finger lands and the gesture takes over as pinch-zoom/pan, so no
   * stray marks are drawn. The one exception is the eraser: its hits are
   * applied live, so the partial work is committed as a single undo step
   * instead of being silently lost. Completed polygon vertices (placed by
   * earlier discrete clicks) are preserved; only the live rubber band is
   * dropped via the scratch clear.
   */
  public cancelActiveStroke(): void {
    if (!this._isPointerDown) return;
    this.cancelScratchRaf();
    const tool = this._strokeTool ?? store.activeTool;
    this.clearHoldTimer();
    this._morphHandle?.cancel();
    this._morphHandle = null;
    this._holdFired = false;
    this._holdShape = null;

    if (tool === 'eraser' && this._eraserSession) {
      eraserTool.finish();
      this.commitEraserSession(this._eraserSession.pageIndex);
    } else {
      // A gesture takeover commits (never silently drops) a selection drag;
      // an uncommitted marquee/lasso is just a rubber band.
      this.commitSelectDrag();
      this._marquee = null;
      this._lasso = null;
      penTool.cancel();
      highlighterTool.cancel();
      // Keep finished polygon vertices; a mid-click rubber band is harmless
      // to drop since the next click re-renders it.
      if (!shapesTool.isPolygonActive()) shapesTool.reset();
      measureTool.cancel();
      redactionTool.cancel();
    }

    if (this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }
    this._isPointerDown = false;
    this._strokeTool = null;
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    this._activeCanvasRect = null;
    this._scratchDirtyRect = null;
  }

  private beginEraserSession(pageIndex: number): void {
    const doc = store.activeDocument;
    if (!doc) {
      this._eraserSession = null;
      return;
    }
    // Shallow copy of the array; annotation objects themselves are treated as
    // immutable by the eraser (testErase creates new objects for splits).
    this._eraserSession = { pageIndex, original: [...(doc.annotations[pageIndex] || [])] };
  }

  /**
   * Applies eraser hits straight to the document with no history and no
   * store notification — pure live visual feedback at pointer-event rate.
   * Each point is tested against the CURRENT page state so continuous drags
   * (including splits created earlier in the same frame) erase correctly.
   */
  private applyEraserDirect(points: Point[], pageIndex: number): boolean {
    const doc = store.activeDocument;
    if (!doc || points.length === 0) return false;
    if (!doc.annotations[pageIndex]) return false;

    let modified = false;
    for (const point of points) {
      const current = doc.annotations[pageIndex];
      if (current.length === 0) break;
      const result = eraserTool.testErase(point, current);
      if (result.toRemove.length === 0) continue;
      const removeIds = new Set(result.toRemove.map(a => a.id));
      doc.annotations[pageIndex] = current
        .filter(a => !removeIds.has(a.id))
        .concat(result.toAdd);
      doc.lastModifiedAt = Date.now();
      modified = true;
    }
    return modified;
  }

  /**
   * Commits the whole eraser drag as a SINGLE undo step. Net diff between
   * stroke-start snapshot and live state — transient pixel fragments created
   * and re-erased mid-stroke cancel out instead of piling hundreds of history
   * entries (each a full app re-render) onto the stack.
   */
  private commitEraserSession(pageIndex: number): void {
    const session = this._eraserSession;
    this._eraserSession = null;
    if (!session || session.pageIndex !== pageIndex) return;
    const doc = store.activeDocument;
    if (!doc) return;

    const current = doc.annotations[pageIndex] || [];
    const original = session.original;
    const currentIds = new Set(current.map(a => a.id));
    const originalIds = new Set(original.map(a => a.id));

    const removed = original.filter(a => !currentIds.has(a.id));
    const added = current.filter(a => !originalIds.has(a.id));
    if (removed.length === 0 && added.length === 0) return;

    if (added.length > 0) {
      history.pushCommitted(new ReplaceAnnotationsCommand(pageIndex, removed, added));
    } else {
      history.pushCommitted(new DeleteAnnotationsCommand(pageIndex, removed));
    }
  }

  /**
   * Opens the floating inline text editor at `pt` to create a brand-new
   * TextAnnotation on commit. If left empty or cancelled, nothing is added.
   */
  public beginNewTextAnnotation(
    pt: Point,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    const tSettings = store.toolSettings;
    const defaultLayerId = 'layer-default';
    const fontSize = this.lensWidth(tSettings.fontSize || 16);
    const fontFamily = tSettings.fontFamily || 'Inter';
    const textColor = tSettings.textColor || '#111827';
    const textBgColor = tSettings.textBgColor || 'transparent';
    const textAlign = tSettings.textAlign || 'left';
    const zoom = store.zoom;
    const cRect = canvas.getBoundingClientRect();

    const screenRect = {
      left: cRect.left + pt.x * zoom,
      top: cRect.top + pt.y * zoom,
      width: Math.max(160, Math.round(180 * Math.min(2, Math.max(0.85, zoom)))),
      height: Math.max(36, Math.round((fontSize * 1.45 + 16) * zoom))
    };

    openInlineEditor({
      rect: screenRect,
      value: '',
      fontSize: fontSize * zoom,
      fontFamily,
      color: textColor,
      backgroundColor: textBgColor,
      textAlign,
      padding: 8 * zoom,
      placeholder: 'Type text… (Enter to finish, Shift+Enter for new line)',
      selectAllOnOpen: false,
      onCommit: (rawText: string) => {
        const cleaned = rawText.replace(/\r\n/g, '\n');
        if (cleaned.trim().length === 0) {
          onNeedRepaint();
          return;
        }
        const textAnn = textTool.createTextAnnotation(
          pt,
          pageIndex,
          defaultLayerId,
          cleaned,
          fontSize,
          fontFamily,
          textColor,
          textBgColor,
          textAlign
        );
        history.execute(new AddAnnotationCommand(pageIndex, textAnn));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(textAnn.id);
        onNeedRepaint();
      },
      onCancel: () => {
        onNeedRepaint();
      }
    });
  }

  /**
   * Opens the floating inline text editor directly over an existing
   * TextAnnotation (`ann`), hiding its canvas render while editing and
   * committing a single `ModifyAnnotationCommand` (or deleting if emptied).
   */
  public editExistingTextAnnotation(
    ann: TextAnnotation,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    const zoom = store.zoom;
    const cRect = canvas.getBoundingClientRect();
    const pad = ann.padding ?? 8;

    const screenRect = {
      left: cRect.left + ann.box.x * zoom,
      top: cRect.top + ann.box.y * zoom,
      width: Math.max(140, ann.box.width * zoom),
      height: Math.max(34, ann.box.height * zoom)
    };

    annotationEngine.setEditingAnnotationId(ann.id);
    onNeedRepaint();

    openInlineEditor({
      rect: screenRect,
      value: ann.text,
      fontSize: ann.fontSize * zoom,
      fontFamily: ann.fontFamily || 'Inter',
      color: ann.color || '#111827',
      backgroundColor: ann.backgroundColor || 'transparent',
      textAlign: ann.textAlign || 'left',
      padding: pad * zoom,
      selectAllOnOpen: true,
      onCommit: (rawText: string) => {
        annotationEngine.setEditingAnnotationId(null);
        const cleaned = rawText.replace(/\r\n/g, '\n');
        if (cleaned.trim().length === 0) {
          history.execute(new DeleteAnnotationsCommand(pageIndex, [ann]));
          store.clearSelection();
          onNeedRepaint();
          return;
        }
        if (cleaned !== ann.text) {
          const measured = textTool.measureTextBox(
            cleaned,
            ann.fontSize,
            ann.fontFamily,
            pad,
            ann.fontWeight,
            ann.fontStyle
          );
          const next: TextAnnotation = {
            ...ann,
            text: cleaned,
            box: {
              x: ann.box.x,
              y: ann.box.y,
              width: measured.width,
              height: measured.height
            },
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, ann, next));
        }
        onNeedRepaint();
      },
      onCancel: () => {
        annotationEngine.setEditingAnnotationId(null);
        onNeedRepaint();
      }
    });
  }

  /**
   * Opens the floating inline text editor seamlessly inside an expanded
   * StickyNoteAnnotation card while keeping the note's card background,
   * top-right collapse button, author footer, and freehand strokes visible.
   */
  public editExistingStickyNote(
    ann: StickyNoteAnnotation,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    if (ann.collapsed) return;
    const zoom = store.zoom;
    const cRect = canvas.getBoundingClientRect();
    const padX = 16;
    const headerH = 36;
    const footerH = 34;

    const screenRect = {
      left: cRect.left + (ann.box.x + padX) * zoom,
      top: cRect.top + (ann.box.y + headerH) * zoom,
      width: Math.max(90, (ann.box.width - padX * 2) * zoom),
      height: Math.max(48, (ann.box.height - headerH - footerH) * zoom)
    };

    annotationEngine.setEditingAnnotationId(ann.id);
    onNeedRepaint();

    openInlineEditor({
      rect: screenRect,
      value: ann.text || '',
      fontSize: (ann.fontSize || 24) * zoom,
      fontFamily: ann.fontFamily || 'Inter',
      color: ann.textColor || '#3b2f1e',
      backgroundColor: 'transparent',
      textAlign: ann.textAlign || 'left',
      padding: 4 * zoom,
      placeholder: '',
      selectAllOnOpen: false,
      multilineEnter: true,
      fixedSize: true,
      seamlessCard: true,
      onCommit: (rawText: string) => {
        annotationEngine.setEditingAnnotationId(null);
        const cleaned = rawText.replace(/\r\n/g, '\n');
        const latestDoc = store.activeDocument;
        const latestAnn = latestDoc?.annotations[pageIndex]?.find(
          (a): a is StickyNoteAnnotation => a.id === ann.id && a.type === 'sticky-note'
        ) || ann;
        if (cleaned !== latestAnn.text) {
          const next: StickyNoteAnnotation = {
            ...latestAnn,
            text: cleaned,
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, latestAnn, next));
        }
        onNeedRepaint();
      },
      onCancel: () => {
        annotationEngine.setEditingAnnotationId(null);
        onNeedRepaint();
      }
    });
  }

  /**
   * Opens the floating inline text editor inside an expanded Sticky Note to
   * add a new embedded TextAnnotation (`note.items`) clipped to the note card.
   */
  public beginNewTextInStickyNote(
    note: StickyNoteAnnotation,
    pt: Point,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    const tSettings = store.toolSettings;
    const defaultLayerId = 'layer-default';
    const fontSize = this.lensWidth(tSettings.fontSize || 16);
    const fontFamily = tSettings.fontFamily || 'Inter';
    const textColor = tSettings.textColor || note.textColor || '#3b2f1e';
    const textBgColor = tSettings.textBgColor || 'transparent';
    const textAlign = tSettings.textAlign || 'left';
    const zoom = store.zoom;
    const cRect = canvas.getBoundingClientRect();

    const maxW = Math.max(80, (note.box.x + note.box.width - pt.x - 8) * zoom);
    const screenRect = {
      left: cRect.left + pt.x * zoom,
      top: cRect.top + pt.y * zoom,
      width: Math.min(maxW, Math.max(120, Math.round(160 * Math.min(2, Math.max(0.85, zoom))))),
      height: Math.max(32, Math.round((fontSize * 1.45 + 14) * zoom))
    };

    openInlineEditor({
      rect: screenRect,
      value: '',
      fontSize: fontSize * zoom,
      fontFamily,
      color: textColor,
      backgroundColor: textBgColor,
      textAlign,
      padding: 6 * zoom,
      placeholder: '',
      selectAllOnOpen: false,
      onCommit: (rawText: string) => {
        const cleaned = rawText.replace(/\r\n/g, '\n');
        if (cleaned.trim().length === 0) {
          onNeedRepaint();
          return;
        }
        const textAnn = textTool.createTextAnnotation(
          pt,
          pageIndex,
          defaultLayerId,
          cleaned,
          fontSize,
          fontFamily,
          textColor,
          textBgColor,
          textAlign
        );
        const latestDoc = store.activeDocument;
        const latestNote = latestDoc?.annotations[pageIndex]?.find(
          (a): a is StickyNoteAnnotation => a.id === note.id && a.type === 'sticky-note'
        ) || note;
        const updatedNote: StickyNoteAnnotation = {
          ...latestNote,
          items: [...(latestNote.items || []), textAnn],
          updatedAt: Date.now()
        };
        history.execute(new ModifyAnnotationCommand(pageIndex, latestNote, updatedNote));
        onNeedRepaint();
      },
      onCancel: () => {
        onNeedRepaint();
      }
    });
  }

  /**
   * Determines if a pointerdown at `pt` should use the active toolbar tool
   * inside an expanded Sticky Note mini-board on the page.
   */
  private findExpandedStickyNoteForInk(
    pt: Point,
    pageAnns: Annotation[],
    activeTool: ToolType
  ): {
    note: StickyNoteAnnotation;
    mode: 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text';
    shapeTool?: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';
  } | null {
    const isShape =
      activeTool === 'rectangle' ||
      activeTool === 'ellipse' ||
      activeTool === 'line' ||
      activeTool === 'arrow' ||
      activeTool === 'polygon' ||
      activeTool === 'freeform-shape';

    if (
      activeTool !== 'pen' &&
      activeTool !== 'highlighter' &&
      activeTool !== 'eraser' &&
      activeTool !== 'text' &&
      !isShape
    ) {
      return null;
    }

    for (let i = pageAnns.length - 1; i >= 0; i--) {
      const cand = pageAnns[i];
      if (cand.type === 'sticky-note' && !cand.collapsed && !cand.locked) {
        if (stickyNoteTool.hitTest(cand, pt) && !stickyNoteTool.hitTestCollapseButton(cand, pt)) {
          if (activeTool === 'pen') {
            return { note: cand, mode: 'pen' };
          }
          if (activeTool === 'highlighter') {
            return { note: cand, mode: 'highlighter' };
          }
          if (activeTool === 'text') {
            return { note: cand, mode: 'text' };
          }
          if (isShape) {
            return { note: cand, mode: 'shape', shapeTool: activeTool };
          }
          if (activeTool === 'eraser') {
            // Inside an expanded Sticky Note, the Eraser always erases inside the note
            // (strokes and embedded items) rather than deleting the Sticky Note card itself.
            return { note: cand, mode: 'eraser' };
          }
        }
        break;
      }
    }
    return null;
  }

  /**
   * Live-erases freehand strokes and embedded shape/text items inside a Sticky Note
   * that are touched by `points`.
   */
  private applyStickyNoteEraser(points: Point[], pageIndex: number, noteId: string, radius: number): void {
    const doc = store.activeDocument;
    if (!doc?.annotations[pageIndex]) return;
    const idx = doc.annotations[pageIndex].findIndex(a => a.id === noteId && a.type === 'sticky-note');
    if (idx === -1) return;
    const note = doc.annotations[pageIndex][idx] as StickyNoteAnnotation;
    const origStrokes = note.strokes || [];
    const origItems = note.items || [];
    if (origStrokes.length === 0 && origItems.length === 0) return;

    let remainingStrokes = origStrokes;
    let remainingItems = origItems;

    for (const rawPt of points) {
      const localPt = note.rotation ? rotatePoint(rawPt, boxCenter(note.box), -note.rotation) : rawPt;
      remainingStrokes = remainingStrokes.filter(stroke => {
        const pad = (stroke.strokeWidth || 2) / 2;
        for (let i = 0; i < stroke.points.length; i++) {
          if (distance(localPt, stroke.points[i]) <= radius + pad) return false;
          if (i > 0 && distanceToSegment(localPt, stroke.points[i - 1], stroke.points[i]) <= radius + pad) return false;
        }
        return true;
      });
      if (remainingItems.length > 0) {
        remainingItems = remainingItems.filter(item => {
          if (item.type === 'line' || item.type === 'arrow' || item.type === 'polygon' || item.type === 'freeform-shape') {
            const pts = item.points && item.points.length >= 2
              ? item.points
              : [{ x: item.box.x, y: item.box.y }, { x: item.box.x + item.box.width, y: item.box.y + item.box.height }];
            const pad = (item.strokeWidth || 2) / 2;
            for (let i = 0; i < pts.length; i++) {
              if (distance(localPt, pts[i]) <= radius + pad) return false;
              if (i > 0 && distanceToSegment(localPt, pts[i - 1], pts[i]) <= radius + pad) return false;
            }
            if (item.type === 'polygon' && pts.length >= 3) {
              if (distanceToSegment(localPt, pts[pts.length - 1], pts[0]) <= radius + pad) return false;
            }
            return true;
          }
          const b = item.box;
          const expanded = {
            x: b.x - radius,
            y: b.y - radius,
            width: b.width + radius * 2,
            height: b.height + radius * 2
          };
          return !(
            localPt.x >= expanded.x &&
            localPt.x <= expanded.x + expanded.width &&
            localPt.y >= expanded.y &&
            localPt.y <= expanded.y + expanded.height
          );
        });
      }
    }

    if (remainingStrokes.length !== origStrokes.length || remainingItems.length !== origItems.length) {
      doc.annotations[pageIndex][idx] = {
        ...note,
        strokes: remainingStrokes,
        items: remainingItems,
        updatedAt: Date.now()
      };
      doc.lastModifiedAt = Date.now();
    }
  }

  /** Page coordinates for events that do not draw, such as context menus. */
  public pagePointForEvent(e: MouseEvent, canvas: HTMLCanvasElement): Point {
    const rect = canvas.getBoundingClientRect();
    const zoom = store.zoom;
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    };
  }

  private getPointInPage(e: PointerEvent, canvas: HTMLCanvasElement): StrokePoint {
    const rect = (this._isPointerDown && this._activeCanvasRect && this._activeCanvasRect.width > 0)
      ? this._activeCanvasRect
      : canvas.getBoundingClientRect();
    const zoom = store.zoom;
    const rawX = (e.clientX - rect.left) / zoom;
    const rawY = (e.clientY - rect.top) / zoom;

    const tSettings = store.toolSettings;
    const now = performance.now();

    if (e.pointerType === 'mouse' && tSettings.mousePressureSimulation) {
      const dt = Math.max(4, now - (this._lastPointerTime || now));
      const dist = Math.hypot(e.clientX - (this._lastPointerX || e.clientX), e.clientY - (this._lastPointerY || e.clientY));
      const speed = dist / dt; // pixels per ms
      // Natural ballpoint/gel pen velocity-pressure mapping: subtle range [0.42 .. 0.76]
      const targetP = Math.max(0.42, Math.min(0.76, 0.74 - speed * 0.14));
      this._simulatedVelocityPressure = this._simulatedVelocityPressure * 0.80 + targetP * 0.20;
    } else {
      this._simulatedVelocityPressure = 0.5;
    }

    this._lastPointerTime = now;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;

    // Clamp raw stylus touch/lift spikes into [0.24, 1.0] and pass 'linear' here so
    // calculateStrokeWidth applies the selected pressureCurve once without double-exponentiating.
    const clampedRaw = (e.pressure !== undefined && e.pressure > 0)
      ? Math.max(0.24, Math.min(1.0, e.pressure))
      : e.pressure;

    const mappedPressure = PressureEngine.mapPressure(
      clampedRaw,
      'linear',
      tSettings.pressureSensitivityEnabled !== false,
      e.pointerType,
      tSettings.mousePressureSimulation,
      this._simulatedVelocityPressure
    );

    return {
      x: rawX,
      y: rawY,
      pressure: mappedPressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      time: now
    };
  }
}

export const pointerHandler = new PointerHandler();
