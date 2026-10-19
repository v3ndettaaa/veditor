/**
 * Sticky Note Annotation Tool
 * Supports expandable/collapsible sticky note cards with formatted text,
 * clipped freehand ink strokes, configurable paper colors, and author signature.
 */

import {
  Point,
  StrokePoint,
  BoundingBox,
  StickyNoteAnnotation,
  StickyNoteStroke
} from '../../core/types';
import { isPointInBox } from '../../utils/geometry';
import { renderSmoothStroke } from '../spline';

export const STICKY_NOTE_DEFAULT_SIZE = 210;
export const STICKY_NOTE_MIN_WIDTH = 150;
export const STICKY_NOTE_MIN_HEIGHT = 140;
export const STICKY_NOTE_MIN_SIZE = 140;
export const STICKY_NOTE_PIN_SIZE = 38;
export const STICKY_NOTE_CORNER_RADIUS = 10;

export interface StickyNotePreset {
  name: string;
  color: string;
  textColor: string;
}

export const STICKY_NOTE_PRESETS: StickyNotePreset[] = [
  { name: 'Canary Yellow', color: '#fef08a', textColor: '#3b2f1e' },
  { name: 'Warm Sand', color: '#fde68a', textColor: '#3b2f1e' },
  { name: 'Soft Mint', color: '#bbf7d0', textColor: '#14532d' },
  { name: 'Sky Blue', color: '#bae6fd', textColor: '#0c4a6e' },
  { name: 'Rose Pink', color: '#fbcfe8', textColor: '#701a75' },
  { name: 'Lavender', color: '#ddd6fe', textColor: '#3b0764' }
];

export const STICKY_NOTE_COLORS: Array<{ hex: string; label: string }> = [
  { hex: '#fef08a', label: 'Warm Yellow' },
  { hex: '#fde68a', label: 'Amber Sand' },
  { hex: '#bbf7d0', label: 'Mint Green' },
  { hex: '#bae6fd', label: 'Sky Blue' },
  { hex: '#fbcfe8', label: 'Soft Rose' },
  { hex: '#ddd6fe', label: 'Lavender' }
];

export const DEFAULT_STICKY_COLORS: string[] = STICKY_NOTE_COLORS.map(c => c.hex);

function rotatePointAround(p: Point, center: Point, angle: number): Point {
  if (!angle) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

/** Word-wraps a single paragraph line to fit within `maxWidth` pixels. */
function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string[] {
  if (!line || maxWidth <= 10) return [line];
  if (ctx.measureText(line).width <= maxWidth) return [line];

  const words = line.split(' ');
  const out: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) out.push(current);
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [''];
}

/** Formats lines with bullet or numbered prefixes when `listStyle` is enabled. */
export function formatStickyNoteDisplayLines(rawText: string, listStyle?: 'none' | 'bullet' | 'number'): string[] {
  const rawLines = rawText.replace(/\r\n/g, '\n').split('\n');
  if (!listStyle || listStyle === 'none') return rawLines;
  return rawLines.map((line, idx) => {
    const trimmed = line.replace(/^(\s*(?:•|-|\*|\d+\.)\s+)/, '');
    if (!trimmed && rawLines.length === 1) return '';
    if (listStyle === 'bullet') return `• ${trimmed}`;
    return `${idx + 1}. ${trimmed}`;
  });
}

export interface CreateStickyNoteOptions {
  color?: string;
  textColor?: string;
  author?: string;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: 'left' | 'center' | 'right';
  opacity?: number;
  collapsed?: boolean;
  strokes?: StickyNoteStroke[];
}

export class StickyNoteTool {
  private _active: boolean = false;
  private _pageIndex: number = 0;
  private _startPoint: Point | null = null;
  private _currentPoint: Point | null = null;
  private _color: string = '#fef08a';
  private _textColor: string = '#3b2f1e';
  private _fontSize: number = 15;
  private _fontFamily: string = 'Inter';
  private _author: string = 'Kia Gh';

