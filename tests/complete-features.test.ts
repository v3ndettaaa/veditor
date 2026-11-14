import { describe, it, expect, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { store } from '../src/core/store';
import {
  computeAngleDegrees,
  computeMeasurementValue,
  measureTool
} from '../src/annotations/tools/measure';
import { parsePrintPageRange } from '../src/ui/components/print-dialog';
import { replaceFileExtension } from '../src/ui/components/save-as-dialog';
import {
  buildAnnotationsMarkdownSummary,
  describeAnnotationItem
} from '../src/ui/components/side-panels';
import { applyFormValuesToPdfLibDoc } from '../src/core/pdf-forms';
import { dataExporter } from '../src/io/export-data';
import { pdfExporter } from '../src/io/export-pdf';
import { pdfEngine } from '../src/core/pdf-engine';
import type { DocumentSession, PageInfo } from '../src/core/types';

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

describe('Complete Part 1 & Part 2 Features Suite', () => {
  beforeEach(() => {
    store.closeAllDocumentTabs();
    store.updateAppSettings({ language: 'en' });
  });

  it('1. Computes 3-point angles (measure-angle) accurately for 90°, 45°, 180°, and degenerate points', () => {
    // 90 degree right angle at origin (0,0) with arms (100,0) and (0,100)
    expect(computeAngleDegrees({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(90, 5);

    // 45 degree angle at (10,10) with arms (110,10) and (110,110)
    expect(computeAngleDegrees({ x: 110, y: 10 }, { x: 10, y: 10 }, { x: 110, y: 110 })).toBeCloseTo(45, 5);

    // 180 degree straight line at (50,50) with arms (0,50) and (100,50)
    expect(computeAngleDegrees({ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 })).toBeCloseTo(180, 5);

    // Zero / degenerate arm returns 0
    expect(computeAngleDegrees({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 50, y: 50 })).toBe(0);
  });

  it('2. Computes distance, polygon area, and angle values with unit & scale calibration', () => {
    const distRes = computeMeasurementValue(
      'measure-distance',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      'cm',
      0.5
    );
    expect(distRes.measuredValue).toBeCloseTo(50, 4);
    expect(distRes.label).toBe('50.00 cm');

    // 100x100 square with scaleRatio 0.1 = 100 cm^2
    const areaRes = computeMeasurementValue(
      'measure-area',
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 }
      ],
      'cm',
      0.1
    );
    expect(areaRes.measuredValue).toBeCloseTo(100, 3);
    expect(areaRes.label).toBe('100.00 cm²');

    // Angle ignores unit/scale and returns degrees
    const angleRes = computeMeasurementValue(
      'measure-angle',
      [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }],
      'mm',
      50
    );
    expect(angleRes.measuredValue).toBeCloseTo(90, 4);
    expect(angleRes.label).toBe('90.0°');
  });

  it('3. Multi-point measure tool session creates valid measure-angle and measure-area annotations', () => {
    store.updateToolSettings({ measureUnit: 'cm', measureScale: 1 });
    measureTool.start({ x: 100, y: 0 }, 0, 'measure-angle', 'cm', 1);
    expect(measureTool.isMultiPointActive()).toBe(true);
    expect(measureTool.addPoint({ x: 0, y: 0 })).toBe(false);
    expect(measureTool.addPoint({ x: 0, y: 100 })).toBe(true);
    expect(measureTool.pointCount).toBe(3);

    const angleAnn = measureTool.finish('layer-default');
    expect(angleAnn).not.toBeNull();
    expect(angleAnn!.type).toBe('measure-angle');
    expect(angleAnn!.measuredValue).toBeCloseTo(90, 4);
    expect(angleAnn!.label).toBe('90.0°');
    expect(measureTool.isMultiPointActive()).toBe(false);
  });

  it('4. Replaces file extensions cleanly for PDF, PNG, JPEG, XFDF, and JSON exports', () => {
    expect(replaceFileExtension('lecture-notes.pdf', 'png')).toBe('lecture-notes.png');
    expect(replaceFileExtension('lecture-notes.png', 'jpeg')).toBe('lecture-notes.jpg');
    expect(replaceFileExtension('lecture-notes.jpg', 'xfdf')).toBe('lecture-notes.xfdf');
    expect(replaceFileExtension('lecture-notes.xfdf', 'json')).toBe('lecture-notes.json');
    expect(replaceFileExtension('my-book', 'pdf')).toBe('my-book.pdf');
  });

  it('5. Parses print page range specifications with validation, deduplication, and sorting', () => {
    expect(parsePrintPageRange('1-3, 5, 8-7', 10)).toEqual([0, 1, 2, 4, 6, 7]);
    expect(parsePrintPageRange('2, 2, 4-6', 5)).toEqual([1, 3, 4]);
    expect(parsePrintPageRange('invalid, 99', 5)).toEqual([]);
    expect(parsePrintPageRange('', 5)).toEqual([]);
  });

  it('6. Builds structured Markdown summary for annotations and bookmarks in English and Persian', () => {
    const doc: Pick<DocumentSession, 'name' | 'pageCount' | 'annotations' | 'userBookmarks'> = {
      name: 'Physics-101.pdf',
      pageCount: 3,
      userBookmarks: [
        { id: 'bm-1', title: 'Chapter 1: Kinematics', note: 'Review formulas', pageIndex: 0, createdAt: 1000 }
      ],
      annotations: {
        0: [
          {
            id: 'note-1',
            pageIndex: 0,
            layerId: 'default',
            type: 'sticky-note',
            box: { x: 20, y: 20, width: 120, height: 80 },
            color: '#fef08a',
            textColor: '#1f2937',
            fontSize: 14,
            fontFamily: 'Inter',
            textAlign: 'left',
            author: 'Reader',
            collapsed: false,
            strokes: [],
            opacity: 1,
            text: 'Important derivation on velocity',
            createdAt: 1000,
            updatedAt: 1000
          }
        ],
        2: [
          {
            id: 'meas-1',
            pageIndex: 2,
            layerId: 'default',
            type: 'measure-angle',
            box: { x: 10, y: 10, width: 50, height: 50 },
            color: '#ef4444',
            opacity: 1,
            points: [{ x: 60, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 60 }],
            strokeWidth: 2,
            scaleRatio: 1,
            unit: 'cm',
            measuredValue: 90,
            label: '90.0°',
            createdAt: 1000,
            updatedAt: 1000
          }
        ]
      }
    };

    const mdEn = buildAnnotationsMarkdownSummary(doc, 'en');
    expect(mdEn).toContain('# Physics-101.pdf');
    expect(mdEn).toContain('## Bookmarks (1)');
    expect(mdEn).toContain('**[Page 1] Chapter 1: Kinematics** — _Review formulas_');
    expect(mdEn).toContain('## Page 1 (1)');
    expect(mdEn).toContain('Important derivation on velocity');
    expect(mdEn).toContain('## Page 3 (1)');
    expect(mdEn).toContain('Angle: 90.0°');

    const mdFa = buildAnnotationsMarkdownSummary(doc, 'fa');
    expect(mdFa).toContain('## نشانک‌ها (1)');
    expect(mdFa).toContain('اندازه زاویه: 90.0°');

    const desc = describeAnnotationItem(doc.annotations[2][0], 'en');
    expect(desc.category).toBe('shapes');
    expect(desc.icon).toBe('measureAngle');
  });

  it('7. Round-trips interactive PDF form values through JSON and PDF exports', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const form = pdfDoc.getForm();
    const textField = form.createTextField('student_name');
    textField.setText('Initial');
    textField.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
    const checkField = form.createCheckBox('agreed_terms');
    checkField.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });
    const rawBytes = await pdfDoc.save();

    const doc: DocumentSession = {
      id: 'form-doc-1',
      name: 'form.pdf',
      fileData: rawBytes,
      pageCount: 1,
      pages: [makePage(0)],
      bookmarks: [],
      annotations: {},
      formValues: {
        student_name: 'Ada Lovelace',
        agreed_terms: true
      },
      layers: {},
      activePageIndex: 0,
      createdAt: 1000,
      lastModifiedAt: 1000
    };
    store.setActiveDocument(doc);

    // JSON export & import preserves formValues
    const jsonStr = dataExporter.exportToJSON();
    doc.formValues = {};
    expect(dataExporter.importFromJSON(jsonStr)).toBe(true);
    expect(doc.formValues).toEqual({
      student_name: 'Ada Lovelace',
      agreed_terms: true
    });

    // PDF export updates AcroForm fields and VEditorState
    const exportedBytes = await pdfExporter.exportPDF({ flatten: false, dpi: 150 });
    const reloadedPdf = await PDFDocument.load(exportedBytes);
    const reloadedForm = reloadedPdf.getForm();
    expect(reloadedForm.getTextField('student_name').getText()).toBe('Ada Lovelace');
    expect(reloadedForm.getCheckBox('agreed_terms').isChecked()).toBe(true);

    // Also verify VEditorState extraction via pdfEngine
    await pdfEngine.extractNativeAnnotations(exportedBytes);
    expect(pdfEngine.getLastExtractedFormValues()).toEqual({
      student_name: 'Ada Lovelace',
      agreed_terms: true
    });

    // Direct applyFormValuesToPdfLibDoc with flatten=true flattens fields into page content
    applyFormValuesToPdfLibDoc(reloadedPdf, { student_name: 'Flattened Name' }, true);
    expect(reloadedPdf.getForm().getFields().length).toBe(0);
  });
});
