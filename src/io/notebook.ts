/**
 * Notebook PDF generator.
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
import { PaperStyle, PageSizeName, PAGE_SIZES } from '../core/types';

export const DEFAULT_PAPER: PaperStyle = {
  pattern: 'lined',
  spacing: 28,
  lineColor: '#c7d2e4',
  paperColor: '#ffffff',
  margin: false
};

/**
 * Ready-made papers offered in the notebook dialog. `id` doubles as the
 * translation key (`notebook.presets.<id>`), so a label lives in one place.
 */
export const PAPER_PRESETS: { id: string; paper: PaperStyle }[] = [
  { id: 'ruled', paper: { ...DEFAULT_PAPER } },
  { id: 'legal', paper: { pattern: 'lined', spacing: 26, lineColor: '#93b8d8', paperColor: '#fefbe8', margin: true } },
  { id: 'graph', paper: { pattern: 'grid', spacing: 18, lineColor: '#cfe0ee', paperColor: '#ffffff', margin: false } },
  { id: 'bullet', paper: { pattern: 'dots', spacing: 20, lineColor: '#b9c2d0', paperColor: '#fffdf9', margin: false } },
  { id: 'iso', paper: { pattern: 'isometric', spacing: 26, lineColor: '#d6d9e6', paperColor: '#ffffff', margin: false } },
  { id: 'dark', paper: { pattern: 'dots', spacing: 22, lineColor: '#3c4356', paperColor: '#151821', margin: false } },
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

/**
 * Draws one sheet of paper. Shared by the PDF generator and (via the same
 * geometry) the dialog preview, so the preview cannot drift from the output.
 */
export function paperGeometry(paper: PaperStyle, width: number, height: number) {
  const pad = 0;
  const step = Math.min(SPACING_MAX, Math.max(SPACING_MIN, paper.spacing));
  const lines: { x1: number; y1: number; x2: number; y2: number; thickness: number }[] = [];
  const dots: { x: number; y: number; r: number }[] = [];

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
    // Two families of 30-degree lines plus verticals: a true isometric field,
    // unlike the horizontal-only rules this used to draw.
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
  }

  // A margin rule only reads as one against horizontal rules.
  const marginX = paper.margin && paper.pattern === 'lined' ? Math.max(36, step * 2) : null;

  return { lines, dots, marginX, step };
}

function drawPage(
  page: ReturnType<PDFDocument['addPage']>,
  paper: PaperStyle,
  width: number,
  height: number
) {
  page.drawRectangle({ x: 0, y: 0, width, height, color: toRgb(paper.paperColor) });

  const ink = toRgb(paper.lineColor);
  const { lines, dots, marginX } = paperGeometry(paper, width, height);

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

  if (marginX !== null) {
    page.drawLine({
      start: { x: marginX, y: 0 },
      end: { x: marginX, y: height },
      thickness: 0.9,
      color: toRgb('#e8a0a8')
    });
  }
}

/** Builds the complete notebook PDF for a spec and page count. */
export async function buildNotebookPdf(
  paper: PaperStyle,
  pageSize: PageSizeName,
  pageCount: number
): Promise<Uint8Array> {
  const { width, height } = PAGE_SIZES[pageSize] ?? PAGE_SIZES.letter;
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < Math.max(1, pageCount); i++) {
    drawPage(pdfDoc.addPage([width, height]), paper, width, height);
  }

  return await pdfDoc.save();
}
