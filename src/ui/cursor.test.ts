import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWheelZoomFactor } from '../core/viewport';
import {
  shouldUseFloatingToolCursor,
  buildFloatingToolCursorSpec,
  drawingCursorValue
} from './cursor';
import { store } from '../core/store';

function withWindowElectron(enabled: boolean, fn: () => void): void {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  const prevWindow = g.window;
  g.window = enabled
    ? { __VEDITOR_ELECTRON__: { isElectron: true, platform: 'linux' }, devicePixelRatio: 2 }
    : { devicePixelRatio: 2 };
  try {
    fn();
  } finally {
    if (prevWindow === undefined) {
      delete g.window;
    } else {
      g.window = prevWindow;
    }
  }
}

test('computeWheelZoomFactor keeps exact extension 0.0035 sensitivity on non-Electron', () => {
  const f1 = computeWheelZoomFactor(-10, 0, false);
  const f2 = computeWheelZoomFactor(25, 0, false);
  assert.ok(Math.abs(f1 - Math.exp(10 * 0.0035)) < 1e-12);
  assert.ok(Math.abs(f2 - Math.exp(-25 * 0.0035)) < 1e-12);
});

test('computeWheelZoomFactor on Electron is strictly continuous with no cliff and clamps Wayland spikes', () => {
  const f47 = computeWheelZoomFactor(-47, 0, true);
  const f48 = computeWheelZoomFactor(-48, 0, true);
  const f485 = computeWheelZoomFactor(-48.5, 0, true);
  const f49 = computeWheelZoomFactor(-49, 0, true);

  // Strictly monotonic across the old 48px boundary — zero 2.86x discontinuity cliff!
  assert.ok(f47 < f48 && f48 < f485 && f485 < f49);
  assert.ok(Math.abs(f48 - Math.exp(48 * 0.0055)) < 1e-12);

  // Wayland/libinput single-event spikes are clamped at ±50px (~1.316x max per event)
  const f50 = computeWheelZoomFactor(-50, 0, true);
  const f160 = computeWheelZoomFactor(-160, 0, true);
  assert.equal(f160, f50);
  assert.ok(f160 < 1.35 && f160 > 1.25);

  const fOut = computeWheelZoomFactor(160, 0, true);
  assert.equal(fOut, computeWheelZoomFactor(50, 0, true));
  assert.ok(fOut > 0.72 && fOut < 0.8);
});

test('Extension / non-Electron uses floating cursor ONLY for Eraser (circle/dot/icon), preserving Pen/Highlighter CSS cursors', () => {
  const prevEraserCursor = store.toolSettings.eraserCursor;
  try {
    store.toolSettings.eraserCursor = 'circle';
    assert.equal(shouldUseFloatingToolCursor('eraser', 'pen', false), true);
    const eraserSpec = buildFloatingToolCursorSpec('eraser', 'pen', 1.5, false);
    assert.ok(eraserSpec !== null);
    assert.ok(eraserSpec.svg.includes('<circle'));
    assert.ok(eraserSpec.sig.startsWith('eraser|circle|'));

    // Crosshair eraser keeps native crosshair CSS cursor
    store.toolSettings.eraserCursor = 'crosshair';
    assert.equal(shouldUseFloatingToolCursor('eraser', 'pen', false), false);

    // Non-Electron Pen & Highlighter keep native CSS cursors (not floating overlay)
    assert.equal(shouldUseFloatingToolCursor('pen', 'pen', false), false);
    assert.equal(shouldUseFloatingToolCursor('highlighter', 'pen', false), false);
    assert.equal(shouldUseFloatingToolCursor('select', 'pen', false), false);
    assert.equal(shouldUseFloatingToolCursor('hand', 'pen', false), false);

    withWindowElectron(false, () => {
      store.toolSettings.eraserCursor = 'circle';
      assert.equal(drawingCursorValue('eraser', 'pen', 1.0), 'none');
      assert.ok(drawingCursorValue('pen', 'pen', 1.0).startsWith('url("data:image/svg+xml,'));
    });
  } finally {
    store.toolSettings.eraserCursor = prevEraserCursor;
  }
});

test('Electron uses floating GPU cursor for Pen, Highlighter, and Eraser so Wayland never reverts to OS arrow', () => {
  const prevEraserCursor = store.toolSettings.eraserCursor;
  const prevHlCursor = store.toolSettings.highlighterCursor;
  try {
    store.toolSettings.eraserCursor = 'circle';
    store.toolSettings.highlighterCursor = 'rectangle';

    assert.equal(shouldUseFloatingToolCursor('pen', 'pen', true), true);
    assert.equal(shouldUseFloatingToolCursor('pen', 'circle', true), true);
    assert.equal(shouldUseFloatingToolCursor('pen', 'crosshair', true), false);
    assert.equal(shouldUseFloatingToolCursor('highlighter', 'pen', true), true);
    assert.equal(shouldUseFloatingToolCursor('eraser', 'pen', true), true);
    assert.equal(shouldUseFloatingToolCursor('select', 'pen', true), false);
    assert.equal(shouldUseFloatingToolCursor('hand', 'pen', true), false);

    const penSpec = buildFloatingToolCursorSpec('pen', 'pen', 1.0, true);
    assert.ok(penSpec !== null);
    assert.equal(penSpec.sig, 'pen|nib');
    assert.equal(penSpec.hotspotX, 2);
    assert.equal(penSpec.hotspotY, 22);

    const hlSpec = buildFloatingToolCursorSpec('highlighter', 'pen', 1.25, true);
    assert.ok(hlSpec !== null);
    assert.ok(hlSpec.svg.includes('<rect'));

    withWindowElectron(true, () => {
      assert.equal(drawingCursorValue('pen', 'pen', 1.0), 'none');
      assert.equal(drawingCursorValue('highlighter', 'pen', 1.0), 'none');
      assert.equal(drawingCursorValue('eraser', 'pen', 1.0), 'none');
      assert.equal(drawingCursorValue('select', 'pen', 1.0), 'default');
      assert.equal(drawingCursorValue('hand', 'pen', 1.0), 'grab');
    });
  } finally {
    store.toolSettings.eraserCursor = prevEraserCursor;
    store.toolSettings.highlighterCursor = prevHlCursor;
  }
});
