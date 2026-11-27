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
import { renderLiveStroke, calculateStrokeWidth } from '../annotations/spline';
import {
  getLowLatency2DContext,
  OneEuroStrokeFilter,
  StreamingInkRenderer,
  StreamingHighlighterRenderer
} from '../annotations/ink-engine';
import { computeStickyResizePreview } from '../annotations/resize-preview';
import { tween, easeOutCubic, type TweenHandle } from '../utils/tween';
import { annotationEngine } from '../annotations/engine';
import { PressureEngine } from './pressure';
import { palmRejection } from './palm-rejection';
import { penTool } from '../annotations/tools/pen';
import { highlighterTool } from '../annotations/tools/highlighter';
import { eraserTool } from '../annotations/tools/eraser';
import { shapesTool } from '../annotations/tools/shapes';
import { textTool } from '../annotations/tools/text';
import {
  stickyNoteTool,
  getStickyNoteLayoutMetrics,
  computeViewportStickyNoteBox,
  findExpandedStickyNoteTarget,
  eraseStickyNoteContent,
  hitTestStickyNoteEmbeddedItem
} from '../annotations/tools/sticky-note';
import { stampTool } from '../annotations/tools/stamp';
import { measureTool } from '../annotations/tools/measure';
import { pdfEngine } from '../core/pdf-engine';
import { resolveAnnotationFontFamily } from '../core/fonts';
import {
  hitTestPageTextPoint,
  getTextRangeRects,
  getSelectedTextFromRange,
  computeUnionBounds,
} from '../core/pdf-text-layout';
import {
  selectionManager,
  normalizeDragBox,
  cloneAnnotation,
  transformAnnotation,
  computeSelectionBoxTransform,
  computeVertexResizeTransform,
  rotatePoint,
  boxCenter,
  BoxTransform,
  HandleType,
  getAnnotationSelectionBox,
  moveAnnotationEndpoint,
  moveAnnotationVertex,
  embedAnnotationsInStickyNote,
  computeHandleLoupePlacement,
  resolveDraggedHandleTargetPoint
} from '../annotations/selection';
import { floatingPropsBar } from '../ui/components/floating-props';
import { openInlineEditor } from '../ui/components/inline-editor';
import { drawingCursorValue } from '../ui/cursor';
import { isElectron } from '../core/platform';

export class PointerHandler {
  private _isPointerDown: boolean = false;
  private _activePageIndex: number = -1;
  private _lastHoverTarget: { pageIndex: number; canvas: HTMLCanvasElement; pt: Point } | null = null;
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
  /** Batched eraser sweep points queued between rAF frames so 120–240Hz pointermove never stalls the main thread. */
  private _eraserPendingPts: Point[] = [];
  private _eraserPointerType: string = 'mouse';
  private _stickyEraserPendingPts: Point[] = [];
  private _stickyEraserPendingNoteId: string | null = null;
    /**
   * Selection drag: moving the selection body or resizing via a transform
   * handle. Mutates live (like the eraser) and commits ONE undo step.
   */
  private _selectDrag: {
    mode: 'move' | 'resize' | 'rotate';
    handle: Exclude<HandleType, null>;
    pageIndex: number;
    originals: Map<string, Annotation>;
    originalsList: Annotation[];
    merged: BoundingBox;
    startPt: Point;
    lastPt: Point;
    shiftKey: boolean;
    hasLifted: boolean;
  } | null = null;
  /**
   * GPU-composited drag sprite overlay for zero-lag move/rotate/collapsed-sticky-resize:
   * rasterized ONCE on lift, then moved/scaled purely via CSS `transform`
   * on the compositor thread (0ms Canvas2D re-rasterization per frame).
   */
  private _dragOverlay: {
    canvas: HTMLCanvasElement;
    pageIndex: number;
    centerCssX: number;
    centerCssY: number;
    spriteBox: BoundingBox;
    isResize: boolean;
  } | null = null;
  /** Offscreen interior content sprite cached once on expanded sticky-note resize lift. */
  private _stickyResizeContentSprite: {
    canvas: HTMLCanvasElement;
    origBox: BoundingBox;
    origHeaderHeight: number;
    spriteScale: number;
    noteId: string;
  } | null = null;
  /** Causal filter + O(1) append-only ink/highlighter streamers for lag-free Sticky Note writing. */
  private readonly _stickyStrokeFilter = new OneEuroStrokeFilter();
  private readonly _stickyInkRenderer = new StreamingInkRenderer();
  private readonly _stickyHighlighterRenderer = new StreamingHighlighterRenderer();
  /**
   * When true, dragging a rectangle's corner handle keeps 90° rectangular corners
   * (resizing the rectangle); when false (default), dragging a corner moves that
   * individual corner freely (holding Shift always toggles the opposite behavior).
   */
  private _rectCornerLockMode: boolean = false;
  /** Current page-space target coordinate of the active handle-drag magnifier loupe, or null. */
  private _activeLoupeTarget: Point | null = null;

  public get activeHandleLoupeTarget(): Point | null {
    return this._activeLoupeTarget;
  }

  public get rectCornerLockMode(): boolean {
    return this._rectCornerLockMode;
  }

  public setRectCornerLockMode(locked: boolean): void {
    this._rectCornerLockMode = locked;
  }
  /** Region-marquee rubber band (Shift extends the selection). */
  private _marquee: { pageIndex: number; start: Point; current: Point; additive: boolean } | null = null;
  /** Freehand lasso path (the Lasso tool, or Alt+drag in Select). */
  private _lasso: { pageIndex: number; points: Point[]; additive: boolean } | null = null;
  /** Active PDF text range selection drag when using the Select tool over document text. */
  private _textSelectDrag: {
    pageIndex: number;
    anchorOffset: number;
    currentOffset: number;
    previewSelection: {
      pageIndex: number;
      startOffset: number;
      endOffset: number;
      text: string;
      rects: BoundingBox[];
      bounds: BoundingBox;
    } | null;
  } | null = null;
  /** Drag-to-size or click-to-place state when creating a new Sticky Note. */
  private _stickyCreateDrag: { pageIndex: number; start: Point; current: Point } | null = null;
  /** Tracks active polygon creation inside an expanded Sticky Note mini-board. */
  private _activeStickyPolygonNoteId: string | null = null;
  /** Tracks active multi-point measure creation inside an expanded Sticky Note mini-board. */
  private _activeStickyMeasureNoteId: string | null = null;
  /** Cached shape vertices collected once on pointerdown to avoid scanning all page annotations on 240Hz pointermove. */
  private _cachedShapeVertices: Point[] | null = null;
  /** Active drag of an embedded item inside an already-selected expanded Sticky Note. */
  private _stickyItemDrag: {
    pageIndex: number;
    noteId: string;
    itemId: string;
    originalNote: StickyNoteAnnotation;
    originalItem: Annotation;
    startPt: Point;
    lastPt: Point;
    moved: boolean;
    hasLifted: boolean;
  } | null = null;
  /** Active in-note tool session (pen, highlighter, eraser, shape, or measure) clipped to an expanded Sticky Note. */
  private _activeStickyStroke: {
    pageIndex: number;
    noteId: string;
    mode: 'pen' | 'highlighter' | 'eraser' | 'shape' | 'measure';
    shapeTool?: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';
    measureTool?: 'measure-distance' | 'measure-angle' | 'measure-area';
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
    modified?: boolean;
    originalNote: StickyNoteAnnotation;
  } | null = null;
  /** Tracks whether a collapsed sticky note was already selected before pointerdown in Select mode. */
  private _wasCollapsedNoteSelectedOnDown: string | null = null;
  /** Tracks which Sticky Note is currently open in the floating inline text editor. */
  private _editingStickyNote: { pageIndex: number; noteId: string } | null = null;

  public get editingStickyNote(): { pageIndex: number; noteId: string } | null {
    return this._editingStickyNote;
  }

  /**
   * Draw-and-hold shape recognition (pen only): holding the pointer nearly
   * still briefly snaps the live stroke to a geometric primitive on lift.
   * Never runs on the move hot path — one timer, one fit per hold.
   */
  private _holdTimer: number | null = null;
  private _holdAnchor: Point | null = null;
  private _holdLastMoveMs: number = 0;
  private _holdFired: boolean = false;
  private _holdShape: FittedShape | null = null;
  private _hoverCursorSig: string = '';
  private _hoverCursorValue: string = '';
  /** Tracks a scratch canvas whose cursor was temporarily switched to the eraser circle for stylus barrel/inverted erasing. */
  private _stylusEraserCursorCanvas: HTMLCanvasElement | null = null;
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
  private _pendingScratchPaintFn: (() => void) | null = null;

  // Reusable zero-GC hot-path buffers & bound rAF callbacks (avoids 240Hz closure/array churn)
  private _movePtsBuffer: StrokePoint[] = [];
  private _predictedPtsBuffer: StrokePoint[] = [];
  private _liveHighlighterShiftKey: boolean = false;

  private readonly _livePenPaintFn = (): void => {
    if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
    const c = this._pageScratchCtx;
    const cv = this._pageScratchCanvas;
    const dpr = this.renderDpr();
    const rs = store.zoom * dpr;
    if (this._holdFired && this._holdShape) {
      penTool.hideTipOverlay();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      this._scratchDirtyRect = null;
      const preview = this.buildHoldShapeAnnotation(this._holdShape, this._activePageIndex, 'layer-default');
      if (preview) {
        this.withScratchOffset(c, cv, () => {
          annotationEngine.renderSingleAnnotation(c, preview, rs);
        });
      }
    } else {
      const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
      const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;
      penTool.renderScratchpadIncremental(c, cv, rs, ox, oy, this._predictedPtsBuffer);
      this.setScratchpadDirtyFromPageBox(penTool.getLiveBoundingBox(), rs);
    }
  };

  private readonly _liveHighlighterPaintFn = (): void => {
    if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
    const c = this._pageScratchCtx;
    const cv = this._pageScratchCanvas;
    const dpr = this.renderDpr();
    const rs = store.zoom * dpr;
    const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
    const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;
    const didIncremental = highlighterTool.renderScratchpadIncremental(
      c,
      cv,
      rs,
      ox,
      oy,
      this._liveHighlighterShiftKey
    );
    if (!didIncremental) {
      this.clearScratchpadDirty(c, cv);
      this.withScratchOffset(c, cv, () => {
        highlighterTool.renderScratchpad(c, rs);
      });
    }
    this.setScratchpadDirtyFromPageBox(highlighterTool.getLiveBoundingBox(), rs);
  };

  /**
   * Returns the set of annotation IDs currently lifted onto the scratchpad canvas
   * during an active select or sticky-note item drag on `pageIndex`, so `annotCanvas`
   * stays completely static for the entire drag with zero per-frame full-page repaints.
   */
  public getSelectDragExcludedIds(pageIndex: number): Set<string> | null {
    if (this._selectDrag && this._selectDrag.hasLifted && this._selectDrag.pageIndex === pageIndex) {
      return new Set(this._selectDrag.originals.keys());
    }
    if (this._stickyItemDrag && this._stickyItemDrag.hasLifted && this._stickyItemDrag.pageIndex === pageIndex) {
      return new Set([this._stickyItemDrag.noteId]);
    }
    return null;
  }

  private destroyDragOverlay(): void {
    const ov = this._dragOverlay;
    this._dragOverlay = null;
    if (ov) {
      if (ov.canvas.parentNode) {
        ov.canvas.parentNode.removeChild(ov.canvas);
      }
      ov.canvas.width = 0;
      ov.canvas.height = 0;
    }
    const sp = this._stickyResizeContentSprite;
    this._stickyResizeContentSprite = null;
    if (sp) {
      sp.canvas.width = 0;
      sp.canvas.height = 0;
    }
  }

  private createStickyResizeContentSprite(note: StickyNoteAnnotation): void {
    if (this._stickyResizeContentSprite) {
      this._stickyResizeContentSprite.canvas.width = 0;
      this._stickyResizeContentSprite.canvas.height = 0;
      this._stickyResizeContentSprite = null;
    }
    if (note.collapsed || typeof document === 'undefined') return;
    const hasText = Boolean((note.text || '').trim().length > 0);
    const hasStrokes = Array.isArray(note.strokes) && note.strokes.length > 0;
    const hasItems = Array.isArray(note.items) && note.items.length > 0;
    if (!hasText && !hasStrokes && !hasItems) return;

    const zoom = Math.max(store.zoom || 1, 0.05);
    const b = note.box;
    const cssW = Math.max(2, Math.ceil(b.width * zoom));
    const cssH = Math.max(2, Math.ceil(b.height * zoom));
    const dpr = resolveAdaptiveCanvasDpr(cssW, cssH, store.appSettings.targetDPI);
    const pixelW = Math.max(2, Math.round(cssW * dpr));
    const pixelH = Math.max(2, Math.round(cssH * dpr));

    const off = document.createElement('canvas');
    off.width = pixelW;
    off.height = pixelH;
    const ctx = off.getContext('2d');
    if (!ctx) return;

    const spriteScale = (pixelW / cssW) * zoom;
    ctx.save();
    ctx.translate(-b.x * spriteScale, -b.y * spriteScale);
    stickyNoteTool.renderCardInteriorOnly(ctx, note, spriteScale, false);
    ctx.restore();

    const origMetrics = getStickyNoteLayoutMetrics(b);
    this._stickyResizeContentSprite = {
      canvas: off,
      origBox: { ...b },
      origHeaderHeight: origMetrics.headerHeight,
      spriteScale,
      noteId: note.id
    };
  }

  private isGpuStickyResize(drag: NonNullable<PointerHandler['_selectDrag']>): boolean {
    if (drag.mode !== 'resize' || drag.originals.size !== 1) return false;
    const orig = drag.originalsList[0];
    if (!orig || orig.type !== 'sticky-note') return false;
    if (drag.handle === 'start' || drag.handle === 'end') return false;
    if (typeof drag.handle === 'string' && drag.handle.startsWith('vertex:')) return false;
    return true;
  }

  private createDragOverlay(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    scratchCanvas: HTMLCanvasElement,
    includeSelectionHandles: boolean = true,
    isResize: boolean = false
  ): boolean {
    this.destroyDragOverlay();
    const container = scratchCanvas.parentElement;
    if (!container || typeof document === 'undefined') return false;

    const zoom = Math.max(store.zoom || 1, 0.05);
    const spriteBox = this.computeSelectionDirtyBox(
      drag.merged,
      drag.originalsList,
      drag.mode === 'rotate' || Boolean(drag.originalsList[0]?.rotation)
    );
    const cssW = Math.max(2, Math.ceil(spriteBox.width * zoom));
    const cssH = Math.max(2, Math.ceil(spriteBox.height * zoom));
    const dpr = resolveAdaptiveCanvasDpr(cssW, cssH, store.appSettings.targetDPI);
    const pixelW = Math.max(2, Math.round(cssW * dpr));
    const pixelH = Math.max(2, Math.round(cssH * dpr));

    const overlay = document.createElement('canvas');
    overlay.className = isResize ? 'select-drag-overlay is-resize-preview' : 'select-drag-overlay';
    overlay.width = pixelW;
    overlay.height = pixelH;
    overlay.style.left = `${spriteBox.x * zoom}px`;
    overlay.style.top = `${spriteBox.y * zoom}px`;
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;

    const ctx = overlay.getContext('2d');
    if (!ctx) return false;

    const spriteScale = (pixelW / cssW) * zoom;
    ctx.save();
    ctx.translate(-spriteBox.x * spriteScale, -spriteBox.y * spriteScale);
    annotationEngine.renderCommittedAnnotations(ctx, drag.originalsList, [], spriteScale);
    if (includeSelectionHandles) {
      selectionManager.render(ctx, drag.originalsList, spriteScale);
    }
    ctx.restore();

    container.appendChild(overlay);
    const center = boxCenter(drag.merged);
    this._dragOverlay = {
      canvas: overlay,
      pageIndex: drag.pageIndex,
      centerCssX: (center.x - spriteBox.x) * zoom,
      centerCssY: (center.y - spriteBox.y) * zoom,
      spriteBox,
      isResize
    };
    return true;
  }

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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = this._scratchDirtyRect;
    if (d) {
      const x = Math.max(0, Math.floor(d.x) - 6);
      const y = Math.max(0, Math.floor(d.y) - 6);
      const w = Math.min(canvas.width - x, Math.ceil(d.width) + 12);
      const h = Math.min(canvas.height - y, Math.ceil(d.height) + 12);
      if (w > 0 && h > 0) {
        ctx.clearRect(x, y, w, h);
      }
      this._scratchDirtyRect = null;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
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
    this._pendingScratchPaintFn = null;
  }

