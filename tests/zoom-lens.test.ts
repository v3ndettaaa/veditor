import { describe, it, expect } from 'vitest';
import { store } from '../src/core/store';

describe('Zoom lens state', () => {
  it('is inactive with a factor of 1 by default', () => {
    if (store.zoomLensActive) store.exitZoomLens();
    store.setZoom(1);
    expect(store.zoomLensActive).toBe(false);
    expect(store.zoomLensFactor).toBe(1);
  });

  it('computes the width compensation factor while active', () => {
    store.enterZoomLens(1);
    expect(store.zoomLensActive).toBe(true);
    // No zoom change yet: tools behave exactly as normal.
    expect(store.zoomLensFactor).toBe(1);
    store.setZoom(3);
    // A 3px pen stored as 3/3 = 1pt renders 3px on screen at 3x zoom.
    expect(store.zoomLensFactor).toBeCloseTo(3, 6);
    store.exitZoomLens();
  });

  it('restores the pre-lens zoom on exit', () => {
    store.enterZoomLens(1);
    store.setZoom(2.5);
    store.exitZoomLens();
    expect(store.zoomLensActive).toBe(false);
    expect(store.zoom).toBeCloseTo(1, 6);
    expect(store.zoomLensFactor).toBe(1);
  });
});
