/**
 * Professional Freehand Pen Tool
 * Ultra-smooth, low-latency, pressure-sensitive drawing.
 */

import { StrokePoint, PenAnnotation, BoundingBox } from '../../core/types';
import { renderLiveStroke } from '../spline';
import { computePointsBoundingBox } from '../../utils/geometry';

export class PenTool {
  private _activePoints: StrokePoint[] = [];
  private _liveTip: StrokePoint | null = null;
  private _pageIndex: number = 0;
  private _color: string = '#4f46e5';
  private _width: number = 3;
  private _pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear';
  private _pressureEnabled: boolean = true;
  private _strength: 'light' | 'balanced' | 'strong' = 'balanced';
  private _smoothing: 'none' | 'subtle' | 'medium' | 'high' = 'medium';

  // O(1) incremental bounding box for live strokes
  private _minX: number = Infinity;
  private _minY: number = Infinity;
  private _maxX: number = -Infinity;
  private _maxY: number = -Infinity;

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
    this._liveTip = null;
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._pressureCurve = curve;
    this._pressureEnabled = pressureEnabled;
    this._strength = strength;
    this._smoothing = smoothing;
    this._minX = point.x;
    this._minY = point.y;
    this._maxX = point.x;
    this._maxY = point.y;
  }

  public move(point: StrokePoint, zoom: number = 1): void {
    const len = this._activePoints.length;
    if (point.x < this._minX) this._minX = point.x;
    if (point.y < this._minY) this._minY = point.y;
    if (point.x > this._maxX) this._maxX = point.x;
    if (point.y > this._maxY) this._maxY = point.y;

    if (len > 0) {
      const prev = this._activePoints[len - 1];
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      const effZoom = Math.max(1, zoom);
      // Filter redundant sub-pixel hardware jitter (< 0.24 screen px, capped at 0.18 page pt)
      // while updating _liveTip so the visible ink tip follows the stylus with zero lag.
      const minDist = Math.min(0.18, 0.24 / effZoom);
      const dist = Math.hypot(dx, dy);
      if (dist < minDist) {
        prev.pressure = prev.pressure * 0.84 + point.pressure * 0.16;
        if (dist > 0.01) {
          this._liveTip = { ...point, pressure: prev.pressure };
        }
        return;
      }
      // Arc-length bounded pressure EMA so touch-down pressure never jumps over short steps
      const rawBlended = prev.pressure * 0.80 + point.pressure * 0.20;
      const maxDelta = Math.max(0.005, dist * 0.08);
      const clampedPressure = Math.max(
        prev.pressure - maxDelta,
        Math.min(prev.pressure + maxDelta, rawBlended)
      );
      point = {
        ...point,
        pressure: clampedPressure
      };
    }
    this._liveTip = null;
    this._activePoints.push(point);
  }

  /** Live stroke points for draw-and-hold recognition (read-only snapshot). */
  public getActivePoints(): readonly StrokePoint[] {
    return this._activePoints;
  }

  /** Returns O(1) page-space bounding box of the in-progress stroke for dirty-rect clearing. */
  public getLiveBoundingBox(): BoundingBox | null {
    if (this._activePoints.length === 0) return null;
    const pad = this._width * 3 + 6;
    return {
      x: this._minX - pad,
      y: this._minY - pad,
      width: (this._maxX - this._minX) + pad * 2,
      height: (this._maxY - this._minY) + pad * 2
    };
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this._activePoints.length === 0) return;

    const pts = this._liveTip
      ? [...this._activePoints, this._liveTip]
      : this._activePoints;

    ctx.save();
    ctx.scale(scale, scale);
    renderLiveStroke(
      ctx,
      pts,
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

    // Preserve exact points and smoothing setting so there is ZERO morphing / snapping on pen release
    const finalizedPoints = [...this._activePoints];
    if (this._liveTip && finalizedPoints.length > 0) {
      const last = finalizedPoints[finalizedPoints.length - 1];
      if (Math.hypot(this._liveTip.x - last.x, this._liveTip.y - last.y) > 0.04) {
        finalizedPoints.push(this._liveTip);
      }
    }
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

    this.cancel();
    return annotation;
  }

  public cancel(): void {
    this._activePoints = [];
    this._liveTip = null;
    this._minX = Infinity;
    this._minY = Infinity;
    this._maxX = -Infinity;
    this._maxY = -Infinity;
  }
}

export const penTool = new PenTool();
