/**
 * Renderer selection boundary (Day-5: settings-backed, was a localStorage
 * flag). Selects the page raster backend: `pdfjs` (default) or `mupdf`
 * (Rust/MuPDF tile renderer, desktop only).
 *
 * This is the ONLY renderer-kind branch point: getPageRenderer() reads it
 * per render call. Never branch on store.appSettings.renderer directly.
 * Extension builds always resolve pdfjs (native engine unavailable).
 */

import { store } from './store';
import { isDesktop } from './platform';

export type RendererKind = 'pdfjs' | 'mupdf';

export function getRendererKind(): RendererKind {
  try {
    if (!isDesktop()) return 'pdfjs';
    return store.appSettings.renderer === 'mupdf' ? 'mupdf' : 'pdfjs';
  } catch {
    return 'pdfjs';
  }
}

/** Legacy Day-2 localStorage flag writer (no callers; kept for console use). */
export function setRendererKind(kind: RendererKind): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (kind === 'pdfjs') localStorage.removeItem('veditor_renderer');
    else localStorage.setItem('veditor_renderer', kind);
  } catch {
    // Private mode etc: stay on pdf.js.
  }
}
