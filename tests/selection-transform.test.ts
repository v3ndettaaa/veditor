import { describe, it, expect } from 'vitest';
import {
  selectionManager,
  normalizeDragBox,
  transformAnnotation,
  rotatePoint,
  boxCenter
} from '../src/annotations/selection';
import { store } from '../src/core/store';
import { PenAnnotation, ShapeAnnotation } from '../src/core/types';

const pen = (id: string, x: number, y: number, w = 100, h = 40): PenAnnotation => ({
  id,
  pageIndex: 0,
  layerId: 'default',
  type: 'pen',
  color: '#000000',
  strokeWidth: 4,
  opacity: 1,
  box: { x, y, width: w, height: h },
  points: [
    { x, y, pressure: 0.5 },
    { x: x + w, y: y + h, pressure: 0.5 }
  ],
  createdAt: 0,
  updatedAt: 0
});

describe('Region selection helpers', () => {
  it('normalizes drag corners into a positive box', () => {
    expect(normalizeDragBox({ x: 50, y: 60 }, { x: 10, y: 20 }))
      .toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it('finds only unlocked intersecting annotations', () => {
    const inside = pen('a', 10, 10);
    const outside = pen('b', 500, 500);
    const locked = { ...pen('c', 12, 12), locked: true };
    const hits = selectionManager.findAnnotationsInRect(
      { x: 0, y: 0, width: 100, height: 100 },
      [inside, outside, locked]
    );
    expect(hits.map(a => a.id)).toEqual(['a']);
  });
});

describe('Annotation transforms', () => {
  it('translates points and box on move without resizing', () => {
    const next = transformAnnotation(
      pen('a', 10, 10),
      { dx: 5, dy: -3, scaleX: 1, scaleY: 1, originX: 10, originY: 10 }
    );
    expect(next.box).toMatchObject({ x: 15, y: 7, width: 100, height: 40 });
    expect(next.points[0]).toMatchObject({ x: 15, y: 7 });
    expect(next.points[1]).toMatchObject({ x: 115, y: 47 });
    expect(next.strokeWidth).toBe(4);
  });

  it('scales box, points and stroke width on resize', () => {
    const next = transformAnnotation(
      pen('a', 10, 10),
      { dx: 0, dy: 0, scaleX: 2, scaleY: 0.5, originX: 10, originY: 10 }
    );
    expect(next.box).toMatchObject({ x: 10, y: 10, width: 200, height: 20 });
    expect(next.points[1]).toMatchObject({ x: 210, y: 30 });
    expect(next.strokeWidth).toBeCloseTo(4 * 1.25, 6);
  });

  it('scales font size for text-like annotations', () => {
    const callout: any = {
      id: 'c',
      pageIndex: 0,
      layerId: 'default',
      type: 'callout',
      box: { x: 0, y: 0, width: 100, height: 50 },
      arrowPoint: { x: 50, y: 80 },
      text: 'hi',
      fontFamily: 'Inter',
      fontSize: 14,
      color: '#000',
      fillColor: '#fff',
      strokeColor: '#000',
      opacity: 1,
      createdAt: 0,
      updatedAt: 0
    };
    const next = transformAnnotation(callout, { dx: 0, dy: 0, scaleX: 2, scaleY: 2, originX: 0, originY: 0 });
    expect(next.fontSize).toBe(28);
    expect(next.arrowPoint).toMatchObject({ x: 100, y: 160 });
  });

  it('hits rotated annotations in their unrotated frame', () => {
    // 100x20 bar rotated 90° about its center: visually vertical.
    const bar = { ...pen('r', 0, 0), box: { x: 0, y: 0, width: 100, height: 20 }, rotation: Math.PI / 2 };
    // Center always hits.
    expect(selectionManager.findAnnotationAtPoint({ x: 50, y: 10 }, [bar])?.id).toBe('r');
    // Top end of the vertical bar (would miss without rotation support).
    expect(selectionManager.findAnnotationAtPoint({ x: 50, y: 55 }, [bar])?.id).toBe('r');
    // Far away still misses.
    expect(selectionManager.findAnnotationAtPoint({ x: 200, y: 200 }, [bar])).toBeNull();
  });

  it('hit-tests rotated selection handles and keeps rotation on transform', () => {
    const box = { x: 0, y: 0, width: 100, height: 20 };
    const c = boxCenter(box);
    // The unrotated NW corner, rotated 90° about the center, still grabs 'nw'.
    const rotatedCorner = rotatePoint({ x: 0, y: 0 }, c, Math.PI / 2);
    expect(selectionManager.hitTestHandles(rotatedCorner, box, 1, Math.PI / 2)).toBe('nw');
    // Move preserves an existing rotation.
    const moved = transformAnnotation(
      { ...pen('a', 0, 0), rotation: 0.5 },
      { dx: 10, dy: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0 }
    );
    expect(moved.rotation).toBe(0.5);
  });

  it('grabs the rotation pin at any zoom (pin is drawn unscaled)', () => {
    const box = { x: 0, y: 100, width: 200, height: 60 };
    const pin = { x: 100, y: 100 - 24 };
    for (const scale of [0.5, 1, 2, 2.81, 5]) {
      expect(selectionManager.hitTestHandles(pin, box, scale)).toBe('rot');
    }
  });

  it('additive (Ctrl-style) selection toggles without clearing', () => {
    store.setSelectedAnnotationIds(['a']);
    store.selectAnnotation('b', true);
    expect([...store.selectedAnnotationIds].sort()).toEqual(['a', 'b']);
    store.selectAnnotation('a', true);
    expect([...store.selectedAnnotationIds]).toEqual(['b']);
    store.clearSelection();
    expect(store.selectedAnnotationIds.size).toBe(0);
  });

  it('rotates points around a pivot correctly', () => {
    const p = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
    // Full circle is identity.
    const q = rotatePoint({ x: 7, y: -3 }, { x: 2, y: 2 }, Math.PI * 2);
    expect(q.x).toBeCloseTo(7, 9);
    expect(q.y).toBeCloseTo(-3, 9);
  });

  it('leaves shape point lists intact when absent', () => {
    const rect: ShapeAnnotation = {
      id: 'r',
      pageIndex: 0,
      layerId: 'default',
      type: 'rectangle',
      box: { x: 0, y: 0, width: 50, height: 50 },
      strokeColor: '#000',
      strokeWidth: 2,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 0,
      updatedAt: 0
    };
    const next = transformAnnotation(rect, { dx: 10, dy: 10, scaleX: 1, scaleY: 1, originX: 0, originY: 0 });
    expect(next.box).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
    expect(next.points).toBeUndefined();
  });
});
