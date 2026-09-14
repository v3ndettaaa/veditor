import { describe, it, expect } from 'vitest';
import { calloutTool, boxEdgeIntersection } from '../src/annotations/tools/callout';

describe('Callout tool', () => {
  it('creates a callout with the provided box and an edge-attached knee', () => {
    const ann = calloutTool.createCallout(
      { x: 10, y: 10 },
      { x: 300, y: 10 },
      0,
      'layer-default',
      'Hello',
      14,
      '#111827',
      '#fef3c7',
      '#d97706',
      { x: 10, y: 10, width: 140, height: 70 }
    );
    expect(ann.type).toBe('callout');
    expect(ann.box.width).toBe(140);
    expect(ann.arrowPoint).toEqual({ x: 300, y: 10 });
    expect(ann.knee).toBeDefined();
    // The knee must sit on the right border, on the centre->anchor ray.
    expect(ann.knee!.x).toBeCloseTo(150, 4);
    expect(ann.knee!.y).toBeCloseTo(45 + (-35) * (70 / 220), 4);
  });

  it('computes the nearest box-edge intersection', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    const hit = boxEdgeIntersection(box, { x: 50, y: 50 }, { x: 200, y: 50 });
    expect(hit.x).toBeCloseTo(100, 4);
    expect(hit.y).toBeCloseTo(50, 4);
  });
});
