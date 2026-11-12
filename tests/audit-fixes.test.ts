import { describe, it, expect, beforeEach } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, degrees } from 'pdf-lib';
import { store } from '../src/core/store';
import { history, BulkModifyCommand, DeleteAnnotationsCommand } from '../src/core/history';
import { pdfExporter } from '../src/io/export-pdf';
import { dataExporter } from '../src/io/export-data';
import { pdfEngine } from '../src/core/pdf-engine';
import { pageActions } from '../src/core/page-actions';
import { syncNativeInkAnnotations, extractNativeInkMetaMap } from '../src/core/native-ink';
import { syncNativeAnnotations, importNativeAnnotations } from '../src/core/native-annotations';
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
import { computeArrowHeadGeometry } from '../src/utils/geometry';
import { fitStroke } from '../src/utils/shape-fit';
import {
  selectionManager,
  computeShapeHandleMetrics,
  computeHandleLoupePlacement,
  resolveDraggedHandleTargetPoint
} from '../src/annotations/selection';
import type {
  DocumentSession,
  HighlighterAnnotation,
  MeasurementAnnotation,
  PageInfo,
  PenAnnotation,
  ShapeAnnotation,
  SignatureAnnotation,
  StampAnnotation,
  StickyNoteAnnotation
} from '../src/core/types';

