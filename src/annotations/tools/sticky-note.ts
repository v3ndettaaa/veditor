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
import { isPointInBox, traceRoundedPolygon, fillLineRibbon, computeArrowHeadGeometry, drawArrowHead, distance, distanceToSegment } from '../../utils/geometry';
import { renderSmoothStroke, renderLiveStroke } from '../spline';
import { textTool } from './text';
import { stampTool } from './stamp';
import { signatureTool } from './signature';
import { measureTool } from './measure';
import { DEFAULT_APP_FONT, resolveAnnotationFontCss, resolveAnnotationFontFamily } from '../../core/fonts';

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

export interface StickyNoteLayoutMetrics {
  uiScale: number;
  cornerRadius: number;
  headerHeight: number;
  headerDividerInset: number;
  btnCenterX: number;
  btnCenterY: number;
  btnSize: number;
  btnRadius: number;
  btnStrokeWidth: number;
  btnArrowSpan: number;
  btnArrowBarb: number;
  padX: number;
  padTop: number;
  footerReserve: number;
}

/**
 * Computes proportional internal card metrics for any Sticky Note box size.
 * At >= 210x210 page units `uiScale` is 1.0 (preserving exact standard layout);
 * when shrunk smaller, header height, button icon, corner radius, and padding
 * scale smoothly with the card instead of clipping or overflowing.
 */
export function getStickyNoteLayoutMetrics(box: BoundingBox): StickyNoteLayoutMetrics {
  const uiScale = Math.max(
    0.28,
    Math.min(1.0, Math.min((box.width || STICKY_NOTE_DEFAULT_SIZE) / STICKY_NOTE_DEFAULT_SIZE, (box.height || STICKY_NOTE_DEFAULT_SIZE) / STICKY_NOTE_DEFAULT_SIZE))
  );
  const headerHeight = Math.max(11, Math.round(36 * uiScale * 10) / 10);
  const btnSize = Math.max(8, Math.round(22 * uiScale * 10) / 10);
  const btnOffsetRight = Math.max(7, Math.min(box.width * 0.3, 21 * uiScale));
  return {
    uiScale,
    cornerRadius: Math.max(3, STICKY_NOTE_CORNER_RADIUS * uiScale),
    headerHeight,
    headerDividerInset: Math.max(4, 12 * uiScale),
    btnCenterX: box.x + box.width - btnOffsetRight,
    btnCenterY: box.y + headerHeight / 2,
    btnSize,
    btnRadius: Math.max(2, 6 * uiScale),
    btnStrokeWidth: Math.max(0.75, 1.4 * uiScale),
    btnArrowSpan: Math.max(2.0, 5 * uiScale),
    btnArrowBarb: Math.max(1.5, 3.5 * uiScale),
    padX: Math.max(4, 14 * uiScale),
    padTop: headerHeight + Math.max(2.5, 8 * uiScale),
    footerReserve: Math.max(3.5, 12 * uiScale)
  };
}

/**
 * Returns the usable inner content area of an expanded Sticky Note (below its header,
 * above its footer margin, inset symmetrically from left/right card borders).
 */
export function getStickyNoteContentRect(ann: StickyNoteAnnotation): BoundingBox {
  const b = ann.box;
  const m = getStickyNoteLayoutMetrics(b);
  const padX = Math.max(4, Math.min(m.padX * 0.65, b.width * 0.12));
  const top = b.y + m.headerHeight + Math.max(3, 6 * m.uiScale);
  const bottom = b.y + b.height - Math.max(4, m.footerReserve * 0.65);
  return {
    x: b.x + padX,
    y: top,
    width: Math.max(16, b.width - padX * 2),
    height: Math.max(16, bottom - top)
  };
}

/**
 * Resolves the topmost expanded, unlocked Sticky Note targeted by a point hover/click,
 * active inline text edit, or (when `allowSelectedFallback` is true) current selection.
 */
