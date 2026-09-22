/**
 * TEMPORARY migration flag — delete after the MuPDF migration is complete.
 *
 * Selects the page raster backend: `pdfjs` (current default) or `mupdf`
 * (Rust/MuPDF tile renderer, Day-2+). Read once per render call so toggling
 * takes effect on reload without any other state changes.
 *
 * Enable:  localStorage.setItem("veditor_renderer", "mupdf"); location.reload();
 * Disable: localStorage.removeItem("veditor_renderer"); location.reload();
 */

export type RendererKind = 'pdfjs' | 'mupdf';

const RENDERER_KEY = 'veditor_renderer';

export function getRendererKind(): RendererKind {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(RENDERER_KEY) === 'mupdf'
      ? 'mupdf'
      : 'pdfjs';
  } catch {
    return 'pdfjs';
  }
}

export function setRendererKind(kind: RendererKind): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (kind === 'pdfjs') localStorage.removeItem(RENDERER_KEY);
    else localStorage.setItem(RENDERER_KEY, kind);
  } catch {
    // Private mode etc: stay on pdf.js.
  }
}
