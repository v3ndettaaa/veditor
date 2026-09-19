/**
 * Shapes Annotation Tool
 * Supports Rectangle, Ellipse, Line, Arrow, Polygon, and Freeform shapes.
 */

import { Point, ShapeAnnotation, ToolType, BoundingBox } from '../../core/types';
import { computePointsBoundingBox, traceRoundedPolygon, fillLineRibbon } from '../../utils/geometry';
import { SHAPE_CORNER_RADIUS } from '../engine';

export type ConstrainedShapeType = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';

/**
 * Constrains a drag point to a regular shape while Shift is held:
 * - rectangle / ellipse: equal sides (square / circle), growing from the drag
 *   start and preserving the drag direction per axis;
 * - line / arrow: angle snapped to 15° increments, length preserved;
 * - polygon / freeform: unconstrained.
 *
 * Pure function so the geometry is unit-testable.
 */
export function constrainShapePoint(
  type: ConstrainedShapeType,
  start: Point,
  current: Point
): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;

  if (type === 'rectangle' || type === 'ellipse') {
    if (dx === 0 && dy === 0) return { ...current };
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: start.x + (dx === 0 ? 0 : Math.sign(dx) * side),
      y: start.y + (dy === 0 ? 0 : Math.sign(dy) * side)
    };
  }

  if (type === 'line' || type === 'arrow') {
    return snapPointTo15(start, current);
  }

  return { ...current };
}

/** Snaps `current` to the nearest 15° ray from `anchor`, preserving length. */
export function snapPointTo15(anchor: Point, current: Point): Point {
  const dx = current.x - anchor.x;
  const dy = current.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...current };
  const step = Math.PI / 12; // 15°
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: anchor.x + len * Math.cos(snapped),
    y: anchor.y + len * Math.sin(snapped)
  };
}

export class ShapesTool {
  private _startPoint: Point | null = null;
  private _currentPoint: Point | null = null;
  private _polygonPoints: Point[] = [];
  private _pageIndex: number = 0;
  private _type: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape' = 'rectangle';
  private _strokeColor: string = '#ef4444';
  private _fillColor: string = 'transparent';
  private _strokeWidth: number = 2;
  private _outline: boolean = true;
  private _strokeStyle: 'solid' | 'dashed' | 'dotted' = 'solid';
  /** True while Shift is held: preview and finish a regular shape. */
  private _constrain: boolean = false;
  /** True while 15° angle snapping is active (Shift or the tool's Snap-15° option). */
  private _snapAngle: boolean = false;

  public start(
    point: Point,
    pageIndex: number,
    type: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape',
    strokeColor: string,
    fillColor: string,
    strokeWidth: number,
    strokeStyle: 'solid' | 'dashed' | 'dotted',
    outline: boolean = true
  ) {
    this._startPoint = point;
    this._currentPoint = point;
    this._pageIndex = pageIndex;
    this._type = type;
    this._strokeColor = strokeColor;
    this._fillColor = fillColor;
    this._strokeWidth = strokeWidth;
    this._outline = outline;
    this._strokeStyle = strokeStyle;
    this._constrain = false;
    this._snapAngle = false;

    if (type === 'polygon' || type === 'freeform-shape') {
      this._polygonPoints.push(point);
    }
  }

  public move(point: Point, constrain: boolean = false, snapAngle: boolean = false): void {
    this._currentPoint = point;
    // Rectangle/ellipse only square up for Shift; line/arrow snap for Shift
    // OR the tool's Snap-15° option; polygon/freeform snap their elastic segment.
    this._constrain = constrain &&
      (this._type === 'rectangle' || this._type === 'ellipse' ||
       this._type === 'line' || this._type === 'arrow');
    this._snapAngle = snapAngle;
    if (this._type === 'freeform-shape') {
      this._polygonPoints.push(point);
    }
  }