export function findExpandedStickyNoteTarget(
  annotations: Annotation[],
  options?: {
    point?: Point | null;
    selectedIds?: Set<string> | string[] | null;
    editingNoteId?: string | null;
    allowSelectedFallback?: boolean;
  }
): StickyNoteAnnotation | null {
  if (!Array.isArray(annotations) || annotations.length === 0) return null;

  const isEligible = (a: Annotation): a is StickyNoteAnnotation =>
    a.type === 'sticky-note' && !a.collapsed && !a.locked;

  if (options?.editingNoteId) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const cand = annotations[i];
      if (cand.id === options.editingNoteId && isEligible(cand)) {
        return cand;
      }
    }
  }

  if (options?.point) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const cand = annotations[i];
      if (isEligible(cand) && stickyNoteTool.hitTest(cand, options.point)) {
        return cand;
      }
    }
  }

  if (options?.allowSelectedFallback && options?.selectedIds) {
    const selSet = options.selectedIds instanceof Set
      ? options.selectedIds
      : new Set(options.selectedIds);
    if (selSet.size > 0) {
      for (let i = annotations.length - 1; i >= 0; i--) {
        const cand = annotations[i];
        if (selSet.has(cand.id) && isEligible(cand)) {
          return cand;
        }
      }
    }
  }

  return null;
}

/**
 * Pure helper: erases freehand strokes and embedded items inside an expanded Sticky Note
 * with O(1) AABB early-out and full support for 'stroke', 'object', and 'pixel' modes.
 * Returns `{ modified, strokes, items }` so callers only repaint when something actually changed.
 */
