/**
 * Notebook PDF generator & Paper Template Catalog.
 *
 * A notebook is an ordinary PDF whose every page is drawn from a `PaperStyle`.
 * Keeping it a real PDF means the viewer, the annotation layers, storage and
 * export all treat it like any other document -- no special-case rendering --
 * and the paper you draw on is the paper you export.
 *
 * Because the bytes are fully derived from the spec plus a page count, adding
 * pages or restyling the paper is just a rebuild; see src/core/notebook.ts.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import {
  PaperStyle,
  PaperPattern,
  PageSizeName,
  NotebookCoverSpec,
  NotebookOrientation,
  resolveNotebookPageDimensions
} from '../core/types';
import { drawNotebookCoverPage, hasNotebookCover } from './notebook-covers';

export const DEFAULT_PAPER: PaperStyle = {
  pattern: 'lined',
  spacing: 28,
  lineColor: '#c7d2e4',
  paperColor: '#ffffff',
  margin: false
};

export type PaperToneId = 'white' | 'yellow' | 'dark' | 'warm';

export interface PaperToneSpec {
  id: PaperToneId;
  label: string;
  labelFa: string;
  paperColor: string;
  lineColor: string;
  marginColor: string;
}

export const PAPER_TONES: PaperToneSpec[] = [
  {
    id: 'white',
    label: 'White Paper',
    labelFa: 'کاغذ سفید',
    paperColor: '#ffffff',
    lineColor: '#c7d2e4',
    marginColor: '#e8a0a8'
  },
  {
    id: 'yellow',
    label: 'Yellow Paper',
    labelFa: 'کاغذ زرد',
    paperColor: '#fefbe8',
    lineColor: '#93b8d8',
    marginColor: '#e5929b'
  },
  {
    id: 'warm',
    label: 'Warm Paper',
    labelFa: 'کاغذ کرم',
    paperColor: '#faf6ee',
    lineColor: '#d1c7b7',
    marginColor: '#dc9999'
  },
  {
    id: 'dark',
    label: 'Dark Paper',
    labelFa: 'کاغذ تیره',
    paperColor: '#1f2126',
    lineColor: '#3b404c',
    marginColor: '#8f4b56'
  }
];

export type PaperTemplateCategory = 'essentials' | 'writing' | 'planner';

export interface PaperTemplateSpec {
  id: string;
  category: PaperTemplateCategory;
  label: string;
  labelFa: string;
  pattern: PaperPattern;
  spacing: number;
  margin: boolean;
}

export const PAPER_TEMPLATES: PaperTemplateSpec[] = [
  // Essentials
  { id: 'blank', category: 'essentials', label: 'Blank', labelFa: 'ساده', pattern: 'blank', spacing: 28, margin: false },
  { id: 'dotted', category: 'essentials', label: 'Dotted Paper', labelFa: 'نقطه‌ای', pattern: 'dots', spacing: 20, margin: false },
  { id: 'ruled-narrow', category: 'essentials', label: 'Ruled Narrow', labelFa: 'خط‌دار ریز', pattern: 'lined', spacing: 20, margin: false },
  { id: 'ruled-wide', category: 'essentials', label: 'Ruled Wide', labelFa: 'خط‌دار درشت', pattern: 'lined', spacing: 32, margin: false },
  { id: 'squared', category: 'essentials', label: 'Squared Paper', labelFa: 'شطرنجی', pattern: 'grid', spacing: 18, margin: false },
  { id: 'isometric', category: 'essentials', label: 'Isometric', labelFa: 'ایزومتریک', pattern: 'isometric', spacing: 26, margin: false },

  // Writing papers
  { id: 'cornell', category: 'writing', label: 'Cornell', labelFa: 'کرنل (Cornell)', pattern: 'cornell', spacing: 24, margin: false },
  { id: 'legal', category: 'writing', label: 'Legal', labelFa: 'حاشیه‌دار (Legal)', pattern: 'lined', spacing: 26, margin: true },
  { id: 'single-column', category: 'writing', label: 'Single Column', labelFa: 'تک‌ستونی', pattern: 'lined', spacing: 28, margin: false },
  { id: 'two-column', category: 'writing', label: 'Two Column', labelFa: 'دوستونی', pattern: 'two-column', spacing: 24, margin: false },
  { id: 'three-column', category: 'writing', label: 'Three Column', labelFa: 'سه‌ستونی', pattern: 'three-column', spacing: 24, margin: false },

  // Planner
  { id: 'weekly', category: 'planner', label: 'Weekly Grid', labelFa: 'برنامه‌ریز هفتگی', pattern: 'weekly', spacing: 24, margin: false },
  { id: 'checklist', category: 'planner', label: 'Checklist', labelFa: 'فهرست کارها', pattern: 'checklist', spacing: 26, margin: false }
];

export function getPaperToneById(id?: string | null): PaperToneSpec {
  return PAPER_TONES.find(t => t.id === id) ?? PAPER_TONES[0];
}

/** Infers the closest PaperToneId from an arbitrary paper hex color. */
export function inferPaperToneId(paperColor: string): PaperToneId {
  const norm = paperColor.trim().toLowerCase();
  const exact = PAPER_TONES.find(t => t.paperColor.toLowerCase() === norm);
  if (exact) return exact.id;
  const m = /^#?([0-9a-f]{6})$/i.exec(norm);
  if (!m) return 'white';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.35) return 'dark';
  if (r > 235 && g > 230 && b < 236 && (r - b) >= 14) return 'yellow';
  if (r > 232 && g > 225 && b < 245 && (r - b) >= 6) return 'warm';
  return 'white';
}

