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

/** Largest cursor image a browser will accept, in CSS px. */
const MAX_CURSOR_PX = 128;

/** Below this a ring is too small to aim with, so it stops shrinking. */
const MIN_RING_PX = 7;

function svgCursor(svg: string, size: number): string {
  const hotspot = Math.round(size / 2);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, crosshair`;
}

/**
 * A ring at the brush's true diameter. Stroked twice -- dark over a light halo
 * -- so it stays visible on white paper and on dark or inverted pages alike.
 */
function ringCursor(diameter: number): string {
  const d = Math.max(MIN_RING_PX, diameter);
  if (d > MAX_CURSOR_PX - 6) return 'crosshair';

  const size = Math.ceil(d) + 6;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.85"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#0f172a" stroke-width="1.25"/>` +
    `<circle cx="${c}" cy="${c}" r="1" fill="#0f172a"/>` +
    `</svg>`;
  return svgCursor(svg, size);
}

/** A filled dot at the brush's true diameter, in the ink colour. */
function dotCursor(diameter: number, ink: string): string {
  const d = Math.max(4, diameter);
  if (d > MAX_CURSOR_PX - 6) return 'crosshair';

  const size = Math.ceil(d) + 6;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${ink}" stroke="#ffffff" stroke-width="1.5"/>` +
    `</svg>`;
  return svgCursor(svg, size);
}

/** Fixed-size pen nib. A nib points at the cursor, so it doesn't scale. */
function penCursor(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
    `<path d="m2 22 4-1 12-12-3-3L3 18l-1 4z" fill="#ffffff" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M14 7l3 3" stroke="#0f172a" stroke-width="1.5"/>` +
    `<circle cx="2.5" cy="21.5" r="1.2" fill="#4f46e5"/>` +
    `</svg>`;
  // The nib tip is the hotspot, not the image centre.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 22, crosshair`;
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
  if (tool === 'eraser') return 'rgba(148,163,184,0.85)';
  return s.penColor;
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

  // The brush is stored in page units; on screen it is scaled by the zoom.
  const onScreen = width * zoom;

  switch (style) {
    case 'circle': return ringCursor(onScreen);
    case 'dot': return dotCursor(onScreen, inkColor(tool));
    case 'pen': return penCursor();
    case 'crosshair':
    default: return 'crosshair';
  }
}
