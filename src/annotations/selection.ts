/**
 * Selection, Transformation & Alignment Engine
 * Provides 8-handle transform box, rotation handle, marquee selection, and alignment utilities.
 */

import { Point, BoundingBox, Annotation, ShapeAnnotation } from '../core/types';
import { isPointInBox, isPointInPolygon, distance, distanceToSegment, polygonArea, mergeBoundingBoxes, boxesIntersect, computePointsBoundingBox } from '../utils/geometry';
import { stickyNoteTool } from './tools/sticky-note';

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

export function boxCenter(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Computes the 2D convex hull of a set of points (Andrew's monotone chain). */
export function computeConvexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points.map(p => ({ x: p.x, y: p.y }));
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push({ x: p.x, y: p.y });
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push({ x: p.x, y: p.y });
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function expandPolygonOutward(hull: Point[], pad: number): Point[] {
  if (hull.length < 3 || pad <= 0) return hull;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
  });
}

function isPointOnInkAnnotation(point: Point, ann: Annotation, extraPad = 6): boolean {
  const pts = (ann as { points?: Point[] }).points;
  if (!Array.isArray(pts) || pts.length === 0) return false;
  const center = boxCenter(ann.box);
  const rot = ann.rotation || 0;
  const local = rot ? rotatePoint(point, center, -rot) : point;
  const tol = Math.max(extraPad, ((ann as any).strokeWidth || 2) / 2 + 5);
  if (pts.length === 1) return distance(local, pts[0]) <= tol;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (distanceToSegment(local, pts[i], pts[i + 1]) <= tol) return true;
  }
  return false;
}

function isPointInEllipseAnnotation(point: Point, ann: Annotation, edgePad = 4): boolean {
  const box = ann.box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const local = ann.rotation ? rotatePoint(point, { x: cx, y: cy }, -ann.rotation) : point;
  const rx = Math.max(2, box.width / 2 + edgePad);
  const ry = Math.max(2, box.height / 2 + edgePad);
  const dx = local.x - cx;
  const dy = local.y - cy;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1.0;
}

/**
 * Checks whether an annotation's actual geometry covers/overlaps a target bounding box
 * (used to block clicking PDF hyperlinks hidden beneath annotations).
 */
