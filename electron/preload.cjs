'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Unlock Chromium's renderer-side visual pinch gesture synthesis immediately so
// Wayland/touchpad two-finger pinches are delivered as ctrl+wheel events.
try {
  webFrame.setVisualZoomLevelLimits(1, 3);
} catch {
  // Ignore if unsupported in this environment
}

contextBridge.exposeInMainWorld('__VEDITOR_ELECTRON__', {
  isElectron: true,
  platform: process.platform,

  getVersion: () => ipcRenderer.invoke('app:get-version'),
  takeStartupFile: () => ipcRenderer.invoke('app:take-startup-file'),

  openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdf'),
  savePdfDialog: (suggestedName) => ipcRenderer.invoke('dialog:save-pdf', suggestedName),
  confirmDialog: (message, title) => ipcRenderer.invoke('dialog:confirm', message, title),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),

  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('fs:write-file', filePath, bytes),
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  buildFileTree: (rootPath) => ipcRenderer.invoke('fs:build-file-tree', rootPath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  removeFile: (targetPath) => ipcRenderer.invoke('fs:remove', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal-path', targetPath),

  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setFullscreen: (active) => ipcRenderer.invoke('window:set-fullscreen', active),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  forceCloseWindow: () => ipcRenderer.invoke('window:force-close'),

  onFullscreenChanged: (callback) => {
    const listener = (_event, isFullscreen) => callback(Boolean(isFullscreen));
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },

  onOpenFilePath: (callback) => {
    const listener = (_event, filePath) => {
      if (typeof filePath === 'string' && filePath) callback(filePath);
    };
    ipcRenderer.on('native:open-file-path', listener);
    return () => ipcRenderer.removeListener('native:open-file-path', listener);
  },

  onCloseRequested: (callback) => {
    ipcRenderer.send('window:register-close-guard');
    const listener = async () => {
      try {
        const canClose = await callback();
        if (canClose) {
          await ipcRenderer.invoke('window:force-close');
        }
      } catch (err) {
        console.error('Close confirmation handler failed:', err);
      }
    };
    ipcRenderer.on('window:close-requested', listener);
    return () => ipcRenderer.removeListener('window:close-requested', listener);
  }
});

// Electron-only UX enhancements (completely isolated from Web/Extension/Tauri builds):
// 1. Restore Chromium Blink GPU compositing on Linux Electron (main.css disables GPU layers
//    under html.platform-linux for WebKitGTK/Tauri, which hurts Blink scroll throughput).
// 2. Deliver two-finger trackpad pinch-to-zoom reliably on Linux/Wayland via native ctrl+wheel,
//    Electron input-event gesturePinchUpdate, visualViewport scale changes, and zoom-changed,
//    deduplicated so a pinch never double-zooms and never scales toolbar chrome.
// 3. Coordinate with veditor's built-in `dataset.kineticScrolling = '1'` fast-scroll protocol
//    so PDF.js renders and GPU canvas allocations stay completely paused while swiping/coasting
//    and never stall or hitch mid-scroll.
window.addEventListener('DOMContentLoaded', () => {
  try {
    webFrame.setVisualZoomLevelLimits(1, 3);
    webFrame.setZoomFactor(1);
  } catch {
    // Ignore
  }

  // Restore Chromium GPU compositing layers on Linux Electron only (overrides WebKitGTK rules).
  if (process.platform === 'linux' && !document.getElementById('veditor-electron-compositor')) {
    const style = document.createElement('style');
    style.id = 'veditor-electron-compositor';
    style.textContent = [
      'html.platform-linux #document-scroll-container {',
      '  will-change: scroll-position;',
      '}',
      'html.platform-linux .pdf-page-container {',
      '  contain: layout style paint;',
      '}',
      'html.platform-linux .pdf-page-canvas,',
      'html.platform-linux .annotation-canvas,',
      'html.platform-linux .annot-chunk-canvas,',
      'html.platform-linux .scratchpad-canvas,',
      'html.platform-linux .scratch-chunk-canvas {',
      '  transform: translateZ(0);',
      '  backface-visibility: hidden;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  let lastPointerX = Math.round(window.innerWidth / 2);
  let lastPointerY = Math.round(window.innerHeight / 2);
  let lastNativeCtrlWheelAt = 0;
  let activeFallbackPinch = false;

  window.addEventListener(
    'pointermove',
    (e) => {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
    },
    { passive: true, capture: true }
  );

  // Track trusted native ctrl+wheel events (including Chromium's synthesized touchpad pinch)
  // so main-process/visualViewport fallbacks never double-zoom when native delivery works.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.isTrusted && (e.ctrlKey || e.metaKey)) {
        lastNativeCtrlWheelAt = performance.now();
      }
    },
    { passive: true, capture: true }
  );

  function getActiveDocumentScroller() {
    const scroller = document.getElementById('document-scroll-container');
    if (!scroller || !scroller.isConnected) return null;
    if (scroller.clientWidth === 0 || scroller.clientHeight === 0) return null;
    return scroller;
  }

  function dispatchSyntheticPinchDelta(deltaY, x, y) {
    const scroller = getActiveDocumentScroller();
    if (!scroller || !Number.isFinite(deltaY) || deltaY === 0) return false;
    delete scroller.dataset.kineticScrolling;
    const rect = scroller.getBoundingClientRect();
    const clientX =
      typeof x === 'number' && Number.isFinite(x)
        ? Math.max(rect.left, Math.min(rect.right, x))
        : Math.max(rect.left, Math.min(rect.right, lastPointerX));
    const clientY =
      typeof y === 'number' && Number.isFinite(y)
        ? Math.max(rect.top, Math.min(rect.bottom, y))
        : Math.max(rect.top, Math.min(rect.bottom, lastPointerY));

    scroller.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        ctrlKey: true,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true
      })
    );
    return true;
  }

  function commitFallbackPinch() {
    if (!activeFallbackPinch) return;
    activeFallbackPinch = false;
    const scroller = getActiveDocumentScroller();
    if (scroller) {
      scroller.dispatchEvent(new Event('gestureend', { bubbles: true }));
    }
  }

  // Fallback 1: Electron WebContents `input-event` gesturePinchUpdate / gesturePinchEnd
  ipcRenderer.on('native:pinch-gesture-update', (_event, payload) => {
    if (!payload || typeof payload.scale !== 'number' || !Number.isFinite(payload.scale) || payload.scale <= 0) {
      return;
    }
    const { scale, x, y } = payload;
    window.setTimeout(() => {
      if (performance.now() - lastNativeCtrlWheelAt < 80) return;
      const clampedScale = Math.max(0.5, Math.min(2.0, scale));
      if (Math.abs(clampedScale - 1) < 0.0005) return;
      const deltaY = -Math.log(clampedScale) / 0.0035;
      if (dispatchSyntheticPinchDelta(deltaY, x, y)) {
        activeFallbackPinch = true;
      }
    }, 0);
  });

  ipcRenderer.on('native:pinch-gesture-end', () => {
    window.setTimeout(() => {
      if (performance.now() - lastNativeCtrlWheelAt < 80) {
        activeFallbackPinch = false;
        return;
      }
      commitFallbackPinch();
    }, 0);
  });

  // Fallback 2: Chromium WebContents `zoom-changed` event
  ipcRenderer.on('native:pinch-zoom-fallback', (_event, direction) => {
    window.setTimeout(() => {
      if (performance.now() - lastNativeCtrlWheelAt < 80) return;
      const deltaY = direction === 'in' ? -45 : 45;
      if (dispatchSyntheticPinchDelta(deltaY, lastPointerX, lastPointerY)) {
        activeFallbackPinch = true;
      }
    }, 0);
  });

  // Fallback 3: Chromium visualViewport pinch scale interception (if Blink zooms the
  // visual viewport instead of dispatching ctrl+wheel, translate into PDF zoom and reset).
  if (window.visualViewport) {
    let lastVisualScale = window.visualViewport.scale || 1;
    let resetVisualTimer = null;

    const resetVisualViewportZoom = () => {
      resetVisualTimer = null;
      lastVisualScale = 1;
      try {
        webFrame.setVisualZoomLevelLimits(1, 1);
        window.requestAnimationFrame(() => {
          try {
            webFrame.setVisualZoomLevelLimits(1, 3);
            webFrame.setZoomFactor(1);
          } catch {
            // Ignore
          }
        });
      } catch {
        // Ignore
      }
      commitFallbackPinch();
    };

    window.visualViewport.addEventListener('resize', () => {
      const currentScale = window.visualViewport ? window.visualViewport.scale : 1;
      if (!Number.isFinite(currentScale) || currentScale <= 0) return;

      const ratio = currentScale / (lastVisualScale || 1);
      lastVisualScale = currentScale;

      if (Math.abs(currentScale - 1) <= 0.002) {
        if (resetVisualTimer !== null) {
          window.clearTimeout(resetVisualTimer);
          resetVisualTimer = null;
        }
        return;
      }

      if (performance.now() - lastNativeCtrlWheelAt >= 80 && Math.abs(ratio - 1) > 0.001) {
        const deltaY = -Math.log(Math.max(0.5, Math.min(2.0, ratio))) / 0.0035;
        if (dispatchSyntheticPinchDelta(deltaY, lastPointerX, lastPointerY)) {
          activeFallbackPinch = true;
        }
      }

      if (resetVisualTimer !== null) {
        window.clearTimeout(resetVisualTimer);
      }
      resetVisualTimer = window.setTimeout(resetVisualViewportZoom, 140);
    });
  }

  // Bubbling-phase guard: runs AFTER veditor's `#document-scroll-container` wheel zoom
  // listener. If a pinch/ctrl+wheel happened while a document is open and wasn't already
  // handled (e.g. cursor drifted over an overlay/gutter), forward it to the PDF viewport,
  // and always prevent Chromium from zooming the app chrome.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (!e.defaultPrevented && e.isTrusted && e.deltaY !== 0) {
          dispatchSyntheticPinchDelta(e.deltaY, e.clientX, e.clientY);
        }
        e.preventDefault();
      }
    },
    { passive: false }
  );

  if (process.platform !== 'linux') return;

  const FRICTION_PER_MS = 0.0017;  // Smooth APZ-like deceleration curve
  const LIFT_DETECT_MS = 44;       // Gap indicating fingers lifted from touchpad
  const ACTIVE_SETTLE_MS = 160;    // Failsafe clear of kineticScrolling if user stops fingers without flinging
  const SWIPE_RESET_GAP_MS = 180;  // Tolerate brief input gaps mid-swipe
  const SAMPLE_WINDOW_MS = 115;    // Sliding window anchored to last wheel sample
  const FAST_SWIPE_SPEED = 0.25;   // px/ms threshold to pause mid-scroll PDF renders immediately
  const FAST_SWIPE_DIST = 32;      // px cumulative swipe distance to pause mid-scroll PDF renders
  const MIN_FLING_SPEED = 0.22;    // px/ms threshold (~220 px/s) to engage kinetic glide
  const MAX_FLING_SPEED = 26;      // px/ms safety clamp
  const STOP_SPEED = 0.032;        // px/ms rest threshold
  const MAX_FRAME_DT_MS = 24;      // Cap dt so any frame spike consumes zero scroll energy

  /** @type {Array<{ t: number, dx: number, dy: number }>} */
  let samples = [];
  let swipeDistance = 0;
  let liftTimer = null;
  let activeSettleTimer = null;
  let coastRaf = null;
  let coastVx = 0;
  let coastVy = 0;
  let carryX = 0;
  let carryY = 0;
  let carriedVx = 0;
  let carriedVy = 0;
  let lastCoastTime = 0;
  let activeScroller = null;
  let lockedScroller = null;

  function setKineticLock(scroller, locked) {
    if (locked && scroller && scroller.isConnected) {
      if (lockedScroller && lockedScroller !== scroller) {
        delete lockedScroller.dataset.kineticScrolling;
      }
      lockedScroller = scroller;
      if (scroller.dataset.kineticScrolling !== '1') {
        scroller.dataset.kineticScrolling = '1';
      }
    } else if (lockedScroller) {
      delete lockedScroller.dataset.kineticScrolling;
      lockedScroller = null;
    }
  }

  function clearActiveSettleTimer() {
    if (activeSettleTimer !== null) {
      window.clearTimeout(activeSettleTimer);
      activeSettleTimer = null;
    }
  }

  function scheduleActiveSettleClear() {
    clearActiveSettleTimer();
    activeSettleTimer = window.setTimeout(() => {
      activeSettleTimer = null;
      if (coastRaf === null) {
        setKineticLock(null, false);
        swipeDistance = 0;
      }
    }, ACTIVE_SETTLE_MS);
  }

  function stopCoast(preserveCarry = false) {
    if (preserveCarry) {
      carriedVx = coastVx;
      carriedVy = coastVy;
    } else {
      carriedVx = 0;
      carriedVy = 0;
    }
    if (coastRaf !== null) {
      window.cancelAnimationFrame(coastRaf);
      coastRaf = null;
    }
    coastVx = 0;
    coastVy = 0;
    carryX = 0;
    carryY = 0;
    lastCoastTime = 0;
    activeScroller = null;
    if (!preserveCarry) {
      setKineticLock(null, false);
    }
  }

  function clearLiftTimer() {
    if (liftTimer !== null) {
      window.clearTimeout(liftTimer);
      liftTimer = null;
    }
  }

  function startCoast(scroller, vx, vy) {
    clearActiveSettleTimer();
    stopCoast(true);
    carriedVx = 0;
    carriedVy = 0;
    activeScroller = scroller;
    setKineticLock(scroller, true);
    coastVx = Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, vx));
    coastVy = Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, vy));
    carryX = 0;
    carryY = 0;
    lastCoastTime = performance.now();

    const step = (now) => {
      if (!activeScroller || !activeScroller.isConnected) {
        stopCoast(false);
        return;
      }

      // Keep fast-scroll render lock active for the entire glide so PDF.js renders and
      // GPU canvas allocations never fire mid-glide and cause hitching.
      if (activeScroller.dataset.kineticScrolling !== '1') {
        activeScroller.dataset.kineticScrolling = '1';
      }

      // Clamp frame delta so any scheduler jitter NEVER drains scroll energy.
      const dt = Math.min(MAX_FRAME_DT_MS, Math.max(1, now - lastCoastTime));
      lastCoastTime = now;

      const decay = Math.exp(-FRICTION_PER_MS * dt);
      const integral = (1 - decay) / FRICTION_PER_MS;
      carryX += coastVx * integral;
      carryY += coastVy * integral;

      // Apply integer pixels while preserving fractional remainder and detecting
      // physical document boundaries WITHOUT reading scrollHeight/clientHeight (zero reflows).
      const intY = Math.trunc(carryY);
      const intX = Math.trunc(carryX);
      if (intY !== 0) {
        carryY -= intY;
        const prevTop = activeScroller.scrollTop;
        activeScroller.scrollTop = prevTop + intY;
        if (activeScroller.scrollTop === prevTop) {
          coastVy = 0;
          carryY = 0;
        }
      }
      if (intX !== 0) {
        carryX -= intX;
        const prevLeft = activeScroller.scrollLeft;
        activeScroller.scrollLeft = prevLeft + intX;
        if (activeScroller.scrollLeft === prevLeft) {
          coastVx = 0;
          carryX = 0;
        }
      }

      coastVx *= decay;
      coastVy *= decay;

      if (Math.hypot(coastVx, coastVy) < STOP_SPEED) {
        stopCoast(false);
        return;
      }

      coastRaf = window.requestAnimationFrame(step);
    };

    coastRaf = window.requestAnimationFrame(step);
  }

  function computeReleaseVelocity() {
    if (samples.length < 2) return null;
    const lastT = samples[samples.length - 1].t;
    const recent = samples.filter((s) => lastT - s.t <= SAMPLE_WINDOW_MS);
    if (recent.length < 2) return null;

    // Filter out single discrete mouse-wheel notches (exact multiples of 100/120px)
    const looksLikeMouseWheel =
      recent.length <= 2 &&
      recent.every((s) => s.dx === 0 && Math.abs(s.dy) >= 96 && Math.abs(s.dy) % 10 === 0);
    if (looksLikeMouseWheel) return null;

    // Use the final samples right before lift so deliberate braking before lift stops cleanly
    const tailStart = Math.max(0, recent.length - 5);
    const tail = recent.slice(tailStart);

    // Compute per-interval velocity while clamping anomalous stall gaps
    let sumX = 0;
    let sumY = 0;
    let effectiveSpanMs = 0;
    for (let i = 1; i < tail.length; i++) {
      const gap = Math.min(32, Math.max(4, tail[i].t - tail[i - 1].t));
      effectiveSpanMs += gap;
      sumX += tail[i].dx;
      sumY += tail[i].dy;
    }
    if (effectiveSpanMs <= 0) return null;

    let vx = sumX / effectiveSpanMs;
    let vy = sumY / effectiveSpanMs;

    // Accumulate carried momentum when the user flicked again in the SAME direction
    if (carriedVy !== 0 && Math.sign(vy) === Math.sign(carriedVy)) {
      const sameDirBoost = Math.abs(carriedVy) * 0.75 + Math.abs(vy);
      vy = Math.sign(vy) * Math.max(Math.abs(vy), sameDirBoost);
    }
    if (carriedVx !== 0 && Math.sign(vx) === Math.sign(carriedVx)) {
      const sameDirBoost = Math.abs(carriedVx) * 0.75 + Math.abs(vx);
      vx = Math.sign(vx) * Math.max(Math.abs(vx), sameDirBoost);
    }

    if (Math.hypot(vx, vy) < MIN_FLING_SPEED) return null;
    return { vx, vy };
  }

  window.addEventListener(
    'wheel',
    (e) => {
      clearLiftTimer();

      if (e.ctrlKey || e.metaKey || e.deltaMode !== 0) {
        clearActiveSettleTimer();
        stopCoast(false);
        samples = [];
        swipeDistance = 0;
        return;
      }

      const scroller = document.getElementById('document-scroll-container');
      if (!scroller || !(e.target instanceof Node) || !scroller.contains(e.target)) {
        clearActiveSettleTimer();
        stopCoast(false);
        samples = [];
        swipeDistance = 0;
        return;
      }

      // If already coasting:
      // - Opposite direction scroll -> brake & stop immediately!
      // - Same direction scroll -> preserve remaining momentum & keep render lock seamlessly!
      if (coastRaf !== null) {
        const opposingY = coastVy !== 0 && e.deltaY !== 0 && Math.sign(e.deltaY) !== Math.sign(coastVy);
        const opposingX = coastVx !== 0 && e.deltaX !== 0 && Math.sign(e.deltaX) !== Math.sign(coastVx);
        if (opposingY || opposingX) {
          clearActiveSettleTimer();
          stopCoast(false);
          samples = [];
          swipeDistance = 0;
          return;
        }
        stopCoast(true);
      }

      const now = performance.now();
      const prevSample = samples.length > 0 ? samples[samples.length - 1] : null;
      if (prevSample && now - prevSample.t > SWIPE_RESET_GAP_MS) {
        samples = [];
        swipeDistance = 0;
        carriedVx = 0;
        carriedVy = 0;
      }

      const stepDist = Math.hypot(e.deltaX, e.deltaY);
      swipeDistance += stepDist;
      const instantDt = prevSample ? Math.max(4, now - prevSample.t) : 16;
      const instantSpeed = stepDist / instantDt;

      // Engage veditor's fast-scroll render pause IMMEDIATELY during brisk trackpad swipes
      // so the very first newly-entered page never stalls the swipe before fingers lift.
      if (swipeDistance >= FAST_SWIPE_DIST || instantSpeed >= FAST_SWIPE_SPEED) {
        setKineticLock(scroller, true);
        scheduleActiveSettleClear();
      }

      samples.push({ t: now, dx: e.deltaX, dy: e.deltaY });
      if (samples.length > 18) {
        samples.shift();
      }

      liftTimer = window.setTimeout(() => {
        liftTimer = null;
        const velocity = computeReleaseVelocity();
        samples = [];
        swipeDistance = 0;
        carriedVx = 0;
        carriedVy = 0;
        if (velocity) {
          startCoast(scroller, velocity.vx, velocity.vy);
        } else {
          // User stopped cleanly without flinging: release render lock so resting page renders immediately
          clearActiveSettleTimer();
          setKineticLock(null, false);
        }
      }, LIFT_DETECT_MS);
    },
    { passive: true, capture: true }
  );

  // Stop kinetic glide immediately on click, touch, or keyboard navigation
  const cancelAll = () => {
    clearActiveSettleTimer();
    stopCoast(false);
    clearLiftTimer();
    samples = [];
    swipeDistance = 0;
  };
  window.addEventListener('pointerdown', cancelAll, { passive: true, capture: true });
  window.addEventListener('keydown', cancelAll, { passive: true, capture: true });
  window.addEventListener('blur', cancelAll, { passive: true });
});


