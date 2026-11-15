/**
 * Central application typography & annotation font resolution helpers.
 * Keeps offline bundled font families aligned across UI chrome, canvas overlays,
 * inline text editors, and Text / Sticky Note authoring pickers.
 */

export const DEFAULT_APP_FONT = 'Manrope';
export const DISPLAY_APP_FONT = 'Plus Jakarta Sans';
export const MONO_APP_FONT = 'JetBrains Mono';
export const PERSIAN_APP_FONT = 'Vazirmatn';

export interface AppFontOption {
  id: string;
  labelEn: string;
  labelFa: string;
  glyph: string;
  cssFamily: string;
}

export const APP_FONT_OPTIONS: readonly AppFontOption[] = [
  {
    id: 'Manrope',
    labelEn: 'Manrope',
    labelFa: 'Manrope',
    glyph: 'Aa',
    cssFamily: '"Manrope", "Vazirmatn", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  {
    id: 'Plus Jakarta Sans',
    labelEn: 'Jakarta',
    labelFa: 'Jakarta',
    glyph: 'Ag',
    cssFamily: '"Plus Jakarta Sans", "Vazirmatn", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  {
    id: 'JetBrains Mono',
    labelEn: 'Mono',
    labelFa: 'Mono',
    glyph: '01',
    cssFamily: '"JetBrains Mono", "Vazirmatn", ui-monospace, monospace',
  },
  {
    id: 'Vazirmatn',
    labelEn: 'Vazirmatn',
    labelFa: 'وزیرمتن',
    glyph: 'الف',
    cssFamily: '"Vazirmatn", "Manrope", -apple-system, BlinkMacSystemFont, Tahoma, sans-serif',
  },
];

/**
 * Normalizes legacy default font references (`Inter`) to the app's current
 * default sans-serif (`Manrope`), while preserving custom PDF/document fonts.
 */
export function resolveAnnotationFontFamily(fontFamily?: string | null): string {
  const raw = (fontFamily || '').trim();
  if (!raw || /^inter$/i.test(raw)) {
    return DEFAULT_APP_FONT;
  }
  return raw;
}

/**
 * Returns a complete CSS / Canvas font-family stack for an annotation font name,
 * pairing Latin and Persian fallback glyphs cleanly.
 */
export function resolveAnnotationFontCss(fontFamily?: string | null): string {
  const fam = resolveAnnotationFontFamily(fontFamily);
  const preset = APP_FONT_OPTIONS.find(opt => opt.id.toLowerCase() === fam.toLowerCase());
  if (preset) return preset.cssFamily;
  const quoted = fam.includes(' ') || fam.includes('"') ? `"${fam.replace(/"/g, '')}"` : fam;
  return `${quoted}, "Manrope", "Vazirmatn", -apple-system, BlinkMacSystemFont, sans-serif`;
}