export function eraseStickyNoteContent(
  note: StickyNoteAnnotation,
  points: Point[],
  radius: number,
  mode: 'stroke' | 'pixel' | 'object' = 'stroke'
): { modified: boolean; strokes: StickyNoteStroke[]; items: Annotation[] } {
  const origStrokes = note.strokes || [];
  const origItems = note.items || [];
  if (points.length === 0 || (origStrokes.length === 0 && origItems.length === 0)) {
    return { modified: false, strokes: origStrokes, items: origItems };
  }

  const center = { x: note.box.x + note.box.width / 2, y: note.box.y + note.box.height / 2 };
  const rot = note.rotation || 0;
  const localPts = rot ? points.map(p => rotatePointAround(p, center, -rot)) : points;

  // Quick union AABB of all incoming eraser points to skip distant strokes/items in O(1)
  let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
  for (const lp of localPts) {
    if (lp.x < pMinX) pMinX = lp.x;
    if (lp.y < pMinY) pMinY = lp.y;
    if (lp.x > pMaxX) pMaxX = lp.x;
    if (lp.y > pMaxY) pMaxY = lp.y;
  }

  let modified = false;
  let remainingStrokes: StickyNoteStroke[] = origStrokes;

  if (origStrokes.length > 0) {
    const nextStrokes: StickyNoteStroke[] = [];
    for (const stroke of origStrokes) {
      const sPts = stroke.points;
      if (!sPts || sPts.length === 0) continue;
      const pad = (stroke.strokeWidth || 2) / 2;
      const hitRadius = radius + pad;

      // Compute stroke AABB for fast O(1) rejection before checking individual segments
      let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
      for (let i = 0; i < sPts.length; i++) {
        const x = sPts[i].x;
        const y = sPts[i].y;
        if (x < sMinX) sMinX = x;
        if (y < sMinY) sMinY = y;
        if (x > sMaxX) sMaxX = x;
        if (y > sMaxY) sMaxY = y;
      }
      if (
        pMaxX + hitRadius < sMinX ||
        pMinX - hitRadius > sMaxX ||
        pMaxY + hitRadius < sMinY ||
        pMinY - hitRadius > sMaxY
      ) {
        nextStrokes.push(stroke);
        continue;
      }

      if (mode === 'pixel') {
        let hitAny = false;
        const fragments: StrokePoint[][] = [];
        let currentFrag: StrokePoint[] = [];

        for (let i = 0; i < sPts.length; i++) {
          const sp = sPts[i];
          let pointErased = false;
          for (let j = 0; j < localPts.length; j++) {
            if (distance(localPts[j], sp) <= hitRadius) {
              pointErased = true;
              break;
            }
          }
          if (pointErased) {
            hitAny = true;
            if (currentFrag.length >= 2) {
              fragments.push(currentFrag);
            }
            currentFrag = [];
            continue;
          }

          // Only check segment crossing when the previous point survived (avoids
          // falsely erasing the first surviving point after an already-erased vertex).
          if (currentFrag.length > 0 && i > 0) {
            const prev = sPts[i - 1];
            let crossedBy: Point | null = null;
            for (let j = 0; j < localPts.length; j++) {
              if (distanceToSegment(localPts[j], prev, sp) <= hitRadius) {
                crossedBy = localPts[j];
                break;
              }
            }
            if (crossedBy) {
              hitAny = true;
              const dx = sp.x - prev.x;
              const dy = sp.y - prev.y;
              const segLenSq = dx * dx + dy * dy;
              if (segLenSq > 1e-4) {
                // Project eraser center onto segment to split cleanly on both sides of the gap
                const tMid = Math.max(0, Math.min(1, ((crossedBy.x - prev.x) * dx + (crossedBy.y - prev.y) * dy) / segLenSq));
                const segLen = Math.sqrt(segLenSq);
                const dt = hitRadius / segLen;
                const tEnter = tMid - dt;
                const tExit = tMid + dt;
                if (tEnter > 0.02) {
                  currentFrag.push({
                    x: prev.x + dx * tEnter,
                    y: prev.y + dy * tEnter,
                    pressure: prev.pressure + (sp.pressure - prev.pressure) * tEnter
                  });
                }
                if (currentFrag.length >= 2) {
                  fragments.push(currentFrag);
                }
                currentFrag = [];
                if (tExit < 0.98) {
                  currentFrag.push({
                    x: prev.x + dx * tExit,
                    y: prev.y + dy * tExit,
                    pressure: prev.pressure + (sp.pressure - prev.pressure) * tExit
                  });
                }
              } else {
                if (currentFrag.length >= 2) {
                  fragments.push(currentFrag);
                }
                currentFrag = [];
              }
            }
          }

          currentFrag.push(sp);
        }
        if (currentFrag.length >= 2) {
          fragments.push(currentFrag);
        }

        if (hitAny) {
          modified = true;
          for (let f = 0; f < fragments.length; f++) {
            nextStrokes.push({
              ...stroke,
              id: f === 0 ? stroke.id : `${stroke.id}_s${Math.random().toString(36).substring(2, 6)}`,
              points: fragments[f]
            });
          }
        } else {
          nextStrokes.push(stroke);
        }
      } else {
        let hit = false;
        outer: for (let j = 0; j < localPts.length; j++) {
          const lp = localPts[j];
          for (let i = 0; i < sPts.length; i++) {
            if (distance(lp, sPts[i]) <= hitRadius) {
              hit = true;
              break outer;
            }
            if (i > 0 && distanceToSegment(lp, sPts[i - 1], sPts[i]) <= hitRadius) {
              hit = true;
              break outer;
            }
          }
        }
        if (hit) {
          modified = true;
        } else {
          nextStrokes.push(stroke);
        }
      }
    }
    remainingStrokes = nextStrokes;
  }

  let remainingItems: Annotation[] = origItems;
  if (origItems.length > 0) {
    const nextItems: Annotation[] = [];
    for (const item of origItems) {
      const b = item.box;
      const strokePad = Math.max(2, ((item as any).strokeWidth || 2) / 2);
      const margin = radius + strokePad + 4;
      // Fast AABB rejection (skip when item is rotated so rotation math stays exact)
      if (
        !item.rotation &&
        (pMaxX + margin < b.x ||
          pMinX - margin > b.x + b.width ||
          pMaxY + margin < b.y ||
          pMinY - margin > b.y + b.height)
      ) {
        nextItems.push(item);
        continue;
      }

      let hit = false;
      for (let j = 0; j < localPts.length; j++) {
        const lp = localPts[j];
        if (
          item.type === 'line' ||
          item.type === 'arrow' ||
          item.type === 'polygon' ||
          item.type === 'freeform-shape' ||
          item.type === 'measure-distance' ||
          item.type === 'measure-angle' ||
          item.type === 'measure-area'
        ) {
          const pts = (item as any).points && (item as any).points.length >= 2
            ? ((item as any).points as Point[])
            : [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }];
          for (let i = 0; i < pts.length; i++) {
            if (distance(lp, pts[i]) <= radius + strokePad) {
              hit = true;
              break;
            }
            if (i > 0 && distanceToSegment(lp, pts[i - 1], pts[i]) <= radius + strokePad) {
              hit = true;
              break;
            }
          }
          if (!hit && (item.type === 'polygon' || item.type === 'measure-area') && pts.length >= 3) {
            if (distanceToSegment(lp, pts[pts.length - 1], pts[0]) <= radius + strokePad) {
              hit = true;
            }
          }
        } else {
          const itemPt = item.rotation
            ? rotatePointAround(lp, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -item.rotation)
            : lp;
          if (
            itemPt.x >= b.x - radius &&
            itemPt.x <= b.x + b.width + radius &&
            itemPt.y >= b.y - radius &&
            itemPt.y <= b.y + b.height + radius
          ) {
            hit = true;
          }
        }
        if (hit) break;
      }

      if (hit) {
        modified = true;
      } else {
        nextItems.push(item);
      }
    }
    remainingItems = nextItems;
  }

  return { modified, strokes: remainingStrokes, items: remainingItems };
}

