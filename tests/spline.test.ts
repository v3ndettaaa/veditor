import { describe, it, expect } from 'vitest';
import { calculateStrokeWidth, generateSmoothSegments } from '../src/annotations/spline';
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
});
