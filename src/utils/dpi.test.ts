import test from 'node:test';
import assert from 'node:assert/strict';
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

test('resolveAdaptiveCanvasDpr preserves 2.5x-3.0x HiDPI budget on non-Electron platforms', () => {
  withMockWindow({ devicePixelRatio: 1, isElectron: false }, () => {
    const dpr = resolveAdaptiveCanvasDpr(612, 792);
    assert.equal(dpr, 2.5);
  });

  withMockWindow({ devicePixelRatio: 2, isElectron: false }, () => {
    const dpr = resolveAdaptiveCanvasDpr(612, 792, 216);
    assert.equal(dpr, 3.0);
  });

  withMockWindow({ devicePixelRatio: 2, isElectron: false }, () => {
    const dpr = resolveAdaptiveCanvasDpr(2400, 3000, 216);
    assert.ok(2400 * dpr <= ADAPTIVE_CANVAS_MAX_DIMENSION + 0.01);
    assert.ok(3000 * dpr <= ADAPTIVE_CANVAS_MAX_DIMENSION + 0.01);
    assert.ok((2400 * dpr) * (3000 * dpr) <= ADAPTIVE_CANVAS_MAX_PIXELS + 10);
  });
});

test('resolveAdaptiveCanvasDpr uses leaner 1.5x-2.0x / 2560px / 4.2MP ceiling exclusively on Electron', () => {
  withMockWindow({ devicePixelRatio: 1, isElectron: true }, () => {
    const dpr = resolveAdaptiveCanvasDpr(612, 792);
    assert.equal(dpr, 1.5);
  });

  withMockWindow({ devicePixelRatio: 2, isElectron: true }, () => {
    const dpr = resolveAdaptiveCanvasDpr(612, 792, 216);
    assert.equal(dpr, 2.0);
  });

  withMockWindow({ devicePixelRatio: 2, isElectron: true }, () => {
    const dpr = resolveAdaptiveCanvasDpr(1800, 2200, 216);
    assert.ok(1800 * dpr <= ELECTRON_CANVAS_MAX_DIMENSION + 0.01);
    assert.ok(2200 * dpr <= ELECTRON_CANVAS_MAX_DIMENSION + 0.01);
    assert.ok((1800 * dpr) * (2200 * dpr) <= ELECTRON_CANVAS_MAX_PIXELS + 10);
  });
});
