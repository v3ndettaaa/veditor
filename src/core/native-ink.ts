/**
 * ISO 32000-1 Two-Way Native Ink Serialization & Synchronization Engine
 *
 * Supports round-trip native PDF /Subtype /Ink annotations:
 *  - ID_SYNC: injects /NM (uuid) into /Annot dicts to match & update ink without duplicate stacking.
 *  - EMIT_ISO: generates /AP /N FormXObject streams via PostScript ops [m, c, l, S, w, RG].
 *  - COORDS: converts between screen (0 top) and PDF (0 bottom) coordinates with rotation handling.
 *  - DENORM: applies RDP filter (tolerance 0.5) to smooth imported strokes.
 *  - HITBOX: calculates AABB bounds [minX, minY, maxX, maxY] padded with stroke width.
 */

import { PDFDocument, PDFName, PDFDict, PDFString, PDFNumber } from 'pdf-lib';
import type { PenAnnotation, HighlighterAnnotation, StrokePoint } from './types';

export interface Point2D {
  x: number;
  y: number;
  pressure?: number;
}

/** Rotation-aware conversion from Screen coordinates to PDF coordinates. */
export function screenToPdfPoint(
  screenX: number,
  screenY: number,
  pageWidth: number,
  pageHeight: number,
  rotation: number = 0
): [number, number] {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 90) {
    return [screenY, screenX];
  } else if (rot === 180) {
    return [pageWidth - screenX, screenY];
  } else if (rot === 270) {
    return [pageHeight - screenY, pageWidth - screenX];
  }
  return [screenX, pageHeight - screenY];
}

/** Ramer-Douglas-Peucker (RDP) curve simplification filter. */
export function rdpFilter(points: Point2D[], tolerance: number = 0.5): Point2D[] {
  if (points.length <= 2) return points;
  let dmax = 0;
  let index = 0;
  const end = points.length - 1;
  const p1 = points[0];
  const p2 = points[end];

  for (let i = 1; i < end; i++) {
    const p = points[i];
    const d = perpendicularDistance(p, p1, p2);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > tolerance) {
    const recResults1 = rdpFilter(points.slice(0, index + 1), tolerance);
    const recResults2 = rdpFilter(points.slice(index), tolerance);
    return recResults1.slice(0, recResults1.length - 1).concat(recResults2);
  } else {
    return [p1, p2];
  }
}

function perpendicularDistance(p: Point2D, p1: Point2D, p2: Point2D): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const norm = Math.hypot(dx, dy);
  if (norm === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);
  return Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x) / norm;
}

/** Computes AABB bounding box padded by stroke width. */
export function computeInkHitbox(points: Point2D[], strokeWidth: number = 2): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  const pad = Math.max(2, strokeWidth);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = maxX + pad;
  maxY = maxY + pad;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

/** Parses hex or rgba string into normalized RGB factors [0..1]. */
export function parseColorRgb(colorStr: string): [number, number, number] {
  if (!colorStr) return [0, 0, 0];
  const hexMatch = colorStr.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  const rgbaMatch = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbaMatch) {
    return [
      parseInt(rgbaMatch[1], 10) / 255,
      parseInt(rgbaMatch[2], 10) / 255,
      parseInt(rgbaMatch[3], 10) / 255
    ];
  }
  return [0, 0, 0];
}

/** Extracts alpha factor [0..1] from an rgba() string if present. */
export function parseColorAlpha(colorStr: string): number | null {
  if (!colorStr) return null;
  const rgbaMatch = colorStr.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/i);
  if (rgbaMatch) {
    const a = parseFloat(rgbaMatch[1]);
    if (Number.isFinite(a)) return Math.max(0, Math.min(1, a));
  }
  return null;
}

/** Quick presence check for /Ink annotations. */
export function bytesMayContainInkAnnotations(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes).includes('/Ink');
}

const INK_NAME = PDFName.of('Ink').asString();

