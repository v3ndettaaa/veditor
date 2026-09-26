/**
 * Day-6 stranded-rest re-arm regression test (narrowest seam).
 * A deferred-rest batch aborted as stale must invoke `onDeferredRestStale`
 * exactly once (handing the page back to normal scheduling); a non-stale
 * failure must NOT invoke it (genuinely-failed work still just warns); and a
 * missing owner must resolve quietly. The main-side handler (needsRaster +
 * one pass) is constructor-inline and DOM-bound — covered by operator
 * validation, not here.
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

  it('does not invoke the callback on a non-stale failure', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('boom'));
    const renderer = getPageRenderer() as unknown as {
      onDeferredRestStale: ((pageIndex: number) => void) | null;
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    const cb = vi.fn();
    renderer.onDeferredRestStale = cb;
    await renderer.renderDeferredRest(snap(4));
    expect(cb).not.toHaveBeenCalled();
  });

  it('resolves quietly with no owner registered', async () => {
    renderEngineTileMock.mockRejectedValueOnce(new Error('stale generation 9'));
    const renderer = getPageRenderer() as unknown as {
      renderDeferredRest: (s: unknown) => Promise<void>;
    };
    await expect(renderer.renderDeferredRest(snap(5))).resolves.toBeUndefined();
  });
});
