/**
 * Professional Freehand Pen Tool
 * Ultra-smooth, low-latency, pressure-sensitive drawing.
 */

import { StrokePoint, PenAnnotation, BoundingBox } from '../../core/types';
import { renderLiveStroke, smoothStrokePoints } from '../spline';
import { computePointsBoundingBox } from '../../utils/geometry';

export class PenTool {
  private _activePoints: StrokePoint[] = [];
  private _pageIndex: number = 0;
  private _color: string = '#4f46e5';
  private _width: number = 3;
  private _pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear';
  private _pressureEnabled: boolean = true;
  private _strength: 'light' | 'balanced' | 'strong' = 'balanced';
  private _smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium';

  public start(
    point: StrokePoint,
    pageIndex: number,
    color: string,
    width: number,
    curve: 'linear' | 'soft' | 'firm' | 'exponential',
    pressureEnabled: boolean = true,
    strength: 'light' | 'balanced' | 'strong' = 'balanced',
    smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium'
  ) {
    this._activePoints = [point];
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._pressureCurve = curve;
    this._pressureEnabled = pressureEnabled;
    this._strength = strength;
    this._smoothing = smoothing;
  }

  public move(point: StrokePoint): void {
    const len = this._activePoints.length;
    if (len > 0) {
      const prev = this._activePoints[len - 1];
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      // Filter redundant sub-pixel hardware jitter (< 0.8px) to prevent array explosion and latency
      if (dx * dx + dy * dy < 0.64) {
        prev.pressure = (prev.pressure + point.pressure) / 2;
        return;
      }
      // Apply gentle real-time streaming low-pass filter to smooth coordinates live
      if (this._smoothing !== 'none' && len >= 2) {
        const alpha = this._smoothing === 'high' ? 0.72 : (this._smoothing === 'subtle' ? 0.88 : 0.80);
        point = {
          x: prev.x * (1 - alpha) + point.x * alpha,
          y: prev.y * (1 - alpha) + point.y * alpha,
          pressure: (prev.pressure + point.pressure) / 2
        };
      }
    }
    this._activePoints.push(point);
  }

  /** Live stroke points for draw-and-hold recognition (read-only snapshot). */
  public getActivePoints(): readonly StrokePoint[] {
    return this._activePoints;
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this._activePoints.length === 0) return;

    ctx.save();
    ctx.scale(scale, scale);
    renderLiveStroke(
      ctx,
      this._activePoints,
      this._color,
      this._width,
      this._pressureCurve,
      this._pressureEnabled,
      this._strength,
      this._smoothing
    );
    ctx.restore();
  }

  public finish(layerId: string): PenAnnotation | null {
    if (this._activePoints.length === 0) return null;

    // The points are already smoothly filtered in real-time as drawn;
    // preserve the exact points so there is ZERO morphing / snapping on pen release
    const finalizedPoints = [...this._activePoints];
    const box: BoundingBox = computePointsBoundingBox(finalizedPoints, this._width);

    const annotation: PenAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: 'pen',
      box,
      points: finalizedPoints,
      color: this._color,
      strokeWidth: this._width,
      pressureEnabled: this._pressureEnabled,
      pressureCurve: this._pressureCurve,
      pressureStrength: this._strength,
      strokeSmoothing: this._smoothing,
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
