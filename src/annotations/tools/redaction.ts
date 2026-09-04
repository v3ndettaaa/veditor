/**
 * True Redaction Tool
 * Marks confidential text/graphics for permanent destruction upon export.
 */

import { Point, RedactionAnnotation, BoundingBox } from '../../core/types';

export class RedactionTool {
  private _startPoint: Point | null = null;
  private _currentPoint: Point | null = null;
  private _pageIndex: number = 0;
  private _color: string = '#000000';

  public start(point: Point, pageIndex: number, color: string = '#000000') {
    this._startPoint = point;
    this._currentPoint = point;
    this._pageIndex = pageIndex;
    this._color = color;
  }

  public move(point: Point): void {
    this._currentPoint = point;
  }

  public renderScratchpad(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this._startPoint || !this._currentPoint) return;

    ctx.save();
    ctx.scale(scale, scale);

    const x = Math.min(this._startPoint.x, this._currentPoint.x);
    const y = Math.min(this._startPoint.y, this._currentPoint.y);
    const w = Math.abs(this._currentPoint.x - this._startPoint.x);
    const h = Math.abs(this._currentPoint.y - this._startPoint.y);

    // Diagonal warning stripes in scratchpad
    ctx.fillStyle = this._color === '#ffffff' ? 'rgba(255, 255, 255, 0.45)' : 'rgba(239, 68, 68, 0.25)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this._color === '#ffffff' ? '#94a3b8' : '#dc2626';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);

    ctx.restore();
  }

  public finish(layerId: string): RedactionAnnotation | null {
    if (!this._startPoint || !this._currentPoint) return null;

    const x = Math.min(this._startPoint.x, this._currentPoint.x);
    const y = Math.min(this._startPoint.y, this._currentPoint.y);
    const w = Math.max(4, Math.abs(this._currentPoint.x - this._startPoint.x));
    const h = Math.max(4, Math.abs(this._currentPoint.y - this._startPoint.y));

    const box: BoundingBox = { x, y, width: w, height: h };

    const annotation: RedactionAnnotation = {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex: this._pageIndex,
      layerId,
      type: 'redaction',
      box,
      color: this._color || '#000000',
      applied: false,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this._startPoint = null;
    this._currentPoint = null;
    return annotation;
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: RedactionAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

    const b = ann.box;

    if (ann.applied) {
      // Fully blacked out permanent box
      ctx.fillStyle = ann.color || '#000000';
      ctx.fillRect(b.x, b.y, b.width, b.height);
    } else {
      // Pending redaction mark: black with crosshatch & border
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(b.x, b.y, b.width, b.height);

      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x, b.y, b.width, b.height);

      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('REDACTION', b.x + b.width / 2, b.y + b.height / 2);
    }

    ctx.restore();
  }
}

export const redactionTool = new RedactionTool();
