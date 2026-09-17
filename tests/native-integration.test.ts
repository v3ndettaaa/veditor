import { afterEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { DocumentSession } from '../src/core/types';
import { store } from '../src/core/store';
import { annotationEngine } from '../src/annotations/engine';
import { importNativeAnnotations } from '../src/core/native-annotations';

const worker = vi.hoisted(() => ({ inputs: [] as Uint8Array[], renders: [] as number[] }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: ({ data }: { data: Uint8Array }) => {
    worker.inputs.push(data.slice());
    const page = {
      rotate: 0,
      getViewport: () => ({ width: 400, height: 500, rotation: 0 }),
      getAnnotations: async () => [],
      render: ({ annotationMode }: { annotationMode: number }) => {
        worker.renders.push(annotationMode);
        return { promise: Promise.resolve() };
      }
    };
    return { promise: Promise.resolve({ numPages: 1, getPage: async () => page, getOutline: async () => [] }), destroy: async () => {} };
  }
}));

import { PDFEngine } from '../src/core/pdf-engine';
import { pdfExporter } from '../src/io/export-pdf';

afterEach(() => {
  store.setActiveDocument(null);
  vi.unstubAllGlobals();
  worker.inputs.length = 0;
  worker.renders.length = 0;
});

it('imports editable objects, paints the overlay, and saves/reopens without duplicate native appearances', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([400, 500]);
  const entries = [
    { Subtype: 'FreeText', NM: PDFString.of('text'), Rect: [20, 350, 180, 390], Contents: PDFString.of('Editable'), DA: PDFString.of('/Helv 16 Tf 0 g'), BS: { W: 0 } },
    { Subtype: 'Highlight', NM: PDFString.of('highlight'), Rect: [20, 250, 180, 270], QuadPoints: [20, 270, 180, 270, 20, 250, 180, 250], C: [1, 1, 0], CA: 0.4 },
    { Subtype: 'Stamp', NM: PDFString.of('foreign'), Rect: [200, 250, 260, 280] }
  ];
  page.node.set(PDFName.of('Annots'), source.context.obj(entries.map(e => source.context.register(source.context.obj({ Type: 'Annot', ...e })))));
  const bytes = await source.save();
  const engine = new PDFEngine();
  await engine.loadFromBytes(bytes, 'integration');
  const renderCopy = await PDFDocument.load(worker.inputs[0]);
  const remaining = renderCopy.getPage(0).node.Annots()!;
  expect(remaining.size()).toBe(1);
  expect(remaining.lookup(0, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe('Stamp');

  const imported = await engine.extractNativeAnnotations(bytes);
  expect(imported.map(e => e.annotation.type)).toEqual(['text', 'highlighter']);
  const session: DocumentSession = { id: 'integration', name: 'test.pdf', fileData: bytes, pageCount: 1,
    pages: [], bookmarks: [], annotations: { 0: imported.map(e => e.annotation) }, layers: {}, activePageIndex: 0, createdAt: 0, lastModifiedAt: 0 };
  store.setActiveDocument(session);
  const ctx = { save: vi.fn(), restore: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), fill: vi.fn(), fillText: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    measureText: () => ({ width: 50 }), globalAlpha: 1 };
  annotationEngine.renderAnnotationsToCanvas(ctx as unknown as CanvasRenderingContext2D, 0, 2);
  expect(ctx.fillText).toHaveBeenCalledWith('Editable', 20, 110);
  expect(ctx.fill).toHaveBeenCalledTimes(1);
  expect(ctx.globalAlpha).toBe(0.4);
  await engine.renderPageAtScale(0, { getContext: () => ctx } as unknown as HTMLCanvasElement, 1);
  expect(worker.renders).toEqual([1]);

  const text = session.annotations[0][0];
  if (text.type !== 'text') throw new Error('Expected editable text');
  text.text = 'Changed';
  const saved = await pdfExporter.exportPDF({ flatten: false, dpi: 150, applyRedactions: false });
  const reopened = await PDFDocument.load(saved);
  expect(importNativeAnnotations(reopened).map(e => e.annotation)).toEqual(session.annotations[0]);
  expect(reopened.getPage(0).node.Annots()!.size()).toBe(3);
  session.fileData = saved;
  session.annotations[0] = [];
  const deleted = await PDFDocument.load(await pdfExporter.exportPDF({ flatten: false, dpi: 150, applyRedactions: false }));
  expect(importNativeAnnotations(deleted)).toEqual([]);
  expect(deleted.getPage(0).node.Annots()!.size()).toBe(1);
});
