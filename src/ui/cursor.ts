/**
 * Drawing cursor for the scratchpad canvas.
 *
 * The size-indicating cursors (`circle`, `dot`) are generated per call so they
 * show the brush at its true on-screen size -- the active tool's width scaled
 * by the current zoom. They used to be fixed-size SVGs in CSS, so a 1px pen
 * and a 30px pen shared one cursor.
 *
 * Browsers cap cursor images (128x128 in Chrome and Firefox; a larger image is
 * dropped and the fallback is used). A brush wider than that can't be drawn
 * truthfully, so we fall back to a crosshair rather than lie about the size.
 */

import { store } from '../core/store';
import { DrawingCursorType, ToolType } from '../core/types';
import { isElectron } from '../core/platform';
import { getDevicePixelRatio } from '../utils/dpi';

/** Largest cursor image a browser will accept, in physical px. */
const MAX_CURSOR_PX = 128;

/** Largest floating DOM eraser/brush ring diameter in CSS px. */
const MAX_FLOATING_CURSOR_PX = 480;

/** Below this a ring is too small to aim with, so it stops shrinking. */
const MIN_RING_PX = 7;

export interface FloatingCursorSpec {
  svg: string;
  hotspotX: number;
  hotspotY: number;
  sig: string;
}

function effectiveMaxCssCursorPx(): number {
  const dpr = Math.max(1, getDevicePixelRatio());
  return Math.max(32, Math.floor(MAX_CURSOR_PX / dpr));
}

function svgCursor(svg: string, size: number): string {
  const hotspot = Math.round(size / 2);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, crosshair`;
}

function buildRingSvg(diameter: number): { svg: string; size: number; hotspot: number } {
  const d = Math.max(MIN_RING_PX, diameter);
  const size = Math.ceil(d) + 6;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.85"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#0f172a" stroke-width="1.25"/>` +
    `<circle cx="${c}" cy="${c}" r="1" fill="#0f172a"/>` +
    `</svg>`;
  return { svg, size, hotspot: c };
}

function buildDotSvg(diameter: number, ink: string): { svg: string; size: number; hotspot: number } {
  const d = Math.max(4, diameter);
  const size = Math.ceil(d) + 6;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${ink}" stroke="#ffffff" stroke-width="1.5"/>` +
    `</svg>`;
  return { svg, size, hotspot: c };
}

function buildRectangleSvg(
  hPx: number,
  ink: string,
  alpha: number,
  maxCssPx: number
): { svg: string; sizeW: number; sizeH: number; hotspotX: number; hotspotY: number } {
  const h = Math.max(6, Math.min(maxCssPx - 8, hPx));
  const w = Math.max(12, Math.min(maxCssPx - 8, Math.round(h * 0.8)));
  const sizeW = Math.ceil(w) + 8;
  const sizeH = Math.ceil(h) + 8;
  const x = 4;
  const y = 4;
  const cx = sizeW / 2;
  const cy = sizeH / 2;
  const fillAlpha = Math.min(0.8, Math.max(0.12, alpha));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeW}" height="${sizeH}" viewBox="0 0 ${sizeW} ${sizeH}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${ink}" fill-opacity="${fillAlpha}" stroke="#ffffff" stroke-width="2.5" opacity="0.9"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="none" stroke="#0f172a" stroke-width="1.2"/>` +
    `<circle cx="${cx}" cy="${cy}" r="1" fill="#0f172a"/>` +
    `</svg>`;
  return { svg, sizeW, sizeH, hotspotX: cx, hotspotY: cy };
}

function buildChiselSvg(
  hPx: number,
  ink: string,
  alpha: number,
  maxCssPx: number
): { svg: string; sizeW: number; sizeH: number; hotspotX: number; hotspotY: number } {
  const h = Math.max(8, Math.min(maxCssPx - 10, hPx));
  const w = Math.max(8, Math.min(maxCssPx - 10, Math.round(h * 0.6)));
  const sizeW = Math.ceil(w) + 8;
  const sizeH = Math.ceil(h) + 8;
  const cx = sizeW / 2;
  const cy = sizeH / 2;
  const fillAlpha = Math.min(0.8, Math.max(0.12, alpha));
  const p1 = `${cx - w / 2},${cy + h / 2}`;
  const p2 = `${cx + w / 2},${cy + h / 2 - 4}`;
  const p3 = `${cx + w / 2},${cy - h / 2}`;
  const p4 = `${cx - w / 2},${cy - h / 2 + 4}`;
  const pts = `${p1} ${p2} ${p3} ${p4}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeW}" height="${sizeH}" viewBox="0 0 ${sizeW} ${sizeH}">` +
    `<polygon points="${pts}" fill="${ink}" fill-opacity="${fillAlpha}" stroke="#ffffff" stroke-width="2.5" opacity="0.9"/>` +
    `<polygon points="${pts}" fill="none" stroke="#0f172a" stroke-width="1.2"/>` +
    `<circle cx="${cx}" cy="${cy}" r="1" fill="#0f172a"/>` +
    `</svg>`;
  return { svg, sizeW, sizeH, hotspotX: cx, hotspotY: cy };
}

