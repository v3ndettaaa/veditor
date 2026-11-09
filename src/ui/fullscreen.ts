/**
 * Cross-platform Fullscreen controller.
 * Unifies standard browser Fullscreen API and Tauri v2 native window fullscreen
 * so fullscreen toggles and auto-hide header work identically in Web, Extension,
 * and Desktop AppImage builds.
 */

import { isDesktop } from '../core/platform';

let cachedDesktopFullscreen = false;
let fullscreenSyncInitialized = false;

function setFullscreenBodyState(active: boolean): void {
  cachedDesktopFullscreen = active;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('is-fullscreen', active);
    document.body.classList.remove('header-peek');
    if (active) {
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && activeEl.closest?.('#app-header')) {
        activeEl.blur();
      }
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('veditor:fullscreenchange', { detail: { fullscreen: active } }));
  }
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const domFs = Boolean(
    document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
  );
  return domFs || cachedDesktopFullscreen;
}

export function initFullscreenSync(): void {
  if (fullscreenSyncInitialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  fullscreenSyncInitialized = true;

  const syncDomFs = () => {
    const domFs = Boolean(
      document.fullscreenElement ||
      (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
    );
    if (domFs) {
      setFullscreenBodyState(true);
    } else if (!isDesktop()) {
      setFullscreenBodyState(false);
    }
  };

  document.addEventListener('fullscreenchange', syncDomFs);
  document.addEventListener('webkitfullscreenchange', syncDomFs);

  // Setup top-edge hover reveal for auto-hidden header in fullscreen / focus mode
  let hideTimer: number | null = null;
  const clearHideTimer = () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const isHeaderAutoHideActive = () =>
    (document.body.classList.contains('is-fullscreen') &&
      document.body.classList.contains('fullscreen-autohide')) ||
    document.body.classList.contains('focus-mode');

  const revealHeader = () => {
    clearHideTimer();
    if (isHeaderAutoHideActive()) {
      document.body.classList.add('header-peek');
    }
  };

  const scheduleHideHeader = () => {
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      const header = document.getElementById('app-header');
      const docsMenuOpen = Boolean(header?.querySelector('.header-docs-menu.is-open'));
      if (docsMenuOpen) return;
      document.body.classList.remove('header-peek');
    }, 150);
  };

  const onPointerOrMouseMove = (e: MouseEvent) => {
    if (!isHeaderAutoHideActive()) return;

    if (e.clientY <= 8) {
      revealHeader();
    } else if (document.body.classList.contains('header-peek')) {
      const header = document.getElementById('app-header');
      const headerBottom = header ? Math.max(48, header.getBoundingClientRect().bottom) : 48;
      const docsMenu = header?.querySelector<HTMLElement>('.header-docs-menu.is-open');
      const menuBottom = docsMenu ? docsMenu.getBoundingClientRect().bottom : headerBottom;
      if (e.clientY > Math.max(headerBottom, menuBottom) + 8) {
        scheduleHideHeader();
      } else {
        clearHideTimer();
      }
    }
  };

  window.addEventListener('mousemove', onPointerOrMouseMove, { passive: true });
  window.addEventListener('pointermove', onPointerOrMouseMove, { passive: true });

  if (isDesktop()) {
    import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const initial = await win.isFullscreen().catch(() => false);
        if (initial) setFullscreenBodyState(true);
        await win.onResized(async () => {
          const fs = await win.isFullscreen().catch(() => false);
          const domFs = Boolean(document.fullscreenElement);
          setFullscreenBodyState(fs || domFs);
        });
      })
      .catch(() => {});
  }
}

export async function toggleFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;

  if (isDesktop()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const current = await win.isFullscreen();
      await win.setFullscreen(!current);
      setFullscreenBodyState(!current);
      return;
    } catch {
      // Fall back to DOM fullscreen API below if Tauri window API fails
    }
  }

  const doc = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };

  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await doc.webkitExitFullscreen();
      }
      setFullscreenBodyState(false);
    } else {
      if (root.requestFullscreen) {
        await root.requestFullscreen();
      } else if (root.webkitRequestFullscreen) {
        await root.webkitRequestFullscreen();
      }
      setFullscreenBodyState(true);
    }
  } catch (err) {
    console.warn('Fullscreen toggle failed:', err);
  }
}
