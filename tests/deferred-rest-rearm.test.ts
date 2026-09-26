/**
 * Day-6 stranded-rest re-arm regression test (narrowest seam), extended by
 * the stub-backend fix: generic deferred failures re-arm while the document
 * is still open (closed-doc stays silent), and a failed pdf.js fallback
 * reports unpainted so the caller retries instead of stranding white.
 * The main-side handler (needsRaster + one pass) is constructor-inline and
 * DOM-bound — covered by operator validation, not here.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { getPageRenderer } from '../src/core/page-renderer';
import { store } from '../src/core/store';
import { renderEngineTile } from '../src/io/engine-tiles';

vi.mock('../src/io/storage', () => ({ persistDocPosition: vi.fn() }));
vi.mock('../src/core/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/core/config')>()),
  getRendererKind: () => 'mupdf' as const,
}));
vi.mock('../src/io/engine-tiles', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/io/engine-tiles')>()),
  renderEngineTile: vi.fn(),
}));

const renderEngineTileMock = vi.mocked(renderEngineTile);

function snap(pageIndex = 3) {
  const canvas = { isConnected: true, width: 512, height: 512 } as unknown as HTMLCanvasElement;
  return {
    docId: 'd6-strand',
    pageIndex,
    zoom: 1,
    rotation: 0,
    renderer: 'mupdf' as const,
    dpr: 2,
    devW: 512,
    devH: 512,
    gen: 7,
    rest: [{ tx: 0, ty: 0, prio: 4 }],
    canvas,
    ctx: {} as unknown as CanvasRenderingContext2D,
    t0: 0,
  };
}

describe('deferred-rest stale re-arm', () => {
  beforeEach(() => {
    store.setZoom(1);
    store.setActiveDocument({
      id: 'd6-strand', name: 'Strand', pageCount: 10,
      pages: Array.from({ length: 10 }, (_, pageIndex) => ({
        pageIndex, pageNumber: pageIndex + 1, width: 595, height: 842,
        originalWidth: 595, originalHeight: 842, rotation: 0,
      })),
      bookmarks: [], annotations: {}, layers: {}, activePageIndex: 0,
      createdAt: 0, lastModifiedAt: 0,
    });
  });

  afterEach(() => {
    const r = getPageRenderer() as unknown as {
      onDeferredRestStale: ((pageIndex: number) => void) | null;
    };
    r.onDeferredRestStale = null;
    store.closeDocumentTab('d6-strand');
    store.setActiveDocument(null);
    vi.restoreAllMocks();
  });

  it('invokes the callback exactly once on a stale abort', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('stale generation 9'));
    const renderer = getPageRenderer() as unknown as {
      onDeferredRestStale: ((pageIndex: number) => void) | null;
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    const cb = vi.fn();
    renderer.onDeferredRestStale = cb;
    await renderer.renderDeferredRest(snap(3));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(3);
  });

  it('invokes the callback exactly once on an open-doc generic failure', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('InvalidPage(3)'));
    const renderer = getPageRenderer() as unknown as {
      onDeferredRestStale: ((pageIndex: number) => void) | null;
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    const cb = vi.fn();
    renderer.onDeferredRestStale = cb;
    await renderer.renderDeferredRest(snap(4));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(4);
  });

  it('does not invoke the callback on a closed-doc generic failure', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('InvalidPage(5)'));
    // Simulate the close-mid-flight race: timer-fire coherence checks pass
    // (activeDocument still set) but the registry no longer tracks the doc.
    store.openDocuments.delete('d6-strand');
    const renderer = getPageRenderer() as unknown as {
      onDeferredRestStale: ((pageIndex: number) => void) | null;
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    const cb = vi.fn();
    renderer.onDeferredRestStale = cb;
    await renderer.renderDeferredRest(snap(5));
    expect(cb).not.toHaveBeenCalled();
  });

  it('resolves quietly with no owner registered', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('stale generation 9'));
    const renderer = getPageRenderer() as unknown as {
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    await expect(renderer.renderDeferredRest(snap(6))).resolves.toBeUndefined();
  });

  it('renderPage reports false when engine and fallback both fail', async () => {
    // Engine open throws (no path/bytes on the fake doc) and pdfEngine has
    // no document loaded, so the fallback reports unpainted: the caller must
    // see false (re-arm eligible) instead of a white-stranding true.
    const renderer = getPageRenderer() as unknown as {
      renderPage: (pageIndex: number, canvas: HTMLCanvasElement, zoom: number, rotation: number) => Promise<boolean>;
    };
    const canvas = { isConnected: true } as unknown as HTMLCanvasElement;
    await expect(renderer.renderPage(3, canvas, 1, 0)).resolves.toBe(false);
  });
});
