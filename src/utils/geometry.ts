/**
 * High-performance Geometry Utilities for veditor
 */

import { Point, BoundingBox } from '../core/types';

/**
 * Traces a polyline/polygon with rounded corners onto an open path. Each
 * corner is filleted with `arcTo`, clamped to half of its two adjacent edge
 * lengths so short edges never overlap. Callers own beginPath/fill/stroke.
 */
export function traceRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  radius: number,
  close: boolean
): void {
  const n = points.length;
  if (n === 0) return;
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  if (n < 3 || radius <= 0) {
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(points[i].x, points[i].y);
    if (close && n > 1) ctx.closePath();
    return;
  }
  const cornerRadius = (
    prev: { x: number; y: number },
    curr: { x: number; y: number },
    next: { x: number; y: number }
  ) => Math.max(0, Math.min(radius, d(prev, curr) / 2, d(curr, next) / 2));

  if (close) {
    const start = {
      x: (points[n - 1].x + points[0].x) / 2,
      y: (points[n - 1].y + points[0].y) / 2
    };
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const prev = points[(i - 1 + n) % n];
      const curr = points[i];
      const next = points[(i + 1) % n];
      const mid = { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 };
      ctx.arcTo(curr.x, curr.y, mid.x, mid.y, cornerRadius(prev, curr, next));
      ctx.lineTo(mid.x, mid.y);
    }
    ctx.closePath();
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < n - 1; i++) {
    const r = cornerRadius(points[i - 1], points[i], points[i + 1]);
    ctx.arcTo(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, r);
  }
  ctx.lineTo(points[n - 1].x, points[n - 1].y);
}

export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function angleBetween(center: Point, p: Point): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return distance(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

export function computePointsBoundingBox(points: Point[], padding = 0): BoundingBox {
  if (points.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2)
  };
}

/** Fills a filled-outline ribbon for a line segment with round caps. */
export function fillLineRibbon(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;
  const nx = -dy / len * width / 2;
  const ny = dx / len * width / 2;

  ctx.beginPath();
  ctx.moveTo(x1 + nx, y1 + ny);
  ctx.lineTo(x2 + nx, y2 + ny);
  ctx.lineTo(x2 - nx, y2 - ny);
  ctx.lineTo(x1 - nx, y1 - ny);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x1, y1, width / 2, Math.atan2(ny, nx), Math.atan2(-ny, -nx));
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x2, y2, width / 2, Math.atan2(-ny, -nx), Math.atan2(ny, nx));
  ctx.fill();
}

export function isPointInBox(p: Point, box: BoundingBox): boolean {
  if (box.rotation) {
    // Rotate point back by -rotation around box center
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cos = Math.cos(-box.rotation);
    const sin = Math.sin(-box.rotation);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const rx = cos * dx - sin * dy + cx;
    const ry = sin * dx + cos * dy + cy;
    return rx >= box.x && rx <= box.x + box.width && ry >= box.y && ry <= box.y + box.height;
  }
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

export function isPointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}

export function boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    b.x > a.x + a.width ||
    b.x + b.width < a.x ||
    b.y > a.y + a.height ||
    b.y + b.height < a.y
  );
}

/**
 * Returns the candidate point within `tolerance` of `point`, or null.
 * Used by vertex magnetic snapping; ties resolve to the closest candidate.
 */
export function findNearestVertex(
  point: Point,
  candidates: Point[],
  tolerance: number
): Point | null {
  let best: Point | null = null;
  let bestDist = tolerance;
  for (const c of candidates) {
    const d = distance(point, c);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

export function mergeBoundingBoxes(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  };
}
