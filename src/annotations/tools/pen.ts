/**
 * Professional Freehand Pen Tool
 * Ultra-smooth, low-latency, pressure-sensitive drawing.
 */

import { StrokePoint, PenAnnotation, BoundingBox } from '../../core/types';
import { renderSmoothStroke } from '../spline';
import { computePointsBoundingBox } from '../../utils/geometry';

export class PenTool {
  private _activePoints: StrokePoint[] = [];
  private _pageIndex: number = 0;
  private _color: string = '#4f46e5';
  private _width: number = 3;
  private _pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear';

  public start(point: StrokePoint, pageIndex: number, color: string, width: number, curve: 'linear' | 'soft' | 'firm' | 'exponential') {
    this._activePoints = [point];
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._pressureCurve = curve;
  }

  public move(point: StrokePoint): void {
    this._activePoints.push(point);
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this._activePoints.length === 0) return;

    ctx.save();
    ctx.scale(scale, scale);
    renderSmoothStroke(
      ctx,
      this._activePoints,
      this._color,
      this._width,
      this._pressureCurve,
      false
    );
    ctx.restore();
  }

  public finish(layerId: string): PenAnnotation | null {
    if (this._activePoints.length === 0) return null;

    const box: BoundingBox = computePointsBoundingBox(this._activePoints, this._width);

    const annotation: PenAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: 'pen',
      box,
      points: [...this._activePoints],
      color: this._color,
      strokeWidth: this._width,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this._activePoints = [];
    return annotation;
  }

  public cancel(): void {
    this._activePoints = [];
  }
}

export const penTool = new PenTool();
