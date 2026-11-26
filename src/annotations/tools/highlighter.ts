/**
 * Professional Highlighter Tool
 * Renders non-destructive translucent highlights with O(1) append-only live streaming.
 */

import { StrokePoint, HighlighterAnnotation, BoundingBox } from '../../core/types';
import { renderSmoothStroke, normalizeHighlighterColor } from '../spline';
import { StreamingHighlighterRenderer } from '../ink-engine';
import { computePointsBoundingBox } from '../../utils/geometry';

export class HighlighterTool {
  private _activePoints: StrokePoint[] = [];
  private _pageIndex: number = 0;
  private _color: string = 'rgba(250, 204, 21, 0.3)';
  private _width: number = 20;
  private _blendMode: 'multiply' | 'source-over' = 'multiply';
  private _straightLine: boolean = false;
  private _tipShape: 'chisel' | 'round' = 'round';
  private _opacity: number = 0.3;
  private _minX: number = Infinity;
  private _minY: number = Infinity;
  private _maxX: number = -Infinity;
  private _maxY: number = -Infinity;
  private _usedIncremental: boolean = false;
  private readonly _streamingRenderer = new StreamingHighlighterRenderer();

  public start(
    point: StrokePoint,
    pageIndex: number,
    color: string,
    width: number,
    blendMode: 'multiply' | 'source-over' = 'multiply',
    straightLine: boolean = false,
    tipShape: 'chisel' | 'round' = 'round',
    opacity: number = 0.3
  ) {
    this._activePoints = [point];
    this._pageIndex = pageIndex;
    this._opacity = opacity;
    // Always store a translucent color; toolbar swatches and the native color
    // picker yield opaque hex values which would otherwise paint solid blocks.
    this._color = normalizeHighlighterColor(color, opacity);
    this._width = width;
    // `multiply` cannot blend across the separate overlay/PDF canvases, so
    // force normal alpha compositing for predictable translucent highlights.
    this._blendMode = 'source-over';
    this._straightLine = straightLine;
    this._tipShape = tipShape;
    this._minX = point.x;
    this._minY = point.y;
    this._maxX = point.x;
    this._maxY = point.y;
    this._usedIncremental = false;
    this._streamingRenderer.reset();
  }

  public move(point: StrokePoint, shiftKey: boolean = false, zoom: number = 1): void {
    if (this._activePoints.length === 0) return;

    if (this._straightLine || shiftKey) {
      const p0 = this._activePoints[0];
      const dx = Math.abs(point.x - p0.x);
      const dy = Math.abs(point.y - p0.y);
      const p1 = dx >= dy ? { ...point, y: p0.y } : { ...point, x: p0.x };
      this._activePoints = [p0, p1];
      this._minX = Math.min(p0.x, p1.x);
      this._minY = Math.min(p0.y, p1.y);
      this._maxX = Math.max(p0.x, p1.x);
      this._maxY = Math.max(p0.y, p1.y);
    } else {
      if (point.x < this._minX) this._minX = point.x;
      if (point.y < this._minY) this._minY = point.y;
      if (point.x > this._maxX) this._maxX = point.x;
      if (point.y > this._maxY) this._maxY = point.y;

      const len = this._activePoints.length;
      if (len > 0) {
        const prev = this._activePoints[len - 1];
        const dx = point.x - prev.x;
        const dy = point.y - prev.y;
        const minDist = 0.65 / Math.max(1, zoom);
        if (dx * dx + dy * dy < minDist * minDist) {
          return;
        }
      }
      this._activePoints.push(point);
    }
  }

  private getRenderPoints(): StrokePoint[] {
    return this._activePoints;
  }

  public getLiveBoundingBox(): BoundingBox | null {
    if (this._activePoints.length === 0) return null;
    const pad = this._width * 1.5 + 8;
    return {
      x: this._minX - pad,
      y: this._minY - pad,
      width: (this._maxX - this._minX) + pad * 2,
      height: (this._maxY - this._minY) + pad * 2
    };
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    const pts = this.getRenderPoints();
    if (pts.length === 0) return;

    ctx.save();
    ctx.scale(scale, scale);
    renderSmoothStroke(
      ctx,
      pts,
      this._color,
      this._width,
      'linear',
      true,
      false,
      'balanced',
      this._tipShape
    );
    ctx.restore();
  }

  /**
   * O(1) append-only live highlighter render for freehand strokes (solid color
   * + canvas CSS opacity prevents overlap darkening without full-stroke clears).
   * Falls back seamlessly for straight-line / Shift-locked 2-point highlights.
   */
  public renderScratchpadIncremental(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    scale: number,
    offsetPxX: number = 0,
    offsetPxY: number = 0,
    isStraightMode: boolean = false
  ): boolean {
    if (this._activePoints.length === 0) return false;
    if (this._straightLine || isStraightMode) {
      if (this._usedIncremental) {
        this._streamingRenderer.clearDirtyOnCanvas(ctx, canvas);
        this._usedIncremental = false;
      }
      return false;
    }
    this._usedIncremental = true;
    this._streamingRenderer.render(
      ctx,
      canvas,
      this._activePoints,
      this._color,
      this._width,
      scale,
      offsetPxX,
      offsetPxY
    );
    return true;
  }

  public clearLiveSurface(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (this._usedIncremental) {
      this._streamingRenderer.clearDirtyOnCanvas(ctx, canvas);
      this._usedIncremental = false;
    } else {
      this._streamingRenderer.restoreCanvasOpacity();
    }
  }

  public finish(layerId: string): HighlighterAnnotation | null {
    const finalPoints = this.getRenderPoints();
    if (finalPoints.length === 0) return null;

    const box: BoundingBox = computePointsBoundingBox(finalPoints, this._width);

    const annotation: HighlighterAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: 'highlighter',
      box,
      points: [...finalPoints],
      color: normalizeHighlighterColor(this._color, this._opacity),
      strokeWidth: this._width,
      blendMode: 'source-over',
      straightLine: this._straightLine,
      tipShape: this._tipShape,
      opacity: this._opacity,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.cancel();
    return annotation;
  }

  public cancel(): void {
    this._activePoints = [];
    this._minX = Infinity;
    this._minY = Infinity;
    this._maxX = -Infinity;
    this._maxY = -Infinity;
    this._usedIncremental = false;
    this._streamingRenderer.reset();
  }
}

export const highlighterTool = new HighlighterTool();
