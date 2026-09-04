/**
 * Professional Highlighter Tool
 * Renders non-destructive translucent highlights with Multiply blend mode.
 */

import { StrokePoint, HighlighterAnnotation, BoundingBox } from '../../core/types';
import { renderSmoothStroke } from '../spline';
import { computePointsBoundingBox } from '../../utils/geometry';

export class HighlighterTool {
  private _activePoints: StrokePoint[] = [];
  private _pageIndex: number = 0;
  private _color: string = 'rgba(250, 204, 21, 0.45)';
  private _width: number = 20;
  private _blendMode: 'multiply' | 'source-over' = 'multiply';
  private _straightLine: boolean = false;
  private _tipShape: 'chisel' | 'round' = 'round';

  public start(
    point: StrokePoint,
    pageIndex: number,
    color: string,
    width: number,
    blendMode: 'multiply' | 'source-over' = 'multiply',
    straightLine: boolean = false,
    tipShape: 'chisel' | 'round' = 'round'
  ) {
    this._activePoints = [point];
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._blendMode = blendMode;
    this._straightLine = straightLine;
    this._tipShape = tipShape;
  }

  public move(point: StrokePoint, shiftKey: boolean = false): void {
    if (this._activePoints.length === 0) return;

    if (this._straightLine || shiftKey) {
      const p0 = this._activePoints[0];
      const dx = Math.abs(point.x - p0.x);
      const dy = Math.abs(point.y - p0.y);
      if (dx >= dy) {
        // Snap straight horizontal (perfect for reading / text line highlighting)
        this._activePoints = [p0, { ...point, y: p0.y }];
      } else {
        // Snap straight vertical
        this._activePoints = [p0, { ...point, x: p0.x }];
      }
    } else {
      this._activePoints.push(point);
    }
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
      'linear',
      true,
      false,
      'balanced',
      this._tipShape
    );
    ctx.restore();
  }

  public finish(layerId: string): HighlighterAnnotation | null {
    if (this._activePoints.length === 0) return null;

    const box: BoundingBox = computePointsBoundingBox(this._activePoints, this._width);

    const annotation: HighlighterAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: 'highlighter',
      box,
      points: [...this._activePoints],
      color: this._color,
      strokeWidth: this._width,
      blendMode: this._blendMode,
      straightLine: this._straightLine,
      tipShape: this._tipShape,
      opacity: 0.8,
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

export const highlighterTool = new HighlighterTool();
