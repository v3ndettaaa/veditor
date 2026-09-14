import { describe, it, expect } from 'vitest';
import { constrainShapePoint, snapPointTo15 } from '../src/annotations/tools/shapes';

describe('15-degree angle snapping', () => {
  it('snaps an arbitrary vector to the nearest 15-degree ray, length preserved', () => {
    const anchor = { x: 10, y: 20 };
    const len = 50;
    const rad40 = (40 * Math.PI) / 180;
    const p = snapPointTo15(anchor, {
      x: anchor.x + len * Math.cos(rad40),
      y: anchor.y + len * Math.sin(rad40)
    });
    expect(Math.hypot(p.x - anchor.x, p.y - anchor.y)).toBeCloseTo(len, 6);
    const deg = (Math.atan2(p.y - anchor.y, p.x - anchor.x) * 180) / Math.PI;
    expect(Math.abs(deg - 45)).toBeLessThan(0.001);
  });

  it('snaps to cardinal axes for tiny deviations', () => {
    const p = snapPointTo15({ x: 0, y: 0 }, { x: 100, y: 3 });
    expect(p.y).toBeCloseTo(0, 6);
  });
});

describe('Shift-constrained regular shapes', () => {
  it('constrains a rectangle drag to a square preserving drag direction', () => {
    // Drag right-down: wider than tall -> side follows width.
    expect(constrainShapePoint('rectangle', { x: 10, y: 10 }, { x: 50, y: 30 }))
      .toEqual({ x: 50, y: 50 });
    // Drag left-up: signs preserved on both axes.
    expect(constrainShapePoint('rectangle', { x: 50, y: 50 }, { x: 20, y: 40 }))
      .toEqual({ x: 20, y: 20 });
  });

  it('constrains an ellipse drag to a circle', () => {
    const c = constrainShapePoint('ellipse', { x: 0, y: 0 }, { x: 30, y: 10 });
    expect(c.x).toBe(30);
    expect(c.y).toBe(30);
  });

  it('snaps lines to 15-degree increments preserving length', () => {
    const start = { x: 0, y: 0 };
    // 10 degrees -> snaps to 15 degrees.
    const len = 100;
    const rad10 = (10 * Math.PI) / 180;
    const p = constrainShapePoint('line', start, {
      x: len * Math.cos(rad10),
      y: len * Math.sin(rad10)
    });
    expect(Math.hypot(p.x - start.x, p.y - start.y)).toBeCloseTo(len, 6);
    expect((Math.atan2(p.y - start.y, p.x - start.x) * 180) / Math.PI).toBeCloseTo(15, 6);
    // Near-horizontal drag snaps exactly horizontal.
    const h = constrainShapePoint('arrow', start, { x: 80, y: 2 });
    expect(h.y).toBeCloseTo(0, 6);
    expect(h.x).toBeCloseTo(Math.hypot(80, 2), 6);
  });

  it('leaves polygon and freeform points untouched', () => {
    const pt = { x: 33, y: 77 };
    expect(constrainShapePoint('polygon', { x: 0, y: 0 }, pt)).toEqual(pt);
    expect(constrainShapePoint('freeform-shape', { x: 5, y: 5 }, pt)).toEqual(pt);
  });

  it('handles zero-length drags without NaN', () => {
    const p = { x: 7, y: 7 };
    expect(constrainShapePoint('rectangle', p, { ...p })).toEqual(p);
    expect(constrainShapePoint('line', p, { ...p })).toEqual(p);
  });
});
