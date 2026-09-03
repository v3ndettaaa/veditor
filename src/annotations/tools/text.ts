/**
 * Text Box Annotation Tool
 * Supports multiline typography, text alignment, and rich visual styling.
 */

import { Point, TextAnnotation, BoundingBox } from '../../core/types';

export class TextTool {
  public createTextAnnotation(
    point: Point,
    pageIndex: number,
    layerId: string,
    initialText: string = 'Double click to edit text',
    fontSize: number = 16,
    fontFamily: string = 'Inter',
    color: string = '#111827',
    bgColor: string = 'transparent',
    align: 'left' | 'center' | 'right' = 'left'
  ): TextAnnotation {
    const estimatedWidth = Math.max(160, initialText.length * (fontSize * 0.6) + 24);
    const estimatedHeight = fontSize * 1.8 + 16;

    const box: BoundingBox = {
      x: point.x,
      y: point.y,
      width: estimatedWidth,
      height: estimatedHeight
    };

    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'text',
      box,
      text: initialText,
      fontFamily,
      fontSize,
      color,
      backgroundColor: bgColor,
      textAlign: align,
      padding: 8,
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /**
   * Renders a text annotation onto a canvas context.
   */
  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: TextAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

    const b = ann.box;
    const padding = ann.padding || 8;

    if (ann.backgroundColor && ann.backgroundColor !== 'transparent') {
      ctx.fillStyle = ann.backgroundColor;
      ctx.fillRect(b.x, b.y, b.width, b.height);
    }

    if (ann.borderColor) {
      ctx.strokeStyle = ann.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
    }

    ctx.font = `${ann.fontStyle || 'normal'} ${ann.fontWeight || 'normal'} ${ann.fontSize}px "${ann.fontFamily}", sans-serif`;
    ctx.fillStyle = ann.color;
    ctx.textBaseline = 'top';

    const lines = ann.text.split('\n');
    const lineHeight = ann.fontSize * 1.35;

    lines.forEach((line, idx) => {
      let x = b.x + padding;
      if (ann.textAlign === 'center') {
        const textW = ctx.measureText(line).width;
        x = b.x + (b.width - textW) / 2;
      } else if (ann.textAlign === 'right') {
        const textW = ctx.measureText(line).width;
        x = b.x + b.width - textW - padding;
      }
      ctx.fillText(line, x, b.y + padding + idx * lineHeight);
    });

    ctx.restore();
  }
}

export const textTool = new TextTool();
