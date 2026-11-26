/**
 * Fast, Spec-Safe PDF Annotation Flattening Engine
 *
 * 1. Isolates existing page `/Contents` inside `q ... Q` so pre-existing
 *    non-identity CTMs, clip paths, or graphics states in arbitrary PDFs
 *    can NEVER shift, invert, clip, or corrupt flattened annotations.
 * 2. Directly emits native PDF vector operators (in an isolated Form XObject)
 *    for pen ink, highlighters, geometric shapes (rectangle, ellipse, line,
 *    arrow, polygon, freeform-shape), and vector signatures — infinite DPI,
 *    tiny output size, <1ms/page, zero canvas allocation.
 * 3. Computes tight, page-clamped bounding boxes for annotations that require
 *    browser rasterization (rich text/RTL, sticky notes, stamps, measurements)
 *    with safe canvas dimension caps so high-DPI export never overflows.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFStream
} from 'pdf-lib';
import type {
  Annotation,
  BoundingBox,
  HighlighterAnnotation,
  PenAnnotation,
  Point,
  ShapeAnnotation,
  SignatureAnnotation
} from './types';
import { computeArrowHeadGeometry } from '../utils/geometry';
import { parseColorAlpha, parseColorRgb } from './native-ink';

export interface PageBoxMetrics {
  boxX: number;
  boxY: number;
  width: number;
  height: number;
  pageRot: number;
  screenWidth: number;
  screenHeight: number;
}

/** Max pixel dimension / total pixels for a cropped raster canvas during flatten. */
export const MAX_FLATTEN_CANVAS_DIM = 4096;
export const MAX_FLATTEN_CANVAS_PIXELS = 12_000_000;

/**
 * Extracts normalized visible page box & rotation metrics matching `native-annotations.ts`.
 */
export function getPageBoxMetrics(pdfPage: PDFPage): PageBoxMetrics {
  const crop = pdfPage.getCropBox();
  const media = pdfPage.getMediaBox();
  const boxX = Math.max(crop.x, media.x);
  const boxY = Math.max(crop.y, media.y);
  const width = Math.max(1, Math.min(crop.x + crop.width, media.x + media.width) - boxX);
  const height = Math.max(1, Math.min(crop.y + crop.height, media.y + media.height) - boxY);
  const pageRot = ((pdfPage.getRotation().angle || 0) % 360 + 360) % 360;
  const isOddRot = pageRot === 90 || pageRot === 270;
  return {
    boxX,
    boxY,
    width,
    height,
    pageRot,
    screenWidth: isOddRot ? height : width,
    screenHeight: isOddRot ? width : height
  };
}

/**
 * Converts a screen-space point (origin top-left, Y down, in rotated view units)
 * to unrotated PDF page user-space coordinates.
 * Matches `native-annotations.ts` `frame(page).toPdf(p)`.
 */
export function screenPointToPdf(pt: Point, m: PageBoxMetrics): [number, number] {
  if (m.pageRot === 90) {
    return [m.boxX + pt.y, m.boxY + pt.x];
  }
  if (m.pageRot === 180) {
    return [m.boxX + m.width - pt.x, m.boxY + pt.y];
  }
  if (m.pageRot === 270) {
    return [m.boxX + m.width - pt.y, m.boxY + m.height - pt.x];
  }
  return [m.boxX + pt.x, m.boxY + m.height - pt.y];
}

/**
 * Converts a screen-space rectangle `{ x, y, width, height }` into the corresponding
 * axis-aligned PDF page rectangle `{ x, y, width, height }` in unrotated PDF user space.
 */
export function screenRectToPdfRect(rect: BoundingBox, m: PageBoxMetrics): BoundingBox {
  const c1 = screenPointToPdf({ x: rect.x, y: rect.y }, m);
  const c2 = screenPointToPdf({ x: rect.x + rect.width, y: rect.y + rect.height }, m);
  const minX = Math.min(c1[0], c2[0]);
  const minY = Math.min(c1[1], c2[1]);
  const maxX = Math.max(c1[0], c2[0]);
  const maxY = Math.max(c1[1], c2[1]);
  return {
    x: minX,
    y: minY,
    width: Math.max(0.5, maxX - minX),
    height: Math.max(0.5, maxY - minY)
  };
}

