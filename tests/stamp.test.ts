import { describe, it, expect } from 'vitest';
import { stampTool } from '../src/annotations/tools/stamp';

describe('Stamp tool', () => {
  it('stores tilt on the annotation rotation (not box.rotation)', () => {
    const ann = stampTool.createPresetStamp({ x: 200, y: 200 }, 0, 'layer-default', 'APPROVED');
    expect(ann.type).toBe('stamp');
    expect(ann.rotation).toBeCloseTo(-0.12, 6);
    expect(ann.box.rotation).toBeUndefined();
    expect(ann.box.width).toBe(180);
    expect(ann.box.height).toBe(64);
  });

  it('creates a custom image stamp with the requested box', () => {
    const ann = stampTool.createCustomImageStamp({ x: 100, y: 100 }, 0, 'layer-default', 'data:image/png;base64,xx', 200, 120);
    expect(ann.stampType).toBe('custom');
    expect(ann.box.width).toBe(200);
    expect(ann.box.height).toBe(120);
  });
});