export function doesAnnotationCoverBox(ann: Annotation, target: BoundingBox): boolean {
  const box = getAnnotationSelectionBox(ann);
  if (!boxesIntersect(box, target)) return false;

  const samplePoints: Point[] = [
    { x: target.x + target.width * 0.5, y: target.y + target.height * 0.5 },
    { x: target.x + target.width * 0.15, y: target.y + target.height * 0.15 },
    { x: target.x + target.width * 0.5, y: target.y + target.height * 0.15 },
    { x: target.x + target.width * 0.85, y: target.y + target.height * 0.15 },
    { x: target.x + target.width * 0.15, y: target.y + target.height * 0.5 },
    { x: target.x + target.width * 0.85, y: target.y + target.height * 0.5 },
    { x: target.x + target.width * 0.15, y: target.y + target.height * 0.85 },
    { x: target.x + target.width * 0.5, y: target.y + target.height * 0.85 },
    { x: target.x + target.width * 0.85, y: target.y + target.height * 0.85 }
  ];

  if (ann.type === 'pen' || ann.type === 'highlighter') {
    const pts = (ann as { points?: Point[] }).points;
    if (!Array.isArray(pts) || pts.length === 0) return false;
    const center = boxCenter(ann.box);
    const rot = ann.rotation || 0;
    const pagePts = rot ? pts.map(p => rotatePoint(p, center, rot)) : pts;
    const pad = Math.max(4, ((ann as any).strokeWidth || 2) / 2);
    for (const p of pagePts) {
      if (isPointInBox(p, target)) return true;
    }
    for (let i = 0; i + 1 < pagePts.length; i++) {
      const a = pagePts[i];
      const b = pagePts[i + 1];
      for (const sp of samplePoints) {
        if (distanceToSegment(sp, a, b) <= pad + Math.min(target.width, target.height) * 0.25) {
          return true;
        }
      }
    }
    return false;
  }

  if (ann.type === 'ellipse') {
    return samplePoints.some(sp => isPointInEllipseAnnotation(sp, ann, 2));
  }

  if (ann.type === 'line' || ann.type === 'arrow' || ann.type === 'measure-distance' || ann.type === 'measure-angle') {
    const verts = getAnnotationVertices(ann);
    if (!verts || verts.length < 2) return false;
    const pad = Math.max(4, ((ann as any).strokeWidth || 2) / 2);
    for (let i = 0; i + 1 < verts.length; i++) {
      for (const sp of samplePoints) {
        if (distanceToSegment(sp, verts[i], verts[i + 1]) <= pad + Math.min(target.width, target.height) * 0.35) {
          return true;
        }
      }
    }
    return false;
  }

  if (ann.type === 'polygon' || ann.type === 'freeform-shape' || ann.type === 'measure-area') {
    const verts = getAnnotationVertices(ann);
    if (!verts || verts.length < 3) return false;
    return samplePoints.some(sp => isPointInPolygon(sp, verts));
  }

  return true;
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
  if (Array.isArray(value.strokes)) {
    value.strokes = value.strokes.map((s: any) => ({
      ...s,
      points: Array.isArray(s.points) ? s.points.map(shift) : []
    }));
  }
  if (Array.isArray(value.items)) {
    value.items = value.items.map((item: Annotation) => offsetAnnotation(item, dx, dy));
  }
  if (typeof value.anchorX === 'number') value.anchorX += dx;
  if (typeof value.anchorY === 'number') value.anchorY += dy;
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

export function getAnnotationSelectionBox(ann: Annotation): BoundingBox {
  if (ann.type === 'sticky-note' && ann.collapsed) {
    return stickyNoteTool.getCollapsedIconBox(ann);
  }
  return ann.box;
}

export function getAnnotationEndpoints(ann: Annotation): [Point, Point] | null {
  if ((ann.type !== 'line' && ann.type !== 'arrow') || !ann.points || ann.points.length < 2) return null;
  const center = boxCenter(ann.box);
  return [ann.points[0], ann.points[ann.points.length - 1]].map(
    point => rotatePoint(point, center, ann.rotation || 0)
  ) as [Point, Point];
}

export function moveAnnotationEndpoint(ann: ShapeAnnotation, handle: 'start' | 'end', target: Point): ShapeAnnotation {
  const endpoints = getAnnotationEndpoints(ann);
  if (!endpoints || !ann.points) return ann;
  const index = handle === 'start' ? 0 : ann.points.length - 1;
  const endpoint = endpoints[handle === 'start' ? 0 : 1];
  if (distance(endpoint, target) < 1e-9) return ann;
  const center = boxCenter(ann.box);
  const rotation = ann.rotation || 0;
  const points = ann.points.map((point, i) => ({
    ...point,
    ...(i === index ? { x: target.x, y: target.y } : rotatePoint(point, center, rotation))
  }));
  return {
    ...ann,
    points,
    box: computePointsBoundingBox(points, ann.strokeWidth),
    rotation: 0,
    updatedAt: Date.now()
  };
}

/**
 * Returns true if the annotation uses contour/vertex selection instead of a generic outer box.
 */
export function isVertexSelectionShape(ann: Annotation): boolean {
  return (
    ann.type === 'polygon' ||
    ann.type === 'freeform-shape' ||
    ann.type === 'line' ||
    ann.type === 'arrow' ||
    ann.type === 'rectangle' ||
    ann.type === 'measure-distance' ||
    ann.type === 'measure-angle' ||
    ann.type === 'measure-area'
  );
}

/**
 * Returns the page-space vertices (with rotation applied) for any vertex-editable shape.
 */
export function getAnnotationVertices(ann: Annotation): Point[] | null {
  if (ann.locked) return null;
  const center = boxCenter(ann.box);
  const rot = ann.rotation || 0;

  if (
    ann.type === 'polygon' ||
    ann.type === 'freeform-shape' ||
    ann.type === 'line' ||
    ann.type === 'arrow' ||
    ann.type === 'measure-distance' ||
    ann.type === 'measure-angle' ||
    ann.type === 'measure-area'
  ) {
    const pts = (ann as { points?: Point[] }).points;
    if (!Array.isArray(pts) || pts.length < 2) return null;
    return pts.map(p => (rot ? rotatePoint(p, center, rot) : { x: p.x, y: p.y }));
  }

  if (ann.type === 'rectangle') {
    const pts = (ann as ShapeAnnotation).points;
    if (Array.isArray(pts) && pts.length >= 3) {
      return pts.map(p => (rot ? rotatePoint(p, center, rot) : { x: p.x, y: p.y }));
    }
    const b = ann.box;
    const corners: Point[] = [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height }
    ];
    return corners.map(p => (rot ? rotatePoint(p, center, rot) : p));
  }

  return null;
}

/**
 * Moves a single vertex of a shape annotation to `target` in page coordinates.
 * For `rectangle`:
 * - When `keepRectangular` is false (default free-corner drag), converts the rectangle
 *   into a 4-vertex `polygon` so that single corner moves independently.
 * - When `keepRectangular` is true (e.g. Shift held or rectangle-lock mode enabled),
 *   resizes the two adjacent edges while keeping 90-degree rectangular corners.
 */
