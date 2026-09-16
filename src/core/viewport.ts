/**
 * Virtualized Viewport Coordinator
 * Enables 60fps scrolling across 500+ page documents with zero memory bloat.
 */

import { store } from './store';
import { PageInfo, ViewMode, MIN_ZOOM, MAX_ZOOM } from './types';
import { persistDocPosition } from '../io/storage';

export interface ViewportPageRect {
  pageIndex: number;
  top: number;
  height: number;
  width: number;
  left: number;
}

/**
 * Page dimensions with the user's rotation applied (90°/270° swap w/h).
 * `PageInfo` widths already include the PDF's native rotation, so only the
 * user rotation is considered here. Pure helper, unit-tested.
 */
export function rotatedPageSize(
  page: Pick<PageInfo, 'originalWidth' | 'originalHeight'>,
  userRotationDeg: number
): { width: number; height: number } {
  const swapped = ((userRotationDeg % 180) + 180) % 180 !== 0;
  return swapped
    ? { width: page.originalHeight, height: page.originalWidth }
    : { width: page.originalWidth, height: page.originalHeight };
}

export class ViewportManager {
  private _scrollContainer: HTMLElement | null = null;
  private _pagesWrapper: HTMLElement | null = null;
  private _visiblePages: Set<number> = new Set();
  private _pageLayouts: ViewportPageRect[] = [];
  private _onVisiblePagesChange: ((visibleIndices: number[]) => void) | null = null;
  /**
   * CSS zoom-preview factor currently applied to the pages wrapper (1 when
   * idle). Scroll offsets live in scaled space while previewing, so they must
   * be divided back down before mapping onto the (unscaled) page layouts —
   * otherwise the wrong pages mount (blank cracks) and eviction churns.
   */
  private _previewScale: number = 1;
  /**
   * rAF coalescing for the scroll listener: a fast fling, a scrollbar drag
   * across hundreds of pages, or the scroll correction after a zoom can fire
   * dozens of native `scroll` events before the browser paints once. Without
   * this, each one raced its own full visible-set recompute + mount/render
   * pass, and the pile-up of overlapping passes was the actual cause of the
   * post-zoom stutter and long-jump freezes — not any single pass being slow.
   * At most one `handleScroll` runs per animation frame, always reading the
   * latest scroll position when it does.
   */
  private _scrollRafId: number | null = null;

  public setPreviewScale(scale: number): void {
    this._previewScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
  }

  public init(
    scrollContainer: HTMLElement,
    pagesWrapper: HTMLElement,
    onVisiblePagesChange: (visibleIndices: number[]) => void
  ) {
    this._scrollContainer = scrollContainer;
    this._pagesWrapper = pagesWrapper;
    this._onVisiblePagesChange = onVisiblePagesChange;

    this._scrollContainer.addEventListener('scroll', () => this.scheduleScrollCheck(), { passive: true });
    window.addEventListener('resize', () => this.updateLayout(), { passive: true });
  }

  private scheduleScrollCheck(): void {
    if (this._scrollRafId !== null) return;
    this._scrollRafId = requestAnimationFrame(() => {
      this._scrollRafId = null;
      this.handleScroll();
    });
  }

  /** Drops visible-set tracking (tab switch / mode change needs a clean pass). */
  public clearVisible(): void {
    this._visiblePages.clear();
  }