function buildPenSvg(): { svg: string; hotspotX: number; hotspotY: number } {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
    `<path d="m2 22 4-1 12-12-3-3L3 18l-1 4z" fill="#ffffff" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M14 7l3 3" stroke="#0f172a" stroke-width="1.5"/>` +
    `<circle cx="2.5" cy="21.5" r="1.2" fill="#4f46e5"/>` +
    `</svg>`;
  return { svg, hotspotX: 2, hotspotY: 22 };
}

function buildEraserIconSvg(): { svg: string; hotspotX: number; hotspotY: number } {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
    `<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" fill="#ffffff" stroke="#0f172a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="m5 11 9 9" stroke="#ef4444" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="4" cy="19" r="1.4" fill="#ef4444"/>` +
    `</svg>`;
  return { svg, hotspotX: 4, hotspotY: 19 };
}

/**
 * A ring at the brush's true diameter. Stroked twice -- dark over a light halo
 * -- so it stays visible on white paper and on dark or inverted pages alike.
 */
function ringCursor(diameter: number): string {
  const d = Math.max(MIN_RING_PX, diameter);
  if (d > effectiveMaxCssCursorPx() - 6) return 'crosshair';
  const { svg, size } = buildRingSvg(d);
  return svgCursor(svg, size);
}

/** A filled dot at the brush's true diameter, in the ink colour. */
function dotCursor(diameter: number, ink: string): string {
  const d = Math.max(4, diameter);
  if (d > effectiveMaxCssCursorPx() - 6) return 'crosshair';
  const { svg, size } = buildDotSvg(d, ink);
  return svgCursor(svg, size);
}

/** A rectangular box matching the highlighter width and text coverage. */
function rectangleCursor(hPx: number, ink: string, alpha: number): string {
  const { svg, sizeW } = buildRectangleSvg(hPx, ink, alpha, effectiveMaxCssCursorPx());
  return svgCursor(svg, sizeW);
}

/** A slanted chisel tip marker cursor. */
function chiselCursor(hPx: number, ink: string, alpha: number): string {
  const { svg, sizeW } = buildChiselSvg(hPx, ink, alpha, effectiveMaxCssCursorPx());
  return svgCursor(svg, sizeW);
}

/** Fixed-size pen nib. A nib points at the cursor, so it doesn't scale. */
function penCursor(): string {
  const { svg, hotspotX, hotspotY } = buildPenSvg();
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, crosshair`;
}

/** Fixed-size eraser icon cursor with hotspot at bottom-left erasing edge. */
function eraserIconCursor(): string {
  const { svg, hotspotX, hotspotY } = buildEraserIconSvg();
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, crosshair`;
}

/**
 * The width of the brush the given tool paints with, in page units, or null
 * for tools that don't paint a stroke.
 */
function brushWidth(tool: ToolType): number | null {
  const s = store.toolSettings;
  switch (tool) {
    case 'pen': return s.penWidth;
    case 'highlighter': return s.highlighterWidth;
    case 'eraser': return s.eraserWidth;
    default: return null;
  }
}

function inkColor(tool: ToolType): string {
  const s = store.toolSettings;
  if (tool === 'highlighter') return s.highlighterColor;
  if (tool === 'eraser') return 'rgba(239,68,68,0.85)';
  return s.penColor;
}

/**
 * Returns true when the active tool cursor should be rendered by the 0ms GPU
 * floating DOM overlay (`#veditor-tool-cursor`) with `cursor: none` on the canvas:
 * - Eraser (`circle` / `dot` / `eraser`): enabled on ALL platforms (Chrome &
 *   Firefox/Zen extensions, Web, Tauri, Electron) so the true-size eraser circle
 *   never disappears due to Wayland SVG cursor drops or browser 128px/HiDPI caps.
 * - Pen & Highlighter custom SVG cursors: enabled ONLY on Electron so Linux
 *   Ozone/Wayland never reverts the pen/highlighter cursor to the OS arrow on
 *   PDF open or zoom, while leaving extension pen/highlighter cursors untouched.
 */
export function shouldUseFloatingToolCursor(
  tool: ToolType,
  style: DrawingCursorType,
  electron: boolean = isElectron()
): boolean {
  if (tool === 'eraser') {
    const eraserCursor = store.toolSettings.eraserCursor || 'circle';
    return eraserCursor !== 'crosshair';
  }
  if (!electron) return false;
  if (tool === 'pen') {
    return style !== 'crosshair';
  }
  if (tool === 'highlighter') {
    const hlCursor = store.toolSettings.highlighterCursor || 'rectangle';
    return hlCursor !== 'crosshair';
  }
  return false;
}

/**
 * Builds the SVG markup, hotspot, and memoization signature for the 0ms GPU
 * floating tool cursor overlay, or returns null when the native CSS cursor is used.
 */
