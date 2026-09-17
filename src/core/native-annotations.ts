import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber,
  PDFObject, PDFPage, PDFRef, PDFStream, PDFString, StandardFonts,
} from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Annotation, BoundingBox, HighlighterAnnotation, Point, ShapeAnnotation, StampAnnotation, TextAnnotation } from './types';
import { STAMP_PRESETS } from '../annotations/tools/stamp';

type QuadHighlight = HighlighterAnnotation & { quadPoints: Point[][] };
type NativeAnnotation = TextAnnotation | ShapeAnnotation | QuadHighlight | StampAnnotation;
type Entry = { pageIndex: number; index: number; raw: PDFObject; dict: PDFDict; annotation: NativeAnnotation };
type Color = { rgb: number[]; alpha: number };
const name = PDFName.of;
const subtypes = new Set(['FreeText', 'Square', 'Circle', 'Line', 'Highlight', 'Polygon', 'PolyLine', 'Stamp']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const point = (v: unknown): v is Point => record(v) && finite(v.x) && finite(v.y);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const unit = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;

function get(dict: PDFDict, key: string): PDFObject | undefined {
  return dict.context.lookup(dict.get(name(key)));
}

function number(dict: PDFDict, key: string, fallback: number): number {
  const value = get(dict, key);
  if (value === undefined) return fallback;
  if (!(value instanceof PDFNumber) || !finite(value.asNumber())) throw new Error(`Invalid /${key}`);
  return value.asNumber();
}

function text(value: PDFObject | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof PDFString || value instanceof PDFHexString)) throw new Error('Invalid PDF string');
  return value.decodeText();
}

function pdfName(value: PDFObject | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof PDFName)) throw new Error('Invalid PDF name');
  return value.decodeText();
}

function numbers(value: PDFObject | undefined, length?: number): number[] {
  if (!(value instanceof PDFArray) || value.size() > 100000 || (length !== undefined && value.size() !== length)) {
    throw new Error('Invalid numeric array');
  }
  return value.asArray().map((_, index) => {
    const resolved = value.lookup(index);
    if (!(resolved instanceof PDFNumber) || !finite(resolved.asNumber())) throw new Error('Invalid coordinate');
    return resolved.asNumber();
  });
}

