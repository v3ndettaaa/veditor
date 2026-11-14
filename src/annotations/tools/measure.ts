/**
 * Measurement Tools Suite
 * Calibrated distance, angle, and area calculations for technical PDF blueprints & plans.
 */

import { Point, MeasurementAnnotation, BoundingBox } from '../../core/types';
import { distance, computePointsBoundingBox, polygonArea } from '../../utils/geometry';

/**
 * Computes the interior angle in degrees (0..180) at `vertex` between
 * rays `vertex -> p0` and `vertex -> p2`.
 */
export function computeAngleDegrees(p0: Point, vertex: Point, p2: Point): number {
  const v1x = p0.x - vertex.x;
  const v1y = p0.y - vertex.y;
  const v2x = p2.x - vertex.x;
  const v2y = p2.y - vertex.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const cosTheta = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (len1 * len2)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

/**
 * Computes the calibrated numeric measurement and display label for any measurement mode.
 */
export function computeMeasurementValue(
  type: 'measure-distance' | 'measure-angle' | 'measure-area',
  points: Point[],
  unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px',
  scaleRatio: number
): { measuredValue: number; label: string } {
  const safeScale = Number.isFinite(scaleRatio) && scaleRatio > 0 ? scaleRatio : 1;
  if (type === 'measure-distance') {
    if (points.length < 2) return { measuredValue: 0, label: `0.00 ${unit}` };
    const distPx = distance(points[0], points[1]);
    const measuredValue = distPx * safeScale;
    return {
      measuredValue,
      label: `${measuredValue.toFixed(2)} ${unit}`
    };
  }
  if (type === 'measure-angle') {
    if (points.length < 3) return { measuredValue: 0, label: '0.0°' };
    const measuredValue = computeAngleDegrees(points[0], points[1], points[2]);
    return {
      measuredValue,
      label: `${measuredValue.toFixed(1)}°`
    };
  }
  // measure-area
  if (points.length < 3) return { measuredValue: 0, label: `0.00 ${unit}²` };
  const areaPx = polygonArea(points);
  const measuredValue = areaPx * (safeScale * safeScale);
  return {
    measuredValue,
    label: `${measuredValue.toFixed(2)} ${unit}²`
  };
}

export class MeasureTool {
  private _points: Point[] = [];
  private _currentPoint: Point | null = null;
  private _pageIndex: number = 0;
  private _type: 'measure-distance' | 'measure-angle' | 'measure-area' = 'measure-distance';
  private _unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px' = 'mm';
  private _scaleRatio: number = 0.264583; // standard 96 DPI: 1 px = ~0.2646 mm
  private _color: string = '#2563eb';

  public get activePageIndex(): number {
    return this._pageIndex;
  }

  public get activeType(): 'measure-distance' | 'measure-angle' | 'measure-area' {
    return this._type;
  }

  public get pointCount(): number {
    return this._points.length;
  }

  public isMultiPointActive(): boolean {
    return (
      this._points.length > 0 &&
      (this._type === 'measure-angle' || this._type === 'measure-area')
    );
  }

  public start(
    point: Point,
    pageIndex: number,
    type: 'measure-distance' | 'measure-angle' | 'measure-area',
    unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px' = 'mm',
    scaleRatio: number = 0.264583,
    color: string = '#2563eb'
  ): void {
    this._points = [{ x: point.x, y: point.y }];
    this._currentPoint = { x: point.x, y: point.y };
    this._pageIndex = pageIndex;
    this._type = type;
    this._unit = unit;
    this._scaleRatio = scaleRatio;
    this._color = color;
  }

  public move(point: Point): void {
    this._currentPoint = { x: point.x, y: point.y };
  }

  /**
   * Appends a vertex in multi-point mode (`measure-angle` or `measure-area`).
   * Returns `true` when the measurement is ready to auto-finish:
   * - `measure-angle`: finishes automatically on the 3rd point.
   * - `measure-area`: finishes when clicking within 12pt of the starting vertex (after >= 3 vertices).
   */
  public addPoint(point: Point, closeRadius = 12): boolean {
    const pt = { x: point.x, y: point.y };
    this._currentPoint = pt;

    if (this._type === 'measure-angle') {
      // Ignore accidental zero-length duplicate clicks on the exact same spot
      const last = this._points[this._points.length - 1];
      if (last && distance(last, pt) < 2) {
        return false;
      }
      this._points.push(pt);
      return this._points.length >= 3;
    }

    if (this._type === 'measure-area') {
      if (this._points.length >= 3 && distance(this._points[0], pt) <= closeRadius) {
        return true;
      }
      const last = this._points[this._points.length - 1];
      if (last && distance(last, pt) < 2) {
        return false;
      }
      this._points.push(pt);
      return false;
    }

    this._points.push(pt);
    return true;
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this._points.length === 0 || !this._currentPoint) return;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.strokeStyle = this._color;
    ctx.fillStyle = this._color;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this._type === 'measure-distance') {
      const p1 = this._points[0];
      const p2 = this._currentPoint;
      this.drawDistanceMeasurement(ctx, p1, p2, undefined, this._color, true);
    } else if (this._type === 'measure-angle') {
      const last = this._points[this._points.length - 1];
      const hasCursor = last && distance(last, this._currentPoint) >= 1.5;
      const previewPts =
        this._points.length >= 3
          ? this._points.slice(0, 3)
          : hasCursor
            ? [...this._points, this._currentPoint]
            : [...this._points];

      if (previewPts.length === 1) {
        this.drawVertexDot(ctx, previewPts[0], this._color, true);
      } else if (previewPts.length === 2) {
        ctx.save();
        if (hasCursor) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(previewPts[0].x, previewPts[0].y);
        ctx.lineTo(previewPts[1].x, previewPts[1].y);
        ctx.stroke();
        ctx.restore();
        const distBadge = computeMeasurementValue('measure-distance', [previewPts[0], previewPts[1]], this._unit, this._scaleRatio).label;
        const midX = (previewPts[0].x + previewPts[1].x) / 2;
        const midY = (previewPts[0].y + previewPts[1].y) / 2;
        this.drawBadge(ctx, midX, midY, distBadge);
        this.drawVertexDot(ctx, previewPts[0], this._color, false);
        this.drawVertexDot(ctx, previewPts[1], this._color, hasCursor);
      } else if (previewPts.length >= 3) {
        this.drawAngleMeasurement(ctx, previewPts[0], previewPts[1], previewPts[2], undefined, this._color);
      }
    } else if (this._type === 'measure-area') {
      const last = this._points[this._points.length - 1];
      const hasCursor = last && distance(last, this._currentPoint) >= 1.5;
      const pts = hasCursor ? [...this._points, this._currentPoint] : [...this._points];

      if (pts.length === 1) {
        this.drawVertexDot(ctx, pts[0], this._color, true);
      } else if (pts.length === 2) {
        ctx.save();
        if (hasCursor) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
        ctx.restore();
        this.drawVertexDot(ctx, pts[0], this._color, false);
        this.drawVertexDot(ctx, pts[1], this._color, hasCursor);
      } else if (pts.length >= 3) {
        this.drawAreaMeasurement(ctx, pts, undefined, this._color, true);
      }
    }

    ctx.restore();
  }

  public cancel(): void {
    this._points = [];
    this._currentPoint = null;
  }

  public finish(layerId: string): MeasurementAnnotation | null {
    if (this._points.length === 0 || !this._currentPoint) return null;

    let allPts: Point[];
    if (this._type === 'measure-distance') {
      allPts = [this._points[0], this._currentPoint];
      if (distance(allPts[0], allPts[1]) < 2) {
        this.cancel();
        return null;
      }
    } else if (this._type === 'measure-angle') {
      allPts =
        this._points.length >= 3
          ? this._points.slice(0, 3)
          : [...this._points, this._currentPoint];
      if (allPts.length < 3) {
        this.cancel();
        return null;
      }
    } else {
      // measure-area
      const last = this._points[this._points.length - 1];
      const closedAtStart = this._points.length >= 3 && distance(this._points[0], this._currentPoint) <= 12;
      allPts =
        closedAtStart || (last && distance(last, this._currentPoint) < 2)
          ? [...this._points]
          : [...this._points, this._currentPoint];
      if (allPts.length < 3) {
        this.cancel();
        return null;
      }
    }

    const box: BoundingBox = computePointsBoundingBox(allPts, 28);
    const { measuredValue, label } = computeMeasurementValue(
      this._type,
      allPts,
      this._unit,
      this._scaleRatio
    );

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
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (ann.type === 'measure-distance' && ann.points.length >= 2) {
      this.drawDistanceMeasurement(ctx, ann.points[0], ann.points[1], ann.label, ann.color);
    } else if (ann.type === 'measure-angle' && ann.points.length >= 3) {
      this.drawAngleMeasurement(ctx, ann.points[0], ann.points[1], ann.points[2], ann.label, ann.color);
    } else if (ann.type === 'measure-area' && ann.points.length >= 3) {
      this.drawAreaMeasurement(ctx, ann.points, ann.label, ann.color);
    }

    ctx.restore();
  }

  private drawVertexDot(
    ctx: CanvasRenderingContext2D,
    pt: Point,
    color: string = this._color,
    isPulseRing: boolean = false
  ): void {
    ctx.save();
    if (isPulseRing) {
      ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.85;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawDistanceMeasurement(
    ctx: CanvasRenderingContext2D,
    p1: Point,
    p2: Point,
    customLabel?: string,
    color: string = this._color,
    isPreview: boolean = false
  ) {
    const { label: computedLabel } = computeMeasurementValue(
      'measure-distance',
      [p1, p2],
      this._unit,
      this._scaleRatio
    );
    const label = customLabel || computedLabel;

    ctx.save();
    ctx.strokeStyle = color;
    if (isPreview) ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();

    // Perpendicular CAD ticks at ends
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const tickLen = 7;
    const perp = angle + Math.PI / 2;

    const drawTick = (pt: Point) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pt.x - Math.cos(perp) * tickLen, pt.y - Math.sin(perp) * tickLen);
      ctx.lineTo(pt.x + Math.cos(perp) * tickLen, pt.y + Math.sin(perp) * tickLen);
      ctx.stroke();
    };

    drawTick(p1);
    drawTick(p2);
    this.drawVertexDot(ctx, p1, color);
    this.drawVertexDot(ctx, p2, color, isPreview);

    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    this.drawBadge(ctx, midX, midY - 14, label);
  }

  private drawAngleMeasurement(
    ctx: CanvasRenderingContext2D,
    p0: Point,
    vertex: Point,
    p2: Point,
    customLabel?: string,
    color: string = this._color
  ) {
    const deg = computeAngleDegrees(p0, vertex, p2);
    const label = customLabel || `${deg.toFixed(1)}°`;

    // Two rays from vertex
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(vertex.x, vertex.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    // Interior angle sector arc at vertex
    const a1 = Math.atan2(p0.y - vertex.y, p0.x - vertex.x);
    const a2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
    let diff = a2 - a1;
    while (diff <= -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    const anticlockwise = diff < 0;

    const rayLen1 = distance(vertex, p0);
    const rayLen2 = distance(vertex, p2);
    const arcRadius = Math.max(14, Math.min(34, Math.min(rayLen1, rayLen2) * 0.42));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vertex.x, vertex.y);
    ctx.arc(vertex.x, vertex.y, arcRadius, a1, a2, anticlockwise);
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, arcRadius, a1, a2, anticlockwise);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.65;
    ctx.stroke();
    ctx.restore();

    this.drawVertexDot(ctx, p0, color);
    this.drawVertexDot(ctx, vertex, color);
    this.drawVertexDot(ctx, p2, color);

    const midAngle = a1 + diff / 2;
    const badgeDist = arcRadius + 18;
    const bx = vertex.x + Math.cos(midAngle) * badgeDist;
    const by = vertex.y + Math.sin(midAngle) * badgeDist;
    this.drawBadge(ctx, bx, by, label);
  }

  private drawAreaMeasurement(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    customLabel?: string,
    color: string = this._color,
    isPreview: boolean = false
  ) {
    const { label: computedLabel } = computeMeasurementValue(
      'measure-area',
      points,
      this._unit,
      this._scaleRatio
    );
    const label = customLabel || computedLabel;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.11)';
    ctx.fill();
    ctx.stroke();

    // During polygon placement, highlight closing edge back to origin with dashed guide
    if (isPreview && points.length >= 3) {
      const startPt = points[0];
      const cursorPt = points[points.length - 1];
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.65)';
      ctx.beginPath();
      ctx.moveTo(cursorPt.x, cursorPt.y);
      ctx.lineTo(startPt.x, startPt.y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    for (let i = 0; i < points.length; i++) {
      const snapHighlight = isPreview && i === 0 && points.length >= 3;
      this.drawVertexDot(ctx, points[i], color, snapHighlight);
    }

    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    this.drawBadge(ctx, cx, cy, label);
  }

  private drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.save();
    ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif';
    const textW = ctx.measureText(text).width;
    const padX = 7;
    const badgeW = textW + padX * 2;
    const badgeH = 20;

    ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.beginPath();
    ctx.roundRect(x - badgeW / 2, y - badgeH / 2, badgeW, badgeH, 5);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
}

export const measureTool = new MeasureTool();
