/**
 * Draw-and-hold shape fitting: snaps a freehand pen stroke to a geometric
 * primitive (line, arrow, rectangle, ellipse, triangle/polygon).
 * Pure functions, unit-tested. All coordinates in page units.
 */

import { Point, BoundingBox } from '../core/types';
import { distance, distanceToSegment, polygonArea, computePointsBoundingBox } from './geometry';

export type FittedShape =
  | { kind: 'line'; p0: Point; p1: Point }
  | { kind: 'arrow'; p0: Point; p1: Point }
  | { kind: 'rectangle'; box: BoundingBox }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: Point[] };

/** Minimum stroke diagonal (page pt) to consider fitting. */
export const FIT_MIN_SIZE = 12;
/** Minimum raw points to consider fitting. */
export const FIT_MIN_POINTS = 8;

export function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1], points[i]);
  return len;
}

/** Arc-length resampling to exactly N points. */
export function resamplePoints(points: Point[], n: number): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: n }, () => ({ ...points[0] }));
  const total = pathLength(points);
  if (total === 0) return Array.from({ length: n }, () => ({ ...points[0] }));
  const step = total / (n - 1);
  const out: Point[] = [{ ...points[0] }];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length && out.length < n; i++) {
    const cur = points[i];
    let seg = distance(prev, cur);
    while (acc + seg >= step && out.length < n) {
      const t = (step - acc) / seg;
      const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push({ ...p });
      prev = p;
      seg = distance(prev, cur);
      acc = 0;
    }
    acc += seg;
    prev = cur;
  }
  while (out.length < n) out.push({ ...points[points.length - 1] });
  return out;
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return distance(p, a);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/** Ramer-Douglas-Peucker corner simplification. */
export function rdp(points: Point[], eps: number): Point[] {
  if (points.length <= 2) return points.map(p => ({ ...p }));
  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > eps) {
    const left = rdp(points.slice(0, index + 1), eps);
    const right = rdp(points.slice(index), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [{ ...first }, { ...last }];
}

/**
 * Merges near-duplicate consecutive corners and drops a duplicated closing
 * point. Resampling frequently straddles a true corner with two close points.
 */
function mergeCorners(corners: Point[], diag: number): Point[] {
  let simp = corners;
  if (simp.length > 1 && distance(simp[0], simp[simp.length - 1]) < 0.08 * diag) {
    simp = simp.slice(0, -1);
  }
  const merged: Point[] = [];
  for (const p of simp) {
    const prev = merged[merged.length - 1];
    if (!prev || distance(p, prev) >= 0.06 * diag) merged.push({ ...p });
    else {
      merged[merged.length - 1] = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
    }
  }
  if (merged.length > 1 && distance(merged[0], merged[merged.length - 1]) < 0.06 * diag) {
    merged.pop();
  }
  return merged;
}

/**
 * Mean distance from each raw sample to the simplified polygon boundary,
 * normalised by the stroke diagonal. Used to reject over-aggressive
 * simplification of genuinely wobbly scribbles.
 */
function polygonFitError(raw: Point[], poly: Point[]): number {
  if (poly.length < 2) return Infinity;
  let sum = 0;
  for (const p of raw) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const d = distanceToSegment(p, a, b);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / raw.length;
}

/**
 * Picks the smallest-vertex corner set across a range of Douglas-Peucker
 * tolerances. A fixed epsilon over-splits imperfect triangles into many-sided
 * polygons; widening it until the vertex count stops shrinking yields the
 * standard primitive the user intended (triangle/quad) while the fit-error
 * guard below keeps true scribbles from collapsing.
 */
function adaptiveCorners(pts: Point[], diag: number): Point[] {
  let best = mergeCorners(rdp(pts, 0.03 * diag), diag);
  let bestCount = best.length;
  for (const factor of [0.045, 0.06, 0.08, 0.1]) {
    if (bestCount <= 3) break;
    const candidate = mergeCorners(rdp(pts, factor * diag), diag);
    if (candidate.length >= 3 && candidate.length < bestCount) {
      best = candidate;
      bestCount = candidate.length;
    }
  }
  return best;
}

/**
 * Classifies a raw pen stroke. Returns null when it should stay ink
 * (too small, too few points, or no confident primitive).
 */
export function fitStroke(raw: Point[]): FittedShape | null {
  if (raw.length < FIT_MIN_POINTS) return null;
  const box = computePointsBoundingBox(raw);
  const diag = Math.hypot(box.width, box.height);
  if (diag < FIT_MIN_SIZE) return null;

  const pts = resamplePoints(raw, 32);
  const len = pathLength(pts);
  if (len === 0) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const endDist = distance(first, last);
  const closure = endDist / diag;

  // --- Line / arrow (open strokes that stay near their chord) ---
  let maxDev = 0;
  for (const p of pts) maxDev += perpendicularDistance(p, first, last);
  const meanDev = maxDev / pts.length;
  if (closure > 0.25 && meanDev / diag < 0.06) {
    // Arrowhead hook: path notably longer than the chord.
    if (len / Math.max(endDist, 1) > 1.18) {
      return { kind: 'arrow', p0: { ...first }, p1: { ...last } };
    }
    return { kind: 'line', p0: { ...first }, p1: { ...last } };
  }

  // --- Closed-ish strokes: clean circles first (a circle hugs its bbox
  // edges enough to fool the rectangle band), then rectangle (edge
  // proximity) → triangle → loose ellipse → polygon. ---
  if (closure < 0.25) {
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let meanR = 0;
    for (const p of pts) meanR += Math.hypot(p.x - cx, p.y - cy);
    meanR /= pts.length;
    let variance = 0;
    for (const p of pts) variance += (Math.hypot(p.x - cx, p.y - cy) - meanR) ** 2;
    variance = Math.sqrt(variance / pts.length) / Math.max(meanR, 1);
    const rx = box.width / 2;
    const ry = box.height / 2;
    const aspect = rx / Math.max(ry, 1);
    const areaRatio = polygonArea(pts) / Math.max(Math.PI * rx * ry, 1);
    const isElliptical = aspect > 0.35 && aspect < 2.8 && areaRatio > 0.7 && areaRatio < 1.2;
    if (variance < 0.1 && isElliptical) {
      return { kind: 'ellipse', cx, cy, rx, ry };
    }

    const band = 0.06 * diag;
    let nearEdge = 0;
    for (const p of pts) {
      const dx = Math.min(p.x - box.x, box.x + box.width - p.x);
      const dy = Math.min(p.y - box.y, box.y + box.height - p.y);
      if (Math.min(dx, dy) <= band) nearEdge++;
    }
    if (nearEdge / pts.length > 0.65) {
      return {
        kind: 'rectangle',
        box: { x: box.x, y: box.y, width: Math.max(4, box.width), height: Math.max(4, box.height) }
      };
    }

    // Adaptive simplification: a fixed epsilon over-splits imperfect
    // triangles into heptagons, so widen it until the vertex count settles.
    const simp = adaptiveCorners(pts, diag);

    // Only accept a polygon whose vertices actually hug the drawn stroke;
    // otherwise an aggressive simplification could turn a scribble into a
    // false triangle.
    const fitErr = polygonFitError(pts, simp) / diag;
    if (fitErr > 0.12) {
      if (variance < 0.15 && isElliptical) {
        return { kind: 'ellipse', cx, cy, rx, ry };
      }
      return null;
    }

    if (simp.length === 3) {
      // Three corners == triangle, still emitted as a 3-point polygon.
      return { kind: 'polygon', points: simp.map(p => ({ ...p })) };
    }

    if (variance < 0.15 && isElliptical) {
      return { kind: 'ellipse', cx, cy, rx, ry };
    }

    if (simp.length >= 4 && simp.length <= 8) {
      return { kind: 'polygon', points: simp.map(p => ({ ...p })) };
    }
  }

  return null;
}
