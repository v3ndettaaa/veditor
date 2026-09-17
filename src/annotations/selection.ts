/**
 * Selection, Transformation & Alignment Engine
 * Provides 8-handle transform box, rotation handle, marquee selection, and alignment utilities.
 */

import { Point, BoundingBox, Annotation } from '../core/types';
import { isPointInBox, isPointInPolygon, distance, distanceToSegment, polygonArea, mergeBoundingBoxes, boxesIntersect, computePointsBoundingBox } from '../utils/geometry';

/**
 * Rotates point `p` around `center` by `angle` radians (counter-clockwise in
 * screen coords where +y points down, matching canvas `rotate()`).
 * Pure, unit-tested.
 */
export function rotatePoint(p: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

/** Box center helper. */
export function boxCenter(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Normalizes two drag corners into a positive-size box. Pure, unit-tested. */
export function normalizeDragBox(a: Point, b: Point, minSize = 4): BoundingBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(minSize, Math.abs(b.x - a.x)),
    height: Math.max(minSize, Math.abs(b.y - a.y))
  };
}

/** Plain-data deep clone for pre-drag snapshots (annotations hold no functions). */
export function cloneAnnotation<T extends Annotation>(ann: T): T {
  return JSON.parse(JSON.stringify(ann)) as T;
}

/** Deep clone an annotation, then translate its page-space geometry. */
export function offsetAnnotation<T extends Annotation>(ann: T, dx: number, dy: number): T {
  const next = cloneAnnotation(ann);
  const shift = <P extends Point>(p: P): P => ({ ...p, x: p.x + dx, y: p.y + dy });
  next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };

  const value = next as any;
  if (Array.isArray(value.points) && value.points.length > 0) {
    value.points = Array.isArray(value.points[0])
      ? value.points.map((stroke: Point[]) => stroke.map(shift))
      : value.points.map(shift);
  }
  if (value.arrowPoint) value.arrowPoint = shift(value.arrowPoint);
  if (value.knee) value.knee = shift(value.knee);
  if (value.anchor) value.anchor = shift(value.anchor);
  return next;
}

/**
 * Reorders annotations without changing their payloads. Later array entries
 * paint above earlier entries and hit-test first.
 */
export function moveAnnotationsInZOrder<T extends Annotation>(
  annotations: T[],
  ids: string[],
  position: 'front' | 'back'
): T[] {
  const selectedIds = new Set(ids);
  const selected = annotations.filter(ann => selectedIds.has(ann.id));
  const rest = annotations.filter(ann => !selectedIds.has(ann.id));
  return position === 'front' ? [...rest, ...selected] : [...selected, ...rest];
}

/**
 * Returns the selection box for an annotation: its bounding box, which enables
 * universal 8-handle resizing and rotation. Geometry-bearing annotations use
 * the AABB of their actual points (padded by half the stroke so handles sit
 * on the visible ink edge); the stored box may lag behind live drags, and a
 * stale-tight box made the selection frame clip the object.
 */
export function getAnnotationSelectionBox(ann: Annotation): BoundingBox {
  const value = ann as any;
  const points: Point[] | undefined = Array.isArray(value.points) && value.points.length > 0 && !Array.isArray(value.points[0])
    ? value.points
    : undefined;
  if (points && (ann.type === 'polygon' || ann.type === 'freeform-shape' || ann.type === 'line' || ann.type === 'arrow' ||
    ann.type === 'pen' || ann.type === 'highlighter' || ann.type.startsWith('measure-'))) {
    const pad = typeof value.strokeWidth === 'number' ? Math.max(0, value.strokeWidth) / 2 : 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      return {
        x: minX - pad,
        y: minY - pad,
        width: Math.max(1, maxX - minX + pad * 2),
        height: Math.max(1, maxY - minY + pad * 2)
      };
    }
  }
  if (ann.type === 'pen' || ann.type === 'highlighter' || ann.type.startsWith('measure-') || ann.type === 'signature') {
    return mergeStrokeBox(ann);
  }
  return ann.box;
}

