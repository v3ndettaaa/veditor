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
// 1. Enable touchpad pinch-to-zoom on the PDF canvas while keeping toolbar/UI chrome at 1:1.
// 2. Provide stall-proof Linux kinetic trackpad scrolling that glides smoothly until
//    momentum runs out or the user explicitly brakes (opposite scroll / click / key),
//    without ever halting when new PDF pages load mid-scroll.
window.addEventListener('DOMContentLoaded', () => {
  try {
    webFrame.setVisualZoomLevelLimits(1, 3);
    webFrame.setZoomFactor(1);
  } catch {
    // Ignore
  }

  let lastPointerX = Math.round(window.innerWidth / 2);
  let lastPointerY = Math.round(window.innerHeight / 2);
  window.addEventListener(
    'pointermove',
    (e) => {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
    },
    { passive: true, capture: true }
  );

  // Fallback bridge if Chromium delivers pinch zoom via WebContents `zoom-changed`
  ipcRenderer.on('native:pinch-zoom-fallback', (_event, direction) => {
    const scroller = document.getElementById('document-scroll-container');
    if (!scroller) return;
    const deltaY = direction === 'in' ? -45 : 45;
    scroller.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        ctrlKey: true,
        clientX: lastPointerX,
        clientY: lastPointerY,
        bubbles: true,
        cancelable: true
      })
    );
  });

  // Bubbling-phase guard: runs AFTER veditor's `#document-scroll-container` wheel zoom
  // listener. Keeps UI chrome locked at 1:1 while forwarding any viewport-area pinch
  // events that missed `#document-scroll-container` (e.g. gaps or overlays) to it.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        const alreadyHandled = e.defaultPrevented;
        e.preventDefault();
        if (!alreadyHandled && e.target instanceof Node) {
          const viewport = document.getElementById('app-viewport-container');
          const scroller = document.getElementById('document-scroll-container');
          const overChrome =
            e.target instanceof Element &&
            e.target.closest(
              '#app-floating-toolbar, #app-view-controls, #app-properties-panel, #app-sidebar, #app-header'
            );
          if (!overChrome && viewport && scroller && viewport.contains(e.target) && !scroller.contains(e.target)) {
            scroller.dispatchEvent(
              new WheelEvent('wheel', {
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaMode: e.deltaMode,
                ctrlKey: true,
                clientX: e.clientX,
                clientY: e.clientY,
                bubbles: true,
                cancelable: true
              })
            );
          }
        }
      }
    },
    { passive: false }
  );

  if (process.platform !== 'linux') return;

  const FRICTION_PER_MS = 0.00185; // Smooth APZ-like deceleration curve
  const LIFT_DETECT_MS = 48;       // Gap indicating fingers lifted from touchpad
  const SWIPE_RESET_GAP_MS = 180;  // Tolerate brief main-thread stalls mid-swipe
  const SAMPLE_WINDOW_MS = 110;    // Sliding window anchored to last wheel sample
  const MIN_FLING_SPEED = 0.25;    // px/ms threshold (~250 px/s) to engage coast
  const BRISK_SWIPE_SPEED = 0.3;   // px/ms threshold to defer heavy page renders mid-swipe
  const BRISK_SWIPE_DIST = 90;     // px cumulative swipe threshold to defer renders
  const MAX_FLING_SPEED = 24;      // px/ms safety clamp
  const STOP_SPEED = 0.04;         // px/ms rest threshold (~0.33px/frame @ 120Hz)
  const MAX_FRAME_DT_MS = 24;      // Cap dt so frame spikes consume zero momentum energy

  /** @type {Array<{ t: number, dx: number, dy: number }>} */
  let samples = [];
  let gestureTravelPx = 0;
  let liftTimer = null;
  let coastRaf = null;
  let coastVx = 0;
  let coastVy = 0;
  let carryX = 0;
  let carryY = 0;
  let carriedVx = 0;
  let carriedVy = 0;
  let lastCoastTime = 0;
  let activeScroller = null;
  let kineticMarkedScroller = null;

  function markKineticScrolling(scroller) {
    if (!scroller) return;
    if (kineticMarkedScroller && kineticMarkedScroller !== scroller) {
      delete kineticMarkedScroller.dataset.kineticScrolling;
    }
    kineticMarkedScroller = scroller;
    if (scroller.dataset.kineticScrolling !== '1') {
      scroller.dataset.kineticScrolling = '1';
    }
  }

  function clearKineticScrolling(emitSettled = true) {
    const scroller = kineticMarkedScroller || activeScroller;
    kineticMarkedScroller = null;
    if (!scroller) return;
    if (scroller.dataset.kineticScrolling === '1') {
      delete scroller.dataset.kineticScrolling;
      if (emitSettled && scroller.isConnected) {
        scroller.dispatchEvent(new CustomEvent('veditor:kinetic-scroll-end'));
      }
    }
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
    if (!preserveCarry) {
      clearKineticScrolling(true);
    }
    activeScroller = null;
  }

  function clearLiftTimer() {
    if (liftTimer !== null) {
      window.clearTimeout(liftTimer);
      liftTimer = null;
    }
  }

  function startCoast(scroller, vx, vy) {
    stopCoast(true);
    carriedVx = 0;
    carriedVy = 0;
    activeScroller = scroller;
    markKineticScrolling(scroller);
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

      // Clamp frame delta so any main-thread spike NEVER drains scroll energy
      // or stops the glide prematurely.
      const dt = Math.min(MAX_FRAME_DT_MS, Math.max(1, now - lastCoastTime));
      lastCoastTime = now;

      const decay = Math.exp(-FRICTION_PER_MS * dt);
      const integral = (1 - decay) / FRICTION_PER_MS;
      carryX += coastVx * integral;
      carryY += coastVy * integral;

      // Apply integer pixels while keeping fractional remainder for smooth deceleration
      const intY = Math.trunc(carryY);
      const intX = Math.trunc(carryX);
      if (intY !== 0) {
        carryY -= intY;
        activeScroller.scrollTop += intY;
      }
      if (intX !== 0) {
        carryX -= intX;
        activeScroller.scrollLeft += intX;
      }

      // Only stop along an axis when we have truly reached the document's physical edge
      const maxTop = Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight);
      const maxLeft = Math.max(0, activeScroller.scrollWidth - activeScroller.clientWidth);
      if ((coastVy < 0 && activeScroller.scrollTop <= 0) || (coastVy > 0 && activeScroller.scrollTop >= maxTop - 1)) {
        coastVy = 0;
        carryY = 0;
      }
      if ((coastVx < 0 && activeScroller.scrollLeft <= 0) || (coastVx > 0 && activeScroller.scrollLeft >= maxLeft - 1)) {
        coastVx = 0;
        carryX = 0;
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
      const gap = Math.min(35, Math.max(4, tail[i].t - tail[i - 1].t));
      effectiveSpanMs += gap;
      sumX += tail[i].dx;
      sumY += tail[i].dy;
    }
    if (effectiveSpanMs <= 0) return null;

    let vx = sumX / effectiveSpanMs;
    let vy = sumY / effectiveSpanMs;

    // Accumulate carried momentum when the user flicked again in the SAME direction
    if (carriedVy !== 0 && Math.sign(vy) === Math.sign(carriedVy)) {
      const sameDirBoost = Math.abs(carriedVy) * 0.72 + Math.abs(vy);
      vy = Math.sign(vy) * Math.max(Math.abs(vy), sameDirBoost);
    }
    if (carriedVx !== 0 && Math.sign(vx) === Math.sign(carriedVx)) {
      const sameDirBoost = Math.abs(carriedVx) * 0.72 + Math.abs(vx);
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
        stopCoast(false);
        samples = [];
        gestureTravelPx = 0;
        return;
      }

      const scroller = document.getElementById('document-scroll-container');
      if (!scroller || !(e.target instanceof Node) || !scroller.contains(e.target)) {
        stopCoast(false);
        samples = [];
        gestureTravelPx = 0;
        return;
      }

      // If already coasting:
      // - Opposite direction scroll -> brake & stop immediately!
      // - Same direction scroll -> preserve remaining momentum & keep kinetic flag active!
      if (coastRaf !== null) {
        const opposingY = coastVy !== 0 && e.deltaY !== 0 && Math.sign(e.deltaY) !== Math.sign(coastVy);
        const opposingX = coastVx !== 0 && e.deltaX !== 0 && Math.sign(e.deltaX) !== Math.sign(coastVx);
        if (opposingY || opposingX) {
          stopCoast(false);
          samples = [];
          gestureTravelPx = 0;
          return;
        }
        stopCoast(true);
      }

      const now = performance.now();
      if (samples.length > 0 && now - samples[samples.length - 1].t > SWIPE_RESET_GAP_MS) {
        samples = [];
        gestureTravelPx = 0;
        carriedVx = 0;
        carriedVy = 0;
      }

      const prevSample = samples.length > 0 ? samples[samples.length - 1] : null;
      samples.push({ t: now, dx: e.deltaX, dy: e.deltaY });
      if (samples.length > 18) {
        samples.shift();
      }
      gestureTravelPx += Math.hypot(e.deltaX, e.deltaY);

      // As soon as a brisk touchpad swipe begins, set `kineticScrolling` so the
      // renderer defers heavy canvas mounts/rasterization until the glide settles.
      if (prevSample) {
        const dt = Math.max(4, now - prevSample.t);
        const instSpeed = Math.hypot(e.deltaX, e.deltaY) / dt;
        if (instSpeed >= BRISK_SWIPE_SPEED || gestureTravelPx >= BRISK_SWIPE_DIST) {
          markKineticScrolling(scroller);
        }
      }

      liftTimer = window.setTimeout(() => {
        liftTimer = null;
        const velocity = computeReleaseVelocity();
        samples = [];
        gestureTravelPx = 0;
        carriedVx = 0;
        carriedVy = 0;
        if (velocity) {
          startCoast(scroller, velocity.vx, velocity.vy);
        } else {
          clearKineticScrolling(true);
        }
      }, LIFT_DETECT_MS);
    },
    { passive: true, capture: true }
  );

  // Stop kinetic glide immediately on click, touch, or keyboard navigation
  const cancelAll = () => {
    stopCoast(false);
    clearLiftTimer();
    samples = [];
    gestureTravelPx = 0;
  };
  window.addEventListener('pointerdown', cancelAll, { passive: true, capture: true });
  window.addEventListener('keydown', cancelAll, { passive: true, capture: true });
  window.addEventListener('blur', cancelAll, { passive: true });
});


