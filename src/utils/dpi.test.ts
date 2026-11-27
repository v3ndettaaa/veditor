import { describe, it, expect } from 'vitest';
import {
  resolveAdaptiveCanvasDpr,
  ADAPTIVE_CANVAS_MAX_DIMENSION,
  ADAPTIVE_CANVAS_MAX_PIXELS,
  ELECTRON_CANVAS_MAX_DIMENSION,
  ELECTRON_CANVAS_MAX_PIXELS
} from './dpi';

function withMockWindow(
  props: { devicePixelRatio?: number; isElectron?: boolean },
  fn: () => void
): void {
  const prevWindow = (globalThis as any).window;
  (globalThis as any).window = {
    devicePixelRatio: props.devicePixelRatio ?? 1,
    ...(props.isElectron ? { __VEDITOR_ELECTRON__: { isElectron: true, platform: 'linux' } } : {})
  };
  try {
    fn();
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
}

describe('resolveAdaptiveCanvasDpr', () => {
  it('preserves 2.5x-3.0x HiDPI budget on non-Electron platforms', () => {
    withMockWindow({ devicePixelRatio: 1, isElectron: false }, () => {
      const dpr = resolveAdaptiveCanvasDpr(612, 792);
      expect(dpr).toBe(2.5);
    });

    withMockWindow({ devicePixelRatio: 2, isElectron: false }, () => {
      const dpr = resolveAdaptiveCanvasDpr(612, 792, 216);
      expect(dpr).toBe(3.0);
    });

    withMockWindow({ devicePixelRatio: 2, isElectron: false }, () => {
      const dpr = resolveAdaptiveCanvasDpr(2400, 3000, 216);
      expect(2400 * dpr).toBeLessThanOrEqual(ADAPTIVE_CANVAS_MAX_DIMENSION + 0.01);
      expect(3000 * dpr).toBeLessThanOrEqual(ADAPTIVE_CANVAS_MAX_DIMENSION + 0.01);
      expect((2400 * dpr) * (3000 * dpr)).toBeLessThanOrEqual(ADAPTIVE_CANVAS_MAX_PIXELS + 10);
    });
  });

  it('uses leaner 1.5x-2.0x / 2560px / 4.2MP ceiling exclusively on Electron', () => {
    withMockWindow({ devicePixelRatio: 1, isElectron: true }, () => {
      const dpr = resolveAdaptiveCanvasDpr(612, 792);
      expect(dpr).toBe(1.5);
    });

    withMockWindow({ devicePixelRatio: 2, isElectron: true }, () => {
      const dpr = resolveAdaptiveCanvasDpr(612, 792, 216);
      expect(dpr).toBe(2.0);
    });

    withMockWindow({ devicePixelRatio: 2, isElectron: true }, () => {
      const dpr = resolveAdaptiveCanvasDpr(1800, 2200, 216);
      expect(1800 * dpr).toBeLessThanOrEqual(ELECTRON_CANVAS_MAX_DIMENSION + 0.01);
      expect(2200 * dpr).toBeLessThanOrEqual(ELECTRON_CANVAS_MAX_DIMENSION + 0.01);
      expect((1800 * dpr) * (2200 * dpr)).toBeLessThanOrEqual(ELECTRON_CANVAS_MAX_PIXELS + 10);
    });
  });
});
