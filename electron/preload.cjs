'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
// 1. Keep toolbar/UI chrome at 1:1 when trackpad pinch (ctrl+wheel) happens outside
//    the PDF viewport, while letting `#document-scroll-container` handle PDF zoom first.
// 2. Add smooth kinetic/inertial trackpad coasting on Linux (where Wayland/libinput
//    deliberately leaves post-lift scroll momentum up to the app and Chromium stops
//    abruptly on finger lift).
window.addEventListener('DOMContentLoaded', () => {
  // Bubbling-phase guard: runs AFTER veditor's `#document-scroll-container` wheel zoom
  // listener, preventing Chromium visual/page zoom anywhere outside the PDF canvas.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  if (process.platform !== 'linux') return;

  const FRICTION_PER_MS = 0.0023; // Natural APZ-like deceleration curve
  const LIFT_DETECT_MS = 38;      // Gap indicating fingers lifted from touchpad
  const SAMPLE_WINDOW_MS = 75;    // Sliding window for fling velocity estimation
  const MIN_FLING_SPEED = 0.32;   // px/ms threshold (~320 px/s) to engage coast
  const MAX_FLING_SPEED = 18;     // px/ms safety clamp
  const STOP_SPEED = 0.035;       // px/ms rest threshold

  /** @type {Array<{ t: number, dx: number, dy: number }>} */
  let samples = [];
  let liftTimer = null;
  let coastRaf = null;
  let coastVx = 0;
  let coastVy = 0;
  let lastCoastTime = 0;
  let activeScroller = null;

  function stopCoast() {
    if (coastRaf !== null) {
      window.cancelAnimationFrame(coastRaf);
      coastRaf = null;
    }
    coastVx = 0;
    coastVy = 0;
    lastCoastTime = 0;
    activeScroller = null;
  }

  function clearLiftTimer() {
    if (liftTimer !== null) {
      window.clearTimeout(liftTimer);
      liftTimer = null;
    }
  }

  function startCoast(scroller, vx, vy) {
    stopCoast();
    activeScroller = scroller;
    coastVx = Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, vx));
    coastVy = Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, vy));
    lastCoastTime = performance.now();

    const step = (now) => {
      if (!activeScroller || !activeScroller.isConnected) {
        stopCoast();
        return;
      }

      const dt = Math.min(32, Math.max(1, now - lastCoastTime));
      lastCoastTime = now;

      const decay = Math.exp(-FRICTION_PER_MS * dt);
      const integral = (1 - decay) / FRICTION_PER_MS;
      const moveX = coastVx * integral;
      const moveY = coastVy * integral;

      const prevTop = activeScroller.scrollTop;
      const prevLeft = activeScroller.scrollLeft;

      if (Math.abs(moveY) >= 0.1) {
        activeScroller.scrollTop = prevTop + moveY;
      }
      if (Math.abs(moveX) >= 0.1) {
        activeScroller.scrollLeft = prevLeft + moveX;
      }

      // If we hit a scroll boundary, zero velocity along that axis
      if (Math.abs(moveY) >= 0.5 && activeScroller.scrollTop === prevTop) {
        coastVy = 0;
      }
      if (Math.abs(moveX) >= 0.5 && activeScroller.scrollLeft === prevLeft) {
        coastVx = 0;
      }

      coastVx *= decay;
      coastVy *= decay;

      if (Math.hypot(coastVx, coastVy) < STOP_SPEED) {
        stopCoast();
        return;
      }

      coastRaf = window.requestAnimationFrame(step);
    };

    coastRaf = window.requestAnimationFrame(step);
  }

  function computeReleaseVelocity() {
    if (samples.length < 3) return null;
    const lastT = samples[samples.length - 1].t;
    const recent = samples.filter((s) => lastT - s.t <= SAMPLE_WINDOW_MS);
    if (recent.length < 3) return null;

    // Filter out discrete mouse-wheel notches (typically exact multiples of 100/120px)
    const looksLikeMouseWheel = recent.every(
      (s) => s.dx === 0 && Math.abs(s.dy) >= 96 && Math.abs(s.dy) % 10 === 0
    );
    if (looksLikeMouseWheel) return null;

    // Use the final samples right before lift so braking before lift stops cleanly
    const tailStart = Math.max(0, recent.length - 5);
    const tail = recent.slice(tailStart);
    const spanMs = Math.max(16, tail[tail.length - 1].t - tail[0].t);

    let sumX = 0;
    let sumY = 0;
    for (let i = 1; i < tail.length; i++) {
      sumX += tail[i].dx;
      sumY += tail[i].dy;
    }

    const vx = sumX / spanMs;
    const vy = sumY / spanMs;
    if (Math.hypot(vx, vy) < MIN_FLING_SPEED) return null;

    return { vx, vy };
  }

  window.addEventListener(
    'wheel',
    (e) => {
      // Any new wheel input or pinch cancels in-flight kinetic coast immediately
      stopCoast();
      clearLiftTimer();

      if (e.ctrlKey || e.metaKey || e.deltaMode !== 0) {
        samples = [];
        return;
      }

      const scroller = document.getElementById('document-scroll-container');
      if (!scroller || !(e.target instanceof Node) || !scroller.contains(e.target)) {
        samples = [];
        return;
      }

      const now = performance.now();
      // Reset gesture buffer if there was a pause between swipes
      if (samples.length > 0 && now - samples[samples.length - 1].t > 55) {
        samples = [];
      }

      samples.push({ t: now, dx: e.deltaX, dy: e.deltaY });
      if (samples.length > 16) {
        samples.shift();
      }

      liftTimer = window.setTimeout(() => {
        liftTimer = null;
        const velocity = computeReleaseVelocity();
        samples = [];
        if (velocity) {
          startCoast(scroller, velocity.vx, velocity.vy);
        }
      }, LIFT_DETECT_MS);
    },
    { passive: true, capture: true }
  );

  // Stop kinetic glide immediately on click, touch, or keyboard navigation
  const cancelAll = () => {
    stopCoast();
    clearLiftTimer();
    samples = [];
  };
  window.addEventListener('pointerdown', cancelAll, { passive: true, capture: true });
  window.addEventListener('keydown', cancelAll, { passive: true, capture: true });
  window.addEventListener('blur', cancelAll, { passive: true });
});