/**
 * Hit-tests embedded items (`note.items`) inside an expanded Sticky Note in reverse z-order.
 */
export function hitTestStickyNoteEmbeddedItem(
  note: StickyNoteAnnotation,
  point: Point,
  tolerance: number = 6
): Annotation | null {
  if (note.collapsed || !Array.isArray(note.items) || note.items.length === 0) return null;
  const center = { x: note.box.x + note.box.width / 2, y: note.box.y + note.box.height / 2 };
  const localPt = note.rotation ? rotatePointAround(point, center, -note.rotation) : point;

  for (let i = note.items.length - 1; i >= 0; i--) {
    const item = note.items[i];
    const b = item.box;
    if (
      item.type === 'line' ||
      item.type === 'arrow' ||
      item.type === 'measure-distance' ||
      item.type === 'measure-angle'
    ) {
      const pts = (item as any).points as Point[] | undefined;
      const pad = Math.max(tolerance, ((item as any).strokeWidth || 2) / 2 + 4);
      if (pts && pts.length >= 2) {
        for (let k = 1; k < pts.length; k++) {
          if (distanceToSegment(localPt, pts[k - 1], pts[k]) <= pad) return item;
        }
      }
      continue;
    }
    const itemPt = item.rotation
      ? rotatePointAround(localPt, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -item.rotation)
      : localPt;
    if (
      itemPt.x >= b.x - tolerance &&
      itemPt.x <= b.x + b.width + tolerance &&
      itemPt.y >= b.y - tolerance &&
      itemPt.y <= b.y + b.height + tolerance
    ) {
      return item;
    }
  }
  return null;
}

/**
 * Computes a zoom-aware Sticky Note bounding box placed cleanly inside the user's
 * visible page region (so zoomed-in views never spawn oversized or off-screen notes).
 */
export function computeViewportStickyNoteBox(
  pageWidth: number,
  pageHeight: number,
  zoom: number,
  visibleRect?: { left: number; top: number; right: number; bottom: number } | null,
  anchorPoint?: Point | null
): { box: BoundingBox; uiScale: number } {
  const safeZoom = Math.max(0.15, Number.isFinite(zoom) ? zoom : 1);
  const safePageW = pageWidth > 0 ? pageWidth : 612;
  const safePageH = pageHeight > 0 ? pageHeight : 792;

  const visL = visibleRect ? Math.max(0, Math.min(safePageW, visibleRect.left)) : 0;
  const visT = visibleRect ? Math.max(0, Math.min(safePageH, visibleRect.top)) : 0;
  const visR = visibleRect ? Math.max(visL + 10, Math.min(safePageW, visibleRect.right)) : safePageW;
  const visB = visibleRect ? Math.max(visT + 10, Math.min(safePageH, visibleRect.bottom)) : safePageH;

  const visW = Math.max(20, visR - visL);
  const visH = Math.max(20, visB - visT);

  // Target ~210-235px card in screen CSS pixels, capped cleanly inside the visible region
  const desiredScreenW = Math.min(235, Math.max(140, visW * safeZoom * 0.42));
  const desiredScreenH = Math.min(220, Math.max(125, visH * safeZoom * 0.40));

  let cardW = desiredScreenW / safeZoom;
  let cardH = desiredScreenH / safeZoom;

  const maxW = Math.max(56, Math.min(safePageW * 0.88, visW * 0.88));
  const maxH = Math.max(46, Math.min(safePageH * 0.88, visH * 0.88));
  const fit = Math.min(1, maxW / cardW, maxH / cardH);
  cardW = Math.max(56, Math.min(safePageW - 8, cardW * fit));
  cardH = Math.max(46, Math.min(safePageH - 8, cardH * fit));

  const targetCx = anchorPoint ? anchorPoint.x : (visL + visR) / 2;
  const targetCy = anchorPoint ? anchorPoint.y : (visT + visB) / 2;

  const margin = Math.min(8, visW * 0.05, visH * 0.05);
  const minX = Math.max(4, visL + margin);
  const maxX = Math.max(minX, Math.min(safePageW - 4 - cardW, visR - margin - cardW));
  const minY = Math.max(4, visT + margin);
  const maxY = Math.max(minY, Math.min(safePageH - 4 - cardH, visB - margin - cardH));

  const x = Math.max(minX, Math.min(maxX, targetCx - cardW / 2));
  const y = Math.max(minY, Math.min(maxY, targetCy - cardH / 2));

  const box: BoundingBox = {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    width: Math.round(cardW * 100) / 100,
    height: Math.round(cardH * 100) / 100
  };
  return { box, uiScale: getStickyNoteLayoutMetrics(box).uiScale };
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
  allowCompact?: boolean;
}

