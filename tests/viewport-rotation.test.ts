import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { rotatedPageSize, ViewportManager } from '../src/core/viewport';
import { store } from '../src/core/store';
import { MAX_ZOOM, MIN_ZOOM, type DocumentSession, type ViewMode } from '../src/core/types';
import { persistDocPosition } from '../src/io/storage';

vi.mock('../src/io/storage', () => ({ persistDocPosition: vi.fn() }));

const A4 = { originalWidth: 595, originalHeight: 842 };

describe('Page-relative zoom', () => {
  let viewport: ViewportManager;
  let scroll: { addEventListener: ReturnType<typeof vi.fn>; clientWidth: number; clientHeight: number; scrollLeft: number; scrollTop: number };
  let wrapper: { style: Record<string, string> };
  let visible: (indices: number[]) => void;
  let previous: { doc: DocumentSession | null; zoom: number; mode: ViewMode; page: number };
  let unsubscribe: (() => void) | undefined;
  let lastVisible: number[] | undefined;

  beforeEach(() => {
    previous = { doc: store.activeDocument, zoom: store.zoom, mode: store.viewMode, page: store.activePageIndex };
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    store.setZoom(1);
    store.setViewMode('continuous');
    store.setActiveDocument({
      id: 'viewport-zoom', name: 'Zoom', pageCount: 6,
      pages: Array.from({ length: 6 }, (_, pageIndex) => ({
        pageIndex, pageNumber: pageIndex + 1, width: 595, height: 842,
        originalWidth: 595, originalHeight: 842, rotation: 0
      })),
      bookmarks: [], annotations: {}, layers: {}, activePageIndex: 0,
      createdAt: 0, lastModifiedAt: 0
    });
    scroll = { addEventListener: vi.fn(), clientWidth: 900, clientHeight: 600, scrollLeft: 0, scrollTop: 0 };
    wrapper = { style: {} };
    visible = vi.fn((indices: number[]) => { lastVisible = indices; });
    viewport = new ViewportManager();
    viewport.init(scroll as unknown as HTMLElement, wrapper as unknown as HTMLElement, visible);
    viewport.updateLayout();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    vi.restoreAllMocks();
    store.endZoomAdjust();
    store.closeDocumentTab('viewport-zoom');
    store.setActiveDocument(previous.doc);
    store.setZoom(previous.zoom);
    store.setViewMode(previous.mode);
    store.setActivePageIndex(previous.page);
    vi.unstubAllGlobals();
  });

  function anchorAt(page: number, x: number, y: number, focal = { x: 173, y: 127 }) {
    const layout = viewport.getLayout(page)!;
    scroll.scrollLeft = layout.left + layout.width * x - focal.x;
    scroll.scrollTop = layout.top + layout.height * y - focal.y;
    return focal;
  }

  function expectAnchor(page: number, x: number, y: number, focal: { x: number; y: number }) {
    const layout = viewport.getLayout(page)!;
    expect(layout.left + layout.width * x - scroll.scrollLeft).toBeCloseTo(focal.x, 4);
    expect(layout.top + layout.height * y - scroll.scrollTop).toBeCloseTo(focal.y, 4);
  }

  it('keeps an off-center point on a later page fixed when zooming in and out', () => {
    const focal = anchorAt(3, 0.63, 0.41);
    const original = { left: scroll.scrollLeft, top: scroll.scrollTop };
    viewport.zoomByFactor(1.7, focal);
    expectAnchor(3, 0.63, 0.41, focal);
    viewport.zoomByFactor(1 / 1.7, focal);
    expectAnchor(3, 0.63, 0.41, focal);
    expect(scroll.scrollLeft).toBeCloseTo(original.left, 8);
    expect(scroll.scrollTop).toBeCloseTo(original.top, 8);
  });

  it('anchors zooms without a focal to the scroller center across margins and gaps', () => {
    const focal = { x: scroll.clientWidth / 2, y: scroll.clientHeight / 2 };
    anchorAt(3, 0.63, 0.41, focal);
    viewport.zoomByFactor(2);
    expectAnchor(3, 0.63, 0.41, focal);
  });

  it('keeps the focal inside the page rect across facing spreads', () => {
    store.setViewMode('two-page');
    viewport.updateLayout();
    const focal = anchorAt(1, 0.3, 0.55);
    viewport.zoomByFactor(2.25, focal);
    expectAnchor(1, 0.3, 0.55, focal);
  });

  it('restores an in-gap anchor after zooming', () => {
    const first = viewport.getLayout(0)!;
    const gapTop = first.top + first.height + 12;
    const focal = { x: 450, y: 200 };
    scroll.scrollLeft = first.left + first.width / 2 - focal.x;
    scroll.scrollTop = gapTop - focal.y;
    const offsetY = (gapTop - first.top) / first.height;
    viewport.zoomByFactor(1.5, focal);
    expectAnchor(0, 0.5, offsetY, focal);
  });

  it('clamps to bounds and still anchors at the limits', () => {
    store.setZoom(MAX_ZOOM);
    viewport.updateLayout();
    const focal = anchorAt(2, 0.5, 0.5);
    viewport.zoomByFactor(10, focal);
    expect(store.zoom).toBe(MAX_ZOOM);
    expectAnchor(2, 0.5, 0.5, focal);
    store.setZoom(MIN_ZOOM);
    viewport.updateLayout();
    anchorAt(2, 0.5, 0.5, focal);
    viewport.zoomByFactor(0.01, focal);
    expect(store.zoom).toBe(MIN_ZOOM);
    expectAnchor(2, 0.5, 0.5, focal);
  });

  it('ignores invalid factors and missing documents', () => {
    const before = { left: scroll.scrollLeft, top: scroll.scrollTop, zoom: store.zoom };
    viewport.zoomByFactor(NaN);
    viewport.zoomByFactor(Infinity);
    viewport.zoomByFactor(0);
    viewport.zoomByFactor(-2);
    expect(store.zoom).toBe(before.zoom);
    expect(scroll.scrollLeft).toBe(before.left);
    expect(scroll.scrollTop).toBe(before.top);
    store.setActiveDocument(null);
    viewport.zoomByFactor(2);
    expect(scroll.scrollLeft).toBe(before.left);
    expect(scroll.scrollTop).toBe(before.top);
  });

  it('keeps fractional page dimensions instead of flooring scaled sizes', () => {
    store.setZoom(1.37);
    viewport.updateLayout();
    const layout = viewport.getLayout(0)!;
    expect(layout.width).toBeCloseTo(595 * 1.37, 8);
    expect(layout.height).toBeCloseTo(842 * 1.37, 8);
    const second = viewport.getLayout(1)!;
    expect(second.top).toBeCloseTo(layout.height + 24 + 20, 8);
  });

  it('toggles zoom adjusting around setZoom', () => {
    const events: string[] = [];
    unsubscribe = store.subscribe(() => events.push(store.isZoomAdjusting ? 'adjusting' : 'idle'));
    const focal = anchorAt(2, 0.5, 0.5);
    viewport.zoomByFactor(1.25, focal);
    expect(events.filter(e => e === 'adjusting')).toHaveLength(1);
    expect(events[0]).toBe('adjusting');
    expect(store.isZoomAdjusting).toBe(false);
    expect(events).toContain('idle');
  });

  it('anchors fitToWidth to an explicit focal point on a later page', () => {
    store.setZoom(2.5);
    store.setActivePageIndex(3);
    viewport.updateLayout();
    const focal = { x: 450, y: 200 };
    anchorAt(3, 0.5, 0.41, focal);
    viewport.fitToWidth(focal);
    expect(store.zoom).toBeCloseTo((900 - 64) / 595, 8);
    expectAnchor(3, 0.5, 0.41, focal);
  });

  it('anchors fitToWidth without a focal point to the scroller center', () => {
    store.setZoom(2.5);
    store.setActivePageIndex(3);
    viewport.updateLayout();
    const focal = { x: 450, y: 300 };
    anchorAt(3, 0.5, 0.41, focal);
    viewport.fitToWidth();
    expect(store.zoom).toBeCloseTo((900 - 64) / 595, 8);
    expectAnchor(3, 0.5, 0.41, focal);
  });
});

