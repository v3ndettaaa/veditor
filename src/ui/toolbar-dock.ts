/**
 * Pure Toolbar Positioning & Magnetic Edge Snap Geometry
 * Determines whether a dragged toolbar should snap into one of the four defined
 * viewport edge docks ('top' | 'bottom' | 'left' | 'right') or remain freely
 * floating at clamped (x, y) coordinates inside the workspace.
 */

import type { ToolbarFloatPos } from '../core/types';

export type ToolbarSnapEdge = 'top' | 'bottom' | 'left' | 'right';

export const TOOLBAR_SNAP_EDGE_PX = 54;
export const TOOLBAR_HEADER_CLEARANCE_PX = 56;
export const TOOLBAR_VIEWPORT_MARGIN_PX = 12;

/**
 * Returns the nearest edge dock when the pointer enters one of the four edge snap zones,
 * or `null` when inside open workspace so the toolbar can float freely anywhere.
 */
export function detectToolbarSnapEdge(
  pointerX: number,
  pointerY: number,
  viewportWidth: number,
  viewportHeight: number,
  headerHeight: number = TOOLBAR_HEADER_CLEARANCE_PX,
  threshold: number = TOOLBAR_SNAP_EDGE_PX
): ToolbarSnapEdge | null {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  const topOrigin = Math.max(0, headerHeight);

  const candidates: Array<{ edge: ToolbarSnapEdge; dist: number }> = [
    { edge: 'top', dist: pointerY - topOrigin },
    { edge: 'bottom', dist: h - pointerY },
    { edge: 'left', dist: pointerX },
    { edge: 'right', dist: w - pointerX }
  ];

  let best: ToolbarSnapEdge | null = null;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (c.dist <= threshold && c.dist < bestDist) {
      bestDist = c.dist;
      best = c.edge;
    }
  }

  return best;
}

/**
 * Clamps a free-floating toolbar top-left coordinate cleanly inside the visible viewport,
 * keeping clear of the top app header and outer edges.
 */
export function clampToolbarFloatPos(
  x: number,
  y: number,
  barWidth: number,
  barHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  headerHeight: number = TOOLBAR_HEADER_CLEARANCE_PX,
  margin: number = TOOLBAR_VIEWPORT_MARGIN_PX
): ToolbarFloatPos {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  const bw = Math.max(40, barWidth);
  const bh = Math.max(36, barHeight);

  const minX = margin;
  const maxX = Math.max(minX, w - bw - margin);
  const minY = Math.max(margin, headerHeight + 8);
  const maxY = Math.max(minY, h - bh - margin);

  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y)))
  };
}
