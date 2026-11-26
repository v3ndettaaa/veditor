/**
 * Notebook Cover Catalog, Vector SVG Renderer, PDF Page-1 Drawer & Safe Page Remapper.
 *
 * Pure module shared by:
 * - Notebook Studio creation/editing modal (Common, Simple, Solid, Textured + No cover)
 * - Document Library (Gallery cards & List rows)
 * - PDF Notebook Generator (`pdf-lib` Page 1 vector cover)
 * - Post-creation notebook cover restyling (with safe annotation/layer page-index shifting)
 */

import { PDFDocument, rgb } from 'pdf-lib';
import {
  Annotation,
  Layer,
  NotebookCoverCategory,
  NotebookCoverSpec,
  NotebookSpec,
  UserBookmarkItem
} from '../core/types';

export const NO_COVER_SPEC: NotebookCoverSpec = {
  id: 'none',
  category: 'none',
  label: 'No cover',
  labelFa: 'بدون کاور',
  bgColor: 'transparent',
  accentColor: 'transparent',
  pattern: 'none'
};

export const NOTEBOOK_COVERS: readonly NotebookCoverSpec[] = [
  NO_COVER_SPEC,

  // ── Simple (Kraft & Charcoal editorial bindings matching reference) ──────
  {
    id: 'simple-ivory',
    category: 'simple',
    label: 'Simple',
    labelFa: 'ساده عاجی',
    bgColor: '#8d7f6d',
    accentColor: '#d9d3c7',
    spineColor: '#e4dfd6',
    inkColor: '#d7cfc2',
    pattern: 'simple-ruled'
  },
  {
    id: 'simple-lime',
    category: 'simple',
    label: 'Simple Lime',
    labelFa: 'ساده لیمویی',
    bgColor: '#8d7f6d',
    accentColor: '#c9d749',
    spineColor: '#c5d344',
    inkColor: '#d7cfc2',
    pattern: 'simple-ruled'
  },
  {
    id: 'simple-allblack',
    category: 'simple',
    label: 'Simple Allblack',
    labelFa: 'مشکی یکدست',
    bgColor: '#2d3138',
    accentColor: '#6d7380',
    spineColor: '#0e1014',
    inkColor: '#88909e',
    pattern: 'simple-ruled'
  },
  {
    id: 'simple-black',
    category: 'simple',
    label: 'Simple Black',
    labelFa: 'ساده مشکی',
    bgColor: '#8d7f6d',
    accentColor: '#2c3037',
    spineColor: '#23262b',
    inkColor: '#d7cfc2',
    pattern: 'simple-ruled'
  },
  {
    id: 'simple-blue',
    category: 'simple',
    label: 'Simple Blue',
    labelFa: 'ساده آبی',
    bgColor: '#8d7f6d',
    accentColor: '#5c86d6',
    spineColor: '#5782d4',
    inkColor: '#d7cfc2',
    pattern: 'simple-ruled'
  },
  {
    id: 'simple-green',
    category: 'simple',
    label: 'Simple Green',
    labelFa: 'ساده سبز',
    bgColor: '#8d7f6d',
    accentColor: '#6a9b64',
    spineColor: '#679961',
    inkColor: '#d7cfc2',
    pattern: 'simple-ruled'
  },

  // ── Solid (Matte hardcovers with vertical elastic closure band) ──────────
  {
    id: 'solid-babyblue',
    category: 'solid',
    label: 'Solid Babyblue',
    labelFa: 'آبی آسمانی',
    bgColor: '#88a9d2',
    accentColor: '#226ad8',
    spineColor: '#7698c4',
    inkColor: '#eef5ff',
    pattern: 'solid-band'
  },
  {
    id: 'solid-navy',
    category: 'solid',
    label: 'Solid Navy',
    labelFa: 'سرمه‌ای کلاسیک',
    bgColor: '#0d3e78',
    accentColor: '#98c1ea',
    spineColor: '#09305f',
    inkColor: '#dcecff',
    pattern: 'solid-band'
  },
  {
    id: 'solid-sage',
    category: 'solid',
    label: 'Solid Sage',
    labelFa: 'سبز مریم‌گلی',
    bgColor: '#698e59',
    accentColor: '#8ec060',
    spineColor: '#597c4a',
    inkColor: '#eef8e8',
    pattern: 'solid-band'
  },
  {
    id: 'solid-charcoal',
    category: 'solid',
    label: 'Solid Charcoal',
    labelFa: 'زغالی لیمویی',
    bgColor: '#2c3037',
    accentColor: '#82be24',
    spineColor: '#20242a',
    inkColor: '#e5e9f0',
    pattern: 'solid-band'
  },
  {
    id: 'solid-rose',
    category: 'solid',
    label: 'Solid Rose',
    labelFa: 'رز کدر',
    bgColor: '#caaeb0',
    accentColor: '#d75544',
    spineColor: '#b7989a',
    inkColor: '#fdf2f2',
    pattern: 'solid-band'
  },
  {
    id: 'solid-terracotta',
    category: 'solid',
    label: 'Solid Terracotta',
    labelFa: 'سفالی گرم',
    bgColor: '#9f5b58',
    accentColor: '#d98f56',
    spineColor: '#884a47',
    inkColor: '#fceee8',
    pattern: 'solid-band'
  },

  // ── Textured (Editorial vector textures crisp at every DPI) ──────────────
  {
    id: 'textured-linen',
    category: 'textured',
    label: 'Woven Linen',
    labelFa: 'کتان بافت‌دار',
    bgColor: '#dfd6c7',
    accentColor: '#b8aa95',
    spineColor: '#4c3e33',
    inkColor: '#524438',
    pattern: 'linen'
  },
  {
    id: 'textured-blueprint',
    category: 'textured',
    label: 'Blueprint',
    labelFa: 'نقشه معماری',
    bgColor: '#16365c',
    accentColor: '#68b4f2',
    spineColor: '#0f2642',
    inkColor: '#a8d5fb',
    pattern: 'blueprint'
  },
  {
    id: 'textured-dotfoil',
    category: 'textured',
    label: 'Noir Gold Foil',
    labelFa: 'نقطه‌کوبی طلایی',
    bgColor: '#1a1d24',
    accentColor: '#d4af62',
    spineColor: '#101217',
    inkColor: '#e6c881',
    pattern: 'dot-foil'
  },
  {
    id: 'textured-terrazzo',
    category: 'textured',
    label: 'Soft Terrazzo',
    labelFa: 'بافت ترازو',
    bgColor: '#f0ece4',
    accentColor: '#c9785d',
    spineColor: '#313640',
    inkColor: '#424854',
    pattern: 'terrazzo'
  }
];

