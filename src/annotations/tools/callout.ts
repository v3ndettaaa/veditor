/**
 * Callout / Speech Bubble Annotation Tool
 * Three-point geometry: text-box container -> knee -> arrow anchor point.
 */

import { Point, CalloutAnnotation, BoundingBox } from '../../core/types';

/** Point where the segment `from` -> `to` crosses the box border. */
export function boxEdgeIntersection(box: BoundingBox, from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
  let bestT = Infinity;
  const consider = (t: number, x: number, y: number) => {
    if (t > 0 && t < bestT) {
      bestT = t;
    }
  };
  // Intersect with the 4 border lines, keeping the nearest hit.
  if (dx !== 0) {
    consider((box.x - from.x) / dx, box.x, 0);
    consider((box.x + box.width - from.x) / dx, box.x + box.width, 0);
  }
  if (dy !== 0) {
    consider((box.y - from.y) / dy, 0, box.y);
    consider((box.y + box.height - from.y) / dy, 0, box.y + box.height);
  }
  if (!Number.isFinite(bestT)) return { x: from.x, y: from.y };
  return { x: from.x + dx * bestT, y: from.y + dy * bestT };
}

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
    strokeColor: string = '#d97706',
    box?: BoundingBox
  ): CalloutAnnotation {
    const finalBox: BoundingBox = box ?? {
      x: boxPoint.x,
      y: boxPoint.y,
      width: 140,
      height: 70
    };
    const center = { x: finalBox.x + finalBox.width / 2, y: finalBox.y + finalBox.height / 2 };
    const knee = boxEdgeIntersection(finalBox, center, arrowPoint);

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'callout',
      box: finalBox,
      arrowPoint,
      knee,
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
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const knee = ann.knee ?? boxEdgeIntersection(b, center, ap);

    // Pointer tail triangle behind the bubble (drawn first so the bubble body
    // cleanly overlaps its base).
    const dx = ap.x - knee.x;
    const dy = ap.y - knee.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const halfBase = Math.max(7, Math.min(14, len * 0.3));
    ctx.beginPath();
    ctx.moveTo(knee.x + px * halfBase, knee.y + py * halfBase);
    ctx.lineTo(ap.x, ap.y);
    ctx.lineTo(knee.x - px * halfBase, knee.y - py * halfBase);
    ctx.closePath();
    ctx.fillStyle = ann.fillColor;
    ctx.fill();
    if (ann.outline !== false) {
      ctx.strokeStyle = ann.strokeColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Bubble body
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(b.x + r, b.y);
    ctx.lineTo(b.x + b.width - r, b.y);
    ctx.quadraticCurveTo(b.x + b.width, b.y, b.x + b.width, b.y + r);
    ctx.lineTo(b.x + b.width, b.y + b.height - r);
    ctx.quadraticCurveTo(b.x + b.width, b.y + b.height, b.x + b.width - r, b.y + b.height);
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

    // Render Text (clipped to the bubble, wrapping long lines)
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x + 2, b.y + 2, Math.max(1, b.width - 4), Math.max(1, b.height - 4));
    ctx.clip();
    ctx.font = `${ann.fontSize}px "${ann.fontFamily}", sans-serif`;
    ctx.fillStyle = ann.color;
    ctx.textBaseline = 'top';

    const maxWidth = Math.max(10, b.width - 16);
    const lineHeight = ann.fontSize * 1.3;
    let y = b.y + 8;
    for (const rawLine of ann.text.split('\n')) {
      let line = '';
      for (const word of rawLine.split(' ')) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          ctx.fillText(line, b.x + 8, y);
          y += lineHeight;
          line = word;
        } else {
          line = test;
        }
      }
      ctx.fillText(line, b.x + 8, y);
      y += lineHeight;
    }
    ctx.restore();

    ctx.restore();
  }
}

export const calloutTool = new CalloutTool();
