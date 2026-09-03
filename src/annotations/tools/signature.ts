/**
 * Signature Tool
 * Vector ink signature insertion and persistent signature library.
 */

import { Point, SignatureAnnotation, StrokePoint, BoundingBox } from '../../core/types';
import { renderSmoothStroke } from '../spline';

export class SignatureTool {
  public createSignatureAnnotation(
    point: Point,
    pageIndex: number,
    layerId: string,
    points: StrokePoint[][],
    color = '#111827',
    width = 180,
    height = 80
  ): SignatureAnnotation {
    const box: BoundingBox = {
      x: point.x - width / 2,
      y: point.y - height / 2,
      width,
      height
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'signature',
      box,
      points,
      color,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: SignatureAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

    const b = ann.box;

    if (ann.points && ann.points.length > 0) {
      // Find internal bounds of the signature strokes
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const stroke of ann.points) {
        for (const pt of stroke) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }
      }

      const internalW = Math.max(1, maxX - minX);
      const internalH = Math.max(1, maxY - minY);
      const scaleX = (b.width - 16) / internalW;
      const scaleY = (b.height - 16) / internalH;
      const sigScale = Math.min(scaleX, scaleY);

      ctx.save();
      ctx.translate(b.x + 8, b.y + 8);
      ctx.scale(sigScale, sigScale);
      ctx.translate(-minX, -minY);

      for (const stroke of ann.points) {
        renderSmoothStroke(ctx, stroke, ann.color, 2.5, 'linear', false);
      }
      ctx.restore();
    } else if (ann.pngDataUrl) {
      const img = new Image();
      img.src = ann.pngDataUrl;
      if (img.complete) {
        ctx.drawImage(img, b.x, b.y, b.width, b.height);
      }
    }

    ctx.restore();
  }
}

export const signatureTool = new SignatureTool();
