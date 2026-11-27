import { describe, it, expect } from 'vitest';
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

describe('computeWheelZoomFactor & floating tool cursors', () => {
  it('keeps exact extension 0.0035 sensitivity on non-Electron', () => {
    const f1 = computeWheelZoomFactor(-10, 0, false);
    const f2 = computeWheelZoomFactor(25, 0, false);
    expect(Math.abs(f1 - Math.exp(10 * 0.0035))).toBeLessThan(1e-12);
    expect(Math.abs(f2 - Math.exp(-25 * 0.0035))).toBeLessThan(1e-12);
  });

  it('on Electron is strictly continuous with no cliff and clamps Wayland spikes', () => {
    const f47 = computeWheelZoomFactor(-47, 0, true);
    const f48 = computeWheelZoomFactor(-48, 0, true);
    const f485 = computeWheelZoomFactor(-48.5, 0, true);
    const f49 = computeWheelZoomFactor(-49, 0, true);

    expect(f47).toBeLessThan(f48);
    expect(f48).toBeLessThan(f485);
    expect(f485).toBeLessThan(f49);
    expect(Math.abs(f48 - Math.exp(48 * 0.0055))).toBeLessThan(1e-12);

    const f50 = computeWheelZoomFactor(-50, 0, true);
    const f160 = computeWheelZoomFactor(-160, 0, true);
    expect(f160).toBe(f50);
    expect(f160).toBeGreaterThan(1.25);
    expect(f160).toBeLessThan(1.35);

    const fOut = computeWheelZoomFactor(160, 0, true);
    expect(fOut).toBe(computeWheelZoomFactor(50, 0, true));
    expect(fOut).toBeGreaterThan(0.72);
    expect(fOut).toBeLessThan(0.8);
  });

  it('uses floating cursor ONLY for Eraser (circle/dot/icon) on non-Electron, preserving Pen/Highlighter CSS cursors', () => {
    const prevEraserCursor = store.toolSettings.eraserCursor;
    try {
      store.toolSettings.eraserCursor = 'circle';
      expect(shouldUseFloatingToolCursor('eraser', 'pen', false)).toBe(true);
      const eraserSpec = buildFloatingToolCursorSpec('eraser', 'pen', 1.5, false);
      expect(eraserSpec).not.toBeNull();
      expect(eraserSpec!.svg).toContain('<circle');
      expect(eraserSpec!.sig.startsWith('eraser|circle|')).toBe(true);

      store.toolSettings.eraserCursor = 'crosshair';
      expect(shouldUseFloatingToolCursor('eraser', 'pen', false)).toBe(false);

      expect(shouldUseFloatingToolCursor('pen', 'pen', false)).toBe(false);
      expect(shouldUseFloatingToolCursor('highlighter', 'pen', false)).toBe(false);
      expect(shouldUseFloatingToolCursor('select', 'pen', false)).toBe(false);
      expect(shouldUseFloatingToolCursor('hand', 'pen', false)).toBe(false);

      withWindowElectron(false, () => {
        store.toolSettings.eraserCursor = 'circle';
        expect(drawingCursorValue('eraser', 'pen', 1.0)).toBe('none');
        expect(drawingCursorValue('pen', 'pen', 1.0).startsWith('url("data:image/svg+xml,')).toBe(true);
      });
    } finally {
      store.toolSettings.eraserCursor = prevEraserCursor;
    }
  });

  it('uses floating GPU cursor for Pen, Highlighter, and Eraser on Electron so Wayland never reverts to OS arrow', () => {
    const prevEraserCursor = store.toolSettings.eraserCursor;
    const prevHlCursor = store.toolSettings.highlighterCursor;
    try {
      store.toolSettings.eraserCursor = 'circle';
      store.toolSettings.highlighterCursor = 'rectangle';

      expect(shouldUseFloatingToolCursor('pen', 'pen', true)).toBe(true);
      expect(shouldUseFloatingToolCursor('pen', 'circle', true)).toBe(true);
      expect(shouldUseFloatingToolCursor('pen', 'crosshair', true)).toBe(false);
      expect(shouldUseFloatingToolCursor('highlighter', 'pen', true)).toBe(true);
      expect(shouldUseFloatingToolCursor('eraser', 'pen', true)).toBe(true);
      expect(shouldUseFloatingToolCursor('select', 'pen', true)).toBe(false);
      expect(shouldUseFloatingToolCursor('hand', 'pen', true)).toBe(false);

      const penSpec = buildFloatingToolCursorSpec('pen', 'pen', 1.0, true);
      expect(penSpec).not.toBeNull();
      expect(penSpec!.sig).toBe('pen|nib');
      expect(penSpec!.hotspotX).toBe(2);
      expect(penSpec!.hotspotY).toBe(22);

      const hlSpec = buildFloatingToolCursorSpec('highlighter', 'pen', 1.25, true);
      expect(hlSpec).not.toBeNull();
      expect(hlSpec!.svg).toContain('<rect');

      withWindowElectron(true, () => {
        expect(drawingCursorValue('pen', 'pen', 1.0)).toBe('none');
        expect(drawingCursorValue('highlighter', 'pen', 1.0)).toBe('none');
        expect(drawingCursorValue('eraser', 'pen', 1.0)).toBe('none');
        expect(drawingCursorValue('select', 'pen', 1.0)).toBe('default');
        expect(drawingCursorValue('hand', 'pen', 1.0)).toBe('grab');
      });
    } finally {
      store.toolSettings.eraserCursor = prevEraserCursor;
      store.toolSettings.highlighterCursor = prevHlCursor;
    }
  });
});
