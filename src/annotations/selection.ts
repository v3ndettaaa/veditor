/**
 * Selection, Transformation & Alignment Engine
 * Provides 8-handle transform box, rotation handle, marquee selection, and alignment utilities.
 */

import { Point, BoundingBox, Annotation } from '../core/types';
import { isPointInBox, distance, mergeBoundingBoxes, boxesIntersect } from '../utils/geometry';

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
  if (ann.type === 'callout') {
    next.arrowPoint = mapPt(a.arrowPoint);
  }
  if ('strokeWidth' in a && typeof a.strokeWidth === 'number') {
    next.strokeWidth = Math.max(0.5, a.strokeWidth * meanScale);
  }
  if ((ann.type === 'text' || ann.type === 'callout') && typeof a.fontSize === 'number') {
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
    // hs stays screen-constant (page units / scale), but the pin OFFSET must
    // be raw page units: renderSelectionBox draws it at box.y - 24 unscaled,
    // so dividing here moved the hit zone away from the visible pin at any
    // zoom other than 100% and the pin could never be grabbed.
    const hs = this._handleSize / scale;
    const rotDist = this._rotHandleDistance;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Rotation handle (tested in the unrotated frame like everything else)
    const rotPt: Point = { x: cx, y: box.y - rotDist };
    if (distance(local, rotPt) <= hs * 1.5) {
      return 'rot';
    }

    // 8 Corner & Edge Handles
    const handles: Record<string, Point> = {
      nw: { x: box.x, y: box.y },
      n: { x: cx, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      e: { x: box.x + box.width, y: cy },
      se: { x: box.x + box.width, y: box.y + box.height },
      s: { x: cx, y: box.y + box.height },
      sw: { x: box.x, y: box.y + box.height },
      w: { x: box.x, y: cy }
    };

    for (const [key, pt] of Object.entries(handles)) {
      if (distance(local, pt) <= hs * 1.2) {
        return key as HandleType;
      }
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
   * Renders the merged selection box for the given annotations.
   */
  public render(ctx: CanvasRenderingContext2D, annotations: Annotation[], scale: number = 1.0): void {
    if (annotations.length === 0) return;
    // A lone rotated annotation gets a rotated box; groups use the merged
    // axis-aligned box.
    const rotation = annotations.length === 1 ? annotations[0].rotation || 0 : 0;
    this.renderSelectionBox(ctx, mergeBoundingBoxes(annotations.map(a => a.box)), scale, rotation);
  }

  /**
   * Renders selection bounding box, handles, and rotation pin on canvas.
   */
  public renderSelectionBox(ctx: CanvasRenderingContext2D, box: BoundingBox, scale: number = 1.0, rotation: number = 0): void {
    ctx.save();
    ctx.scale(scale, scale);
    if (rotation) {
      const c = boxCenter(box);
      ctx.translate(c.x, c.y);
      ctx.rotate(rotation);
      ctx.translate(-c.x, -c.y);
    }

    const hs = this._handleSize;
    const rotDist = this._rotHandleDistance;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Dashed selection border
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    // Rotation stem line & handle
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.moveTo(cx, box.y);
    ctx.lineTo(cx, box.y - rotDist);
    ctx.strokeStyle = '#4f46e5';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, box.y - rotDist, hs / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 8 handles
    const handles = [
      { x: box.x, y: box.y, cursor: 'nwse-resize' },
      { x: cx, y: box.y, cursor: 'ns-resize' },
      { x: box.x + box.width, y: box.y, cursor: 'nesw-resize' },
      { x: box.x + box.width, y: cy, cursor: 'ew-resize' },
      { x: box.x + box.width, y: box.y + box.height, cursor: 'nwse-resize' },
      { x: cx, y: box.y + box.height, cursor: 'ns-resize' },
      { x: box.x, y: box.y + box.height, cursor: 'nesw-resize' },
      { x: box.x, y: cy, cursor: 'ew-resize' }
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5;

    for (const h of handles) {
      ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
      ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
    }

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
