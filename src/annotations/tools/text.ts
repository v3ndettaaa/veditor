/**
 * Text Box Annotation Tool
 * Supports multiline typography, text alignment, and rich visual styling.
 */

import { Point, TextAnnotation, BoundingBox } from '../../core/types';

export class TextTool {
  private _measureCtx: CanvasRenderingContext2D | null = null;

  private getMeasureContext(): CanvasRenderingContext2D | null {
    if (this._measureCtx) return this._measureCtx;
    if (typeof document !== 'undefined') {
      try {
        const canvas = document.createElement('canvas');
        this._measureCtx = canvas.getContext('2d');
      } catch (_) {
        this._measureCtx = null;
      }
    }
    return this._measureCtx;
  }

  /**
   * Computes exact page-unit bounding box dimensions for a single or multiline
   * text string at the given font size, family, and padding.
   */
  public measureTextBox(
    text: string,
    fontSize: number = 16,
    fontFamily: string = 'Inter',
    padding: number = 8,
    fontWeight: string | number = 'normal',
    fontStyle: string = 'normal'
  ): { width: number; height: number } {
    const rawLines = (text || ' ').split('\n');
    const lines = rawLines.length > 0 ? rawLines : [' '];
    const lineHeight = fontSize * 1.35;
    const ctx = this.getMeasureContext();
    if (ctx) {
      ctx.font = `${fontStyle || 'normal'} ${fontWeight || 'normal'} ${fontSize}px "${fontFamily}", sans-serif`;
    }

    let maxLineWidth = 0;
    for (const line of lines) {
      const sample = line.length > 0 ? line : ' ';
      let w = 0;
      if (ctx) {
        const m = ctx.measureText(sample);
        if (m && Number.isFinite(m.width) && m.width > 0) {
          w = m.width;
        }
      }
      if (w <= 0) {
        w = sample.length * (fontSize * 0.58);
      }
      if (w > maxLineWidth) maxLineWidth = w;
    }

    const width = Math.max(48, Math.ceil(maxLineWidth + padding * 2 + 8));
    const height = Math.max(
      Math.ceil(lineHeight + padding * 2),
      Math.ceil(lines.length * lineHeight + padding * 2)
    );
    return { width, height };
  }

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
    const padding = 8;
    const measured = this.measureTextBox(initialText, fontSize, fontFamily, padding);

    const box: BoundingBox = {
      x: point.x,
      y: point.y,
      width: measured.width,
      height: measured.height
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
      padding,
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
    const padding = ann.padding ?? 8;

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
