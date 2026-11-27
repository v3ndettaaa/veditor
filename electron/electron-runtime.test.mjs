import test from 'node:test';
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

test('preload Linux kinetic scroller sets kineticScrolling during glide, survives frame spikes, brakes on reverse, and emits settled event', () => {
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
    }
    contains(node) {
      return node === this || this.children.includes(node);
    }
    closest() {
      return null;
    }
    dispatchEvent(evt) {
      this.dispatched.push(evt);
      return true;
    }
  }

  class MockWheelEvent {
    constructor(type, init = {}) {
      this.type = type;
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
  assert.deepEqual(visualZoomLimits, [1, 3]);

  // Fire DOMContentLoaded
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

  // 1. Brisk downward swipe sets kineticScrolling immediately
  for (let i = 0; i < 4; i++) {
    nowMs += 10;
    const evt = new MockWheelEvent('wheel', { deltaX: 0, deltaY: 36, deltaMode: 0, target: pageNode });
    fireWheel(evt);
  }
  assert.equal(scroller.dataset.kineticScrolling, '1');

  // 2. Lift fingers -> coast starts and survives a 400ms frame spike without stopping
  nowMs += 55;
  flushTimers();
  assert.equal(rafs.size, 1);
  const topBeforeCoast = scroller.scrollTop;
  stepRaf(400); // simulate huge spike
  assert.ok(scroller.scrollTop > topBeforeCoast);
  assert.equal(rafs.size, 1, 'coast must continue after frame spike');
  assert.equal(scroller.dataset.kineticScrolling, '1');

  // 3. Opposite-direction wheel brakes immediately and emits veditor:kinetic-scroll-end
  const reverseEvt = new MockWheelEvent('wheel', { deltaX: 0, deltaY: -12, deltaMode: 0, target: pageNode });
  fireWheel(reverseEvt);
  assert.equal(rafs.size, 0, 'reverse scroll must immediately stop coast');
  assert.equal(scroller.dataset.kineticScrolling, undefined);
  assert.ok(
    scroller.dispatched.some((e) => e.type === 'veditor:kinetic-scroll-end'),
    'must emit veditor:kinetic-scroll-end when braking'
  );

  // 4. Pinch (ctrl+wheel) landing over viewport gap forwards synthetic ctrl+wheel to scroller
  scroller.dispatched = [];
  const gapPinch = new MockWheelEvent('wheel', {
    deltaX: 0,
    deltaY: -20,
    deltaMode: 0,
    ctrlKey: true,
    clientX: 500,
    clientY: 400,
    target: gapNode
  });
  fireWheel(gapPinch);
  assert.equal(gapPinch.defaultPrevented, true);
  assert.equal(scroller.dispatched.length, 1);
  assert.equal(scroller.dispatched[0].ctrlKey, true);
  assert.equal(scroller.dispatched[0].deltaY, -20);
});
