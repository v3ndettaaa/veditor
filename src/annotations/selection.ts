/**
 * Selection, Transformation & Alignment Engine
 * Provides 8-handle transform box, rotation handle, marquee selection, and alignment utilities.
 */

import { Point, BoundingBox, Annotation } from '../core/types';
import { isPointInBox, distance, mergeBoundingBoxes } from '../utils/geometry';

export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot' | 'body' | null;

export class SelectionManager {
  private _handleSize = 8;
  private _rotHandleDistance = 24;

  /**
   * Hit tests a point against the active selection's bounding box and handles.
   */
  public hitTestHandles(point: Point, box: BoundingBox, scale: number = 1.0): HandleType {
    const hs = this._handleSize / scale;
    const rotDist = this._rotHandleDistance / scale;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Rotation handle
    const rotPt: Point = { x: cx, y: box.y - rotDist };
    if (distance(point, rotPt) <= hs * 1.5) {
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
      if (distance(point, pt) <= hs * 1.2) {
        return key as HandleType;
      }
    }

    if (isPointInBox(point, box)) {
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
      if (isPointInBox(point, ann.box)) {
        return ann;
      }
    }
    return null;
  }

  /**
   * Renders selection bounding box, handles, and rotation pin on canvas.
   */
  public renderSelectionBox(ctx: CanvasRenderingContext2D, box: BoundingBox, scale: number = 1.0): void {
    ctx.save();
    ctx.scale(scale, scale);

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
