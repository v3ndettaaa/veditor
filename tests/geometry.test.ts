import { describe, it, expect } from 'vitest';
import {
  distance,
  distanceToSegment,
  computePointsBoundingBox,
  isPointInBox,
  isPointInPolygon,
  polygonArea,
  boxesIntersect,
  mergeBoundingBoxes
} from '../src/utils/geometry';

describe('Geometry Utilities', () => {
  it('calculates euclidean distance between two points', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(distance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });

  it('calculates distance to line segment correctly', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    // Point above midpoint
    expect(distanceToSegment({ x: 5, y: 5 }, a, b)).toBe(5);
    // Point past endpoint b
    expect(distanceToSegment({ x: 15, y: 0 }, a, b)).toBe(5);
    // Point before endpoint a
    expect(distanceToSegment({ x: -3, y: 0 }, a, b)).toBe(3);
  });

  it('computes accurate bounding box for a set of points', () => {
    const points = [
      { x: 10, y: 20 },
      { x: 50, y: 80 },
      { x: 30, y: 10 }
    ];
    const box = computePointsBoundingBox(points, 5);
    expect(box.x).toBe(5); // 10 - 5
    expect(box.y).toBe(5); // 10 - 5
    expect(box.width).toBe(50); // 40 + 10
    expect(box.height).toBe(80); // 70 + 10
  });

  it('tests point inside bounding box', () => {
    const box = { x: 20, y: 20, width: 100, height: 50 };
    expect(isPointInBox({ x: 50, y: 40 }, box)).toBe(true);
    expect(isPointInBox({ x: 10, y: 40 }, box)).toBe(false);
    expect(isPointInBox({ x: 150, y: 40 }, box)).toBe(false);
  });

  it('tests point in polygon algorithm (ray-casting)', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ];
    expect(isPointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(isPointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it('calculates polygon area correctly', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 4 }
    ];
    expect(polygonArea(triangle)).toBe(12); // (6 * 4) / 2 = 12
  });

  it('detects bounding box intersections', () => {
    const a = { x: 0, y: 0, width: 20, height: 20 };
    const b = { x: 10, y: 10, width: 20, height: 20 };
    const c = { x: 50, y: 50, width: 10, height: 10 };

    expect(boxesIntersect(a, b)).toBe(true);
    expect(boxesIntersect(a, c)).toBe(false);
  });

  it('merges multiple bounding boxes into an enveloping box', () => {
    const b1 = { x: 10, y: 10, width: 20, height: 20 };
    const b2 = { x: 50, y: 30, width: 30, height: 40 };
    const merged = mergeBoundingBoxes([b1, b2]);

    expect(merged.x).toBe(10);
    expect(merged.y).toBe(10);
    expect(merged.width).toBe(70); // 80 - 10
    expect(merged.height).toBe(60); // 70 - 10
  });
});
