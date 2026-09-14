/**
 * Collapsible Handwritten Sticky Note Tool.
 * A note card lives on the page as one annotation: paper background +
 * freehand ink + text entries in note-local coords, collapsible into a pin
 * badge at its anchor point.
 */

import {
  Point,
  BoundingBox,
  StickyNoteAnnotation,
  StickyNoteInkStroke,
  PaperStyle
} from '../../core/types';
import { paperGeometry } from '../../io/notebook';
import { renderSmoothStroke } from '../spline';

export const STICKY_DEFAULT_SIZE = { width: 180, height: 140 };
export const STICKY_PIN_RADIUS = 11;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return `rgba(15,23,42,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Paints the paper background clipped to the note box (call within save/clip). */
export function paintNotePaper(
  ctx: CanvasRenderingContext2D,
  paper: PaperStyle,
  w: number,
  h: number
): void {
  ctx.fillStyle = paper.paperColor || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (paper.pattern === 'blank') return;
  const geo = paperGeometry({ ...paper, spacing: Math.min(28, Math.max(14, paper.spacing * 0.7)) }, w, h);
  ctx.strokeStyle = hexToRgba(paper.lineColor || '#c7d2e4', 0.9);
  ctx.fillStyle = hexToRgba(paper.lineColor || '#c7d2e4', 0.9);
  ctx.lineWidth = 0.8;
  for (const l of geo.lines) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  for (const d of geo.dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (geo.marginX !== null) {
    ctx.strokeStyle = hexToRgba('#f0a3a3', 0.8);
    ctx.beginPath();
    ctx.moveTo(geo.marginX, 0);
    ctx.lineTo(geo.marginX, h);
    ctx.stroke();
  }
}

export class StickyNoteTool {
  public createNote(
    anchor: Point,
    pageIndex: number,
    layerId: string,
    paper: PaperStyle,
    width = STICKY_DEFAULT_SIZE.width,
    height = STICKY_DEFAULT_SIZE.height
  ): StickyNoteAnnotation {
    const box: BoundingBox = { x: anchor.x, y: anchor.y, width, height };
    return {
      id: Math.random().toString(36).substring(2, 9),
      pageIndex,
      layerId,
      type: 'sticky-note',
      box,
      anchor: { x: anchor.x, y: anchor.y },
      collapsed: false,
      paper: { ...paper },
      ink: [],
      texts: [],
      opacity: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D, ann: StickyNoteAnnotation, scale: number = 1.0): void {
    if (ann.collapsed) {
      this.renderPin(ctx, ann, scale);
      return;
    }
    ctx.save();
    ctx.scale(scale, scale);
    const b = ann.box;
    // Card shadow + paper (clipped so rules never bleed past rounded corners).
    ctx.save();
    ctx.shadowColor = 'rgba(15,23,42,0.25)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = ann.paper.paperColor || '#ffffff';
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.width, b.height);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.width, b.height);
    ctx.clip();
    ctx.translate(b.x, b.y);
    paintNotePaper(ctx, ann.paper, b.width, b.height);
    // Ink strokes in note-local coords.
    for (const s of ann.ink) {
      if (s.points.length === 0) continue;
      if (s.kind === 'highlighter') {
        this.renderNoteHighlighter(ctx, s);
      } else {
        renderSmoothStroke(ctx, s.points as any, s.color, s.strokeWidth, 'linear', false, false, 'balanced');
      }
    }
    // Text entries.
    for (const t of ann.texts) {
      ctx.fillStyle = t.color;
      ctx.font = `${t.fontSize}px "${t.fontFamily}", sans-serif`;
      ctx.textBaseline = 'top';
      const words = t.text.split(/\s+/);
      let line = '';
      let ly = t.y + 4;
      const maxW = Math.max(20, t.w || b.width - 8);
      for (const word of words) {
        const trial = line ? `${line} ${word}` : word;
        if (ctx.measureText(trial).width > maxW && line) {
          ctx.fillText(line, t.x + 4, ly);
          ly += t.fontSize * 1.3;
          line = word;
        } else {
          line = trial;
        }
      }
      if (line) ctx.fillText(line, t.x + 4, ly);
    }
    ctx.restore();

    // Card border + fold corner.
    ctx.strokeStyle = 'rgba(15,23,42,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.fillStyle = 'rgba(15,23,42,0.08)';
    ctx.beginPath();
    ctx.moveTo(b.x + b.width, b.y);
    ctx.lineTo(b.x + b.width - 14, b.y);
    ctx.lineTo(b.x + b.width, b.y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private renderNoteHighlighter(ctx: CanvasRenderingContext2D, s: StickyNoteInkStroke): void {
    if (s.points.length === 0) return;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  /** Stylish folded-note badge at the anchor point. */
  public renderPin(ctx: CanvasRenderingContext2D, ann: StickyNoteAnnotation, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);
    const { x, y } = ann.anchor;
    const size = 26;
    const half = size / 2;
    const bx = x - half;
    const by = y - half;

    // Soft drop shadow
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    // Rounded rectangle card badge
    const color = ann.paper?.paperColor || '#fef08a';
    ctx.fillStyle = color;
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(bx, by, size, size, 5);
    } else {
      ctx.rect(bx, by, size, size);
    }
    ctx.fill();

    // Reset shadow for crisp inner details
    ctx.shadowColor = 'transparent';

    // Stylish folded corner at top-right
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.beginPath();
    ctx.moveTo(bx + size - 8, by);
    ctx.lineTo(bx + size, by + 8);
    ctx.lineTo(bx + size - 8, by + 8);
    ctx.closePath();
    ctx.fill();

    // Fold highlight edge
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Elegant note lines
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx + 6, by + 9);
    ctx.lineTo(bx + size - 10, by + 9);

    ctx.moveTo(bx + 6, by + 14);
    ctx.lineTo(bx + size - 6, by + 14);

    ctx.moveTo(bx + 6, by + 19);
    ctx.lineTo(bx + size - 11, by + 19);
    ctx.stroke();

    // Outer border
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(bx, by, size, size, 5);
    } else {
      ctx.rect(bx, by, size, size);
    }
    ctx.stroke();

    ctx.restore();
  }

  /** Hit test: badge when collapsed, card box when expanded. */
  public hitTest(pt: Point, ann: StickyNoteAnnotation): boolean {
    const dx = pt.x - ann.anchor.x;
    const dy = pt.y - ann.anchor.y;
    if (Math.hypot(dx, dy) <= 16) {
      return true;
    }
    if (ann.collapsed) {
      return false;
    }
    const b = ann.box;
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  }
}

export const stickyNoteTool = new StickyNoteTool();