  /**
   * Recalculates page dimensions and positions based on zoom, viewMode, and container size.
   */
  public updateLayout(force = true) {
    const doc = store.activeDocument;
    if (!this._scrollContainer || !this._pagesWrapper) return;
    if (!doc) {
      if (this._scrollRafId !== null) {
        cancelAnimationFrame(this._scrollRafId);
        this._scrollRafId = null;
      }
      this._pageLayouts = [];
      this._visiblePages.clear();
      this._previewScale = 1;
      this._pagesWrapper.style.width = '';
      this._pagesWrapper.style.height = '';
      this._pagesWrapper.style.minWidth = '';
      this._pagesWrapper.style.transform = '';
      this._pagesWrapper.style.transformOrigin = '';
      this._scrollContainer.scrollLeft = 0;
      return;
    }

    const zoom = store.zoom;
    const viewMode = store.viewMode;
    const containerWidth = Math.max(300, this._scrollContainer.clientWidth);
    const pageSpacing = 24;

    this._pageLayouts = [];
    let currentTop = 20;
    let maxContentWidth = containerWidth;

    if (viewMode === 'continuous') {
      for (let i = 0; i < doc.pages.length; i++) {
        const page = doc.pages[i];
        const { width: baseW, height: baseH } = rotatedPageSize(page, store.pageRotations[i] || 0);

        const scaledW = Math.floor(baseW * zoom);
        const scaledH = Math.floor(baseH * zoom);
        if (scaledW + 40 > maxContentWidth) {
          maxContentWidth = scaledW + 40;
        }

        const left = Math.max(20, Math.floor((containerWidth - scaledW) / 2));

        this._pageLayouts.push({
          pageIndex: i,
          top: currentTop,
          left,
          width: scaledW,
          height: scaledH
        });

        currentTop += scaledH + pageSpacing;
      }

      this._pagesWrapper.style.height = `${currentTop + 60}px`;
      this._pagesWrapper.style.width = `${maxContentWidth}px`;
      this._pagesWrapper.style.minWidth = '100%';
    } else if (viewMode === 'single') {
      const activeIdx = Math.min(doc.pages.length - 1, Math.max(0, store.activePageIndex));
      const page = doc.pages[activeIdx];
      const { width: baseW, height: baseH } = rotatedPageSize(page, store.pageRotations[activeIdx] || 0);

      const scaledW = Math.floor(baseW * zoom);
      const scaledH = Math.floor(baseH * zoom);
      maxContentWidth = Math.max(containerWidth, scaledW + 40);
      const left = Math.max(20, Math.floor((containerWidth - scaledW) / 2));

      this._pageLayouts.push({
        pageIndex: activeIdx,
        top: 20,
        left,
        width: scaledW,
        height: scaledH
      });

      this._pagesWrapper.style.height = `${scaledH + 60}px`;
      this._pagesWrapper.style.width = `${maxContentWidth}px`;
      this._pagesWrapper.style.minWidth = '100%';
    } else if (viewMode === 'two-page') {
      // Facing spreads: 2 pages side-by-side (rotation-aware so rotated
      // pages keep their own box instead of overflowing their neighbour).
      for (let i = 0; i < doc.pages.length; i += 2) {
        const page1 = doc.pages[i];
        const page2 = i + 1 < doc.pages.length ? doc.pages[i + 1] : null;

        const s1 = rotatedPageSize(page1, store.pageRotations[i] || 0);
        const w1 = Math.floor(s1.width * zoom);
        const h1 = Math.floor(s1.height * zoom);

        const s2 = page2 ? rotatedPageSize(page2, store.pageRotations[i + 1] || 0) : null;
        const w2 = s2 ? Math.floor(s2.width * zoom) : 0;
        const h2 = s2 ? Math.floor(s2.height * zoom) : 0;

        const rowW = w1 + (page2 ? w2 + 16 : 0);
        const rowH = Math.max(h1, h2);
        if (rowW + 40 > maxContentWidth) {
          maxContentWidth = rowW + 40;
        }
        const startLeft = Math.max(20, Math.floor((containerWidth - rowW) / 2));

        this._pageLayouts.push({
          pageIndex: i,
          top: currentTop,
          left: startLeft,
          width: w1,
          height: h1
        });

        if (page2) {
          this._pageLayouts.push({
            pageIndex: i + 1,
            top: currentTop,
            left: startLeft + w1 + 16,
            width: w2,
            height: h2
          });
        }

        currentTop += rowH + pageSpacing;
      }

      this._pagesWrapper.style.height = `${currentTop + 60}px`;
      this._pagesWrapper.style.width = `${maxContentWidth}px`;
      this._pagesWrapper.style.minWidth = '100%';
    }

    this.handleScroll(force);
  }

  /**
   * Virtualization check on scroll: renders only pages intersecting the viewport + 1 buffer page.
   */
  public handleScroll(force = false) {
    if (!this._scrollContainer || this._pageLayouts.length === 0) return;

    // Map scroller space back into layout space when a zoom preview is active.
    const rawTop = this._scrollContainer.scrollTop;
    const scrollTop = rawTop / this._previewScale;
    const viewH = this._scrollContainer.clientHeight / this._previewScale;
    const buffer = viewH * 2.0; // 200% buffer ahead and behind so zoom-out exposes mounted pages, not gaps

    const newVisible = new Set<number>();
    let centerPage = 0;
    let minDistanceToCenter = Infinity;
    const viewportCenterY = scrollTop + viewH / 2;

    for (const layout of this._pageLayouts) {
      const pageBottom = layout.top + layout.height;
      if (pageBottom >= scrollTop - buffer && layout.top <= scrollTop + viewH + buffer) {
        newVisible.add(layout.pageIndex);
      }

      const pageCenterY = layout.top + layout.height / 2;
      const dist = Math.abs(pageCenterY - viewportCenterY);
      if (dist < minDistanceToCenter) {
        minDistanceToCenter = dist;
        centerPage = layout.pageIndex;
      }
    }

    // During a focal-anchored zoom step the scroll correction lands after the
    // layout pass; the intermediate pass must not mount, persist, or page-flip.
    if (store.isZoomAdjusting) return;

    // Persist exact scroll offset per-document for instant tab restore.
    // Skipped while a tab switch rebuild is in flight (stale offset would
    // clobber the just-restored page before scrollToPage runs).
    const doc = store.activeDocument;
    if (doc && !store.isDocSwitching) {
      doc.savedScrollTop = rawTop;
      doc.savedScrollLeft = this._scrollContainer.scrollLeft;
      persistDocPosition(doc);
    }

    // Update active page index based on scroll position
    if (!store.isDocSwitching && centerPage !== store.activePageIndex && store.viewMode === 'continuous') {
      store.setActivePageIndex(centerPage);
    }

    // Check if visible set changed
    let changed = newVisible.size !== this._visiblePages.size;
    if (!changed) {
      for (const idx of newVisible) {
        if (!this._visiblePages.has(idx)) {
          changed = true;
          break;
        }
      }
    }

    if (changed || force) {
      this._visiblePages = newVisible;
      this._onVisiblePagesChange?.(Array.from(newVisible));
    }
  }

