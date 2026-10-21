/**
 * Sticky Note Annotation Tool
 * Supports expandable/collapsible sticky note cards with formatted text,
 * clipped freehand ink strokes, configurable paper colors, and author signature.
 */

import {
  Point,
  StrokePoint,
  BoundingBox,
  Annotation,
  ShapeAnnotation,
  StickyNoteAnnotation,
  StickyNoteStroke
} from '../../core/types';
import { isPointInBox, traceRoundedPolygon, fillLineRibbon } from '../../utils/geometry';
import { renderSmoothStroke } from '../spline';
import { textTool } from './text';

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
  iconWidth?: number;
  iconHeight?: number;
  strokes?: StickyNoteStroke[];
  items?: Annotation[];
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
  private _author: string = '';

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
      author: opts.author !== undefined ? opts.author : '',
      ...(opts.iconWidth !== undefined ? { iconWidth: Math.max(20, opts.iconWidth) } : {}),
      ...(opts.iconHeight !== undefined ? { iconHeight: Math.max(20, opts.iconHeight) } : {}),
      strokes: opts.strokes ? opts.strokes.map(s => ({ ...s, points: s.points.map(p => ({ ...p })) })) : [],
      ...(opts.items ? { items: JSON.parse(JSON.stringify(opts.items)) } : {}),
      opacity: opts.opacity ?? 1.0,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Returns the folded-corner icon bounding box used when `ann.collapsed === true`.
   * Respects custom resized `iconWidth` / `iconHeight` while defaulting to 38x38.
   */
  public getCollapsedIconBox(ann: StickyNoteAnnotation): BoundingBox {
    return {
      x: ann.box.x,
      y: ann.box.y,
      width: Math.max(20, ann.iconWidth ?? STICKY_NOTE_PIN_SIZE),
      height: Math.max(20, ann.iconHeight ?? STICKY_NOTE_PIN_SIZE),
      rotation: ann.rotation || 0
    };
  }

  /**
   * Translates a StickyNoteAnnotation's card box, strokes, and embedded items by (dx, dy).
   */
  private translateNoteContent(ann: StickyNoteAnnotation, dx: number, dy: number): StickyNoteAnnotation {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { ...ann };
    const shiftPt = <P extends Point>(p: P): P => ({ ...p, x: p.x + dx, y: p.y + dy });
    const shiftItem = (item: Annotation): Annotation => {
      const next: any = JSON.parse(JSON.stringify(item));
      next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };
      if (Array.isArray(next.points) && next.points.length > 0) {
        next.points = Array.isArray(next.points[0])
          ? next.points.map((s: Point[]) => s.map(shiftPt))
          : next.points.map(shiftPt);
      }
      return next as Annotation;
    };
    return {
      ...ann,
      box: {
        ...ann.box,
        x: ann.box.x + dx,
        y: ann.box.y + dy
      },
      strokes: Array.isArray(ann.strokes)
        ? ann.strokes.map(s => ({
            ...s,
            points: Array.isArray(s.points) ? s.points.map(shiftPt) : []
          }))
        : [],
      ...(Array.isArray(ann.items) ? { items: ann.items.map(shiftItem) } : {})
    };
  }

  private _lastContentTimestamp = 0;

  /**
   * Returns a strictly monotonic timestamp guaranteed to be greater than every
   * existing stroke and item inside `note` so chronological z-order is deterministic.
   */
  public nextContentTimestamp(note?: StickyNoteAnnotation): number {
    let maxExisting = this._lastContentTimestamp;
    if (note) {
      for (const s of note.strokes || []) {
        if (typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) && s.createdAt > maxExisting) {
          maxExisting = s.createdAt;
        }
      }
      for (const it of note.items || []) {
        if (typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) && it.createdAt > maxExisting) {
          maxExisting = it.createdAt;
        }
      }
    }
    const now = Date.now();
    this._lastContentTimestamp = now > maxExisting ? now : maxExisting + 1;
    return this._lastContentTimestamp;
  }

  /**
   * Expands a collapsed StickyNoteAnnotation so the full card opens in a direction
   * that fits inside `[0..pageWidth, 0..pageHeight]` (e.g. opening leftward when near
   * the right edge of the page, or upward when near the bottom edge).
   */
  public expandStickyNoteForPage(
    ann: StickyNoteAnnotation,
    pageWidth: number = 0,
    pageHeight: number = 0
  ): StickyNoteAnnotation {
    const iconBox = this.getCollapsedIconBox(ann);
    const anchorX = iconBox.x;
    const anchorY = iconBox.y;
    const cardW = ann.box.width;
    const cardH = ann.box.height;
    const margin = 8;

    let targetX = anchorX;
    let targetY = anchorY;

    if (pageWidth > 0) {
      if (anchorX + cardW > pageWidth - margin) {
        // Not enough room to the right: open leftward from the icon's right edge
        const openLeftX = anchorX + iconBox.width - cardW;
        targetX = Math.max(margin, Math.min(openLeftX, pageWidth - cardW - margin));
      } else if (targetX < margin) {
        targetX = margin;
      }
    }

    if (pageHeight > 0) {
      if (anchorY + cardH > pageHeight - margin) {
        // Not enough room below: open upward from the icon's bottom edge
        const openUpY = anchorY + iconBox.height - cardH;
        targetY = Math.max(margin, Math.min(openUpY, pageHeight - cardH - margin));
      } else if (targetY < margin) {
        targetY = margin;
      }
    }

    const dx = targetX - ann.box.x;
    const dy = targetY - ann.box.y;
    const shifted = this.translateNoteContent(ann, dx, dy);
    return {
      ...shifted,
      collapsed: false,
      anchorX,
      anchorY,
      updatedAt: Date.now()
    };
  }

  /**
   * Collapses an expanded StickyNoteAnnotation back to its icon, restoring its
   * original `anchorX`/`anchorY` pin coordinate if it was smart-expanded near a page edge.
   */
  public collapseStickyNote(ann: StickyNoteAnnotation): StickyNoteAnnotation {
    let targetX = ann.box.x;
    let targetY = ann.box.y;
    if (ann.anchorX !== undefined && ann.anchorX >= ann.box.x - 4 && ann.anchorX <= ann.box.x + ann.box.width + 4) {
      targetX = ann.anchorX;
    }
    if (ann.anchorY !== undefined && ann.anchorY >= ann.box.y - 4 && ann.anchorY <= ann.box.y + ann.box.height + 4) {
      targetY = ann.anchorY;
    }
    const dx = targetX - ann.box.x;
    const dy = targetY - ann.box.y;
    const shifted = this.translateNoteContent(ann, dx, dy);
    const next: StickyNoteAnnotation = {
      ...shifted,
      collapsed: true,
      updatedAt: Date.now()
    };
    delete next.anchorX;
    delete next.anchorY;
    return next;
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

  /**
   * Clamps a point (or StrokePoint) so it stays strictly inside the Sticky Note's border
   * (with `pad` inset) while drawing or writing inside the note.
   */
  public clampPointToNote<P extends Point>(ann: StickyNoteAnnotation, pt: P, pad: number = 3): P {
    const b = ann.box;
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const rot = ann.rotation || 0;
    const local = rot ? rotatePointAround(pt, center, -rot) : pt;
    const safePad = Math.max(2, Math.min(pad, b.width * 0.25, b.height * 0.25));
    const clampedLocal: Point = {
      x: Math.max(b.x + safePad, Math.min(b.x + b.width - safePad, local.x)),
      y: Math.max(b.y + safePad, Math.min(b.y + b.height - safePad, local.y))
    };
    const world = rot ? rotatePointAround(clampedLocal, center, rot) : clampedLocal;
    return { ...pt, x: world.x, y: world.y };
  }

  /**
   * Executes `drawFn` clipped strictly inside the Sticky Note's full rounded card border.
   */
  public withNoteClip(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    scaleOrFn: number | (() => void),
    maybeDrawFn?: () => void
  ): void {
    const scale = typeof scaleOrFn === 'number' ? scaleOrFn : 1;
    const drawFn = typeof scaleOrFn === 'function' ? scaleOrFn : maybeDrawFn;
    if (!drawFn) return;
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
    drawRoundedRectPath(
      ctx,
      b.x + 1.5,
      b.y + 1.5,
      b.width - 3,
      b.height - 3,
      Math.max(2, STICKY_NOTE_CORNER_RADIUS - 1.5)
    );
    ctx.clip();
    ctx.scale(1 / scale, 1 / scale);
    drawFn();
    ctx.restore();
  }

  public start(
    point: Point,
    pageIndex: number,
    color: string = '#fef08a',
    textColor: string = '#3b2f1e',
    fontSize: number = 15,
    fontFamily: string = 'Inter',
    author: string = ''
  ): void {
    this._active = true;
    this._pageIndex = pageIndex;
    this._startPoint = { ...point };
    this._currentPoint = { ...point };
    this._color = color || '#fef08a';
    this._textColor = textColor || '#3b2f1e';
    this._fontSize = fontSize || 15;
    this._fontFamily = fontFamily || 'Inter';
    this._author = author ?? '';
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
   * Renders a live in-progress pen or highlighter stroke clipped inside the full `ann.box` card border.
   */
  public renderLiveStroke(
    ctx: CanvasRenderingContext2D,
    ann: StickyNoteAnnotation,
    points: StrokePoint[],
    color: string,
    strokeWidth: number,
    opacity: number = 1,
    scale: number = 1,
    isHighlighter: boolean = false,
    pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
    pressureEnabled: boolean = true,
    pressureStrength: 'light' | 'balanced' | 'strong' = 'balanced',
    tipShape: 'chisel' | 'round' = 'round',
    smoothing: 'none' | 'subtle' | 'medium' | 'high' | 'light' | 'heavy' = 'medium'
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
    drawRoundedRectPath(
      ctx,
      b.x + 1.5,
      b.y + 1.5,
      b.width - 3,
      b.height - 3,
      Math.max(2, STICKY_NOTE_CORNER_RADIUS - 1.5)
    );
    ctx.clip();
    ctx.globalAlpha = isHighlighter ? 1.0 : opacity;
    const mappedSmoothing: 'none' | 'subtle' | 'medium' | 'high' =
      smoothing === 'light' ? 'subtle' : smoothing === 'heavy' ? 'high' : smoothing;
    renderSmoothStroke(
      ctx,
      points,
      color || ann.textColor || '#3b2f1e',
      strokeWidth || 2,
      pressureCurve,
      isHighlighter,
      pressureEnabled,
      pressureStrength,
      tipShape,
      mappedSmoothing
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
    scale: number = 1,
    optionsOrIsHighlighter?:
      | boolean
      | {
          tool?: 'pen' | 'highlighter' | string;
          pressureEnabled?: boolean;
          pressureCurve?: 'linear' | 'soft' | 'firm' | 'exponential';
          pressureStrength?: 'light' | 'balanced' | 'strong';
          smoothing?: 'none' | 'subtle' | 'medium' | 'high' | 'light' | 'heavy';
          blendMode?: 'multiply' | 'source-over';
          tipShape?: 'chisel' | 'round';
        },
    pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential' = 'linear',
    pressureEnabled: boolean = true,
    pressureStrength: 'light' | 'balanced' | 'strong' = 'balanced',
    tipShape: 'chisel' | 'round' = 'round',
    smoothing: 'none' | 'subtle' | 'medium' | 'high' | 'light' | 'heavy' = 'medium'
  ): void {
    if (typeof optionsOrIsHighlighter === 'object' && optionsOrIsHighlighter !== null) {
      const isHigh = optionsOrIsHighlighter.tool === 'highlighter';
      this.renderLiveStroke(
        ctx,
        ann,
        points,
        color,
        strokeWidth,
        opacity,
        scale,
        isHigh,
        optionsOrIsHighlighter.pressureCurve || 'linear',
        optionsOrIsHighlighter.pressureEnabled !== false,
        optionsOrIsHighlighter.pressureStrength || 'balanced',
        optionsOrIsHighlighter.tipShape || (isHigh ? 'chisel' : 'round'),
        optionsOrIsHighlighter.smoothing || 'medium'
      );
      return;
    }
    this.renderLiveStroke(
      ctx,
      ann,
      points,
      color,
      strokeWidth,
      opacity,
      scale,
      Boolean(optionsOrIsHighlighter),
      pressureCurve,
      pressureEnabled,
      pressureStrength,
      tipShape,
      smoothing
    );
  }

  /**
   * Renders a drag preview of a new Sticky Note card on the scratchpad canvas.
   */
  public renderPreview(
    ctx: CanvasRenderingContext2D,
    box: BoundingBox,
    scale: number = 1.0,
    color: string = '#fef08a',
    author: string = '',
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

    // 3. Header bar separator line
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 47, 30, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + 12, b.y + 36);
    ctx.lineTo(b.x + b.width - 12, b.y + 36);
    ctx.stroke();
    ctx.restore();

    // 4. Clipped interior for typography, freehand strokes (pen & highlighter), and embedded items (shapes & text)
    ctx.save();
    drawRoundedRectPath(ctx, b.x + 1.5, b.y + 1.5, b.width - 3, b.height - 3, Math.max(2, r - 1.5));
    ctx.clip();

    const hasStrokes = Array.isArray(ann.strokes) && ann.strokes.length > 0;
    const hasItems = Array.isArray(ann.items) && ann.items.length > 0;
    const rawText = (ann.text || '').trim();
    const padX = 14;
    const padTop = 44;
    const footerReserve = 12;
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
      }
    }

    // Render internal freehand strokes (pen & highlighter) and embedded board items (shapes & text)
    // in unified chronological creation order so newer drawings always appear on top of older ones.
    if (hasStrokes || hasItems) {
      type NoteDrawable =
        | { kind: 'stroke'; stroke: StickyNoteStroke; time: number; seq: number }
        | { kind: 'item'; item: Annotation; time: number; seq: number };
      const drawables: NoteDrawable[] = [];
      let seq = 0;
      if (hasStrokes) {
        for (const stroke of ann.strokes) {
          drawables.push({
            kind: 'stroke',
            stroke,
            time: typeof stroke.createdAt === 'number' && Number.isFinite(stroke.createdAt) ? stroke.createdAt : 0,
            seq: seq++
          });
        }
      }
      if (hasItems && ann.items) {
        for (const item of ann.items) {
          drawables.push({
            kind: 'item',
            item,
            time: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
            seq: seq++
          });
        }
      }
      drawables.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.seq - b.seq));

      for (const entry of drawables) {
        if (entry.kind === 'stroke') {
          const stroke = entry.stroke;
          if (stroke.points && stroke.points.length > 0) {
            const isHl = stroke.tool === 'highlighter';
            ctx.save();
            if (!isHl && stroke.opacity !== undefined) {
              ctx.globalAlpha = (ann.opacity ?? 1) * stroke.opacity;
            }
            const rawSm = stroke.smoothing || stroke.strokeSmoothing || 'medium';
            const mappedSm: 'none' | 'subtle' | 'medium' | 'high' =
              rawSm === 'light' ? 'subtle' : rawSm === 'heavy' ? 'high' : rawSm;
            renderSmoothStroke(
              ctx,
              stroke.points,
              stroke.color || ann.textColor || '#3b2f1e',
              stroke.strokeWidth || 2.0,
              stroke.pressureCurve || 'linear',
              isHl,
              isHl ? false : (stroke.pressureEnabled !== false),
              stroke.pressureStrength || 'balanced',
              stroke.tipShape || 'round',
              mappedSm
            );
            ctx.restore();
          }
        } else {
          this.renderEmbeddedItem(ctx, entry.item);
        }
      }
    }

    ctx.restore();

    // 6. Top-right collapse button icon rendered on top so it stays crisp and accessible
    ctx.save();
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
    ctx.moveTo(btnCx + 5, btnCy - 5);
    ctx.lineTo(btnCx + 1, btnCy - 1);
    ctx.moveTo(btnCx + 1, btnCy - 4.5);
    ctx.lineTo(btnCx + 1, btnCy - 1);
    ctx.lineTo(btnCx + 4.5, btnCy - 1);
    ctx.moveTo(btnCx - 5, btnCy + 5);
    ctx.lineTo(btnCx - 1, btnCy + 1);
    ctx.moveTo(btnCx - 1, btnCy + 4.5);
    ctx.lineTo(btnCx - 1, btnCy + 1);
    ctx.lineTo(btnCx - 4.5, btnCy + 1);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  /**
   * Renders an embedded Shape or Text annotation inside a Sticky Note card's clipped coordinate space.
   */
  private renderEmbeddedItem(ctx: CanvasRenderingContext2D, item: Annotation): void {
    ctx.save();
    ctx.globalAlpha = item.opacity ?? 1.0;
    if (item.type === 'text') {
      textTool.renderToCanvas(ctx, item, 1);
      ctx.restore();
      return;
    }
    if (item.type === 'pen') {
      renderSmoothStroke(
        ctx,
        item.points,
        item.color,
        item.strokeWidth,
        item.pressureCurve || 'linear',
        false,
        item.pressureEnabled !== false,
        item.pressureStrength || 'balanced',
        'round',
        item.strokeSmoothing || 'medium'
      );
      ctx.restore();
      return;
    }
    if (item.type === 'highlighter') {
      renderSmoothStroke(
        ctx,
        item.points,
        item.color,
        item.strokeWidth,
        'linear',
        true,
        false,
        'balanced',
        item.tipShape || 'round'
      );
      ctx.restore();
      return;
    }
    if (
      item.type === 'rectangle' ||
      item.type === 'ellipse' ||
      item.type === 'line' ||
      item.type === 'arrow' ||
      item.type === 'polygon' ||
      item.type === 'freeform-shape'
    ) {
      const sh = item as ShapeAnnotation;
      const w = Math.max(1, sh.strokeWidth || 2);
      const outline = sh.type === 'line' || sh.type === 'arrow' || sh.outline !== false;
      const cornerRadius = Number.isFinite(sh.cornerRadius) ? Math.max(0, sh.cornerRadius!) : 0;
      const fillAlpha = Math.max(0, Math.min(1, sh.fillOpacity ?? 1));
      const hasFill = Boolean(sh.fillColor && sh.fillColor !== 'transparent' && fillAlpha > 0);
      const fillInterior = () => {
        if (!hasFill) return;
        ctx.save();
        ctx.globalAlpha *= fillAlpha;
        ctx.fillStyle = sh.fillColor!;
        ctx.fill();
        ctx.restore();
      };

      ctx.strokeStyle = sh.strokeColor;
      ctx.fillStyle = sh.fillColor || 'transparent';
      ctx.lineWidth = w;
      ctx.lineJoin = cornerRadius === 0 && (sh.type === 'rectangle' || sh.type === 'polygon' || sh.type === 'freeform-shape')
        ? 'miter'
        : 'round';
      ctx.miterLimit = 4;
      ctx.lineCap = 'round';
      if (sh.strokeStyle === 'dashed') {
        ctx.setLineDash([Math.max(8, w * 2.0), Math.max(6, w * 1.55)]);
      } else if (sh.strokeStyle === 'dotted') {
        ctx.setLineDash([0.1, Math.max(5, w * 1.85)]);
      } else {
        ctx.setLineDash([]);
      }
      const sb = sh.box;
      if (sh.type === 'rectangle') {
        const radius = Math.max(0, Math.min(cornerRadius, sb.width / 2, sb.height / 2));
        drawRoundedRectPath(ctx, sb.x, sb.y, sb.width, sb.height, radius);
        fillInterior();
        if (outline) ctx.stroke();
      } else if (sh.type === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(
          sb.x + sb.width / 2,
          sb.y + sb.height / 2,
          Math.max(1, sb.width / 2),
          Math.max(1, sb.height / 2),
          0,
          0,
          Math.PI * 2
        );
        fillInterior();
        if (outline) ctx.stroke();
      } else if ((sh.type === 'line' || sh.type === 'arrow') && sh.points && sh.points.length >= 2) {
        const pts = sh.points;
        if (sh.strokeStyle === 'dashed' || sh.strokeStyle === 'dotted') {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            fillLineRibbon(ctx, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, w);
          }
        }
        if (sh.type === 'arrow') {
          ctx.setLineDash([]);
          const prev = pts[pts.length - 2];
          const tip = pts[pts.length - 1];
          const headLen = Math.max(12, w * 4);
          const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - headLen * Math.cos(angle - Math.PI / 6), tip.y - headLen * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(tip.x - headLen * Math.cos(angle + Math.PI / 6), tip.y - headLen * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fillStyle = sh.strokeColor;
          ctx.fill();
          ctx.lineWidth = Math.min(2, w * 0.5);
          ctx.stroke();
        }
      } else if ((sh.type === 'polygon' || sh.type === 'freeform-shape') && sh.points && sh.points.length >= 2) {
        ctx.beginPath();
        traceRoundedPolygon(ctx, sh.points, cornerRadius, true);
        fillInterior();
        if (outline) ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Renders the collapsed folded-corner sticky note icon, scaled proportionally to `iconBox`.
   */
  private renderCollapsedIcon(ctx: CanvasRenderingContext2D, ann: StickyNoteAnnotation): void {
    const iconBox = this.getCollapsedIconBox(ann);
    const w = iconBox.width;
    const h = iconBox.height;
    const minDim = Math.min(w, h);
    const ratio = minDim / STICKY_NOTE_PIN_SIZE;
    const x = iconBox.x;
    const y = iconBox.y;
    const r = Math.max(3, 7 * ratio);
    const fold = Math.max(5, 11 * ratio);

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.24)';
    ctx.shadowBlur = 7 * ratio;
    ctx.shadowOffsetY = 2 * ratio;

    // Outer shape with bottom-right folded cut
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - fold);
    ctx.lineTo(x + w - fold, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();

    ctx.fillStyle = ann.color || '#fef08a';
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = Math.max(1.2, 1.75 * ratio);
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Folded corner flap triangle
    const flapInset = 2 * ratio;
    ctx.beginPath();
    ctx.moveTo(x + w - fold, y + h);
    ctx.lineTo(x + w - fold, y + h - fold + flapInset);
    ctx.quadraticCurveTo(
      x + w - fold,
      y + h - fold,
      x + w - fold + flapInset,
      y + h - fold
    );
    ctx.lineTo(x + w, y + h - fold);
    ctx.closePath();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fill();
    ctx.stroke();

    // Subtle note lines hint when note contains text, ink, or embedded items
    const hasContent =
      (ann.text && ann.text.trim().length > 0) ||
      (ann.strokes && ann.strokes.length > 0) ||
      (ann.items && ann.items.length > 0);
    if (hasContent) {
      ctx.save();
      ctx.strokeStyle = ann.textColor || '#3b2f1e';
      ctx.globalAlpha = (ann.opacity ?? 1) * 0.55;
      ctx.lineWidth = Math.max(1, 1.5 * ratio);
      ctx.lineCap = 'round';
      ctx.beginPath();
      const lx0 = x + (8 / 38) * w;
      ctx.moveTo(lx0, y + (11 / 38) * h);
      ctx.lineTo(x + w - (8 / 38) * w, y + (11 / 38) * h);
      ctx.moveTo(lx0, y + (18 / 38) * h);
      ctx.lineTo(x + w - (10 / 38) * w, y + (18 / 38) * h);
      ctx.moveTo(lx0, y + (25 / 38) * h);
      ctx.lineTo(x + w - (15 / 38) * w, y + (25 / 38) * h);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export const stickyNoteTool = new StickyNoteTool();
