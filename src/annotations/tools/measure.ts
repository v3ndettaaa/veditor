/**
 * Measurement Tools Suite
 * Calibrated distance, angle, and area calculations for technical PDF blueprints & plans.
 */

import { Point, MeasurementAnnotation, BoundingBox } from '../../core/types';
import { distance, computePointsBoundingBox, polygonArea } from '../../utils/geometry';

export class MeasureTool {
  private _points: Point[] = [];
  private _currentPoint: Point | null = null;
  private _pageIndex: number = 0;
  private _type: 'measure-distance' | 'measure-angle' | 'measure-area' = 'measure-distance';
  private _unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px' = 'mm';
  private _scaleRatio: number = 0.264583; // standard 96 DPI: 1 px = ~0.2646 mm
  private _color: string = '#2563eb';

  public start(
    point: Point,
    pageIndex: number,
    type: 'measure-distance' | 'measure-angle' | 'measure-area',
    unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px' = 'mm',
    scaleRatio: number = 0.264583,
    color: string = '#2563eb'
  ) {
    this._points = [point];
    this._currentPoint = point;
    this._pageIndex = pageIndex;
    this._type = type;
    this._unit = unit;
    this._scaleRatio = scaleRatio;
    this._color = color;
  }

  public move(point: Point): void {
    this._currentPoint = point;
  }

  public addPoint(point: Point): void {
    this._points.push(point);
    this._currentPoint = point;
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this._points.length === 0 || !this._currentPoint) return;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = this._color;
    ctx.fillStyle = this._color;
    ctx.lineWidth = 2;

    if (this._type === 'measure-distance') {
      const p1 = this._points[0];
      const p2 = this._currentPoint;
      this.drawDistanceMeasurement(ctx, p1, p2);
    } else if (this._type === 'measure-angle') {
      const allPts = [...this._points, this._currentPoint];
      if (allPts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(allPts[0].x, allPts[0].y);
        ctx.lineTo(allPts[1].x, allPts[1].y);
        if (allPts.length >= 3) {
          ctx.lineTo(allPts[2].x, allPts[2].y);
        }
        ctx.stroke();
      }
    } else if (this._type === 'measure-area') {
      const pts = [...this._points, this._currentPoint];
      if (pts.length > 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  public finish(layerId: string): MeasurementAnnotation | null {
    if (this._points.length === 0 || !this._currentPoint) return null;

    const allPts = this._type === 'measure-distance' ? [this._points[0], this._currentPoint] : [...this._points];
    const box: BoundingBox = computePointsBoundingBox(allPts, 24);

    let measuredValue = 0;
    let label = '';

    if (this._type === 'measure-distance') {
      const distPx = distance(allPts[0], allPts[1]);
      measuredValue = distPx * this._scaleRatio;
      label = `${measuredValue.toFixed(2)} ${this._unit}`;
    } else if (this._type === 'measure-area') {
      const areaPx = polygonArea(allPts);
      measuredValue = areaPx * (this._scaleRatio * this._scaleRatio);
      label = `${measuredValue.toFixed(2)} ${this._unit}²`;
    }

    const annotation: MeasurementAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: this._type,
      box,
      points: allPts,
      unit: this._unit,
      scaleRatio: this._scaleRatio,
      color: this._color,
      strokeWidth: 2,
      measuredValue,
      label,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this._points = [];
    this._currentPoint = null;
    return annotation;
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: MeasurementAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.strokeWidth;

    if (ann.type === 'measure-distance' && ann.points.length >= 2) {
      this.drawDistanceMeasurement(ctx, ann.points[0], ann.points[1], ann.label);
    } else if (ann.type === 'measure-area' && ann.points.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(ann.points[i].x, ann.points[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
      ctx.fill();
      ctx.stroke();

      // Draw area badge at centroid
      const cx = ann.points.reduce((sum, p) => sum + p.x, 0) / ann.points.length;
      const cy = ann.points.reduce((sum, p) => sum + p.y, 0) / ann.points.length;
      this.drawBadge(ctx, cx, cy, ann.label);
    }

    ctx.restore();
  }

  private drawDistanceMeasurement(ctx: CanvasRenderingContext2D, p1: Point, p2: Point, customLabel?: string) {
    const distPx = distance(p1, p2);
    const val = distPx * this._scaleRatio;
    const label = customLabel || `${val.toFixed(2)} ${this._unit}`;

    // Main line
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    // Perpendicular ticks at ends
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const tickLen = 8;
    const perp = angle + Math.PI / 2;

    const drawTick = (pt: Point) => {
      ctx.beginPath();
      ctx.moveTo(pt.x - Math.cos(perp) * tickLen, pt.y - Math.sin(perp) * tickLen);
      ctx.lineTo(pt.x + Math.cos(perp) * tickLen, pt.y + Math.sin(perp) * tickLen);
      ctx.stroke();
    };

    drawTick(p1);
    drawTick(p2);

    // Center badge
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    this.drawBadge(ctx, midX, midY, label);
  }

  private drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif';
    const textW = ctx.measureText(text).width;
    const padX = 8;
    const padY = 4;
    const badgeW = textW + padX * 2;
    const badgeH = 20;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x - badgeW / 2, y - badgeH / 2, badgeW, badgeH, 4);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }
}

export const measureTool = new MeasureTool();
