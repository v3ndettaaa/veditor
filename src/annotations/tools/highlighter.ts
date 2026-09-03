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

  public start(
    point: StrokePoint,
    pageIndex: number,
    color: string,
    width: number,
    blendMode: 'multiply' | 'source-over' = 'multiply'
  ) {
    this._activePoints = [point];
    this._pageIndex = pageIndex;
    this._color = color;
    this._width = width;
    this._blendMode = blendMode;
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
      'linear',
      true
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