export function moveAnnotationVertex(
  ann: Annotation,
  vertexIndex: number,
  target: Point,
  keepRectangular: boolean = false
): Annotation {
  const vertices = getAnnotationVertices(ann);
  if (!vertices || vertexIndex < 0 || vertexIndex >= vertices.length) return ann;
  if (distance(vertices[vertexIndex], target) < 1e-9) return ann;

  if ((ann.type === 'line' || ann.type === 'arrow') && vertices.length === 2) {
    return moveAnnotationEndpoint(ann as ShapeAnnotation, vertexIndex === 0 ? 'start' : 'end', target);
  }

  if (ann.type === 'rectangle') {
    const shapeAnn = ann as ShapeAnnotation;
    if (keepRectangular) {
      const center = boxCenter(ann.box);
      const rot = ann.rotation || 0;
      const localTarget = rot ? rotatePoint(target, center, -rot) : target;
      const b = ann.box;
      const oppCorners: Point[] = [
        { x: b.x + b.width, y: b.y + b.height }, // opposite of 0 (NW) is SE
        { x: b.x, y: b.y + b.height },           // opposite of 1 (NE) is SW
        { x: b.x, y: b.y },                      // opposite of 2 (SE) is NW
        { x: b.x + b.width, y: b.y }             // opposite of 3 (SW) is NE
      ];
      const anchor = oppCorners[vertexIndex] || oppCorners[0];
      const nextBox = normalizeDragBox(anchor, localTarget, 8);
      return {
        ...shapeAnn,
        box: nextBox,
        updatedAt: Date.now()
      };
    }

    // Free corner move: convert rectangle into a 4-vertex polygon with that corner moved
    const nextPoints = vertices.map((p, i) => (i === vertexIndex ? { x: target.x, y: target.y } : { x: p.x, y: p.y }));
    return {
      ...shapeAnn,
      type: 'polygon',
      points: nextPoints,
      box: computePointsBoundingBox(nextPoints, shapeAnn.strokeWidth),
      rotation: 0,
      updatedAt: Date.now()
    };
  }

  const nextPoints = vertices.map((p, i) => (i === vertexIndex ? { x: target.x, y: target.y } : { x: p.x, y: p.y }));
  const strokeW = (ann as { strokeWidth?: number }).strokeWidth ?? 2;
  return {
    ...ann,
    points: nextPoints,
    box: computePointsBoundingBox(nextPoints, strokeW),
    rotation: 0,
    updatedAt: Date.now()
  } as Annotation;
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
  if (ann.type === 'sticky-note') {
    if (ann.collapsed) {
      const iconBox = stickyNoteTool.getCollapsedIconBox(ann);
      const ic1 = mapPt({ x: iconBox.x, y: iconBox.y });
      const ic2 = mapPt({ x: iconBox.x + iconBox.width, y: iconBox.y + iconBox.height });
      const nextIconX = Math.min(ic1.x, ic2.x);
      const nextIconY = Math.min(ic1.y, ic2.y);
      const nextIconW = Math.max(20, Math.abs(ic2.x - ic1.x));
      const nextIconH = Math.max(20, Math.abs(ic2.y - ic1.y));
      const shiftX = nextIconX - b.x;
      const shiftY = nextIconY - b.y;
      next.box = {
        x: b.x + shiftX,
        y: b.y + shiftY,
        width: b.width,
        height: b.height,
        ...(b.rotation !== undefined ? { rotation: b.rotation } : {})
      };
      next.iconWidth = nextIconW;
      next.iconHeight = nextIconH;
      if (typeof a.anchorX === 'number') next.anchorX = a.anchorX + shiftX;
      if (typeof a.anchorY === 'number') next.anchorY = a.anchorY + shiftY;
      if (Array.isArray(a.strokes)) {
        next.strokes = a.strokes.map((s: any) => ({
          ...s,
          points: Array.isArray(s.points)
            ? s.points.map((pt: Point) => ({ ...pt, x: pt.x + shiftX, y: pt.y + shiftY }))
            : []
        }));
      }
      if (Array.isArray(a.items)) {
        next.items = a.items.map((item: Annotation) => offsetAnnotation(item, shiftX, shiftY));
      }
    } else {
      next.box.width = Math.max(120, next.box.width);
      next.box.height = Math.max(100, next.box.height);
      if (typeof a.anchorX === 'number') next.anchorX = next.box.x;
      if (typeof a.anchorY === 'number') next.anchorY = next.box.y;
      if (Array.isArray(a.strokes)) {
        next.strokes = a.strokes.map((s: any) => ({
          ...s,
          strokeWidth: Math.max(0.5, (s.strokeWidth || 2) * meanScale),
          points: Array.isArray(s.points) ? s.points.map(mapPt) : []
        }));
      }
      if (Array.isArray(a.items)) {
        next.items = a.items.map((item: Annotation) => transformAnnotation(item, t));
      }
    }
  }
  return next as T;
}

export type HandleType =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'rot'
  | 'body'
  | 'start'
  | 'end'
  | `vertex:${number}`
  | null;