/**
 * Wraps the page's existing `/Contents` stream(s) in `q\n` ... `\nQ\n` so any
 * unbalanced transforms, clip paths, or graphics states left by the original PDF
 * are cleanly restored before flattened operators or images are appended.
 */
export function isolatePageContentStream(pdfDoc: PDFDocument, pdfPage: PDFPage): void {
  const contentsKey = PDFName.of('Contents');
  const rawContents = pdfPage.node.get(contentsKey);
  if (!rawContents) return;

  const qStream = pdfDoc.context.stream('q\n');
  const QStream = pdfDoc.context.stream('\nQ\n');
  const qRef = pdfDoc.context.register(qStream);
  const QRef = pdfDoc.context.register(QStream);

  const resolved = pdfDoc.context.lookup(rawContents);
  if (resolved instanceof PDFArray) {
    const items: any[] = [qRef];
    for (let i = 0; i < resolved.size(); i++) {
      items.push(resolved.get(i));
    }
    items.push(QRef);
    pdfPage.node.set(contentsKey, pdfDoc.context.obj(items));
  } else if (resolved instanceof PDFStream || rawContents instanceof PDFRef) {
    pdfPage.node.set(contentsKey, pdfDoc.context.obj([qRef, rawContents, QRef]));
  }
}

/**
 * Appends a raw operator stream to a PDFPage's `/Contents` array without mutating
 * any existing streams.
 */
export function appendPageContentStream(pdfDoc: PDFDocument, pdfPage: PDFPage, operators: string): void {
  const stream = pdfDoc.context.flateStream(new TextEncoder().encode(operators));
  const streamRef = pdfDoc.context.register(stream);
  const contentsKey = PDFName.of('Contents');
  const rawContents = pdfPage.node.get(contentsKey);

  if (!rawContents) {
    pdfPage.node.set(contentsKey, streamRef);
    return;
  }
  const resolved = pdfDoc.context.lookup(rawContents);
  if (resolved instanceof PDFArray) {
    resolved.push(streamRef);
  } else {
    pdfPage.node.set(contentsKey, pdfDoc.context.obj([rawContents, streamRef]));
  }
}

/**
 * Registers an XObject under a unique resource name on `pdfPage` and returns that name.
 */
export function registerPageXObject(pdfDoc: PDFDocument, pdfPage: PDFPage, xObjectRef: PDFRef, prefix = 'VFlat'): string {
  const resourcesKey = PDFName.of('Resources');
  const xObjectKey = PDFName.of('XObject');

  let resources = pdfPage.node.lookupMaybe(resourcesKey, PDFDict);
  if (!resources) {
    resources = pdfDoc.context.obj({}) as PDFDict;
    pdfPage.node.set(resourcesKey, resources);
  }
  let xObjects = resources.lookupMaybe(xObjectKey, PDFDict);
  if (!xObjects) {
    xObjects = pdfDoc.context.obj({}) as PDFDict;
    resources.set(xObjectKey, xObjects);
  }

  let idx = 0;
  let candidate = `${prefix}${idx}`;
  while (xObjects.has(PDFName.of(candidate))) {
    idx++;
    candidate = `${prefix}${idx}`;
  }
  xObjects.set(PDFName.of(candidate), xObjectRef);
  return candidate;
}

/**
 * Returns true if `ann` can be flattened directly as crisp PDF vector operators
 * without needing a browser 2D canvas.
 */
export function canVectorFlattenAnnotation(ann: Annotation): boolean {
  switch (ann.type) {
    case 'pen':
      return Array.isArray(ann.points) && ann.points.length >= 1;
    case 'highlighter':
      return (
        (Array.isArray(ann.quadPoints) && ann.quadPoints.length > 0) ||
        (Array.isArray(ann.points) && ann.points.length >= 1)
      );
    case 'rectangle':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'polygon':
    case 'freeform-shape':
      return true;
    case 'signature':
      return Array.isArray((ann as SignatureAnnotation).points) && (ann as SignatureAnnotation).points!.length > 0;
    default:
      return false;
  }
}

/**
 * Computes a padded screen-space bounding box for any annotation, clamped to page dimensions.
 */