function decodeApStream(annotDict: PDFDict): string {
  const ap = annotDict.lookup(PDFName.of('AP'), PDFDict);
  const raw = ap.context.lookup(ap.get(PDFName.of('N'))) as PDFRawStream;
  try {
    return new TextDecoder().decode(decodePDFRawStream(raw).decode());
  } catch {
    return new TextDecoder().decode(raw.contents);
  }
}

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

  it('8. Preserves ShapeAnnotation fillOpacity in PDF /ca, /AP ExtGState, and round-trip parsing', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);

    const semiFilledRect: ShapeAnnotation = {
      id: 'fill-op-rect',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'rectangle',
      box: { x: 40, y: 50, width: 140, height: 90 },
      strokeColor: '#1d4ed8',
      fillColor: '#3b82f6',
      fillOpacity: 0.35,
      strokeWidth: 3,
      outline: true,
      strokeStyle: 'solid',
      cornerRadius: 12,
      opacity: 0.9,
      createdAt: 1000,
      updatedAt: 1000
    };

    await syncNativeAnnotations(pdfDoc, { 0: [semiFilledRect] });
    const savedBytes = await pdfDoc.save();

    const loaded = await PDFDocument.load(savedBytes);
    const annotDict = loaded.getPage(0).node.Annots()!.lookup(0, PDFDict);
    expect(annotDict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBeCloseTo(0.9, 2);
    // PDF /ca is effective non-stroking alpha = opacity (0.9) * fillOpacity (0.35) = 0.315
    expect(annotDict.lookupMaybe(PDFName.of('ca'), PDFNumber)?.asNumber()).toBeCloseTo(0.315, 2);

    const extracted = importNativeAnnotations(loaded);
    expect(extracted.length).toBe(1);
    const restored = extracted[0].annotation as ShapeAnnotation;
    expect(restored.fillColor).toBe('#3b82f6');
    expect(restored.fillOpacity).toBeCloseTo(0.35, 2);
    expect(restored.opacity).toBeCloseTo(0.9, 2);
  });

  it('9. Applies cornerRadius cubic Beziers and closes freeform-shape on export and round-trip', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);

    const freeformShape: ShapeAnnotation = {
      id: 'freeform-rounded',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'freeform-shape',
      box: { x: 20, y: 20, width: 100, height: 100 },
      points: [
        { x: 20, y: 20 },
        { x: 120, y: 20 },
        { x: 70, y: 120 }
      ],
      strokeColor: '#10b981',
      fillColor: '#34d399',
      fillOpacity: 0.4,
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      cornerRadius: 16,
      opacity: 1,
      createdAt: 1000,
      updatedAt: 1000
    };

    await syncNativeAnnotations(pdfDoc, { 0: [freeformShape] });
    const savedBytes = await pdfDoc.save();

    const loaded = await PDFDocument.load(savedBytes);
    const annotDict = loaded.getPage(0).node.Annots()!.lookup(0, PDFDict);
    const content = decodeApStream(annotDict);
    // Cubic Bezier curve operator 'c' for rounded vertices + closed path 'h' + fill/stroke 'B'
    expect(content).toContain(' c\n');
    expect(content).toContain('\nh\nB');
  });

  it('10. Preserves custom highlighter opacity and chisel tip shape in native /Ink annotations', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);

    const hl: HighlighterAnnotation = {
      id: 'chisel-hl',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'highlighter',
      box: { x: 30, y: 100, width: 200, height: 24 },
      points: [
        { x: 30, y: 112, pressure: 0.5 },
        { x: 230, y: 112, pressure: 0.5 }
      ],
      color: '#fde047',
      strokeWidth: 20,
      opacity: 0.18,
      tipShape: 'chisel',
      blendMode: 'multiply',
      createdAt: 1000,
      updatedAt: 1000
    };

    syncNativeInkAnnotations(pdfDoc, { 0: [hl] });
    const savedBytes = await pdfDoc.save();

    const loaded = await PDFDocument.load(savedBytes);
    const inkDict = loaded.getPage(0).node.Annots()!.lookup(0, PDFDict);
    expect(inkDict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBeCloseTo(0.18, 2);

    const streamText = decodeApStream(inkDict);
    expect(streamText).toContain('0 J\n0 j');

    const metaMap = extractNativeInkMetaMap(loaded);
    expect(metaMap.get('chisel-hl')?.opacity).toBeCloseTo(0.18, 2);
    expect(metaMap.get('chisel-hl')?.tipShape).toBe('chisel');
  });

  it('11. Renders preset stamps with valid PDF text operators and sticky notes with custom icon size and embedded items', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);

    const presetStamp: StampAnnotation = {
      id: 'stamp-approved-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'stamp',
      stampType: 'preset',
      presetKey: 'APPROVED',
      color: '#16a34a',
      box: { x: 100, y: 100, width: 160, height: 54 },
      opacity: 0.95,
      createdAt: 1000,
      updatedAt: 1000
    };

    const expandedNote: StickyNoteAnnotation = {
      id: 'sticky-expanded-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'sticky-note',
      box: { x: 50, y: 200, width: 220, height: 180 },
      iconWidth: 48,
      iconHeight: 48,
      text: 'First bullet line\nSecond bullet line',
      listStyle: 'bullet',
      color: '#fef08a',
      textColor: '#3b2f1e',
      fontSize: 14,
      fontFamily: 'Helvetica',
      textAlign: 'left',
      author: 'VEditor User',
      collapsed: false,
      strokes: [],
      items: [
        {
          id: 'inner-rect',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'rectangle',
          box: { x: 20, y: 90, width: 80, height: 40 },
          strokeColor: '#ef4444',
          fillColor: '#fca5a5',
          fillOpacity: 0.5,
          strokeWidth: 2,
          outline: true,
          strokeStyle: 'solid',
          opacity: 1,
          createdAt: 1000,
          updatedAt: 1000
        }
      ],
      opacity: 1,
      createdAt: 1000,
      updatedAt: 1000
    };

    await syncNativeAnnotations(pdfDoc, { 0: [presetStamp, expandedNote] });
    const savedBytes = await pdfDoc.save();

    const loaded = await PDFDocument.load(savedBytes);
    const annots = loaded.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(2);

    const stampOps = decodeApStream(annots.lookup(0, PDFDict));
    expect(stampOps).toContain('BT\n');
    expect(stampOps).toContain('ET');
    // Must not have corrupt nested BT without ET
    expect(stampOps.split('BT').length - 1).toBe(1);

    const extracted = importNativeAnnotations(loaded);
    expect(extracted.map((e: { annotation: { id: string } }) => e.annotation.id)).toEqual(['stamp-approved-1', 'sticky-expanded-1']);
    const restoredNote = extracted[1].annotation as StickyNoteAnnotation;
    expect(restoredNote.listStyle).toBe('bullet');
    expect(restoredNote.items?.length).toBe(1);
    expect(restoredNote.iconWidth).toBe(48);
  });

  it('12. Supports Bookmark Notes and full Save -> Re-open round-trip for userBookmarks and composite annotations', async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    src.addPage([600, 800]);
    const baseBytes = await src.save();

    const sig: SignatureAnnotation = {
      id: 'sig-rt-1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'signature',
      box: { x: 100, y: 500, width: 180, height: 60 },
      points: [
        [
          { x: 105, y: 530, pressure: 0.6 },
          { x: 250, y: 525, pressure: 0.8 }
        ]
      ],
      color: '#1e293b',
      opacity: 1,
      createdAt: 1000,
      updatedAt: 1000
    };

    const measure: MeasurementAnnotation = {
      id: 'measure-rt-1',
      pageIndex: 1,
      layerId: 'layer-default',
      type: 'measure-distance',
      box: { x: 50, y: 100, width: 120, height: 20 },
      points: [
        { x: 50, y: 110 },
        { x: 170, y: 110 }
      ],
      color: '#e11d48',
      strokeWidth: 2,
      scaleRatio: 1,
      unit: 'mm',
      measuredValue: 120,
      label: '120 mm',
      opacity: 1,
      createdAt: 1000,
      updatedAt: 1000
    };

    const doc: DocumentSession = {
      id: 'roundtrip-doc',
      name: 'roundtrip.pdf',
      fileData: baseBytes,
      pageCount: 2,
      pages: [makePage(0), makePage(1)],
      bookmarks: [],
      userBookmarks: [],
      annotations: { 0: [sig], 1: [measure] },
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);

    // Add bookmark with note, then update its note
    store.addUserBookmark(1, 'Key Formula', 'Review before exam');
    expect(doc.userBookmarks?.length).toBe(1);
    expect(doc.userBookmarks?.[0].note).toBe('Review before exam');

    const bmId = doc.userBookmarks![0].id;
    store.updateUserBookmark(bmId, { title: 'Key Formula (Updated)', note: 'Derive equation 4.2' });
    expect(doc.userBookmarks?.[0].title).toBe('Key Formula (Updated)');
    expect(doc.userBookmarks?.[0].note).toBe('Derive equation 4.2');

    // Export PDF (unflattened Save)
    const exportedBytes = await pdfExporter.exportPDF({
      flatten: false,
      dpi: 150,
      embedCompositeAnnotations: true
    });

    // Re-extract annotations and userBookmarks from the saved PDF bytes
    const restoredAnnotations = await pdfEngine.extractNativeAnnotations(exportedBytes);
    const restoredBookmarks = pdfEngine.getLastExtractedUserBookmarks();

    expect(restoredBookmarks.length).toBe(1);
    expect(restoredBookmarks[0].pageIndex).toBe(1);
    expect(restoredBookmarks[0].title).toBe('Key Formula (Updated)');
    expect(restoredBookmarks[0].note).toBe('Derive equation 4.2');

    const restoredIds = restoredAnnotations.map(r => r.annotation.id);
    expect(restoredIds).toContain('sig-rt-1');
    expect(restoredIds).toContain('measure-rt-1');
  });

  it('13. Includes fillOpacity, interior-color, highlighter, polygon, stamp, and userBookmarks in XFDF and JSON exports', () => {
    const poly: ShapeAnnotation = {
      id: 'xfdf-poly',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'polygon',
      box: { x: 10, y: 20, width: 100, height: 80 },
      points: [
        { x: 10, y: 20 },
        { x: 110, y: 20 },
        { x: 60, y: 100 }
      ],
      strokeColor: '#2563eb',
      fillColor: '#60a5fa',
      fillOpacity: 0.45,
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 0.85,
      createdAt: 1000,
      updatedAt: 1000
    };

    const doc: DocumentSession = {
      id: 'xfdf-doc',
      name: 'xfdf.pdf',
      pageCount: 1,
      pages: [makePage(0)],
      bookmarks: [],
      userBookmarks: [{ id: 'bm-1', title: 'Page 1 Note', note: 'Important!', pageIndex: 0, createdAt: 1000 }],
      annotations: { 0: [poly] },
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);

    const jsonStr = dataExporter.exportToJSON();
    const parsedJson = JSON.parse(jsonStr);
    expect(parsedJson.userBookmarks.length).toBe(1);
    expect(parsedJson.userBookmarks[0].note).toBe('Important!');
    expect(parsedJson.annotations[0][0].fillOpacity).toBe(0.45);

    const xfdfStr = dataExporter.exportToXFDF();
    expect(xfdfStr).toContain('<polygon ');
    expect(xfdfStr).toContain('interior-color="#60a5fa"');
    // Effective XFDF opacity = 0.85 * 0.45 = 0.3825 -> "0.38"
    expect(xfdfStr).toContain('opacity="0.38"');
  });

  it('14. Computes sleek, proportional arrowheads for both Arrow tool and draw-and-hold arrows', () => {
    // Normal arrow with strokeWidth = 2: headLen is sleek (~6.2), well below the old 12pt minimum
    const normal = computeArrowHeadGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 2);
    expect(normal.headLen).toBeCloseTo(6.2, 1);
    expect(normal.headLen).toBeLessThan(8);
    // Shaft pulls back inside the arrowhead so the round cap never pokes past the sharp tip
    expect(normal.shaftEnd.x).toBeLessThan(100);
    expect(normal.shaftEnd.x).toBeGreaterThan(94);

    // Short arrow (length = 12pt): headLen clamps to <= 34% of shaft length so it never overwhelms the shaft
    const shortArrow = computeArrowHeadGeometry({ x: 10, y: 10 }, { x: 22, y: 10 }, 4);
    expect(shortArrow.headLen).toBeLessThanOrEqual(12 * 0.34 + 0.01);

    // Draw-and-hold arrow recognition anchors p1 at the true apex (180, 10) rather than the hook barb end (165, 12)
    const strokePts = [];
    for (let i = 0; i < 16; i++) {
      strokePts.push({ x: 10 + (170 * i) / 15, y: 10 });
    }
    strokePts.push({ x: 160, y: 22 }, { x: 150, y: 30 }, { x: 165, y: 12 });
    const fitted = fitStroke(strokePts);
    expect(fitted?.kind).toBe('arrow');
    if (fitted?.kind === 'arrow') {
      expect(fitted.p1.x).toBeCloseTo(180, 1);
      expect(fitted.p1.y).toBeCloseTo(10, 1);
    }
  });

  it('15. Scales shape selection indicator handles proportionally to the drawn shape size', () => {
    const largeMetrics = computeShapeHandleMetrics(
      { x: 0, y: 0, width: 120, height: 90 },
      [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 90 }, { x: 0, y: 90 }],
      true
    );
    const smallMetrics = computeShapeHandleMetrics(
      { x: 0, y: 0, width: 16, height: 16 },
      [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 16 }, { x: 0, y: 16 }],
      true
    );

    expect(smallMetrics.handleRadius).toBeLessThan(largeMetrics.handleRadius * 0.55);
    expect(smallMetrics.outerRadius).toBeLessThan(largeMetrics.outerRadius * 0.55);
    expect(smallMetrics.boxHandleSize).toBeLessThan(largeMetrics.boxHandleSize * 0.6);
    expect(smallMetrics.rotDist).toBeLessThan(largeMetrics.rotDist);
    // Two corner handles on a small 16pt edge never exceed 34% of the edge combined radius
    expect(smallMetrics.handleRadius).toBeLessThanOrEqual(16 * 0.17 + 0.01);

    // Hit-testing on a small 20x20 rectangle allows both corner vertex dragging AND center body moving
    const smallRect: ShapeAnnotation = {
      id: 'small-rect',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'rectangle',
      box: { x: 50, y: 50, width: 20, height: 20 },
      strokeColor: '#ef4444',
      fillColor: 'transparent',
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 100,
      updatedAt: 100
    };
    expect(selectionManager.hitTestSelection({ x: 50, y: 50 }, [smallRect], 1.0)).toBe('vertex:0');
    expect(selectionManager.hitTestSelection({ x: 60, y: 60 }, [smallRect], 1.0)).toBe('body');
  });

  it('16. Computes magnifier loupe placement and resolves exact dragged handle coordinates', () => {
    // Normal mid-page point places the loupe above the pointer
    const midPlacement = computeHandleLoupePlacement({ x: 200, y: 300 }, 612, 792, 1.0);
    expect(midPlacement.placedBelow).toBe(false);
    expect(midPlacement.loupeCenter.y).toBeLessThan(300);
    expect(midPlacement.magnification).toBe(2.5);

    // Point near the top edge of the page flips the loupe below so it never clips off-screen
    const topPlacement = computeHandleLoupePlacement({ x: 200, y: 18 }, 612, 792, 1.0);
    expect(topPlacement.placedBelow).toBe(true);
    expect(topPlacement.loupeCenter.y).toBeGreaterThan(18);

    // Resolves exact vertex and endpoint coordinates for the loupe crosshair
    const poly: ShapeAnnotation = {
      id: 'loupe-poly',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'polygon',
      box: { x: 10, y: 20, width: 100, height: 80 },
      points: [{ x: 10, y: 20 }, { x: 110, y: 25 }, { x: 60, y: 100 }],
      strokeColor: '#4f46e5',
      fillColor: 'transparent',
      strokeWidth: 2,
      outline: true,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 100,
      updatedAt: 100
    };
    expect(resolveDraggedHandleTargetPoint(poly, 'vertex:1', { x: 0, y: 0 })).toEqual({ x: 110, y: 25 });
  });
});