export class StickyNoteTool {
  private _active: boolean = false;
  private _pageIndex: number = 0;
  private _startPoint: Point | null = null;
  private _currentPoint: Point | null = null;
  private _color: string = '#fef08a';
  private _textColor: string = '#3b2f1e';
  private _fontSize: number = 15;
  private _fontFamily: string = DEFAULT_APP_FONT;
  private _author: string = '';
  private _editingEmbeddedItemId: string | null = null;

  public setEditingEmbeddedItemId(id: string | null): void {
    this._editingEmbeddedItemId = id;
  }

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

    const minW = opts.allowCompact ? 56 : STICKY_NOTE_MIN_WIDTH;
    const minH = opts.allowCompact ? 46 : STICKY_NOTE_MIN_HEIGHT;
    const normalizedBox: BoundingBox = {
      x: rawBox.x,
      y: rawBox.y,
      width: Math.max(minW, rawBox.width || STICKY_NOTE_DEFAULT_SIZE),
      height: Math.max(minH, rawBox.height || STICKY_NOTE_DEFAULT_SIZE),
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
      fontFamily: resolveAnnotationFontFamily(opts.fontFamily),
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
    const m = getStickyNoteLayoutMetrics(ann.box);
    const halfHit = Math.max(5.5, m.btnSize * 0.72);
    return (
      local.x >= m.btnCenterX - halfHit &&
      local.x <= m.btnCenterX + halfHit &&
      local.y >= m.btnCenterY - halfHit &&
      local.y <= m.btnCenterY + halfHit
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
    const m = getStickyNoteLayoutMetrics(b);
    const sideInset = Math.max(2, 6 * m.uiScale);
    const bottomInset = Math.max(2, 8 * m.uiScale);
    return (
      local.x >= b.x + sideInset &&
      local.x <= b.x + b.width - sideInset &&
      local.y >= b.y + m.headerHeight &&
      local.y <= b.y + b.height - bottomInset
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
    const m = getStickyNoteLayoutMetrics(b);
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
      Math.max(2, m.cornerRadius - 1.5)
    );
    ctx.clip();
    ctx.scale(1 / scale, 1 / scale);
    drawFn();
    ctx.restore();
  }

  /**
   * Applies the sticky note's rounded card clip path directly in page coordinates
   * (for StreamingInkRenderer / StreamingHighlighterRenderer `clipCallback`).
   */
  public applyNoteClipPath(ctx: CanvasRenderingContext2D, ann: StickyNoteAnnotation): void {
    const b = ann.box;
    const m = getStickyNoteLayoutMetrics(b);
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
      Math.max(2, m.cornerRadius - 1.5)
    );
    ctx.clip();
  }

