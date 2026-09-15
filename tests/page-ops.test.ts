import { describe, it, expect, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  applyPageBytesResult,
  buildIndexMap,
  capturePageSnapshot,
  deletePdfPages,
  exportPdfPages,
  insertBlankPages,
  insertPdfPages,
  movePdfPages,
  onPageStructureChanged,
  reorderIndexMap,
  remapBookmarks,
  remapPageRecord,
  remapRotations,
  spliceIndexMap
} from '../src/core/page-ops';
import { history, PageOpsCommand } from '../src/core/history';
import { store } from '../src/core/store';
import { DocumentSession, PageInfo, PenAnnotation } from '../src/core/types';

/**
 * Every page gets a distinct width so page order can be asserted by reading
 * the result back rather than by trusting the operation's index arithmetic.
 */
async function makePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([600 + i, 800]);
  return doc.save();
}

async function widthsOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(page => Math.round(page.getWidth()));
}

function pageInfos(widths: number[]): PageInfo[] {
  return widths.map((width, index) => ({
    pageIndex: index,
    pageNumber: index + 1,
    width,
    height: 800,
    originalWidth: width,
    originalHeight: 800,
    rotation: 0
  }));
}

function makeDoc(bytes: Uint8Array, widths: number[]): DocumentSession {
  return {
    id: 'page-ops-doc',
    name: 'page-ops.pdf',
    fileData: bytes,
    pageCount: widths.length,
    pages: pageInfos(widths),
    bookmarks: [],
    annotations: {},
    layers: {},
    activePageIndex: 0,
    createdAt: Date.now(),
    lastModifiedAt: Date.now()
  };
}

function penOn(pageIndex: number, id: string): PenAnnotation {
  return {
    id,
    pageIndex,
    layerId: 'layer-default',
    type: 'pen',
    box: { x: 0, y: 0, width: 10, height: 10 },
    points: [{ x: 0, y: 0, pressure: 0.5 }],
    color: '#000000',
    strokeWidth: 2,
    opacity: 1,
    createdAt: 0,
    updatedAt: 0
  };
}