function mergeStrokeBox(ann: Annotation): BoundingBox {
  const paths: Point[][] = [];
  const value = ann as any;
  if (Array.isArray(value.points)) {
    if (Array.isArray(value.points[0])) paths.push(...value.points);
    else paths.push(value.points);
  }
  if (ann.type === 'signature') {
    if (typeof value.pngDataUrl === 'string' && value.pngDataUrl.length > 0) return ann.box;
    if (Array.isArray(value.points) && value.points.length > 0 && Array.isArray(value.points[0])) {
      paths.push(...value.points);
    }
  }
  if (paths.length === 0) return ann.box;
  return mergeBoundingBoxes(paths.map(computePointsBoundingBox));
}

export interface BoxTransform {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  originX: number;
  originY: number;
}

/**
 * Applies a merged-box-relative transform to one annotation: box corners and
 * every point array move together; stroke widths and font sizes scale by the
 * mean axis scale. Pure, unit-tested.
 */
export function transformAnnotation<T extends Annotation>(ann: T, t: BoxTransform): T {
  const mapPt = <P extends Point>(p: P): P => ({
    ...p,
    x: t.originX + (p.x - t.originX) * t.scaleX + t.dx,
    y: t.originY + (p.y - t.originY) * t.scaleY + t.dy
  });
  const meanScale = (Math.abs(t.scaleX) + Math.abs(t.scaleY)) / 2 || 1;

  const next: any = { ...ann, box: undefined, updatedAt: Date.now() };
  const b = ann.box;
  const c1 = mapPt({ x: b.x, y: b.y });
  const c2 = mapPt({ x: b.x + b.width, y: b.y + b.height });
  next.box = {
    x: Math.min(c1.x, c2.x),
    y: Math.min(c1.y, c2.y),
    width: Math.abs(c2.x - c1.x),
    height: Math.abs(c2.y - c1.y),
    ...(b.rotation !== undefined ? { rotation: b.rotation } : {})
  };

  const a: any = ann;
  if (Array.isArray(a.points) && (ann.type === 'pen' || ann.type === 'highlighter' ||
      ann.type === 'measure-distance' || ann.type === 'measure-angle' || ann.type === 'measure-area')) {
    next.points = a.points.map(mapPt);
  } else if (Array.isArray(a.points) && (ann.type === 'rectangle' || ann.type === 'ellipse' ||
      ann.type === 'line' || ann.type === 'arrow' || ann.type === 'polygon' || ann.type === 'freeform-shape')) {
    next.points = a.points ? a.points.map(mapPt) : a.points;
  } else if (ann.type === 'signature' && Array.isArray(a.points)) {
    next.points = a.points.map((stroke: Point[]) => stroke.map(mapPt));
  } else if (a.points !== undefined) {
    next.points = a.points;
  }
  if ('strokeWidth' in a && typeof a.strokeWidth === 'number') {
    next.strokeWidth = Math.max(0.5, a.strokeWidth * meanScale);
  }
  if (ann.type === 'text' && typeof a.fontSize === 'number') {
    next.fontSize = Math.max(4, a.fontSize * meanScale);
  }
  return next as T;
}

export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot' | 'body' | null;

export class SelectionManager {
  private _handleSize = 8;
  private _rotHandleDistance = 24;

  /**
   * Hit tests a point against the active selection's bounding box and handles.
   * When the selection is rotated, the point is mapped into the unrotated
   * frame first so handles stay grabbable at any angle.
   */
  public hitTestHandles(point: Point, box: BoundingBox, scale: number = 1.0, rotation: number = 0): HandleType {
    const local = rotation ? rotatePoint(point, boxCenter(box), -rotation) : point;
    // Scale handle size adaptively: on small boxes scale down from 8px to 5px so handles stay proportional
    const minDim = Math.min(box.width, box.height) * scale;
    const baseHs = Math.max(5, Math.min(this._handleSize, minDim / 4));
    const hs = baseHs / scale;
    const rotDist = this._rotHandleDistance;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    let bestHandle: HandleType | null = null;
    // Generous grab zones: handles draw only a few CSS pixels wide on HiDPI
    // screens, so the hit area must be meaningfully larger than the visual.
    let bestDist = hs * 2.4;

    // Rotation handle (tested in the unrotated frame like everything else)
    const rotPt: Point = { x: cx, y: box.y - rotDist };
    const dRot = distance(local, rotPt);
    if (dRot <= hs * 2.2) {
      bestHandle = 'rot';
      bestDist = dRot;
    }

    // Corner handles (always active)
    const handles: Record<string, Point> = {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      se: { x: box.x + box.width, y: box.y + box.height },
      sw: { x: box.x, y: box.y + box.height }
    };

    // Midpoint edge handles only if the box is wide and tall enough to prevent crowding
    const isCompact = box.width < 36 || box.height < 36;
    if (!isCompact) {
      handles.n = { x: cx, y: box.y };
      handles.e = { x: box.x + box.width, y: cy };
      handles.s = { x: cx, y: box.y + box.height };
      handles.w = { x: box.x, y: cy };
    }

    for (const [key, pt] of Object.entries(handles)) {
      const d = distance(local, pt);
      if (d <= hs * 2.0 && d < bestDist) {
        bestDist = d;
        bestHandle = key as HandleType;
      }
    }

    if (bestHandle) {
      return bestHandle;
    }

    if (isPointInBox(local, box)) {
      return 'body';
    }

    return null;
  }