export interface ShapeHandleMetrics {
  /** Characteristic span of the shape (shortest edge or minimum box dimension, in page units). */
  characteristicSpan: number;
  /** Normalized scale factor in [0.36, 1.0] proportional to shape size. */
  sizeFactor: number;
  /** Inner white/indigo circle radius for vertex & endpoint handles (in page units). */
  handleRadius: number;
  /** Soft outer halo radius around vertex handles (in page units). */
  outerRadius: number;
  /** Precision center dot radius inside vertex handles (in page units). */
  centerDotRadius: number;
  /** Ring stroke width for handles (in page units). */
  strokeWidth: number;
  /** Side length for square/rounded-rect box resize handles (in page units). */
  boxHandleSize: number;
  /** Distance from the top of the bounding box to the rotation handle (in page units). */
  rotDist: number;
  /** Edge pill width/length for rectangle side handles (in page units). */
  edgePillLong: number;
  /** Edge pill thickness for rectangle side handles (in page units). */
  edgePillShort: number;
}

/**
 * Computes handle radii, stroke widths, and rotation stem distance proportional
 * to the drawn shape's geometry so small shapes never get overwhelmed by large indicators.
 */
export function computeShapeHandleMetrics(
  box: BoundingBox,
  vertices?: Point[] | null,
  isClosed: boolean = true,
  zoom: number = 1.0
): ShapeHandleMetrics {
  let characteristicSpan = Math.max(4, Math.min(box.width || 0, box.height || 0));
  if (vertices && vertices.length >= 2) {
    if (vertices.length === 2) {
      characteristicSpan = Math.max(4, distance(vertices[0], vertices[1]));
    } else {
      let minEdge = Infinity;
      for (let i = 0; i + 1 < vertices.length; i++) {
        const d = distance(vertices[i], vertices[i + 1]);
        if (d > 0.5 && d < minEdge) minEdge = d;
      }
      if (isClosed && vertices.length >= 3) {
        const closeD = distance(vertices[vertices.length - 1], vertices[0]);
        if (closeD > 0.5 && closeD < minEdge) minEdge = closeD;
      }
      const boxMin = Math.min(box.width || Infinity, box.height || Infinity);
      const rawSpan = Math.min(minEdge, boxMin > 0 ? boxMin : minEdge);
      characteristicSpan = Math.max(4, Number.isFinite(rawSpan) ? rawSpan : 32);
    }
  } else if (!Number.isFinite(characteristicSpan) || characteristicSpan <= 0) {
    characteristicSpan = Math.max(4, Math.hypot(box.width || 0, box.height || 0));
  }

  const safeZoom = Math.max(0.5, zoom || 1);
  const zoomDampen = safeZoom > 1 ? 1 / Math.pow(safeZoom, 0.5) : 1;
  const t = Math.max(0, Math.min(1, (characteristicSpan - 6) / (72 - 6)));
  const sizeFactor = (0.32 + 0.68 * t) * zoomDampen;
  const handleRadius = Math.max(1.35, Math.min(4.2 * sizeFactor, characteristicSpan * 0.14));
  const outerRadius = handleRadius * 1.36;
  const centerDotRadius = Math.max(0.55, handleRadius * 0.32);
  const strokeWidth = Math.max(0.95, Math.min(1.65, 1.65 * sizeFactor));
  const boxHandleSize = Math.max(2.4, Math.min(6.8 * sizeFactor, characteristicSpan * 0.22));
  const rotDist = Math.max(10, Math.round(22 * (0.42 + 0.58 * t) * zoomDampen));
  const edgePillLong = Math.max(4.5, 8.5 * sizeFactor);
  const edgePillShort = Math.max(2.0, 3.4 * sizeFactor);

  return {
    characteristicSpan,
    sizeFactor,
    handleRadius,
    outerRadius,
    centerDotRadius,
    strokeWidth,
    boxHandleSize,
    rotDist,
    edgePillLong,
    edgePillShort
  };
}

export interface HandleLoupePlacement {
  /** Center of the circular magnifier lens in page coordinates. */
  loupeCenter: Point;
  /** Radius of the circular magnifier lens in page coordinates. */
  radiusPage: number;
  /** Zoom magnification factor inside the lens (relative to current page view). */
  magnification: number;
  /** True when the loupe flipped below the target point to avoid clipping at the top edge. */
  placedBelow: boolean;
}

/**
 * Computes the screen-constant, boundary-clamped placement for the precision
 * magnifier loupe shown while dragging a shape corner/vertex/resize handle.
 */
