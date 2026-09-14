import { describe, it, expect } from 'vitest';
import { calculateStrokeWidth, generateSmoothSegments, smoothStrokePoints } from '../src/annotations/spline';
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
      { x: 0.1, y: 0.1, pressure: 0.8 }, // jitter (<0.8px away) - should be filtered
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
});
