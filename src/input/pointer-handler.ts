/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType, Annotation } from '../core/types';
import { store } from '../core/store';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ReplaceAnnotationsCommand } from '../core/history';
import { PressureEngine } from './pressure';
import { palmRejection } from './palm-rejection';
import { penTool } from '../annotations/tools/pen';
import { highlighterTool } from '../annotations/tools/highlighter';
import { eraserTool } from '../annotations/tools/eraser';
import { shapesTool } from '../annotations/tools/shapes';
import { textTool } from '../annotations/tools/text';
import { stampTool } from '../annotations/tools/stamp';
import { measureTool } from '../annotations/tools/measure';
import { laserTool } from '../annotations/tools/laser';
import { redactionTool } from '../annotations/tools/redaction';
import { selectionManager } from '../annotations/selection';

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
      case 'pen':
        penTool.start(
          pt,
          pageIndex,
          tSettings.penColor,
          tSettings.penWidth,
          tSettings.pressureCurve,
          tSettings.pressureSensitivityEnabled !== false,
          tSettings.pressureStrength || 'balanced'
        );
        break;

      case 'highlighter':
        highlighterTool.start(
          pt,
          pageIndex,
          tSettings.highlighterColor,
          tSettings.highlighterWidth,
          tSettings.highlighterBlendMode,
          tSettings.highlighterStraightLine,
          tSettings.highlighterTipShape
        );
        break;

      case 'eraser':
        eraserTool.start(pt, tSettings.eraserWidth / 2, tSettings.eraserMode);
        this.beginEraserSession(pageIndex);
        this.applyEraserDirect([pt], pageIndex);
        onNeedRepaint();
        break;

      case 'polygon': {
        if (shapesTool.isPolygonActive()) {
          const closed = shapesTool.addPolygonVertex(pt);
          if (closed) {
            const polyAnn = shapesTool.finish(defaultLayerId);
            if (polyAnn) {
              history.execute(new AddAnnotationCommand(pageIndex, polyAnn));
            }
            if (this._pageScratchCtx) {
              this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
            }
            onNeedRepaint();
            return;
          }
          if (this._pageScratchCtx) {
            this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
            shapesTool.renderScratchpad(this._pageScratchCtx, store.zoom * (window.devicePixelRatio || 1));
          }
          return;
        }

        shapesTool.start(
          pt,
          pageIndex,
          'polygon',
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          tSettings.shapeWidth,
          tSettings.shapeStyle
        );
        break;
      }

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'freeform-shape':
        shapesTool.start(
          pt,
          pageIndex,
          tool,
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          tSettings.shapeWidth,
          tSettings.shapeStyle
        );
        break;

      case 'text':
        const textAnn = textTool.createTextAnnotation(
          pt,
          pageIndex,
          defaultLayerId,
          'Double click to edit text',
          tSettings.fontSize,
          tSettings.fontFamily,
          tSettings.textColor,
          tSettings.textBgColor,
          tSettings.textAlign
        );
        history.execute(new AddAnnotationCommand(pageIndex, textAnn));
        store.setActiveTool('select');
        store.selectAnnotation(textAnn.id);
        onNeedRepaint();
        break;

      case 'stamp':
        const stampAnn = stampTool.createPresetStamp(pt, pageIndex, defaultLayerId, tSettings.stampPreset || 'APPROVED');
        history.execute(new AddAnnotationCommand(pageIndex, stampAnn));
        store.setActiveTool('select');
        store.selectAnnotation(stampAnn.id);
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

      case 'laser':
        laserTool.start(pt, onNeedRepaint);
        break;

      case 'redaction':
        redactionTool.start(pt, pageIndex, tSettings.redactionColor || '#000000');
        break;

      case 'select':
        const doc = store.activeDocument;
        if (doc) {
          const ann = selectionManager.findAnnotationAtPoint(pt, doc.annotations[pageIndex] || []);
          if (ann) {
            store.selectAnnotation(ann.id, e.shiftKey);
          } else if (!e.shiftKey) {
            store.clearSelection();
          }
          onNeedRepaint();
        }
        break;
    }
  }

  public handlePointerMove(
    e: PointerEvent,
    pageIndex: number,
    scratchCanvas: HTMLCanvasElement,
    onNeedRepaint: () => void
  ): void {
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

    const dpr = window.devicePixelRatio || 1;
    const renderScale = store.zoom * dpr;
    const pts = coalescedEvents.map((evt: PointerEvent) => this.getPointInPage(evt, scratchCanvas));
    if (pts.length === 0) return;
    const lastPt = pts[pts.length - 1];
    const shiftKey = (e as MouseEvent).shiftKey === true;

    switch (tool) {
      case 'pen':
        for (const pt of pts) penTool.move(pt);
        penTool.renderScratchpad(ctx, renderScale);
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
      case 'freeform-shape':
        for (const pt of pts) shapesTool.move(pt);
        shapesTool.renderScratchpad(ctx, renderScale);
        break;

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        for (const pt of pts) measureTool.move(pt);
        measureTool.renderScratchpad(ctx, renderScale);
        break;

      case 'laser':
        for (const pt of pts) laserTool.move(pt);
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
    onNeedRepaint: () => void
  ): void {
    if (!this._isPointerDown || this._activePageIndex !== pageIndex) return;

    this._isPointerDown = false;
    const tool = this._strokeTool ?? store.activeTool;
    const defaultLayerId = 'layer-default';

    if (tool === 'polygon') {
      this._isPointerDown = false;
      this._strokeTool = null;
      // Polygons remain active across clicks until closed or completed
      if (this._pageScratchCtx && shapesTool.isPolygonActive()) {
        shapesTool.renderScratchpad(this._pageScratchCtx, store.zoom * (window.devicePixelRatio || 1));
      }
      return;
    }

    // Clear scratchpad canvas
    if (this._pageScratchCtx) {
      this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    }

    switch (tool) {
      case 'pen':
        const penAnn = penTool.finish(defaultLayerId);
        if (penAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, penAnn));
        }
        break;

      case 'highlighter':
        const highAnn = highlighterTool.finish(defaultLayerId);
        if (highAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, highAnn));
        }
        break;

      case 'eraser':
        eraserTool.finish();
        this.commitEraserSession(pageIndex);
        break;

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'freeform-shape':
        const shapeAnn = shapesTool.finish(defaultLayerId);
        if (shapeAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, shapeAnn));
        }
        break;

      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
        const measureAnn = measureTool.finish(defaultLayerId);
        if (measureAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, measureAnn));
        }
        break;

      case 'laser':
        laserTool.stop();
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

    if (tool === 'eraser' && this._eraserSession) {
      eraserTool.finish();
      this.commitEraserSession(this._eraserSession.pageIndex);
    } else {
      penTool.cancel();
      highlighterTool.cancel();
      // Keep finished polygon vertices; a mid-click rubber band is harmless
      // to drop since the next click re-renders it.
      if (!shapesTool.isPolygonActive()) shapesTool.reset();
      measureTool.cancel();
      redactionTool.cancel();
      laserTool.stop();
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
