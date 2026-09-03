/**
 * Stylus Pressure Curve Engine
 * Calibrates and normalizes raw stylus pressure values across hardware devices.
 */

export type PressureCurveType = 'linear' | 'soft' | 'firm' | 'exponential';

export class PressureEngine {
  public static mapPressure(rawPressure: number | undefined, curve: PressureCurveType = 'linear'): number {
    if (rawPressure === undefined || isNaN(rawPressure) || rawPressure === 0) {
      return 0.5; // fallback default for non-pressure devices (mouse)
    }

    const p = Math.max(0.01, Math.min(1.0, rawPressure));

    switch (curve) {
      case 'soft':
        // Soft curve: high sensitivity with light pressure
        return Math.sqrt(p);

      case 'firm':
        // Firm curve: requires more physical pressure to produce heavy strokes
        return p * p;

      case 'exponential':
        // Exponential: high dynamic range
        return Math.pow(p, 2.5);

      case 'linear':
      default:
        return p;
    }
  }
}
