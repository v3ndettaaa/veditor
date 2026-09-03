/**
 * Stylus Pressure Curve Engine
 * Calibrates and normalizes raw stylus pressure values across hardware devices.
 */

export type PressureCurveType = 'linear' | 'soft' | 'firm' | 'exponential';

export class PressureEngine {
  public static mapPressure(
    rawPressure: number | undefined,
    curve: PressureCurveType = 'linear',
    enabled: boolean = true,
    pointerType: string = 'pen',
    mouseSimulation: boolean = false,
    simulatedPressure: number = 0.5
  ): number {
    if (!enabled) {
      return 0.5; // fallback neutral pressure when pressure sensitivity is disabled
    }

    let p: number;

    if (pointerType === 'mouse') {
      if (mouseSimulation) {
        p = simulatedPressure;
      } else {
        return 0.5; // standard uniform mouse pressure
      }
    } else {
      if (rawPressure === undefined || isNaN(rawPressure) || rawPressure === 0) {
        p = 0.5;
      } else {
        p = rawPressure;
      }
    }

    p = Math.max(0.01, Math.min(1.0, p));

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
