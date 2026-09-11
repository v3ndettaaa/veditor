/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType, Annotation, BoundingBox } from '../core/types';
import { store } from '../core/store';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ReplaceAnnotationsCommand, BulkModifyCommand } from '../core/history';
import { mergeBoundingBoxes } from '../utils/geometry';
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
import {
  selectionManager,
  normalizeDragBox,
  cloneAnnotation,
  transformAnnotation,
  rotatePoint,
  boxCenter,
  BoxTransform,
  HandleType
} from '../annotations/selection';

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

  /**
   * Lens width compensation: while a zoom-lens is active, creation widths are
   * divided by (zoom / baseZoom) so tools feel identical on screen. Stored
   * data stays in PDF points, so exiting the lens shrinks the content.
   */
  private lensWidth(base: number): number {
    const f = store.zoomLensFactor;
    return f !== 1 ? base / f : base;
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

      case 'pen':
        penTool.start(
          pt,
          pageIndex,
          tSettings.penColor,
          this.lensWidth(tSettings.penWidth),
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
          this.lensWidth(tSettings.highlighterWidth),
          tSettings.highlighterBlendMode,
          tSettings.highlighterStraightLine,
          tSettings.highlighterTipShape
        );
        break;

      case 'eraser':
        eraserTool.start(pt, this.lensWidth(tSettings.eraserWidth) / 2, tSettings.eraserMode);
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
      case 'freeform-shape':
        shapesTool.start(
          pt,
          pageIndex,
          tool,
          tSettings.shapeColor,
          tSettings.shapeFillColor,
          this.lensWidth(tSettings.shapeWidth),
          tSettings.shapeStyle,
          tSettings.shapeOutline !== false
        );
        break;

      case 'text':
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
        store.selectAnnotation(textAnn.id);
        onNeedRepaint();
        break;

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
        store.selectAnnotation(stampBase.id);
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
          const merged = mergeBoundingBoxes(selected.map(a => a.box));
          // Lone rotated annotations hit-test in their rotated frame.
          const singleRot = selected.length === 1 ? selected[0].rotation || 0 : 0;
          const hit = selectionManager.hitTestHandles(
            pt, merged, store.zoom * (window.devicePixelRatio || 1), singleRot
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
        } else {
          // 3. Empty press: rubber-band region select (tiny drag = click).
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
              const t = this.selectTransformFor(drag, effLast);
              doc.annotations[pageIndex] = doc.annotations[pageIndex].map(a => {
                const orig = drag.originals.get(a.id);
                return orig ? (transformAnnotation(orig, t) as typeof a) : a;
              });
              doc.lastModifiedAt = Date.now();
            }
          }
          onNeedRepaint();
        } else if (this._marquee && this._marquee.pageIndex === pageIndex) {
          this._marquee.current = { ...lastPt };
          this.renderMarquee(ctx, renderScale);
        }
        break;
      }

      case 'zoom-lens':
        this._zoomMarqueeCurrent = { ...lastPt };
        this.renderZoomMarquee(ctx, renderScale);
        break;

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
        // Shift constrains drag shapes to regular forms (square / circle /
        // 15°-snapped line), mirroring the highlighter's straight-snap key.
        for (const pt of pts) shapesTool.move(pt, shiftKey);
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
        shapesTool.renderScratchpad(this._pageScratchCtx, store.zoom * (window.devicePixelRatio || 1));
      }
      return;
    }

    // Clear scratchpad canvas
    if (this._pageScratchCtx) {
      this._pageScratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    }

    switch (tool) {
      case 'select':
        this.commitSelectDrag();
        if (this._marquee) {
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
    cur: Point
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
    if (h.includes('e')) x2 += dx;
    if (h.includes('s')) y2 += dy;
    if (h.includes('w')) x1 += dx;
    if (h.includes('n')) y1 += dy;
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
      this._zoomMarqueeStart = null;
      this._zoomMarqueeCurrent = null;
      // A gesture takeover commits (never silently drops) a selection drag;
      // an uncommitted marquee is just a rubber band, safe to discard.
      this.commitSelectDrag();
      this._marquee = null;
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
