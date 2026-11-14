import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { buildZipArchive } from '../src/io/zip';
import { encryptAndSavePdfDocument } from '../src/core/pdf-encrypt';
import { applyFormValuesToPdfLibDoc } from '../src/core/pdf-forms-writer';
import {
  computeConvexHull,
  doesAnnotationCoverBox,
  selectionManager
} from '../src/annotations/selection';
import {
  parsePrintPageRange,
  groupPagesIntoSheets,
  pdfBytesMayBeEncrypted,
  isPdfPasswordError,
  buildPrintPageCss
} from '../src/core/print-utils';
import { shouldAutoOpenPdfUrl } from '../src/background/service-worker';
import type { Annotation } from '../src/core/types';

test('buildZipArchive produces valid PK headers, entry names, and EOCD count', () => {
  const page1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const page2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8, 9]);
  const archive = buildZipArchive([
    { name: 'doc-page-001.png', data: page1 },
    { name: 'doc-page-002.png', data: page2 }
  ]);

  // Starts with Local File Header signature PK\x03\x04
  assert.equal(archive[0], 0x50);
  assert.equal(archive[1], 0x4b);
  assert.equal(archive[2], 0x03);
  assert.equal(archive[3], 0x04);

  // Ends with End of Central Directory signature PK\x05\x06 at tail - 22 (zero comment)
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = archive.byteLength - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 8, true), 2);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2);

  // Entry filenames appear inside the archive
  const text = new TextDecoder('latin1').decode(archive);
  assert.ok(text.includes('doc-page-001.png'));
  assert.ok(text.includes('doc-page-002.png'));
});

test('encryptAndSavePdfDocument produces a real RC4-128 PDF verifiable by pdfjs-dist', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 400]);
  page.drawText('Secret veditor verification text', { x: 40, y: 340, size: 16 });

  const encryptedBytes = await encryptAndSavePdfDocument(pdfDoc, 'MySecret!123');
  const header = new TextDecoder('latin1').decode(encryptedBytes.slice(0, 8));
  assert.ok(header.startsWith('%PDF-'));

  // 1. Opening without password must fail with PasswordException
  await assert.rejects(
    async () => {
      const task = pdfjsLib.getDocument({ data: encryptedBytes.slice() });
      await task.promise;
    },
    (err: any) => err?.name === 'PasswordException' && err?.code === 1
  );

  // 2. Opening with wrong password must fail with NEED_PASSWORD / INCORRECT_PASSWORD
  await assert.rejects(
    async () => {
      const task = pdfjsLib.getDocument({ data: encryptedBytes.slice(), password: 'wrong-password' });
      await task.promise;
    },
    (err: any) => err?.name === 'PasswordException' && err?.code === 2
  );

  // 3. Opening with the right password must succeed and preserve page text
  const okTask = pdfjsLib.getDocument({ data: encryptedBytes.slice(), password: 'MySecret!123' });
  const loaded = await okTask.promise;
  assert.equal(loaded.numPages, 1);
  const loadedPage = await loaded.getPage(1);
  const txt = await loadedPage.getTextContent();
  const joined = txt.items.map((it: any) => it.str || '').join(' ');
  assert.ok(joined.includes('Secret veditor verification text'));
  await okTask.destroy();
});

test('applyFormValuesToPdfLibDoc writes text, checkbox, radio group, and dropdown cleanly', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  const textField = form.createTextField('applicant.name');
  textField.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });

  const checkField = form.createCheckBox('applicant.agree');
  checkField.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });

  const radioGroup = form.createRadioGroup('applicant.plan');
  radioGroup.addOptionToPage('pro', page, { x: 50, y: 600, width: 18, height: 18 });
  radioGroup.addOptionToPage('free', page, { x: 90, y: 600, width: 18, height: 18 });

  const dropdown = form.createDropdown('applicant.country');
  dropdown.addOptions(['US', 'DE', 'IR']);
  dropdown.addToPage(page, { x: 50, y: 550, width: 150, height: 24 });

  applyFormValuesToPdfLibDoc(doc, {
    'applicant.name': 'Aria Ahmadi',
    'applicant.agree': true,
    'applicant.plan': 'pro',
    'applicant.country': 'IR'
  });

  const savedBytes = await doc.save();
  const reopened = await PDFDocument.load(savedBytes);
  const rForm = reopened.getForm();

  assert.equal(rForm.getTextField('applicant.name').getText(), 'Aria Ahmadi');
  assert.equal(rForm.getCheckBox('applicant.agree').isChecked(), true);
  assert.equal(rForm.getRadioGroup('applicant.plan').getSelected(), 'pro');
  assert.deepEqual(rForm.getDropdown('applicant.country').getSelected(), ['IR']);

  // Also test unchecking & changing option
  applyFormValuesToPdfLibDoc(reopened, {
    'applicant.agree': false,
    'applicant.plan': 'free'
  });
  assert.equal(rForm.getCheckBox('applicant.agree').isChecked(), false);
  assert.equal(rForm.getRadioGroup('applicant.plan').getSelected(), 'free');
});