describe('Page index maps', () => {
  it('maps surviving pages to their new positions', () => {
    const map = buildIndexMap([1, 3]);
    expect(map.get(0)).toBeUndefined();
    expect(map.get(1)).toBe(0);
    expect(map.get(2)).toBeUndefined();
    expect(map.get(3)).toBe(1);
  });

  it('shifts existing pages down by the pages spliced in before them', () => {
    const map = spliceIndexMap(3, [{ at: 1, count: 2 }]);
    expect([map.get(0), map.get(1), map.get(2)]).toEqual([0, 3, 4]);
    // Pages appended at the end shift nothing.
    const tail = spliceIndexMap(2, [{ at: 2, count: 5 }]);
    expect([tail.get(0), tail.get(1)]).toEqual([0, 1]);
  });

  it('reorders a drag so the moved pages land before the drop target', () => {
    // Page 1 dragged downward past page 3.
    const down = reorderIndexMap(5, [1], 3);
    expect([0, 2, 1, 3, 4].map(oldIndex => down.get(oldIndex))).toEqual([0, 1, 2, 3, 4]);
    // Page 3 dragged upward onto page 1.
    const up = reorderIndexMap(5, [3], 1);
    expect([0, 3, 1, 2, 4].map(oldIndex => up.get(oldIndex))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('Page record remapping', () => {
  it('re-keys and retargets page-keyed annotation lists', () => {
    const records = {
      0: [penOn(0, 'a')],
      2: [penOn(2, 'b'), penOn(2, 'c')]
    };
    const next = remapPageRecord(records, buildIndexMap([2]));
    expect(Object.keys(next)).toEqual(['0']);
    expect(next[0].map(a => a.id)).toEqual(['b', 'c']);
    expect(next[0].every(a => a.pageIndex === 0)).toBe(true);
  });

  it('keeps only the rotations of surviving pages', () => {
    const next = remapRotations({ 0: 90, 1: 180, 4: 270 }, buildIndexMap([1, 4]));
    expect(next).toEqual({ 0: 180, 1: 270 });
  });

  it('keeps orphaned bookmark branches that still have surviving children', () => {
    const marks = [
      { title: 'gone', pageIndex: 0 },
      { title: 'parent', pageIndex: 2, items: [{ title: 'child', pageIndex: 1 }] }
    ];
    // Only old page 1 survives, as the new page 0.
    expect(remapBookmarks(marks, buildIndexMap([1]))).toEqual([
      { title: 'parent', items: [{ title: 'child', pageIndex: 0 }] }
    ]);
  });
});

describe('PDF page operations', () => {
  it('exports a standalone PDF of the requested pages, in document order', async () => {
    const bytes = await makePdf(4);
    const export2 = await exportPdfPages(bytes, [3, 0]);
    expect(export2).not.toBeNull();
    expect(await widthsOf(export2!.bytes)).toEqual([600, 603]);
    expect(export2!.pageCount).toBe(2);
  });

  it('deletes pages and refuses to delete the last one', async () => {
    const bytes = await makePdf(4);
    expect(await widthsOf((await deletePdfPages(bytes, [1])).bytes)).toEqual([600, 602, 603]);

    const all = await deletePdfPages(bytes, [0, 1, 2, 3]);
    expect(all.pageCount).toBe(1);
  });

  it('inserts foreign pages at an index', async () => {
    const bytes = await makePdf(4);
    const donor = await exportPdfPages(bytes, [3]);
    const merged = await insertPdfPages(bytes, 2, donor!.bytes);
    expect(await widthsOf(merged.bytes)).toEqual([600, 601, 603, 602, 603]);
    expect(merged.pageCount).toBe(5);
  });

  it('inserts blank pages at the requested size', async () => {
    const bytes = await makePdf(4);
    const result = await insertBlankPages(bytes, 1, 2, 612, 792);
    expect(await widthsOf(result.bytes)).toEqual([600, 612, 612, 601, 602, 603]);
  });

  it('moves pages forward and backward', async () => {
    const bytes = await makePdf(4);
    expect(await widthsOf((await movePdfPages(bytes, [0], 3)).bytes)).toEqual([601, 602, 600, 603]);
    expect(await widthsOf((await movePdfPages(bytes, [3], 1)).bytes)).toEqual([600, 603, 601, 602]);
    // Moving every page is a no-op rather than a corrupt file.
    const all = await movePdfPages(bytes, [0, 1, 2, 3], 0);
    expect(await widthsOf(all.bytes)).toEqual([600, 601, 602, 603]);
  });
});

describe('PageOpsCommand', () => {
  let doc: DocumentSession;
  let originalBytes: Uint8Array;

  beforeEach(async () => {
    store.closeAllDocumentTabs();
    history.clear();
    originalBytes = await makePdf(4);
    doc = makeDoc(originalBytes, [600, 601, 602, 603]);
    doc.annotations = { 0: [penOn(0, 'keep')], 2: [penOn(2, 'moves')] };
    store.setActiveDocument(doc);
  });

  it('restores bytes and page-keyed records on undo, and reapplies them on redo', async () => {
    const rotations = store.pageRotations;
    const before = capturePageSnapshot(doc, rotations);

    // Delete page 1: page 2's annotation must slide into index 1.
    const result = await deletePdfPages(doc.fileData!, [1]);
    applyPageBytesResult(doc, rotations, result, buildIndexMap([0, 2, 3]));
    const after = capturePageSnapshot(doc, rotations);
    history.pushCommitted(new PageOpsCommand('Delete page', before, after));

    expect(doc.pageCount).toBe(3);
    expect(Object.keys(doc.annotations).sort()).toEqual(['0', '1']);
    expect(doc.annotations[1][0].pageIndex).toBe(1);

    history.undo();
    expect(doc.pageCount).toBe(4);
    expect([...doc.fileData!]).toEqual([...originalBytes]);
    expect(Object.keys(doc.annotations).sort()).toEqual(['0', '2']);
    expect(doc.annotations[2][0].pageIndex).toBe(2);

    history.redo();
    expect(doc.pageCount).toBe(3);
    expect(Object.keys(doc.annotations).sort()).toEqual(['0', '1']);
  });

  it('restores the user rotation of a page through an undo', async () => {
    const rotations = store.pageRotations;
    const before = capturePageSnapshot(doc, rotations, { omitBytes: true });
    rotations[1] = 90;
    const after = capturePageSnapshot(doc, rotations, { omitBytes: true });
    history.pushCommitted(new PageOpsCommand('Rotate page', before, after));

    expect(store.pageRotations[1]).toBe(90);
    history.undo();
    expect(store.pageRotations[1]).toBeUndefined();
    // A rotation-only snapshot must not have swapped the bytes underneath.
    expect(doc.fileData).toBe(originalBytes);
  });

  it('tells the app the page structure changed on every apply', async () => {
    const rotations = store.pageRotations;
    const before = capturePageSnapshot(doc, rotations, { omitBytes: true });
    rotations[0] = 180;
    const after = capturePageSnapshot(doc, rotations, { omitBytes: true });

    let signals = 0;
    const unsubscribe = onPageStructureChanged(() => { signals++; });
    history.pushCommitted(new PageOpsCommand('Rotate page', before, after));
    expect(signals).toBe(0);

    history.undo();
    expect(signals).toBe(1);
    history.redo();
    expect(signals).toBe(2);
    unsubscribe();
  });
});
