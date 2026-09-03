/**
 * Master Input & Pointer Event Coordinator
 * Handles 120/240Hz coalesced events, stylus pressure, palm rejection, and tool dispatching.
 */

import { Point, StrokePoint, ToolType } from '../core/types';
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
          tSettings.highlighterBlendMode
        );
        break;

      case 'eraser':
        eraserTool.start(pt, tSettings.eraserWidth / 2, tSettings.eraserMode);
        this.processEraser(pt, pageIndex, onNeedRepaint);
        break;

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'polygon':
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
        const stampAnn = stampTool.createPresetStamp(pt, pageIndex, defaultLayerId, 'APPROVED');
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
        redactionTool.start(pt, pageIndex);
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

    // Use coalesced events for extreme pen drawing smoothness
    const coalescedEvents = (e as any).getCoalescedEvents ? (e as any).getCoalescedEvents() : [e];
    const tool = store.activeTool;
    const ctx = this._pageScratchCtx;
    if (!ctx) return;

    // Clear scratchpad canvas
    ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);

    const dpr = window.devicePixelRatio || 1;
    const renderScale = store.zoom * dpr;

    for (const evt of coalescedEvents) {
      const pt = this.getPointInPage(evt, scratchCanvas);

      switch (tool) {
        case 'pen':
          penTool.move(pt);
          penTool.renderScratchpad(ctx, renderScale);
          break;

        case 'highlighter':
          highlighterTool.move(pt);
          highlighterTool.renderScratchpad(ctx, renderScale);
          break;

        case 'eraser':
          eraserTool.move(pt);
          this.processEraser(pt, pageIndex, onNeedRepaint);
          eraserTool.renderScratchpad(ctx, pt, renderScale);
          break;

        case 'rectangle':
        case 'ellipse':
        case 'line':
        case 'arrow':
        case 'polygon':
        case 'freeform-shape':
          shapesTool.move(pt);
          shapesTool.renderScratchpad(ctx, renderScale);
          break;

        case 'measure-distance':
        case 'measure-angle':
        case 'measure-area':
          measureTool.move(pt);
          measureTool.renderScratchpad(ctx, renderScale);
          break;

        case 'laser':
          laserTool.move(pt);
          break;

        case 'redaction':
          redactionTool.move(pt);
          redactionTool.renderScratchpad(ctx, renderScale);
          break;
      }
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
    const tool = store.activeTool;
    const defaultLayerId = 'layer-default';

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
        break;

      case 'rectangle':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'polygon':
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
    this._activePageIndex = -1;
    this._pageScratchCanvas = null;
    this._pageScratchCtx = null;
    onNeedRepaint();
  }

  private processEraser(point: Point, pageIndex: number, onNeedRepaint: () => void) {
    const doc = store.activeDocument;
    if (!doc || !doc.annotations[pageIndex]) return;

    const result = eraserTool.testErase(point, doc.annotations[pageIndex]);
    if (result.toRemove.length > 0) {
      if (result.toAdd.length > 0) {
        history.execute(new ReplaceAnnotationsCommand(pageIndex, result.toRemove, result.toAdd));
      } else {
        history.execute(new DeleteAnnotationsCommand(pageIndex, result.toRemove));
      }
      onNeedRepaint();
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
