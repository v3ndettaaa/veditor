/**
 * Callout / Speech Bubble Annotation Tool
 */

import { Point, CalloutAnnotation, BoundingBox } from '../../core/types';

export class CalloutTool {
  public createCallout(
    boxPoint: Point,
    arrowPoint: Point,
    pageIndex: number,
    layerId: string,
    text: string = 'Note...',
    fontSize: number = 14,
    color: string = '#111827',
    fillColor: string = '#fef3c7',
    strokeColor: string = '#d97706'
  ): CalloutAnnotation {
    const box: BoundingBox = {
      x: boxPoint.x,
      y: boxPoint.y,
      width: 140,
      height: 70
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'callout',
      box,
      arrowPoint,
      text,
      fontFamily: 'Inter',
      fontSize,
      color,
      fillColor,
      strokeColor,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: CalloutAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

    const b = ann.box;
    const ap = ann.arrowPoint;

    // Draw speech bubble with arrow
    ctx.beginPath();
    const r = 8;
    ctx.moveTo(b.x + r, b.y);
    ctx.lineTo(b.x + b.width - r, b.y);
    ctx.quadraticCurveTo(b.x + b.width, b.y, b.x + b.width, b.y + r);
    ctx.lineTo(b.x + b.width, b.y + b.height - r);
    ctx.quadraticCurveTo(b.x + b.width, b.y + b.height, b.x + b.width - r, b.y + b.height);

    // Callout pointer arrow
    ctx.lineTo(b.x + b.width * 0.4 + 10, b.y + b.height);
    ctx.lineTo(ap.x, ap.y);
    ctx.lineTo(b.x + b.width * 0.4 - 10, b.y + b.height);

    ctx.lineTo(b.x + r, b.y + b.height);
    ctx.quadraticCurveTo(b.x, b.y + b.height, b.x, b.y + b.height - r);
    ctx.lineTo(b.x, b.y + r);
    ctx.quadraticCurveTo(b.x, b.y, b.x + r, b.y);
    ctx.closePath();

    ctx.fillStyle = ann.fillColor;
    ctx.fill();
    if (ann.outline !== false) {
      ctx.strokeStyle = ann.strokeColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Render Text
    ctx.font = `${ann.fontSize}px "${ann.fontFamily}", sans-serif`;
    ctx.fillStyle = ann.color;
    ctx.textBaseline = 'top';

    const lines = ann.text.split('\n');
    const lineHeight = ann.fontSize * 1.3;
    lines.forEach((line, idx) => {
      ctx.fillText(line, b.x + 10, b.y + 10 + idx * lineHeight);
    });

    ctx.restore();
  }
}

export const calloutTool = new CalloutTool();