export function paperStyleForTemplate(
  template: PaperTemplateSpec,
  tone: PaperToneSpec
): PaperStyle {
  return {
    pattern: template.pattern,
    spacing: template.spacing,
    paperColor: tone.paperColor,
    lineColor: tone.lineColor,
    margin: template.margin
  };
}

export function findMatchingPaperTemplate(paper: PaperStyle): PaperTemplateSpec | null {
  for (const tpl of PAPER_TEMPLATES) {
    if (tpl.pattern !== paper.pattern) continue;
    if (paper.pattern === 'blank') return tpl;
    if (paper.pattern === 'lined') {
      if (Boolean(tpl.margin) !== Boolean(paper.margin)) continue;
      if (Math.abs(tpl.spacing - paper.spacing) <= 2) return tpl;
    } else {
      return tpl;
    }
  }
  return PAPER_TEMPLATES.find(tpl => tpl.pattern === paper.pattern) ?? null;
}

/**
 * Ready-made papers offered in quick-create shortcuts and legacy presets.
 * `id` doubles as the translation key (`notebook.presets.<id>`).
 */
export const PAPER_PRESETS: { id: string; paper: PaperStyle }[] = [
  { id: 'ruled', paper: { ...DEFAULT_PAPER } },
  { id: 'legal', paper: { pattern: 'lined', spacing: 26, lineColor: '#93b8d8', paperColor: '#fefbe8', margin: true } },
  { id: 'graph', paper: { pattern: 'grid', spacing: 18, lineColor: '#cfe0ee', paperColor: '#ffffff', margin: false } },
  { id: 'bullet', paper: { pattern: 'dots', spacing: 20, lineColor: '#b9c2d0', paperColor: '#fffdf9', margin: false } },
  { id: 'iso', paper: { pattern: 'isometric', spacing: 26, lineColor: '#d6d9e6', paperColor: '#ffffff', margin: false } },
  { id: 'dark', paper: { pattern: 'dots', spacing: 22, lineColor: '#3b404c', paperColor: '#1f2126', margin: false } },
  { id: 'blank', paper: { pattern: 'blank', spacing: 28, lineColor: '#c7d2e4', paperColor: '#ffffff', margin: false } }
];

/** Spacing bounds, shared by the dialog slider and the generator. */
export const SPACING_MIN = 8;
export const SPACING_MAX = 64;

function toRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export interface PaperLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

export interface PaperDot {
  x: number;
  y: number;
  r: number;
}

export interface PaperRect {
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
}

/**
 * Computes exact vector geometry for one sheet of paper. Shared by the PDF
 * generator and the dialog preview, so the preview cannot drift from the output.
 */