export function computeHandleLoupePlacement(
  targetPt: Point,
  pageWidth: number,
  pageHeight: number,
  zoom: number = 1.0
): HandleLoupePlacement {
  const safeZoom = Math.max(zoom || 1, 0.25);
  const radiusPage = 46 / safeZoom;
  const offsetDist = 72 / safeZoom;
  const edgePad = 8 / safeZoom;
  const topThreshold = radiusPage + edgePad;

  const placedBelow = targetPt.y - offsetDist < topThreshold;
  const rawY = placedBelow ? targetPt.y + offsetDist : targetPt.y - offsetDist;

  const minX = radiusPage + edgePad;
  const maxX = pageWidth > minX * 2 ? pageWidth - radiusPage - edgePad : Math.max(minX, targetPt.x);
  const minY = radiusPage + edgePad;
  const maxY = pageHeight > minY * 2 ? pageHeight - radiusPage - edgePad : Math.max(minY, rawY);

  return {
    loupeCenter: {
      x: pageWidth > 0 ? Math.max(minX, Math.min(maxX, targetPt.x)) : targetPt.x,
      y: pageHeight > 0 ? Math.max(minY, Math.min(maxY, rawY)) : rawY
    },
    radiusPage,
    magnification: 2.5,
    placedBelow
  };
}

/**
 * Resolves the exact page-space coordinate of the dragged indicator handle on `ann`
 * so the magnifier loupe crosshair stays locked onto the true shape corner/vertex.
 */
export function resolveDraggedHandleTargetPoint(
  ann: Annotation | undefined,
  handle: Exclude<HandleType, null>,
  fallbackPt: Point
): Point {
  if (!ann) return fallbackPt;
  if (handle === 'start' || handle === 'end') {
    const endpoints = getAnnotationEndpoints(ann);
    if (endpoints) return handle === 'start' ? endpoints[0] : endpoints[1];
    return fallbackPt;
  }
  if (typeof handle === 'string' && handle.startsWith('vertex:')) {
    const idx = parseInt(handle.slice(7), 10);
    const verts = getAnnotationVertices(ann);
    if (verts && idx >= 0 && idx < verts.length) {
      return verts[idx];
    }
    return fallbackPt;
  }
  const b = ann.box;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const handleMap: Partial<Record<Exclude<HandleType, null>, Point>> = {
    nw: { x: b.x, y: b.y },
    n: { x: cx, y: b.y },
    ne: { x: b.x + b.width, y: b.y },
    e: { x: b.x + b.width, y: cy },
    se: { x: b.x + b.width, y: b.y + b.height },
    s: { x: cx, y: b.y + b.height },
    sw: { x: b.x, y: b.y + b.height },
    w: { x: b.x, y: cy }
  };
  const pt = handleMap[handle];
  if (!pt) return fallbackPt;
  return ann.rotation ? rotatePoint(pt, { x: cx, y: cy }, ann.rotation) : pt;
}

export class SelectionManager {
  private _handleSize = 8;
  private _rotHandleDistance = 24;