export const DEFAULT_NOTEBOOK_COVER_ID = 'simple-allblack';

export const COMMON_COVER_IDS: readonly string[] = [
  'none',
  'simple-allblack',
  'simple-black',
  'solid-babyblue'
];

export function getNotebookCoverById(id?: string | null): NotebookCoverSpec {
  if (!id) return NO_COVER_SPEC;
  return NOTEBOOK_COVERS.find(c => c.id === id) ?? NO_COVER_SPEC;
}

export function getDefaultNotebookCover(): NotebookCoverSpec {
  return getNotebookCoverById(DEFAULT_NOTEBOOK_COVER_ID);
}

export function getCoversByCategory(category: Exclude<NotebookCoverCategory, 'none'>): NotebookCoverSpec[] {
  return NOTEBOOK_COVERS.filter(c => c.category === category);
}

export function getCommonCovers(): NotebookCoverSpec[] {
  return COMMON_COVER_IDS.map(id => getNotebookCoverById(id));
}

/** True when a notebook spec or cover spec represents an active physical cover page. */
export function hasNotebookCover(specOrCover?: NotebookSpec | NotebookCoverSpec | null): boolean {
  if (!specOrCover) return false;
  const cover = 'paper' in specOrCover ? specOrCover.cover : specOrCover;
  return Boolean(cover && cover.category !== 'none' && cover.id !== 'none');
}