  public start(
    point: Point,
    pageIndex: number,
    color: string = '#fef08a',
    textColor: string = '#3b2f1e',
    fontSize: number = 15,
    fontFamily: string = DEFAULT_APP_FONT,
    author: string = ''
  ): void {
    this._active = true;
    this._pageIndex = pageIndex;
    this._startPoint = { ...point };
    this._currentPoint = { ...point };
    this._color = color || '#fef08a';
    this._textColor = textColor || '#3b2f1e';
    this._fontSize = fontSize || 15;
    this._fontFamily = resolveAnnotationFontFamily(fontFamily);
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
    const m = getStickyNoteLayoutMetrics(b);
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
      Math.max(2, m.cornerRadius - 1.5)
    );
    ctx.clip();
    ctx.globalAlpha = isHighlighter ? 1.0 : opacity;
    const mappedSmoothing: 'none' | 'subtle' | 'medium' | 'high' =
      smoothing === 'light' ? 'subtle' : smoothing === 'heavy' ? 'high' : smoothing;
    if (!isHighlighter) {
      renderLiveStroke(
        ctx,
        points,
        color || ann.textColor || '#3b2f1e',
        strokeWidth || 2,
        pressureCurve,
        pressureEnabled,
        pressureStrength,
        mappedSmoothing
      );
    } else {
      renderSmoothStroke(
        ctx,
        points,
        color || ann.textColor || '#3b2f1e',
        strokeWidth || 2,
        pressureCurve,
        true,
        false,
        pressureStrength,
        tipShape,
        mappedSmoothing
      );
    }
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
      fontFamily: DEFAULT_APP_FONT,
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
    const m = getStickyNoteLayoutMetrics(b);
    const r = m.cornerRadius;