/**
 * Fast deterministic FNV-1a fingerprint for an ink stroke + page geometry.
 * Allows `syncNativeInkAnnotations` to skip rebuilding & flate-compressing
 * appearance streams for unchanged strokes during incremental Ctrl+S saves.
 */
export function computeInkFingerprint(
  ann: PenAnnotation | HighlighterAnnotation,
  boxX: number,
  boxY: number,
  pageWidth: number,
  pageHeight: number,
  rotation: number
): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    const v = Math.round(n * 100) | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mixStr(ann.type);
  mixStr(ann.color || '');
  mixStr(ann.type === 'highlighter' ? ((ann as HighlighterAnnotation).tipShape || '') : '');
  mix(ann.strokeWidth || 1.5);
  mix(ann.opacity ?? -1);
  mix(boxX);
  mix(boxY);
  mix(pageWidth);
  mix(pageHeight);
  mix(rotation);
  const pts = ann.points || [];
  mix(pts.length);
  for (let i = 0; i < pts.length; i++) {
    mix(pts[i].x);
    mix(pts[i].y);
  }
  return `v1_${(h >>> 0).toString(36)}_${pts.length}`;
}

/**
 * Bidirectionally synchronizes Veditor pen/highlighter ink annotations into `pdfDoc`
 * as native ISO 32000-1 `/Subtype /Ink` annotations.
 *
 * Matches existing annotations by `/NM (uuid)`.
 * Removes deleted annotations, updates modified ones, skips unchanged ones via
 * `/VEditorInkHash` fingerprint caching, and appends new ones.
 * Generates ISO `/AP /N` FormXObject appearance streams for vector fidelity.
 */
