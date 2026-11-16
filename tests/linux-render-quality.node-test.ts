import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_CANVAS_MAX_DIMENSION,
  ADAPTIVE_CANVAS_MAX_PIXELS,
  resolveAdaptiveCanvasDpr
} from '../src/utils/dpi';
import { normalizeWheelDeltaY } from '../src/core/viewport';

test('resolveAdaptiveCanvasDpr stays >= 1.5x at high zoom on 1080p/1440p viewports under platform-linux', () => {
  const prevWin = (globalThis as any).window;
  const prevDoc = (globalThis as any).document;
  try {
    (globalThis as any).window = { devicePixelRatio: 1 };
    const classes = new Set(['platform-linux', 'platform-desktop']);
    (globalThis as any).document = {
      documentElement: { classList: { contains: (c: string) => classes.has(c) } }
    };

    const chunk1080p = resolveAdaptiveCanvasDpr(1844, 1256, 200);
    assert.ok(chunk1080p >= 1.8, `expected >= 1.8x on 1080p chunk, got ${chunk1080p}`);
    assert.ok(1844 * chunk1080p <= ADAPTIVE_CANVAS_MAX_DIMENSION);
    assert.ok((1844 * chunk1080p) * (1256 * chunk1080p) <= ADAPTIVE_CANVAS_MAX_PIXELS + 1);

    const chunk1440p = resolveAdaptiveCanvasDpr(2400, 1400, 200);
    assert.ok(chunk1440p >= 1.5, `expected >= 1.5x on 1440p chunk, got ${chunk1440p}`);
  } finally {
    (globalThis as any).window = prevWin;
    (globalThis as any).document = prevDoc;
  }
});

test('normalizeWheelDeltaY normalizes line/page modes and clamps Wayland/libinput spikes', () => {
  assert.equal(normalizeWheelDeltaY(-40, 0), -40);
  assert.equal(normalizeWheelDeltaY(-3, 1), -60);
  assert.equal(normalizeWheelDeltaY(1, 2), 160);
  assert.equal(normalizeWheelDeltaY(900, 0), 160);
  assert.equal(normalizeWheelDeltaY(-900, 0), -160);
  assert.equal(normalizeWheelDeltaY(Number.NaN, 0), 0);
});
