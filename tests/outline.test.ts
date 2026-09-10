import { describe, it, expect, beforeEach } from 'vitest';
import { shapesTool } from '../src/annotations/tools/shapes';
import { shapeHasOutline } from '../src/annotations/engine';

describe('Shape outline toggle', () => {
  beforeEach(() => {
    shapesTool.reset();
  });

  it('stores outline=false on finished shapes when disabled', () => {
    shapesTool.start({ x: 10, y: 10 }, 0, 'rectangle', '#000', '#fff', 2, 'solid', false);
    shapesTool.move({ x: 60, y: 40 });
    const ann = shapesTool.finish('layer-1');
    expect(ann).not.toBeNull();
    expect(ann?.outline).toBe(false);
  });

  it('defaults to outline=true when not specified', () => {
    shapesTool.start({ x: 10, y: 10 }, 0, 'ellipse', '#000', 'transparent', 2, 'solid');
    shapesTool.move({ x: 60, y: 40 });
    const ann = shapesTool.finish('layer-1');
    expect(ann?.outline).toBe(true);
  });

  it('shapeHasOutline respects the flag for closed shapes only', () => {
    expect(shapeHasOutline({ type: 'rectangle', outline: false })).toBe(false);
    expect(shapeHasOutline({ type: 'ellipse', outline: false })).toBe(false);
    expect(shapeHasOutline({ type: 'polygon', outline: false })).toBe(false);
    expect(shapeHasOutline({ type: 'rectangle', outline: true })).toBe(true);
    expect(shapeHasOutline({ type: 'rectangle' })).toBe(true);
    // Lines and arrows ARE their outline: always stroked.
    expect(shapeHasOutline({ type: 'line', outline: false })).toBe(true);
    expect(shapeHasOutline({ type: 'arrow', outline: false })).toBe(true);
  });
});
