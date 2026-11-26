/**
 * Pure geometry helper for 60fps GPU-composited live resize preview of Sticky Notes.
 *
 * Computes the clamped target box and exact CSS `transform` / `transformOrigin`
 * for the pre-rendered `_dragOverlay` sprite canvas in O(1) arithmetic — zero
 * deep-cloning of embedded strokes/items, zero `Path2D` cache invalidation, and
 * zero per-frame shadow-blur or text reflow during active resizing.
 */

import { BoundingBox } from '../core/types';
import { BoxTransform } from './selection';

export interface StickyResizePreviewState {
  nextBox: BoundingBox;
  scaleX: number;
  scaleY: number;
  /** CSS transform string for `_dragOverlay.canvas` (in CSS px). */
  cssTransform: string;
  /** CSS transform-origin string for `_dragOverlay.canvas` (in CSS px). */
  cssTransformOrigin: string;
}

export const STICKY_RESIZE_MIN_W = 56;
export const STICKY_RESIZE_MIN_H = 46;
export const STICKY_COLLAPSED_MIN_SIZE = 20;

/**
 * Computes the clamped destination box and GPU CSS transform for scaling a
 * pre-rendered sticky-note overlay sprite from `origBox` using `transform`.
 */
export function computeStickyResizePreview(
  origBox: BoundingBox,
  spriteBox: BoundingBox,
  transform: BoxTransform,
  zoom: number,
  options?: {
    collapsed?: boolean;
    rotation?: number;
  }
): StickyResizePreviewState {
  const safeZoom = Math.max(zoom || 1, 0.05);
  const minW = options?.collapsed ? STICKY_COLLAPSED_MIN_SIZE : STICKY_RESIZE_MIN_W;
  const minH = options?.collapsed ? STICKY_COLLAPSED_MIN_SIZE : STICKY_RESIZE_MIN_H;
  const rot = options?.rotation || 0;

  const mapPt = (x: number, y: number, sx: number, sy: number) => ({
    x: transform.originX + (x - transform.originX) * sx + transform.dx,
    y: transform.originY + (y - transform.originY) * sy + transform.dy
  });

  const c1 = mapPt(origBox.x, origBox.y, transform.scaleX, transform.scaleY);
  const c2 = mapPt(origBox.x + origBox.width, origBox.y + origBox.height, transform.scaleX, transform.scaleY);

  let nextX = Math.min(c1.x, c2.x);
  let nextY = Math.min(c1.y, c2.y);
  let nextW = Math.abs(c2.x - c1.x);
  let nextH = Math.abs(c2.y - c1.y);

  // Match transformAnnotation's minimum-size clamp semantics verbatim so live
  // preview matches the final committed box on pointerup without any jump.
  if (!options?.collapsed && (nextW < minW || nextH < minH)) {
    const clampRatio = Math.max(
      minW / Math.max(1, nextW),
      minH / Math.max(1, nextH)
    );
    const effScaleX = transform.scaleX * clampRatio;
    const effScaleY = transform.scaleY * clampRatio;
    const cc1 = mapPt(origBox.x, origBox.y, effScaleX, effScaleY);
    const cc2 = mapPt(origBox.x + origBox.width, origBox.y + origBox.height, effScaleX, effScaleY);
    nextX = Math.min(cc1.x, cc2.x);
    nextY = Math.min(cc1.y, cc2.y);
    nextW = Math.abs(cc2.x - cc1.x);
    nextH = Math.abs(cc2.y - cc1.y);
  } else if (options?.collapsed) {
    nextW = Math.max(minW, nextW);
    nextH = Math.max(minH, nextH);
  }

  const origW = Math.max(1, origBox.width);
  const origH = Math.max(1, origBox.height);
  const scaleX = nextW / origW;
  const scaleY = nextH / origH;

  // Anchor transform-origin at the original box's center inside the sprite canvas.
  // Because CSS applies transforms right-to-left:
  //   translate3d(dcx, dcy, 0) rotate(rot) scale(sx, sy) rotate(-rot)
  // first un-rotates the sprite back to local axes, applies axis-aligned scale,
  // re-applies rotation, and shifts center from origCenter to nextCenter!
  const origCx = origBox.x + origBox.width * 0.5;
  const origCy = origBox.y + origBox.height * 0.5;
  const nextCx = nextX + nextW * 0.5;
  const nextCy = nextY + nextH * 0.5;

  const originCssX = (origCx - spriteBox.x) * safeZoom;
  const originCssY = (origCy - spriteBox.y) * safeZoom;
  const shiftCssX = (nextCx - origCx) * safeZoom;
  const shiftCssY = (nextCy - origCy) * safeZoom;

  const cssTransformOrigin = `${originCssX.toFixed(2)}px ${originCssY.toFixed(2)}px`;
  const cssTransform = Math.abs(rot) > 1e-4
    ? `translate3d(${shiftCssX.toFixed(2)}px, ${shiftCssY.toFixed(2)}px, 0) rotate(${rot.toFixed(5)}rad) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}) rotate(${(-rot).toFixed(5)}rad)`
    : `translate3d(${shiftCssX.toFixed(2)}px, ${shiftCssY.toFixed(2)}px, 0) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;

  return {
    nextBox: {
      x: nextX,
      y: nextY,
      width: nextW,
      height: nextH,
      ...(origBox.rotation !== undefined ? { rotation: origBox.rotation } : {})
    },
    scaleX,
    scaleY,
    cssTransform,
    cssTransformOrigin
  };
}
