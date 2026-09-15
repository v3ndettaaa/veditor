/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType, ToolOptionKey, Annotation, BoundingBox, ShapeAnnotation } from '../core/types';
import { store } from '../core/store';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ReplaceAnnotationsCommand, BulkModifyCommand } from '../core/history';
import { mergeBoundingBoxes, computePointsBoundingBox, findNearestVertex } from '../utils/geometry';
import { resolveRenderDpr, clampRenderMultiplier } from '../utils/dpi';
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
  getAnnotationSelectionBox
} from '../annotations/selection';
import { floatingPropsBar } from '../ui/components/floating-props';

export class PointerHandler {
  private _isPointerDown: boolean = false;
  private _activePageIndex: number = -1;
  private _pageScratchCanvas: HTMLCanvasElement | null = null;
  private _pageScratchCtx: CanvasRenderingContext2D | null = null;
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
  /** Zoom-lens marquee drag corners, in page coordinates. */
  private _zoomMarqueeStart: Point | null = null;
  private _zoomMarqueeCurrent: Point | null = null;
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
  private static readonly HOLD_DELAY_MS = 400;
  /** Long enough that the three morph phases read as one gesture, not a flash. */
  private static readonly MORPH_MS = 260;
  private static readonly HOLD_RADIUS = 8;
  private static readonly HOLD_MIN_SIZE = 12;

