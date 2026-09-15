import { describe, it, expect } from 'vitest';
import { clampRenderMultiplier, resolveRenderDpr, MAX_RENDER_DIMENSION } from '../src/utils/dpi';

describe('Render DPI helpers', () => {
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