  /**
   * Factory helper for creating a StickyNoteAnnotation with guaranteed minimum card dimensions.
   * Supports both (pageIndex, layerId, box, text, options) and (pageIndex, point, options).
   */
  public createStickyNote(
    pageIndex: number,
    layerOrPoint: string | Point,
    boxOrOptions?: BoundingBox | (CreateStickyNoteOptions & { layerId?: string; box?: BoundingBox; text?: string }),
    text: string = '',
    options: CreateStickyNoteOptions = {}
  ): StickyNoteAnnotation {
    const now = Date.now();
    let layerId = 'layer-default';
    let rawBox: BoundingBox;
    let finalText = text ?? '';
    let opts: CreateStickyNoteOptions = options;

    if (typeof layerOrPoint === 'string') {
      layerId = layerOrPoint;
      rawBox = (boxOrOptions as BoundingBox) || {
        x: 40,
        y: 40,
        width: STICKY_NOTE_DEFAULT_SIZE,
        height: STICKY_NOTE_DEFAULT_SIZE
      };
    } else {
      const point = layerOrPoint;
      const cfg = (boxOrOptions as (CreateStickyNoteOptions & { layerId?: string; box?: BoundingBox; text?: string })) || {};
      layerId = cfg.layerId || 'layer-default';
      rawBox = cfg.box || {
        x: Math.max(8, point.x - STICKY_NOTE_DEFAULT_SIZE / 2),
        y: Math.max(8, point.y - STICKY_NOTE_DEFAULT_SIZE / 2),
        width: STICKY_NOTE_DEFAULT_SIZE,
        height: STICKY_NOTE_DEFAULT_SIZE
      };
      finalText = cfg.text ?? '';
      opts = cfg;
    }

    const normalizedBox: BoundingBox = {
      x: rawBox.x,
      y: rawBox.y,
      width: Math.max(STICKY_NOTE_MIN_WIDTH, rawBox.width || STICKY_NOTE_DEFAULT_SIZE),
      height: Math.max(STICKY_NOTE_MIN_HEIGHT, rawBox.height || STICKY_NOTE_DEFAULT_SIZE),
      ...(rawBox.rotation !== undefined ? { rotation: rawBox.rotation } : {})
    };
    return {
      id: 'note_' + Math.random().toString(36).substring(2, 10),
      pageIndex,
      layerId,
      type: 'sticky-note',
      box: normalizedBox,
      collapsed: opts.collapsed ?? false,
      color: opts.color || '#fef08a',
      text: finalText,
      textColor: opts.textColor || '#3b2f1e',
      fontSize: opts.fontSize || 15,
      fontFamily: opts.fontFamily || 'Inter',
      textAlign: opts.textAlign || 'left',
      author: opts.author !== undefined ? opts.author : 'Kia Gh',
      strokes: opts.strokes ? opts.strokes.map(s => ({ ...s, points: s.points.map(p => ({ ...p })) })) : [],
      opacity: opts.opacity ?? 1.0,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Returns the compact 38x38 folded-corner icon bounding box used when `ann.collapsed === true`.
   */
  public getCollapsedIconBox(ann: StickyNoteAnnotation): BoundingBox {
    return {
      x: ann.box.x,
      y: ann.box.y,
      width: STICKY_NOTE_PIN_SIZE,
      height: STICKY_NOTE_PIN_SIZE,
      rotation: ann.rotation || 0
    };
  }

  /**
   * Hit-tests a StickyNoteAnnotation in page coordinates (accounting for collapsed state and rotation).
   */
  public hitTest(ann: StickyNoteAnnotation, point: Point): boolean {
    if (ann.collapsed) {
      const iconBox = this.getCollapsedIconBox(ann);
      const center = { x: iconBox.x + iconBox.width / 2, y: iconBox.y + iconBox.height / 2 };
      const local = rotatePointAround(point, center, -(ann.rotation || 0));
      return isPointInBox(local, iconBox);
    }
    const center = { x: ann.box.x + ann.box.width / 2, y: ann.box.y + ann.box.height / 2 };
    const local = rotatePointAround(point, center, -(ann.rotation || 0));
    return isPointInBox(local, ann.box);
  }

  /**
   * Returns true if `point` lands on the top-right collapse button inside an expanded note's header.
   */
  public hitTestCollapseButton(ann: StickyNoteAnnotation, point: Point): boolean {
    if (ann.collapsed) return false;
    const center = { x: ann.box.x + ann.box.width / 2, y: ann.box.y + ann.box.height / 2 };
    const local = rotatePointAround(point, center, -(ann.rotation || 0));
    const b = ann.box;
    return (
      local.x >= b.x + b.width - 36 &&
      local.x <= b.x + b.width - 4 &&
      local.y >= b.y + 4 &&
      local.y <= b.y + 34
    );
  }

  /**
   * Returns true if `point` is inside the note's main body content area (below header, above footer).
   */
  public isPointInContentArea(ann: StickyNoteAnnotation, point: Point): boolean {
    if (ann.collapsed) return false;
    const center = { x: ann.box.x + ann.box.width / 2, y: ann.box.y + ann.box.height / 2 };
    const local = rotatePointAround(point, center, -(ann.rotation || 0));
    const b = ann.box;
    return (
      local.x >= b.x + 6 &&
      local.x <= b.x + b.width - 6 &&
      local.y >= b.y + 36 &&
      local.y <= b.y + b.height - 8
    );
  }

  public start(
    point: Point,
    pageIndex: number,
    color: string = '#fef08a',
    textColor: string = '#3b2f1e',
    fontSize: number = 15,
    fontFamily: string = 'Inter',
    author: string = 'Kia Gh'
  ): void {
    this._active = true;
    this._pageIndex = pageIndex;
    this._startPoint = { ...point };
    this._currentPoint = { ...point };
    this._color = color || '#fef08a';
    this._textColor = textColor || '#3b2f1e';
    this._fontSize = fontSize || 15;
    this._fontFamily = fontFamily || 'Inter';
    this._author = author ?? 'Kia Gh';
  }

  public move(point: Point): void {
    if (!this._active) return;
    this._currentPoint = { ...point };
  }

  public cancel(): void {
    this._active = false;
    this._startPoint = null;
    this._currentPoint = null;
  }

  public finish(layerId: string): StickyNoteAnnotation | null {
    if (!this._active || !this._startPoint || !this._currentPoint) return null;
    const s = this._startPoint;
    const c = this._currentPoint;
    this._active = false;
    this._startPoint = null;
    this._currentPoint = null;

    const dragW = Math.abs(c.x - s.x);
    const dragH = Math.abs(c.y - s.y);

    const box: BoundingBox = (dragW < 14 && dragH < 14)
      ? {
          x: Math.max(8, s.x - STICKY_NOTE_DEFAULT_SIZE / 2),
          y: Math.max(8, s.y - STICKY_NOTE_DEFAULT_SIZE / 2),
          width: STICKY_NOTE_DEFAULT_SIZE,
          height: STICKY_NOTE_DEFAULT_SIZE
        }
      : {
          x: Math.min(s.x, c.x),
          y: Math.min(s.y, c.y),
          width: Math.max(STICKY_NOTE_MIN_WIDTH, dragW),
          height: Math.max(STICKY_NOTE_MIN_HEIGHT, dragH)
        };

    return this.createStickyNote(this._pageIndex, layerId, box, '', {
      color: this._color,
      textColor: this._textColor,
      fontSize: this._fontSize,
      fontFamily: this._fontFamily,
      author: this._author
    });
  }

  /**
   * Renders a live in-progress pen stroke clipped inside `ann.box`.
   */
  public renderLiveStroke(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    points: StrokePoint[],
    color: string,
    strokeWidth: number,
    opacity: number = 1,
    scale: number = 1
  ): void {
    if (ann.collapsed || points.length === 0) return;
    const b = ann.box;
    ctx.save();
    ctx.scale(scale, scale);
    if (ann.rotation) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(ann.rotation);
      ctx.translate(-cx, -cy);
    }
    drawRoundedRectPath(ctx, b.x + 2, b.y + 36, b.width - 4, b.height - 40, Math.max(2, STICKY_NOTE_CORNER_RADIUS - 2));
    ctx.clip();
    ctx.globalAlpha = opacity;
    renderSmoothStroke(
      ctx,
      points,
      color || ann.textColor || '#3b2f1e',
      strokeWidth || 2,
      'linear',
      false,
      true,
      'balanced',
      'round',
      'medium'
    );
    ctx.restore();
  }

  public renderLiveStrokeInNote(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    points: StrokePoint[],
    color: string,
    strokeWidth: number,
    opacity: number = 1,
    scale: number = 1
  ): void {
    this.renderLiveStroke(ctx, ann, points, color, strokeWidth, opacity, scale);
  }

  /**
   * Renders a drag preview of a new Sticky Note card on the scratchpad canvas.
   */
  public renderPreview(
    ctx: CanvasRenderingContext2D,
    box: BoundingBox,
    scale: number = 1.0,
    color: string = '#fef08a',
    author: string = 'Kia Gh',
    textColor: string = '#3b2f1e'
  ): void {
    const previewAnn: StickyNoteAnnotation = {
      id: 'preview',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'sticky-note',
      box,
      collapsed: false,
      color,
      text: '',
      textColor,
      fontSize: 15,
      fontFamily: 'Inter',
      textAlign: 'left',
      author,
      strokes: [],
      opacity: 0.9,
      createdAt: 0,
      updatedAt: 0
    };
    this.renderToCanvas(ctx, previewAnn, scale, false);
  }

  /**
   * Renders a StickyNoteAnnotation onto any 2D canvas context.
   */
  public render(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    scale: number = 1.0,
    isEditingText: boolean = false
  ): void {
    this.renderToCanvas(ctx, ann, scale, isEditingText);
  }

  /**
   * Renders a StickyNoteAnnotation onto any 2D canvas context (screen or PDF export).
   */
  public renderToCanvas(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    scale: number = 1.0,
    isEditingText: boolean = false
  ): void {
    ctx.save();
    ctx.scale(scale, scale);

    if (ann.collapsed) {
      this.renderCollapsedIcon(ctx, ann);
      ctx.restore();
      return;
    }

    const b = ann.box;
    const r = STICKY_NOTE_CORNER_RADIUS;

    // 1. Card elevation shadow & warm paper fill
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.20)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    drawRoundedRectPath(ctx, b.x, b.y, b.width, b.height, r);
    ctx.fillStyle = ann.color || '#fef08a';
    ctx.fill();
    ctx.restore();

    // 2. Subtle card border
    drawRoundedRectPath(ctx, b.x, b.y, b.width, b.height, r);
    ctx.strokeStyle = 'rgba(59, 47, 30, 0.26)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 3. Header bar separator and top-right collapse button
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 47, 30, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + 12, b.y + 36);
    ctx.lineTo(b.x + b.width - 12, b.y + 36);
    ctx.stroke();

