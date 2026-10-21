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
  private _onScreenPages: Set<number> = new Set();
  private _pageLayouts: ViewportPageRect[] = [];
  private _onVisiblePagesChange: ((visibleIndices: number[]) => void) | null = null;
  private _previewScale: number = 1;
  private _scrollRafId: number | null = null;
  /**
   * Latched mathematical page anchor `(pageIndex, offsetX, offsetY)` in
   * normalized `[0, 1]` page space. Preserved across consecutive zoom steps
   * at the same focal point so browser scroll clamping (`scrollTop = 0` or
   * centered margins when a page is narrower than the viewport) never causes
   * cumulative anchor drift when zooming in and zooming back out.
   */
  private _zoomAnchor: {
    docId: string;
    pageIndex: number;
    offsetX: number;
    offsetY: number;
    focalX: number;
    focalY: number;
    timestamp: number;
  } | null = null;
  private _ignoreNextScrollAnchorReset: boolean = false;

  public setPreviewScale(scale: number): void {
    this._previewScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
  }

  public clearZoomAnchor(): void {
    this._zoomAnchor = null;
  }

  public init(
    scrollContainer: HTMLElement,
    pagesWrapper: HTMLElement,
    onVisiblePagesChange: (visibleIndices: number[]) => void
  ) {
    this._scrollContainer = scrollContainer;
    this._pagesWrapper = pagesWrapper;
    this._onVisiblePagesChange = onVisiblePagesChange;

    this._scrollContainer.addEventListener('scroll', () => {
      if (!store.isZoomAdjusting && !this._ignoreNextScrollAnchorReset) {
        this._zoomAnchor = null;
      }
      this._ignoreNextScrollAnchorReset = false;
      this.scheduleScrollCheck();
    }, { passive: true });
    window.addEventListener('resize', () => {
      this._zoomAnchor = null;
      this.updateLayout();
    }, { passive: true });
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
    this._onScreenPages.clear();
    this._zoomAnchor = null;
  }

  /** Pages directly intersecting the user's visible viewport (highest render priority). */
  public getOnScreenPages(): ReadonlySet<number> {
    return this._onScreenPages;
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
      this._onScreenPages.clear();
      this._previewScale = 1;
      this._zoomAnchor = null;
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

        const scaledW = baseW * zoom;
        const scaledH = baseH * zoom;
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

      const scaledW = baseW * zoom;
      const scaledH = baseH * zoom;
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
        const w1 = s1.width * zoom;
        const h1 = s1.height * zoom;

        const s2 = page2 ? rotatedPageSize(page2, store.pageRotations[i + 1] || 0) : null;
        const w2 = s2 ? s2.width * zoom : 0;
        const h2 = s2 ? s2.height * zoom : 0;

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
   * Virtualization check on scroll: identifies pages currently on-screen
   * plus `store.appSettings.maxRenderBufferPages` (1, 3, or 5) preload pages
   * ahead and behind so scrolling into adjacent pages is instantaneous.
   */
  public handleScroll(force = false) {
    if (!this._scrollContainer || this._pageLayouts.length === 0) return;

    // Map scroller space back into layout space when a zoom preview is active.
    const rawTop = this._scrollContainer.scrollTop;
    const scrollTop = rawTop / this._previewScale;
    const viewH = this._scrollContainer.clientHeight / this._previewScale;
    const bufferPages = Math.max(1, Math.min(8, store.appSettings.maxRenderBufferPages || 3));

    // Immediate on-screen window (plus 140px lead-in so a page edge entering view is already hot)
    const onScreenMargin = 140;
    const newOnScreen = new Set<number>();
    const newVisible = new Set<number>();
    let centerPage = 0;
    let minDistanceToCenter = Infinity;
    const viewportCenterY = scrollTop + viewH / 2;

    // Pixel lookahead proportional to configured preload buffer pages
    const firstPageH = this._pageLayouts[0]?.height || viewH || 800;
    const preloadPx = store.zoom > 2.4
      ? Math.max(viewH * 0.65, firstPageH * Math.min(2, bufferPages * 0.65))
      : Math.max(viewH * bufferPages * 0.85, firstPageH * bufferPages);

    let minOnScreenIdx = Infinity;
    let maxOnScreenIdx = -Infinity;

    for (const layout of this._pageLayouts) {
      const pageBottom = layout.top + layout.height;
      if (pageBottom >= scrollTop - onScreenMargin && layout.top <= scrollTop + viewH + onScreenMargin) {
        newOnScreen.add(layout.pageIndex);
        newVisible.add(layout.pageIndex);
        if (layout.pageIndex < minOnScreenIdx) minOnScreenIdx = layout.pageIndex;
        if (layout.pageIndex > maxOnScreenIdx) maxOnScreenIdx = layout.pageIndex;
      } else if (pageBottom >= scrollTop - preloadPx && layout.top <= scrollTop + viewH + preloadPx) {
        newVisible.add(layout.pageIndex);
      }

      const pageCenterY = layout.top + layout.height / 2;
      const dist = Math.abs(pageCenterY - viewportCenterY);
      if (dist < minDistanceToCenter) {
        minDistanceToCenter = dist;
        centerPage = layout.pageIndex;
      }
    }

    if (newOnScreen.size === 0) {
      newOnScreen.add(centerPage);
      newVisible.add(centerPage);
      minOnScreenIdx = centerPage;
      maxOnScreenIdx = centerPage;
    }

    // Guarantee exact N-page count preload ahead and behind in continuous / two-page layouts
    if (store.viewMode !== 'single' && Number.isFinite(minOnScreenIdx) && Number.isFinite(maxOnScreenIdx)) {
      const maxExistingPage = this._pageLayouts[this._pageLayouts.length - 1]?.pageIndex ?? 0;
      const maxIndexRadius = store.zoom > 2.4 ? Math.min(2, bufferPages) : bufferPages;
      const startPreload = Math.max(0, minOnScreenIdx - maxIndexRadius);
      const endPreload = Math.min(maxExistingPage, maxOnScreenIdx + maxIndexRadius);
      for (const layout of this._pageLayouts) {
        if (layout.pageIndex >= startPreload && layout.pageIndex <= endPreload) {
          newVisible.add(layout.pageIndex);
        }
      }
    }

    // Order visibleIndices so on-screen pages come FIRST (sorted by distance to viewport center),
    // followed by preload buffer pages sorted by proximity to the viewport center.
    const sortedVisible = Array.from(newVisible).sort((a, b) => {
      const aOn = newOnScreen.has(a) ? 0 : 1;
      const bOn = newOnScreen.has(b) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return Math.abs(a - centerPage) - Math.abs(b - centerPage);
    });

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

    // Check if visible or on-screen set changed
    let changed = newVisible.size !== this._visiblePages.size || newOnScreen.size !== this._onScreenPages.size;
    if (!changed) {
      for (const idx of newVisible) {
        if (!this._visiblePages.has(idx)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      for (const idx of newOnScreen) {
        if (!this._onScreenPages.has(idx)) {
          changed = true;
          break;
        }
      }
    }

    this._onScreenPages = newOnScreen;
    if (changed || force) {
      this._visiblePages = new Set(sortedVisible);
      this._onVisiblePagesChange?.(sortedVisible);
    }
  }

  public scrollToPage(pageIndex: number, opts?: { behavior?: ScrollBehavior }) {
    if (!this._scrollContainer) return;
    this._zoomAnchor = null;
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

  public fitToWidth(focal?: { x: number; y: number }): void {
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;
    const activePage = doc.pages[store.activePageIndex || 0] || doc.pages[0];
    if (!activePage) return;
    const { width: baseW } = rotatedPageSize(activePage, store.pageRotations[store.activePageIndex || 0] || 0);
    const containerW = this._scrollContainer.clientWidth - 64;
    const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerW / baseW));
    if (this._pageLayouts.length === 0 || store.isDocSwitching) {
      store.setZoom(targetZoom);
      return;
    }
    this.zoomByFactor(targetZoom / store.zoom, focal);
  }

  public fitToPage() {
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;
    const activePage = doc.pages[store.activePageIndex || 0] || doc.pages[0];
    if (!activePage) return;
    const { width: baseW, height: baseH } = rotatedPageSize(activePage, store.pageRotations[store.activePageIndex || 0] || 0);
    const containerW = this._scrollContainer.clientWidth - 64;
    const containerH = this._scrollContainer.clientHeight - 80;
    const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(containerW / baseW, containerH / baseH)));
    if (this._pageLayouts.length === 0 || store.isDocSwitching) {
      store.setZoom(targetZoom);
      return;
    }
    this.zoomByFactor(targetZoom / store.zoom);
  }

  /**
   * Zooms by `factor` anchored to an optional focal point in scroller-space
   * (defaults to the viewport center), latching the normalized `(pageIndex, u, v)`
   * coordinate across consecutive zoom ticks at the same focal point so browser
   * scroll clamping never causes drift when zooming in and back out.
   */
  public zoomByFactor(factor: number, focal?: { x: number; y: number }): void {
    const doc = store.activeDocument;
    if (!this._scrollContainer || !doc || !Number.isFinite(factor) || factor <= 0) return;
    const oldZoom = store.zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;
    const cx = focal ? focal.x : this._scrollContainer.clientWidth / 2;
    const cy = focal ? focal.y : this._scrollContainer.clientHeight / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const canReuseAnchor =
      this._zoomAnchor !== null &&
      this._zoomAnchor.docId === doc.id &&
      Math.hypot(cx - this._zoomAnchor.focalX, cy - this._zoomAnchor.focalY) <= 10 &&
      now - this._zoomAnchor.timestamp < 5000 &&
      this.getLayout(this._zoomAnchor.pageIndex) !== undefined;

    let anchorPageIndex: number;
    let offsetX: number;
    let offsetY: number;

    if (canReuseAnchor && this._zoomAnchor) {
      anchorPageIndex = this._zoomAnchor.pageIndex;
      offsetX = this._zoomAnchor.offsetX;
      offsetY = this._zoomAnchor.offsetY;
      this._zoomAnchor.focalX = cx;
      this._zoomAnchor.focalY = cy;
      this._zoomAnchor.timestamp = now;
    } else {
      const contentX = this._scrollContainer.scrollLeft + cx;
      const contentY = this._scrollContainer.scrollTop + cy;
      let anchor: ViewportPageRect | undefined;
      let nearestDistance = Infinity;
      for (const layout of this._pageLayouts) {
        if (layout.width <= 0 || layout.height <= 0) continue;
        const dx = Math.max(layout.left - contentX, 0, contentX - layout.left - layout.width);
        const dy = Math.max(layout.top - contentY, 0, contentY - layout.top - layout.height);
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          anchor = layout;
          nearestDistance = distance;
        }
      }
      if (!anchor) {
        store.setZoom(newZoom);
        return;
      }
      anchorPageIndex = anchor.pageIndex;
      offsetX = (contentX - anchor.left) / anchor.width;
      offsetY = (contentY - anchor.top) / anchor.height;
      this._zoomAnchor = {
        docId: doc.id,
        pageIndex: anchorPageIndex,
        offsetX,
        offsetY,
        focalX: cx,
        focalY: cy,
        timestamp: now
      };
    }

    const oldLayouts = this._pageLayouts;
    store.beginZoomAdjust();
    try {
      store.setZoom(newZoom);
      if (this._pageLayouts === oldLayouts) this.updateLayout();
      const layout = this.getLayout(anchorPageIndex);
      if (layout) {
        this._ignoreNextScrollAnchorReset = true;
        this._scrollContainer.scrollLeft = layout.left + offsetX * layout.width - cx;
        this._scrollContainer.scrollTop = layout.top + offsetY * layout.height - cy;
      }
    } finally {
      store.endZoomAdjust();
    }
    this.handleScroll(true);
  }
}

export const viewportManager = new ViewportManager();