export function paperGeometry(paper: PaperStyle, width: number, height: number) {
  const pad = 0;
  const step = Math.min(SPACING_MAX, Math.max(SPACING_MIN, paper.spacing));
  const lines: PaperLineSegment[] = [];
  const dots: PaperDot[] = [];
  const rects: PaperRect[] = [];

  if (paper.pattern === 'lined') {
    for (let y = step; y < height - pad; y += step) {
      lines.push({ x1: pad, y1: y, x2: width - pad, y2: y, thickness: 0.6 });
    }
  } else if (paper.pattern === 'grid') {
    for (let x = step; x < width - pad; x += step) {
      lines.push({ x1: x, y1: pad, x2: x, y2: height - pad, thickness: 0.5 });
    }
    for (let y = step; y < height - pad; y += step) {
      lines.push({ x1: pad, y1: y, x2: width - pad, y2: y, thickness: 0.5 });
    }
  } else if (paper.pattern === 'dots') {
    for (let x = step; x < width - pad; x += step) {
      for (let y = step; y < height - pad; y += step) {
        dots.push({ x, y, r: 1.1 });
      }
    }
  } else if (paper.pattern === 'isometric') {
    const dx = step * Math.cos(Math.PI / 6);
    const dy = step * Math.sin(Math.PI / 6);
    const slope = dy / dx;
    const span = height / slope;
    for (let x = -span; x < width + span; x += step) {
      lines.push({ x1: x, y1: 0, x2: x + span, y2: height, thickness: 0.45 });
      lines.push({ x1: x, y1: 0, x2: x - span, y2: height, thickness: 0.45 });
    }
    for (let x = step; x < width; x += step * 2) {
      lines.push({ x1: x, y1: 0, x2: x, y2: height, thickness: 0.45 });
    }
  } else if (paper.pattern === 'cornell') {
    const topBand = Math.round(height * 0.13);
    const bottomBand = Math.round(height * 0.84);
    const cueX = Math.round(width * 0.27);
    const inset = Math.max(18, Math.round(width * 0.04));

    // Structural dividers (header, cue column, summary band)
    lines.push({ x1: inset, y1: topBand, x2: width - inset, y2: topBand, thickness: 1.0 });
    lines.push({ x1: inset, y1: bottomBand, x2: width - inset, y2: bottomBand, thickness: 1.0 });
    lines.push({ x1: cueX, y1: topBand, x2: cueX, y2: bottomBand, thickness: 1.0 });

    // Ruled note lines inside the right notes column
    for (let y = topBand + step; y < bottomBand - 4; y += step) {
      lines.push({ x1: cueX + 8, y1: y, x2: width - inset, y2: y, thickness: 0.5 });
    }
    // Subtle summary lines at bottom
    for (let y = bottomBand + step; y < height - inset; y += step) {
      lines.push({ x1: inset, y1: y, x2: width - inset, y2: y, thickness: 0.45 });
    }
  } else if (paper.pattern === 'two-column') {
    const topPad = Math.round(height * 0.08);
    const inset = Math.max(20, Math.round(width * 0.045));
    const gutter = Math.max(14, Math.round(width * 0.03));
    const midX = width * 0.5;
    lines.push({ x1: midX, y1: topPad, x2: midX, y2: height - inset, thickness: 0.9 });
    for (let y = topPad + step; y < height - inset; y += step) {
      lines.push({ x1: inset, y1: y, x2: midX - gutter * 0.5, y2: y, thickness: 0.55 });
      lines.push({ x1: midX + gutter * 0.5, y1: y, x2: width - inset, y2: y, thickness: 0.55 });
    }
  } else if (paper.pattern === 'three-column') {
    const topPad = Math.round(height * 0.08);
    const inset = Math.max(18, Math.round(width * 0.04));
    const gutter = Math.max(10, Math.round(width * 0.02));
    const colW = (width - inset * 2) / 3;
    const x1 = inset + colW;
    const x2 = inset + colW * 2;
    lines.push({ x1, y1: topPad, x2: x1, y2: height - inset, thickness: 0.85 });
    lines.push({ x1: x2, y1: topPad, x2, y2: height - inset, thickness: 0.85 });
    for (let y = topPad + step; y < height - inset; y += step) {
      lines.push({ x1: inset, y1: y, x2: x1 - gutter * 0.5, y2: y, thickness: 0.5 });
      lines.push({ x1: x1 + gutter * 0.5, y1: y, x2: x2 - gutter * 0.5, y2: y, thickness: 0.5 });
      lines.push({ x1: x2 + gutter * 0.5, y1: y, x2: width - inset, y2: y, thickness: 0.5 });
    }
  } else if (paper.pattern === 'weekly') {
    const inset = Math.max(24, Math.round(width * 0.05));
    const headerY = Math.round(height * 0.11);
    const gridTop = headerY + Math.round(height * 0.03);
    const gridBottom = height - inset;
    const gridW = width - inset * 2;
    const gridH = gridBottom - gridTop;

    // Header title line
    lines.push({ x1: inset, y1: headerY, x2: width - inset, y2: headerY, thickness: 1.0 });
    // Outer planner grid frame
    rects.push({ x: inset, y: gridTop, width: gridW, height: gridH, thickness: 0.9 });

    // 7 vertical columns (Mon-Sun)
    const cols = 7;
    const colW = gridW / cols;
    for (let c = 1; c < cols; c++) {
      const cx = inset + colW * c;
      lines.push({ x1: cx, y1: gridTop, x2: cx, y2: gridBottom, thickness: 0.55 });
    }

    // Header row + horizontal time slots
    const subHeaderY = gridTop + Math.max(20, Math.round(step * 1.1));
    lines.push({ x1: inset, y1: subHeaderY, x2: width - inset, y2: subHeaderY, thickness: 0.85 });
    for (let y = subHeaderY + step; y < gridBottom - 4; y += step) {
      lines.push({ x1: inset, y1: y, x2: width - inset, y2: y, thickness: 0.5 });
    }
  } else if (paper.pattern === 'checklist') {
    const inset = Math.max(28, Math.round(width * 0.06));
    const headerY = Math.round(height * 0.11);
    const boxSize = Math.min(12, Math.max(7, Math.round(step * 0.42)));
    const lineStartX = inset + boxSize + 10;

    // Title divider
    lines.push({ x1: inset, y1: headerY, x2: width - inset, y2: headerY, thickness: 1.0 });

    for (let y = headerY + step; y < height - inset; y += step) {
      rects.push({
        x: inset,
        y: y - boxSize - 2,
        width: boxSize,
        height: boxSize,
        thickness: 0.75
      });
      lines.push({ x1: lineStartX, y1: y, x2: width - inset, y2: y, thickness: 0.55 });
    }
  }

  // A margin rule only reads as one against horizontal rules.
  const marginX = paper.margin && paper.pattern === 'lined' ? Math.max(36, step * 2) : null;

  return { lines, dots, rects, marginX, step };
}

