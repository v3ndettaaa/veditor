import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const afterPack = require('./after-pack.cjs');

test('afterPack wraps Linux executable and launches native Wayland + pinch flags when WAYLAND_DISPLAY is set', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veditor-afterpack-'));
  try {
    const exePath = path.join(tmpDir, 'veditor-electron');
    // Fake binary prints its argv and ELECTRON_OZONE_PLATFORM_HINT so we can verify real shell execution
    fs.writeFileSync(
      exePath,
      '#!/bin/sh\nprintf "HINT=%s\\n" "$ELECTRON_OZONE_PLATFORM_HINT"\nfor a in "$@"; do printf "ARG=%s\\n" "$a"; done\n',
      { mode: 0o755 }
    );

    await afterPack({
      electronPlatformName: 'linux',
      appOutDir: tmpDir,
      packager: { executableName: 'veditor-electron' }
    });

    assert.equal(fs.existsSync(path.join(tmpDir, 'veditor-electron.bin')), true);
    assert.equal(fs.existsSync(exePath), true);

    // 1. Wayland session -> forces --ozone-platform=wayland + --enable-pinch + --enable-smooth-scrolling
    const waylandOut = execFileSync(exePath, ['/tmp/sample.pdf'], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland' },
      encoding: 'utf8'
    });
    assert.match(waylandOut, /HINT=wayland/);
    assert.match(waylandOut, /ARG=--ozone-platform=wayland/);
    assert.match(waylandOut, /ARG=--enable-pinch/);
    assert.match(waylandOut, /ARG=--enable-smooth-scrolling/);
    assert.match(waylandOut, /ARG=\/tmp\/sample\.pdf/);

    // 2. Symlink invocation (like /usr/bin/veditor-electron -> /opt/veditor/veditor-electron in .deb)
    const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veditor-symlink-'));
    try {
      const linkPath = path.join(symlinkDir, 'veditor-electron');
      fs.symlinkSync(exePath, linkPath);
      const linkOut = execFileSync(linkPath, [], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', WAYLAND_DISPLAY: 'wayland-1' },
        encoding: 'utf8'
      });
      assert.match(linkOut, /ARG=--ozone-platform=wayland/);
    } finally {
      fs.rmSync(symlinkDir, { recursive: true, force: true });
    }

    // 3. Explicit --ozone-platform=x11 override is respected
    const overrideOut = execFileSync(exePath, ['--ozone-platform=x11'], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', WAYLAND_DISPLAY: 'wayland-1' },
      encoding: 'utf8'
    });
    assert.doesNotMatch(overrideOut, /ARG=--ozone-platform=wayland/);
    assert.match(overrideOut, /ARG=--ozone-platform=x11/);

    // 4. Non-Wayland X11 session falls back to --ozone-platform-hint=auto
    const x11Out = execFileSync(exePath, [], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
      encoding: 'utf8'
    });
    assert.match(x11Out, /HINT=auto/);
    assert.match(x11Out, /ARG=--ozone-platform-hint=auto/);
    assert.match(x11Out, /ARG=--enable-pinch/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function createPreloadHarness() {
  const preloadCode = fs.readFileSync(path.resolve(process.cwd(), 'electron/preload.cjs'), 'utf8');

  let nowMs = 1000;
  let nextTimerId = 1;
  let nextRafId = 1;
  const timers = new Map();
  const rafs = new Map();
  const windowListeners = new Map();
  const ipcListeners = new Map();
  let visualZoomLimits = null;

  class MockNode {}
  class MockElement extends MockNode {
    constructor(id) {
      super();
      this.id = id;
      this.isConnected = true;
      this.dataset = {};
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.scrollHeight = 50000;
      this.scrollWidth = 1200;
      this.clientHeight = 900;
      this.clientWidth = 1200;
      this.dispatched = [];
      this.children = [];
      this.listeners = new Map();
    }
    contains(node) {
      return node === this || this.children.includes(node);
    }
    closest() {
      return null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    emitLocal(type, evt = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn(evt);
    }
    dispatchEvent(evt) {
      this.dispatched.push(evt);
      return true;
    }
  }

  class MockWheelEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.isTrusted = false;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const scroller = new MockElement('document-scroll-container');
  const pageNode = new MockElement('page-1');
  scroller.children.push(pageNode);
  const viewport = new MockElement('app-viewport-container');
  const gapNode = new MockElement('viewport-gap');
  viewport.children.push(scroller, gapNode);

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, runAt: nowMs + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(fn) {
      const id = nextRafId++;
      rafs.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      rafs.delete(id);
    }
  };

  const mockDocument = {
    getElementById(id) {
      if (id === 'document-scroll-container') return scroller;
      if (id === 'app-viewport-container') return viewport;
      return null;
    }
  };

  const mockElectron = {
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: {
      invoke: async () => null,
      send() {},
      on(ch, fn) {
        ipcListeners.set(ch, fn);
      },
      removeListener() {}
    },
    webFrame: {
      setVisualZoomLevelLimits(min, max) {
        visualZoomLimits = [min, max];
      },
      setZoomFactor() {}
    }
  };

  const sandbox = {
    require: (mod) => {
      if (mod === 'electron') return mockElectron;
      throw new Error(`Sandboxed preload must not require ${mod}`);
    },
    process: { platform: 'linux' },
    window: mockWindow,
    document: mockDocument,
    performance: { now: () => nowMs },
    Node: MockNode,
    Element: MockElement,
    WheelEvent: MockWheelEvent,
    CustomEvent: MockCustomEvent,
    console
  };

  vm.runInNewContext(preloadCode, sandbox);
  for (const fn of windowListeners.get('DOMContentLoaded') || []) fn();

  const fireWheel = (evt) => {
    for (const fn of windowListeners.get('wheel') || []) fn(evt);
  };

  const flushTimers = () => {
    for (const [id, t] of [...timers.entries()]) {
      if (nowMs >= t.runAt) {
        timers.delete(id);
        t.fn();
      }
    }
  };

  const stepRaf = (advanceMs) => {
    nowMs += advanceMs;
    const batch = [...rafs.entries()];
    rafs.clear();
    for (const [, fn] of batch) fn(nowMs);
  };

  return {
    get nowMs() { return nowMs; },
    advance(ms) { nowMs += ms; },
    rafs,
    timers,
    ipcListeners,
    visualZoomLimits,
    scroller,
    pageNode,
    gapNode,
    MockWheelEvent,
    fireWheel,
    flushTimers,
    stepRaf
  };
}

test('preload Linux fallback kinetic scroller glides on abrupt X11 flick, survives frame spikes, brakes on reverse, and forwards gap pinch', () => {
  const h = createPreloadHarness();
  assert.deepEqual(h.visualZoomLimits, [1, 3]);

  // 1. Brisk downward flick with constant speed (X11 style, no native compositor fling)
  for (let i = 0; i < 4; i++) {
    h.advance(10);
    h.fireWheel(new h.MockWheelEvent('wheel', { deltaX: 0, deltaY: 36, deltaMode: 0, target: h.pageNode }));
  }
  assert.equal(h.scroller.dataset.kineticScrolling, '1');

  // Snapshot rAF runs, native compositor does NOT advance scrollTop afterward
  h.stepRaf(8);
  h.advance(56);
  h.flushTimers();
  assert.equal(h.rafs.size, 1, 'fallback coast should start on X11 when no native fling moved scrollTop');

  const topBeforeCoast = h.scroller.scrollTop;
  h.stepRaf(400); // simulate huge main-thread spike
  assert.ok(h.scroller.scrollTop > topBeforeCoast);
  assert.equal(h.rafs.size, 1, 'coast must continue after frame spike');
  assert.equal(h.scroller.dataset.kineticScrolling, '1');

  // Opposite-direction wheel brakes immediately and emits veditor:kinetic-scroll-end
  h.fireWheel(new h.MockWheelEvent('wheel', { deltaX: 0, deltaY: -12, deltaMode: 0, target: h.pageNode }));
  // Cancel snapshot rAF or verify coast stopped (only nativeSnapRaf remains, not coastRaf)
  assert.equal(h.scroller.dataset.kineticScrolling, undefined);
  assert.ok(
    h.scroller.dispatched.some((e) => e.type === 'veditor:kinetic-scroll-end'),
    'must emit veditor:kinetic-scroll-end when braking'
  );

  // Pinch (ctrl+wheel) landing over viewport gap forwards synthetic ctrl+wheel to scroller
  h.scroller.dispatched = [];
  const gapPinch = new h.MockWheelEvent('wheel', {
    deltaX: 0,
    deltaY: -20,
    deltaMode: 0,
    ctrlKey: true,
    isTrusted: true,
    clientX: 500,
    clientY: 400,
    target: h.gapNode
  });
  h.fireWheel(gapPinch);
  assert.equal(gapPinch.defaultPrevented, true);
  assert.equal(h.scroller.dispatched.length, 1);
  assert.equal(h.scroller.dispatched[0].ctrlKey, true);
  assert.equal(h.scroller.dispatched[0].deltaY, -20);

  // Trusted ctrl+wheel suppresses native:pinch-zoom-fallback for 600ms
  h.scroller.dispatched = [];
  const fallbackHandler = h.ipcListeners.get('native:pinch-zoom-fallback');
  assert.ok(fallbackHandler);
  fallbackHandler({}, 'in');
  assert.equal(h.scroller.dispatched.length, 0, 'fallback zoom must be ignored right after real ctrl+wheel pinch');

  // After 650ms idle, fallback dispatches a gentle ±16 deltaY
  h.advance(650);
  fallbackHandler({}, 'in');
  assert.equal(h.scroller.dispatched.length, 1);
  assert.equal(h.scroller.dispatched[0].deltaY, -16);
});

test('preload detects native Wayland compositor fling and never launches duplicate JS coast', () => {
  const h = createPreloadHarness();

  // Brisk swipe
  for (let i = 0; i < 4; i++) {
    h.advance(10);
    h.scroller.scrollTop += 36;
    h.fireWheel(new h.MockWheelEvent('wheel', { deltaX: 0, deltaY: 36, deltaMode: 0, target: h.pageNode }));
  }
  assert.equal(h.scroller.dataset.kineticScrolling, '1');

  // Post-wheel snapshot captures scrollTop
  h.stepRaf(8);
  const snapTop = h.scroller.scrollTop;

  // Native Wayland compositor advances scrollTop on its own before LIFT_DETECT_MS
  h.scroller.scrollTop += 64;
  h.advance(56);
  h.flushTimers();

  // JS coast MUST NOT start (no rAF scheduled), while kineticScrolling stays active during native glide
  assert.equal(h.rafs.size, 0, 'JS coast must not start when native Wayland fling is already moving scrollTop');
  assert.equal(h.scroller.dataset.kineticScrolling, '1');
  assert.equal(h.scroller.scrollTop, snapTop + 64);

  // Native compositor continues sending passive scroll events for 100ms
  h.advance(40);
  h.scroller.scrollTop += 30;
  h.scroller.emitLocal('scroll');
  h.flushTimers();
  assert.equal(h.scroller.dataset.kineticScrolling, '1');

  // Once native fling goes idle for NATIVE_FLING_IDLE_MS (72ms), flag clears and settled event fires
  h.advance(80);
  h.flushTimers();
  assert.equal(h.scroller.dataset.kineticScrolling, undefined);
  assert.ok(h.scroller.dispatched.some((e) => e.type === 'veditor:kinetic-scroll-end'));
});

test('preload does not launch phantom JS coast after decelerating Wayland fling wheel tail finishes', () => {
  const h = createPreloadHarness();

  // Simulate Chromium FlingController emitting smoothly decelerating wheel events until momentum runs out
  const deltas = [48, 42, 36, 28, 20, 14, 9, 6, 3.5, 2];
  for (const dy of deltas) {
    h.advance(10);
    h.scroller.scrollTop += dy;
    h.fireWheel(new h.MockWheelEvent('wheel', { deltaX: 0, deltaY: dy, deltaMode: 0, target: h.pageNode }));
  }
  assert.equal(h.scroller.dataset.kineticScrolling, '1');

  const topAtEnd = h.scroller.scrollTop;
  h.stepRaf(8);
  h.advance(60);
  h.flushTimers();

  // Zero JS coast rAF, zero extra pixel drift, settled event fires immediately
  assert.equal(h.rafs.size, 0, 'must not start JS coast after a decelerating native fling tail');
  assert.equal(h.scroller.scrollTop, topAtEnd, 'scrollTop must not drift after momentum ends');
  assert.equal(h.scroller.dataset.kineticScrolling, undefined);
  assert.ok(h.scroller.dispatched.some((e) => e.type === 'veditor:kinetic-scroll-end'));
});