    // Top-right collapse button icon (inward diagonal arrows)
    const btnCx = b.x + b.width - 21;
    const btnCy = b.y + 18;
    ctx.fillStyle = 'rgba(59, 47, 30, 0.08)';
    drawRoundedRectPath(ctx, btnCx - 11, btnCy - 11, 22, 22, 6);
    ctx.fill();

    ctx.strokeStyle = ann.textColor || '#3b2f1e';
    ctx.globalAlpha = (ann.opacity ?? 1) * 0.72;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    // Top-right arrow pointing inward
    ctx.moveTo(btnCx + 5, btnCy - 5);
    ctx.lineTo(btnCx + 1, btnCy - 1);
    ctx.moveTo(btnCx + 1, btnCy - 4.5);
    ctx.lineTo(btnCx + 1, btnCy - 1);
    ctx.lineTo(btnCx + 4.5, btnCy - 1);
    // Bottom-left arrow pointing inward
    ctx.moveTo(btnCx - 5, btnCy + 5);
    ctx.lineTo(btnCx - 1, btnCy + 1);
    ctx.moveTo(btnCx - 1, btnCy + 4.5);
    ctx.lineTo(btnCx - 1, btnCy + 1);
    ctx.lineTo(btnCx - 4.5, btnCy + 1);
    ctx.stroke();
    ctx.restore();