it('clears PDF geometry on home and preserves vertical home scrolling during resize', () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const scroll = { addEventListener: vi.fn(), scrollLeft: 900, scrollTop: 240 };
  const wrapper = { style: { width: '2400px', height: '9000px', minWidth: '100%', transform: 'scale(2)', transformOrigin: '0 0' } };
  const viewport = new ViewportManager();
  const previous = store.activeDocument;
  try {
    store.setActiveDocument(null);
    viewport.init(scroll as unknown as HTMLElement, wrapper as unknown as HTMLElement, vi.fn());
    viewport.updateLayout();
    expect(wrapper.style).toEqual({ width: '', height: '', minWidth: '', transform: '', transformOrigin: '' });
    expect(scroll.scrollLeft).toBe(0);
    expect(scroll.scrollTop).toBe(240);
    expect(viewport.getLayout(0)).toBeUndefined();
    viewport.updateLayout();
    expect(scroll.scrollTop).toBe(240);
  } finally {
    store.setActiveDocument(previous);
    vi.unstubAllGlobals();
  }
});

describe('Rotation-aware page sizing', () => {
  it('keeps dimensions without user rotation', () => {
    expect(rotatedPageSize(A4, 0)).toEqual({ width: 595, height: 842 });
  });

  it('swaps dimensions at 90 and 270 degrees', () => {
    expect(rotatedPageSize(A4, 90)).toEqual({ width: 842, height: 595 });
    expect(rotatedPageSize(A4, 270)).toEqual({ width: 842, height: 595 });
    expect(rotatedPageSize(A4, -90)).toEqual({ width: 842, height: 595 });
  });

  it('keeps dimensions at 180 degrees', () => {
    expect(rotatedPageSize(A4, 180)).toEqual({ width: 595, height: 842 });
  });
});