  public hitTestSelection(point: Point, annotations: Annotation[], scale: number = 1.0): HandleType {
    if (annotations.length === 0 || annotations.some(ann => ann.locked)) return null;

    if (annotations.length === 1) {
      const ann = annotations[0];
      const safeScale = Math.max(scale, 0.25);

      // 1. Two-point line / arrow endpoint handles ('start' and 'end')
      const endpoints = getAnnotationEndpoints(ann);
      if (endpoints) {
        const segLen = distance(endpoints[0], endpoints[1]);
        const endpointGrab = Math.min(10 / safeScale, Math.max(4.5 / safeScale, segLen * 0.34));
        const startDistance = distance(point, endpoints[0]);
        const endDistance = distance(point, endpoints[1]);
        if (Math.min(startDistance, endDistance) <= endpointGrab) {
          return startDistance <= endDistance ? 'start' : 'end';
        }
        const strokePad = Math.max(8 / safeScale, ((ann as ShapeAnnotation).strokeWidth || 2) * 0.75);
        if (distanceToSegment(point, endpoints[0], endpoints[1]) <= strokePad) {
          return 'body';
        }
        return null;
      }

      // 2. Vertex-based shapes (polygon, freeform-shape, multi-point line/arrow, rectangle, measure-*)
      if (isVertexSelectionShape(ann)) {
        const vertices = getAnnotationVertices(ann);
        if (vertices && vertices.length >= 2) {
          const isClosed =
            ann.type === 'polygon' ||
            ann.type === 'freeform-shape' ||
            ann.type === 'rectangle' ||
            ann.type === 'measure-area';
          const metrics = computeShapeHandleMetrics(ann.box, vertices, isClosed);
          const grabRadius = Math.min(
            10.5 / safeScale,
            Math.max(4.5 / safeScale, metrics.characteristicSpan * 0.34)
          );
          let bestIdx = -1;
          let bestDist = grabRadius;
          for (let i = 0; i < vertices.length; i++) {
            const d = distance(point, vertices[i]);
            if (d <= bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
          if (bestIdx !== -1) {
            return `vertex:${bestIdx}`;
          }

          const box = ann.box;
          const rot = ann.rotation || 0;
          const local = rot ? rotatePoint(point, boxCenter(box), -rot) : point;
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;

          // Rotation handle above shape
          const rotPt: Point = { x: cx, y: box.y - metrics.rotDist };
          if (distance(local, rotPt) <= 10 / safeScale) {
            return 'rot';
          }

          // For rectangles, keep the 4 edge-midpoint handles (n, e, s, w) active so
          // users can also resize width/height directly from the sides
          if (ann.type === 'rectangle' && box.width >= 24 && box.height >= 24) {
            const edgeHandles: Record<'n' | 'e' | 's' | 'w', Point> = {
              n: { x: cx, y: box.y },
              e: { x: box.x + box.width, y: cy },
              s: { x: cx, y: box.y + box.height },
              w: { x: box.x, y: cy }
            };
            const edgeGrab = Math.min(9.5 / safeScale, Math.max(4 / safeScale, metrics.characteristicSpan * 0.25));
            for (const [k, pt] of Object.entries(edgeHandles) as Array<['n' | 'e' | 's' | 'w', Point]>) {
              if (distance(local, pt) <= edgeGrab) {
                return k;
              }
            }
          }

          // Contour / interior body hit-test
          const strokePad = Math.max(8 / safeScale, ((ann as any).strokeWidth || 2) * 0.75);
          if (ann.type === 'rectangle') {
            if (isPointInBox(local, box)) return 'body';
            return null;
          }

          for (let i = 0; i + 1 < vertices.length; i++) {
            if (distanceToSegment(point, vertices[i], vertices[i + 1]) <= strokePad) {
              return 'body';
            }
          }
          if (isClosed && vertices.length >= 3) {
            if (distanceToSegment(point, vertices[vertices.length - 1], vertices[0]) <= strokePad) {
              return 'body';
            }
            if (isPointInPolygon(point, vertices)) {
              return 'body';
            }
          }
          return null;
        }
      }
    }

    return this.hitTestHandles(
      point,
      mergeBoundingBoxes(annotations.map(getAnnotationSelectionBox)),
      scale,
      annotations.length === 1 ? annotations[0].rotation || 0 : 0,
      annotations.length === 1 ? annotations[0] : undefined
    );
  }

  /**
   * Hit tests a point against the active selection's bounding box and handles.
   * When the selection is rotated, the point is mapped into the unrotated
   * frame first so handles stay grabbable at any angle.
   */
  public hitTestHandles(
    point: Point,
    box: BoundingBox,
    scale: number = 1.0,
    rotation: number = 0,
    singleAnn?: Annotation
  ): HandleType {
    const local = rotation ? rotatePoint(point, boxCenter(box), -rotation) : point;
    const safeScale = Math.max(scale, 0.25);
    const metrics = computeShapeHandleMetrics(box);
    const hs = metrics.boxHandleSize;
    const rotDist = metrics.rotDist;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    let bestHandle: HandleType | null = null;
    const handleGrab = Math.min(
      Math.max(hs * 1.9, 9 / safeScale),
      Math.max(4.5 / safeScale, metrics.characteristicSpan * 0.36)
    );
    let bestDist = handleGrab * 1.15;

    // Rotation handle (tested in the unrotated frame like everything else)
    const rotPt: Point = { x: cx, y: box.y - rotDist };
    const dRot = distance(local, rotPt);
    if (dRot <= Math.max(hs * 2.0, 9 / safeScale)) {
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
      if (d <= handleGrab && d < bestDist) {
        bestDist = d;
        bestHandle = key as HandleType;
      }
    }

    if (bestHandle) {
      return bestHandle;
    }

    if (singleAnn) {
      if (singleAnn.type === 'pen' || singleAnn.type === 'highlighter') {
        return isPointOnInkAnnotation(point, singleAnn, 8 / safeScale) ? 'body' : null;
      }
      if (singleAnn.type === 'ellipse') {
        return isPointInEllipseAnnotation(point, singleAnn, 4 / safeScale) ? 'body' : null;
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
      const selBox = getAnnotationSelectionBox(ann);
      // Rotated annotations hit-test in their unrotated frame.
      const local = ann.rotation ? rotatePoint(point, boxCenter(selBox), -ann.rotation) : point;
      if (!isPointInBox(local, selBox)) continue;

      if (ann.type === 'pen' || ann.type === 'highlighter') {
        if (!isPointOnInkAnnotation(point, ann, 7)) continue;
        return ann;
      }

      if (ann.type === 'ellipse') {
        if (!isPointInEllipseAnnotation(point, ann, 4)) continue;
        return ann;
      }

      if (
        ann.type === 'line' ||
        ann.type === 'arrow' ||
        ann.type === 'polygon' ||
        ann.type === 'freeform-shape' ||
        ann.type === 'measure-distance' ||
        ann.type === 'measure-angle' ||
        ann.type === 'measure-area'
      ) {
        const vertices = getAnnotationVertices(ann);
        if (vertices && vertices.length >= 2) {
          const pad = Math.max(10, ((ann as any).strokeWidth || 2) + 6);
          let hitEdge = false;
          for (let j = 0; j < vertices.length; j++) {
            if (distance(point, vertices[j]) <= pad) {
              hitEdge = true;
              break;
            }
            if (j + 1 < vertices.length && distanceToSegment(point, vertices[j], vertices[j + 1]) <= pad) {
              hitEdge = true;
              break;
            }
          }
          const isClosed =
            ann.type === 'polygon' ||
            ann.type === 'freeform-shape' ||
            ann.type === 'measure-area';
          if (!hitEdge && isClosed && vertices.length >= 3) {
            if (
              distanceToSegment(point, vertices[vertices.length - 1], vertices[0]) <= pad ||
              isPointInPolygon(point, vertices)
            ) {
              hitEdge = true;
            }
          }
          if (!hitEdge) continue;
        }
      }

      return ann;
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
    return annotations.filter(a => !a.locked && boxesIntersect(norm, getAnnotationSelectionBox(a)));
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
      const selBox = getAnnotationSelectionBox(ann);
      if (!boxesIntersect(lassoBox, selBox)) continue;
      // Test in the annotation's unrotated frame (boxes stay unrotated).
      const center = boxCenter(selBox);
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
          ann.type === 'stamp' || ann.type === 'signature') {
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
   * Renders the selection highlight for the given annotations.
   * Single geometric shapes render contour-hugging dashed outlines and direct
   * circular vertex handles on their actual corners/vertices (never an outer box).
   */
  public render(ctx: CanvasRenderingContext2D, annotations: Annotation[], scale: number = 1.0): void {
    if (annotations.length === 0) return;

    if (annotations.length === 1) {
      const ann = annotations[0];
      if (isVertexSelectionShape(ann)) {
        this.renderVertexSelection(ctx, ann, scale);
        return;
      }
      if (ann.type === 'ellipse') {
        this.renderEllipseSelection(ctx, ann, scale);
        return;
      }
      if (ann.type === 'pen' || ann.type === 'highlighter') {
        this.renderInkSelection(ctx, ann, scale);
        return;
      }
    }

    // Multi-selection or inherently rectangular annotations (text, stamp, sticky-note)
    const rotation = annotations.length === 1 ? annotations[0].rotation || 0 : 0;
    this.renderSelectionBox(
      ctx,
      mergeBoundingBoxes(annotations.map(getAnnotationSelectionBox)),
      scale,
      rotation
    );
  }

  /**
   * Renders a tight contour-hull selection envelope around a pen/highlighter stroke
   * with subtle corner/rotation grips (no loose oversized box obscuring adjacent text).
   */
  private renderInkSelection(
    ctx: CanvasRenderingContext2D,
    ann: Annotation,
    scale: number = 1.0
  ): void {
    const pts = (ann as { points?: Point[] }).points;
    if (!Array.isArray(pts) || pts.length < 2) {
      this.renderSelectionBox(ctx, getAnnotationSelectionBox(ann), scale, ann.rotation || 0);
      return;
    }

    const box = getAnnotationSelectionBox(ann);
    const rotation = ann.rotation || 0;
    const hull = expandPolygonOutward(computeConvexHull(pts), Math.max(4, ((ann as any).strokeWidth || 2) / 2 + 2));

    ctx.save();
    ctx.scale(scale, scale);
    if (rotation) {
      const c = boxCenter(box);
      ctx.translate(c.x, c.y);
      ctx.rotate(rotation);
      ctx.translate(-c.x, -c.y);
    }

    if (hull.length >= 3) {
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 1.35;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 1.35;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    if (ann.locked) {
      ctx.restore();
      return;
    }

    const metrics = computeShapeHandleMetrics(box);
    const hs = metrics.boxHandleSize;
    const rotDist = metrics.rotDist;
    const cx = box.x + box.width / 2;

    // Subtle rotation handle above top center
    ctx.setLineDash([]);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(cx, box.y);
    ctx.lineTo(cx, box.y - rotDist);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, box.y - rotDist, (hs + 1) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Subtle circular corner resize handles at the four corners
    const corners: Point[] = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ];
    const r = Math.max(2.2, metrics.handleRadius * 0.85);
    for (const cPt of corners) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = metrics.strokeWidth;
      ctx.beginPath();
      ctx.arc(cPt.x, cPt.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Renders a contour-hugging selection highlight and draggable vertex handles
   * directly on the corners/vertices of a shape annotation.
   */
  private renderVertexSelection(
    ctx: CanvasRenderingContext2D,
    ann: Annotation,
    scale: number = 1.0
  ): void {
    const vertices = getAnnotationVertices(ann) || getAnnotationEndpoints(ann);
    if (!vertices || vertices.length === 0) return;

    ctx.save();
    ctx.scale(scale, scale);

    // 1. Dashed contour highlight directly along the shape's geometry
    const isClosed =
      ann.type === 'polygon' ||
      ann.type === 'freeform-shape' ||
      ann.type === 'rectangle' ||
      ann.type === 'measure-area';

    ctx.save();
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(vertices[i].x, vertices[i].y);
    }
    if (isClosed && vertices.length >= 3) {
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();

    if (ann.locked) {
      ctx.restore();
      return;
    }

    const metrics = computeShapeHandleMetrics(ann.box, vertices, isClosed);

    // 2. Rotation stem & handle + side handles for rectangles (in rotated frame)
    const endpoints = getAnnotationEndpoints(ann);
    if (!endpoints) {
      const box = ann.box;
      const rot = ann.rotation || 0;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const rotDist = metrics.rotDist;
      const hs = metrics.boxHandleSize;

      ctx.save();
      if (rot) {
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.translate(-cx, -cy);
      }

      // Rotation stem and handle
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.moveTo(cx, box.y);
      ctx.lineTo(cx, box.y - rotDist);
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = Math.max(1.0, 1.4 * metrics.sizeFactor);
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
      ctx.lineWidth = metrics.strokeWidth;
      ctx.stroke();

      ctx.fillStyle = '#4f46e5';
      ctx.beginPath();
      ctx.arc(cx, box.y - rotDist, metrics.centerDotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // For rectangles, also render subtle edge-midpoint handles (n, e, s, w)
      // so both free-corner dragging (via corner circles) and 90-degree edge resizing work seamlessly
      if (ann.type === 'rectangle' && box.width >= 24 && box.height >= 24) {
        const ehLong = metrics.edgePillLong;
        const ehShort = metrics.edgePillShort;
        const edgeHandles = [
          { x: cx, y: box.y, w: ehLong, h: ehShort },
          { x: box.x + box.width, y: cy, w: ehShort, h: ehLong },
          { x: cx, y: box.y + box.height, w: ehLong, h: ehShort },
          { x: box.x, y: cy, w: ehShort, h: ehLong }
        ];
        ctx.save();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = Math.max(1.0, 1.4 * metrics.sizeFactor);
        for (const eh of edgeHandles) {
          ctx.beginPath();
          if ((ctx as any).roundRect) {
            (ctx as any).roundRect(eh.x - eh.w / 2, eh.y - eh.h / 2, eh.w, eh.h, 2);
          } else {
            ctx.rect(eh.x - eh.w / 2, eh.y - eh.h / 2, eh.w, eh.h);
          }
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.restore();
    }

    // 3. Circular draggable vertex handles on every corner / vertex of the shape,
    // scaled proportionally to the shape's dimensions so small shapes stay clean and unobstructed.
    ctx.save();
    ctx.setLineDash([]);
    const outerRadius = metrics.outerRadius;
    const handleRadius = metrics.handleRadius;
    for (const pt of vertices) {
      // Soft halo for clear visual affordance
      ctx.fillStyle = 'rgba(79, 70, 229, 0.16)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, outerRadius, 0, Math.PI * 2);
      ctx.fill();

      // Crisp white vertex circle with indigo ring
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = metrics.strokeWidth;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Precision center dot
      ctx.fillStyle = '#4f46e5';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, metrics.centerDotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.restore();
  }

  /**
   * Renders a contour-hugging dashed selection border directly on an ellipse's perimeter
   * instead of an outer rectangular bounding box.
   */
  private renderEllipseSelection(
    ctx: CanvasRenderingContext2D,
    ann: Annotation,
    scale: number = 1.0
  ): void {
    const box = ann.box;
    const rotation = ann.rotation || 0;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = Math.max(1, box.width / 2);
    const ry = Math.max(1, box.height / 2);
    const metrics = computeShapeHandleMetrics(box);
    const hs = metrics.boxHandleSize;
    const rotDist = metrics.rotDist;

    ctx.save();
    ctx.scale(scale, scale);
    if (rotation) {
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
    }

    // Dashed contour hugging the ellipse itself
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (ann.locked) {
      ctx.restore();
      return;
    }

    // Rotation stem and handle from top cardinal point
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.moveTo(cx, box.y);
    ctx.lineTo(cx, box.y - rotDist);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = Math.max(1.0, 1.4 * metrics.sizeFactor);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = metrics.strokeWidth;
    ctx.beginPath();
    ctx.arc(cx, box.y - rotDist, (hs + 1) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cardinal & corner handles scaled proportionally to ellipse size
    const handles: Point[] = [
      { x: cx, y: box.y },
      { x: box.x + box.width, y: cy },
      { x: cx, y: box.y + box.height },
      { x: box.x, y: cy },
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ];
    const ellipseHandleR = Math.max(1.8, metrics.handleRadius * 0.92);
    for (const h of handles) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = metrics.strokeWidth;
      ctx.beginPath();
      ctx.arc(h.x, h.y, ellipseHandleR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
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

    const metrics = computeShapeHandleMetrics(box);
    const hs = metrics.boxHandleSize;
    const rotDist = metrics.rotDist;
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