export function getCoverDisplayName(cover: NotebookCoverSpec | null | undefined, lang: 'en' | 'fa'): string {
  const c = cover ?? NO_COVER_SPEC;
  return lang === 'fa' ? c.labelFa : c.label;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.18, 0.2, 0.23];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toPdfRgb(hex: string) {
  const [r, g, b] = hexToRgbTuple(hex);
  return rgb(r, g, b);
}

/**
 * Deterministic terrazzo geometric shards (normalized 0..1 coordinates) shared
 * between the UI SVG renderer and the PDF Page-1 vector drawer.
 */
const TERRAZZO_SHARDS: ReadonlyArray<{ x: number; y: number; r: number; color: string }> = [
  { x: 0.22, y: 0.14, r: 0.022, color: '#c9785d' },
  { x: 0.42, y: 0.11, r: 0.015, color: '#64748b' },
  { x: 0.68, y: 0.16, r: 0.024, color: '#7a9b76' },
  { x: 0.82, y: 0.24, r: 0.016, color: '#d4a373' },
  { x: 0.31, y: 0.30, r: 0.019, color: '#334155' },
  { x: 0.56, y: 0.28, r: 0.017, color: '#c9785d' },
  { x: 0.75, y: 0.42, r: 0.022, color: '#64748b' },
  { x: 0.26, y: 0.48, r: 0.023, color: '#7a9b76' },
  { x: 0.48, y: 0.54, r: 0.016, color: '#d4a373' },
  { x: 0.81, y: 0.60, r: 0.019, color: '#c9785d' },
  { x: 0.35, y: 0.69, r: 0.021, color: '#334155' },
  { x: 0.62, y: 0.72, r: 0.017, color: '#7a9b76' },
  { x: 0.24, y: 0.84, r: 0.018, color: '#d4a373' },
  { x: 0.51, y: 0.86, r: 0.022, color: '#c9785d' },
  { x: 0.76, y: 0.82, r: 0.015, color: '#64748b' }
];

/**
 * Renders a razor-sharp proportional vector SVG representing a hardcover notebook.
 * Used identically across the Create/Edit Notebook Studio, preview rail, and Library cards.
 */
