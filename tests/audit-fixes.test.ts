import { describe, it, expect, beforeEach } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { store } from '../src/core/store';
import { history, BulkModifyCommand, DeleteAnnotationsCommand } from '../src/core/history';
import { pdfExporter } from '../src/io/export-pdf';
import { pageActions } from '../src/core/page-actions';
import { syncNativeInkAnnotations } from '../src/core/native-ink';
import {
  applyRecordMap,
  buildIndexMap,
  capturePageSnapshot,
  applyPageSnapshot,
  cropPdfPages,
  resetPdfPageCrops
} from '../src/core/page-ops';
import { rotatedPageSize } from '../src/core/viewport';
import { tr } from '../src/ui/i18n';
import type { DocumentSession, PageInfo, PenAnnotation, ShapeAnnotation } from '../src/core/types';

function makePage(pageIndex: number, width = 600, height = 800, rotation = 0): PageInfo {
  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    width,
    height,
    rotation,
    originalWidth: width,
    originalHeight: height
  };
}

describe('Veditor v4.0 Audit Fixes Verification Suite', () => {
  beforeEach(() => {
    store.closeAllDocumentTabs();
    history.clear();
    for (const k of Object.keys(store.pageRotations)) {
      delete store.pageRotations[Number(k)];
    }
    store.updateAppSettings({ language: 'en' });
  });

  it('1. Bakes user page rotations into exported PDF /Rotate when bakePageRotations is true, and omits when false', async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    src.addPage([600, 800]);
    const bytes = await src.save();

    const doc: DocumentSession = {
      id: 'rot-export-doc',
      name: 'rot.pdf',
      fileData: bytes,
      pageCount: 2,
      pages: [makePage(0), makePage(1)],
      bookmarks: [],
      annotations: {},
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);
    store.pageRotations[0] = 90;
    store.pageRotations[1] = 270;

    // Disk export (default bakePageRotations: true) bakes 90° and 270° into PDF /Rotate
    const diskBytes = await pdfExporter.exportPDF({ flatten: false, dpi: 150 });
    const loadedDisk = await PDFDocument.load(diskBytes);
    expect(loadedDisk.getPage(0).getRotation().angle).toBe(90);
    expect(loadedDisk.getPage(1).getRotation().angle).toBe(270);

    // Session export (bakePageRotations: false) leaves PDF /Rotate at 0° so active session doesn't double-rotate
    const sessionBytes = await pdfExporter.exportPDF({
      flatten: false,
      dpi: 150,
      bakePageRotations: false
    });
    const loadedSession = await PDFDocument.load(sessionBytes);
    expect(loadedSession.getPage(0).getRotation().angle).toBe(0);
    expect(loadedSession.getPage(1).getRotation().angle).toBe(0);
  });

  it('2. Makes page rotations undoable via pageActions.rotatePages and marks document modified', async () => {
    const doc: DocumentSession = {
      id: 'rot-undo-doc',
      name: 'undo-rot.pdf',
      pageCount: 2,
      pages: [makePage(0), makePage(1)],
      bookmarks: [],
      annotations: {},
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);

    await pageActions.rotatePages([0], 90);
    expect(store.pageRotations[0]).toBe(90);
    expect(doc.lastModifiedAt).toBeGreaterThan(1000);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(store.pageRotations[0] || 0).toBe(0);

    history.redo();
    expect(store.pageRotations[0]).toBe(90);
  });

  it('3. Preserves exact ink stroke coordinates on cropped pages (non-zero CropBox origin)', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    // Crop 50pt from left, 100pt from bottom -> visible box is (50, 100) with size 500x600
    page.setCropBox(50, 100, 500, 600);

    const stroke: PenAnnotation = {
      id: 'cropped-ink-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      box: { x: 20, y: 30, width: 80, height: 60 },
      points: [
        { x: 20, y: 30, pressure: 0.6 },
        { x: 100, y: 90, pressure: 0.8 }
      ],
      color: '#ef4444',
      strokeWidth: 4,
      opacity: 0.9,
      createdAt: 1000,
      updatedAt: 1000
    };

    syncNativeInkAnnotations(pdfDoc, { 0: [stroke] });
    const savedBytes = await pdfDoc.save();

    const reopened = await PDFDocument.load(savedBytes);
    const annots = reopened.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1);
    const inkDict = annots.lookup(0, PDFDict);
    const inkList = inkDict.lookup(PDFName.of('InkList'), PDFArray).lookup(0, PDFArray);
    const coords = Array.from({ length: inkList.size() }, (_, idx) => inkList.lookup(idx, PDFNumber).asNumber());
    // boxX=50, boxY=100, pageHeight=600 -> (50+20, 100+(600-30)) = (70, 670), (50+100, 100+(600-90)) = (150, 610)
    expect(coords).toEqual([70, 670, 150, 610]);
  });

  it('4. Remaps and snapshots userBookmarks across page deletions and undo/redo', () => {
    const doc: DocumentSession = {
      id: 'bm-doc',
      name: 'bookmarks.pdf',
      pageCount: 3,
      pages: [makePage(0), makePage(1), makePage(2)],
      bookmarks: [],
      userBookmarks: [
        { id: 'ub-1', title: 'Intro', pageIndex: 0, createdAt: 100 },
        { id: 'ub-2', title: 'Deleted Chapter', pageIndex: 1, createdAt: 200 },
        { id: 'ub-3', title: 'Conclusion', pageIndex: 2, createdAt: 300 }
      ],
      annotations: {},
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };

    const rotations: Record<number, number> = {};
    const snapshotBefore = capturePageSnapshot(doc, rotations, { omitBytes: true });

    // Delete page 1 (middle page); remaining pages are [0, 2] -> mapped to [0, 1]
    applyRecordMap(doc, rotations, buildIndexMap([0, 2]));
    expect(doc.userBookmarks?.map(b => ({ id: b.id, pageIndex: b.pageIndex }))).toEqual([
      { id: 'ub-1', pageIndex: 0 },
      { id: 'ub-3', pageIndex: 1 }
    ]);

    // Restore snapshot (undo) brings back all 3 user bookmarks at their original indices
    applyPageSnapshot(doc, rotations, snapshotBefore);
    expect(doc.userBookmarks?.map(b => ({ id: b.id, pageIndex: b.pageIndex }))).toEqual([
      { id: 'ub-1', pageIndex: 0 },
      { id: 'ub-2', pageIndex: 1 },
      { id: 'ub-3', pageIndex: 2 }
    ]);
  });

  it('5. Computes rotation-aware visualOffsets when resetting crop on a 90°-rotated page', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    page.setRotation(degrees(90));
    const initialBytes = await pdfDoc.save();

    // Crop the 90°-rotated page: visual top=10, right=20, bottom=30, left=40
    const cropped = await cropPdfPages(initialBytes, [0], { top: 10, right: 20, bottom: 30, left: 40 }, {});
    expect(cropped.visualOffsets[0]).toEqual({ dx: 40, dy: 10 });

    const uncropped = await resetPdfPageCrops(cropped.bytes, [0], {});
    // resetPageCrops applies offsetAnnotation(ann, -offset.dx, -offset.dy), so visualOffsets is (-40, -10)
    expect(uncropped.visualOffsets[0]).toEqual({ dx: -40, dy: -10 });
  });

  it('6. Batches multi-annotation property edits per page and deletes across pages cleanly', () => {
    const rect1: ShapeAnnotation = {
      id: 'rect-p0-a',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'rectangle',
      box: { x: 10, y: 10, width: 50, height: 50 },
      strokeColor: '#000000',
      fillColor: 'transparent',
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 100,
      updatedAt: 100
    };
    const rect2: ShapeAnnotation = {
      id: 'rect-p0-b',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'rectangle',
      box: { x: 80, y: 10, width: 50, height: 50 },
      strokeColor: '#000000',
      fillColor: 'transparent',
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 100,
      updatedAt: 100
    };
    const rectPage1: ShapeAnnotation = {
      id: 'rect-p1-a',
      pageIndex: 1,
      layerId: 'layer-default',
      type: 'rectangle',
      box: { x: 20, y: 20, width: 40, height: 40 },
      strokeColor: '#000000',
      fillColor: 'transparent',
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 100,
      updatedAt: 100
    };

    const doc: DocumentSession = {
      id: 'props-doc',
      name: 'props.pdf',
      pageCount: 2,
      pages: [makePage(0), makePage(1)],
      bookmarks: [],
      annotations: { 0: [rect1, rect2], 1: [rectPage1] },
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);

    // Execute BulkModifyCommand for both annotations on page 0
    history.execute(new BulkModifyCommand(0, [
      { prev: { ...rect1 }, next: { ...rect1, strokeColor: '#ef4444' } },
      { prev: { ...rect2 }, next: { ...rect2, strokeColor: '#ef4444' } }
    ]));

    expect((doc.annotations[0][0] as ShapeAnnotation).strokeColor).toBe('#ef4444');
    expect((doc.annotations[0][1] as ShapeAnnotation).strokeColor).toBe('#ef4444');

    // A single undo restores both annotations on page 0 simultaneously
    history.undo();
    expect((doc.annotations[0][0] as ShapeAnnotation).strokeColor).toBe('#000000');
    expect((doc.annotations[0][1] as ShapeAnnotation).strokeColor).toBe('#000000');

    // Multi-page delete grouped by pageIndex removes items from both page 0 and page 1
    history.execute(new DeleteAnnotationsCommand(0, [rect1]));
    history.execute(new DeleteAnnotationsCommand(1, [rectPage1]));
    expect(doc.annotations[0].map(a => a.id)).toEqual(['rect-p0-b']);
    expect(doc.annotations[1].length).toBe(0);
  });

  it('7. Computes rotation-aware page dimensions for clipboard image paste and bilingual tr() strings', () => {
    const pageMeta = makePage(0);
    const size90 = rotatedPageSize(pageMeta, 90);
    expect(size90).toEqual({ width: 800, height: 600 });

    store.updateAppSettings({ language: 'fa' });
    expect(tr('Save cancelled', 'ذخیره‌سازی لغو شد')).toBe('ذخیره‌سازی لغو شد');
    store.updateAppSettings({ language: 'en' });
    expect(tr('Save cancelled', 'ذخیره‌سازی لغو شد')).toBe('Save cancelled');
  });
});