export function syncNativeInkAnnotations(
  pdfDoc: PDFDocument,
  annotationsByPage: Record<number, any[]>
): boolean {
  let changed = false;
  const pages = pdfDoc.getPages();

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    const boxX = Math.max(crop.x, media.x);
    const boxY = Math.max(crop.y, media.y);
    const pageWidth = Math.max(1, Math.min(crop.x + crop.width, media.x + media.width) - boxX);
    const pageHeight = Math.max(1, Math.min(crop.y + crop.height, media.y + media.height) - boxY);
    const rotation = page.getRotation()?.angle || 0;

    const veditorInkAnns = (annotationsByPage[pageIdx] || []).filter(
      a => (a.type === 'pen' || a.type === 'highlighter') && a.points?.length >= 2
    ) as Array<PenAnnotation | HighlighterAnnotation>;

    const annotsArray = page.node.Annots();
    const existingKeep: any[] = [];
    const existingInkMap = new Map<string, { ref: any; dict: PDFDict }>();
    const inkIdSet = new Set(veditorInkAnns.map(a => a.id));

    if (annotsArray) {
      for (let i = 0; i < annotsArray.size(); i++) {
        const rawItem = annotsArray.get(i);
        const dict = annotsArray.lookupMaybe(i, PDFDict);
        const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
        if (subtype?.asString() === INK_NAME && dict) {
          const nmObj = dict.lookupMaybe(PDFName.of('NM'), PDFString);
          const nmStr = nmObj?.asString();
          const managed = dict.lookupMaybe(PDFName.of('VEditorManaged'), PDFNumber)?.asNumber() === 1;
          if (nmStr && (managed || inkIdSet.has(nmStr))) {
            existingInkMap.set(nmStr, { ref: rawItem, dict });
          } else {
            existingKeep.push(rawItem);
          }
        } else {
          existingKeep.push(rawItem);
        }
      }
    }

    const updatedInkRefs: any[] = [];
    let pageChanged = false;

    for (const ann of veditorInkAnns) {
      const annotId = ann.id;
      const filteredPoints = ann.points;
      if (filteredPoints.length < 2) continue;

      const fingerprint = computeInkFingerprint(ann, boxX, boxY, pageWidth, pageHeight, rotation);
      const existingEntry = existingInkMap.get(annotId);

      // Fast incremental path: if the stroke's fingerprint and /AP stream match, reuse its ref untouched!
      if (existingEntry) {
        const prevHash = existingEntry.dict.lookupMaybe(PDFName.of('VEditorInkHash'), PDFString)?.decodeText();
        if (prevHash === fingerprint && existingEntry.dict.has(PDFName.of('AP'))) {
          existingInkMap.delete(annotId);
          updatedInkRefs.push(existingEntry.ref);
          continue;
        }
      }

      pageChanged = true;
      changed = true;
      const strokeWidth = ann.strokeWidth || 1.5;
      const [r, g, b] = parseColorRgb(ann.color || '#000000');

      // Coordinate conversion: screen (0 top) -> PDF (boxX/boxY bottom-left) with rotation handling
      const inkListCoords: number[] = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const pt of filteredPoints) {
        const [relX, relY] = screenToPdfPoint(pt.x, pt.y, pageWidth, pageHeight, rotation);
        const pdfX = boxX + relX;
        const pdfY = boxY + relY;
        inkListCoords.push(pdfX, pdfY);
        if (pdfX < minX) minX = pdfX;
        if (pdfY < minY) minY = pdfY;
        if (pdfX > maxX) maxX = pdfX;
        if (pdfY > maxY) maxY = pdfY;
      }

      const pad = Math.max(2, strokeWidth);
      const rectLlx = Math.max(boxX, minX - pad);
      const rectLly = Math.max(boxY, minY - pad);
      const rectUrx = maxX + pad;
      const rectUry = maxY + pad;

      // Check if existing dict can be updated
      let annotDict = existingEntry?.dict;
      if (!annotDict) {
        annotDict = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Ink',
          NM: PDFString.of(annotId)
        }) as PDFDict;
      } else {
        existingInkMap.delete(annotId);
      }

      // Update Dictionary attributes per ISO 32000-1
      annotDict.set(PDFName.of('VEditorManaged'), PDFNumber.of(1));
      annotDict.set(PDFName.of('VEditorInkHash'), PDFString.of(fingerprint));
      annotDict.set(PDFName.of('VEditorTool'), PDFString.of(ann.type));
      if (ann.type === 'highlighter' && (ann as HighlighterAnnotation).tipShape) {
        annotDict.set(PDFName.of('VEditorTipShape'), PDFString.of((ann as HighlighterAnnotation).tipShape!));
      } else {
        annotDict.delete(PDFName.of('VEditorTipShape'));
      }
      annotDict.set(PDFName.of('Rect'), pdfDoc.context.obj([rectLlx, rectLly, rectUrx, rectUry]));
      annotDict.set(PDFName.of('F'), PDFNumber.of(4)); // Print flag
      annotDict.set(PDFName.of('C'), pdfDoc.context.obj([r, g, b]));
      annotDict.set(
        PDFName.of('BS'),
        pdfDoc.context.obj({
          W: PDFNumber.of(strokeWidth),
          S: PDFName.of('S')
        })
      );
      annotDict.set(PDFName.of('InkList'), pdfDoc.context.obj([[...inkListCoords]]));

      const colorAlpha = parseColorAlpha(ann.color);
      const rawOpacity = ann.type === 'highlighter'
        ? (typeof ann.opacity === 'number' && Number.isFinite(ann.opacity) && ann.opacity < 1
            ? ann.opacity
            : (colorAlpha ?? (typeof ann.opacity === 'number' && Number.isFinite(ann.opacity) ? ann.opacity : 0.35)))
        : (ann.opacity ?? colorAlpha ?? 1);
      const opacity = Math.max(0.05, Math.min(1, rawOpacity));
      annotDict.set(PDFName.of('CA'), PDFNumber.of(opacity));

      const isChisel = ann.type === 'highlighter' && (ann as HighlighterAnnotation).tipShape === 'chisel';
      const capJoin = isChisel ? '0 J\n0 j' : '1 J\n1 j';

      // EMIT_ISO: Generate /AP /N FormXObject appearance stream
      let streamContent = `${capJoin}\n/GS gs\n${strokeWidth} w\n${r} ${g} ${b} RG\n`;
      streamContent += `${inkListCoords[0].toFixed(2)} ${inkListCoords[1].toFixed(2)} m\n`;
      for (let i = 2; i + 1 < inkListCoords.length; i += 2) {
        streamContent += `${inkListCoords[i].toFixed(2)} ${inkListCoords[i + 1].toFixed(2)} l\n`;
      }
      streamContent += `S\n`;

      const formDict = {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [rectLlx, rectLly, rectUrx, rectUry],
        Resources: { ExtGState: { GS: { Type: 'ExtGState', CA: opacity, ca: opacity } } }
      };
      const appearanceStream = pdfDoc.context.flateStream(
        new TextEncoder().encode(streamContent),
        formDict
      );
      const streamRef = pdfDoc.context.register(appearanceStream);

      const apDict = pdfDoc.context.obj({
        N: streamRef
      });
      annotDict.set(PDFName.of('AP'), apDict);

      const ref = existingEntry?.ref ?? pdfDoc.context.register(annotDict);
      updatedInkRefs.push(ref);
    }

    // Any remaining items in existingInkMap were deleted in Veditor -> prune them
    if (existingInkMap.size > 0) {
      changed = true;
      pageChanged = true;
    }

    if (pageChanged || (updatedInkRefs.length > 0 && !annotsArray)) {
      const finalAnnots = [...existingKeep, ...updatedInkRefs];
      page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(finalAnnots));
    }
  }

  return changed;
}

