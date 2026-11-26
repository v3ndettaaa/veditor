/**
 * Professional Freehand Pen Tool
 * Ultra-smooth, low-latency, pressure-sensitive drawing powered by
 * causal One-Euro filtering and zero-blit append-only analytical ink streaming.
 */

import { StrokePoint, PenAnnotation, BoundingBox } from '../../core/types';
import { renderLiveStroke, IncrementalLivePen } from '../spline';
import { OneEuroStrokeFilter } from '../ink-engine';
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

  // O(1) incremental bounding box, causal One-Euro filter, & zero-blit streaming renderer
  private _minX: number = Infinity;
  private _minY: number = Infinity;
  private _maxX: number = -Infinity;
  private _maxY: number = -Infinity;
  private readonly _filter = new OneEuroStrokeFilter();
  private readonly _incrementalRenderer = new IncrementalLivePen();

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
    this._filter.reset(smoothing);
    const first = this._filter.filter(
      point.x,
      point.y,
      point.pressure ?? 0.5,
      point.time ?? performance.now(),
      1,
      point.tiltX,
      point.tiltY
    );
    this._activePoints = [first];
    this._liveTip = null;
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._pressureCurve = curve;
    this._pressureEnabled = pressureEnabled;
    this._strength = strength;
    this._smoothing = smoothing;
    this._minX = first.x;
    this._minY = first.y;
    this._maxX = first.x;
    this._maxY = first.y;
    this._incrementalRenderer.reset();
  }

  public move(point: StrokePoint, zoom: number = 1): void {
    const len = this._activePoints.length;
    if (len === 0) return;

    const prev = this._activePoints[len - 1];
    const effZoom = Math.max(0.25, zoom);
    // Filter redundant sub-pixel hardware jitter while updating _liveTip so
    // the visible ink nib tracks slow micro-movements with zero delay.
    const minDist = Math.min(0.18, 0.24 / Math.max(1, effZoom));
    const rawDist = Math.hypot(point.x - prev.x, point.y - prev.y);
    if (rawDist < minDist) {
      prev.pressure = prev.pressure * 0.55 + (point.pressure ?? 0.5) * 0.45;
      if (rawDist > 0.01) {
        this._liveTip = {
          x: point.x,
          y: point.y,
          pressure: prev.pressure,
          tiltX: point.tiltX,
          tiltY: point.tiltY,
          time: point.time
        };
      }
      return;
    }

    const filtered = this._filter.filter(
      point.x,
      point.y,
      point.pressure ?? 0.5,
      point.time ?? performance.now(),
      effZoom,
      point.tiltX,
      point.tiltY
    );

    if (filtered.x < this._minX) this._minX = filtered.x;
    if (filtered.y < this._minY) this._minY = filtered.y;
    if (filtered.x > this._maxX) this._maxX = filtered.x;
    if (filtered.y > this._maxY) this._maxY = filtered.y;

    this._liveTip = null;
    this._activePoints.push(filtered);
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

  /**
   * O(1) zero-blit append-only live stroke render directly onto `canvas`,
   * paired with a tiny floating tip canvas for the unclosed segment and
   * optional 1-frame hardware stylus prediction.
   */
  public renderScratchpadIncremental(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    scale: number,
    offsetPxX: number = 0,
    offsetPxY: number = 0,
    predictedPoints?: readonly StrokePoint[] | null
  ): void {
    if (this._activePoints.length === 0) return;
    this._incrementalRenderer.render(
      ctx,
      canvas,
      this._activePoints,
      this._color,
      this._width,
      this._pressureCurve,
      this._pressureEnabled,
      this._strength,
      this._smoothing,
      scale,
      offsetPxX,
      offsetPxY,
      this._liveTip,
      predictedPoints
    );
  }

  public clearLiveSurface(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    this._incrementalRenderer.clearDirtyOnCanvas(ctx, canvas);
  }

  public hideTipOverlay(): void {
    this._incrementalRenderer.hideTipOverlay();
  }

  public finish(layerId: string): PenAnnotation | null {
    if (this._activePoints.length === 0) return null;

    // Points are already causally One-Euro smoothed during live streaming:
    // setting `preSmoothed: true` guarantees 0.000px visual shift on pen lift.
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
      preSmoothed: true,
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
    this._incrementalRenderer.reset();
  }
}

export const penTool = new PenTool();