function rgbColor(values: number[]): string {
  if (!values.every(unit)) throw new Error('Invalid color');
  let rgb = values;
  if (values.length === 1) rgb = [values[0], values[0], values[0]];
  else if (values.length === 4) rgb = values.slice(0, 3).map(c => 1 - Math.min(1, c + values[3]));
  else if (values.length !== 3) throw new Error('Unsupported color space');
  return `#${rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

function nativeColor(dict: PDFDict, key: string, fallback: string): string {
  const value = get(dict, key);
  if (value === undefined) return fallback;
  const values = numbers(value);
  return values.length ? rgbColor(values) : 'transparent';
}

function color(value: unknown): Color {
  if (typeof value !== 'string') throw new Error('Invalid annotation color');
  if (value === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const s = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    return { rgb: [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255), alpha: 1 };
  }
  const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (match) {
    const rgb = match.slice(1, 4).map(c => Number(c) / 255);
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (rgb.every(unit) && unit(alpha)) return { rgb, alpha };
  }
  throw new Error(`Unsupported annotation color: ${value}`);
}

function validColor(value: unknown): boolean {
  try { color(value); return true; } catch { return false; }
}

function validModel(value: unknown): value is NativeAnnotation {
  if (record(value)) {
    const common = ['id', 'pageIndex', 'layerId', 'type', 'box', 'createdAt', 'updatedAt', 'opacity', 'blendMode', 'locked', 'rotation'];
    const specific = value.type === 'text'
      ? ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'borderColor', 'textAlign', 'padding']
      : value.type === 'highlighter'
        ? ['points', 'quadPoints', 'color', 'strokeWidth', 'straightLine', 'tipShape']
        : value.type === 'stamp'
          ? ['stampType', 'presetKey', 'imageUrl', 'svgData', 'color']
          : ['strokeColor', 'fillColor', 'strokeWidth', 'outline', 'strokeStyle', 'cornerRadius', 'points', 'arrowStart', 'arrowEnd'];
    if (Object.keys(value).some(k => !common.includes(k) && !specific.includes(k))) return false;
  }
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 4096 ||
    !Number.isInteger(value.pageIndex) || (value.pageIndex as number) < 0 || typeof value.layerId !== 'string' ||
    !finite(value.createdAt) || !finite(value.updatedAt) || !unit(value.opacity) || !record(value.box)) return false;
  const b = value.box;
  if (!finite(b.x) || !finite(b.y) || !finite(b.width) || b.width < 0 || !finite(b.height) || b.height < 0 ||
    (b.rotation !== undefined && !finite(b.rotation)) || (value.rotation !== undefined && !finite(value.rotation)) ||
    (value.locked !== undefined && typeof value.locked !== 'boolean') ||
    (value.blendMode !== undefined && !['multiply', 'source-over'].includes(value.blendMode as string))) return false;
  if (value.type === 'text') {
    return positive(b.width) && positive(b.height) && typeof value.text === 'string' && value.text.length <= 1000000 &&
      typeof value.fontFamily === 'string' && positive(value.fontSize) && validColor(value.color) &&
      ['left', 'center', 'right'].includes(value.textAlign as string) &&
      (value.fontWeight === undefined || typeof value.fontWeight === 'string' || finite(value.fontWeight)) &&
      (value.fontStyle === undefined || ['normal', 'italic'].includes(value.fontStyle as string)) &&
      (value.padding === undefined || (finite(value.padding) && value.padding >= 0)) &&
      (value.backgroundColor === undefined || validColor(value.backgroundColor)) &&
      (value.borderColor === undefined || validColor(value.borderColor));
  }
  if (value.type === 'highlighter') {
    return positive(b.width) && positive(b.height) && validColor(value.color) && positive(value.strokeWidth) &&
      ['multiply', 'source-over'].includes(value.blendMode as string) && Array.isArray(value.points) && value.points.length === 0 &&
      Array.isArray(value.quadPoints) && value.quadPoints.length > 0 && value.quadPoints.length <= 12500 &&
      value.quadPoints.every(q => Array.isArray(q) && q.length === 4 && q.every(p => point(p) && unit(p.x) && unit(p.y)) && quadArea(q) > 1e-12) &&
      (value.straightLine === undefined || typeof value.straightLine === 'boolean') &&
      (value.tipShape === undefined || ['chisel', 'round'].includes(value.tipShape as string));
  }
  if (value.type === 'stamp') {
    return positive(b.width) && positive(b.height) &&
      ['preset', 'custom'].includes(value.stampType as string) &&
      (value.stampType === 'preset'
        ? typeof value.presetKey === 'string' && STAMP_PRESETS.some(p => p.key === value.presetKey) &&
          (value.color === undefined || validColor(value.color))
        : typeof value.imageUrl === 'string' && value.imageUrl.length <= 8000000);
  }
  if (!['rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'freeform-shape'].includes(value.type as string) || !validColor(value.strokeColor) ||
    !finite(value.strokeWidth) || value.strokeWidth < 0 || !['solid', 'dashed', 'dotted'].includes(value.strokeStyle as string) ||
    (value.fillColor !== undefined && !validColor(value.fillColor)) ||
    (value.outline !== undefined && typeof value.outline !== 'boolean') ||
    (value.arrowStart !== undefined && typeof value.arrowStart !== 'boolean') ||
    (value.arrowEnd !== undefined && typeof value.arrowEnd !== 'boolean') ||
    (value.cornerRadius !== undefined && (!finite(value.cornerRadius) || value.cornerRadius < 0))) return false;
  if (value.type === 'line' || value.type === 'arrow') {
    return Array.isArray(value.points) && value.points.length === 2 && value.points.every(point) &&
      Math.hypot(value.points[1].x - value.points[0].x, value.points[1].y - value.points[0].y) > 0;
  }
  return positive(b.width) && positive(b.height) && (value.points === undefined || (Array.isArray(value.points) && value.points.every(point)));
}

function frame(page: PDFPage) {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const x = Math.max(crop.x, media.x), y = Math.max(crop.y, media.y);
  const w = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const h = Math.min(crop.y + crop.height, media.y + media.height) - y;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (![x, y, w, h].every(finite) || w <= 0 || h <= 0 || ![0, 90, 180, 270].includes(rotation) || number(page.node, 'UserUnit', 1) !== 1) {
    throw new Error('Unsupported PDF page geometry');
  }
  return {
    rotation,
    toScreen(p: Point): Point {
      const u = p.x - x, v = p.y - y;
      if (rotation === 90) return { x: v, y: u };
      if (rotation === 180) return { x: w - u, y: v };
      if (rotation === 270) return { x: h - v, y: w - u };
      return { x: u, y: h - v };
    },
    toPdf(p: Point): Point {
      if (rotation === 90) return { x: x + p.y, y: y + p.x };
      if (rotation === 180) return { x: x + w - p.x, y: y + p.y };
      if (rotation === 270) return { x: x + w - p.y, y: y + h - p.x };
      return { x: x + p.x, y: y + h - p.y };
    },
  };
}

function bounds(points: Point[]): BoundingBox {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  return { x, y, width: right - x, height: bottom - y };
}

function corners(b: BoundingBox): Point[] {
  return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
}

function polygon(quad: Point[]): Point[] {
  const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
  return [...quad].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

function quadArea(quad: Point[]): number {
  const p = polygon(quad);
  const crosses = p.map((a, i) => {
    const b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  if (!crosses.every(c => c > 0)) return 0;
  return Math.abs(p.reduce((sum, a, i) => sum + a.x * p[(i + 1) % 4].y - a.y * p[(i + 1) % 4].x, 0)) / 2;
}

function border(dict: PDFDict) {
  const bs = get(dict, 'BS');
  if (bs !== undefined && !(bs instanceof PDFDict)) throw new Error('Invalid /BS');
  let width = bs instanceof PDFDict ? number(bs, 'W', 1) : 1;
  let dash: number[] = [];
  const style = bs instanceof PDFDict ? pdfName(get(bs, 'S')) ?? 'S' : 'S';
  if (!['S', 'D'].includes(style)) throw new Error('Unsupported border style');
  if (bs instanceof PDFDict && get(bs, 'D') !== undefined) dash = numbers(get(bs, 'D'));
  const legacy = get(dict, 'Border');
  if (legacy !== undefined) {
    if (!(legacy instanceof PDFArray) || legacy.size() < 3 || legacy.size() > 4) throw new Error('Invalid /Border');
    const base = numbers(dict.context.obj(legacy.asArray().slice(0, 3)), 3);
    if (base[0] !== 0 || base[1] !== 0) throw new Error('Unsupported rounded native border');
    if (!bs) width = base[2];
    if (!bs && legacy.size() === 4) dash = numbers(legacy.lookup(3));
  }
  if (width < 0 || dash.some(v => v < 0) || (dash.length && !dash.some(v => v > 0))) throw new Error('Invalid border width or dash');
  if (style === 'D' && !dash.length) dash = [3];
  return { width, dash, style: (dash.length ? (dash[0] <= 3 ? 'dotted' : 'dashed') : 'solid') as ShapeAnnotation['strokeStyle'] };
}

function fontInfo(dict: PDFDict, page: PDFPage, alias: string) {
  const ap = get(dict, 'AP');
  const normal = ap instanceof PDFDict ? get(ap, 'N') : undefined;
  const resources = normal instanceof PDFStream ? get(normal.dict, 'Resources') : undefined;
  const candidates = [get(dict, 'DR'), resources, page.node.Resources()];
  const acro = get(page.doc.catalog, 'AcroForm');
  if (acro instanceof PDFDict) candidates.push(get(acro, 'DR') as PDFDict | undefined);
  let base = alias;
  for (const resource of candidates) {
    if (!(resource instanceof PDFDict)) continue;
    const fonts = get(resource, 'Font');
    const font = fonts instanceof PDFDict ? get(fonts, alias) : undefined;
    if (font instanceof PDFDict) { base = pdfName(get(font, 'BaseFont')) ?? alias; break; }
  }
  const family = /cour|mono/i.test(base) ? 'Courier New' : /times|tiro|tibo|tiit|tibi|serif/i.test(base) && !/sans/i.test(base) ? 'Times New Roman' : 'Arial';
  return { fontFamily: family, fontWeight: /bold|tibo|tibi|hebo|hebi|cobo|cobi/i.test(base) ? 'bold' : 'normal',
    fontStyle: (/italic|oblique|tiit|tibi|heob|hebi|coob|cobi/i.test(base) ? 'italic' : 'normal') as 'italic' | 'normal' };
}

function appearanceText(dict: PDFDict, page: PDFPage) {
  const da = text(get(dict, 'DA')) ?? '';
  const num = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
  const fonts = [...da.matchAll(new RegExp(`/([^\\s/]+)\\s+(${num})\\s+Tf\\b`, 'g'))];
  const font = fonts.at(-1);
  const fontSize = font ? Number(font[2]) : 12;
  if (!positive(fontSize)) throw new Error('Unsupported auto-sized FreeText');
  let c = '#000000';
  const tokens = da.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const count = tokens[i] === 'rg' ? 3 : tokens[i] === 'g' ? 1 : tokens[i] === 'k' ? 4 : 0;
    if (count) {
      const values = tokens.slice(i - count, i).map(Number);
      if (values.length !== count) throw new Error('Invalid /DA');
      c = rgbColor(values);
    }
  }
  return { ...fontInfo(dict, page, font?.[1] ?? 'Helv'), fontSize, color: c };
}

function subtypeFor(ann: NativeAnnotation): string {
  if (ann.type === 'text') return 'FreeText';
  if (ann.type === 'rectangle') return 'Square';
  if (ann.type === 'ellipse') return 'Circle';
  if (ann.type === 'highlighter') return 'Highlight';
  if (ann.type === 'stamp') return 'Stamp';
  if (ann.type === 'line' || ann.type === 'arrow') return 'Line';
  if (ann.type === 'polygon') return 'Polygon';
  return 'PolyLine';
}

function parse(dict: PDFDict, page: PDFPage, pageIndex: number, id: string): NativeAnnotation {
  const subtype = pdfName(get(dict, 'Subtype'));
  if (!subtype || !subtypes.has(subtype)) throw new Error('Unsupported subtype');
  const flags = number(dict, 'F', 0);
  if (!Number.isInteger(flags) || flags < 0 || (flags & (1 | 2 | 32 | 8 | 16 | 256))) throw new Error('Unsupported visibility or transform flags');
  const rect = numbers(get(dict, 'Rect'), 4);
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) throw new Error('Invalid /Rect');
  const f = frame(page);
  const contents = text(get(dict, 'Contents')) ?? '';
  const opacity = number(dict, 'CA', 1);
  if (!unit(opacity)) throw new Error('Invalid opacity');
  border(dict);
  nativeColor(dict, 'C', '#000000');
  nativeColor(dict, 'IC', 'transparent');
  if (subtype === 'Line') {
    const l = numbers(get(dict, 'L'), 4);
    if (l[0] === l[2] && l[1] === l[3]) throw new Error('Degenerate line');
    lineEndings(dict);
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const vertices = numbers(get(dict, 'Vertices'));
    if (subtype === 'PolyLine' && vertices.length < 4) throw new Error('Invalid /Vertices');
    if (vertices.length < 6 || vertices.length % 2) throw new Error('Invalid /Vertices');
  }
  if (subtype === 'Stamp' && get(dict, 'VEditorData') === undefined && (get(dict, 'AP') !== undefined || get(dict, 'Name') === undefined)) {
    throw new Error('Unsupported native stamp');
  }
  if (subtype === 'Highlight') {
    const quads = numbers(get(dict, 'QuadPoints'));
    if (!quads.length || quads.length % 8) throw new Error('Invalid /QuadPoints');
    for (let i = 0; i < quads.length; i += 8) {
      const quad = [0, 2, 4, 6].map(j => ({ x: quads[i + j], y: quads[i + j + 1] }));
      if (quadArea(quad) <= 0 || quad.some(p => p.x < rect[0] - 1e-6 || p.x > rect[2] + 1e-6 || p.y < rect[1] - 1e-6 || p.y > rect[3] + 1e-6)) throw new Error('Invalid highlight geometry');
    }
  }
  const stored = get(dict, 'VEditorData');
  if (stored !== undefined) {
    if (number(dict, 'VEditorNative', 0) !== 1) throw new Error('Unmarked internal data');
    const json = text(stored);
    if (!json || json.length > 4000000) throw new Error('Invalid internal data');
    const data: unknown = JSON.parse(json);
    if (!validModel(data) || subtypeFor(data) !== subtype || data.id !== id || (data.type === 'text' && data.text !== contents)) {
      throw new Error('Invalid internal annotation model');
    }
    return { ...data, pageIndex };
  }
  const be = get(dict, 'BE');
  if (be !== undefined && (!(be instanceof PDFDict) || number(be, 'I', 0) !== 0 || ![undefined, 'S'].includes(pdfName(get(be, 'S'))))) throw new Error('Unsupported border effect');
  for (const key of ['RC', 'CL', 'Path']) if (get(dict, key) !== undefined) throw new Error(`Unsupported /${key}`);
  if (number(dict, 'LL', 0) !== 0 || number(dict, 'LLE', 0) !== 0 || number(dict, 'LLO', 0) !== 0 || get(dict, 'Cap')?.toString() === 'true') throw new Error('Unsupported line caption or leader');
  const rd = get(dict, 'RD') === undefined ? [0, 0, 0, 0] : numbers(get(dict, 'RD'), 4);
  if (rd.some(v => v < 0) || rd[0] + rd[2] >= rect[2] - rect[0] || rd[1] + rd[3] >= rect[3] - rect[1]) throw new Error('Invalid /RD');
  const pdfBox = { x: rect[0] + rd[0], y: rect[1] + rd[1], width: rect[2] - rect[0] - rd[0] - rd[2], height: rect[3] - rect[1] - rd[1] - rd[3] };
  let box = bounds(corners(pdfBox).map(f.toScreen));
  const base = { id, pageIndex, layerId: 'default', box, opacity, createdAt: 0, updatedAt: 0, locked: !!(flags & (64 | 128 | 512)) };
  const stroke = border(dict);
  if (subtype === 'FreeText') {
    const q = number(dict, 'Q', 0);
    const rotate = number(dict, 'Rotate', 0);
    if (![0, 1, 2].includes(q) || rotate % 90 !== 0) throw new Error('Unsupported FreeText alignment or rotation');
    const center = f.toScreen({ x: pdfBox.x + pdfBox.width / 2, y: pdfBox.y + pdfBox.height / 2 });
    const odd = Math.abs(rotate % 180) === 90;
    const width = odd ? pdfBox.height : pdfBox.width, height = odd ? pdfBox.width : pdfBox.height;
    box = { x: center.x - width / 2, y: center.y - height / 2, width, height };
    const typography = appearanceText(dict, page);
    return { ...base, box, type: 'text', text: contents, ...typography,
      rotation: (f.rotation - rotate) * Math.PI / 180, textAlign: (['left', 'center', 'right'] as const)[q],
      backgroundColor: nativeColor(dict, 'C', 'transparent'),
      ...(stroke.width > 0 ? { borderColor: typography.color } : {}), padding: 0 };
  }
  const c = nativeColor(dict, 'C', subtype === 'Highlight' ? '#ffff00' : '#000000');
  if (subtype === 'Highlight') {
    const coords = numbers(get(dict, 'QuadPoints'));
    if (!coords.length || coords.length % 8) throw new Error('Invalid /QuadPoints');
    const quadPoints: Point[][] = [];
    for (let i = 0; i < coords.length; i += 8) {
      const quad: Point[] = [];
      for (let j = 0; j < 8; j += 2) {
        const p = f.toScreen({ x: coords[i + j], y: coords[i + j + 1] });
        quad.push({ x: (p.x - box.x) / box.width, y: (p.y - box.y) / box.height });
      }
      quadPoints.push(quad);
    }
    const result: QuadHighlight = { ...base, type: 'highlighter', points: [], quadPoints, color: c, strokeWidth: 1, blendMode: 'multiply' };
    if (!validModel(result)) throw new Error('Invalid highlight geometry');
    return result;
  }
  const shape = { ...base, strokeColor: c, fillColor: nativeColor(dict, 'IC', 'transparent'),
    strokeWidth: stroke.width, strokeStyle: stroke.style, outline: stroke.width > 0 && c !== 'transparent', cornerRadius: 0 };
  if (subtype === 'Line') {
    const l = numbers(get(dict, 'L'), 4);
    const points = [f.toScreen({ x: l[0], y: l[1] }), f.toScreen({ x: l[2], y: l[3] })];
    const endings = lineEndings(dict);
    const arrowStart = endings[0] !== 'None', arrowEnd = endings[1] !== 'None';
    const result: ShapeAnnotation = { ...shape, type: arrowStart || arrowEnd ? 'arrow' : 'line', points, arrowStart, arrowEnd };
    if (!validModel(result)) throw new Error('Invalid line');
    return result;
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const vertices = numbers(get(dict, 'Vertices'));
    const points: Point[] = [];
    for (let i = 0; i < vertices.length; i += 2) points.push(f.toScreen({ x: vertices[i], y: vertices[i + 1] }));
    const result: ShapeAnnotation = { ...shape, type: subtype === 'Polygon' ? 'polygon' : 'freeform-shape', points };
    if (!validModel(result)) throw new Error('Invalid polygon vertices');
    return result;
  }
  if (subtype === 'Stamp') {
    const result: StampAnnotation = { ...base, type: 'stamp', stampType: 'preset', presetKey: 'APPROVED', color: c };
    if (!validModel(result)) throw new Error('Invalid stamp');
    return result;
  }
  return { ...shape, type: subtype === 'Square' ? 'rectangle' : 'ellipse' };
}

function lineEndings(dict: PDFDict): string[] {
  const le = get(dict, 'LE');
  if (le === undefined) return ['None', 'None'];
  if (!(le instanceof PDFArray) || le.size() !== 2) throw new Error('Invalid /LE');
  const endings = le.asArray().map(v => pdfName(dict.context.lookup(v)) ?? 'None');
  if (!endings.every(v => ['None', 'OpenArrow', 'ClosedArrow'].includes(v))) throw new Error('Unsupported line ending');
  return endings;
}

function directId(dict: PDFDict): string {
  let hash = 2166136261;
  for (const ch of dict.toString()) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function entries(pdfDoc: PDFDocument): Entry[] {
  const result: Entry[] = [];
  const ids = new Set<string>();
  pdfDoc.getPages().forEach((page, pageIndex) => {
    let annots: PDFObject | undefined;
    try { annots = get(page.node, 'Annots'); } catch { return; }
    if (!(annots instanceof PDFArray)) return;
    for (let index = 0; index < annots.size(); index++) {
      try {
        const raw = annots.get(index);
        const dict = pdfDoc.context.lookup(raw);
        if (!(dict instanceof PDFDict)) continue;
        const fallback = `native-${pageIndex}-${raw instanceof PDFRef ? `${raw.objectNumber}-${raw.generationNumber}` : directId(dict)}`;
        const nm = text(get(dict, 'NM'));
        let id = nm || fallback;
        if (ids.has(id)) id = `${id}:${fallback}:${index}`;
        const annotation = parse(dict, page, pageIndex, id);
        if (!validModel(annotation)) continue;
        ids.add(id);
        result.push({ pageIndex, index, raw, dict, annotation });
      } catch { continue; }
    }
  });
  return result;
}

export function importNativeAnnotations(pdfDoc: PDFDocument): Array<{ pageIndex: number; annotation: Annotation }> {
  return entries(pdfDoc).map(({ pageIndex, annotation }) => ({ pageIndex, annotation }));
}

export function stripImportedNativeAnnotations(pdfDoc: PDFDocument): boolean {
  const imported = entries(pdfDoc);
  pdfDoc.getPages().forEach((page, pageIndex) => {
    const removed = new Set(imported.filter(e => e.pageIndex === pageIndex).map(e => e.index));
    if (!removed.size) return;
    const annots = get(page.node, 'Annots') as PDFArray;
    page.node.set(name('Annots'), pdfDoc.context.obj(annots.asArray().filter((_, index) => !removed.has(index))));
  });
  return imported.length > 0;
}

function standardFont(ann: TextAnnotation): StandardFonts {
  const bold = /bold/i.test(String(ann.fontWeight)) || Number(ann.fontWeight) >= 600;
  const italic = ann.fontStyle === 'italic';
  if (/cour|mono/i.test(ann.fontFamily)) return bold ? italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  if (/times|serif/i.test(ann.fontFamily) && !/sans/i.test(ann.fontFamily)) return bold ? italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  return bold ? italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

function n(value: number): string {
  if (!finite(value) || Math.abs(value) > 1e8) throw new Error('Unsupported appearance coordinate magnitude');
  return String(Number(value.toFixed(6)));
}

function list(values: number[]): string { return values.map(n).join(' '); }

function build(pdfDoc: PDFDocument, page: PDFPage, ann: NativeAnnotation, original: Entry | undefined, font?: PDFFont): PDFDict {
  const ctx = pdfDoc.context;
  const dict = original ? original.dict.clone(ctx) : ctx.obj({ Type: 'Annot' });
  const set = (key: string, value: PDFObject) => dict.set(name(key), value);
  const b = ann.box;
  const f = frame(page);
  const angle = ann.rotation ?? 0, cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const transform = (p: Point) => f.toPdf({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos });
  const origin = transform({ x: 0, y: 0 }), ex = transform({ x: 1, y: 0 }), ey = transform({ x: 0, y: 1 });
  const matrix = [ex.x - origin.x, ex.y - origin.y, ey.x - origin.x, ey.y - origin.y, origin.x, origin.y];
  const geometry = corners(b);
  const ops: string[] = ['q', `${list(matrix)} cm`, '1 J', '1 j'];
  const states: Record<string, PDFDict> = {};
  const paint = (fill: Color, stroke: Color, multiply = false) => {
    const key = `G${Object.keys(states).length}`;
    states[key] = ctx.obj({ Type: 'ExtGState', ca: ann.opacity * fill.alpha, CA: ann.opacity * stroke.alpha, BM: multiply ? 'Multiply' : 'Normal' });
    ops.push(`/${key} gs`, `${list(fill.rgb)} rg`, `${list(stroke.rgb)} RG`);
  };
  const path = (points: Point[], close = true) => {
    ops.push(`${list([points[0].x, points[0].y])} m`);
    for (const p of points.slice(1)) ops.push(`${list([p.x, p.y])} l`);
    if (close) ops.push('h');
  };
  const rectangle = () => ops.push(`${list([b.x, b.y, b.width, b.height])} re`);
  let pad = 0;
  set('Type', name('Annot'));
  set('Subtype', name(subtypeFor(ann)));
  set('NM', PDFHexString.fromText(ann.id));
  set('VEditorNative', PDFNumber.of(1));
  set('VEditorData', PDFHexString.fromText(JSON.stringify(ann)));
  set('CA', PDFNumber.of(ann.opacity));
  set('P', page.ref);
  set('F', PDFNumber.of(4 | (ann.locked ? 128 : 0)));
  if (!original) set('Contents', PDFHexString.fromText(''));
  for (const key of ['AP', 'AS', 'RD', 'Rotate', 'Border']) dict.delete(name(key));
  if (ann.type === 'text') {
    if (!font) throw new Error('Missing FreeText font');
    const fg = color(ann.color), bg = color(ann.backgroundColor ?? 'transparent'), stroke = color(ann.borderColor ?? 'transparent');
    const originalBorder = original ? border(original.dict) : undefined;
    const unchangedBorder = original?.annotation.type === 'text' && original.annotation.borderColor === ann.borderColor;
    const width = stroke.alpha ? unchangedBorder && originalBorder ? originalBorder.width : 1 : 0;
    const dash = unchangedBorder && originalBorder ? originalBorder.dash : [];
    pad = width / 2;
    paint(bg, stroke);
    ops.push(`${n(width)} w`, `[${list(dash)}] 0 d`);
    rectangle();
    ops.push(bg.alpha ? stroke.alpha ? 'B' : 'f' : stroke.alpha ? 'S' : 'n');
    paint(fg, fg);
    const padding = ann.padding ?? 8;
    const ascent = font.heightAtSize(ann.fontSize, { descender: false });
    const descent = font.heightAtSize(ann.fontSize) - ascent;
    ops.push('BT', `/F0 ${n(ann.fontSize)} Tf`);
    ann.text.split(/\r\n|\r|\n/).forEach((line, i) => {
      const encoded = font.encodeText(line);
      const width = font.widthOfTextAtSize(line, ann.fontSize);
      const x = ann.textAlign === 'center' ? b.x + (b.width - width) / 2 : ann.textAlign === 'right' ? b.x + b.width - padding - width : b.x + padding;
      const top = b.y + padding + i * ann.fontSize * 1.35;
      ops.push(`1 0 0 -1 ${list([x, top + ascent])} Tm`, `${encoded.toString()} Tj`);
      geometry.push({ x, y: top }, { x: x + width, y: top + ascent + descent });
    });
    ops.push('ET');
    set('Contents', PDFHexString.fromText(ann.text));
    set('DA', PDFString.of(`/F0 ${n(ann.fontSize)} Tf ${list(fg.rgb)} rg`));
    set('DR', ctx.obj({ Font: { F0: font.ref } }));
    set('Q', PDFNumber.of(['left', 'center', 'right'].indexOf(ann.textAlign)));
    set('C', ctx.obj(bg.alpha ? bg.rgb : []));
    set('BS', ctx.obj({ W: width, S: dash.length ? 'D' : 'S', ...(dash.length ? { D: dash } : {}) }));
  } else if (ann.type === 'highlighter') {
    const fill = color(ann.color);
    paint(fill, fill, ann.blendMode === 'multiply');
    const quads = ann.quadPoints.map(q => q.map(p => ({ x: b.x + p.x * b.width, y: b.y + p.y * b.height })));
    for (const q of quads) { path(polygon(q)); ops.push('f'); }
    set('QuadPoints', ctx.obj(quads.flatMap(q => q.flatMap(p => { const v = transform(p); return [v.x, v.y]; }))));
    set('C', ctx.obj(fill.rgb));
  } else if (ann.type === 'stamp') {
    const fill = color(ann.color || '#dc2626'), stroke = fill;
    const preset = STAMP_PRESETS.find(p => p.key === ann.presetKey) || STAMP_PRESETS[0];
    set('Name', name('Approved'));
    set('Contents', PDFHexString.fromText(preset.label));
    paint(fill, fill);
    ops.push(`${n(Math.max(1, b.height * 0.05))} w`, `${list([b.x, b.y, b.width, b.height])} re`, 'S');
    ops.push('BT', `/F0 ${n(Math.max(6, b.height * 0.3))} Tf`, `${list(fill.rgb)} rg`,
      `BT ${list([b.x + b.width / 2, cy - b.height * 0.1])} Td`, `${preset.label.replace(/[()\\]/g, '')} Tj`, 'ET');
    geometry.push(...corners(b));
  } else {
    const fill = color((ann as ShapeAnnotation).fillColor ?? 'transparent'), stroke = color((ann as ShapeAnnotation).strokeColor);
    const line = ann.type === 'line' || ann.type === 'arrow';
    const outline = (line || ann.outline !== false) && ann.strokeWidth > 0 && stroke.alpha > 0;
    const width = outline ? ann.strokeWidth : 0;
    pad = width / 2;
    let dash = ann.strokeStyle === 'dashed' ? [8, 6] : ann.strokeStyle === 'dotted' ? [3, 4] : [];
    if (original && 'strokeStyle' in original.annotation && original.annotation.strokeStyle === ann.strokeStyle) dash = border(original.dict).dash;
    const bs = original && get(original.dict, 'BS') instanceof PDFDict ? (get(original.dict, 'BS') as PDFDict).clone(ctx) : ctx.obj({});
    bs.set(name('W'), PDFNumber.of(width));
    bs.set(name('S'), name(dash.length ? 'D' : 'S'));
    if (dash.length) bs.set(name('D'), ctx.obj(dash)); else bs.delete(name('D'));
    set('BS', bs);
    set('C', ctx.obj(stroke.alpha ? stroke.rgb : []));
    set('IC', ctx.obj(fill.alpha ? fill.rgb : []));
    paint(fill, stroke, ann.blendMode === 'multiply');
    ops.push(`${n(width)} w`, `[${list(dash)}] 0 d`);
    if (line) {
      const points = ann.points!;
      geometry.push(...points);
      path(points, false);
      ops.push(outline ? 'S' : 'n');
      const old = original ? lineEndings(original.dict) : ['None', 'None'];
      const enabled = [ann.arrowStart ?? false, ann.arrowEnd ?? ann.type === 'arrow'];
      const endings = enabled.map((v, i) => v ? old[i] !== 'None' ? old[i] : 'ClosedArrow' : 'None');
      endings.forEach((ending, i) => {
        if (ending === 'None') return;
        const tip = points[i], other = points[1 - i];
        const direction = Math.atan2(tip.y - other.y, tip.x - other.x), length = Math.max(12, ann.strokeWidth * 4);
        const head = [{ x: tip.x - length * Math.cos(direction - Math.PI / 6), y: tip.y - length * Math.sin(direction - Math.PI / 6) }, tip,
          { x: tip.x - length * Math.cos(direction + Math.PI / 6), y: tip.y - length * Math.sin(direction + Math.PI / 6) }];
        geometry.push(...head);
        paint(ending === 'ClosedArrow' ? (fill.alpha ? fill : stroke) : fill, stroke);
        ops.push('[] 0 d');
        path(head, ending === 'ClosedArrow');
        ops.push(ending === 'ClosedArrow' ? 'B' : 'S');
      });
      set('L', ctx.obj(points.flatMap(p => { const v = transform(p); return [v.x, v.y]; })));
      set('LE', ctx.obj(endings.map(name)));
    } else if (ann.type === 'polygon' || ann.type === 'freeform-shape') {
      const points = ann.points ?? [];
      geometry.push(...points);
      path(points, ann.type === 'polygon');
      ops.push(fill.alpha ? outline ? 'B' : 'f' : outline ? 'S' : 'n');
      set('Vertices', ctx.obj(points.flatMap(p => { const v = transform(p); return [v.x, v.y]; })));
    } else {
      if (ann.type === 'ellipse') {
        const rx = b.width / 2, ry = b.height / 2, k = 0.5522847498307936;
        ops.push(`${list([cx + rx, cy])} m`);
        for (const values of [
          [cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
          [cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
          [cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
          [cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
        ]) ops.push(`${list(values)} c`);
        ops.push('h');
      } else {
        const r = Math.min(ann.cornerRadius ?? 0.75, b.width / 2, b.height / 2);
        if (!r) rectangle();
        else {
          const x = b.x, y = b.y, right = x + b.width, bottom = y + b.height, k = r * 0.5522847498307936;
          ops.push(`${list([x + r, y])} m`, `${list([right - r, y])} l`, `${list([right - r + k, y, right, y + r - k, right, y + r])} c`,
            `${list([right, bottom - r])} l`, `${list([right, bottom - r + k, right - r + k, bottom, right - r, bottom])} c`,
            `${list([x + r, bottom])} l`, `${list([x + r - k, bottom, x, bottom - r + k, x, bottom - r])} c`,
            `${list([x, y + r])} l`, `${list([x, y + r - k, x + r - k, y, x + r, y])} c`, 'h');
        }
      }
      ops.push(fill.alpha ? outline ? 'B' : 'f' : outline ? 'S' : 'n');
    }
  }
  ops.push('Q');
  const bb = bounds(geometry.map(transform));
  const rect = [bb.x - pad, bb.y - pad, bb.x + Math.max(bb.width, 0.01) + pad, bb.y + Math.max(bb.height, 0.01) + pad];
  if (!rect.every(finite)) throw new Error('Invalid transformed annotation bounds');
  set('Rect', ctx.obj(rect));
  if ((ann.type === 'rectangle' || ann.type === 'ellipse') && !angle) set('RD', ctx.obj([pad, pad, pad, pad]));
  const resources = ctx.obj({ ExtGState: states, ...(font ? { Font: { F0: font.ref } } : {}) });
  const stream = ctx.flateStream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources });
  set('AP', ctx.obj({ N: ctx.register(stream) }));
  return dict;
}

export async function syncNativeAnnotations(pdfDoc: PDFDocument, annotationsByPage: Record<number, Annotation[]>, unicodeFontProvider?: () => Promise<Uint8Array>): Promise<void> {
  let unicodeFont: PDFFont | undefined;
  const imported = entries(pdfDoc);
  const pages = pdfDoc.getPages();
  const fonts = new Map<StandardFonts, PDFFont>();
  const plans: Array<{ page: PDFPage; keep: PDFObject[]; replacements: Array<{ dict: PDFDict; ref?: PDFRef }> }> = [];
  for (const key of Object.keys(annotationsByPage)) {
    if (!/^\d+$/.test(key) || Number(key) >= pages.length || !Array.isArray(annotationsByPage[Number(key)])) throw new Error('Invalid annotation page');
  }
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const originals = imported.filter(e => e.pageIndex === pageIndex);
    const byId = new Map(originals.map(e => [e.annotation.id, e]));
    const originalIndices = new Set(originals.map(e => e.index));
    const annots = get(page.node, 'Annots');
    const candidates = (annotationsByPage[pageIndex] ?? []).filter(a => ['text', 'rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'freeform-shape', 'stamp'].includes(a.type) || (a.type === 'highlighter' && 'quadPoints' in a));
    if (!originals.length && !candidates.length) continue;
    if (annots !== undefined && !(annots instanceof PDFArray)) throw new Error('Cannot safely update malformed /Annots');
    const keep = annots instanceof PDFArray ? annots.asArray().filter((_, i) => !originalIndices.has(i)) : [];
    const replacements: Array<{ dict: PDFDict; ref?: PDFRef }> = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (!validModel(candidate) || candidate.pageIndex !== pageIndex) throw new Error(`Invalid or unsupported native annotation: ${candidate.id}`);
      if (ids.has(candidate.id)) throw new Error(`Duplicate annotation ID: ${candidate.id}`);
      ids.add(candidate.id);
      const ann = candidate;
      const original = byId.get(ann.id);
      if (original && number(original.dict, 'VEditorNative', 0) === 1 && text(get(original.dict, 'VEditorData')) === JSON.stringify(ann)) {
        replacements.push({ dict: original.dict, ref: original.raw instanceof PDFRef ? original.raw : undefined });
        continue;
      }
      let font: PDFFont | undefined;
      if (ann.type === 'text') {
        const fontName = standardFont(ann);
        font = fonts.get(fontName);
        if (!font) { font = await pdfDoc.embedFont(fontName); fonts.set(fontName, font); }
        try { for (const line of ann.text.split(/\r\n|\r|\n/)) font.encodeText(line); }
        catch {
          if (!unicodeFontProvider) throw new Error(`FreeText ${ann.id}: standard WinAnsi fonts cannot encode this text. Content was preserved; a Unicode font provider is required.`);
          if (!unicodeFont) {
            pdfDoc.registerFontkit(fontkit);
            unicodeFont = await pdfDoc.embedFont(await unicodeFontProvider(), { subset: true });
          }
          const supported = new Set(unicodeFont.getCharacterSet());
          if ([...ann.text].some(ch => !['\r', '\n'].includes(ch) && !supported.has(ch.codePointAt(0)!))) {
            throw new Error(`FreeText ${ann.id}: the bundled font does not contain every required character.`);
          }
          font = unicodeFont;
        }
      }
      replacements.push({ dict: build(pdfDoc, page, ann, original, font), ref: original?.raw instanceof PDFRef ? original.raw : undefined });
    }
    plans.push({ page, keep, replacements });
  }
  for (const { page, keep, replacements } of plans) {
    const refs = replacements.map(({ dict, ref }) => {
      if (ref) { pdfDoc.context.assign(ref, dict); return ref; }
      return pdfDoc.context.register(dict);
    });
    page.node.set(name('Annots'), pdfDoc.context.obj([...keep, ...refs]));
  }
}