  /**
   * Lens width compensation: while a zoom-lens is active, creation widths are
   * divided by (zoom / baseZoom) so tools feel identical on screen. Stored
   * data stays in PDF points, so exiting the lens shrinks the content.
   */
  private lensWidth(base: number): number {
    const f = store.zoomLensFactor;
    return f !== 1 ? base / f : base;
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

  /**
   * Backing-store multiplier matching the page canvases (target DPI, clamped
   * so a page's backing store never exceeds MAX_RENDER_DIMENSION). Live
   * previews and handle hit-tests must use the same scale as committed
   * rendering or they drift on HiDPI / custom-DPI displays.
   */
  private renderDpr(): number {
    const c = this._pageScratchCanvas;
    const target = resolveRenderDpr(store.appSettings.targetDPI);
    if (!c) return target;
    const cssW = parseFloat(c.style.width) || c.width;
    const cssH = parseFloat(c.style.height) || c.height;
    return clampRenderMultiplier(cssW, cssH, target);
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
    if (Math.hypot(box.width, box.height) < PointerHandler.HOLD_MIN_SIZE) return;
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

    // Morph: the raw ink stays put and fades while the fitted shape is drawn
    // over it with a sweeping outline, so the stroke reads as being
    // *straightened* rather than replaced. A short accent glow marks the
    // moment it locks in. Three overlapping phases, one tween:
    //   ink   1 -> 0 over t 0..0.55
    //   shape 0 -> 1 over t 0.25..1.0
    //   glow  fades out over t 0.6..1.0
    const accent = store.appSettings.accentColor || '#4f46e5';
    const shapeBox = preview.box;
    const sweepLength = Math.max(40, (shapeBox.width + shapeBox.height) * 2);

    this._morphHandle?.cancel();
    this._morphHandle = tween({
      durationMs: PointerHandler.MORPH_MS,
      // Linear master clock: the phase windows below are wall-clock fractions,
      // and a global ease-out would rush all three of them into the first
      // quarter of the gesture. Each phase eases itself instead.
      easing: (t) => t,
      onUpdate: (t) => {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        if (!c || !cv) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);

        // Phase A: the ink the user drew, fading out — slowly at first, so the
        // shape is seen to grow *out of* the stroke rather than replace it.
        const inkAlpha = 1 - easeOutCubic(Math.min(1, t / 0.55));
        if (inkAlpha > 0) {
          c.save();
          c.globalAlpha = inkAlpha;
          c.scale(renderScale, renderScale);
          renderLiveStroke(c, rawPts, rawColor, rawWidth, rawCurve, rawPressure, rawStrength);
          c.restore();
        }

        // Phase B: the shape, revealed along its outline.
        const shapeT = easeOutCubic(Math.max(0, Math.min(1, (t - 0.25) / 0.75)));
        if (shapeT > 0) {
          c.save();
          c.globalAlpha = shapeT;
          annotationEngine.renderSingleAnnotation(c, preview, renderScale);
          c.restore();

          // Sweeping outline on top of the plain shape: dash offset walks the
          // visible dash from the shape's start to its end.
          c.save();
          c.scale(renderScale, renderScale);
          c.strokeStyle = accent;
          c.lineWidth = 1.75 / Math.max(renderScale, 0.0001);
          c.lineCap = 'round';
          c.setLineDash([sweepLength, sweepLength]);
          c.lineDashOffset = sweepLength * (1 - shapeT);
          c.strokeRect(shapeBox.x, shapeBox.y, shapeBox.width, shapeBox.height);
          c.restore();
        }

        // Phase C: accent halo that eases out as the shape settles.
        const glowT = easeOutCubic(Math.max(0, Math.min(1, (t - 0.6) / 0.4)));
        if (glowT < 1) {
          c.save();
          c.scale(renderScale, renderScale);
          c.globalAlpha = (1 - glowT) * 0.5;
          c.strokeStyle = accent;
          c.lineWidth = 3 / Math.max(renderScale, 0.0001);
          c.shadowColor = accent;
          c.shadowBlur = 12 * (1 - glowT);
          c.strokeRect(shapeBox.x, shapeBox.y, shapeBox.width, shapeBox.height);
          c.restore();
        }
      },
      onComplete: () => {
        this._morphHandle = null;
        // Settle on the final shape so nothing flickers when the tween ends.
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        if (!c || !cv) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);
        c.save();
        c.scale(renderScale, renderScale);
        annotationEngine.renderSingleAnnotation(c, preview, renderScale);
        c.restore();
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

    this._isPointerDown = true;
    this._activePageIndex = pageIndex;
    this._pageScratchCanvas = scratchCanvas;
    this._pageScratchCtx = scratchCanvas.getContext('2d');
    this._lastPointerTime = Date.now();
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

    const defaultLayerId = 'layer-default';

    switch (tool) {
      case 'zoom-lens':
        this._zoomMarqueeStart = { x: pt.x, y: pt.y };
        this._zoomMarqueeCurrent = { x: pt.x, y: pt.y };
        break;

      case 'pen': {
        penTool.start(
          pt,
          pageIndex,
          tSettings.penColor,
          this.lensWidth(tSettings.penWidth),
          tSettings.pressureCurve,
          tSettings.pressureSensitivityEnabled !== false,
          tSettings.pressureStrength || 'balanced',
          tSettings.strokeSmoothing || 'medium'
        );
        this.startHoldTimer({ x: pt.x, y: pt.y });
        break;
      }

      case 'highlighter': {
        highlighterTool.start(
          pt,
          pageIndex,
          tSettings.highlighterColor,
          this.lensWidth(tSettings.highlighterWidth),
          tSettings.highlighterBlendMode,
          tSettings.highlighterStraightLine,
          tSettings.highlighterTipShape,
          tSettings.highlighterOpacity ?? 0.45
        );
        break;
      }

      case 'eraser': {
        eraserTool.start(pt, this.lensWidth(tSettings.eraserWidth) / 2, tSettings.eraserMode);
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
            if (this._pageScratchCtx) {
              this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
            }
            onNeedRepaint();
            return;
          }
          if (this._pageScratchCtx) {
            this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
            shapesTool.renderScratchpad(this._pageScratchCtx, store.zoom * (this.renderDpr()));
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
          tSettings.shapeOutline !== false
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
          tSettings.shapeOutline !== false
        );
        break;
      }

      case 'text': {
        const textAnn = textTool.createTextAnnotation(
          pt,
          pageIndex,
          defaultLayerId,
          'Double click to edit text',
          this.lensWidth(tSettings.fontSize),
          tSettings.fontFamily,
          tSettings.textColor,
          tSettings.textBgColor,
          tSettings.textAlign
        );
        history.execute(new AddAnnotationCommand(pageIndex, textAnn));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(textAnn.id);
        onNeedRepaint();
        break;
      }

      case 'stamp':
        const stampBase = stampTool.createPresetStamp(pt, pageIndex, defaultLayerId, tSettings.stampPreset || 'APPROVED');
        // Fixed-size stamps must shrink in page units while lens-zoomed so
        // they land at the same on-screen size.
        if (store.zoomLensFactor !== 1) {
          const f = store.zoomLensFactor;
          stampBase.box = {
            ...stampBase.box,
            x: pt.x - stampBase.box.width / 2 / f,
            y: pt.y - stampBase.box.height / 2 / f,
            width: stampBase.box.width / f,
            height: stampBase.box.height / f
          };
        }
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
        const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));

        // Ctrl/Cmd-click adds to the selection exactly like Shift-click, so it
        // must not start a drag — otherwise multi-selecting for bulk delete
        // is impossible once something is already selected.
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        // 1. Grab a transform handle or the selection body to start a drag.
        if (selected.length > 0 && !additive) {
          const merged = mergeBoundingBoxes(selected.map(getAnnotationSelectionBox));
          // Lone rotated annotations hit-test in their rotated frame.
          const singleRot = selected.length === 1 ? selected[0].rotation || 0 : 0;
          const hit = selectionManager.hitTestHandles(
            pt, merged, store.zoom * (this.renderDpr()), singleRot
          );
          if (hit) {
            const originals = new Map(selected.map(a => [a.id, cloneAnnotation(a)] as [string, Annotation]));
            // Resizing a rotated annotation works in its unrotated frame.
            const startPt = singleRot && hit !== 'body' && hit !== 'rot'
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
            break;
          }
        }

        // 2. Click an annotation to (multi-)select it.
        const ann = selectionManager.findAnnotationAtPoint(pt, pageAnns);
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
      const ctx = scratchCanvas.getContext('2d');
      if (ctx) {
        const hoverPt = this.getPointInPage(e, scratchCanvas);
        const placed = this.snapToVertex(hoverPt, pageIndex);
        shapesTool.move(placed, e.shiftKey, e.shiftKey || this.toolOpt('polygon', 'snapAngle15'));
        ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
        shapesTool.renderScratchpad(ctx, store.zoom * this.renderDpr());
        this.renderSnapTarget(ctx, store.zoom * this.renderDpr());
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

    // Clear scratchpad canvas once per frame
    ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);

    const dpr = this.renderDpr();
    const renderScale = store.zoom * dpr;
    const pts = coalescedEvents.map((evt: PointerEvent) => this.getPointInPage(evt, scratchCanvas));
    if (pts.length === 0) return;
    const lastPt = pts[pts.length - 1];
    const shiftKey = (e as MouseEvent).shiftKey === true;

    switch (tool) {
      case 'select': {
        if (this._selectDrag && this._selectDrag.pageIndex === pageIndex) {
          // Absolute transform from drag start applied to pristine originals:
          // idempotent per frame, zero drift.
          const drag = this._selectDrag;
          const doc = store.activeDocument;
          if (doc?.annotations[pageIndex]) {
            if (drag.mode === 'rotate') {
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
          this.growLasso(pts, pageIndex, ctx, renderScale);
        } else if (this._marquee && this._marquee.pageIndex === pageIndex) {
          this._marquee.current = { ...lastPt };
          this.renderMarquee(ctx, renderScale);
        }
        break;
      }

      case 'lasso': {
        this.growLasso(pts, pageIndex, ctx, renderScale);
        break;
      }

      case 'zoom-lens':
        this._zoomMarqueeCurrent = { ...lastPt };
        this.renderZoomMarquee(ctx, renderScale);
        break;

      case 'pen':
        for (const pt of pts) penTool.move(pt);
        // Draw-and-hold: moving past the hold radius restarts (or cancels a
        // fired preview back to ink); stillness lets the timer snap.
        if (this._holdAnchor && Math.hypot(lastPt.x - this._holdAnchor.x, lastPt.y - this._holdAnchor.y) > PointerHandler.HOLD_RADIUS) {
          this._holdFired = false;
          this._holdShape = null;
          this._morphHandle?.cancel();
          this._morphHandle = null;
          this.startHoldTimer({ x: lastPt.x, y: lastPt.y });
        }
        if (this._holdFired && this._holdShape) {
          const preview = this.buildHoldShapeAnnotation(this._holdShape, pageIndex, 'layer-default');
          if (preview) annotationEngine.renderSingleAnnotation(ctx, preview, renderScale);
        } else {
          penTool.renderScratchpad(ctx, renderScale);
        }
        break;

      case 'highlighter':
        for (const pt of pts) highlighterTool.move(pt, shiftKey);
        highlighterTool.renderScratchpad(ctx, renderScale);
        break;

      case 'eraser':
        eraserTool.move(lastPt);
        // Direct document mutation + single canvas repaint: zero history,
        // zero store.notify per frame. The whole drag commits as ONE undo
        // step on pointer-up (see commitEraserSession).
        this.applyEraserDirect(pts, pageIndex);
        onNeedRepaint();
        // Single preview ring at the live position — drawing one per
        // coalesced sub-event left a trail of stale circles behind the cursor.
        eraserTool.renderScratchpad(ctx, lastPt, renderScale);
        break;

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
        shapesTool.renderScratchpad(ctx, renderScale);
        if (magnetic) this.renderSnapTarget(ctx, renderScale);
        break;
      }

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        for (const pt of pts) measureTool.move(pt);
        measureTool.renderScratchpad(ctx, renderScale);
        break;

      case 'redaction':
        for (const pt of pts) redactionTool.move(pt);
        redactionTool.renderScratchpad(ctx, renderScale);
        break;
    }
  }

  public handlePointerUp(
    _e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: () => void,
    onZoomLens?: (pageIndex: number, rect: { x: number; y: number; width: number; height: number }) => void
  ): void {
    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    this._isPointerDown = false;
    const tool = this._strokeTool ?? store.activeTool;
    const defaultLayerId = 'layer-default';

    if (tool === 'zoom-lens') {
      const s = this._zoomMarqueeStart;
      const c = this._zoomMarqueeCurrent;
      this._zoomMarqueeStart = null;
      this._zoomMarqueeCurrent = null;
      this._strokeTool = null;
      if (s && c) {
        const w = Math.abs(c.x - s.x);
        const h = Math.abs(c.y - s.y);
        // Tiny drags are clicks, not zooms.
        if (w >= 8 && h >= 8) {
          onZoomLens?.(pageIndex, {
            x: Math.min(s.x, c.x),
            y: Math.min(s.y, c.y),
            width: w,
            height: h
          });
        }
      }
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
      }
      this._activePageIndex = -1;
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
      return;
    }

    if (tool === 'polygon') {
      this._isPointerDown = false;
      this._strokeTool = null;
      // Polygons remain active across clicks until closed or completed
      if (this._pageScratchCtx && shapesTool.isPolygonActive()) {
        shapesTool.renderScratchpad(this._pageScratchCtx, store.zoom * (this.renderDpr()));
      }
      return;
    }

    // Clear scratchpad canvas
    if (this._pageScratchCtx) {
      this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    }

    switch (tool) {
      case 'select':
      case 'lasso':
        this.commitSelectDrag();
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
            if (!mq.additive) store.clearSelection();
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
      if (polyAnn) {
        history.execute(new AddAnnotationCommand(pageIndex, polyAnn));
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

  /** Aborts an in-progress zoom marquee without zooming. Returns true if one was active. */
  public cancelZoomMarquee(): boolean {
    if (!this._zoomMarqueeStart) return false;
    this._zoomMarqueeStart = null;
    this._zoomMarqueeCurrent = null;
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

  /** Renders the dashed marquee rect for the zoom-lens drag. */
  private renderZoomMarquee(ctx: CanvasRenderingContext2D, scale: number): void {
    const s = this._zoomMarqueeStart;
    const c = this._zoomMarqueeCurrent;
    if (!s || !c) return;
    ctx.save();
    ctx.scale(scale, scale);
    const x = Math.min(s.x, c.x);
    const y = Math.min(s.y, c.y);
    const w = Math.abs(c.x - s.x);
    const h = Math.abs(c.y - s.y);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#6366f1';
    // Constant on-screen dash width regardless of zoom.
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([6 / scale, 4 / scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
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

  public handleHover(e: PointerEvent, pageIndex: number, canvas: HTMLCanvasElement): void {
    if (store.selectedAnnotationIds.size === 0 || !floatingPropsBar) return;

    const doc = store.activeDocument;
    if (!doc) return;
    const pageAnns = doc.annotations[pageIndex] || [];
    const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
    if (selected.length === 0) return;

    const pt = this.getPointInPage(e, canvas);
    const merged = mergeBoundingBoxes(selected.map(getAnnotationSelectionBox));
    const singleRot = selected.length === 1 ? selected[0].rotation || 0 : 0;
    const hit = selectionManager.hitTestHandles(
      pt, merged, store.zoom * (this.renderDpr()), singleRot
    );

    const isNearOrOver = hit !== null || (
      pt.x >= merged.x - 10 &&
      pt.x <= merged.x + merged.width + 10 &&
      pt.y >= merged.y - 10 &&
      pt.y <= merged.y + merged.height + 10
    );

    floatingPropsBar.setHoverState(isNearOrOver);
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
      this._zoomMarqueeStart = null;
      this._zoomMarqueeCurrent = null;
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
  private applyEraserDirect(points: Point[], pageIndex: number): void {
    const doc = store.activeDocument;
    if (!doc || points.length === 0) return;
    if (!doc.annotations[pageIndex]) return;

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
    }
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
    const rect = canvas.getBoundingClientRect();
    const zoom = store.zoom;
    const rawX = (e.clientX - rect.left) / zoom;
    const rawY = (e.clientY - rect.top) / zoom;

    const tSettings = store.toolSettings;
    const now = Date.now();

    if (e.pointerType === 'mouse' && tSettings.mousePressureSimulation) {
      const dt = Math.max(8, now - (this._lastPointerTime || now));
      const dist = Math.hypot(e.clientX - (this._lastPointerX || e.clientX), e.clientY - (this._lastPointerY || e.clientY));
      const speed = dist / dt; // pixels per ms
      // Faster drawing -> thinner stroke (lower pressure), slower drawing -> thicker stroke
      const targetP = Math.max(0.2, Math.min(0.9, 0.85 - speed * 0.35));
      this._simulatedVelocityPressure = this._simulatedVelocityPressure * 0.65 + targetP * 0.35;
    } else {
      this._simulatedVelocityPressure = 0.5;
    }

    this._lastPointerTime = now;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;

    const mappedPressure = PressureEngine.mapPressure(
      e.pressure,
      tSettings.pressureCurve,
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