/** Legacy cleanup for raw raster stripping. */
export function stripNativeInkAnnotations(pdfDoc: PDFDocument): boolean {
  let changed = false;
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept: any[] = [];
    let pageChanged = false;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
      if (subtype?.asString() === INK_NAME) {
        pageChanged = true;
        continue;
      }
      kept.push(annots.get(i));
    }
    if (pageChanged) {
      changed = true;
      page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(kept));
    }
  }
  return changed;
}

export async function stripNativeInkAnnotationsFromBytes(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const changed = stripNativeInkAnnotations(pdfDoc);
    if (!changed) return bytes;
    return await pdfDoc.save({ useObjectStreams: false });
  } catch (e) {
    console.warn('Could not strip native Ink annotations:', e);
    return bytes;
  }
}

export function extractNativeInkToolMap(pdfDoc: PDFDocument): Map<string, 'pen' | 'highlighter'> {
  const toolMap = new Map<string, 'pen' | 'highlighter'>();
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
      if (subtype?.asString() !== INK_NAME || !dict) continue;
      const nm = dict.lookupMaybe(PDFName.of('NM'), PDFString)?.asString();
      const tool = dict.lookupMaybe(PDFName.of('VEditorTool'), PDFString)?.asString();
      if (nm && (tool === 'highlighter' || tool === 'pen')) {
        toolMap.set(nm, tool);
      }
    }
  }
  return toolMap;
}

export function extractNativeInkMetaMap(pdfDoc: PDFDocument): Map<string, { tool?: 'pen' | 'highlighter'; tipShape?: 'chisel' | 'round'; opacity?: number }> {
  const metaMap = new Map<string, { tool?: 'pen' | 'highlighter'; tipShape?: 'chisel' | 'round'; opacity?: number }>();
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
      if (subtype?.asString() !== INK_NAME || !dict) continue;
      const nm = dict.lookupMaybe(PDFName.of('NM'), PDFString)?.asString();
      if (!nm) continue;
      const tool = dict.lookupMaybe(PDFName.of('VEditorTool'), PDFString)?.asString();
      const tipShape = dict.lookupMaybe(PDFName.of('VEditorTipShape'), PDFString)?.asString();
      const ca = dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber();
      metaMap.set(nm, {
        tool: tool === 'highlighter' || tool === 'pen' ? tool : undefined,
        tipShape: tipShape === 'chisel' || tipShape === 'round' ? tipShape : undefined,
        opacity: typeof ca === 'number' && Number.isFinite(ca) ? ca : undefined
      });
    }
  }
  return metaMap;
}

