/**
 * Virtualized Viewport Coordinator
 * Enables 60fps scrolling across 500+ page documents with zero memory bloat.
 */

import { store } from './store';
import { PageInfo, ViewMode } from './types';

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

    this._scrollContainer.addEventListener('scroll', () => this.handleScroll(), { passive: true });
    window.addEventListener('resize', () => this.updateLayout(), { passive: true });
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
    if (!doc || !this._scrollContainer || !this._pagesWrapper) return;

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
    const buffer = viewH * 1.5; // 150% buffer ahead and behind to preload visible pages smoothly

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

    // Persist exact scroll offset per-document for instant tab restore.
    // Skipped while a tab switch rebuild is in flight (stale offset would
    // clobber the just-restored page before scrollToPage runs).
    const doc = store.activeDocument;
    if (doc && !store.isDocSwitching) {
      doc.savedScrollTop = rawTop;
      doc.savedScrollLeft = this._scrollContainer.scrollLeft;
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
    const newZoom = Math.max(0.2, Math.min(3.0, containerW / baseW));
    store.setZoom(newZoom);
    this.updateLayout();
  }

  public fitToPage() {
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;
    const activePage = doc.pages[store.activePageIndex || 0] || doc.pages[0];
    if (!activePage) return;
    const { width: baseW, height: baseH } = rotatedPageSize(activePage, store.pageRotations[store.activePageIndex || 0] || 0);
    const containerW = this._scrollContainer.clientWidth - 64;
    const containerH = this._scrollContainer.clientHeight - 80;
    const newZoom = Math.max(0.2, Math.min(3.0, Math.min(containerW / baseW, containerH / baseH)));
    store.setZoom(newZoom);
    this.updateLayout();
  }
}

export const viewportManager = new ViewportManager();