test('Selection contour hit-testing, ellipse math, and link coverage blocking', () => {
  const now = Date.now();
  // Diagonal ink stroke from (10,10) to (110,110): empty corners (10,110) and (110,10) MUST miss!
  const diagonalPen: Annotation = {
    id: 'pen-1',
    type: 'pen',
    pageIndex: 0,
    layerId: 'layer-default',
    color: '#ef4444',
    opacity: 1,
    strokeWidth: 4,
    points: [
      { x: 10, y: 10, pressure: 0.5 },
      { x: 60, y: 60, pressure: 0.5 },
      { x: 110, y: 110, pressure: 0.5 }
    ],
    box: { x: 8, y: 8, width: 104, height: 104 },
    createdAt: now,
    updatedAt: now
  };

  assert.ok(selectionManager.findAnnotationAtPoint({ x: 60, y: 60 }, [diagonalPen]));
  assert.equal(selectionManager.findAnnotationAtPoint({ x: 10, y: 110 }, [diagonalPen]), null);
  assert.equal(selectionManager.findAnnotationAtPoint({ x: 110, y: 10 }, [diagonalPen]), null);

  // Diagonal pen covers a link centered near (60,60), does NOT cover a link sitting in empty top-right corner (95,10)
  assert.equal(doesAnnotationCoverBox(diagonalPen, { x: 52, y: 52, width: 16, height: 16 }), true);
  assert.equal(doesAnnotationCoverBox(diagonalPen, { x: 96, y: 10, width: 12, height: 12 }), false);

  // Ellipse hit-test excludes bounding box corner (102, 102) on a 100x100 circle at (100,100)
  const circle: Annotation = {
    id: 'ell-1',
    type: 'ellipse',
    pageIndex: 0,
    layerId: 'layer-default',
    strokeColor: '#3b82f6',
    fillColor: 'transparent',
    strokeStyle: 'solid',
    outline: true,
    opacity: 1,
    strokeWidth: 2,
    box: { x: 100, y: 100, width: 100, height: 100 },
    createdAt: now,
    updatedAt: now
  };
  assert.ok(selectionManager.findAnnotationAtPoint({ x: 150, y: 150 }, [circle]));
  assert.equal(selectionManager.findAnnotationAtPoint({ x: 102, y: 102 }, [circle]), null);

  // Convex hull ignores collinear interior point
  const hull = computeConvexHull([
    { x: 0, y: 0 },
    { x: 50, y: 50 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ]);
  assert.equal(hull.length, 4);
});

test('Print Preview Studio helpers parse page ranges and group sheets correctly', () => {
  assert.deepEqual(parsePrintPageRange('1-3, 5, 3, 99', 6), [0, 1, 2, 4]);
  assert.deepEqual(parsePrintPageRange('4-2', 6), [1, 2, 3]);
  assert.deepEqual(parsePrintPageRange('invalid', 6), []);

  assert.deepEqual(groupPagesIntoSheets([0, 1, 2], 1), [[0], [1], [2]]);
  assert.deepEqual(groupPagesIntoSheets([0, 1, 2], 2), [[0, 1], [2]]);
  assert.deepEqual(groupPagesIntoSheets([0, 1, 2, 3, 4], 4), [[0, 1, 2, 3], [4]]);
});

test('shouldAutoOpenPdfUrl only intercepts web http(s) PDF URLs when enabled', () => {
  assert.equal(shouldAutoOpenPdfUrl('https://example.com/paper.pdf', true), true);
  assert.equal(shouldAutoOpenPdfUrl('http://example.com/PAPER.PDF?download=1#page=2', true), true);
  assert.equal(shouldAutoOpenPdfUrl('https://example.com/paper.pdf', false), false);
  assert.equal(shouldAutoOpenPdfUrl('https://example.com/index.html', true), false);
  assert.equal(shouldAutoOpenPdfUrl('chrome-extension://abcdef/index.html?pdfUrl=a.pdf', true), false);
  assert.equal(shouldAutoOpenPdfUrl('blob:https://example.com/1234.pdf', true), false);
});

test('MeasureTool stays multi-point active between clicks and computes angle & area accurately', async () => {
  const { MeasureTool } = await import('../src/annotations/tools/measure');
  const mt = new MeasureTool();

  // 3-point angle: stays active after point 1 and point 2, finishes on point 3
  mt.start({ x: 100, y: 0 }, 0, 'measure-angle', 'pt', 1);
  assert.equal(mt.isMultiPointActive(), true);
  assert.equal(mt.pointCount, 1);

  const completed2 = mt.addPoint({ x: 0, y: 0 });
  assert.equal(completed2, false);
  assert.equal(mt.isMultiPointActive(), true);
  assert.equal(mt.pointCount, 2);

  mt.move({ x: 0, y: 100 });
  const completed3 = mt.addPoint({ x: 0, y: 100 });
  assert.equal(completed3, true);
  const angleAnn = mt.finish('layer-default');
  assert.ok(angleAnn);
  assert.equal(angleAnn.type, 'measure-angle');
  assert.ok(Math.abs(angleAnn.measuredValue - 90) < 0.01);
  assert.equal(angleAnn.label, '90.0°');
  assert.equal(mt.isMultiPointActive(), false);

  // Polygon area: closes when clicking near start vertex after >= 3 points
  mt.start({ x: 0, y: 0 }, 0, 'measure-area', 'pt', 1);
  assert.equal(mt.addPoint({ x: 100, y: 0 }), false);
  assert.equal(mt.addPoint({ x: 100, y: 50 }), false);
  assert.equal(mt.addPoint({ x: 0, y: 50 }), false);
  assert.equal(mt.isMultiPointActive(), true);
  assert.equal(mt.addPoint({ x: 2, y: 2 }), true);
  const areaAnn = mt.finish('layer-default');
  assert.ok(areaAnn);
  assert.equal(areaAnn.type, 'measure-area');
  assert.ok(Math.abs(areaAnn.measuredValue - 5000) < 1);
  assert.equal(mt.isMultiPointActive(), false);
});

test('extensionApi.storage persists boolean toggle values via localStorage outside extension runtime', async () => {
  const mem = new Map<string, string>();
  const prevStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }
  };
  try {
    const { extensionApi } = await import('../src/utils/browser-compat');
    await extensionApi.storage.set({ veditor_auto_open_pdfs: true });
    const res1 = await extensionApi.storage.get(['veditor_auto_open_pdfs']);
    assert.equal(res1.veditor_auto_open_pdfs, true);
    await extensionApi.storage.set({ veditor_auto_open_pdfs: false });
    const res2 = await extensionApi.storage.get(['veditor_auto_open_pdfs']);
    assert.equal(res2.veditor_auto_open_pdfs, false);
  } finally {
    (globalThis as any).localStorage = prevStorage;
  }
});

test('pdfBytesMayBeEncrypted, isPdfPasswordError, and buildPrintPageCss behave deterministically', async () => {
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([300, 400]);
  const plainBytes = new Uint8Array(await plainDoc.save());
  assert.equal(pdfBytesMayBeEncrypted(plainBytes), false);

  const encDoc = await PDFDocument.create();
  encDoc.addPage([300, 400]);
  const encBytes = await encryptAndSavePdfDocument(encDoc, 'pass123');
  assert.equal(pdfBytesMayBeEncrypted(encBytes), true);

  assert.equal(isPdfPasswordError({ name: 'PasswordException', code: 1 }), true);
  assert.equal(isPdfPasswordError({ code: 2 }), true);
  assert.equal(isPdfPasswordError(new Error('Incorrect password')), true);
  assert.equal(isPdfPasswordError(new Error('Invalid XRef table')), false);

  const cssLandDark = buildPrintPageCss(true, true);
  assert.ok(cssLandDark.includes('size: landscape;'));
  assert.ok(cssLandDark.includes('#111318'));
  const cssPortLight = buildPrintPageCss(false, false);
  assert.ok(cssPortLight.includes('size: portrait;'));
  assert.ok(cssPortLight.includes('#ffffff'));
});