    // 1. Card elevation shadow & warm paper fill
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.20)';
    ctx.shadowBlur = 12 * m.uiScale;
    ctx.shadowOffsetY = 4 * m.uiScale;
    drawRoundedRectPath(ctx, b.x, b.y, b.width, b.height, r);
    ctx.fillStyle = ann.color || '#fef08a';
    ctx.fill();
    ctx.restore();

    // 2. Subtle card border
    drawRoundedRectPath(ctx, b.x, b.y, b.width, b.height, r);
    ctx.strokeStyle = 'rgba(59, 47, 30, 0.26)';
    ctx.lineWidth = Math.max(0.75, 1.1 * m.uiScale);
    ctx.stroke();

    // 3. Header bar separator line (scales proportionally with card dimensions)
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 47, 30, 0.14)';
    ctx.lineWidth = Math.max(0.65, m.uiScale);
    ctx.beginPath();
    ctx.moveTo(b.x + m.headerDividerInset, b.y + m.headerHeight);
    ctx.lineTo(b.x + b.width - m.headerDividerInset, b.y + m.headerHeight);
    ctx.stroke();
    ctx.restore();

    // 4. Clipped interior for typography, freehand strokes (pen & highlighter), and embedded items (shapes & text)
    ctx.save();
    drawRoundedRectPath(ctx, b.x + 1.5, b.y + 1.5, b.width - 3, b.height - 3, Math.max(2, r - 1.5));
    ctx.clip();

    const hasStrokes = Array.isArray(ann.strokes) && ann.strokes.length > 0;
    const hasItems = Array.isArray(ann.items) && ann.items.length > 0;
    const rawText = (ann.text || '').trim();
    const padX = m.padX;
    const padTop = m.padTop;
    const footerReserve = m.footerReserve;
    const availW = Math.max(12, b.width - padX * 2);
    const availH = Math.max(10, b.height - padTop - footerReserve);

    if (!isEditingText) {
      if (rawText.length > 0) {
        const fontSize = Math.max(5, ann.fontSize || 15);
        const weight = ann.fontWeight === 'bold' || Number(ann.fontWeight) >= 600 ? 'bold' : 'normal';
        const style = ann.fontStyle === 'italic' ? 'italic' : 'normal';
        const familyCss = resolveAnnotationFontCss(ann.fontFamily);
        ctx.font = `${style} ${weight} ${fontSize}px ${familyCss}`;
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
              mappedSm,
              !isHl && stroke.preSmoothed === true
            );
            ctx.restore();
          }
        } else {
          if (this._editingEmbeddedItemId && entry.item.id === this._editingEmbeddedItemId) {
            continue;
          }
          this.renderEmbeddedItem(ctx, entry.item);
        }
      }
    }

    ctx.restore();

    // 6. Top-right collapse button icon scaled proportionally to card header
    ctx.save();
    const btnCx = m.btnCenterX;
    const btnCy = m.btnCenterY;
    const halfBtn = m.btnSize / 2;
    const span = m.btnArrowSpan;
    const arm = Math.max(0.6, span - m.btnArrowBarb);
    const gap = Math.max(0.5, 1 * m.uiScale);
    ctx.fillStyle = 'rgba(59, 47, 30, 0.08)';
    drawRoundedRectPath(ctx, btnCx - halfBtn, btnCy - halfBtn, m.btnSize, m.btnSize, m.btnRadius);
    ctx.fill();

    ctx.strokeStyle = ann.textColor || '#3b2f1e';
    ctx.globalAlpha = (ann.opacity ?? 1) * 0.72;
    ctx.lineWidth = m.btnStrokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(btnCx + span, btnCy - span);
    ctx.lineTo(btnCx + gap, btnCy - gap);
    ctx.moveTo(btnCx + gap, btnCy - (span - arm * 0.25));
    ctx.lineTo(btnCx + gap, btnCy - gap);
    ctx.lineTo(btnCx + (span - arm * 0.25), btnCy - gap);
    ctx.moveTo(btnCx - span, btnCy + span);
    ctx.lineTo(btnCx - gap, btnCy + gap);
    ctx.moveTo(btnCx - gap, btnCy + (span - arm * 0.25));
    ctx.lineTo(btnCx - gap, btnCy + gap);
    ctx.lineTo(btnCx - (span - arm * 0.25), btnCy + gap);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  /**
   * Renders an embedded annotation (image/stamp, signature, shape, text, ink, or measurement)
   * inside a Sticky Note card's clipped coordinate space.
   */
  private renderEmbeddedItem(ctx: CanvasRenderingContext2D, item: Annotation): void {
    ctx.save();
    ctx.globalAlpha = item.opacity ?? 1.0;
    const itemRot = item.rotation || 0;
    if (itemRot) {
      const cx = item.box.x + item.box.width / 2;
      const cy = item.box.y + item.box.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(itemRot);
      ctx.translate(-cx, -cy);
    }
    if (item.type === 'text') {
      textTool.renderToCanvas(ctx, item, 1);
      ctx.restore();
      return;
    }
    if (item.type === 'stamp') {
      stampTool.renderToCanvas(ctx, item, 1);
      ctx.restore();
      return;
    }
    if (item.type === 'signature') {
      signatureTool.renderToCanvas(ctx, item, 1);
      ctx.restore();
      return;
    }
    if (
      item.type === 'measure-distance' ||
      item.type === 'measure-angle' ||
      item.type === 'measure-area'
    ) {
      measureTool.renderToCanvas(ctx, item, 1);
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
        item.strokeSmoothing || 'medium',
        item.preSmoothed === true
      );
      ctx.restore();
      return;
    }
    if (item.type === 'highlighter') {
      if (item.quadPoints && item.quadPoints.length > 0) {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        for (const quad of item.quadPoints) {
          const cx = quad.reduce((sum, p) => sum + p.x, 0) / quad.length;
          const cy = quad.reduce((sum, p) => sum + p.y, 0) / quad.length;
          const ordered = [...quad].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
          ordered.forEach((p, index) => {
            const x = item.box.x + p.x * item.box.width;
            const y = item.box.y + p.y * item.box.height;
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fill();
      } else {
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
      }
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
        const isArrow = sh.type === 'arrow';
        const arrowGeom = isArrow
          ? computeArrowHeadGeometry(pts[pts.length - 2], pts[pts.length - 1], w)
          : null;
        if (sh.strokeStyle === 'dashed' || sh.strokeStyle === 'dotted') {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            const endPt = isArrow && i === pts.length - 1 && arrowGeom ? arrowGeom.shaftEnd : pts[i];
            ctx.lineTo(endPt.x, endPt.y);
          }
          ctx.stroke();
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            const endPt = isArrow && i === pts.length - 2 && arrowGeom ? arrowGeom.shaftEnd : pts[i + 1];
            fillLineRibbon(ctx, pts[i].x, pts[i].y, endPt.x, endPt.y, w);
          }
        }
        if (isArrow) {
          drawArrowHead(ctx, pts[pts.length - 2], pts[pts.length - 1], w, sh.strokeColor);
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
