import { describe, it, expect, vi } from 'vitest';
import {
  calculateStrokeWidth,
  generateSmoothSegments,
  smoothStrokePoints,
  sampleCentripetalPenSpline,
  renderSmoothStroke
} from '../src/annotations/spline';
import { PressureEngine } from '../src/input/pressure';

describe('Spline & Pressure Engine', () => {
  it('maps pressure curves accurately', () => {
    // Linear
    expect(PressureEngine.mapPressure(0.5, 'linear')).toBe(0.5);

    // Soft curve increases sensitivity for light touches
    expect(PressureEngine.mapPressure(0.25, 'soft')).toBe(0.5); // sqrt(0.25) = 0.5

    // Firm curve requires harder touch
    expect(PressureEngine.mapPressure(0.5, 'firm')).toBe(0.25); // 0.5^2 = 0.25
  });

  it('calculates dynamic stroke width from pressure', () => {
    const baseWidth = 10;
    const wLight = calculateStrokeWidth(baseWidth, 0.1, 'linear');
    const wNormal = calculateStrokeWidth(baseWidth, 0.5, 'linear');
    const wHeavy = calculateStrokeWidth(baseWidth, 1.0, 'linear');

    expect(wLight).toBeLessThan(wNormal);
    expect(wNormal).toBeLessThan(wHeavy);
    expect(wHeavy).toBeGreaterThan(10);
  });

  it('generates smooth cubic bezier segments for stroke points', () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 20, y: 15, pressure: 0.6 },
      { x: 45, y: 30, pressure: 0.7 },
      { x: 70, y: 50, pressure: 0.5 }
    ];

    const segments = generateSmoothSegments(points, 4, 'linear');
    expect(segments.length).toBe(3); // 4 points -> 3 bezier segments
    expect(segments[0].p0.x).toBe(0);
    expect(segments[0].p1.x).toBe(20);
    expect(segments[0].cp1).toBeDefined();
    expect(segments[0].cp2).toBeDefined();
  });

  it('still generates cubic interpolation when pressure sensitivity is disabled', () => {
    const points = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 20, y: 15, pressure: 0.9 },
      { x: 45, y: 30, pressure: 0.2 }
    ];
    const segments = generateSmoothSegments(points, 8, 'linear', false);
    expect(segments.length).toBe(2);
    for (const segment of segments) {
      expect(segment.widthStart).toBe(8);
      expect(segment.widthEnd).toBe(8);
      expect(segment.cp1).toBeDefined();
      expect(segment.cp2).toBeDefined();
    }
  });

  it('returns uniform stroke width when pressure sensitivity is disabled', () => {
    const baseWidth = 8;
    // When pressure sensitivity is off, line width is strictly uniform
    expect(calculateStrokeWidth(baseWidth, 0.1, 'linear', false)).toBe(baseWidth);
    expect(calculateStrokeWidth(baseWidth, 0.5, 'linear', false)).toBe(baseWidth);
    expect(calculateStrokeWidth(baseWidth, 0.9, 'linear', false)).toBe(baseWidth);
    expect(calculateStrokeWidth(baseWidth, 1.0, 'exponential', false)).toBe(baseWidth);
  });

  it('handles pressure sensitivity toggle and mouse velocity simulation in PressureEngine', () => {
    // When disabled, returns fixed neutral 0.5
    expect(PressureEngine.mapPressure(0.9, 'exponential', false)).toBe(0.5);
    expect(PressureEngine.mapPressure(0.1, 'soft', false)).toBe(0.5);

    // Mouse pointer without simulation returns 0.5
    expect(PressureEngine.mapPressure(0.8, 'linear', true, 'mouse', false)).toBe(0.5);

    // Mouse pointer with simulation returns velocity-simulated value
    const simulated = 0.35;
    expect(PressureEngine.mapPressure(0.0, 'linear', true, 'mouse', true, simulated)).toBe(0.35);
  });

  it('supports variable pressure dynamic range strengths', () => {
    const baseWidth = 10;
    const wLightMin = calculateStrokeWidth(baseWidth, 0.0, 'linear', true, 'light');
    const wStrongMin = calculateStrokeWidth(baseWidth, 0.0, 'linear', true, 'strong');

    // Strong dynamic range allows significantly thinner strokes at zero pressure
    expect(wStrongMin).toBeLessThan(wLightMin);
  });

  it('filters micro-jitter and smoothes pressure with smoothStrokePoints', () => {
    const rawPoints = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 0.05, y: 0.05, pressure: 0.8 }, // jitter (<0.14pt away) - should be filtered
      { x: 10, y: 10, pressure: 0.2 },
      { x: 20, y: 20, pressure: 0.9 },
      { x: 30, y: 30, pressure: 0.4 }
    ];

    const smoothed = smoothStrokePoints(rawPoints, 'medium');
    expect(smoothed.length).toBeLessThan(rawPoints.length);
    expect(smoothed[0].x).toBe(0);
    expect(smoothed[smoothed.length - 1].x).toBe(30);

    // Pressure should not have wild jumps
    for (let i = 1; i < smoothed.length - 1; i++) {
      expect(smoothed[i].pressure).toBeGreaterThanOrEqual(0.1);
      expect(smoothed[i].pressure).toBeLessThanOrEqual(0.9);
    }
  });

  it('clamps bezier control points to at most half chord distance to prevent spikes and loops', () => {
    // Sharp turn / hairpin test that previously blew up Catmull-Rom tangents
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 100, y: 0, pressure: 0.5 },
      { x: 101, y: 1, pressure: 0.5 }, // very close corner point
      { x: 0, y: 100, pressure: 0.5 }
    ];

    const segments = generateSmoothSegments(points, 4, 'linear');
    for (const seg of segments) {
      const chord = Math.hypot(seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y);
      const cp1Dist = Math.hypot(seg.cp1.x - seg.p0.x, seg.cp1.y - seg.p0.y);
      const cp2Dist = Math.hypot(seg.cp2.x - seg.p1.x, seg.cp2.y - seg.p1.y);
      // Control points must never overshoot chord * 0.51 (with float tolerance)
      expect(cp1Dist).toBeLessThanOrEqual(chord * 0.501 + 0.001);
      expect(cp2Dist).toBeLessThanOrEqual(chord * 0.501 + 0.001);
    }
  });

  it('upsamples small handwriting written at 100% zoom into dense sub-0.25pt Centripetal spline points', () => {
    // Small letter curve written at 100% zoom with ~1.5pt chord spacing
    const smallHandwriting = [
      { x: 10, y: 10, pressure: 0.45 },
      { x: 11.4, y: 9.2, pressure: 0.52 },
      { x: 12.6, y: 10.1, pressure: 0.55 },
      { x: 12.1, y: 11.6, pressure: 0.50 },
      { x: 10.5, y: 11.8, pressure: 0.48 }
    ];

    const smoothed = smoothStrokePoints(smallHandwriting, 'medium');
    const sampled = sampleCentripetalPenSpline(smoothed, 1.8, 'linear', true, 'balanced');

    // Should upsample 5 coarse points into a dense, smooth curve (> 25 points)
    expect(sampled.length).toBeGreaterThan(25);
    // Exact start and end points preserved
    expect(sampled[0].x).toBeCloseTo(10, 4);
    expect(sampled[0].y).toBeCloseTo(10, 4);
    expect(sampled[sampled.length - 1].x).toBeCloseTo(10.5, 4);
    expect(sampled[sampled.length - 1].y).toBeCloseTo(11.8, 4);

    // Every step is fine-grained and bounded in width change (no beads or jumps)
    for (let i = 1; i < sampled.length; i++) {
      const ds = Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
      const dw = Math.abs(sampled[i].w - sampled[i - 1].w);
      expect(ds).toBeLessThanOrEqual(0.35);
      expect(dw).toBeLessThanOrEqual(0.05);
    }
  });

  it('renders 1-point and 2-point micro-taps as pure filled 360-degree circular disks without stroke cusps', () => {
    const arcSpy = vi.fn();
    const fillSpy = vi.fn();
    const strokeSpy = vi.fn();
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: arcSpy,
      fill: fillSpy,
      stroke: strokeSpy,
      lineCap: 'round',
      lineJoin: 'round',
      strokeStyle: '#000',
      fillStyle: '#000',
      lineWidth: 1,
      imageSmoothingEnabled: true
    } as unknown as CanvasRenderingContext2D;

    // 2-point micro-tap (0.15pt apart) that previously produced a half-cut dot
    renderSmoothStroke(
      mockCtx,
      [
        { x: 50, y: 50, pressure: 0.5 },
        { x: 50.1, y: 50.05, pressure: 0.5 }
      ],
      '#1e293b',
      2.0,
      'linear',
      false,
      true,
      'balanced',
      'round',
      'medium'
    );

    expect(arcSpy).toHaveBeenCalledTimes(1);
    expect(fillSpy).toHaveBeenCalledTimes(1);
    expect(strokeSpy).not.toHaveBeenCalled();
  });
});