export function computeAnnotationScreenBounds(ann: Annotation, screenWidth: number, screenHeight: number): BoundingBox {
  const b = ann.box || { x: 0, y: 0, width: 0, height: 0 };
  const strokePad = Math.max(6, ((ann as any).strokeWidth || 2) * 2);
  // Extra margin for sticky-note drop shadows, measurement badges, or rotation
  const extraPad =
    ann.type === 'sticky-note' ? 22
    : (ann.type === 'measure-distance' || ann.type === 'measure-angle' || ann.type === 'measure-area') ? 48
    : ann.type === 'text' ? 12
    : strokePad;

  let minX = b.x;
  let minY = b.y;
  let maxX = b.x + b.width;
  let maxY = b.y + b.height;

  const rot = ann.rotation || 0;
  if (rot !== 0) {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners: Point[] = [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height }
    ];
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    for (const c of corners) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
    }
  }

  const x0 = Math.max(0, Math.floor(minX - extraPad));
  const y0 = Math.max(0, Math.floor(minY - extraPad));
  const x1 = Math.min(screenWidth, Math.ceil(maxX + extraPad));
  const y1 = Math.min(screenHeight, Math.ceil(maxY + extraPad));
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0)
  };
}

/**
 * Computes the union screen-space bounding box for a non-empty list of annotations.
 */
