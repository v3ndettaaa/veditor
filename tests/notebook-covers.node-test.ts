import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  NOTEBOOK_COVERS,
  NO_COVER_SPEC,
  getCommonCovers,
  getCoversByCategory,
  getDefaultNotebookCover,
  getNotebookCoverById,
  hasNotebookCover,
  renderNotebookCoverSvg,
  remapDocumentPagesForCoverToggle
} from '../src/io/notebook-covers';
import { buildNotebookPdf, DEFAULT_PAPER } from '../src/io/notebook';
import { resolveNotebookPageDimensions } from '../src/core/types';

test('cover catalog includes Common, Simple, Solid, Textured, and No cover', () => {
  assert.equal(getNotebookCoverById('none').id, 'none');
  assert.equal(hasNotebookCover(NO_COVER_SPEC), false);
  assert.equal(hasNotebookCover(getDefaultNotebookCover()), true);

  const common = getCommonCovers();
  assert.equal(common.length, 4);
  assert.equal(common[0].id, 'none');
  assert.equal(common[1].id, 'simple-allblack');

  assert.ok(getCoversByCategory('simple').length >= 6);
  assert.ok(getCoversByCategory('solid').length >= 6);
  assert.ok(getCoversByCategory('textured').length >= 4);

  // Every cover renders valid SVG markup in both portrait and landscape
  for (const cover of NOTEBOOK_COVERS) {
    const svgPortrait = renderNotebookCoverSvg(cover, { landscape: false });
    const svgLandscape = renderNotebookCoverSvg(cover, { landscape: true });
    assert.ok(svgPortrait.includes('<svg') && svgPortrait.includes('</svg>'));
    assert.ok(svgLandscape.includes('viewBox="0 0 160 120"'));
  }
});

test('buildNotebookPdf prepends Page 1 cover when selected and respects orientation', async () => {
  const cover = getNotebookCoverById('solid-babyblue');
  const bytesWithCover = await buildNotebookPdf(DEFAULT_PAPER, 'letter', 3, {
    cover,
    orientation: 'portrait'
  });
  const docWithCover = await PDFDocument.load(bytesWithCover);
  assert.equal(docWithCover.getPageCount(), 4, '1 cover page + 3 paper pages = 4 total pages');
  const p0Size = docWithCover.getPage(0).getSize();
  assert.equal(p0Size.width, 612);
  assert.equal(p0Size.height, 792);

  const bytesNoCover = await buildNotebookPdf(DEFAULT_PAPER, 'letter', 3, {
    cover: NO_COVER_SPEC,
    orientation: 'landscape'
  });
  const docNoCover = await PDFDocument.load(bytesNoCover);
  assert.equal(docNoCover.getPageCount(), 3, 'No cover keeps exact paper page count');
  const landSize = docNoCover.getPage(0).getSize();
  assert.equal(landSize.width, 792);
  assert.equal(landSize.height, 612);

  const resolvedA4Land = resolveNotebookPageDimensions('a4', 'landscape');
  assert.equal(resolvedA4Land.width, 842);
  assert.equal(resolvedA4Land.height, 595);
});

test('remapDocumentPagesForCoverToggle preserves annotations across cover toggles', () => {
  const mkAnn = (id: string, pageIndex: number): any => ({
    id,
    pageIndex,
    layerId: 'layer-default',
    type: 'pen',
    box: { x: 10, y: 10, width: 20, height: 20 },
    opacity: 1,
    createdAt: 1,
    updatedAt: 1
  });

  // 1. Adding a cover to a 3-page coverless notebook shifts page 0 -> 1 and page 2 -> 3
  const added = remapDocumentPagesForCoverToggle(
    {
      pageCount: 3,
      activePageIndex: 1,
      annotations: { 0: [mkAnn('a0', 0)], 2: [mkAnn('a2', 2)] },
      layers: { 0: [{ id: 'l0', name: 'L0', visible: true, locked: false, opacity: 1, order: 0 }] },
      userBookmarks: [{ id: 'b1', title: 'Intro', pageIndex: 0, createdAt: 1 }]
    },
    false,
    true
  );
  assert.equal(added.pageDelta, 1);
  assert.equal(added.pageCount, 4);
  assert.equal(added.paperPageCount, 3);
  assert.equal(added.activePageIndex, 2);
  assert.equal(added.annotations[0], undefined);
  assert.equal(added.annotations[1][0].pageIndex, 1);
  assert.equal(added.annotations[3][0].pageIndex, 3);
  assert.equal(added.userBookmarks?.[0].pageIndex, 1);

  // 2. Switching between two covers performs zero index shift
  const swapped = remapDocumentPagesForCoverToggle(added, true, true);
  assert.equal(swapped.pageDelta, 0);
  assert.equal(swapped.pageCount, 4);
  assert.equal(swapped.paperPageCount, 3);
  assert.equal(swapped.annotations[1][0].id, 'a0');

  // 3. Removing cover shifts pages >= 1 back by -1 cleanly
  const removed = remapDocumentPagesForCoverToggle(swapped, true, false);
  assert.equal(removed.pageDelta, -1);
  assert.equal(removed.pageCount, 3);
  assert.equal(removed.paperPageCount, 3);
  assert.equal(removed.activePageIndex, 1);
  assert.equal(removed.annotations[0][0].id, 'a0');
  assert.equal(removed.annotations[0][0].pageIndex, 0);
  assert.equal(removed.annotations[2][0].id, 'a2');
});