    // 4. Clipped interior for freehand ink strokes & typography
    ctx.save();
    drawRoundedRectPath(ctx, b.x, b.y, b.width, b.height, r);
    ctx.clip();

    const hasStrokes = Array.isArray(ann.strokes) && ann.strokes.length > 0;
    const rawText = (ann.text || '').trim();
    const padX = 14;
    const padTop = 44;
    const footerReserve = ann.author ? 28 : 12;
    const availW = Math.max(20, b.width - padX * 2);
    const availH = Math.max(20, b.height - padTop - footerReserve);

    if (!isEditingText) {
      if (rawText.length > 0) {
        const fontSize = Math.max(8, ann.fontSize || 15);
        const weight = ann.fontWeight === 'bold' || Number(ann.fontWeight) >= 600 ? 'bold' : 'normal';
        const style = ann.fontStyle === 'italic' ? 'italic' : 'normal';
        const family = ann.fontFamily || 'Inter';
        ctx.font = `${style} ${weight} ${fontSize}px ${family}, -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.fillStyle = ann.textColor || '#3b2f1e';
        ctx.textBaseline = 'top';

        const displayLines = formatStickyNoteDisplayLines(ann.text, ann.listStyle);
        const wrappedLines: string[] = [];
        for (const para of displayLines) {
          wrappedLines.push(...wrapLine(ctx, para, availW));
        }

        const lineHeight = fontSize * 1.35;
        let curY = b.y + padTop;
        const maxBottom = b.y + padTop + availH;

        for (const line of wrappedLines) {
          if (curY + fontSize * 0.6 > maxBottom) break;
          let drawX = b.x + padX;
          if (ann.textAlign === 'center') {
            drawX = b.x + b.width / 2;
            ctx.textAlign = 'center';
          } else if (ann.textAlign === 'right') {
            drawX = b.x + b.width - padX;
            ctx.textAlign = 'right';
          } else {
            ctx.textAlign = 'left';
          }
          ctx.fillText(line, drawX, curY);
          curY += lineHeight;
        }
      } else if (!hasStrokes) {
        // Centered "Add text" placeholder matching reference screenshot 1
        const placeholderSize = Math.max(14, Math.min(20, Math.round(Math.min(b.width, b.height) * 0.10)));
        ctx.font = `400 ${placeholderSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.fillStyle = 'rgba(59, 47, 30, 0.42)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Add text', b.x + b.width / 2, b.y + 36 + (b.height - 36 - (ann.author ? 24 : 0)) / 2);
      }
    }