  /** Current drag point with the active constraint applied. */
  private effectiveCurrent(): Point | null {
    if (!this._startPoint || !this._currentPoint) return null;
    if (this._type === 'polygon' || this._type === 'freeform-shape') {
      if (!this._snapAngle) return this._currentPoint;
      const anchor = this._polygonPoints.length > 0
        ? this._polygonPoints[this._polygonPoints.length - 1]
        : this._startPoint;
      return snapPointTo15(anchor, this._currentPoint);
    }
    if (!this._constrain && !this._snapAngle) return this._currentPoint;
    if (this._type === 'line' || this._type === 'arrow') {
      return snapPointTo15(this._startPoint, this._currentPoint);
    }
    if (this._constrain) {
      return constrainShapePoint(this._type, this._startPoint, this._currentPoint);
    }
    return this._currentPoint;
  }

  public isPolygonActive(): boolean {
    return this._type === 'polygon' && this._polygonPoints.length > 0;
  }

  /** Page the in-progress shape belongs to; the hover elastic uses this to
   *  refuse to draw on a neighbouring page's canvas. */
  public get activePageIndex(): number {
    return this._pageIndex;
  }

  public getPolygonPointCount(): number {
    return this._polygonPoints.length;
  }

  public addPolygonVertex(point: Point): boolean {
    // Apply 15° snapping relative to the previous vertex when enabled.
    const placed = this._snapAngle && this._polygonPoints.length > 0
      ? snapPointTo15(this._polygonPoints[this._polygonPoints.length - 1], point)
      : point;
    if (this._polygonPoints.length >= 3) {
      const p0 = this._polygonPoints[0];
      const distToStart = Math.hypot(placed.x - p0.x, placed.y - p0.y);
      if (distToStart < 14) {
        // User clicked near start point: signal to close polygon
        return true;
      }
    }
    // Ignore a duplicate vertex from the second click of a double-click.
    const last = this._polygonPoints[this._polygonPoints.length - 1];
    if (last && Math.hypot(placed.x - last.x, placed.y - last.y) < 3) {
      return false;
    }
    this._polygonPoints.push(placed);
    this._currentPoint = placed;
    return false;
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    const cp = this.effectiveCurrent();
    if (!this._startPoint || !cp) return;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    this.applyStyle(ctx);

    const sp = this._startPoint;

    // Lines and arrows are pure stroke; closed shapes honor the outline toggle.
    const outline = this._outline || this._type === 'line' || this._type === 'arrow';

    if (this._type === 'rectangle') {
      const x = Math.min(sp.x, cp.x);
      const y = Math.min(sp.y, cp.y);
      const w = Math.abs(cp.x - sp.x);
      const h = Math.abs(cp.y - sp.y);
      // Preview with the same rounded corners the committed shape will have.
      const r = Math.min(SHAPE_CORNER_RADIUS, w / 2, h / 2);
      ctx.beginPath();
      traceRoundedPolygon(ctx, [
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
      ], r, true);
      if (this._fillColor && this._fillColor !== 'transparent') {
        ctx.fill();
      }
      if (outline) ctx.stroke();
    } else if (this._type === 'ellipse') {
      const cx = (sp.x + cp.x) / 2;
      const cy = (sp.y + cp.y) / 2;
      const rx = Math.abs(cp.x - sp.x) / 2;
      const ry = Math.abs(cp.y - sp.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      if (this._fillColor && this._fillColor !== 'transparent') {
        ctx.fill();
      }
      if (outline) ctx.stroke();
    } else if (this._type === 'line') {
      fillLineRibbon(ctx, sp.x, sp.y, cp.x, cp.y, this._strokeWidth);
    } else if (this._type === 'arrow') {
      fillLineRibbon(ctx, sp.x, sp.y, cp.x, cp.y, this._strokeWidth);
      // Arrowhead as filled polygon
      const dx = cp.x - sp.x;
      const dy = cp.y - sp.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        const headLen = Math.max(12, this._strokeWidth * 4);
        const angle = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y);
        ctx.lineTo(
          cp.x - headLen * Math.cos(angle - Math.PI / 6),
          cp.y - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          cp.x - headLen * Math.cos(angle + Math.PI / 6),
          cp.y - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = this._strokeColor;
        ctx.fill();
      }
    } else if (this._type === 'polygon') {
      if (this._polygonPoints.length > 0) {
        const previewPts = cp ? [...this._polygonPoints, cp] : [...this._polygonPoints];
        ctx.beginPath();
        traceRoundedPolygon(ctx, previewPts, SHAPE_CORNER_RADIUS, false);
        if (this._fillColor && this._fillColor !== 'transparent') {
          ctx.fill();
        }
        if (outline) ctx.stroke();

        // If hovering near start point (closing threshold), highlight start point
        if (cp && this._polygonPoints.length >= 3) {
          const p0 = this._polygonPoints[0];
          if (Math.hypot(cp.x - p0.x, cp.y - p0.y) < 14) {
            ctx.beginPath();
            ctx.arc(p0.x, p0.y, 8, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(34, 197, 94, 0.4)';
            ctx.fill();
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }
    } else if (this._type === 'freeform-shape') {
      if (this._polygonPoints.length > 1) {
        ctx.beginPath();
        traceRoundedPolygon(ctx, this._polygonPoints, SHAPE_CORNER_RADIUS, true);
        if (this._fillColor && this._fillColor !== 'transparent') {
          ctx.fill();
        }
        if (outline) ctx.stroke();
      }
    }

    ctx.restore();
  }

  public finish(layerId: string): ShapeAnnotation | null {
    if (this._type === 'polygon') {
      if (this._polygonPoints.length < 3) {
        this.reset();
        return null;
      }
    } else if (!this._startPoint || !this._currentPoint) {
      return null;
    }

    let box: BoundingBox;
    let points: Point[] | undefined;

    // Finish what was previewed: the Shift-constrained point when active.
    const end = this.effectiveCurrent() ?? this._currentPoint;

    if (this._type === 'rectangle' || this._type === 'ellipse') {
      const x = Math.min(this._startPoint!.x, end!.x);
      const y = Math.min(this._startPoint!.y, end!.y);
      const w = Math.max(4, Math.abs(end!.x - this._startPoint!.x));
      const h = Math.max(4, Math.abs(end!.y - this._startPoint!.y));
      box = { x, y, width: w, height: h };
    } else if (this._type === 'line' || this._type === 'arrow') {
      points = [this._startPoint!, end!];
      box = computePointsBoundingBox(points, this._strokeWidth);
    } else {
      points = [...this._polygonPoints];
      box = computePointsBoundingBox(points, this._strokeWidth);
    }

    const annotation: ShapeAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: this._type,
      box,
      strokeColor: this._strokeColor,
      fillColor: this._fillColor,
      strokeWidth: this._strokeWidth,
      outline: this._outline,
      strokeStyle: this._strokeStyle,
      points,
      arrowEnd: this._type === 'arrow',
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.reset();
    return annotation;
  }

  public reset() {
    this._startPoint = null;
    this._currentPoint = null;
    this._polygonPoints = [];
    this._constrain = false;
  }

  private applyStyle(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = this._strokeColor;
    ctx.fillStyle = this._fillColor;
    ctx.lineWidth = this._strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (this._strokeStyle === 'dashed') {
      ctx.setLineDash([8, 6]);
    } else if (this._strokeStyle === 'dotted') {
      ctx.setLineDash([3, 4]);
    } else {
      ctx.setLineDash([]);
    }
  }

  private drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
    const headLen = Math.max(12, this._strokeWidth * 4);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
      to.x - headLen * Math.cos(angle - Math.PI / 6),
      to.y - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      to.x - headLen * Math.cos(angle + Math.PI / 6),
      to.y - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fillStyle = this._strokeColor;
    ctx.fill();
  }
}

export const shapesTool = new ShapesTool();