  public scrollToPage(pageIndex: number, opts?: { behavior?: ScrollBehavior }) {
    if (!this._scrollContainer) return;
    const doc = store.activeDocument;
    if (doc) {
      pageIndex = Math.max(0, Math.min(doc.pageCount - 1, Math.floor(pageIndex)));
    }
    let layout = this._pageLayouts.find(p => p.pageIndex === pageIndex);
    if (!layout) {
      // Single / two-page modes only lay out the active spread, so a jump
      // target has no layout yet: activate it first, then lay out and scroll.
      // (Previously this silently did nothing and the jump field reset.)
      store.setActivePageIndex(pageIndex);
      this.updateLayout(true);
      layout = this._pageLayouts.find(p => p.pageIndex === pageIndex);
    }
    if (layout) {
      const behavior = opts?.behavior
        ?? (store.appSettings.smoothScroll !== false ? 'smooth' : 'auto');
      this._scrollContainer.scrollTo({
        top: Math.max(0, layout.top - 20),
        behavior
      });
      store.setActivePageIndex(pageIndex);
    }
  }

  public getLayout(pageIndex: number): ViewportPageRect | undefined {
    return this._pageLayouts.find(p => p.pageIndex === pageIndex);
  }

  public fitToWidth() {
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;
    const activePage = doc.pages[store.activePageIndex || 0] || doc.pages[0];
    if (!activePage) return;
    const { width: baseW } = rotatedPageSize(activePage, store.pageRotations[store.activePageIndex || 0] || 0);
    const containerW = this._scrollContainer.clientWidth - 64;
    // Single commit: setZoom's notify path lays out once.
    store.setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerW / baseW)));
  }

  public fitToPage() {
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;
    const activePage = doc.pages[store.activePageIndex || 0] || doc.pages[0];
    if (!activePage) return;
    const { width: baseW, height: baseH } = rotatedPageSize(activePage, store.pageRotations[store.activePageIndex || 0] || 0);
    const containerW = this._scrollContainer.clientWidth - 64;
    const containerH = this._scrollContainer.clientHeight - 80;
    store.setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(containerW / baseW, containerH / baseH))));
  }

  /**
   * Zooms by `factor` anchored to the viewport's own center, so the content
   * the user is actually looking at stays put instead of drifting toward
   * whatever happens to be at the scroll container's top-left — the bug
   * behind zoom +/− (toolbar buttons and Ctrl+/Ctrl−) appearing to "jump" to
   * an unrelated page. Mirrors the scroll-compensation `zoomAtPoint` already
   * does for click/wheel zoom, just anchored at the center instead of a
   * pointer position.
   */
  public zoomByFactor(factor: number): void {
    if (!this._scrollContainer || !Number.isFinite(factor) || factor <= 0) return;
    const oldZoom = store.zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    if (Math.abs(newZoom - oldZoom) < 0.0005) return;
    const ratio = newZoom / oldZoom;
    const cx = this._scrollContainer.clientWidth / 2;
    const cy = this._scrollContainer.clientHeight / 2;
    const targetLeft = (this._scrollContainer.scrollLeft + cx) * ratio - cx;
    const targetTop = (this._scrollContainer.scrollTop + cy) * ratio - cy;
    store.beginZoomAdjust();
    try {
      store.setZoom(newZoom);
      this._scrollContainer.scrollLeft = targetLeft;
      this._scrollContainer.scrollTop = targetTop;
    } finally {
      store.endZoomAdjust();
    }
    this.handleScroll(true);
  }
}

export const viewportManager = new ViewportManager();
