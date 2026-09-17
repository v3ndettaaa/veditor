import { afterEach, describe, it, expect, vi } from 'vitest';
import { clampRenderMultiplier, resolveAnnotationDpr, resolveRenderDpr, MAX_RENDER_DIMENSION } from '../src/utils/dpi';

describe('Render DPI helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([1, 1.25, 1.5, 2])('uses at least 2x for annotations at device DPR %s', devicePixelRatio => {
    vi.stubGlobal('window', { devicePixelRatio });
    expect(resolveAnnotationDpr()).toBe(2);
    expect(resolveAnnotationDpr(72)).toBe(2);
  });

  it('keeps annotations at native device DPR despite a lower target DPI', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2.333 });
    expect(resolveAnnotationDpr()).toBeGreaterThanOrEqual(2.333);
    expect(resolveAnnotationDpr(72)).toBe(2.333);
  });

  it('honors a configured target above both 2x and device DPR', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2.5 });
    expect(resolveAnnotationDpr(288)).toBe(4);
    expect(resolveAnnotationDpr(250)).toBeCloseTo(250 / 72, 10);
    expect(resolveRenderDpr(72)).toBe(1);
  });

  it.each([undefined, 0, -72, NaN, Infinity, -Infinity])('falls back safely for invalid target DPI %s', targetDPI => {
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(resolveAnnotationDpr(targetDPI)).toBe(3);
  });

  it('uses 2x when no browser window is available', () => {
    vi.stubGlobal('window', undefined);
    expect(resolveAnnotationDpr()).toBe(2);
  });

  it.each([[4000, 2000], [2000, 4000]])('retains the dimension cap for annotation backing stores of %s by %s', (cssWidth, cssHeight) => {
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    const multiplier = clampRenderMultiplier(cssWidth, cssHeight, resolveAnnotationDpr(288));
    expect(multiplier).toBe(MAX_RENDER_DIMENSION / 4000);
    expect(multiplier).toBeLessThan(2);
    expect(cssWidth * multiplier).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    expect(cssHeight * multiplier).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    expect(clampRenderMultiplier(612, 792, resolveAnnotationDpr(288))).toBe(4);
  });

  it('maps an explicit target DPI to a backing-store multiplier', () => {
    expect(resolveRenderDpr(72)).toBe(1);
    expect(resolveRenderDpr(144)).toBe(2);
    expect(resolveRenderDpr(150)).toBeCloseTo(150 / 72, 10);
  });

  it('caps extreme backing stores without changing CSS dimensions', () => {
    expect(clampRenderMultiplier(612, 792, 12)).toBeLessThan(12);
    expect(792 * clampRenderMultiplier(612, 792, 12)).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    expect(clampRenderMultiplier(612, 792, 2)).toBe(2);
  });
});