export function computeUnionScreenBounds(
  annotations: Annotation[],
  screenWidth: number,
  screenHeight: number
): BoundingBox | null {
  if (annotations.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ann of annotations) {
    const b = computeAnnotationScreenBounds(ann, screenWidth, screenHeight);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

/**
 * Clamps a target DPI scale for a cropped canvas rect so it never exceeds
 * browser canvas dimension or memory limits (preventing blank/corrupted PNGs).
 */
export function resolveSafeRasterScale(rectWidth: number, rectHeight: number, desiredScale: number): number {
  const safeW = Math.max(1, rectWidth);
  const safeH = Math.max(1, rectHeight);
  let scale = Math.max(0.5, desiredScale);
  const maxDimScale = Math.min(MAX_FLATTEN_CANVAS_DIM / safeW, MAX_FLATTEN_CANVAS_DIM / safeH);
  if (scale > maxDimScale) scale = maxDimScale;
  const totalPixels = safeW * scale * safeH * scale;
  if (totalPixels > MAX_FLATTEN_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_FLATTEN_CANVAS_PIXELS / totalPixels);
  }
  return Math.max(0.5, scale);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function rotatePointScreen(pt: Point, cx: number, cy: number, angle: number): Point {
  if (!angle) return pt;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/**
 * Emits a smooth polyline/Bezier path in PDF coordinates using quadratic midpoints
 * promoted to exact cubic Bezier segments (`c` operator), matching `spline.ts`.
 */
function emitSmoothPolylinePath(pts: Point[], m: PageBoxMetrics, rotCx?: number, rotCy?: number, rotAngle?: number): string {
  const transform = (p: Point): [number, number] => {
    const sp = rotAngle ? rotatePointScreen(p, rotCx!, rotCy!, rotAngle) : p;
    return screenPointToPdf(sp, m);
  };

  if (pts.length === 1) {
    const [x, y] = transform(pts[0]);
    return `${fmt(x)} ${fmt(y)} m\n${fmt(x + 0.05)} ${fmt(y + 0.05)} l\n`;
  }

  const mapped = pts.map(transform);
  let ops = `${fmt(mapped[0][0])} ${fmt(mapped[0][1])} m\n`;

  if (mapped.length === 2) {
    ops += `${fmt(mapped[1][0])} ${fmt(mapped[1][1])} l\n`;
    return ops;
  }

  let curX = mapped[0][0];
  let curY = mapped[0][1];
  for (let i = 1; i < mapped.length - 1; i++) {
    const p1x = mapped[i][0];
    const p1y = mapped[i][1];
    const midX = (p1x + mapped[i + 1][0]) * 0.5;
    const midY = (p1y + mapped[i + 1][1]) * 0.5;
    // Exact degree elevation from quadratic (cur -> p1 -> mid) to cubic (c1, c2, mid)
    const c1x = curX + (2 / 3) * (p1x - curX);
    const c1y = curY + (2 / 3) * (p1y - curY);
    const c2x = midX + (2 / 3) * (p1x - midX);
    const c2y = midY + (2 / 3) * (p1y - midY);
    ops += `${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(midX)} ${fmt(midY)} c\n`;
    curX = midX;
    curY = midY;
  }
  const last = mapped[mapped.length - 1];
  ops += `${fmt(last[0])} ${fmt(last[1])} l\n`;
  return ops;
}

/**
 * Emits a rounded rectangle path in screen space converted to PDF coordinates.
 */
function emitRoundedRectPdfPath(
  b: BoundingBox,
  radius: number,
  m: PageBoxMetrics,
  rotAngle: number
): string {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const toPdf = (x: number, y: number): [number, number] => {
    const sp = rotAngle ? rotatePointScreen({ x, y }, cx, cy, rotAngle) : { x, y };
    return screenPointToPdf(sp, m);
  };

  const r = Math.max(0, Math.min(radius, b.width / 2, b.height / 2));
  if (r <= 0.05) {
    const p0 = toPdf(b.x, b.y);
    const p1 = toPdf(b.x + b.width, b.y);
    const p2 = toPdf(b.x + b.width, b.y + b.height);
    const p3 = toPdf(b.x, b.y + b.height);
    return (
      `${fmt(p0[0])} ${fmt(p0[1])} m\n` +
      `${fmt(p1[0])} ${fmt(p1[1])} l\n` +
      `${fmt(p2[0])} ${fmt(p2[1])} l\n` +
      `${fmt(p3[0])} ${fmt(p3[1])} l\n` +
      `h\n`
    );
  }

  const k = 0.5522847498 * r;
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + b.width;
  const y1 = b.y + b.height;

  const seg = (x: number, y: number) => {
    const [px, py] = toPdf(x, y);
    return `${fmt(px)} ${fmt(py)}`;
  };

  return (
    `${seg(x0 + r, y0)} m\n` +
    `${seg(x1 - r, y0)} l\n` +
    `${seg(x1 - r + k, y0)} ${seg(x1, y0 + r - k)} ${seg(x1, y0 + r)} c\n` +
    `${seg(x1, y1 - r)} l\n` +
    `${seg(x1, y1 - r + k)} ${seg(x1 - r + k, y1)} ${seg(x1 - r, y1)} c\n` +
    `${seg(x0 + r, y1)} l\n` +
    `${seg(x0 + r - k, y1)} ${seg(x0, y1 - r + k)} ${seg(x0, y1 - r)} c\n` +
    `${seg(x0, y0 + r)} l\n` +
    `${seg(x0, y0 + r - k)} ${seg(x0 + r - k, y0)} ${seg(x0 + r, y0)} c\n` +
    `h\n`
  );
}

/**
 * Emits an ellipse path (4 cubic Bezier quadrants) in PDF coordinates.
 */
function emitEllipsePdfPath(b: BoundingBox, m: PageBoxMetrics, rotAngle: number): string {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const rx = Math.max(0.5, b.width / 2);
  const ry = Math.max(0.5, b.height / 2);
  const kx = 0.5522847498 * rx;
  const ky = 0.5522847498 * ry;
  const seg = (x: number, y: number) => {
    const sp = rotAngle ? rotatePointScreen({ x, y }, cx, cy, rotAngle) : { x, y };
    const [px, py] = screenPointToPdf(sp, m);
    return `${fmt(px)} ${fmt(py)}`;
  };
  return (
    `${seg(cx + rx, cy)} m\n` +
    `${seg(cx + rx, cy + ky)} ${seg(cx + kx, cy + ry)} ${seg(cx, cy + ry)} c\n` +
    `${seg(cx - kx, cy + ry)} ${seg(cx - rx, cy + ky)} ${seg(cx - rx, cy)} c\n` +
    `${seg(cx - rx, cy - ky)} ${seg(cx - kx, cy - ry)} ${seg(cx, cy - ry)} c\n` +
    `${seg(cx + kx, cy - ry)} ${seg(cx + rx, cy - ky)} ${seg(cx + rx, cy)} c\n` +
    `h\n`
  );
}

/**
 * Flattens a batch of vector-capable annotations into a single isolated Form XObject
 * and draws it onto `pdfPage` (assumes `isolatePageContentStream` has already run).
 */
export function flattenVectorAnnotationsToPage(
  pdfDoc: PDFDocument,
  pdfPage: PDFPage,
  annotations: Annotation[],
  m: PageBoxMetrics
): boolean {
  if (annotations.length === 0) return false;

  const extGStates: Record<string, any> = {};
  const gsCache = new Map<string, string>();
  const getGsName = (strokeAlpha: number, fillAlpha: number, blendMode: 'Normal' | 'Multiply' = 'Normal'): string => {
    const caS = Math.max(0.01, Math.min(1, Math.round(strokeAlpha * 1000) / 1000));
    const caF = Math.max(0.01, Math.min(1, Math.round(fillAlpha * 1000) / 1000));
    const key = `${caS}|${caF}|${blendMode}`;
    let name = gsCache.get(key);
    if (!name) {
      name = `GS${gsCache.size}`;
      gsCache.set(key, name);
      extGStates[name] = {
        Type: 'ExtGState',
        CA: PDFNumber.of(caS),
        ca: PDFNumber.of(caF),
        ...(blendMode !== 'Normal' ? { BM: PDFName.of(blendMode) } : {})
      };
    }
    return name;
  };

  let ops = '';

  for (const ann of annotations) {
    const baseOpacity = Math.max(0.01, Math.min(1, ann.opacity ?? 1));
    const rot = ann.rotation || 0;
    const cx = (ann.box?.x || 0) + (ann.box?.width || 0) / 2;
    const cy = (ann.box?.y || 0) + (ann.box?.height || 0) / 2;

    if (ann.type === 'pen') {
      const pen = ann as PenAnnotation;
      if (!pen.points || pen.points.length === 0) continue;
      const [r, g, b] = parseColorRgb(pen.color || '#000000');
      const colorAlpha = parseColorAlpha(pen.color);
      const alpha = Math.max(0.01, Math.min(1, baseOpacity * (colorAlpha ?? 1)));
      const w = Math.max(0.25, pen.strokeWidth || 1.5);
      const gs = getGsName(alpha, alpha, 'Normal');
      ops += `q\n/${gs} gs\n1 J\n1 j\n${fmt(w)} w\n${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`;
      ops += emitSmoothPolylinePath(pen.points, m, cx, cy, rot);
      ops += `S\nQ\n`;
      continue;
    }

    if (ann.type === 'highlighter') {
      const hl = ann as HighlighterAnnotation;
      const [r, g, b] = parseColorRgb(hl.color || '#fde047');
      const colorAlpha = parseColorAlpha(hl.color);
      const bm: 'Normal' | 'Multiply' = hl.blendMode === 'source-over' ? 'Normal' : 'Multiply';

      if (Array.isArray(hl.quadPoints) && hl.quadPoints.length > 0) {
        const alpha = Math.max(0.05, Math.min(1, baseOpacity * (colorAlpha ?? 0.35)));
        const gs = getGsName(alpha, alpha, bm);
        ops += `q\n/${gs} gs\n${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n`;
        for (const quad of hl.quadPoints) {
          if (!Array.isArray(quad) || quad.length < 3) continue;
          const qcx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
          const qcy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
          const ordered = [...quad].sort((a, bPt) => Math.atan2(a.y - qcy, a.x - qcx) - Math.atan2(bPt.y - qcy, bPt.x - qcx));
          ordered.forEach((qp, idx) => {
            const sp = { x: hl.box.x + qp.x * hl.box.width, y: hl.box.y + qp.y * hl.box.height };
            const rSp = rot ? rotatePointScreen(sp, cx, cy, rot) : sp;
            const [px, py] = screenPointToPdf(rSp, m);
            ops += `${fmt(px)} ${fmt(py)} ${idx === 0 ? 'm' : 'l'}\n`;
          });
          ops += `h\n`;
        }
        ops += `f\nQ\n`;
      } else if (Array.isArray(hl.points) && hl.points.length >= 1) {
        const alpha = Math.max(
          0.05,
          Math.min(
            1,
            colorAlpha !== null ? colorAlpha : (typeof hl.opacity === 'number' && hl.opacity < 1 ? hl.opacity : 0.35)
          )
        );
        const gs = getGsName(alpha, alpha, bm);
        const w = Math.max(1, hl.strokeWidth || 14);
        const capJoin = hl.tipShape === 'chisel' ? '0 J\n0 j' : '1 J\n1 j';
        ops += `q\n/${gs} gs\n${capJoin}\n${fmt(w)} w\n${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`;
        ops += emitSmoothPolylinePath(hl.points, m, cx, cy, rot);
        ops += `S\nQ\n`;
      }
      continue;
    }

    if (ann.type === 'signature') {
      const sig = ann as SignatureAnnotation;
      const strokes = sig.points || [];
      if (strokes.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const stroke of strokes) {
        for (const pt of stroke) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
      if (!Number.isFinite(minX)) continue;
      const b = sig.box;
      const internalW = Math.max(1, maxX - minX);
      const internalH = Math.max(1, maxY - minY);
      const scaleX = Math.max(0.05, (b.width - 16) / internalW);
      const scaleY = Math.max(0.05, (b.height - 16) / internalH);
      const sigScale = Math.min(scaleX, scaleY);
      const [r, g, bCol] = parseColorRgb(sig.color || '#0f172a');
      const alpha = Math.max(0.01, Math.min(1, baseOpacity * (parseColorAlpha(sig.color) ?? 1)));
      const w = Math.max(0.5, 2.5 * sigScale);
      const gs = getGsName(alpha, alpha, 'Normal');
      ops += `q\n/${gs} gs\n1 J\n1 j\n${fmt(w)} w\n${fmt(r)} ${fmt(g)} ${fmt(bCol)} RG\n`;
      for (const stroke of strokes) {
        if (!Array.isArray(stroke) || stroke.length === 0) continue;
        const mapped = stroke.map((pt) => ({
          x: b.x + 8 + (pt.x - minX) * sigScale,
          y: b.y + 8 + (pt.y - minY) * sigScale
        }));
        ops += emitSmoothPolylinePath(mapped, m, cx, cy, rot);
      }
      ops += `S\nQ\n`;
      continue;
    }

    if (
      ann.type === 'rectangle' ||
      ann.type === 'ellipse' ||
      ann.type === 'line' ||
      ann.type === 'arrow' ||
      ann.type === 'polygon' ||
      ann.type === 'freeform-shape'
    ) {
      const sh = ann as ShapeAnnotation;
      const w = Math.max(0.5, sh.strokeWidth || 2);
      const outline = sh.type === 'line' || sh.type === 'arrow' || sh.outline !== false;
      const fillAlphaRaw = Math.max(0, Math.min(1, sh.fillOpacity ?? 1));
      const hasFill = Boolean(sh.fillColor && sh.fillColor !== 'transparent' && fillAlphaRaw > 0 && sh.type !== 'line' && sh.type !== 'arrow');
      const [sr, sg, sb] = parseColorRgb(sh.strokeColor || '#000000');
      const strokeAlpha = Math.max(0.01, Math.min(1, baseOpacity * (parseColorAlpha(sh.strokeColor) ?? 1)));

      let dashOp = '[] 0 d\n';
      if (sh.strokeStyle === 'dashed') {
        dashOp = `[${fmt(Math.max(8, w * 2.0))} ${fmt(Math.max(6, w * 1.55))}] 0 d\n`;
      } else if (sh.strokeStyle === 'dotted') {
        dashOp = `[0.1 ${fmt(Math.max(5, w * 1.85))}] 0 d\n`;
      }

      if (sh.type === 'line' || sh.type === 'arrow') {
        const pts = sh.points && sh.points.length >= 2
          ? sh.points
          : [{ x: sh.box.x, y: sh.box.y }, { x: sh.box.x + sh.box.width, y: sh.box.y + sh.box.height }];
        const isArrow = sh.type === 'arrow';
        const arrowGeom = isArrow ? computeArrowHeadGeometry(pts[pts.length - 2], pts[pts.length - 1], w) : null;
        const shaftPts = pts.map((p, idx) =>
          isArrow && idx === pts.length - 1 && arrowGeom ? arrowGeom.shaftEnd : p
        );
        const gs = getGsName(strokeAlpha, strokeAlpha, 'Normal');
        ops += `q\n/${gs} gs\n1 J\n1 j\n${dashOp}${fmt(w)} w\n${fmt(sr)} ${fmt(sg)} ${fmt(sb)} RG\n`;
        shaftPts.forEach((p, idx) => {
          const sp = rot ? rotatePointScreen(p, cx, cy, rot) : p;
          const [px, py] = screenPointToPdf(sp, m);
          ops += `${fmt(px)} ${fmt(py)} ${idx === 0 ? 'm' : 'l'}\n`;
        });
        ops += `S\n`;

        if (isArrow && arrowGeom) {
          const tipPt = pts[pts.length - 1];
          const tip = rot ? rotatePointScreen(tipPt, cx, cy, rot) : tipPt;
          const left = rot ? rotatePointScreen(arrowGeom.leftWing, cx, cy, rot) : arrowGeom.leftWing;
          const right = rot ? rotatePointScreen(arrowGeom.rightWing, cx, cy, rot) : arrowGeom.rightWing;
          const [tx, ty] = screenPointToPdf(tip, m);
          const [lx, ly] = screenPointToPdf(left, m);
          const [rx, ry] = screenPointToPdf(right, m);
          ops += `${fmt(sr)} ${fmt(sg)} ${fmt(sb)} rg\n`;
          ops += `${fmt(tx)} ${fmt(ty)} m\n${fmt(lx)} ${fmt(ly)} l\n${fmt(rx)} ${fmt(ry)} l\nh\nf\n`;
        }
        ops += `Q\n`;
        continue;
      }

      let pathOps = '';
      if (sh.type === 'rectangle') {
        const radius = Number.isFinite(sh.cornerRadius) ? Math.max(0, sh.cornerRadius!) : 0.75;
        pathOps = emitRoundedRectPdfPath(sh.box, radius, m, rot);
      } else if (sh.type === 'ellipse') {
        pathOps = emitEllipsePdfPath(sh.box, m, rot);
      } else if (sh.points && sh.points.length >= 2) {
        sh.points.forEach((p, idx) => {
          const sp = rot ? rotatePointScreen(p, cx, cy, rot) : p;
          const [px, py] = screenPointToPdf(sp, m);
          ops += ''; // keep loop crisp
          pathOps += `${fmt(px)} ${fmt(py)} ${idx === 0 ? 'm' : 'l'}\n`;
        });
        pathOps += 'h\n';
      }

      if (!pathOps) continue;

      if (hasFill && sh.fillColor) {
        const [fr, fg, fb] = parseColorRgb(sh.fillColor);
        const fillAlpha = Math.max(0.01, Math.min(1, baseOpacity * fillAlphaRaw * (parseColorAlpha(sh.fillColor) ?? 1)));
        const gsFill = getGsName(fillAlpha, fillAlpha, 'Normal');
        ops += `q\n/${gsFill} gs\n${fmt(fr)} ${fmt(fg)} ${fmt(fb)} rg\n${pathOps}f\nQ\n`;
      }
      if (outline) {
        const gsStroke = getGsName(strokeAlpha, strokeAlpha, 'Normal');
        const join = (sh.type === 'rectangle' && (sh.cornerRadius ?? 0.75) === 0) ? '0 j' : '1 j';
        ops += `q\n/${gsStroke} gs\n1 J\n${join}\n${dashOp}${fmt(w)} w\n${fmt(sr)} ${fmt(sg)} ${fmt(sb)} RG\n${pathOps}S\nQ\n`;
      }
    }
  }

  if (!ops) return false;

  const formStream = pdfDoc.context.flateStream(new TextEncoder().encode(ops), {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [m.boxX, m.boxY, m.boxX + m.width, m.boxY + m.height],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: {
      ExtGState: extGStates
    }
  });
  const formRef = pdfDoc.context.register(formStream);
  const xObjName = registerPageXObject(pdfDoc, pdfPage, formRef, 'VFlatV');
  appendPageContentStream(pdfDoc, pdfPage, `q\n/${xObjName} Do\nQ\n`);
  return true;
}