function drawPage(
  page: ReturnType<PDFDocument['addPage']>,
  paper: PaperStyle,
  width: number,
  height: number
) {
  page.drawRectangle({ x: 0, y: 0, width, height, color: toRgb(paper.paperColor) });

  const ink = toRgb(paper.lineColor);
  const { lines, dots, rects, marginX } = paperGeometry(paper, width, height);

  for (const l of lines) {
    page.drawLine({
      start: { x: l.x1, y: height - l.y1 },
      end: { x: l.x2, y: height - l.y2 },
      thickness: l.thickness,
      color: ink
    });
  }

  for (const d of dots) {
    page.drawCircle({ x: d.x, y: height - d.y, size: d.r, color: ink });
  }

  for (const rc of rects) {
    page.drawRectangle({
      x: rc.x,
      y: height - rc.y - rc.height,
      width: rc.width,
      height: rc.height,
      borderColor: ink,
      borderWidth: rc.thickness
    });
  }

  if (marginX !== null) {
    const tone = getPaperToneById(inferPaperToneId(paper.paperColor));
    page.drawLine({
      start: { x: marginX, y: 0 },
      end: { x: marginX, y: height },
      thickness: 0.9,
      color: toRgb(tone.marginColor)
    });
  }
}

export interface BuildNotebookPdfOptions {
  cover?: NotebookCoverSpec | null;
  orientation?: NotebookOrientation;
}

/**
 * Builds the complete notebook PDF for a spec and paper page count.
 * When `options.cover` is active (not `'none'`), Page 1 (index 0) is rendered as
 * the matching vector book cover followed by `paperPageCount` paper sheets.
 */
export async function buildNotebookPdf(
  paper: PaperStyle,
  pageSize: PageSizeName,
  paperPageCount: number,
  options?: BuildNotebookPdfOptions
): Promise<Uint8Array> {
  const { width, height } = resolveNotebookPageDimensions(pageSize, options?.orientation ?? 'portrait');
  const pdfDoc = await PDFDocument.create();

  if (options?.cover && hasNotebookCover(options.cover)) {
    drawNotebookCoverPage(pdfDoc.addPage([width, height]), options.cover, width, height);
  }

  for (let i = 0; i < Math.max(1, paperPageCount); i++) {
    drawPage(pdfDoc.addPage([width, height]), paper, width, height);
  }

  return await pdfDoc.save();
}