  /**
   * Finds an annotation hit by a point.
   */
  public findAnnotationAtPoint(point: Point, annotations: Annotation[]): Annotation | null {
    // Reverse loop to check topmost annotations first
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      if (ann.locked) continue;
      // Rotated annotations hit-test in their unrotated frame.
      const local = ann.rotation ? rotatePoint(point, boxCenter(ann.box), -ann.rotation) : point;
      if (isPointInBox(local, ann.box)) {
        return ann;
      }
    }
    return null;
  }

  /**
   * All unlocked annotations whose box intersects the marquee rect.
   */
  public findAnnotationsInRect(rect: BoundingBox, annotations: Annotation[]): Annotation[] {
    const norm = normalizeDragBox(
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      0
    );
    return annotations.filter(a => !a.locked && boxesIntersect(norm, a.box));
  }

  /**
   * Freehand lasso selection: all unlocked annotations intersecting an
   * arbitrary closed loop (page units). Stroke-like annotations hit on ink
   * (vertices inside the loop or within half stroke width of its edges);
   * box-like annotations hit on corners/edges like the rect marquee.
   * Degenerate loops (<3 points or tiny area) return [] — callers fall back
   * to click/clear behavior.
   */
  public findAnnotationsInPolygon(poly: Point[], annotations: Annotation[], strokePad = 0): Annotation[] {
    if (poly.length < 3 || polygonArea(poly) < 25) return [];
    const lassoBox = mergeBoundingBoxes(poly.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })));
    const hits: Annotation[] = [];
    for (const ann of annotations) {
      if (ann.locked) continue;
      if (!boxesIntersect(lassoBox, ann.box)) continue;
      // Test in the annotation's unrotated frame (boxes stay unrotated).
      const center = boxCenter(ann.box);
      const rot = ann.rotation || 0;
      const local: Point[] = rot ? poly.map(p => rotatePoint(p, center, -rot)) : poly;
      if (this.annotationIntersectsPolygon(ann, local, strokePad)) hits.push(ann);
    }
    return hits;
  }

  private annotationIntersectsPolygon(ann: Annotation, poly: Point[], strokePad: number): boolean {
    const corners = [
      { x: ann.box.x, y: ann.box.y },
      { x: ann.box.x + ann.box.width, y: ann.box.y },
      { x: ann.box.x + ann.box.width, y: ann.box.y + ann.box.height },
      { x: ann.box.x, y: ann.box.y + ann.box.height }
    ];
    const boxHitsPoly = corners.some(c => isPointInPolygon(c, poly));
    const polyHitsBox = poly.some(p => isPointInBox(p, ann.box));
    const edgesCross = this.loopEdgesCrossBox(poly, ann.box);
    if (boxHitsPoly || polyHitsBox || edgesCross) {
      // Box-like annotations are decided by box overlap alone.
      if (ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'text' ||
          ann.type === 'stamp' || ann.type === 'redaction' ||
          ann.type === 'signature') {
        return true;
      }
    }
    // Stroke-like annotations: require ink contact, not just box overlap.
    const paths = this.annotationPaths(ann);
    if (paths.length === 0) return boxHitsPoly || polyHitsBox || edgesCross;
    const pad = (ann as any).strokeWidth ? (ann as any).strokeWidth / 2 + strokePad : strokePad;
    for (const path of paths) {
      for (const pt of path) {
        if (isPointInPolygon(pt, poly)) return true;
      }
      for (let i = 0; i + 1 < path.length; i++) {
        if (this.segmentNearLoop(path[i], path[i + 1], poly, pad)) return true;
      }
    }
    return false;
  }

  /** Point arrays of stroke-like annotations (unrotated frame). */
  private annotationPaths(ann: Annotation): Point[][] {
    switch (ann.type) {
      case 'pen':
      case 'highlighter':
        return [(ann as any).points as Point[]];
      case 'measure-distance':
      case 'measure-angle':
      case 'measure-area':
      case 'line':
      case 'arrow':
      case 'polygon':
      case 'freeform-shape':
        return (ann as any).points ? [(ann as any).points as Point[]] : [];
      case 'signature':
        return ((ann as any).points as Point[][]) || [];
      default:
        return [];
    }
  }

  /** True when segment ab is within pad of any lasso edge (or crosses one). */
  private segmentNearLoop(a: Point, b: Point, poly: Point[], pad: number): boolean {
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i];
      const d = poly[(i + 1) % poly.length];
      if (this.segmentsCross(a, b, c, d)) return true;
      if (pad > 0 && (distanceToSegment(a, c, d) <= pad || distanceToSegment(b, c, d) <= pad)) return true;
    }
    return false;
  }

  private loopEdgesCrossBox(poly: Point[], box: BoundingBox): boolean {
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      for (let j = 0; j < poly.length; j++) {
        if (this.segmentsCross(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
      }
    }
    return false;
  }

  private segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
    const dir = (p: Point, q: Point, r: Point) =>
      (r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x);
    const d1 = dir(c, d, a);
    const d2 = dir(c, d, b);
    const d3 = dir(a, b, c);
    const d4 = dir(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  /**
   * Renders the merged selection box for the given annotations.
   */
  public render(ctx: CanvasRenderingContext2D, annotations: Annotation[], scale: number = 1.0): void {
    if (annotations.length === 0) return;
    // A lone rotated annotation gets a rotated box; groups use the merged
    // axis-aligned box.
    const rotation = annotations.length === 1 ? annotations[0].rotation || 0 : 0;
    this.renderSelectionBox(
      ctx,
      mergeBoundingBoxes(annotations.map(getAnnotationSelectionBox)),
      scale,
      rotation
    );
  }

  /**
   * Renders selection bounding box, handles, rotation pin, and dimension badge on canvas.
   */
  public renderSelectionBox(
    ctx: CanvasRenderingContext2D,
    box: BoundingBox,
    scale: number = 1.0,
    rotation: number = 0,
    isIconOnly: boolean = false
  ): void {
    ctx.save();
    ctx.scale(scale, scale);
    if (rotation) {
      const c = boxCenter(box);
      ctx.translate(c.x, c.y);
      ctx.rotate(rotation);
      ctx.translate(-c.x, -c.y);
    }

    const minDim = Math.min(box.width, box.height);
    const hs = Math.max(5, Math.min(this._handleSize, minDim / 4));
    const rotDist = this._rotHandleDistance;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const isCompact = box.width < 36 || box.height < 36;

    // Elegant modern selection border with rounded corners
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(box.x, box.y, box.width, box.height, 4);
    } else {
      ctx.rect(box.x, box.y, box.width, box.height);
    }
    ctx.stroke();

    if (isIconOnly) {
      // Icon-only selection: clean border without cluttering resize handles.
      ctx.restore();
      return;
    }

    // Modern floating dimension badge below box (only when large enough to prevent clutter)
    if (!isCompact && box.width >= 36 && box.height >= 36) {
      const dimText = rotation
        ? `${Math.round(box.width)} × ${Math.round(box.height)} • ${Math.round((rotation * 180) / Math.PI)}°`
        : `${Math.round(box.width)} × ${Math.round(box.height)}`;
      ctx.save();
      ctx.font = '10px Inter, -apple-system, sans-serif';
      const tw = ctx.measureText(dimText).width;
      const pw = tw + 12;
      const ph = 18;
      const px = cx - pw / 2;
      const py = box.y + box.height + 6;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.beginPath();
      if ((ctx as any).roundRect) {
        (ctx as any).roundRect(px, py, pw, ph, 4);
      } else {
        ctx.rect(px, py, pw, ph);
      }
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dimText, cx, py + ph / 2);
      ctx.restore();
    }

    // Rotation stem line & pivot handle
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.moveTo(cx, box.y);
    ctx.lineTo(cx, box.y - rotDist);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, box.y - rotDist, (hs + 1) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Small pivot center dot
    ctx.fillStyle = '#4f46e5';
    ctx.beginPath();
    ctx.arc(cx, box.y - rotDist, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Corner handles (always present)
    const handles = [
      { x: box.x, y: box.y, cursor: 'nwse-resize' },
      { x: box.x + box.width, y: box.y, cursor: 'nesw-resize' },
      { x: box.x + box.width, y: box.y + box.height, cursor: 'nwse-resize' },
      { x: box.x, y: box.y + box.height, cursor: 'nesw-resize' }
    ];

    // Midpoint edge handles only if large enough to avoid collision
    if (!isCompact) {
      handles.push(
        { x: cx, y: box.y, cursor: 'ns-resize' },
        { x: box.x + box.width, y: cy, cursor: 'ew-resize' },
        { x: cx, y: box.y + box.height, cursor: 'ns-resize' },
        { x: box.x, y: cy, cursor: 'ew-resize' }
      );
    }

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.2)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;

    for (const h of handles) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      if ((ctx as any).roundRect) {
        (ctx as any).roundRect(h.x - hs / 2, h.y - hs / 2, hs, hs, 2);
      } else {
        ctx.rect(h.x - hs / 2, h.y - hs / 2, hs, hs);
      }
      ctx.fill();

      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();

    ctx.restore();
  }

  /**
   * Alignment functions for multi-selected annotations.
   */
  public alignAnnotations(
    annotations: Annotation[],
    type: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
  ): Annotation[] {
    if (annotations.length < 2) return annotations;
    const merged = mergeBoundingBoxes(annotations.map(a => a.box));

    return annotations.map(a => {
      const b = { ...a.box };
      if (type === 'left') b.x = merged.x;
      else if (type === 'center') b.x = merged.x + (merged.width - b.width) / 2;
      else if (type === 'right') b.x = merged.x + merged.width - b.width;
      else if (type === 'top') b.y = merged.y;
      else if (type === 'middle') b.y = merged.y + (merged.height - b.height) / 2;
      else if (type === 'bottom') b.y = merged.y + merged.height - b.height;
      return { ...a, box: b, updatedAt: Date.now() };
    });
  }

  public distributeAnnotations(annotations: Annotation[], direction: 'horizontal' | 'vertical'): Annotation[] {
    if (annotations.length < 3) return annotations;

    const sorted = [...annotations].sort((a, b) => {
      return direction === 'horizontal' ? a.box.x - b.box.x : a.box.y - b.box.y;
    });

    const first = sorted[0].box;
    const last = sorted[sorted.length - 1].box;

    if (direction === 'horizontal') {
      const totalSpan = last.x + last.width - first.x;
      const totalElementsWidth = sorted.reduce((sum, a) => sum + a.box.width, 0);
      const gap = (totalSpan - totalElementsWidth) / (sorted.length - 1);

      let curX = first.x;
      return sorted.map((a, i) => {
        if (i === 0) {
          curX += a.box.width + gap;
          return a;
        }
        const updated = { ...a, box: { ...a.box, x: curX }, updatedAt: Date.now() };
        curX += a.box.width + gap;
        return updated;
      });
    } else {
      const totalSpan = last.y + last.height - first.y;
      const totalElementsHeight = sorted.reduce((sum, a) => sum + a.box.height, 0);
      const gap = (totalSpan - totalElementsHeight) / (sorted.length - 1);

      let curY = first.y;
      return sorted.map((a, i) => {
        if (i === 0) {
          curY += a.box.height + gap;
          return a;
        }
        const updated = { ...a, box: { ...a.box, y: curY }, updatedAt: Date.now() };
        curY += a.box.height + gap;
        return updated;
      });
    }
  }
}

export const selectionManager = new SelectionManager();