export function renderNotebookCoverSvg(
  cover: NotebookCoverSpec,
  opts?: {
    title?: string;
    landscape?: boolean;
    compact?: boolean;
  }
): string {
  const isLand = Boolean(opts?.landscape);
  const vw = isLand ? 160 : 120;
  const vh = isLand ? 120 : 160;

  if (cover.category === 'none' || cover.id === 'none') {
    return `
      <svg class="nb-cover-svg is-none" viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="3" y="3" width="${vw - 6}" height="${vh - 6}" rx="6" fill="none"
              stroke="currentColor" stroke-opacity="0.28" stroke-width="1.6" stroke-dasharray="5 4"/>
      </svg>
    `;
  }

  const spineW = Math.round(vw * 0.085);
  const pageEdgeW = Math.max(3, Math.round(vw * 0.032));
  const bodyW = vw - pageEdgeW;
  const ink = cover.inkColor || '#ffffff';
  const spine = cover.spineColor || cover.accentColor;

  let detailSvg = '';

  if (cover.pattern === 'simple-ruled') {
    const lineY = Math.round(vh * 0.245);
    const lineX1 = spineW + Math.round(vw * 0.09);
    const lineX2 = bodyW - Math.round(vw * 0.09);
    const boxX = bodyW - Math.round(vw * 0.25);
    const boxY = vh - Math.round(vh * 0.23);
    const boxW = Math.round(vw * 0.16);
    const step = Math.max(4, Math.round(vh * 0.036));
    detailSvg = `
      <rect x="0" y="0" width="${spineW}" height="${vh}" fill="${spine}" />
      <rect x="${spineW}" y="0" width="1.2" height="${vh}" fill="#000000" fill-opacity="0.22" />
      <line x1="${lineX1}" y1="${lineY}" x2="${lineX2}" y2="${lineY}" stroke="${ink}" stroke-opacity="0.55" stroke-width="1.15" />
      <g stroke="${ink}" stroke-opacity="0.5" stroke-width="1">
        <line x1="${boxX}" y1="${boxY}" x2="${boxX + boxW}" y2="${boxY}" />
        <line x1="${boxX}" y1="${boxY + step}" x2="${boxX + boxW}" y2="${boxY + step}" />
        <line x1="${boxX}" y1="${boxY + step * 2}" x2="${boxX + boxW}" y2="${boxY + step * 2}" />
        <line x1="${boxX}" y1="${boxY + step * 3}" x2="${boxX + boxW * 0.85}" y2="${boxY + step * 3}" />
        <line x1="${boxX + boxW * 0.85}" y1="${boxY + step * 3}" x2="${boxX + boxW}" y2="${boxY + step * 2.4}" />
      </g>
    `;
  } else if (cover.pattern === 'solid-band') {
    const bandW = Math.max(5, Math.round(vw * 0.055));
    const bandX = bodyW - Math.round(vw * 0.13);
    detailSvg = `
      <rect x="0" y="0" width="${Math.max(4, Math.round(vw * 0.03))}" height="${vh}" fill="${spine}" fill-opacity="0.7" />
      <rect x="${Math.max(4, Math.round(vw * 0.03))}" y="0" width="1" height="${vh}" fill="#000000" fill-opacity="0.16" />
      <rect x="${bandX - 1}" y="0" width="${bandW + 2}" height="${vh}" fill="#000000" fill-opacity="0.14" />
      <rect x="${bandX}" y="0" width="${bandW}" height="${vh}" fill="${cover.accentColor}" />
    `;
  } else if (cover.pattern === 'linen') {
    const weaveLines: string[] = [];
    for (let x = spineW + 6; x < bodyW; x += 6) {
      weaveLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${vh}" />`);
    }
    for (let y = 6; y < vh; y += 6) {
      weaveLines.push(`<line x1="${spineW}" y1="${y}" x2="${bodyW}" y2="${y}" />`);
    }
    const plateX = spineW + Math.round((bodyW - spineW) * 0.16);
    const plateW = Math.round((bodyW - spineW) * 0.68);
    const plateY = Math.round(vh * 0.2);
    const plateH = Math.round(vh * 0.18);
    detailSvg = `
      <g stroke="${cover.accentColor}" stroke-opacity="0.34" stroke-width="0.7">
        ${weaveLines.join('')}
      </g>
      <rect x="0" y="0" width="${spineW}" height="${vh}" fill="${spine}" />
      <rect x="${spineW}" y="0" width="1.2" height="${vh}" fill="#000000" fill-opacity="0.24" />
      <rect x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" rx="2.5"
            fill="#faf6ef" fill-opacity="0.92" stroke="${spine}" stroke-opacity="0.3" stroke-width="0.9" />
      <line x1="${plateX + 8}" y1="${plateY + plateH * 0.45}" x2="${plateX + plateW - 8}" y2="${plateY + plateH * 0.45}"
            stroke="${ink}" stroke-opacity="0.45" stroke-width="1.2" />
      <line x1="${plateX + 14}" y1="${plateY + plateH * 0.72}" x2="${plateX + plateW - 14}" y2="${plateY + plateH * 0.72}"
            stroke="${ink}" stroke-opacity="0.3" stroke-width="1" />
    `;
  } else if (cover.pattern === 'blueprint') {
    const gridLines: string[] = [];
    for (let x = spineW + 10; x < bodyW; x += 10) {
      gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${vh}" />`);
    }
    for (let y = 10; y < vh; y += 10) {
      gridLines.push(`<line x1="${spineW}" y1="${y}" x2="${bodyW}" y2="${y}" />`);
    }
    const pad = 10;
    detailSvg = `
      <g stroke="${cover.accentColor}" stroke-opacity="0.22" stroke-width="0.65">
        ${gridLines.join('')}
      </g>
      <rect x="0" y="0" width="${spineW}" height="${vh}" fill="${spine}" />
      <rect x="${spineW + pad}" y="${pad}" width="${bodyW - spineW - pad * 2}" height="${vh - pad * 2}"
            fill="none" stroke="${ink}" stroke-opacity="0.52" stroke-width="0.9" />
      <rect x="${spineW + pad + 3}" y="${pad + 3}" width="${bodyW - spineW - pad * 2 - 6}" height="${vh - pad * 2 - 6}"
            fill="none" stroke="${ink}" stroke-opacity="0.26" stroke-width="0.6" />
      <circle cx="${spineW + (bodyW - spineW) * 0.5}" cy="${vh * 0.42}" r="${Math.min(vw, vh) * 0.14}"
              fill="none" stroke="${ink}" stroke-opacity="0.45" stroke-width="0.9" />
      <line x1="${spineW + pad + 10}" y1="${vh * 0.72}" x2="${bodyW - pad - 10}" y2="${vh * 0.72}"
            stroke="${ink}" stroke-opacity="0.55" stroke-width="1" />
    `;
  } else if (cover.pattern === 'dot-foil') {
    const dots: string[] = [];
    for (let y = 16; y < vh - 12; y += 14) {
      for (let x = spineW + 12; x < bodyW - 8; x += 14) {
        dots.push(`<circle cx="${x}" cy="${y}" r="1.05" />`);
      }
    }
    const cx = spineW + (bodyW - spineW) * 0.5;
    const cy = vh * 0.34;
    detailSvg = `
      <g fill="${cover.accentColor}" fill-opacity="0.34">
        ${dots.join('')}
      </g>
      <rect x="0" y="0" width="${spineW}" height="${vh}" fill="${spine}" />
      <rect x="${spineW}" y="0" width="1.2" height="${vh}" fill="${cover.accentColor}" fill-opacity="0.45" />
      <polygon points="${cx},${cy - 10} ${cx + 10},${cy} ${cx},${cy + 10} ${cx - 10},${cy}"
               fill="none" stroke="${cover.accentColor}" stroke-width="1.2" stroke-opacity="0.9" />
      <line x1="${cx - 22}" y1="${cy + 20}" x2="${cx + 22}" y2="${cy + 20}"
            stroke="${cover.accentColor}" stroke-width="1" stroke-opacity="0.7" />
    `;
  } else if (cover.pattern === 'terrazzo') {
    const shards = TERRAZZO_SHARDS.map(s => {
      const sx = spineW + s.x * (bodyW - spineW);
      const sy = s.y * vh;
      const r = s.r * Math.min(vw, vh);
      return `<polygon points="${sx - r},${sy - r * 0.4} ${sx + r * 0.7},${sy - r} ${sx + r},${sy + r * 0.5} ${sx - r * 0.3},${sy + r * 0.9}" fill="${s.color}" fill-opacity="0.72" />`;
    }).join('');
    detailSvg = `
      ${shards}
      <rect x="0" y="0" width="${spineW}" height="${vh}" fill="${spine}" />
      <rect x="${spineW}" y="0" width="1.2" height="${vh}" fill="#000000" fill-opacity="0.2" />
    `;
  }

  const cleanTitle = opts?.title?.trim();
  const titleMarkup = cleanTitle && !opts?.compact
    ? `<text x="${spineW + (bodyW - spineW) * 0.5}" y="${Math.round(vh * 0.21)}"
             text-anchor="middle" fill="${ink}" fill-opacity="0.92"
             font-size="${Math.max(8, Math.round(vw * 0.075))}" font-weight="600"
             font-family="system-ui, -apple-system, sans-serif">${escapeXml(cleanTitle.slice(0, 18))}</text>`
    : '';

  return `
    <svg class="nb-cover-svg" viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <clipPath id="nb-clip-${cover.id}-${vw}x${vh}">
          <rect x="0" y="0" width="${vw}" height="${vh}" rx="4" />
        </clipPath>
      </defs>
      <g clip-path="url(#nb-clip-${cover.id}-${vw}x${vh})">
        <!-- Page block edge peeking on the right -->
        <rect x="${bodyW - 2}" y="2" width="${pageEdgeW + 2}" height="${vh - 4}" rx="1.5" fill="#e6e6e8" />
        <line x1="${bodyW + pageEdgeW * 0.4}" y1="3" x2="${bodyW + pageEdgeW * 0.4}" y2="${vh - 3}" stroke="#c9cbd0" stroke-width="0.7" />
        <!-- Front hardcover board -->
        <rect x="0" y="0" width="${bodyW}" height="${vh}" rx="2" fill="${cover.bgColor}" />
        ${detailSvg}
        ${titleMarkup}
        <!-- Subtle top highlight & right board bevel -->
        <rect x="0" y="0" width="${bodyW}" height="1.2" fill="#ffffff" fill-opacity="0.16" />
        <rect x="${bodyW - 1}" y="0" width="1" height="${vh}" fill="#000000" fill-opacity="0.2" />
      </g>
    </svg>
  `;
}