  private armScratchRafTick(): void {
    this._scratchRafId = requestAnimationFrame(() => {
      if (this._scratchNeedsTrailingPaint) {
        this._scratchNeedsTrailingPaint = false;
        const fn = this._pendingScratchPaintFn;
        this._pendingScratchPaintFn = null;
        fn?.();
        // Stay armed for one more vsync so high-frequency pointermove events
        // arriving right after this frame coalesce cleanly without double-painting.
        this.armScratchRafTick();
      } else {
        this._scratchRafId = null;
      }
    });
  }

  /**
   * Executes the first paint immediately for zero initial latency, then
   * coalesces subsequent high-frequency pointermove redraws to strictly once
   * per display refresh frame (60/120Hz) using the latest callback closure.
   */
  private scheduleLiveInkPaint(paintFn: () => void): void {
    if (this._scratchRafId === null) {
      paintFn();
      this._scratchNeedsTrailingPaint = false;
      this._pendingScratchPaintFn = null;
      this.armScratchRafTick();
    } else {
      this._scratchNeedsTrailingPaint = true;
      this._pendingScratchPaintFn = paintFn;
    }
  }

  /**
   * Geometry vertices already on the page that a new shape point can snap to:
   * line/arrow/polygon/freeform points plus rectangle corners.
   */
  private collectShapeVertices(pageIndex: number): Point[] {
    const doc = store.activeDocument;
    if (!doc) return [];
    const out: Point[] = [];
    for (const a of (doc.annotations[pageIndex] || [])) {
      if (a.type === 'line' || a.type === 'arrow' || a.type === 'polygon' || a.type === 'freeform-shape') {
        const pts = (a as { points?: Point[] }).points;
        if (pts) for (const p of pts) out.push({ x: p.x, y: p.y });
      } else if (a.type === 'rectangle') {
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
    const vertices = this._cachedShapeVertices ?? this.collectShapeVertices(pageIndex);
    const hit = findNearestVertex(pt, vertices, tolPage);
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

  /** (Re)starts the draw-and-hold snap timer without churning timers during rapid motion. */
  private startHoldTimer(anchor: Point): void {
    if (this._holdAnchor) {
      this._holdAnchor.x = anchor.x;
      this._holdAnchor.y = anchor.y;
    } else {
      this._holdAnchor = { x: anchor.x, y: anchor.y };
    }
    this._holdLastMoveMs = performance.now();
    if (this._holdTimer === null) {
      this._holdTimer = window.setTimeout(() => this.onHoldTimerTick(), PointerHandler.HOLD_DELAY_MS);
    }
  }

  private onHoldTimerTick(): void {
    this._holdTimer = null;
    if (!this._isPointerDown || (this._strokeTool ?? store.activeTool) !== 'pen' || this._holdFired) return;
    const elapsed = performance.now() - this._holdLastMoveMs;
    const remaining = PointerHandler.HOLD_DELAY_MS - elapsed;
    if (remaining > 16) {
      this._holdTimer = window.setTimeout(() => this.onHoldTimerTick(), remaining);
      return;
    }
    this.onHoldFire();
  }

  private clearHoldTimer(): void {
    if (this._holdTimer !== null) {
      window.clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    this._holdAnchor = null;
    this._holdLastMoveMs = 0;
  }

  /** Fires while the pointer is still down: fits the live stroke once (page or sticky note). */
  private onHoldFire(): void {
    this._holdTimer = null;
    if (!this._isPointerDown || (this._strokeTool ?? store.activeTool) !== 'pen') return;
    if (this._holdFired) return;

    const stickyPen = this._activeStickyStroke?.mode === 'pen' ? this._activeStickyStroke : null;
    const pts = stickyPen ? stickyPen.points : penTool.getActivePoints();
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

    const stickyNote = stickyPen
      ? store.activeDocument?.annotations[this._activePageIndex]?.find(
          (a): a is StickyNoteAnnotation => a.id === stickyPen.noteId && a.type === 'sticky-note'
        )
      : undefined;

    const renderScale = store.zoom * this.renderDpr();
    const rawPts: StrokePoint[] = pts.map(p => ({ ...p }));
    const rawColor = stickyPen ? stickyPen.color : store.toolSettings.penColor;
    const rawWidth = stickyPen ? stickyPen.strokeWidth : this.lensWidth(store.toolSettings.penWidth);
    const rawCurve = store.toolSettings.pressureCurve;
    const rawPressure = store.toolSettings.pressureSensitivityEnabled !== false;
    const rawStrength = store.toolSettings.pressureStrength;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    penTool.clearLiveSurface(ctx, canvas);
    this.clearScratchpadDirty(ctx, canvas);

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

        const drawFrame = () => {
          const inkAlpha = 1 - easeOutCubic(Math.min(1, t / 0.4));
          if (inkAlpha > 0.01) {
            c.save();
            c.globalAlpha = inkAlpha;
            c.scale(renderScale, renderScale);
            renderLiveStroke(c, rawPts, rawColor, rawWidth, rawCurve, rawPressure, rawStrength);
            c.restore();
          }

          const settle = easeOutCubic(t);
          const scaleFactor = 1.06 - 0.06 * settle;
          c.save();
          c.globalAlpha = settle;
          c.scale(renderScale, renderScale);
          c.translate(shapeCx, shapeCy);
          c.scale(scaleFactor, scaleFactor);
          c.translate(-shapeCx, -shapeCy);
          annotationEngine.renderSingleAnnotation(c, preview, 1);
          c.restore();
        };

        this.withScratchOffset(c, cv, () => {
          if (stickyNote) {
            stickyNoteTool.withNoteClip(c, stickyNote, renderScale, drawFrame);
          } else {
            drawFrame();
          }
        });
      },
      onComplete: () => {
        this._morphHandle = null;
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        if (!c || !cv) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);
        this.withScratchOffset(c, cv, () => {
          if (stickyNote) {
            stickyNoteTool.withNoteClip(c, stickyNote, renderScale, () => {
              annotationEngine.renderSingleAnnotation(c, preview, renderScale);
            });
          } else {
            annotationEngine.renderSingleAnnotation(c, preview, renderScale);
          }
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
      return { ...base, type: 'rectangle', box: { ...fit.box }, cornerRadius: s.shapeCornerRadius ?? 0 };
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
      box: computePointsBoundingBox(fit.points, strokeWidth),
      cornerRadius: s.shapeCornerRadius ?? 0
    };
  }

  /**
   * Resolves the page dimensions (in page points) for boundary-aware Sticky Note expansion.
   */
  private getPageBounds(pageIndex: number, canvas?: HTMLCanvasElement): { width: number; height: number } {
    const pageMeta = store.activeDocument?.pages?.[pageIndex];
    if (pageMeta && pageMeta.width > 0 && pageMeta.height > 0) {
      const rot = (((store.pageRotations?.[pageIndex] ?? pageMeta.rotation ?? 0) % 360) + 360) % 360;
      const swapped = rot === 90 || rot === 270;
      return {
        width: swapped ? pageMeta.height : pageMeta.width,
        height: swapped ? pageMeta.width : pageMeta.height
      };
    }
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const zoom = store.zoom || 1;
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width / zoom, height: rect.height / zoom };
      }
    }
    return { width: 0, height: 0 };
  }

  public handlePointerDown(
    e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: (dirtyPageBox?: BoundingBox | null) => void
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
    this._pageScratchCtx = getLowLatency2DContext(renderCanvas);
    this._activeCanvasRect = scratchCanvas.getBoundingClientRect();
    this._scratchDirtyRect = null;
    this._predictedPtsBuffer.length = 0;
    this._eraserPendingPts.length = 0;
    this._stickyEraserPendingPts.length = 0;
    this._stickyEraserPendingNoteId = null;
    this._eraserPointerType = e.pointerType || 'mouse';
    this._lastPointerTime = performance.now();
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    this._simulatedVelocityPressure = 0.5;

    const pt = this.getPointInPage(e, scratchCanvas);
    let tool = store.activeTool;

    // Auto-detect stylus eraser tip / barrel button (buttons & 32 or button === 5)
    const isStylusEraser = this.isStylusEraserEvent(e);
    if (isStylusEraser) {
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
          this.restoreStylusEraserCursor(e);
          const nextNote = stickyNoteTool.collapseStickyNote(cand);
          history.execute(new ModifyAnnotationCommand(pageIndex, cand, nextNote));
          store.setActiveTool('select');
          store.selectAnnotation(cand.id);
          onNeedRepaint();
          return;
        }
        if (stickyNoteTool.hitTest(cand, pt)) {
          break;
        }
      }
    }

    // When erasing via the stylus eraser button/tip while another tool (e.g. Pen)
    // is active, switch the hardware OS cursor to the eraser circle immediately.
    if (isStylusEraser && store.activeTool !== 'eraser') {
      this._stylusEraserCursorCanvas = scratchCanvas;
      this.setCanvasCursor(scratchCanvas, this.getCachedDrawingCursor('eraser'));
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
        const existingEmbedded = hitTestStickyNoteEmbeddedItem(note, pt);
        if (existingEmbedded && existingEmbedded.type === 'text') {
          this.editEmbeddedTextInStickyNote(note, existingEmbedded, pageIndex, scratchCanvas, onNeedRepaint);
          return;
        }
        const clampedPt = stickyNoteTool.clampPointToNote(note, pt, 10);
        this.beginNewTextInStickyNote(note, clampedPt, pageIndex, scratchCanvas, onNeedRepaint);
        return;
      }