export function buildFloatingToolCursorSpec(
  tool: ToolType,
  style: DrawingCursorType,
  zoom: number,
  electron: boolean = isElectron()
): FloatingCursorSpec | null {
  if (!shouldUseFloatingToolCursor(tool, style, electron)) return null;

  const s = store.toolSettings;
  const safeZoom = Math.max(0.1, zoom || 1);

  if (tool === 'eraser') {
    const eraserCursor = s.eraserCursor || 'circle';
    const onScreen = Math.min(MAX_FLOATING_CURSOR_PX, Math.max(1, (s.eraserWidth || 24) * safeZoom));
    const sizeKey = Math.round(onScreen * 2);
    if (eraserCursor === 'dot') {
      const { svg, hotspot } = buildDotSvg(Math.min(24, Math.max(6, onScreen * 0.35)), 'rgba(239,68,68,0.85)');
      return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `eraser|dot|${sizeKey}` };
    }
    if (eraserCursor === 'eraser') {
      const { svg, hotspotX, hotspotY } = buildEraserIconSvg();
      return { svg, hotspotX, hotspotY, sig: 'eraser|icon' };
    }
    const { svg, hotspot } = buildRingSvg(onScreen);
    return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `eraser|circle|${sizeKey}` };
  }

  if (tool === 'highlighter') {
    const hlCursor = s.highlighterCursor || 'rectangle';
    const opacity = s.highlighterOpacity ?? 0.45;
    const color = s.highlighterColor || '#facc15';
    const onScreen = Math.min(MAX_FLOATING_CURSOR_PX, Math.max(1, (s.highlighterWidth || 20) * safeZoom));
    const sizeKey = Math.round(onScreen * 2);
    if (hlCursor === 'chisel') {
      const { svg, hotspotX, hotspotY } = buildChiselSvg(onScreen, color, opacity, MAX_FLOATING_CURSOR_PX);
      return { svg, hotspotX, hotspotY, sig: `hl|chisel|${sizeKey}|${color}|${opacity}` };
    }
    if (hlCursor === 'circle') {
      const { svg, hotspot } = buildRingSvg(onScreen);
      return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `hl|circle|${sizeKey}` };
    }
    if (hlCursor === 'dot') {
      const { svg, hotspot } = buildDotSvg(onScreen, color);
      return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `hl|dot|${sizeKey}|${color}` };
    }
    const { svg, hotspotX, hotspotY } = buildRectangleSvg(onScreen, color, opacity, MAX_FLOATING_CURSOR_PX);
    return { svg, hotspotX, hotspotY, sig: `hl|rect|${sizeKey}|${color}|${opacity}` };
  }

  if (tool === 'pen') {
    const onScreen = Math.min(MAX_FLOATING_CURSOR_PX, Math.max(1, (s.penWidth || 3) * safeZoom));
    const sizeKey = Math.round(onScreen * 2);
    if (style === 'circle') {
      const { svg, hotspot } = buildRingSvg(onScreen);
      return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `pen|circle|${sizeKey}` };
    }
    if (style === 'dot') {
      const color = s.penColor || '#4f46e5';
      const { svg, hotspot } = buildDotSvg(onScreen, color);
      return { svg, hotspotX: hotspot, hotspotY: hotspot, sig: `pen|dot|${sizeKey}|${color}` };
    }
    const { svg, hotspotX, hotspotY } = buildPenSvg();
    return { svg, hotspotX, hotspotY, sig: 'pen|nib' };
  }

  return null;
}

/**
 * The CSS `cursor` value for the scratchpad canvas, given the active tool,
 * the user's cursor preference, and the zoom the page is drawn at.
 */
export function drawingCursorValue(
  tool: ToolType,
  style: DrawingCursorType,
  zoom: number
): string {
  // Select doesn't draw, so it keeps the normal arrow.
  if (tool === 'select') return 'default';
  // Hand pans the page instead of drawing.
  if (tool === 'hand') return 'grab';

  const width = brushWidth(tool);
  if (width === null) return 'crosshair';

  if (shouldUseFloatingToolCursor(tool, style)) {
    return 'none';
  }

  const onScreen = width * zoom;

  if (tool === 'highlighter') {
    const s = store.toolSettings;
    const hlCursor = s.highlighterCursor || 'rectangle';
    const opacity = s.highlighterOpacity ?? 0.45;
    const color = s.highlighterColor || '#facc15';
    switch (hlCursor) {
      case 'rectangle':
        return rectangleCursor(onScreen, color, opacity);
      case 'chisel':
        return chiselCursor(onScreen, color, opacity);
      case 'circle':
        return ringCursor(onScreen);
      case 'dot':
        return dotCursor(onScreen, color);
      case 'crosshair':
      default:
        return 'crosshair';
    }
  }

  if (tool === 'eraser') {
    const eraserCursor = store.toolSettings.eraserCursor || 'circle';
    switch (eraserCursor) {
      case 'circle':
        return ringCursor(onScreen);
      case 'dot':
        return dotCursor(Math.min(24, Math.max(6, onScreen * 0.35)), 'rgba(239,68,68,0.85)');
      case 'eraser':
        return eraserIconCursor();
      case 'crosshair':
      default:
        return 'crosshair';
    }
  }

  switch (style) {
    case 'circle': return ringCursor(onScreen);
    case 'dot': return dotCursor(onScreen, inkColor(tool));
    case 'pen': return penCursor();
    case 'crosshair':
    default: return 'crosshair';
  }
}
