import { describe, it, expect, beforeEach } from 'vitest';
import { shapesTool } from '../src/annotations/tools/shapes';
import { highlighterTool } from '../src/annotations/tools/highlighter';
import { store } from '../src/core/store';

describe('Polygon Multi-Point Shape Tool', () => {
  beforeEach(() => {
    shapesTool.reset();
  });

  it('starts a polygon and adds multiple vertices', () => {
    shapesTool.start(
      { x: 10, y: 10 },
      0,
      'polygon',
      '#ef4444',
      'transparent',
      2,
      'solid'
    );

    expect(shapesTool.isPolygonActive()).toBe(true);
    expect(shapesTool.getPolygonPointCount()).toBe(1);

    const closed1 = shapesTool.addPolygonVertex({ x: 50, y: 10 });
    expect(closed1).toBe(false);
    expect(shapesTool.getPolygonPointCount()).toBe(2);

    const closed2 = shapesTool.addPolygonVertex({ x: 50, y: 50 });
    expect(closed2).toBe(false);
    expect(shapesTool.getPolygonPointCount()).toBe(3);

    const closed3 = shapesTool.addPolygonVertex({ x: 10, y: 50 });
    expect(closed3).toBe(false);
    expect(shapesTool.getPolygonPointCount()).toBe(4);
  });

  it('detects polygon closing when clicking near the start vertex', () => {
    shapesTool.start(
      { x: 100, y: 100 },
      0,
      'polygon',
      '#4f46e5',
      '#6366f1',
      3,
      'solid'
    );

    shapesTool.addPolygonVertex({ x: 200, y: 100 });
    shapesTool.addPolygonVertex({ x: 150, y: 200 });

    // Click near start point (within 14px threshold)
    const isClosed = shapesTool.addPolygonVertex({ x: 105, y: 102 });
    expect(isClosed).toBe(true);

    const annotation = shapesTool.finish('layer-1');
    expect(annotation).not.toBeNull();
    expect(annotation?.type).toBe('polygon');
    expect(annotation?.points?.length).toBe(3);
    expect(annotation?.strokeColor).toBe('#4f46e5');
    expect(annotation?.fillColor).toBe('#6366f1');
    expect(annotation?.box.width).toBeGreaterThan(0);
    expect(annotation?.box.height).toBeGreaterThan(0);
  });

  it('rejects finishing a polygon with fewer than 3 vertices', () => {
    shapesTool.start({ x: 0, y: 0 }, 0, 'polygon', '#000', 'transparent', 1, 'solid');
    shapesTool.addPolygonVertex({ x: 10, y: 10 });

    const annotation = shapesTool.finish('layer-1');
    expect(annotation).toBeNull();
  });
});

describe('Enhanced Highlighter Tool', () => {
  beforeEach(() => {
    highlighterTool.cancel();
  });

  it('creates a standard highlighter annotation', () => {
    highlighterTool.start(
      { x: 10, y: 20, pressure: 0.5 },
      0,
      'rgba(250, 204, 21, 0.45)',
      24,
      'multiply',
      false,
      'round'
    );

    highlighterTool.move({ x: 50, y: 22, pressure: 0.5 });
    highlighterTool.move({ x: 100, y: 21, pressure: 0.5 });

    const ann = highlighterTool.finish('layer-1');
    expect(ann).not.toBeNull();
    expect(ann?.type).toBe('highlighter');
    expect(ann?.strokeWidth).toBe(24);
    expect(ann?.straightLine).toBe(false);
    expect(ann?.tipShape).toBe('round');
  });

  it('snaps to straight horizontal line when straightLine or shift is active', () => {
    highlighterTool.start(
      { x: 10, y: 50, pressure: 0.5 },
      0,
      'rgba(250, 204, 21, 0.45)',
      20,
      'multiply',
      true,
      'chisel'
    );

    // Slight vertical deviation should be snapped to exact y=50
    highlighterTool.move({ x: 120, y: 58, pressure: 0.5 });

    const ann = highlighterTool.finish('layer-1');
    expect(ann).not.toBeNull();
    expect(ann?.straightLine).toBe(true);
    expect(ann?.tipShape).toBe('chisel');
    expect(ann?.points.length).toBe(2);
    expect(ann?.points[0].y).toBe(50);
    expect(ann?.points[1].y).toBe(50); // Snapped horizontal!
    expect(ann?.points[1].x).toBe(120);
  });
});

describe('Custom Drawing Cursors', () => {
  it('updates toolSettings and appSettings with selected cursor', () => {
    store.updateToolSettings({ drawingCursor: 'crosshair' });
    expect(store.toolSettings.drawingCursor).toBe('crosshair');

    store.updateToolSettings({ drawingCursor: 'dot' });
    expect(store.toolSettings.drawingCursor).toBe('dot');

    store.updateToolSettings({ drawingCursor: 'pen' });
    expect(store.toolSettings.drawingCursor).toBe('pen');
  });
});

describe('Tool Configuration Settings', () => {
  it('supports configuring redaction mode (Blackout vs Whiteout)', () => {
    store.updateToolSettings({ redactionColor: '#ffffff' });
    expect(store.toolSettings.redactionColor).toBe('#ffffff');

    store.updateToolSettings({ redactionColor: '#000000' });
    expect(store.toolSettings.redactionColor).toBe('#000000');
  });

  it('supports configuring preset stamps and creates corresponding annotations', () => {
    store.updateToolSettings({ stampPreset: 'CONFIDENTIAL' });
    expect(store.toolSettings.stampPreset).toBe('CONFIDENTIAL');

    store.updateToolSettings({ stampPreset: 'DRAFT' });
    expect(store.toolSettings.stampPreset).toBe('DRAFT');
  });

  it('resets all preferences to comprehensive default values', () => {
    store.updateToolSettings({
      drawingCursor: 'crosshair',
      highlighterStraightLine: true,
      highlighterTipShape: 'chisel',
      stampPreset: 'VOID',
      redactionColor: '#ffffff'
    });

    store.resetSettingsToDefault();

    expect(store.toolSettings.drawingCursor).toBe('pen');
    expect(store.toolSettings.highlighterStraightLine).toBe(false);
    expect(store.toolSettings.highlighterTipShape).toBe('round');
    expect(store.toolSettings.stampPreset).toBe('APPROVED');
    expect(store.toolSettings.redactionColor).toBe('#000000');
  });

  it('supports configuring shape fill color and applies to drawn shapes', () => {
    store.updateToolSettings({ shapeFillColor: '#3b82f6' });
    expect(store.toolSettings.shapeFillColor).toBe('#3b82f6');

    shapesTool.start(
      { x: 10, y: 10 },
      0,
      'rectangle',
      '#ef4444',
      store.toolSettings.shapeFillColor,
      2,
      'solid'
    );
    shapesTool.move({ x: 100, y: 80 });
    const rect = shapesTool.finish('layer-1');
    expect(rect).not.toBeNull();
    expect(rect?.fillColor).toBe('#3b82f6');

    store.updateToolSettings({ shapeFillColor: 'transparent' });
    expect(store.toolSettings.shapeFillColor).toBe('transparent');
  });
});