/**
 * Draws the vector cover page directly into Page 1 of a generated `pdf-lib` document.
 * Geometry and palette match `renderNotebookCoverSvg()` 1:1.
 */
export function drawNotebookCoverPage(
  page: ReturnType<PDFDocument['addPage']>,
  cover: NotebookCoverSpec,
  width: number,
  height: number
): void {
  if (cover.category === 'none' || cover.id === 'none') return;

  const spineW = Math.round(width * 0.085);
  const bg = toPdfRgb(cover.bgColor);
  const accent = toPdfRgb(cover.accentColor);
  const spine = toPdfRgb(cover.spineColor || cover.accentColor);
  const ink = toPdfRgb(cover.inkColor || '#ffffff');

  // Full hardcover background
  page.drawRectangle({ x: 0, y: 0, width, height, color: bg });

  if (cover.pattern === 'simple-ruled') {
    page.drawRectangle({ x: 0, y: 0, width: spineW, height, color: spine });
    page.drawRectangle({ x: spineW, y: 0, width: 2, height, color: rgb(0, 0, 0), opacity: 0.22 });

    const lineY = height * (1 - 0.245);
    const padX = width * 0.09;
    page.drawLine({
      start: { x: spineW + padX, y: lineY },
      end: { x: width - padX, y: lineY },
      thickness: 1.4,
      color: ink,
      opacity: 0.55
    });

    const boxW = width * 0.17;
    const boxX = width - width * 0.25;
    const boxTopY = height * 0.23;
    const step = height * 0.036;
    for (let i = 0; i < 4; i++) {
      const y = boxTopY - i * step;
      page.drawLine({
        start: { x: boxX, y },
        end: { x: boxX + (i === 3 ? boxW * 0.85 : boxW), y },
        thickness: 1.1,
        color: ink,
        opacity: 0.5
      });
    }
  } else if (cover.pattern === 'solid-band') {
    const edgeSpineW = Math.max(12, Math.round(width * 0.03));
    const bandW = Math.max(18, Math.round(width * 0.055));
    const bandX = width - Math.round(width * 0.13);

    page.drawRectangle({ x: 0, y: 0, width: edgeSpineW, height, color: spine, opacity: 0.72 });
    page.drawRectangle({ x: edgeSpineW, y: 0, width: 1.5, height, color: rgb(0, 0, 0), opacity: 0.16 });
    page.drawRectangle({ x: bandX - 2, y: 0, width: bandW + 4, height, color: rgb(0, 0, 0), opacity: 0.14 });
    page.drawRectangle({ x: bandX, y: 0, width: bandW, height, color: accent });
  } else if (cover.pattern === 'linen') {
    const step = 18;
    for (let x = spineW + step; x < width; x += step) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.65, color: accent, opacity: 0.34 });
    }
    for (let y = step; y < height; y += step) {
      page.drawLine({ start: { x: spineW, y }, end: { x: width, y }, thickness: 0.65, color: accent, opacity: 0.34 });
    }
    page.drawRectangle({ x: 0, y: 0, width: spineW, height, color: spine });
    page.drawRectangle({ x: spineW, y: 0, width: 2, height, color: rgb(0, 0, 0), opacity: 0.22 });

    const plateX = spineW + (width - spineW) * 0.16;
    const plateW = (width - spineW) * 0.68;
    const plateH = height * 0.18;
    const plateY = height * (1 - 0.38);
    page.drawRectangle({
      x: plateX,
      y: plateY,
      width: plateW,
      height: plateH,
      color: rgb(0.98, 0.965, 0.937),
      opacity: 0.92,
      borderColor: spine,
      borderWidth: 1.2,
      borderOpacity: 0.35
    });
    page.drawLine({
      start: { x: plateX + 28, y: plateY + plateH * 0.56 },
      end: { x: plateX + plateW - 28, y: plateY + plateH * 0.56 },
      thickness: 1.4,
      color: ink,
      opacity: 0.45
    });
    page.drawLine({
      start: { x: plateX + 48, y: plateY + plateH * 0.3 },
      end: { x: plateX + plateW - 48, y: plateY + plateH * 0.3 },
      thickness: 1.1,
      color: ink,
      opacity: 0.3
    });
  } else if (cover.pattern === 'blueprint') {
    const step = 28;
    for (let x = spineW + step; x < width; x += step) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.6, color: accent, opacity: 0.22 });
    }
    for (let y = step; y < height; y += step) {
      page.drawLine({ start: { x: spineW, y }, end: { x: width, y }, thickness: 0.6, color: accent, opacity: 0.22 });
    }
    page.drawRectangle({ x: 0, y: 0, width: spineW, height, color: spine });

    const pad = 34;
    page.drawRectangle({
      x: spineW + pad,
      y: pad,
      width: width - spineW - pad * 2,
      height: height - pad * 2,
      borderColor: ink,
      borderWidth: 1.4,
      borderOpacity: 0.52
    });
    page.drawRectangle({
      x: spineW + pad + 9,
      y: pad + 9,
      width: width - spineW - (pad + 9) * 2,
      height: height - (pad + 9) * 2,
      borderColor: ink,
      borderWidth: 0.8,
      borderOpacity: 0.28
    });
    page.drawCircle({
      x: spineW + (width - spineW) * 0.5,
      y: height * 0.58,
      size: Math.min(width, height) * 0.14,
      borderColor: ink,
      borderWidth: 1.3,
      borderOpacity: 0.45
    });
    page.drawLine({
      start: { x: spineW + pad + 32, y: height * 0.28 },
      end: { x: width - pad - 32, y: height * 0.28 },
      thickness: 1.4,
      color: ink,
      opacity: 0.55
    });
  } else if (cover.pattern === 'dot-foil') {
    const step = 42;
    for (let y = 44; y < height - 36; y += step) {
      for (let x = spineW + 38; x < width - 28; x += step) {
        page.drawCircle({ x, y, size: 2.2, color: accent, opacity: 0.34 });
      }
    }
    page.drawRectangle({ x: 0, y: 0, width: spineW, height, color: spine });
    page.drawRectangle({ x: spineW, y: 0, width: 2, height, color: accent, opacity: 0.45 });

    const cx = spineW + (width - spineW) * 0.5;
    const cy = height * 0.64;
    const d = 32;
    page.drawLine({ start: { x: cx, y: cy + d }, end: { x: cx + d, y: cy }, thickness: 1.6, color: accent, opacity: 0.9 });
    page.drawLine({ start: { x: cx + d, y: cy }, end: { x: cx, y: cy - d }, thickness: 1.6, color: accent, opacity: 0.9 });
    page.drawLine({ start: { x: cx, y: cy - d }, end: { x: cx - d, y: cy }, thickness: 1.6, color: accent, opacity: 0.9 });
    page.drawLine({ start: { x: cx - d, y: cy }, end: { x: cx, y: cy + d }, thickness: 1.6, color: accent, opacity: 0.9 });
    page.drawLine({
      start: { x: cx - 72, y: cy - 64 },
      end: { x: cx + 72, y: cy - 64 },
      thickness: 1.3,
      color: accent,
      opacity: 0.7
    });
  } else if (cover.pattern === 'terrazzo') {
    for (const shard of TERRAZZO_SHARDS) {
      const sx = spineW + shard.x * (width - spineW);
      const sy = height * (1 - shard.y);
      const r = shard.r * Math.min(width, height);
      page.drawRectangle({
        x: sx - r * 0.8,
        y: sy - r * 0.65,
        width: r * 1.6,
        height: r * 1.3,
        color: toPdfRgb(shard.color),
        opacity: 0.72
      });
    }
    page.drawRectangle({ x: 0, y: 0, width: spineW, height, color: spine });
    page.drawRectangle({ x: spineW, y: 0, width: 2, height, color: rgb(0, 0, 0), opacity: 0.2 });
  }
}