      if (mode === 'measure' && stickyTarget.measureTool) {
        const mTool = stickyTarget.measureTool;
        const clampedPt = stickyNoteTool.clampPointToNote(note, pt, 4);
        if (
          (mTool === 'measure-angle' || mTool === 'measure-area') &&
          measureTool.isMultiPointActive() &&
          this._activeStickyMeasureNoteId === note.id &&
          measureTool.activePageIndex === pageIndex &&
          measureTool.activeType === mTool
        ) {
          const completed = measureTool.addPoint(clampedPt);
          if (completed) {
            const measureAnn = measureTool.finish(defaultLayerId);
            if (measureAnn) {
              measureAnn.createdAt = stickyNoteTool.nextContentTimestamp(note);
              const updatedNote: StickyNoteAnnotation = {
                ...note,
                items: [...(note.items || []), measureAnn],
                updatedAt: Date.now()
              };
              history.execute(new ModifyAnnotationCommand(pageIndex, note, updatedNote));
            }
            this._activeStickyMeasureNoteId = null;
            this._activeStickyStroke = null;
            this._isPointerDown = false;
            this._strokeTool = null;
            this._activePageIndex = -1;
            if (this._pageScratchCtx && this._pageScratchCanvas) {
              this.clearScratchpadDirty(this._pageScratchCtx, this._pageScratchCanvas);
            }
            onNeedRepaint();
            return;
          }
          if (this._pageScratchCtx && this._pageScratchCanvas) {
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              stickyNoteTool.withNoteClip(c, note, rs, () => {
                measureTool.renderScratchpad(c, rs);
              });
            });
            this.setScratchpadDirtyFromPageBox({
              x: note.box.x - 24,
              y: note.box.y - 24,
              width: note.box.width + 48,
              height: note.box.height + 48
            }, rs);
          }
          return;
        }

        if (mTool === 'measure-angle' || mTool === 'measure-area') {
          this._activeStickyMeasureNoteId = note.id;
        }
        measureTool.start(clampedPt, pageIndex, mTool, tSettings.measureUnit, tSettings.measureScale, '#2563eb');
        this._activeStickyStroke = {
          pageIndex,
          noteId: note.id,
          mode: 'measure',
          measureTool: mTool,
          points: [clampedPt],
          color: '#2563eb',
          strokeWidth: 2,
          originalNote: cloneAnnotation(note)
        };
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            stickyNoteTool.withNoteClip(c, note, rs, () => {
              measureTool.renderScratchpad(c, rs);
            });
          });
          this.setScratchpadDirtyFromPageBox({
            x: note.box.x - 24,
            y: note.box.y - 24,
            width: note.box.width + 48,
            height: note.box.height + 48
          }, rs);
        }
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
                polyAnn.createdAt = stickyNoteTool.nextContentTimestamp(note);
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
                this.clearScratchpadDirty(this._pageScratchCtx, this._pageScratchCanvas);
              }
              onNeedRepaint();
              return;
            }
            if (this._pageScratchCtx && this._pageScratchCanvas) {
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas;
              const rs = store.zoom * this.renderDpr();
              this.clearScratchpadDirty(c, cv);
              this.withScratchOffset(c, cv, () => {
                stickyNoteTool.withNoteClip(c, note, rs, () => {
                  shapesTool.renderScratchpad(c, rs);
                });
              });
              this.setScratchpadDirtyFromPageBox({
                x: note.box.x - 16,
                y: note.box.y - 16,
                width: note.box.width + 32,
                height: note.box.height + 32
              }, rs);
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
            tSettings.shapeFillOpacity ?? 1.0,
            tSettings.shapeCornerRadius ?? 0
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
          tSettings.shapeFillOpacity ?? 1.0,
          tSettings.shapeCornerRadius ?? 0
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
        modified: false,
        originalNote: cloneAnnotation(note)
      };
      if (mode === 'eraser') {
        const radius = Math.max(8, tSettings.eraserWidth / 2);
        eraserTool.start(clampedPt, radius, tSettings.eraserMode);
        this._stickyEraserPendingNoteId = note.id;
        if (this.applyStickyNoteEraser([pt], pageIndex, note.id, radius, tSettings.eraserMode)) {
          this._activeStickyStroke.modified = true;
          const pad = 20;
          onNeedRepaint({
            x: note.box.x - pad,
            y: note.box.y - pad,
            width: note.box.width + pad * 2,
            height: note.box.height + pad * 2
          });
        }
        // On mouse/pen, the hardware OS cursor already renders the eraser circle at 0ms latency.
        // Only draw a canvas guide circle for touch input where no OS cursor exists.
        if (this._eraserPointerType === 'touch' && this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            stickyNoteTool.withNoteClip(c, note, rs, () => {
              eraserTool.renderScratchpad(c, clampedPt, rs);
            });
          });
          this.setScratchpadDirtyFromPageBox({
            x: clampedPt.x - radius - 4,
            y: clampedPt.y - radius - 4,
            width: (radius + 4) * 2,
            height: (radius + 4) * 2
          }, rs);
        }
      } else {
        if (mode === 'pen') {
          const rawSmoothing = this._activeStickyStroke.smoothing || 'medium';
          const normalizedSmoothing = rawSmoothing === 'light'
            ? 'subtle'
            : rawSmoothing === 'heavy'
              ? 'high'
              : rawSmoothing;
          this._stickyStrokeFilter.reset(normalizedSmoothing);
          const filteredStart = this._stickyStrokeFilter.filter(
            clampedPt.x,
            clampedPt.y,
            clampedPt.pressure ?? 0.5,
            clampedPt.time ?? performance.now(),
            Math.max(0.25, store.zoom),
            clampedPt.tiltX,
            clampedPt.tiltY
          );
          this._activeStickyStroke.points = [filteredStart];
          this._stickyInkRenderer.reset();
          this.startHoldTimer({ x: filteredStart.x, y: filteredStart.y });
        } else if (mode === 'highlighter') {
          this._stickyHighlighterRenderer.reset();
        }
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const dpr = this.renderDpr();
          const rs = store.zoom * dpr;
          const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
          const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;
          if (mode === 'pen') {
            this._stickyInkRenderer.render(
              c,
              cv,
              this._activeStickyStroke.points,
              strokeColor,
              strokeW,
              this._activeStickyStroke.pressureCurve || 'linear',
              this._activeStickyStroke.pressureEnabled !== false,
              this._activeStickyStroke.pressureStrength || 'balanced',
              rs,
              ox,
              oy,
              calculateStrokeWidth,
              null,
              null,
              (clipCtx) => stickyNoteTool.applyNoteClipPath(clipCtx, note)
            );
          } else if (mode === 'highlighter' && !this._activeStickyStroke.straightLine) {
            this._stickyHighlighterRenderer.render(
              c,
              cv,
              this._activeStickyStroke.points,
              strokeColor,
              strokeW,
              rs,
              ox,
              oy,
              (clipCtx) => stickyNoteTool.applyNoteClipPath(clipCtx, note)
            );
          } else {
            this.clearScratchpadDirty(c, cv);
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
          const pad = Math.max(12, strokeW + 8);
          this.setScratchpadDirtyFromPageBox({
            x: note.box.x - pad,
            y: note.box.y - pad,
            width: note.box.width + pad * 2,
            height: note.box.height + pad * 2
          }, rs);
        }
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
          const dpr = this.renderDpr();
          const rs = store.zoom * dpr;
          const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
          const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;
          penTool.renderScratchpadIncremental(c, cv, rs, ox, oy);
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
          const dpr = this.renderDpr();
          const rs = store.zoom * dpr;
          const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
          const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;
          this._liveHighlighterShiftKey = e.shiftKey === true;
          const didIncremental = highlighterTool.renderScratchpadIncremental(
            c,
            cv,
            rs,
            ox,
            oy,
            this._liveHighlighterShiftKey
          );
          if (!didIncremental) {
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              highlighterTool.renderScratchpad(c, rs);
            });
          }
          this.setScratchpadDirtyFromPageBox(highlighterTool.getLiveBoundingBox(), rs);
        }
        break;
      }

      case 'eraser': {
        eraserTool.start(pt, tSettings.eraserWidth / 2, tSettings.eraserMode);
        this.beginEraserSession(pageIndex);
        const dirtyBox = this.applyEraserDirect([pt], pageIndex);
        if (dirtyBox) {
          onNeedRepaint(dirtyBox);
        }
        if (this._eraserPointerType === 'touch' && this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          const livePt = eraserTool.getLiveBoundingBox();
          if (livePt) {
            this.withScratchOffset(c, cv, () => {
              eraserTool.renderScratchpad(c, pt, rs);
            });
            this.setScratchpadDirtyFromPageBox(livePt, rs);
          }
        }
        break;
      }

      case 'polygon': {
        const polySnap = e.shiftKey || this.toolOpt('polygon', 'snapAngle15');
        if (isElectron() && !this._cachedShapeVertices) {
          this._cachedShapeVertices = this.collectShapeVertices(pageIndex);
        }
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
            this._cachedShapeVertices = null;
            if (this._pageScratchCtx && this._pageScratchCanvas) {
              this.clearScratchpadDirty(this._pageScratchCtx, this._pageScratchCanvas);
              this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
            }
            onNeedRepaint();
            return;
          }
          if (this._pageScratchCtx && this._pageScratchCanvas) {
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            if (isElectron()) {
              this.clearScratchpadDirty(c, cv);
            } else {
              c.clearRect(0, 0, cv.width, cv.height);
            }
            this.withScratchOffset(c, cv, () => {
              shapesTool.renderScratchpad(c, rs);
            });
            if (isElectron()) {
              this.setScratchpadDirtyFromPageBox(shapesTool.getLiveBoundingBox(), rs);
            }
          }
          return;
        }

        this._snapTarget = null;
        if (isElectron()) {
          this._cachedShapeVertices = this.collectShapeVertices(pageIndex);
        }
        shapesTool.start(
          pt,
          pageIndex,
          'polygon',
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          this.lensWidth(tSettings.shapeWidth),
          tSettings.shapeStyle,
          tSettings.shapeOutline !== false,
          tSettings.shapeFillOpacity ?? 1.0,
          tSettings.shapeCornerRadius ?? 0
        );
        break;
      }

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'freeform-shape': {
        this._cachedShapeVertices = this.collectShapeVertices(pageIndex);
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
          tSettings.shapeFillOpacity ?? 1.0,
          tSettings.shapeCornerRadius ?? 0
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
            const pageBounds = this.getPageBounds(pageIndex, scratchCanvas);
            const expanded = stickyNoteTool.expandStickyNoteForPage(hit, pageBounds.width, pageBounds.height);
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

      case 'stamp': {
        const stampBase = stampTool.createPresetStamp(pt, pageIndex, defaultLayerId, tSettings.stampPreset || 'APPROVED');
        const targetNote = findExpandedStickyNoteTarget(pageAnns, {
          point: pt,
          allowSelectedFallback: false
        });
        if (targetNote) {
          const { updatedNote, insertedItems } = embedAnnotationsInStickyNote(targetNote, [stampBase], pt);
          if (insertedItems.length > 0) {
            history.execute(new ModifyAnnotationCommand(pageIndex, targetNote, updatedNote));
            store.setActiveTool('select');
            this.selectCreatedAnnotation(targetNote.id);
            onNeedRepaint();
            break;
          }
        }
        history.execute(new AddAnnotationCommand(pageIndex, stampBase));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(stampBase.id);
        onNeedRepaint();
        break;
      }

      case 'measure-distance':
        measureTool.start(
          pt,
          pageIndex,
          tool,
          tSettings.measureUnit,
          tSettings.measureScale,
          '#2563eb'
        );
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          c.clearRect(0, 0, cv.width, cv.height);
          this.withScratchOffset(c, cv, () => {
            measureTool.renderScratchpad(c, store.zoom * this.renderDpr());
          });
        }
        break;

      case 'measure-angle':
      case 'measure-area': {
        if (measureTool.isMultiPointActive() && measureTool.activePageIndex === pageIndex && measureTool.activeType === tool) {
          const completed = measureTool.addPoint(pt);
          if (completed) {
            const measureAnn = measureTool.finish(defaultLayerId);
            if (measureAnn) {
              history.execute(new AddAnnotationCommand(pageIndex, measureAnn));
            }
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
              measureTool.renderScratchpad(c, store.zoom * this.renderDpr());
            });
          }
          return;
        }
        measureTool.start(
          pt,
          pageIndex,
          tool,
          tSettings.measureUnit,
          tSettings.measureScale,
          '#2563eb'
        );
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          c.clearRect(0, 0, cv.width, cv.height);
          this.withScratchOffset(c, cv, () => {
            measureTool.renderScratchpad(c, store.zoom * this.renderDpr());
          });
        }
        break;
      }

      case 'lasso': {
        // Freehand selection loop. Same session as Alt+drag in Select, so both
        // paths share the commit logic on pointer-up. Dropping the old
        // selection here would defeat the additive union on pointer-up, so it
        // only happens for a plain (non-additive) lasso.
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        // A press on the current selection's handles or body is a transform,
        // never a new lasso — the controls behave identically to Select.
        if (!additive && this.tryBeginSelectDrag(pt, pageIndex, scratchCanvas)) break;
        if (!additive) {
          store.clearSelection();
          store.setTextSelection(null);
        }
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
        if (!additive && this.tryBeginSelectDrag(pt, pageIndex, scratchCanvas)) {
          store.setTextSelection(null);
          break;
        }

        // 2. Click an annotation to (multi-)select it.
        const ann = hitBeforeDrag;
        if (ann) {
          store.setTextSelection(null);
          store.selectAnnotation(ann.id, additive);
          // On Electron, `store.selectAnnotation()` already notifies VeditorApp to
          // repaint visible pages — avoid a duplicate synchronous full-page repaint.
          if (!isElectron()) {
            onNeedRepaint();
          }
        } else if ((e as MouseEvent).altKey === true) {
          // 3a. Alt+drag: freehand lasso loop around arbitrary ink/shapes.
          store.setTextSelection(null);
          this._lasso = {
            pageIndex,
            points: [{ x: pt.x, y: pt.y }],
            additive
          };
        } else {
          // 3b. Check if the press starts on selectable PDF text.
          const textLayout = pdfEngine.getCachedPageTextLayout(pageIndex);
          const textHit = !additive && textLayout
            ? hitTestPageTextPoint(textLayout, pt.x, pt.y, 4, false)
            : null;
          if (textHit) {
            store.clearSelection();
            store.setTextSelection(null);
            this._textSelectDrag = {
              pageIndex,
              anchorOffset: textHit.charOffset,
              currentOffset: textHit.charOffset,
              previewSelection: null
            };
            onNeedRepaint();
          } else {
            // 3c. Empty press: rubber-band region select (tiny drag = click).
            if (!additive) store.setTextSelection(null);
            void pdfEngine.getPageTextLayout(pageIndex);
            this._marquee = {
              pageIndex,
              start: { x: pt.x, y: pt.y },
              current: { x: pt.x, y: pt.y },
              additive
            };
          }
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
  private tryBeginSelectDrag(pt: Point, pageIndex: number, scratchCanvas?: HTMLCanvasElement): boolean {
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

    // If a single expanded Sticky Note is already selected and the user grabs an
    // embedded item inside its body area, drag that inner item instead of moving the whole note card.
    if (
      hit === 'body' &&
      selected.length === 1 &&
      selected[0].type === 'sticky-note' &&
      !selected[0].collapsed &&
      !selected[0].locked &&
      stickyNoteTool.isPointInContentArea(selected[0], pt)
    ) {
      const embeddedHit = hitTestStickyNoteEmbeddedItem(selected[0], pt);
      if (embeddedHit) {
        this._stickyItemDrag = {
          pageIndex,
          noteId: selected[0].id,
          itemId: embeddedHit.id,
          originalNote: cloneAnnotation(selected[0]),
          originalItem: cloneAnnotation(embeddedHit),
          startPt: { x: pt.x, y: pt.y },
          lastPt: { x: pt.x, y: pt.y },
          moved: false,
          hasLifted: false
        };
        return true;
      }
    }

    const originals = new Map(selected.map(a => [a.id, cloneAnnotation(a)] as [string, Annotation]));
    const originalsList = selected.map(a => a);
    const isVertexHandle = typeof hit === 'string' && hit.startsWith('vertex:');
    // Resizing a rotated annotation works in its unrotated frame; vertex handles work in page space.
    const startPt =
      singleRot &&
      hit !== 'body' &&
      hit !== 'rot' &&
      hit !== 'start' &&
      hit !== 'end' &&
      !isVertexHandle
        ? rotatePoint(pt, boxCenter(merged), -singleRot)
        : { x: pt.x, y: pt.y };
    const mode = hit === 'body' ? 'move' : hit === 'rot' ? 'rotate' : 'resize';
    this._selectDrag = {
      mode,
      handle: hit,
      pageIndex,
      originals,
      originalsList,
      merged: { ...merged },
      startPt,
      lastPt: { x: pt.x, y: pt.y },
      shiftKey: false,
      hasLifted: false
    };
    if (isElectron()) {
      floatingPropsBar?.hideForProgrammaticSelection();
    }
    if (mode === 'resize') {
      const targetPt = resolveDraggedHandleTargetPoint(selected[0], hit, pt);
      this._activeLoupeTarget = targetPt;
      if (this._pageScratchCtx && this._pageScratchCanvas && scratchCanvas) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const rs = store.zoom * this.renderDpr();
        c.clearRect(0, 0, cv.width, cv.height);
        this.withScratchOffset(c, cv, () => {
          const loupeBox = this.renderHandleLoupe(c, scratchCanvas, pageIndex, targetPt, rs);
          this.setScratchpadDirtyFromPageBox(loupeBox, rs);
        });
      }
    } else {
      this._activeLoupeTarget = null;
    }
    return true;
  }

  public handlePointerMove(
    e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: (dirtyPageBox?: BoundingBox | null) => void
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
      if (isElectron()) {
        const renderCanvas = this.resolveRenderScratchCanvas(scratchCanvas);
        const ctx = getLowLatency2DContext(renderCanvas);
        if (!ctx) return;
        this._pageScratchCanvas = renderCanvas;
        this._pageScratchCtx = ctx;
        if (!this._cachedShapeVertices) {
          this._cachedShapeVertices = this.collectShapeVertices(pageIndex);
        }
        const hoverPt = this.getPointInPage(e, scratchCanvas);
        const shiftKey = e.shiftKey;
        const snapAngle = shiftKey || this.toolOpt('polygon', 'snapAngle15');
        this.scheduleLiveInkPaint(() => {
          if (this._isPointerDown || store.activeTool !== 'polygon' || !shapesTool.isPolygonActive() || shapesTool.activePageIndex !== pageIndex) {
            return;
          }
          const polyNote = this._activeStickyPolygonNoteId
            ? store.activeDocument?.annotations[pageIndex]?.find(
                (a): a is StickyNoteAnnotation => a.id === this._activeStickyPolygonNoteId && a.type === 'sticky-note'
              )
            : undefined;
          const placed = polyNote
            ? stickyNoteTool.clampPointToNote(polyNote, hoverPt, 2)
            : this.snapToVertex(hoverPt, pageIndex);
          shapesTool.move(placed, shiftKey, snapAngle);
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(ctx, renderCanvas);
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
          this.setScratchpadDirtyFromPageBox(shapesTool.getLiveBoundingBox(), rs);
        });
        return;
      }

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

    if (
      !this._isPointerDown &&
      (store.activeTool === 'measure-angle' || store.activeTool === 'measure-area') &&
      measureTool.isMultiPointActive() &&
      measureTool.activePageIndex === pageIndex
    ) {
      if (isElectron()) {
        const renderCanvas = this.resolveRenderScratchCanvas(scratchCanvas);
        const ctx = getLowLatency2DContext(renderCanvas);
        if (!ctx) return;
        this._pageScratchCanvas = renderCanvas;
        this._pageScratchCtx = ctx;
        this._activePageIndex = pageIndex;
        const hoverPt = this.getPointInPage(e, scratchCanvas);
        this.scheduleLiveInkPaint(() => {
          if (this._isPointerDown || !measureTool.isMultiPointActive() || measureTool.activePageIndex !== pageIndex) return;
          const measureNote = this._activeStickyMeasureNoteId
            ? store.activeDocument?.annotations[pageIndex]?.find(
                (a): a is StickyNoteAnnotation => a.id === this._activeStickyMeasureNoteId && a.type === 'sticky-note'
              )
            : undefined;
          const placed = measureNote ? stickyNoteTool.clampPointToNote(measureNote, hoverPt, 4) : hoverPt;
          measureTool.move(placed);
          ctx.clearRect(0, 0, renderCanvas.width, renderCanvas.height);
          const rs = store.zoom * this.renderDpr();
          this.withScratchOffset(ctx, renderCanvas, () => {
            if (measureNote) {
              stickyNoteTool.withNoteClip(ctx, measureNote, rs, () => {
                measureTool.renderScratchpad(ctx, rs);
              });
            } else {
              measureTool.renderScratchpad(ctx, rs);
            }
          });
        });
        return;
      }

      const renderCanvas = this.resolveRenderScratchCanvas(scratchCanvas);
      const ctx = renderCanvas.getContext('2d');
      if (ctx) {
        this._pageScratchCanvas = renderCanvas;
        this._pageScratchCtx = ctx;
        this._activePageIndex = pageIndex;
        const hoverPt = this.getPointInPage(e, scratchCanvas);
        const measureNote = this._activeStickyMeasureNoteId
          ? store.activeDocument?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === this._activeStickyMeasureNoteId && a.type === 'sticky-note'
            )
          : undefined;
        const placed = measureNote ? stickyNoteTool.clampPointToNote(measureNote, hoverPt, 4) : hoverPt;
        measureTool.move(placed);
        ctx.clearRect(0, 0, renderCanvas.width, renderCanvas.height);
        const rs = store.zoom * this.renderDpr();
        this.withScratchOffset(ctx, renderCanvas, () => {
          if (measureNote) {
            stickyNoteTool.withNoteClip(ctx, measureNote, rs, () => {
              measureTool.renderScratchpad(ctx, rs);
            });
          } else {
            measureTool.renderScratchpad(ctx, rs);
          }
        });
      }
      return;
    }

    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    const coalescedEvents: PointerEvent[] =
      typeof (e as any).getCoalescedEvents === 'function' ? (e as any).getCoalescedEvents() : [e];
    const tool = this._strokeTool ?? store.activeTool;
    const ctx = this._pageScratchCtx;
    if (!ctx) return;

    const pts = this._movePtsBuffer;
    pts.length = 0;
    const evCount = coalescedEvents.length;
    if (evCount === 0) {
      pts.push(this.getPointInPage(e, scratchCanvas));
    } else {
      for (let i = 0; i < evCount; i++) {
        pts.push(this.getPointInPage(coalescedEvents[i], scratchCanvas));
      }
    }
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
        if (s.mode === 'eraser') {
          const radius = Math.max(8, store.toolSettings.eraserWidth / 2);
          const clampedLast = stickyNoteTool.clampPointToNote(currentNote, lastPt, 2);
          eraserTool.move(clampedLast);
          for (let i = 0; i < pts.length; i++) {
            this._stickyEraserPendingPts.push({ x: pts[i].x, y: pts[i].y });
          }
          this._stickyEraserPendingNoteId = s.noteId;
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._activeStickyStroke || this._activeStickyStroke.mode !== 'eraser') return;
            const batch = this._stickyEraserPendingPts.splice(0, this._stickyEraserPendingPts.length);
            if (batch.length > 0) {
              const erasedAny = this.applyStickyNoteEraser(batch, pageIndex, s.noteId, radius, store.toolSettings.eraserMode);
              if (erasedAny) {
                s.modified = true;
                const pad = 20;
                onNeedRepaint({
                  x: currentNote.box.x - pad,
                  y: currentNote.box.y - pad,
                  width: currentNote.box.width + pad * 2,
                  height: currentNote.box.height + pad * 2
                });
              }
            }
            if (this._eraserPointerType === 'touch' && this._pageScratchCtx && this._pageScratchCanvas) {
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas;
              const rs = store.zoom * this.renderDpr();
              this.clearScratchpadDirty(c, cv);
              this.withScratchOffset(c, cv, () => {
                stickyNoteTool.withNoteClip(c, currentNote, rs, () => {
                  eraserTool.renderScratchpad(c, clampedLast, rs);
                });
              });
              this.setScratchpadDirtyFromPageBox({
                x: clampedLast.x - radius - 4,
                y: clampedLast.y - radius - 4,
                width: (radius + 4) * 2,
                height: (radius + 4) * 2
              }, rs);
            }
          });
        } else if (s.mode === 'measure' && s.measureTool) {
          const clamped = stickyNoteTool.clampPointToNote(currentNote, lastPt, 4);
          measureTool.move(clamped);
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              stickyNoteTool.withNoteClip(c, currentNote, rs, () => {
                measureTool.renderScratchpad(c, rs);
              });
            });
            this.setScratchpadDirtyFromPageBox({
              x: currentNote.box.x - 24,
              y: currentNote.box.y - 24,
              width: currentNote.box.width + 48,
              height: currentNote.box.height + 48
            }, rs);
          });
        } else if (s.mode === 'shape' && s.shapeTool) {
          if (s.shapeTool !== 'polygon') {
            const snapAngle = shiftKey || this.toolOpt(s.shapeTool, 'snapAngle15');
            const clamped = stickyNoteTool.clampPointToNote(currentNote, lastPt, Math.max(2, s.strokeWidth / 2));
            shapesTool.move(clamped, shiftKey, snapAngle);
          }
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              stickyNoteTool.withNoteClip(c, currentNote, rs, () => {
                shapesTool.renderScratchpad(c, rs);
              });
            });
            const pad = Math.max(16, s.strokeWidth + 8);
            this.setScratchpadDirtyFromPageBox({
              x: currentNote.box.x - pad,
              y: currentNote.box.y - pad,
              width: currentNote.box.width + pad * 2,
              height: currentNote.box.height + pad * 2
            }, rs);
          });
        } else {
          const effZoom = Math.max(0.25, store.zoom);
          const minDist = s.mode === 'pen'
            ? Math.min(0.18, 0.24 / Math.max(1, effZoom))
            : 0.65 / Math.max(1, effZoom);
          const isStraightHl = s.mode === 'highlighter' && (s.straightLine || shiftKey);
          for (const rawPt of pts) {
            const clamped = stickyNoteTool.clampPointToNote(currentNote, rawPt, 2);
            if (isStraightHl && s.points.length >= 1) {
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
              const rawDist = prev ? Math.hypot(clamped.x - prev.x, clamped.y - prev.y) : Infinity;
              if (rawDist >= minDist) {
                if (s.mode === 'pen') {
                  const filtered = this._stickyStrokeFilter.filter(
                    clamped.x,
                    clamped.y,
                    clamped.pressure ?? 0.5,
                    clamped.time ?? performance.now(),
                    effZoom,
                    clamped.tiltX,
                    clamped.tiltY
                  );
                  s.points.push(filtered);
                } else {
                  s.points.push(clamped);
                }
              }
            }
          }
          if (s.mode === 'pen') {
            const clampedLast = stickyNoteTool.clampPointToNote(currentNote, lastPt, 2);
            const holdRadiusPage = PointerHandler.HOLD_RADIUS / Math.max(store.zoom, 0.25);
            if (this._holdAnchor && Math.hypot(clampedLast.x - this._holdAnchor.x, clampedLast.y - this._holdAnchor.y) > holdRadiusPage) {
              this._holdFired = false;
              this._holdShape = null;
              this._morphHandle?.cancel();
              this._morphHandle = null;
              this.startHoldTimer({ x: clampedLast.x, y: clampedLast.y });
            }
          }
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const dpr = this.renderDpr();
            const rs = store.zoom * dpr;
            const ox = (parseFloat(cv.dataset.offsetX || '0') || 0) * dpr;
            const oy = (parseFloat(cv.dataset.offsetY || '0') || 0) * dpr;

            if (s.mode === 'pen' && this._holdFired && this._holdShape) {
              this._stickyInkRenderer.clearSettledDirtyOnCanvas(c, cv);
              this.clearScratchpadDirty(c, cv);
              const preview = this.buildHoldShapeAnnotation(this._holdShape, pageIndex, 'layer-default');
              if (preview) {
                this.withScratchOffset(c, cv, () => {
                  stickyNoteTool.withNoteClip(c, currentNote, rs, () => {
                    annotationEngine.renderSingleAnnotation(c, preview, rs);
                  });
                });
              }
            } else if (s.mode === 'pen') {
              // Strictly O(1) append-only GPU ink streaming inside the Sticky Note — ZERO mid-stroke clear!
              this._stickyInkRenderer.render(
                c,
                cv,
                s.points,
                s.color,
                s.strokeWidth,
                s.pressureCurve || 'linear',
                s.pressureEnabled !== false,
                s.pressureStrength || 'balanced',
                rs,
                ox,
                oy,
                calculateStrokeWidth,
                null,
                null,
                (clipCtx) => stickyNoteTool.applyNoteClipPath(clipCtx, currentNote)
              );
            } else if (s.mode === 'highlighter' && !isStraightHl) {
              // Strictly O(1) append-only GPU highlighter streaming inside the Sticky Note!
              this._stickyHighlighterRenderer.render(
                c,
                cv,
                s.points,
                s.color,
                s.strokeWidth,
                rs,
                ox,
                oy,
                (clipCtx) => stickyNoteTool.applyNoteClipPath(clipCtx, currentNote)
              );
            } else {
              this._stickyHighlighterRenderer.restoreCanvasOpacity();
              this.clearScratchpadDirty(c, cv);
              this.withScratchOffset(c, cv, () => {
                stickyNoteTool.renderLiveStrokeInNote(
                  c,
                  currentNote,
                  s.points,
                  s.color,
                  s.strokeWidth,
                  s.opacity ?? 1.0,
                  rs,
                  {
                    tool: 'highlighter',
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
            const pad = Math.max(12, s.strokeWidth + 8);
            this.setScratchpadDirtyFromPageBox({
              x: currentNote.box.x - pad,
              y: currentNote.box.y - pad,
              width: currentNote.box.width + pad * 2,
              height: currentNote.box.height + pad * 2
            }, rs);
          });
        }
      }
      return;
    }

    // Coalesced rAF paint for freehand ink & highlighter (zero-GC hot path)
    if (tool === 'pen') {
      const zoom = store.zoom;
      for (let i = 0; i < pts.length; i++) {
        penTool.move(pts[i], zoom);
      }
      const holdRadiusPage = PointerHandler.HOLD_RADIUS / Math.max(zoom, 0.25);
      if (this._holdAnchor && Math.hypot(lastPt.x - this._holdAnchor.x, lastPt.y - this._holdAnchor.y) > holdRadiusPage) {
        this._holdFired = false;
        this._holdShape = null;
        this._morphHandle?.cancel();
        this._morphHandle = null;
        this.startHoldTimer(lastPt);
      }
      this.scheduleLiveInkPaint(this._livePenPaintFn);
      return;
    }

    if (tool === 'highlighter') {
      const zoom = store.zoom;
      for (let i = 0; i < pts.length; i++) {
        highlighterTool.move(pts[i], shiftKey, zoom);
      }
      this._liveHighlighterShiftKey = shiftKey;
      this.scheduleLiveInkPaint(this._liveHighlighterPaintFn);
      return;
    }

    if (tool === 'eraser') {
      if (this._stylusEraserCursorCanvas === scratchCanvas) {
        this.setCanvasCursor(scratchCanvas, this.getCachedDrawingCursor('eraser'));
      }
      eraserTool.move(lastPt);
      for (let i = 0; i < pts.length; i++) {
        this._eraserPendingPts.push({ x: pts[i].x, y: pts[i].y });
      }
      this.scheduleLiveInkPaint(() => {
        if (!this._isPointerDown) return;
        const batch = this._eraserPendingPts.splice(0, this._eraserPendingPts.length);
        if (batch.length > 0) {
          const dirtyBox = this.applyEraserDirect(batch, pageIndex);
          if (dirtyBox) {
            onNeedRepaint(dirtyBox);
          }
        }
        // Native OS cursor renders the eraser circle at 0ms latency for mouse/pen.
        // Only draw a touch-guide circle on scratchpad for finger touch input.
        if (this._eraserPointerType === 'touch' && this._pageScratchCtx && this._pageScratchCanvas) {
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
        }
      });
      return;
    }

    // Coalesced rAF paint for all remaining interactive drag tools (select, shapes,
    // measure, sticky-note create, marquee, lasso) so 120–240Hz pointer streams
    // never stall the main thread with redundant full-canvas redraws.
    switch (tool) {
      case 'lasso':
      case 'select': {
        if (this._stickyItemDrag && this._stickyItemDrag.pageIndex === pageIndex) {
          const idrag = this._stickyItemDrag;
          idrag.lastPt = { x: lastPt.x, y: lastPt.y };
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || this._stickyItemDrag !== idrag) return;
            const doc = store.activeDocument;
            const pageAnns = doc?.annotations[pageIndex];
            if (!doc || !pageAnns) return;
            const noteIdx = pageAnns.findIndex(
              a => a.id === idrag.noteId && a.type === 'sticky-note'
            );
            if (noteIdx === -1) return;
            const curNote = pageAnns[noteIdx] as StickyNoteAnnotation;
            const dx = idrag.lastPt.x - idrag.startPt.x;
            const dy = idrag.lastPt.y - idrag.startPt.y;
            if (Math.hypot(dx, dy) > 0.5) idrag.moved = true;
            const origBox = idrag.originalItem.box;
            const movedItem = transformAnnotation(idrag.originalItem, {
              dx,
              dy,
              scaleX: 1,
              scaleY: 1,
              originX: origBox.x,
              originY: origBox.y
            });
            const updatedNote: StickyNoteAnnotation = {
              ...curNote,
              items: (curNote.items || []).map(it => (it.id === idrag.itemId ? movedItem : it)),
              updatedAt: Date.now()
            };
            pageAnns[noteIdx] = updatedNote;
            doc.lastModifiedAt = Date.now();
            if (!idrag.hasLifted) {
              idrag.hasLifted = true;
              onNeedRepaint();
            }
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas || scratchCanvas;
            if (!c || !cv) return;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              annotationEngine.renderCommittedAnnotations(c, [updatedNote], [], rs);
              if (store.selectedAnnotationIds.has(updatedNote.id)) {
                selectionManager.render(c, [updatedNote], rs);
              }
            });
            const dirtyBox = this.computeSelectionDirtyBox(getAnnotationSelectionBox(updatedNote), [updatedNote]);
            this.setScratchpadDirtyFromPageBox(dirtyBox, rs);
          });
          break;
        }
        if (this._selectDrag && this._selectDrag.pageIndex === pageIndex) {
          const drag = this._selectDrag;
          drag.lastPt = { x: lastPt.x, y: lastPt.y };
          drag.shiftKey = shiftKey;
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || this._selectDrag !== drag) return;
            const doc = store.activeDocument;
            const pageAnns = doc?.annotations[pageIndex];
            if (!doc || !pageAnns) return;
            if (!drag.hasLifted) {
              drag.hasLifted = true;
              if (drag.mode === 'move' || drag.mode === 'rotate') {
                this.createDragOverlay(drag, scratchCanvas, true, false);
              } else if (this.isGpuStickyResize(drag)) {
                const origNote = drag.originalsList[0] as StickyNoteAnnotation;
                if (origNote.collapsed) {
                  this.createDragOverlay(drag, scratchCanvas, false, true);
                } else {
                  this.createStickyResizeContentSprite(origNote);
                }
              }
              onNeedRepaint();
            }

            if (drag.mode === 'move') {
              const dx = drag.lastPt.x - drag.startPt.x;
              const dy = drag.lastPt.y - drag.startPt.y;
              this._activeLoupeTarget = null;
              if (this._dragOverlay && this._dragOverlay.pageIndex === pageIndex) {
                const zoom = Math.max(store.zoom || 1, 0.05);
                this._dragOverlay.canvas.style.transform = `translate3d(${dx * zoom}px, ${dy * zoom}px, 0)`;
                return;
              }
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas || scratchCanvas;
              if (!c || !cv) return;
              const rs = store.zoom * this.renderDpr();
              this.clearScratchpadDirty(c, cv);
              this.withScratchOffset(c, cv, () => {
                c.save();
                c.translate(dx * rs, dy * rs);
                annotationEngine.renderCommittedAnnotations(c, drag.originalsList, [], rs);
                selectionManager.render(c, drag.originalsList, rs);
                c.restore();
              });
              const shiftedBox: BoundingBox = {
                x: drag.merged.x + dx,
                y: drag.merged.y + dy,
                width: drag.merged.width,
                height: drag.merged.height
              };
              this.setScratchpadDirtyFromPageBox(
                this.computeSelectionDirtyBox(shiftedBox, drag.originalsList),
                rs
              );
            } else if (drag.mode === 'rotate') {
              const delta = this.computeRotationDelta(drag, drag.lastPt, drag.shiftKey);
              this._activeLoupeTarget = null;
              if (this._dragOverlay && this._dragOverlay.pageIndex === pageIndex) {
                this._dragOverlay.canvas.style.transformOrigin = `${this._dragOverlay.centerCssX}px ${this._dragOverlay.centerCssY}px`;
                this._dragOverlay.canvas.style.transform = `rotate(${delta}rad)`;
                return;
              }
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas || scratchCanvas;
              if (!c || !cv) return;
              const rs = store.zoom * this.renderDpr();
              const center = boxCenter(drag.merged);
              this.clearScratchpadDirty(c, cv);
              this.withScratchOffset(c, cv, () => {
                c.save();
                c.translate(center.x * rs, center.y * rs);
                c.rotate(delta);
                c.translate(-center.x * rs, -center.y * rs);
                annotationEngine.renderCommittedAnnotations(c, drag.originalsList, [], rs);
                selectionManager.render(c, drag.originalsList, rs);
                c.restore();
              });
              this.setScratchpadDirtyFromPageBox(
                this.computeSelectionDirtyBox(drag.merged, drag.originalsList, true),
                rs
              );
            } else if (this.isGpuStickyResize(drag)) {
              const origNote = drag.originalsList[0] as StickyNoteAnnotation;
              const zoom = Math.max(store.zoom || 1, 0.05);
              let effLast = drag.lastPt;
              if (origNote.rotation) {
                effLast = rotatePoint(drag.lastPt, boxCenter(drag.merged), -origNote.rotation);
              }
              const t = this.selectTransformFor(drag, effLast, drag.shiftKey);
              const origBox = origNote.collapsed
                ? stickyNoteTool.getCollapsedIconBox(origNote)
                : origNote.box;
              const spriteBox = (origNote.collapsed && this._dragOverlay)
                ? this._dragOverlay.spriteBox
                : origBox;
              const preview = computeStickyResizePreview(
                origBox,
                spriteBox,
                t,
                zoom,
                { collapsed: origNote.collapsed, rotation: origNote.rotation }
              );
              this._activeLoupeTarget = null;

              if (origNote.collapsed && this._dragOverlay && this._dragOverlay.isResize && this._dragOverlay.pageIndex === pageIndex) {
                this._dragOverlay.canvas.style.transformOrigin = preview.cssTransformOrigin;
                this._dragOverlay.canvas.style.transform = preview.cssTransform;
              }

              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas || scratchCanvas;
              if (c && cv) {
                const rs = store.zoom * this.renderDpr();
                this.clearScratchpadDirty(c, cv);
                const lightPreviewNote: StickyNoteAnnotation = origNote.collapsed
                  ? {
                      ...origNote,
                      box: { ...origNote.box, x: preview.nextBox.x, y: preview.nextBox.y },
                      iconWidth: preview.nextBox.width,
                      iconHeight: preview.nextBox.height
                    }
                  : { ...origNote, box: preview.nextBox };
                this.withScratchOffset(c, cv, () => {
                  if (!origNote.collapsed) {
                    // 1. Crisp, undistorted card shell + constant/ratio header + square collapse icon (~0.04ms)
                    stickyNoteTool.renderCardChrome(c, preview.nextBox, {
                      color: origNote.color,
                      textColor: origNote.textColor,
                      opacity: origNote.opacity,
                      rotation: origNote.rotation,
                      fastDrag: true,
                      scale: rs
                    });
                    // 2. Fast GPU blit of cached interior content (text/strokes/items) below the header
                    const sprite = this._stickyResizeContentSprite;
                    if (sprite && sprite.noteId === origNote.id && sprite.canvas.width > 0 && sprite.canvas.height > 0) {
                      const nextM = getStickyNoteLayoutMetrics(preview.nextBox);
                      const srcY = Math.min(sprite.canvas.height - 1, Math.max(0, sprite.origHeaderHeight * sprite.spriteScale));
                      const srcH = Math.max(1, sprite.canvas.height - srcY);
                      const dstH = preview.nextBox.height - nextM.headerHeight;
                      if (dstH > 2) {
                        c.save();
                        c.scale(rs, rs);
                        if (origNote.rotation) {
                          const cx = preview.nextBox.x + preview.nextBox.width * 0.5;
                          const cy = preview.nextBox.y + preview.nextBox.height * 0.5;
                          c.translate(cx, cy);
                          c.rotate(origNote.rotation);
                          c.translate(-cx, -cy);
                        }
                        c.beginPath();
                        c.rect(
                          preview.nextBox.x + 1.5,
                          preview.nextBox.y + nextM.headerHeight + 0.5,
                          Math.max(1, preview.nextBox.width - 3),
                          Math.max(1, dstH - 2)
                        );
                        c.clip();
                        c.drawImage(
                          sprite.canvas,
                          0,
                          srcY,
                          sprite.canvas.width,
                          srcH,
                          preview.nextBox.x,
                          preview.nextBox.y + nextM.headerHeight,
                          preview.nextBox.width,
                          dstH
                        );
                        c.restore();
                      }
                    }
                  }
                  // 3. Draw crisp selection border, all 8 handles, and dimension pill STRICTLY ON TOP
                  selectionManager.render(c, [lightPreviewNote], rs);
                });
                this.setScratchpadDirtyFromPageBox(
                  this.computeSelectionDirtyBox(preview.nextBox, [lightPreviewNote]),
                  rs
                );
              }
            } else {
              const c = this._pageScratchCtx;
              const cv = this._pageScratchCanvas || scratchCanvas;
              if (!c || !cv) return;
              const rs = store.zoom * this.renderDpr();
              this.clearScratchpadDirty(c, cv);
              const updatedList = this.applyResizeOrVertexTransform(drag, drag.lastPt, drag.shiftKey, pageAnns);
              doc.lastModifiedAt = Date.now();
              const currentAnn = updatedList[0];
              const targetPt = resolveDraggedHandleTargetPoint(currentAnn, drag.handle, drag.lastPt);
              this._activeLoupeTarget = targetPt;
              let loupeBox: BoundingBox | null = null;
              this.withScratchOffset(c, cv, () => {
                annotationEngine.renderCommittedAnnotations(c, updatedList, [], rs);
                selectionManager.render(c, updatedList, rs);
                loupeBox = this.renderHandleLoupe(c, scratchCanvas, pageIndex, targetPt, rs);
              });
              const selDirty = updatedList.length > 0
                ? this.computeSelectionDirtyBox(
                    mergeBoundingBoxes(updatedList.map(getAnnotationSelectionBox)),
                    updatedList
                  )
                : null;
              const dirtyUnion = selDirty && loupeBox
                ? mergeBoundingBoxes([selDirty, loupeBox])
                : (selDirty || loupeBox);
              this.setScratchpadDirtyFromPageBox(dirtyUnion, rs);
            }
          });
        } else if (this._textSelectDrag && this._textSelectDrag.pageIndex === pageIndex) {
          const ts = this._textSelectDrag;
          const ptCopy = { x: lastPt.x, y: lastPt.y };
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || this._textSelectDrag !== ts) return;
            const layout = pdfEngine.getCachedPageTextLayout(pageIndex);
            if (!layout) return;
            const directHit = hitTestPageTextPoint(layout, ptCopy.x, ptCopy.y, 6, false);
            const hit = directHit ?? hitTestPageTextPoint(layout, ptCopy.x, ptCopy.y, 6, true);
            if (!hit) return;
            const curIdx = Math.min(Math.max(0, hit.charOffset), Math.max(0, layout.fullText.length - 1));
            ts.currentOffset = curIdx;
            const anchor = Math.min(Math.max(0, ts.anchorOffset), Math.max(0, layout.fullText.length - 1));
            const startOffset = Math.min(anchor, curIdx);
            const endOffset = Math.min(layout.fullText.length, Math.max(anchor, curIdx) + 1);
            if (endOffset > startOffset) {
              const rects = getTextRangeRects(layout, startOffset, endOffset);
              const text = getSelectedTextFromRange(layout, startOffset, endOffset);
              if (rects.length > 0 && text.trim().length > 0) {
                ts.previewSelection = {
                  pageIndex,
                  startOffset,
                  endOffset,
                  text,
                  rects,
                  bounds: computeUnionBounds(rects)
                };
              } else {
                ts.previewSelection = null;
              }
            } else {
              ts.previewSelection = null;
            }
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas || scratchCanvas;
            if (!c || !cv) return;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            const sel = ts.previewSelection;
            if (sel && sel.rects.length > 0) {
              this.withScratchOffset(c, cv, () => {
                c.save();
                c.scale(rs, rs);
                c.fillStyle = 'rgba(59, 130, 246, 0.28)';
                for (const r of sel.rects) {
                  c.beginPath();
                  if (typeof c.roundRect === 'function') {
                    c.roundRect(r.x - 0.5, r.y, r.width + 1, r.height, 1.5);
                  } else {
                    c.rect(r.x - 0.5, r.y, r.width + 1, r.height);
                  }
                  c.fill();
                }
                c.restore();
              });
              const b = sel.bounds;
              this.setScratchpadDirtyFromPageBox(
                { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 },
                rs
              );
            }
          });
        } else if (this._lasso && this._lasso.pageIndex === pageIndex) {
          const path = this._lasso.points;
          for (const pt of pts) {
            const prev = path[path.length - 1];
            if (!prev || Math.abs(pt.x - prev.x) + Math.abs(pt.y - prev.y) > 1.5) {
              path.push({ x: pt.x, y: pt.y });
            }
          }
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas || !this._lasso) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              this.renderLassoPath(c, rs);
            });
            const lb = computePointsBoundingBox(this._lasso.points);
            this.setScratchpadDirtyFromPageBox(
              { x: lb.x - 10, y: lb.y - 10, width: lb.width + 20, height: lb.height + 20 },
              rs
            );
          });
        } else if (this._marquee && this._marquee.pageIndex === pageIndex) {
          this._marquee.current = { ...lastPt };
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas || !this._marquee) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            this.withScratchOffset(c, cv, () => {
              this.renderMarquee(c, rs);
            });
            const b = normalizeDragBox(this._marquee.start, this._marquee.current);
            this.setScratchpadDirtyFromPageBox({ x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 }, rs);
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
        const snapAngle = shiftKey || this.toolOpt(tool, 'snapAngle15');
        const magnetic = tool === 'line' || tool === 'arrow' ||
          tool === 'polygon' || tool === 'freeform-shape';
        this._snapTarget = null;
        if (tool === 'freeform-shape') {
          for (let i = 0; i < pts.length; i++) {
            const p = i === pts.length - 1 ? this.snapToVertex(pts[i], pageIndex) : pts[i];
            shapesTool.move(p, shiftKey, snapAngle);
          }
        } else {
          const p = magnetic ? this.snapToVertex(lastPt, pageIndex) : lastPt;
          shapesTool.move(p, shiftKey, snapAngle);
        }
        this.scheduleLiveInkPaint(() => {
          if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            shapesTool.renderScratchpad(c, rs);
            if (magnetic) this.renderSnapTarget(c, rs);
          });
        });
        break;
      }

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        measureTool.move(lastPt);
        this.scheduleLiveInkPaint(() => {
          if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas) return;
          const c = this._pageScratchCtx;
          const cv = this._pageScratchCanvas;
          const rs = store.zoom * this.renderDpr();
          this.clearScratchpadDirty(c, cv);
          this.withScratchOffset(c, cv, () => {
            measureTool.renderScratchpad(c, rs);
          });
        });
        break;

      case 'sticky-note':
        if (this._stickyCreateDrag && this._stickyCreateDrag.pageIndex === pageIndex) {
          this._stickyCreateDrag.current = { ...lastPt };
          this.scheduleLiveInkPaint(() => {
            if (!this._isPointerDown || !this._pageScratchCtx || !this._pageScratchCanvas || !this._stickyCreateDrag) return;
            const c = this._pageScratchCtx;
            const cv = this._pageScratchCanvas;
            const rs = store.zoom * this.renderDpr();
            this.clearScratchpadDirty(c, cv);
            const d = distance(this._stickyCreateDrag.start, this._stickyCreateDrag.current);
            if (d > 10) {
              const rawBox = normalizeDragBox(this._stickyCreateDrag.start, this._stickyCreateDrag.current);
              const previewBox: BoundingBox = {
                x: rawBox.x,
                y: rawBox.y,
                width: Math.max(56, rawBox.width),
                height: Math.max(46, rawBox.height)
              };
              const ts = store.toolSettings;
              this.withScratchOffset(c, cv, () => {
                stickyNoteTool.renderPreview(
                  c,
                  previewBox,
                  rs,
                  ts.noteColor || '#ebd09e',
                  '',
                  ts.noteTextColor || '#3b2f1e'
                );
              });
              this.setScratchpadDirtyFromPageBox({
                x: previewBox.x - 24,
                y: previewBox.y - 24,
                width: previewBox.width + 48,
                height: previewBox.height + 48
              }, rs);
            }
          });
        }
        break;
    }
  }

  public handlePointerUp(
    _e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: (dirtyPageBox?: BoundingBox | null) => void
  ): void {
    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    this.cancelScratchRaf();
    this._isPointerDown = false;
    this._activeCanvasRect = null;
    this._scratchDirtyRect = null;
    this._cachedShapeVertices = null;
    const tool = this._strokeTool ?? store.activeTool;
    const defaultLayerId = 'layer-default';

    if (tool === 'polygon') {
      this._isPointerDown = false;
      this._strokeTool = null;
      // Polygons remain active across clicks until closed or completed
      if (this._pageScratchCtx && this._pageScratchCanvas && shapesTool.isPolygonActive()) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const polyNote = this._activeStickyPolygonNoteId
          ? store.activeDocument?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === this._activeStickyPolygonNoteId && a.type === 'sticky-note'
            )
          : undefined;
        const rs = store.zoom * this.renderDpr();
        this.withScratchOffset(c, cv, () => {
          if (polyNote) {
            stickyNoteTool.withNoteClip(c, polyNote, rs, () => {
              shapesTool.renderScratchpad(c, rs);
            });
          } else {
            shapesTool.renderScratchpad(c, rs);
          }
        });
      }
      return;
    }

    if ((tool === 'measure-angle' || tool === 'measure-area') && measureTool.isMultiPointActive()) {
      this._isPointerDown = false;
      this._strokeTool = null;
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        const c = this._pageScratchCtx;
        const cv = this._pageScratchCanvas;
        const measureNote = this._activeStickyMeasureNoteId
          ? store.activeDocument?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === this._activeStickyMeasureNoteId && a.type === 'sticky-note'
            )
          : undefined;
        const rs = store.zoom * this.renderDpr();
        c.clearRect(0, 0, cv.width, cv.height);
        this.withScratchOffset(c, cv, () => {
          if (measureNote) {
            stickyNoteTool.withNoteClip(c, measureNote, rs, () => {
              measureTool.renderScratchpad(c, rs);
            });
          } else {
            measureTool.renderScratchpad(c, rs);
          }
        });
      }
      return;
    }

    // Defer clearing the scratchpad for live pen/highlighter strokes (page or sticky note)
    // until right after commit/repaint so there is 0ms blank flicker and O(1) dirty-rect clear.
    const isIncrementalInkUp =
      !this._stickyItemDrag &&
      (
        (!this._activeStickyStroke && ((tool === 'pen' && !this._holdFired) || tool === 'highlighter')) ||
        (!!this._activeStickyStroke &&
          !this._holdFired &&
          (this._activeStickyStroke.mode === 'pen' || this._activeStickyStroke.mode === 'highlighter'))
      );
    if (!isIncrementalInkUp && this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }
    let handledIncrementally = false;

    // Commit active embedded-item drag inside an expanded Sticky Note
    if (this._stickyItemDrag && this._stickyItemDrag.pageIndex === pageIndex) {
      this.commitStickyItemDrag();
      this._isPointerDown = false;
      this._strokeTool = null;
      this._activePageIndex = -1;
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
      this._scratchDirtyRect = null;
      onNeedRepaint();
      return;
    }

    // Commit active in-note tool session if one was in flight
    if (this._activeStickyStroke && this._activeStickyStroke.pageIndex === pageIndex) {
      const s = this._activeStickyStroke;
      this._activeStickyStroke = null;
      const snapped = s.mode === 'pen' && this._holdFired ? this._holdShape : null;
      this._morphHandle?.cancel();
      this._morphHandle = null;
      this.clearHoldTimer();
      this._holdFired = false;
      this._holdShape = null;

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
      let stickyErasedDirty: BoundingBox | null = null;
      let stickyErasedIncrementally = false;
      if (currentNote) {
        if (s.mode === 'eraser') {
          const pending = this._stickyEraserPendingPts.splice(0, this._stickyEraserPendingPts.length);
          this._stickyEraserPendingNoteId = null;
          if (pending.length > 0) {
            const radius = Math.max(8, store.toolSettings.eraserWidth / 2);
            if (this.applyStickyNoteEraser(pending, pageIndex, s.noteId, radius, store.toolSettings.eraserMode)) {
              s.modified = true;
              const pad = 20;
              stickyErasedDirty = {
                x: currentNote.box.x - pad,
                y: currentNote.box.y - pad,
                width: currentNote.box.width + pad * 2,
                height: currentNote.box.height + pad * 2
              };
            }
          }
          const latestNote = doc?.annotations[pageIndex]?.find(
            (a): a is StickyNoteAnnotation => a.id === s.noteId && a.type === 'sticky-note'
          ) || currentNote;
          eraserTool.finish();
          if (s.modified) {
            history.pushCommitted(new ModifyAnnotationCommand(pageIndex, s.originalNote, { ...latestNote }));
          }
          stickyErasedIncrementally = true;
        } else if (s.mode === 'measure') {
          const measureAnn = measureTool.finish(defaultLayerId);
          if (measureAnn) {
            measureAnn.createdAt = stickyNoteTool.nextContentTimestamp(currentNote);
            const updatedNote: StickyNoteAnnotation = {
              ...currentNote,
              items: [...(currentNote.items || []), measureAnn],
              updatedAt: Date.now()
            };
            history.execute(new ModifyAnnotationCommand(pageIndex, s.originalNote, updatedNote));
          }
        } else if (s.mode === 'shape') {
          const shapeAnn = shapesTool.finish(defaultLayerId);
          if (shapeAnn) {
            shapeAnn.createdAt = stickyNoteTool.nextContentTimestamp(currentNote);
            const updatedNote: StickyNoteAnnotation = {
              ...currentNote,
              items: [...(currentNote.items || []), shapeAnn],
              updatedAt: Date.now()
            };
            history.execute(new ModifyAnnotationCommand(pageIndex, s.originalNote, updatedNote));
          }
        } else if (snapped) {
          const shapeAnn = this.buildHoldShapeAnnotation(snapped, pageIndex, defaultLayerId);
          if (shapeAnn) {
            shapeAnn.createdAt = stickyNoteTool.nextContentTimestamp(currentNote);
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
            points: [...s.points],
            color: s.color,
            strokeWidth: s.strokeWidth,
            opacity: s.opacity ?? 1.0,
            pressureEnabled: s.pressureEnabled,
            pressureCurve: s.pressureCurve,
            pressureStrength: s.pressureStrength,
            smoothing: s.smoothing,
            preSmoothed: s.mode === 'pen',
            blendMode: s.blendMode,
            tipShape: s.tipShape,
            createdAt: stickyNoteTool.nextContentTimestamp(currentNote)
          };
          const updatedNote: StickyNoteAnnotation = {
            ...currentNote,
            strokes: [...(currentNote.strokes || []), newStroke],
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, s.originalNote, updatedNote));
        }
      }
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        if (s.mode === 'pen') {
          this._stickyInkRenderer.clearSettledDirtyOnCanvas(this._pageScratchCtx, this._pageScratchCanvas);
        } else if (s.mode === 'highlighter') {
          this._stickyHighlighterRenderer.clearDirtyOnCanvas(this._pageScratchCtx, this._pageScratchCanvas);
        }
      } else {
        this._stickyInkRenderer.reset();
        this._stickyHighlighterRenderer.reset();
      }
      this._isPointerDown = false;
      this._strokeTool = null;
      this._activePageIndex = -1;
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
      this.restoreStylusEraserCursor(_e);
      if (stickyErasedIncrementally) {
        if (stickyErasedDirty) onNeedRepaint(stickyErasedDirty);
      } else {
        onNeedRepaint();
      }
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
            const pageBounds = this.getPageBounds(pageIndex, scratchCanvas);
            const expanded = stickyNoteTool.expandStickyNoteForPage(collapsedNote, pageBounds.width, pageBounds.height);
            history.execute(new ModifyAnnotationCommand(pageIndex, collapsedNote, expanded));
            onNeedRepaint();
            break;
          }
        }
        this._wasCollapsedNoteSelectedOnDown = null;
        if (this._textSelectDrag) {
          const ts = this._textSelectDrag;
          this._textSelectDrag = null;
          const sel = ts.previewSelection;
          if (sel && sel.text.trim().length > 0 && sel.rects.length > 0) {
            store.setTextSelection(sel);
            floatingPropsBar?.showForTextSelection();
          } else {
            store.setTextSelection(null);
          }
          break;
        }
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
        this._predictedPtsBuffer.length = 0;
        if (snapped) {
          // Two-step history: add the raw freehand stroke, then replace it
          // with the recognized shape. Undo #1 restores the original ink;
          // undo #2 removes it entirely.
          if (this._pageScratchCtx && this._pageScratchCanvas) {
            penTool.clearLiveSurface(this._pageScratchCtx, this._pageScratchCanvas);
          } else {
            penTool.hideTipOverlay();
          }
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
          // Commit & stamp onto annotCanvas FIRST, then clear ONLY the tight
          // device-pixel dirty rect on scratchCanvas (0ms flicker, O(1) cost).
          const scratchCtx = this._pageScratchCtx;
          const scratchCanvas = this._pageScratchCanvas;
          const penAnn = penTool.finish(defaultLayerId);
          if (penAnn) {
            history.execute(
              new AddAnnotationCommand(pageIndex, penAnn),
              { kind: 'incremental-annotation', pageIndex, annotation: penAnn }
            );
            handledIncrementally = true;
          }
          if (scratchCtx && scratchCanvas) {
            this.clearScratchpadDirty(scratchCtx, scratchCanvas);
          }
          penTool.hideTipOverlay();
        }
        break;
      }

      case 'highlighter': {
        const scratchCtx = this._pageScratchCtx;
        const scratchCanvas = this._pageScratchCanvas;
        const highAnn = highlighterTool.finish(defaultLayerId);
        if (highAnn) {
          history.execute(
            new AddAnnotationCommand(pageIndex, highAnn),
            { kind: 'incremental-annotation', pageIndex, annotation: highAnn }
          );
          handledIncrementally = true;
        }
        if (scratchCtx && scratchCanvas) {
          this.clearScratchpadDirty(scratchCtx, scratchCanvas);
        }
        break;
      }

      case 'eraser': {
        const pending = this._eraserPendingPts.splice(0, this._eraserPendingPts.length);
        if (pending.length > 0) {
          const dirtyBox = this.applyEraserDirect(pending, pageIndex);
          if (dirtyBox) {
            onNeedRepaint(dirtyBox);
          }
        }
        eraserTool.finish();
        this.commitEraserSession(pageIndex);
        handledIncrementally = true;
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

      case 'measure-distance': {
        const measureAnn = measureTool.finish(defaultLayerId);
        if (measureAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, measureAnn));
        }
        break;
      }

      case 'sticky-note': {
        const drag = this._stickyCreateDrag;
        this._stickyCreateDrag = null;
        const startPt = drag ? drag.start : this.getPointInPage(_e, scratchCanvas);
        const endPt = drag ? drag.current : startPt;
        const dist = distance(startPt, endPt);
        const ts = store.toolSettings;
        const zoom = Math.max(store.zoom || 1, 0.15);
        const pageBounds = this.getPageBounds(pageIndex, scratchCanvas);

        let customBox: BoundingBox;
        let uiScale = 1.0;

        if (dist > 14) {
          const raw = normalizeDragBox(startPt, endPt);
          customBox = {
            x: raw.x,
            y: raw.y,
            width: Math.max(56, raw.width),
            height: Math.max(46, raw.height)
          };
          uiScale = getStickyNoteLayoutMetrics(customBox).uiScale;
        } else {
          // Compute the page's visible rect inside the viewport scroll container
          // so zoomed-in clicks spawn a card sized and positioned inside the visible area.
          let visRect: { left: number; top: number; right: number; bottom: number } | null = null;
          const containerEl = scratchCanvas.parentElement;
          const scrollEl = document.getElementById('document-scroll-container') || document.querySelector<HTMLElement>('.document-scroll-area');
          if (containerEl && scrollEl) {
            const scRect = scrollEl.getBoundingClientRect();
            const pgRect = containerEl.getBoundingClientRect();
            if (scRect.width > 0 && scRect.height > 0 && pgRect.width > 0 && pgRect.height > 0) {
              visRect = {
                left: Math.max(0, scRect.left - pgRect.left) / zoom,
                top: Math.max(0, scRect.top - pgRect.top) / zoom,
                right: Math.min(pgRect.width, scRect.right - pgRect.left) / zoom,
                bottom: Math.min(pgRect.height, scRect.bottom - pgRect.top) / zoom
              };
            }
          }
          const placed = computeViewportStickyNoteBox(
            pageBounds.width,
            pageBounds.height,
            zoom,
            visRect,
            startPt
          );
          customBox = placed.box;
          uiScale = placed.uiScale;
        }

        const baseFontSize = ts.noteFontSize || 18;
        const scaledFontSize = Math.max(7, Math.round(baseFontSize * uiScale * 10) / 10);

        const noteAnn = stickyNoteTool.createStickyNote(pageIndex, startPt, {
          layerId: defaultLayerId,
          box: customBox,
          color: ts.noteColor || '#ebd09e',
          textColor: ts.noteTextColor || '#3b2f1e',
          fontSize: scaledFontSize,
          fontFamily: resolveAnnotationFontFamily(ts.fontFamily),
          textAlign: ts.textAlign || 'left',
          author: '',
          allowCompact: true
        });
        history.execute(new AddAnnotationCommand(pageIndex, noteAnn));
        store.setActiveTool('select');
        this.selectCreatedAnnotation(noteAnn.id);
        onNeedRepaint();
        this.editExistingStickyNote(noteAnn, pageIndex, scratchCanvas, onNeedRepaint);
        break;
      }
    }

    if (!handledIncrementally && this._pageScratchCtx && this._pageScratchCanvas) {
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    }
    this._isPointerDown = false;
    this._strokeTool = null;
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    this._scratchDirtyRect = null;
    this._predictedPtsBuffer.length = 0;
    this.restoreStylusEraserCursor(_e);
    if (!handledIncrementally) {
      onNeedRepaint();
    }
  }

  public finishPolygon(pageIndex: number, defaultLayerId: string = 'layer-default', onNeedRepaint?: () => void): boolean {
    if (measureTool.isMultiPointActive()) {
      const measureAnn = measureTool.finish(defaultLayerId);
      const stickyNoteId = this._activeStickyMeasureNoteId;
      this._activeStickyMeasureNoteId = null;
      this._activeStickyStroke = null;
      if (measureAnn) {
        const doc = store.activeDocument;
        const targetNote = stickyNoteId
          ? doc?.annotations[pageIndex]?.find(
              (a): a is StickyNoteAnnotation => a.id === stickyNoteId && a.type === 'sticky-note'
            )
          : undefined;
        if (targetNote) {
          measureAnn.createdAt = stickyNoteTool.nextContentTimestamp(targetNote);
          const updatedNote: StickyNoteAnnotation = {
            ...targetNote,
            items: [...(targetNote.items || []), measureAnn],
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, targetNote, updatedNote));
        } else {
          history.execute(new AddAnnotationCommand(pageIndex, measureAnn));
        }
        if (this._pageScratchCtx && this._pageScratchCanvas) {
          this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
        }
        this._pageScratchCanvas = null;
        this._pageScratchCtx = null;
        this._scratchDirtyRect = null;
        this._cachedShapeVertices = null;
        onNeedRepaint?.();
        return true;
      }
      measureTool.cancel();
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
      }
      this._scratchDirtyRect = null;
      this._cachedShapeVertices = null;
      return false;
    }
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
          polyAnn.createdAt = stickyNoteTool.nextContentTimestamp(targetNote);
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
        this._scratchDirtyRect = null;
        this._cachedShapeVertices = null;
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
    return computeSelectionBoxTransform(
      drag.merged,
      drag.mode,
      String(drag.handle),
      drag.startPt,
      cur,
      shiftKey
    );
  }

  /**
   * Rotates every dragged annotation around the merged-box pivot by the angle
   * swept since drag start (Shift snaps to 15°). Single selections spin in
   * place; groups orbit their shared center, each keeping its own rotation.
   * Absolute from drag start: idempotent per frame, zero drift.
   */
  private computeRotationDelta(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    cur: Point,
    snap: boolean
  ): number {
    const center = boxCenter(drag.merged);
    const a0 = Math.atan2(drag.startPt.y - center.y, drag.startPt.x - center.x);
    const a1 = Math.atan2(cur.y - center.y, cur.x - center.x);
    let delta = a1 - a0;
    // Normalize to [-PI, PI] so crossing the -x axis doesn't spin backwards.
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (snap) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
    return delta;
  }

  private applyRotationDrag(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    cur: Point,
    snap: boolean,
    pageAnns: Annotation[]
  ): void {
    const center = boxCenter(drag.merged);
    const delta = this.computeRotationDelta(drag, cur, snap);
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

  private applyResizeOrVertexTransform(
    drag: NonNullable<PointerHandler['_selectDrag']>,
    curPt: Point,
    shiftKey: boolean,
    pageAnns: Annotation[]
  ): Annotation[] {
    const updated: Annotation[] = [];
    if (drag.handle === 'start' || drag.handle === 'end') {
      const handle = drag.handle;
      for (let i = 0; i < pageAnns.length; i++) {
        const orig = drag.originals.get(pageAnns[i].id);
        if (!orig) continue;
        if (orig.type !== 'line' && orig.type !== 'arrow') {
          updated.push(pageAnns[i]);
          continue;
        }
        let nextAnn: Annotation;
        if (shiftKey) {
          const ptIdx = handle === 'start' ? 0 : Math.max(0, (orig.points?.length || 1) - 1);
          const vt = computeVertexResizeTransform(orig, ptIdx, curPt);
          nextAnn = vt ? transformAnnotation(orig, vt) : moveAnnotationEndpoint(orig, handle, curPt);
        } else {
          nextAnn = moveAnnotationEndpoint(orig, handle, curPt);
        }
        pageAnns[i] = nextAnn;
        updated.push(nextAnn);
      }
      return updated;
    }

    if (typeof drag.handle === 'string' && drag.handle.startsWith('vertex:')) {
      const vertexIdx = parseInt(drag.handle.slice(7), 10);
      const keepRect = this._rectCornerLockMode;
      for (let i = 0; i < pageAnns.length; i++) {
        const orig = drag.originals.get(pageAnns[i].id);
        if (!orig) continue;
        let nextAnn: Annotation;
        if (shiftKey) {
          const vt = computeVertexResizeTransform(orig, vertexIdx, curPt);
          nextAnn = vt ? transformAnnotation(orig, vt) : moveAnnotationVertex(orig, vertexIdx, curPt, keepRect);
        } else {
          nextAnn = moveAnnotationVertex(orig, vertexIdx, curPt, keepRect);
        }
        pageAnns[i] = nextAnn;
        updated.push(nextAnn);
      }
      return updated;
    }

    let effLast = curPt;
    if (drag.originals.size === 1) {
      const orig = drag.originalsList[0];
      if (orig && orig.rotation) effLast = rotatePoint(curPt, boxCenter(drag.merged), -orig.rotation);
    }
    const t = this.selectTransformFor(drag, effLast, shiftKey);
    for (let i = 0; i < pageAnns.length; i++) {
      const orig = drag.originals.get(pageAnns[i].id);
      if (!orig) continue;
      const nextAnn = transformAnnotation(orig, t) as Annotation;
      pageAnns[i] = nextAnn;
      updated.push(nextAnn);
    }
    return updated;
  }

  private computeSelectionDirtyBox(
    box: BoundingBox,
    annotations: Annotation[],
    extraAngle: boolean = false
  ): BoundingBox {
    const invZoom = 1 / Math.max(store.zoom || 1, 0.2);
    let strokePad = 14;
    let hasRotation = extraAngle;
    for (const a of annotations) {
      const sw = (a as { strokeWidth?: number }).strokeWidth;
      if (typeof sw === 'number' && Number.isFinite(sw)) {
        const needed = a.type === 'arrow' ? sw * 6 + 12 : sw * 2 + 12;
        if (needed > strokePad) strokePad = needed;
      }
      if (a.type === 'sticky-note') {
        strokePad = Math.max(strokePad, 28);
      }
      if (a.rotation) hasRotation = true;
    }
    const handlePad = 48 * invZoom;
    const pad = strokePad + handlePad;
    if (hasRotation) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const halfDiag = Math.hypot(box.width, box.height) * 0.5 + pad;
      return {
        x: cx - halfDiag,
        y: cy - halfDiag,
        width: halfDiag * 2,
        height: halfDiag * 2
      };
    }
    return {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2
    };
  }

  /** Commits an in-progress embedded-item drag inside a Sticky Note as ONE undo step. */
  private commitStickyItemDrag(): void {
    const idrag = this._stickyItemDrag;
    this._stickyItemDrag = null;
    if (!idrag) return;
    const doc = store.activeDocument;
    const pageAnns = doc?.annotations[idrag.pageIndex];
    if (!doc || !pageAnns) return;
    const noteIdx = pageAnns.findIndex(
      (a): a is StickyNoteAnnotation => a.id === idrag.noteId && a.type === 'sticky-note'
    );
    if (noteIdx === -1) return;
    const dx = idrag.lastPt.x - idrag.startPt.x;
    const dy = idrag.lastPt.y - idrag.startPt.y;
    if (Math.hypot(dx, dy) > 0.5) idrag.moved = true;
    if (idrag.moved) {
      const curNote = pageAnns[noteIdx] as StickyNoteAnnotation;
      const origBox = idrag.originalItem.box;
      const movedItem = transformAnnotation(idrag.originalItem, {
        dx,
        dy,
        scaleX: 1,
        scaleY: 1,
        originX: origBox.x,
        originY: origBox.y
      });
      const updatedNote: StickyNoteAnnotation = {
        ...curNote,
        items: (curNote.items || []).map(it => (it.id === idrag.itemId ? movedItem : it)),
        updatedAt: Date.now()
      };
      pageAnns[noteIdx] = updatedNote;
      doc.lastModifiedAt = Date.now();
      history.pushCommitted(new ModifyAnnotationCommand(idrag.pageIndex, idrag.originalNote, { ...updatedNote }));
    }
  }

  /** Commits an in-progress selection drag as ONE undo step. No-op otherwise. */
  private commitSelectDrag(): void {
    const drag = this._selectDrag;
    this._selectDrag = null;
    this._activeLoupeTarget = null;
    this._scratchDirtyRect = null;
    this.destroyDragOverlay();
    if (!drag) return;
    const movedEnough = drag.lastPt.x !== drag.startPt.x || drag.lastPt.y !== drag.startPt.y;
    if (!drag.hasLifted && !movedEnough) return;
    const doc = store.activeDocument;
    const pageAnns = doc?.annotations[drag.pageIndex];
    if (!doc || !pageAnns) return;

    if (drag.mode === 'move') {
      const dx = drag.lastPt.x - drag.startPt.x;
      const dy = drag.lastPt.y - drag.startPt.y;
      if (dx !== 0 || dy !== 0) {
        const t: BoxTransform = {
          dx,
          dy,
          scaleX: 1,
          scaleY: 1,
          originX: drag.merged.x,
          originY: drag.merged.y
        };
        for (let i = 0; i < pageAnns.length; i++) {
          const orig = drag.originals.get(pageAnns[i].id);
          if (orig) pageAnns[i] = transformAnnotation(orig, t);
        }
        doc.lastModifiedAt = Date.now();
      }
    } else if (drag.mode === 'rotate') {
      this.applyRotationDrag(drag, drag.lastPt, drag.shiftKey, pageAnns);
      doc.lastModifiedAt = Date.now();
    } else {
      this.applyResizeOrVertexTransform(drag, drag.lastPt, drag.shiftKey, pageAnns);
      doc.lastModifiedAt = Date.now();
    }

    const pairs: Array<{ prev: Annotation; next: Annotation }> = [];
    for (const [id, prev] of drag.originals) {
      const next = pageAnns.find(a => a.id === id);
      if (next && JSON.stringify(next) !== JSON.stringify(prev)) {
        pairs.push({ prev, next: { ...next } });
      }
    }
    if (pairs.length > 0) {
      history.pushCommitted(new BulkModifyCommand(drag.pageIndex, pairs));
    }
  }

  /**
   * Renders a precision circular magnifier loupe above (or below near the top edge)
   * the dragged shape vertex/endpoint/resize indicator handle so the user can see
   * the exact PDF content and corner position beneath the pointer.
   */
  private renderHandleLoupe(
    ctx: CanvasRenderingContext2D,
    scratchCanvas: HTMLCanvasElement,
    pageIndex: number,
    targetPt: Point,
    renderScale: number
  ): BoundingBox {
    const pageBounds = this.getPageBounds(pageIndex, scratchCanvas);
    const zoom = Math.max(store.zoom || 1, 0.25);
    const invZoom = 1 / zoom;
    const placement = computeHandleLoupePlacement(targetPt, pageBounds.width, pageBounds.height, zoom);
    const { loupeCenter, radiusPage, magnification } = placement;
    const isDarkPdf = typeof document !== 'undefined' && document.body?.classList.contains('invert-pdf-document');

    ctx.save();
    ctx.scale(renderScale, renderScale);

    // 1. Subtle connector stem & target indicator ring at the exact corner coordinate
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([2.5 * invZoom, 2.5 * invZoom]);
    ctx.moveTo(targetPt.x, targetPt.y);
    ctx.lineTo(loupeCenter.x, loupeCenter.y);
    ctx.strokeStyle = 'rgba(79, 70, 229, 0.55)';
    ctx.lineWidth = 1.2 * invZoom;
    ctx.stroke();
    ctx.restore();

    // 2. Outer drop shadow & opaque backing disc for the lens
    //    Avoid expensive Skia per-frame shadowBlur on Electron Linux during resize drags.
    ctx.save();
    if (!isElectron()) {
      ctx.shadowColor = 'rgba(15, 23, 42, 0.32)';
      ctx.shadowBlur = 14 * invZoom;
      ctx.shadowOffsetY = 4 * invZoom;
    }
    ctx.beginPath();
    ctx.arc(loupeCenter.x, loupeCenter.y, radiusPage, 0, Math.PI * 2);
    ctx.fillStyle = isDarkPdf ? '#14171f' : '#ffffff';
    ctx.fill();
    ctx.restore();

    // 3. Clipped magnified view (2.5x) of the underlying PDF page + annotations
    ctx.save();
    ctx.beginPath();
    ctx.arc(loupeCenter.x, loupeCenter.y, radiusPage, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(loupeCenter.x, loupeCenter.y);
    ctx.scale(magnification, magnification);
    ctx.translate(-targetPt.x, -targetPt.y);

    // 3a. Composite ONLY the tiny magnified patch of the underlying PDF page canvas
    const viewHalf = radiusPage / magnification + 2;
    const container = scratchCanvas.parentElement;
    const pdfCanvas = container?.querySelector<HTMLCanvasElement>('.pdf-page-canvas:not(.pdf-chunk-canvas)');
    if (pdfCanvas && pdfCanvas.width > 1 && pdfCanvas.height > 1 && pageBounds.width > 0 && pageBounds.height > 0) {
      const srcPageX = Math.max(0, targetPt.x - viewHalf);
      const srcPageY = Math.max(0, targetPt.y - viewHalf);
      const srcPageRight = Math.min(pageBounds.width, targetPt.x + viewHalf);
      const srcPageBottom = Math.min(pageBounds.height, targetPt.y + viewHalf);
      const srcPageW = srcPageRight - srcPageX;
      const srcPageH = srcPageBottom - srcPageY;
      if (srcPageW > 0 && srcPageH > 0) {
        const scaleX = pdfCanvas.width / pageBounds.width;
        const scaleY = pdfCanvas.height / pageBounds.height;
        ctx.drawImage(
          pdfCanvas,
          srcPageX * scaleX,
          srcPageY * scaleY,
          srcPageW * scaleX,
          srcPageH * scaleY,
          srcPageX,
          srcPageY,
          srcPageW,
          srcPageH
        );
      }
    }

    // 3b. Render background paper grid/lines (if enabled) and spatially culled annotations at 2.5x
    if (store.appSettings.backgroundPattern !== 'none' && pageBounds.width > 0 && pageBounds.height > 0) {
      annotationEngine.renderBackgroundPattern(
        ctx,
        pageBounds.width,
        pageBounds.height,
        store.appSettings.backgroundPattern,
        1.0
      );
    }
    const cullBox: BoundingBox = {
      x: targetPt.x - viewHalf,
      y: targetPt.y - viewHalf,
      width: viewHalf * 2,
      height: viewHalf * 2
    };
    annotationEngine.renderAnnotationsToCanvas(ctx, pageIndex, 1.0, null, cullBox);
    ctx.restore();

    // 4. Precision crosshair reticle inside the loupe (with an unobstructed center gap)
    ctx.save();
    const gap = 3.5 * invZoom;
    const arm = radiusPage * 0.58;
    ctx.strokeStyle = isDarkPdf ? 'rgba(165, 180, 252, 0.78)' : 'rgba(79, 70, 229, 0.72)';
    ctx.lineWidth = 1.1 * invZoom;
    ctx.setLineDash([]);
    ctx.beginPath();
    // Horizontal arms
    ctx.moveTo(loupeCenter.x - arm, loupeCenter.y);
    ctx.lineTo(loupeCenter.x - gap, loupeCenter.y);
    ctx.moveTo(loupeCenter.x + gap, loupeCenter.y);
    ctx.lineTo(loupeCenter.x + arm, loupeCenter.y);
    // Vertical arms
    ctx.moveTo(loupeCenter.x, loupeCenter.y - arm);
    ctx.lineTo(loupeCenter.x, loupeCenter.y - gap);
    ctx.moveTo(loupeCenter.x, loupeCenter.y + gap);
    ctx.lineTo(loupeCenter.x, loupeCenter.y + arm);
    ctx.stroke();

    // Center precision target ring
    ctx.beginPath();
    ctx.arc(loupeCenter.x, loupeCenter.y, gap, 0, Math.PI * 2);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.3 * invZoom;
    ctx.stroke();

    // Coordinate readout pill at the bottom of the lens
    const coordText = `${Math.round(targetPt.x)}, ${Math.round(targetPt.y)}`;
    ctx.font = `600 ${9.5 * invZoom}px "JetBrains Mono", "Manrope", -apple-system, sans-serif`;
    const pillW = Math.max(42 * invZoom, ctx.measureText(coordText).width + 10 * invZoom);
    const pillH = 14 * invZoom;
    const pillX = loupeCenter.x - pillW / 2;
    const pillY = loupeCenter.y + radiusPage - pillH - 4 * invZoom;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(pillX, pillY, pillW, pillH, 4 * invZoom);
    } else {
      ctx.rect(pillX, pillY, pillW, pillH);
    }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(coordText, loupeCenter.x, pillY + pillH / 2);

    // 5. Double-ring lens bezel (crisp white inner ring + indigo outer ring)
    ctx.beginPath();
    ctx.arc(loupeCenter.x, loupeCenter.y, radiusPage - 1.5 * invZoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2.0 * invZoom;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(loupeCenter.x, loupeCenter.y, radiusPage, 0, Math.PI * 2);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 2.2 * invZoom;
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    const shadowPad = 24 * invZoom;
    const targetPad = 10 * invZoom;
    const minX = Math.min(loupeCenter.x - radiusPage - shadowPad, targetPt.x - targetPad);
    const minY = Math.min(loupeCenter.y - radiusPage - shadowPad, targetPt.y - targetPad);
    const maxX = Math.max(loupeCenter.x + radiusPage + shadowPad, targetPt.x + targetPad);
    const maxY = Math.max(loupeCenter.y + radiusPage + shadowPad, targetPt.y + targetPad);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
    let cancelled = false;
    if (shapesTool.isPolygonActive()) {
      shapesTool.reset();
      this._activeStickyPolygonNoteId = null;
      cancelled = true;
    }
    if (measureTool.isMultiPointActive()) {
      measureTool.cancel();
      this._activeStickyMeasureNoteId = null;
      cancelled = true;
    }
    if (cancelled) {
      if (this._pageScratchCtx && this._pageScratchCanvas) {
        this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
      }
      this._pageScratchCanvas = null;
      this._pageScratchCtx = null;
      this._scratchDirtyRect = null;
      this._cachedShapeVertices = null;
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
    return (
      (shapesTool.isPolygonActive() && shapesTool.activePageIndex === pageIndex) ||
      (measureTool.isMultiPointActive() && measureTool.activePageIndex === pageIndex)
    );
  }

  public clearHover(pageIndex?: number): void {
    if (pageIndex === undefined || this._lastHoverTarget?.pageIndex === pageIndex) {
      this._lastHoverTarget = null;
    }
    if (!this._isPointerDown && this._stylusEraserCursorCanvas) {
      this.restoreStylusEraserCursor();
    }
  }

  public isStylusEraserEvent(e: PointerEvent): boolean {
    return (
      store.toolSettings.stylusInvertedEraserEnabled !== false &&
      e.pointerType === 'pen' &&
      ((e.buttons & 32) !== 0 || (e as any).button === 5)
    );
  }

  public isStylusEraserCursorCanvas(canvas: HTMLCanvasElement): boolean {
    return this._stylusEraserCursorCanvas === canvas;
  }

  public syncStylusEraserCursor(e: PointerEvent, canvas: HTMLCanvasElement): boolean {
    if (this.isStylusEraserEvent(e) && store.activeTool !== 'eraser') {
      this._stylusEraserCursorCanvas = canvas;
      this.setCanvasCursor(canvas, this.getCachedDrawingCursor('eraser'));
      return true;
    }
    if (this._stylusEraserCursorCanvas) {
      const prev = this._stylusEraserCursorCanvas;
      this._stylusEraserCursorCanvas = null;
      this.setCanvasCursor(prev, this.getCachedDrawingCursor());
      if (prev !== canvas) {
        this.setCanvasCursor(canvas, this.getCachedDrawingCursor());
      }
    }
    return false;
  }

  private restoreStylusEraserCursor(upEvent?: PointerEvent): void {
    if (!this._stylusEraserCursorCanvas) return;
    // On pointerup, e.button === 5 can be the button that was just released, so only
    // keep the eraser cursor if the eraser button bit (32) is still held down.
    if (
      upEvent &&
      store.toolSettings.stylusInvertedEraserEnabled !== false &&
      upEvent.pointerType === 'pen' &&
      (upEvent.buttons & 32) !== 0 &&
      store.activeTool !== 'eraser'
    ) {
      this.setCanvasCursor(this._stylusEraserCursorCanvas, this.getCachedDrawingCursor('eraser'));
      return;
    }
    const prev = this._stylusEraserCursorCanvas;
    this._stylusEraserCursorCanvas = null;
    this.setCanvasCursor(prev, this.getCachedDrawingCursor());
  }

  private setCanvasCursor(canvas: HTMLCanvasElement, cursor: string): void {
    if (canvas.style.cursor !== cursor) {
      canvas.style.cursor = cursor;
    }
  }

  private getCachedDrawingCursor(toolOverride?: ToolType): string {
    const tool = toolOverride ?? store.activeTool;
    const ts = store.toolSettings;
    const style = ts.drawingCursor || 'pen';
    const zoomKey = Math.round((store.zoom || 1) * 100);
    const sig = `${tool}|${style}|${zoomKey}|${ts.penWidth}|${ts.eraserWidth}|${ts.eraserCursor || 'circle'}|${ts.highlighterWidth}|${ts.highlighterCursor || 'rectangle'}|${ts.highlighterColor}|${ts.highlighterOpacity ?? 0.45}`;
    if (sig !== this._hoverCursorSig) {
      this._hoverCursorSig = sig;
      this._hoverCursorValue = drawingCursorValue(tool, style, store.zoom);
    }
    return this._hoverCursorValue;
  }

  public handleHover(e: PointerEvent, pageIndex: number, canvas: HTMLCanvasElement, precomputedPt?: Point): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const pageAnns = doc.annotations[pageIndex] || [];
    const pt = precomputedPt ?? this.getPointInPage(e, canvas);
    this._lastHoverTarget = { pageIndex, canvas, pt: { x: pt.x, y: pt.y } };

    if (this.syncStylusEraserCursor(e, canvas)) {
      floatingPropsBar?.setHoverState(false);
      return;
    }

    const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
    if (selected.length > 0) {
      if (selected.length === 1 && selected[0].type === 'sticky-note' && !selected[0].collapsed) {
        if (stickyNoteTool.hitTestCollapseButton(selected[0], pt)) {
          this.setCanvasCursor(canvas, 'pointer');
          floatingPropsBar?.setHoverState(true);
          return;
        }
      }

      const merged = mergeBoundingBoxes(selected.map(getAnnotationSelectionBox));
      const hit = selectionManager.hitTestSelection(
        pt, selected, store.zoom * this.renderDpr()
      );
      const cursorByHandle: Record<string, string> = {
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
      const isNearOrOver = hit !== null || (
        pt.x >= merged.x - 10 &&
        pt.x <= merged.x + merged.width + 10 &&
        pt.y >= merged.y - 10 &&
        pt.y <= merged.y + merged.height + 10
      );
      floatingPropsBar?.setHoverState(isNearOrOver);

      if (hit) {
        this.setCanvasCursor(canvas, hit.startsWith('vertex:') ? 'crosshair' : (cursorByHandle[hit] || 'pointer'));
        return;
      }
    }

    // When Select tool is active and not over a selection handle, switch cursor to
    // pointer over unselected annotations or I-beam ('text') over selectable PDF text.
    if (store.activeTool === 'select') {
      const hoverAnn = selectionManager.findAnnotationAtPoint(pt, pageAnns);
      if (hoverAnn) {
        this.setCanvasCursor(canvas, 'pointer');
        return;
      }
      const layout = pdfEngine.getCachedPageTextLayout(pageIndex);
      if (layout) {
        const textHit = hitTestPageTextPoint(layout, pt.x, pt.y, 4, false);
        this.setCanvasCursor(canvas, textHit ? 'text' : 'default');
      } else {
        this.setCanvasCursor(canvas, 'default');
        void pdfEngine.getPageTextLayout(pageIndex).then((loadedLayout) => {
          const target = this._lastHoverTarget;
          if (
            !loadedLayout ||
            this._isPointerDown ||
            store.activeTool !== 'select' ||
            !target ||
            target.pageIndex !== pageIndex ||
            target.canvas !== canvas ||
            !canvas.isConnected
          ) {
            return;
          }
          const latestAnns = store.activeDocument?.annotations[pageIndex] || [];
          if (selectionManager.findAnnotationAtPoint(target.pt, latestAnns)) return;
          const delayedHit = hitTestPageTextPoint(loadedLayout, target.pt.x, target.pt.y, 4, false);
          if (delayedHit) {
            this.setCanvasCursor(canvas, 'text');
          }
        });
      }
      return;
    }

    if (selected.length > 0) {
      this.setCanvasCursor(canvas, this.getCachedDrawingCursor());
    }
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
      const pending = this._eraserPendingPts.splice(0, this._eraserPendingPts.length);
      if (pending.length > 0) {
        this.applyEraserDirect(pending, this._eraserSession.pageIndex);
      }
      eraserTool.finish();
      this.commitEraserSession(this._eraserSession.pageIndex);
    } else {
      this._eraserPendingPts.length = 0;
      this._stickyEraserPendingPts.length = 0;
      this._stickyEraserPendingNoteId = null;
      // A gesture takeover commits (never silently drops) a selection drag;
      // an uncommitted marquee/lasso is just a rubber band.
      this.commitSelectDrag();
      this.commitStickyItemDrag();
      this._marquee = null;
      this._lasso = null;
      this._textSelectDrag = null;
      penTool.cancel();
      highlighterTool.cancel();
      // Keep finished polygon vertices; a mid-click rubber band is harmless
      // to drop since the next click re-renders it.
      if (!shapesTool.isPolygonActive()) shapesTool.reset();
      measureTool.cancel();
    }

    if (this._pageScratchCtx && this._pageScratchCanvas) {
      penTool.clearLiveSurface(this._pageScratchCtx, this._pageScratchCanvas);
      highlighterTool.clearLiveSurface(this._pageScratchCtx, this._pageScratchCanvas);
      this._pageScratchCtx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
    } else {
      penTool.hideTipOverlay();
    }
    this._isPointerDown = false;
    this._strokeTool = null;
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    this._activeCanvasRect = null;
    this._scratchDirtyRect = null;
    this._predictedPtsBuffer.length = 0;
    this._cachedShapeVertices = null;
    this.restoreStylusEraserCursor();
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
   * Applies a frame's batched eraser sweep straight to the document in ONE
   * vectorized pass (zero history/notify cost) and returns the tight page-space
   * dirty rectangle covering all modified annotations for sub-millisecond
   * clipped repaints, or `null` if nothing was hit.
   */
  private applyEraserDirect(points: Point[], pageIndex: number): BoundingBox | null {
    const doc = store.activeDocument;
    if (!doc || points.length === 0) return null;
    const current = doc.annotations[pageIndex];
    if (!current || current.length === 0) return null;

    const result = eraserTool.testEraseBatch(points, current);
    if (result.toRemove.length === 0) return null;

    const removeIds = new Set<string>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxPad = Math.max(8, (store.toolSettings.eraserWidth || 20) * 0.6);

    const includeAnn = (a: Annotation) => {
      const sw = typeof (a as { strokeWidth?: number }).strokeWidth === 'number'
        ? (a as { strokeWidth: number }).strokeWidth
        : 2;
      const pad = Math.max(10, sw * 2 + 8);
      if (pad > maxPad) maxPad = pad;
      const b = a.box;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    };

    for (let i = 0; i < result.toRemove.length; i++) {
      removeIds.add(result.toRemove[i].id);
      includeAnn(result.toRemove[i]);
    }
    for (let i = 0; i < result.toAdd.length; i++) {
      includeAnn(result.toAdd[i]);
    }

    doc.annotations[pageIndex] = current
      .filter(a => !removeIds.has(a.id))
      .concat(result.toAdd);
    doc.lastModifiedAt = Date.now();

    if (!Number.isFinite(minX)) return null;
    return {
      x: minX - maxPad,
      y: minY - maxPad,
      width: (maxX - minX) + maxPad * 2,
      height: (maxY - minY) + maxPad * 2
    };
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
    const fontFamily = resolveAnnotationFontFamily(tSettings.fontFamily);
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
      fontFamily: resolveAnnotationFontFamily(ann.fontFamily),
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
    const metrics = getStickyNoteLayoutMetrics(ann.box);
    const padX = metrics.padX;
    const headerH = metrics.headerHeight;
    const footerH = metrics.footerReserve;

    const screenRect = {
      left: cRect.left + (ann.box.x + padX) * zoom,
      top: cRect.top + (ann.box.y + headerH) * zoom,
      width: Math.max(40, (ann.box.width - padX * 2) * zoom),
      height: Math.max(24, (ann.box.height - headerH - footerH) * zoom)
    };

    annotationEngine.setEditingAnnotationId(ann.id);
    this._editingStickyNote = { pageIndex, noteId: ann.id };
    onNeedRepaint();

    openInlineEditor({
      rect: screenRect,
      value: ann.text || '',
      fontSize: Math.max(5, (ann.fontSize || 15)) * zoom,
      fontFamily: resolveAnnotationFontFamily(ann.fontFamily),
      color: ann.textColor || '#3b2f1e',
      backgroundColor: 'transparent',
      textAlign: ann.textAlign || 'left',
      padding: Math.max(2, 4 * metrics.uiScale) * zoom,
      placeholder: '',
      selectAllOnOpen: false,
      multilineEnter: true,
      fixedSize: true,
      seamlessCard: true,
      onCommit: (rawText: string) => {
        if (this._editingStickyNote?.noteId === ann.id) {
          this._editingStickyNote = null;
        }
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
        if (this._editingStickyNote?.noteId === ann.id) {
          this._editingStickyNote = null;
        }
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
    const fontFamily = resolveAnnotationFontFamily(tSettings.fontFamily);
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
        textAnn.createdAt = stickyNoteTool.nextContentTimestamp(latestNote);
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
   * Opens the floating inline text editor directly over an existing embedded
   * TextAnnotation inside an expanded Sticky Note (`note.items`).
   */
  public editEmbeddedTextInStickyNote(
    note: StickyNoteAnnotation,
    textItem: TextAnnotation,
    pageIndex: number,
    canvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
    const zoom = store.zoom;
    const cRect = canvas.getBoundingClientRect();
    const pad = textItem.padding ?? 8;

    const screenRect = {
      left: cRect.left + textItem.box.x * zoom,
      top: cRect.top + textItem.box.y * zoom,
      width: Math.max(120, textItem.box.width * zoom),
      height: Math.max(30, textItem.box.height * zoom)
    };

    stickyNoteTool.setEditingEmbeddedItemId(textItem.id);
    onNeedRepaint();

    openInlineEditor({
      rect: screenRect,
      value: textItem.text,
      fontSize: textItem.fontSize * zoom,
      fontFamily: resolveAnnotationFontFamily(textItem.fontFamily),
      color: textItem.color || note.textColor || '#3b2f1e',
      backgroundColor: textItem.backgroundColor || 'transparent',
      textAlign: textItem.textAlign || 'left',
      padding: pad * zoom,
      selectAllOnOpen: true,
      onCommit: (rawText: string) => {
        stickyNoteTool.setEditingEmbeddedItemId(null);
        const cleaned = rawText.replace(/\r\n/g, '\n');
        const latestDoc = store.activeDocument;
        const latestNote = latestDoc?.annotations[pageIndex]?.find(
          (a): a is StickyNoteAnnotation => a.id === note.id && a.type === 'sticky-note'
        ) || note;
        const items = latestNote.items || [];
        if (cleaned.trim().length === 0) {
          const updatedNote: StickyNoteAnnotation = {
            ...latestNote,
            items: items.filter(it => it.id !== textItem.id),
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, latestNote, updatedNote));
          onNeedRepaint();
          return;
        }
        if (cleaned !== textItem.text) {
          const measured = textTool.measureTextBox(
            cleaned,
            textItem.fontSize,
            textItem.fontFamily,
            pad,
            textItem.fontWeight,
            textItem.fontStyle
          );
          const nextItem: TextAnnotation = {
            ...textItem,
            text: cleaned,
            box: {
              x: textItem.box.x,
              y: textItem.box.y,
              width: measured.width,
              height: measured.height
            },
            updatedAt: Date.now()
          };
          const updatedNote: StickyNoteAnnotation = {
            ...latestNote,
            items: items.map(it => (it.id === textItem.id ? nextItem : it)),
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(pageIndex, latestNote, updatedNote));
        }
        onNeedRepaint();
      },
      onCancel: () => {
        stickyNoteTool.setEditingEmbeddedItemId(null);
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
    mode: 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'measure';
    shapeTool?: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';
    measureTool?: 'measure-distance' | 'measure-angle' | 'measure-area';
  } | null {
    const isShape =
      activeTool === 'rectangle' ||
      activeTool === 'ellipse' ||
      activeTool === 'line' ||
      activeTool === 'arrow' ||
      activeTool === 'polygon' ||
      activeTool === 'freeform-shape';
    const isMeasure =
      activeTool === 'measure-distance' ||
      activeTool === 'measure-angle' ||
      activeTool === 'measure-area';

    if (
      activeTool !== 'pen' &&
      activeTool !== 'highlighter' &&
      activeTool !== 'eraser' &&
      activeTool !== 'text' &&
      !isShape &&
      !isMeasure
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
          if (isMeasure) {
            return { note: cand, mode: 'measure', measureTool: activeTool };
          }
          if (activeTool === 'eraser') {
            // Inside an expanded Sticky Note, the Eraser always erases inside the note
            // (strokes and embedded items) rather than deleting the Sticky Note card itself.
            return { note: cand, mode: 'eraser' };
          }
        }
        break;
      }
      // If a page-level annotation sits ABOVE the sticky note at `pt`, do not trap
      // new pen/highlighter/shape/text/measure annotations inside the lower sticky note
      // (which would force them to render underneath `cand`).
      if (activeTool !== 'eraser' && !cand.locked) {
        const pad = Math.max(4, ((cand as any).strokeWidth || 2) / 2);
        const b = cand.box;
        const inCandBox =
          pt.x >= b.x - pad &&
          pt.x <= b.x + b.width + pad &&
          pt.y >= b.y - pad &&
          pt.y <= b.y + b.height + pad;
        if (inCandBox && selectionManager.findAnnotationAtPoint(pt, [cand]) !== null) {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Live-erases freehand strokes and embedded items inside a Sticky Note using
   * AABB early-out and full stroke/object/pixel mode support.
   * Returns `true` only when content actually changed so callers skip redundant repaints.
   */
  private applyStickyNoteEraser(
    points: Point[],
    pageIndex: number,
    noteId: string,
    radius: number,
    mode: 'stroke' | 'pixel' | 'object' = 'stroke'
  ): boolean {
    const doc = store.activeDocument;
    if (!doc?.annotations[pageIndex]) return false;
    const idx = doc.annotations[pageIndex].findIndex(a => a.id === noteId && a.type === 'sticky-note');
    if (idx === -1) return false;
    const note = doc.annotations[pageIndex][idx] as StickyNoteAnnotation;
    const result = eraseStickyNoteContent(note, points, radius, mode);
    if (!result.modified) return false;

    doc.annotations[pageIndex][idx] = {
      ...note,
      strokes: result.strokes,
      items: result.items,
      updatedAt: Date.now()
    };
    doc.lastModifiedAt = Date.now();
    return true;
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

    // Preserve light stylus pressure down to 0.05 so feather-light pen strokes render thin,
    // and detect Linux/WebKitGTK stylus events that report pointerType='mouse' with real hardware pressure/tilt.
    const clampedRaw = (e.pressure !== undefined && e.pressure > 0)
      ? Math.max(0.05, Math.min(1.0, e.pressure))
      : e.pressure;

    const hasRealHardwarePressure =
      e.pointerType === 'pen' ||
      (e.pointerType === 'touch' && e.pressure > 0 && Math.abs(e.pressure - 0.5) > 0.005) ||
      ((e.tiltX && e.tiltX !== 0) || (e.tiltY && e.tiltY !== 0)) ||
      (e.pressure > 0 && Math.abs(e.pressure - 0.5) > 0.01 && e.pressure < 1.0);

    const effectivePointerType = hasRealHardwarePressure && e.pointerType !== 'touch'
      ? 'pen'
      : e.pointerType;

    const mappedPressure = PressureEngine.mapPressure(
      clampedRaw,
      'linear',
      tSettings.pressureSensitivityEnabled !== false,
      effectivePointerType,
      tSettings.mousePressureSimulation === true,
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