    // Render internal freehand ink strokes inside note
    if (hasStrokes) {
      for (const stroke of ann.strokes) {
        if (stroke.points && stroke.points.length > 0) {
          ctx.save();
          if (stroke.opacity !== undefined) {
            ctx.globalAlpha = (ann.opacity ?? 1) * stroke.opacity;
          }
          renderSmoothStroke(
            ctx,
            stroke.points,
            stroke.color || ann.textColor || '#3b2f1e',
            stroke.strokeWidth || 2.0,
            'linear',
            false,
            true,
            'balanced',
            'round',
            'medium'
          );
          ctx.restore();
        }
      }
    }

    // 5. Bottom-left author signature label (e.g. "Kia Gh")
    if (ann.author && ann.author.trim().length > 0 && b.height >= 72) {
      const authorFontSize = 11.5;
      ctx.font = `600 ${authorFontSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = ann.textColor || '#3b2f1e';
      ctx.globalAlpha = (ann.opacity ?? 1) * 0.72;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(ann.author.trim(), b.x + 14, b.y + b.height - 12);
    }

    ctx.restore();
    ctx.restore();
  }

  /**
   * Renders the collapsed folded-corner sticky note icon (matching screenshot 3).
   */
  private renderCollapsedIcon(ctx: CanvasRenderingContext2D, ann: StickyNoteAnnotation): void {
    const iconBox = this.getCollapsedIconBox(ann);
    const size = iconBox.width;
    const x = iconBox.x;
    const y = iconBox.y;
    const r = 7;
    const fold = 11;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.24)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 2;

    // Outer shape with bottom-right folded cut
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + size - r, y);
    ctx.quadraticCurveTo(x + size, y, x + size, y + r);
    ctx.lineTo(x + size, y + size - fold);
    ctx.lineTo(x + size - fold, y + size);
    ctx.lineTo(x + r, y + size);
    ctx.quadraticCurveTo(x, y + size, x, y + size - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();

    ctx.fillStyle = ann.color || '#fef08a';
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Folded corner flap triangle
    ctx.beginPath();
    ctx.moveTo(x + size - fold, y + size);
    ctx.lineTo(x + size - fold, y + size - fold + 2);
    ctx.quadraticCurveTo(
      x + size - fold,
      y + size - fold,
      x + size - fold + 2,
      y + size - fold
    );
    ctx.lineTo(x + size, y + size - fold);
    ctx.closePath();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fill();
    ctx.stroke();

    // Subtle note lines hint when note contains text or ink
    if ((ann.text && ann.text.trim().length > 0) || (ann.strokes && ann.strokes.length > 0)) {
      ctx.save();
      ctx.strokeStyle = ann.textColor || '#3b2f1e';
      ctx.globalAlpha = (ann.opacity ?? 1) * 0.55;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 8, y + 11);
      ctx.lineTo(x + size - 8, y + 11);
      ctx.moveTo(x + 8, y + 18);
      ctx.lineTo(x + size - 10, y + 18);
      ctx.moveTo(x + 8, y + 25);
      ctx.lineTo(x + size - 15, y + 25);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export const stickyNoteTool = new StickyNoteTool();