export interface PageRemapInput {
  pageCount: number;
  activePageIndex: number;
  annotations: Record<number, Annotation[]>;
  layers: Record<number, Layer[]>;
  userBookmarks?: UserBookmarkItem[];
}

export interface PageRemapResult extends PageRemapInput {
  paperPageCount: number;
  pageDelta: -1 | 0 | 1;
}

/**
 * Pure page-index remapping helper when toggling a notebook cover on/off after creation.
 * - `hadCover === willHaveCover`: 0 index shift, paper page count preserved.
 * - `false -> true` (adding cover): shifts all annotations, layers, bookmarks, and
 *   activePageIndex by `+1` so existing page 0 moves cleanly to page 1 behind the new cover.
 * - `true -> false` (removing cover): drops page 0 cover and shifts pages `>= 1` by `-1`
 *   (keeping at least 1 paper page).
 */
export function remapDocumentPagesForCoverToggle(
  input: PageRemapInput,
  hadCover: boolean,
  willHaveCover: boolean
): PageRemapResult {
  const existingPaperPages = hadCover
    ? Math.max(1, input.pageCount - 1)
    : Math.max(1, input.pageCount);

  if (hadCover === willHaveCover) {
    return {
      ...input,
      pageCount: willHaveCover ? existingPaperPages + 1 : existingPaperPages,
      paperPageCount: existingPaperPages,
      pageDelta: 0
    };
  }

  const pageDelta: -1 | 1 = !hadCover && willHaveCover ? 1 : -1;
  const nextAnnotations: Record<number, Annotation[]> = {};
  const nextLayers: Record<number, Layer[]> = {};

  for (const [k, anns] of Object.entries(input.annotations || {})) {
    const idx = Number(k);
    if (!Number.isFinite(idx)) continue;
    const nextIdx = idx + pageDelta;
    if (nextIdx < 0) continue;
    nextAnnotations[nextIdx] = anns.map(a => ({ ...a, pageIndex: nextIdx }));
  }

  for (const [k, lyrs] of Object.entries(input.layers || {})) {
    const idx = Number(k);
    if (!Number.isFinite(idx)) continue;
    const nextIdx = idx + pageDelta;
    if (nextIdx < 0) continue;
    nextLayers[nextIdx] = lyrs.map(l => ({ ...l }));
  }

  const nextBookmarks = input.userBookmarks
    ? input.userBookmarks
        .map(b => ({ ...b, pageIndex: b.pageIndex + pageDelta }))
        .filter(b => b.pageIndex >= 0)
    : undefined;

  const nextTotalPages = willHaveCover ? existingPaperPages + 1 : existingPaperPages;
  const nextActivePage = Math.max(0, Math.min(nextTotalPages - 1, input.activePageIndex + pageDelta));

  return {
    pageCount: nextTotalPages,
    paperPageCount: existingPaperPages,
    activePageIndex: nextActivePage,
    annotations: nextAnnotations,
    layers: nextLayers,
    ...(nextBookmarks !== undefined ? { userBookmarks: nextBookmarks } : {}),
    pageDelta
  };
}
