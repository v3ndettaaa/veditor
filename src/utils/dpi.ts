/**
 * Display / render DPI helpers.
 *
 * The PDF point grid is 72 DPI, so a page rendered at `scale = 1` maps one
 * PDF point to one CSS pixel. `targetDPI` is the user-facing render
 * resolution; the backing-store multiplier over CSS pixels is therefore
 * `targetDPI / 72`. When unset it falls back to the physical system DPI
 * (72 * devicePixelRatio), which keeps HiDPI displays native.
 */

export const BASE_PDF_DPI = 72;

/**
 * Maximum canvas backing-store dimension, capped to protect VRAM.
 * 16384 keeps pages sharp to ~8x zoom on HiDPI displays (800% on A4 ≈ 6736px);
 * beyond the cap the browser upscales, which is where visible aliasing would begin.
 */
export const MAX_RENDER_DIMENSION = 16384;

export function getDevicePixelRatio(): number {
  if (typeof window !== 'undefined' && window.devicePixelRatio) {
    return window.devicePixelRatio;
  }
  return 1;
}

/** Physical system DPI inferred from the display's device pixel ratio. */
export function getSystemDpi(): number {
  return Math.round(BASE_PDF_DPI * getDevicePixelRatio());
}

/**
 * Backing-store pixels per CSS pixel for a given target DPI.
 * Defaults to the system DPI when `targetDPI` is missing/invalid.
 */
export function resolveRenderDpr(targetDPI?: number): number {
  const dpi = typeof targetDPI === 'number' && Number.isFinite(targetDPI) && targetDPI > 0
    ? targetDPI
    : getSystemDpi();
  return dpi / BASE_PDF_DPI;
}

export function resolveAnnotationDpr(targetDPI?: number): number {
  return Math.max(2, getDevicePixelRatio(), resolveRenderDpr(targetDPI));
}

/**
 * Clamp a backing-store multiplier so neither canvas dimension exceeds
 * `MAX_RENDER_DIMENSION`. CSS size is unaffected; the browser upscales.
 */
export function clampRenderMultiplier(
  cssWidth: number,
  cssHeight: number,
  multiplier: number
): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 1;
  const largest = Math.max(cssWidth * multiplier, cssHeight * multiplier);
  if (largest > MAX_RENDER_DIMENSION && largest > 0) {
    return multiplier * (MAX_RENDER_DIMENSION / largest);
  }
  return multiplier;
}
