import { describe, it, expect } from 'vitest';
import { fitStroke, resamplePoints, rdp } from '../src/utils/shape-fit';
import type { Point } from '../src/core/types';

function linePts(p0: Point, p1: Point, n = 20, jitter = 0.6): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({
      x: p0.x + (p1.x - p0.x) * t + (Math.sin(i * 3.7) * jitter),
      y: p0.y + (p1.y - p0.y) * t + (Math.cos(i * 2.9) * jitter)
    });
  }
  return pts;
}

function circlePts(cx: number, cy: number, r: number, n = 40): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.98 });
  }
  return pts;
}

function rectPts(x: number, y: number, w: number, h: number, per = 10): Point[] {
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y }
  ];
  const pts: Point[] = [];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < per; i++) {
      const t = i / per;
      pts.push({
        x: corners[s].x + (corners[s + 1].x - corners[s].x) * t,
        y: corners[s].y + (corners[s + 1].y - corners[s].y) * t
      });
    }
  }
  pts.push({ ...corners[4] });
  return pts;
}

describe('shape-fit', () => {
  it('resamples to N points', () => {
    const out = resamplePoints(linePts({ x: 0, y: 0 }, { x: 100, y: 0 }, 5), 32);
    expect(out).toHaveLength(32);
  });

  it('rdp keeps line endpoints, drops collinear middles', () => {
    const out = rdp(linePts({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, 0.1), 2);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('fits a straight drawn line', () => {
    const fit = fitStroke(linePts({ x: 10, y: 10 }, { x: 200, y: 40 }));
    expect(fit?.kind).toBe('line');
  });

  it('fits an arrow with a head hook', () => {
    const shaft = linePts({ x: 10, y: 10 }, { x: 180, y: 10 }, 16, 0.5);
    // Hook back: barb strokes at the end.
    shaft.push({ x: 160, y: 22 }, { x: 150, y: 30 }, { x: 165, y: 12 });
    const fit = fitStroke(shaft);
    expect(fit?.kind).toBe('arrow');
  });

  it('fits a drawn circle to ellipse', () => {
    const fit = fitStroke(circlePts(100, 100, 60));
    expect(fit?.kind).toBe('ellipse');
    if (fit?.kind === 'ellipse') {
      expect(Math.abs(fit.rx - fit.ry) / fit.rx).toBeLessThan(0.3);
    }
  });

  it('fits a drawn rectangle', () => {
    const fit = fitStroke(rectPts(20, 20, 160, 100));
    expect(fit?.kind).toBe('rectangle');
  });

  it('fits a drawn triangle to polygon', () => {
    const tri: Point[] = [];
    const v = [{ x: 100, y: 20 }, { x: 180, y: 140 }, { x: 20, y: 140 }, { x: 100, y: 20 }];
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 12; i++) {
        const t = i / 12;
        tri.push({ x: v[s].x + (v[s + 1].x - v[s].x) * t, y: v[s].y + (v[s + 1].y - v[s].y) * t });
      }
    }
    const fit = fitStroke(tri);
    expect(fit?.kind).toBe('polygon');
  });

  it('resolves a wobbly triangle to a 3-vertex primitive', () => {
    const tri: Point[] = [];
    const v = [{ x: 100, y: 20 }, { x: 180, y: 140 }, { x: 20, y: 140 }, { x: 100, y: 20 }];
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 10; i++) {
        const t = i / 10;
        tri.push({
          x: v[s].x + (v[s + 1].x - v[s].x) * t + Math.sin(i * 2.1) * 3,
          y: v[s].y + (v[s + 1].y - v[s].y) * t + Math.cos(i * 1.7) * 3
        });
      }
    }
    const fit = fitStroke(tri);
    expect(fit?.kind).toBe('polygon');
    if (fit?.kind === 'polygon') expect(fit.points.length).toBe(3);
  });

  it('rejects dots and tiny scribbles to ink', () => {
    expect(fitStroke([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    const tiny = linePts({ x: 0, y: 0 }, { x: 5, y: 3 }, 10, 0.2);
    expect(fitStroke(tiny)).toBeNull();
  });

  it('rejects wild scribbles to ink', () => {
    const pts: Point[] = [];
    for (let i = 0; i < 40; i++) {
      pts.push({ x: (i * 37) % 200, y: (i * 53) % 150 });
    }
    expect(fitStroke(pts)).toBeNull();
  });
});
