import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  resolveWebPdfUrl,
  extractCleanPdfFilename,
  isLikelyWebPdfUrl,
  normalizePdfBytes,
  uint8ArrayToBase64,
  base64ToUint8Array
} from '../../utils/pdf-url';
import {
  isolatePageContentStream,
  flattenVectorAnnotationsToPage,
  getPageBoxMetrics,
  resolveSafeRasterScale,
  MAX_FLATTEN_CANVAS_DIM
} from '../pdf-flatten';
import { syncNativeInkAnnotations } from '../native-ink';
import { eraseStickyNoteContent, stickyNoteTool } from '../../annotations/tools/sticky-note';
import type { PenAnnotation } from '../types';

test('resolveWebPdfUrl unwraps viewer wrappers and normalizePdfBytes strips leading BOM', () => {
  assert.equal(
    resolveWebPdfUrl('chrome-extension://abc/index.html?file=https%3A%2F%2Fexample.com%2Ftest.pdf'),
    'https://example.com/test.pdf'
  );
  assert.equal(extractCleanPdfFilename('https://arxiv.org/pdf/2501.00001'), '2501.00001.pdf');
  assert.equal(isLikelyWebPdfUrl('https://arxiv.org/pdf/2501.00001'), true);

  const prefixed = new Uint8Array([0xef, 0xbb, 0xbf, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const norm = normalizePdfBytes(prefixed);
  assert.ok(norm);
  assert.equal(norm[0], 0x25);
  assert.deepEqual(Array.from(base64ToUint8Array(uint8ArrayToBase64(norm))), Array.from(norm));
});

test('vector flatten produces reloadable PDF across 90-degree rotated page and clamps huge raster scales', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 800]);
  page.setRotation(degrees(90));
  page.drawRectangle({ x: 10, y: 10, width: 40, height: 40 });
  isolatePageContentStream(pdfDoc, page);
  const metrics = getPageBoxMetrics(page);
  const pen: PenAnnotation = {
    id: 'p_rot',
    pageIndex: 0,
    layerId: 'layer-default',
    type: 'pen',
    color: '#ef4444',
    strokeWidth: 3,
    points: [
      { x: 20, y: 30, pressure: 0.5 },
      { x: 120, y: 140, pressure: 0.7 }
    ],
    box: { x: 20, y: 30, width: 100, height: 110 },
    opacity: 1,
    createdAt: 1,
    updatedAt: 1
  };
  assert.equal(flattenVectorAnnotationsToPage(pdfDoc, page, [pen], metrics), true);
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
  assert.equal(reloaded.getPage(0).getRotation().angle, 90);

  const clampedScale = resolveSafeRasterScale(4000, 4000, 8);
  assert.ok(4000 * clampedScale <= MAX_FLATTEN_CANVAS_DIM + 1);
});

test('syncNativeInkAnnotations skips unchanged strokes via /VEditorInkHash', async () => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([600, 800]);
  const pen: PenAnnotation = {
    id: 'ink_1',
    pageIndex: 0,
    layerId: 'layer-default',
    type: 'pen',
    color: '#000000',
    strokeWidth: 2,
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 80, y: 60, pressure: 0.5 }],
    box: { x: 10, y: 10, width: 70, height: 50 },
    opacity: 1,
    createdAt: 1,
    updatedAt: 1
  };
  assert.equal(syncNativeInkAnnotations(pdfDoc, { 0: [pen] }), true);
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(syncNativeInkAnnotations(reloaded, { 0: [pen] }), false);
});

test('eraseStickyNoteContent splits strokes in pixel mode and skips untouched strokes cleanly', () => {
  const note = stickyNoteTool.createStickyNote(0, 'layer-default', { x: 0, y: 0, width: 200, height: 200 }, '', {
    strokes: [
      {
        id: 's1',
        tool: 'pen',
        color: '#000',
        strokeWidth: 2,
        points: [
          { x: 20, y: 100, pressure: 0.5 },
          { x: 40, y: 100, pressure: 0.5 },
          { x: 60, y: 100, pressure: 0.5 },
          { x: 80, y: 100, pressure: 0.5 },
          { x: 100, y: 100, pressure: 0.5 },
          { x: 120, y: 100, pressure: 0.5 }
        ]
      }
    ]
  });
  const miss = eraseStickyNoteContent(note, [{ x: 180, y: 180 }], 8, 'pixel');
  assert.equal(miss.modified, false);

  const split = eraseStickyNoteContent(note, [{ x: 70, y: 100 }], 12, 'pixel');
  assert.equal(split.modified, true);
  assert.equal(split.strokes.length, 2);
});
