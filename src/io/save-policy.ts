/**
 * Standalone policy helpers for save behavior, kept dependency-light so
 * policy regressions can be tested without DOM/export infrastructure.
 */

/**
 * True when the viewer is currently displaying the document with the dark
 * inversion filter. Used ONLY by Save As to preselect the theme choice —
 * never by regular Save.
 */
export function isPdfDisplayedDark(invertDocumentOled: boolean, hasBodyClass: boolean): boolean {
  return Boolean(invertDocumentOled) || Boolean(hasBodyClass);
}
