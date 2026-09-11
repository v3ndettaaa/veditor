/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType, Annotation, BoundingBox, ShapeAnnotation, StickyNoteAnnotation, PaperStyle } from '../core/types';
import { store } from '../core/store';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ReplaceAnnotationsCommand, BulkModifyCommand, ModifyAnnotationCommand } from '../core/history';
import { mergeBoundingBoxes, computePointsBoundingBox } from '../utils/geometry';
import { fitStroke, type FittedShape } from '../utils/shape-fit';
import { annotationEngine } from '../annotations/engine';
import { PressureEngine } from './pressure';
import { palmRejection } from './palm-rejection';
import { penTool } from '../annotations/tools/pen';
import { stickyNoteTool } from '../annotations/tools/sticky-note';
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
  /** Freehand lasso path (Alt+drag in Select): closed loop, page coordinates. */
  private _lasso: { pageIndex: number; points: Point[]; additive: boolean } | null = null;
  /** Sticky-note card drag (tool creates sized cards like rectangle drags). */
  private _noteDraft: { pageIndex: number; start: Point; current: Point } | null = null;
  /** Live inner-note stroke (pen/highlighter routed into an editing note). */
  private _noteStroke: {
    noteId: string;
    pageIndex: number;
    kind: 'pen' | 'highlighter';
    color: string;
    width: number;
    points: StrokePoint[];
    prev: StickyNoteAnnotation;
    dirty: boolean;
  } | null = null;
  /** Snapshot for inner-note eraser sessions (single undo step on lift). */
  private _noteErasePrev: { noteId: string; pageIndex: number; prev: StickyNoteAnnotation; dirty: boolean } | null = null;

  /**
   * Draw-and-hold shape recognition (pen only): holding the pointer nearly
   * still briefly snaps the live stroke to a geometric primitive on lift.
   * Never runs on the move hot path — one timer, one fit per hold.
   */
  private _holdTimer: number | null = null;
  private _holdAnchor: Point | null = null;
  private _holdFired: boolean = false;
  private _holdShape: FittedShape | null = null;
  private static readonly HOLD_DELAY_MS = 400;
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

  /** Default paper for new sticky notes from the toolbar paper choice. */
  private defaultNotePaper(): PaperStyle {
    const pattern = store.toolSettings.stickyPaper || 'lined';
    return { pattern, spacing: 22, lineColor: '#d9c66c', paperColor: '#fef9c3', margin: false };
  }

  /** Any sticky note hit at a page point (pin-aware for collapsed notes). */
  private findNoteAt(pageIndex: number, pt: Point): StickyNoteAnnotation | null {
    const doc = store.activeDocument;
    if (!doc) return null;
    for (let i = (doc.annotations[pageIndex] || []).length - 1; i >= 0; i--) {
      const a = doc.annotations[pageIndex][i];
      if (a.type !== 'sticky-note' || a.locked) continue;
      if (stickyNoteTool.hitTest(pt, a as StickyNoteAnnotation)) {
        return a as StickyNoteAnnotation;
      }
    }
    return null;
  }

  /** The editing note under a page point (expanded card body only). */
  private editingNoteAt(pageIndex: number, pt: Point): StickyNoteAnnotation | null {
    const id = store.editingNoteId;
    if (!id) return null;
    const doc = store.activeDocument;
    if (!doc) return null;
    const ann = (doc.annotations[pageIndex] || []).find(a => a.id === id);
    if (!ann || ann.type !== 'sticky-note') return null;
    const note = ann as StickyNoteAnnotation;
    if (note.collapsed) return null;
    const b = note.box;
    if (pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height) return null;
    return note;
  }

  private noteLocal(note: StickyNoteAnnotation, pt: Point): Point {
    return { x: pt.x - note.box.x, y: pt.y - note.box.y };
  }

  /** Live (mutable) note reference for in-progress inner sessions. */
  private liveNote(doc: { annotations: Record<number, Annotation[]> }, pageIndex: number, noteId: string): StickyNoteAnnotation | null {
    const ann = (doc.annotations[pageIndex] || []).find(a => a.id === noteId);
    if (!ann || ann.type !== 'sticky-note') return null;
    return ann as StickyNoteAnnotation;
  }

  /** Replaces the live temp stroke view from the accumulated session points. */
  private syncNoteStrokeLive(note: StickyNoteAnnotation): void {
    const s = this._noteStroke;
    if (!s) return;
    const base = s.prev.ink;
    note.ink = [...base, { kind: s.kind, points: [...s.points], color: s.color, strokeWidth: s.width }];
    note.updatedAt = Date.now();
  }

  /**
   * Erases inner-note ink/texts near a page point. Returns true when anything
   * was removed. Coordinates: ink/texts are note-local, pt is page units.
   */
  private eraseNoteAt(note: StickyNoteAnnotation, pt: Point, radius: number): boolean {
    const local = this.noteLocal(note, pt);
    let changed = false;
    const before = note.ink.length;
    note.ink = note.ink.filter(s => {
      for (const p of s.points) {
        if (Math.hypot(p.x - local.x, p.y - local.y) <= radius + s.strokeWidth / 2) return false;
      }
      return true;
    });
    if (note.ink.length !== before) changed = true;
    const tBefore = note.texts.length;
    note.texts = note.texts.filter(t => {
      const inX = local.x >= t.x - 4 && local.x <= t.x + t.w + 4;
      const inY = local.y >= t.y - 4 && local.y <= t.y + t.fontSize * 1.5 + 4;
      return !(inX && inY);
    });
    if (note.texts.length !== tBefore) changed = true;
    if (changed) note.updatedAt = Date.now();
    return changed;
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
    // Swap the live ink preview for the snapped shape immediately.
    if (this._pageScratchCtx && this._pageScratchCanvas) {
      const ctx = this._pageScratchCtx;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, this._pageScratchCanvas.width, this._pageScratchCanvas.height);
      const preview = this.buildHoldShapeAnnotation(fit, this._activePageIndex, 'layer-default');
      if (preview) annotationEngine.renderSingleAnnotation(ctx, preview, store.zoom * dpr);
    }
  }

  /** Builds the snapped ShapeAnnotation with current shape styling. */
  private buildHoldShapeAnnotation(fit: FittedShape, pageIndex: number, layerId: string): ShapeAnnotation | null {
    const s = store.toolSettings;
    const strokeWidth = this.lensWidth(s.shapeWidth);
    const base = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      strokeColor: s.shapeColor,
      fillColor: s.shapeFillColor,
      strokeWidth,
      outline: s.shapeOutline !== false,
      strokeStyle: s.shapeStyle,
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
        const target = this.editingNoteAt(pageIndex, pt);
        if (target) {
          const local = this.noteLocal(target, pt);
          this._noteStroke = {
            noteId: target.id,
            pageIndex,
            kind: 'pen',
            color: tSettings.penColor,
            width: this.lensWidth(tSettings.penWidth),
            points: [{ ...local, pressure: 0.5 }],
            prev: cloneAnnotation(target),
            dirty: false
          };
          this.syncNoteStrokeLive(target);
          onNeedRepaint();
          break;
        }
        penTool.start(
          pt,
          pageIndex,
          tSettings.penColor,
          this.lensWidth(tSettings.penWidth),
          tSettings.pressureCurve,
          tSettings.pressureSensitivityEnabled !== false,
          tSettings.pressureStrength || 'balanced'
        );
        this.startHoldTimer({ x: pt.x, y: pt.y });
        break;
      }

      case 'highlighter': {
        const target = this.editingNoteAt(pageIndex, pt);
        if (target) {
          const local = this.noteLocal(target, pt);
          this._noteStroke = {
            noteId: target.id,
            pageIndex,
            kind: 'highlighter',
            color: tSettings.highlighterColor,
            width: this.lensWidth(tSettings.highlighterWidth),
            points: [{ ...local, pressure: 0.5 }],
            prev: cloneAnnotation(target),
            dirty: false
          };
          this.syncNoteStrokeLive(target);
          onNeedRepaint();
          break;
        }
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
      }

      case 'eraser': {
        const target = this.editingNoteAt(pageIndex, pt);
        if (target) {
          this._noteErasePrev = { noteId: target.id, pageIndex, prev: cloneAnnotation(target), dirty: false };
          this.eraseNoteAt(target, pt, this.lensWidth(tSettings.eraserWidth) / 2);
          onNeedRepaint();
          break;
        }
        eraserTool.start(pt, this.lensWidth(tSettings.eraserWidth) / 2, tSettings.eraserMode);
        this.beginEraserSession(pageIndex);
        this.applyEraserDirect([pt], pageIndex);
        onNeedRepaint();
        break;
      }

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

      case 'text': {
        const noteTarget = this.editingNoteAt(pageIndex, pt);
        if (noteTarget) {
          const prev = cloneAnnotation(noteTarget);
          const local = this.noteLocal(noteTarget, pt);
          const next = cloneAnnotation(noteTarget);
          next.texts = [...next.texts, {
            text: 'Note...',
            fontFamily: tSettings.fontFamily,
            fontSize: this.lensWidth(tSettings.fontSize),
            color: tSettings.textColor,
            x: Math.max(0, local.x),
            y: Math.max(0, local.y),
            w: Math.max(20, noteTarget.box.width - local.x - 8)
          }];
          next.updatedAt = Date.now();
          history.execute(new ModifyAnnotationCommand(pageIndex, prev, next));
          onNeedRepaint();
          break;
        }
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

      case 'sticky-note': {
        // Click an expanded note to edit inside it; otherwise start a card drag.
        const existing = this.findNoteAt(pageIndex, pt);
        if (existing && !existing.collapsed) {
          store.setEditingNote(existing.id);
          store.selectAnnotation(existing.id);
          onNeedRepaint();
          // End the press immediately: editing strokes start on the next press.
          this._isPointerDown = false;
          this._strokeTool = null;
          this._activePageIndex = -1;
          this._pageScratchCanvas = null;
          this._pageScratchCtx = null;
          return;
        }
        this._noteDraft = { pageIndex, start: { x: pt.x, y: pt.y }, current: { x: pt.x, y: pt.y } };
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

    // Inner-note sessions bypass the page tool switch entirely.
    if (this._noteStroke && this._noteStroke.pageIndex === pageIndex) {
      const doc = store.activeDocument;
      const note = doc ? this.liveNote(doc, pageIndex, this._noteStroke.noteId) : null;
      if (note) {
        for (const pt of pts) {
          const local = this.noteLocal(note, pt);
          this._noteStroke.points.push({ ...local, pressure: 0.5 });
        }
        this._noteStroke.dirty = true;
        this.syncNoteStrokeLive(note);
        doc!.lastModifiedAt = Date.now();
        onNeedRepaint();
      }
      return;
    }
    if (this._noteErasePrev && this._noteErasePrev.pageIndex === pageIndex) {
      const doc = store.activeDocument;
      const note = doc ? this.liveNote(doc, pageIndex, this._noteErasePrev.noteId) : null;
      if (note) {
        const r = this.lensWidth(store.toolSettings.eraserWidth) / 2;
        for (const pt of pts) {
          if (this.eraseNoteAt(note, pt, r)) this._noteErasePrev.dirty = true;
        }
        if (this._noteErasePrev.dirty) {
          doc!.lastModifiedAt = Date.now();
          onNeedRepaint();
        }
      }
      return;
    }

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
        } else if (this._lasso && this._lasso.pageIndex === pageIndex) {
          for (const pt of pts) {
            const path = this._lasso.points;
            const prev = path[path.length - 1];
            // Drop sub-pixel jitter so the loop stays lean.
            if (!prev || Math.abs(pt.x - prev.x) + Math.abs(pt.y - prev.y) > 1.5) {
              path.push({ x: pt.x, y: pt.y });
            }
          }
          this.renderLassoPath(ctx, renderScale);
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
        // Draw-and-hold: moving past the hold radius restarts (or cancels a
        // fired preview back to ink); stillness lets the timer snap.
        if (this._holdAnchor && Math.hypot(lastPt.x - this._holdAnchor.x, lastPt.y - this._holdAnchor.y) > PointerHandler.HOLD_RADIUS) {
          this._holdFired = false;
          this._holdShape = null;
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

      case 'sticky-note':
        if (this._noteDraft && this._noteDraft.pageIndex === pageIndex) {
          this._noteDraft.current = { ...lastPt };
          const box = normalizeDragBox(this._noteDraft.start, this._noteDraft.current, 4);
          ctx.save();
          ctx.scale(renderScale, renderScale);
          ctx.fillStyle = 'rgba(254, 249, 195, 0.5)';
          ctx.fillRect(box.x, box.y, box.width, box.height);
          ctx.strokeStyle = '#b45309';
          ctx.lineWidth = 1.5 / renderScale;
          ctx.setLineDash([5 / renderScale, 4 / renderScale]);
          ctx.strokeRect(box.x, box.y, box.width, box.height);
          ctx.restore();
        }
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
        // Inner-note stroke commits as one Modify step on the note.
        if (this._noteStroke && this._noteStroke.pageIndex === pageIndex) {
          const s = this._noteStroke;
          this._noteStroke = null;
          const doc = store.activeDocument;
          const note = doc ? this.liveNote(doc, pageIndex, s.noteId) : null;
          if (doc && note && s.dirty) {
            const next = cloneAnnotation(note);
            doc.lastModifiedAt = Date.now();
            history.pushCommitted(new ModifyAnnotationCommand(pageIndex, s.prev, next));
          }
          break;
        }
        const snapped = this._holdFired ? this._holdShape : null;
        const holdPage = this._activePageIndex;
        this.clearHoldTimer();
        if (snapped) {
          const shapeAnn = this.buildHoldShapeAnnotation(snapped, holdPage, defaultLayerId);
          penTool.cancel();
          this._holdFired = false;
          this._holdShape = null;
          if (shapeAnn) {
            history.execute(new AddAnnotationCommand(holdPage, shapeAnn));
            // Expose transform handles immediately, like text/stamp placement.
            store.setActiveTool('select');
            store.selectAnnotation(shapeAnn.id);
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
        if (this._noteStroke && this._noteStroke.pageIndex === pageIndex) {
          const s = this._noteStroke;
          this._noteStroke = null;
          const doc = store.activeDocument;
          const note = doc ? this.liveNote(doc, pageIndex, s.noteId) : null;
          if (doc && note && s.dirty) {
            const next = cloneAnnotation(note);
            doc.lastModifiedAt = Date.now();
            history.pushCommitted(new ModifyAnnotationCommand(pageIndex, s.prev, next));
          }
          break;
        }
        const highAnn = highlighterTool.finish(defaultLayerId);
        if (highAnn) {
          history.execute(new AddAnnotationCommand(pageIndex, highAnn));
        }
        break;
      }

      case 'eraser': {
        if (this._noteErasePrev && this._noteErasePrev.pageIndex === pageIndex) {
          const s = this._noteErasePrev;
          this._noteErasePrev = null;
          const doc = store.activeDocument;
          const note = doc ? this.liveNote(doc, pageIndex, s.noteId) : null;
          if (doc && note && s.dirty) {
            const next = cloneAnnotation(note);
            doc.lastModifiedAt = Date.now();
            history.pushCommitted(new ModifyAnnotationCommand(pageIndex, s.prev, next));
          }
          break;
        }
        eraserTool.finish();
        this.commitEraserSession(pageIndex);
        break;
      }

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

      case 'sticky-note': {
        const draft = this._noteDraft;
        this._noteDraft = null;
        if (draft && draft.pageIndex === pageIndex) {
          const raw = normalizeDragBox(draft.start, draft.current, 4);
          const box = {
            x: raw.x,
            y: raw.y,
            width: Math.max(80, raw.width),
            height: Math.max(60, raw.height)
          };
          const note = stickyNoteTool.createNote(
            { x: box.x, y: box.y },
            pageIndex,
            defaultLayerId,
            this.defaultNotePaper(),
            box.width,
            box.height
          );
          history.execute(new AddAnnotationCommand(pageIndex, note));
          // Open for inner editing right away + select for transform handles.
          store.setEditingNote(note.id);
          store.selectAnnotation(note.id);
        }
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

  /**
   * Double-click on a sticky note: pin toggles collapse/expand, a text entry
   * inside an editing note opens a prompt editor, otherwise the note opens
   * for inner editing. Returns true when a note consumed the event
   * (caller must skip polygon-close / dblclick-zoom).
   */
  public handleNoteDoubleClick(e: PointerEvent, pageIndex: number, canvas: HTMLCanvasElement, onRepaint: () => void): boolean {
    const doc = store.activeDocument;
    if (!doc) return false;
    const pt = this.getPointInPage(e, canvas);
    const note = this.findNoteAt(pageIndex, pt);
    if (!note) return false;
    if (!note.collapsed && store.editingNoteId === note.id) {
      // Edit the text entry under the cursor, if any.
      const local = this.noteLocal(note, pt);
      const hit = note.texts.findIndex(t =>
        local.x >= t.x - 2 && local.x <= t.x + t.w + 2 &&
        local.y >= t.y - 2 && local.y <= t.y + t.fontSize * 1.6 + 2
      );
      if (hit !== -1) {
        const current = note.texts[hit].text;
        const nextText = window.prompt('Edit note text:', current);
        if (nextText !== null && nextText !== current) {
          const prev = cloneAnnotation(note);
          const next = cloneAnnotation(note);
          next.texts[hit] = { ...next.texts[hit], text: nextText };
          next.updatedAt = Date.now();
          history.execute(new ModifyAnnotationCommand(pageIndex, prev, next));
          onRepaint();
        }
        return true;
      }
    }
    // Toggle collapse (pin <-> card) as one undo step + select the note.
    const prev = cloneAnnotation(note);
    const next = cloneAnnotation(note);
    next.collapsed = !next.collapsed;
    next.updatedAt = Date.now();
    history.execute(new ModifyAnnotationCommand(pageIndex, prev, next));
    if (next.collapsed) {
      if (store.editingNoteId === next.id) store.setEditingNote(null);
    } else {
      store.setEditingNote(next.id);
    }
    store.selectAnnotation(next.id);
    onRepaint();
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
    this.clearHoldTimer();
    this._holdFired = false;
    this._holdShape = null;

    if (tool === 'eraser' && this._eraserSession) {
      eraserTool.finish();
      this.commitEraserSession(this._eraserSession.pageIndex);
    } else {
      this._zoomMarqueeStart = null;
      this._zoomMarqueeCurrent = null;
      // A gesture takeover commits (never silently drops) a selection drag;
      // an uncommitted marquee/lasso/note-draft is just a rubber band.
      this.commitSelectDrag();
      this._marquee = null;
      this._lasso = null;
      this._noteDraft = null;
      // Restore inner-note sessions to their snapshots (no partial marks).
      this.restoreNoteSessions();
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

  /** Restores inner-note snapshots, discarding uncommitted live changes. */
  private restoreNoteSessions(): void {
    const doc = store.activeDocument;
    if (this._noteStroke && doc) {
      const list = doc.annotations[this._noteStroke.pageIndex];
      if (list) {
        const idx = list.findIndex(a => a.id === this._noteStroke!.noteId);
        if (idx !== -1) list[idx] = this._noteStroke.prev as any;
      }
    }
    if (this._noteErasePrev && doc) {
      const list = doc.annotations[this._noteErasePrev.pageIndex];
      if (list) {
        const idx = list.findIndex(a => a.id === this._noteErasePrev!.noteId);
        if (idx !== -1) list[idx] = this._noteErasePrev.prev as any;
      }
    }
    this._noteStroke = null;
    this._noteErasePrev = null;
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
