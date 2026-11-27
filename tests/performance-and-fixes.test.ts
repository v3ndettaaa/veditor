import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import {
  canVectorFlattenAnnotation,
  computeUnionScreenBounds,
  flattenVectorAnnotationsToPage,
  getPageBoxMetrics,
  isolatePageContentStream,
  MAX_FLATTEN_CANVAS_DIM,
  MAX_FLATTEN_CANVAS_PIXELS,
  resolveSafeRasterScale,
  screenPointToPdf,
  screenRectToPdfRect
} from '../src/core/pdf-flatten';
import { syncNativeInkAnnotations, computeInkFingerprint } from '../src/core/native-ink';
import { applyFormValuesToPdfLibDoc } from '../src/core/pdf-forms-writer';
import {
  stickyNoteTool,
  eraseStickyNoteContent,
  hitTestStickyNoteEmbeddedItem
} from '../src/annotations/tools/sticky-note';
import {
  resolveWebPdfUrl,
  extractCleanPdfFilename,
  isLikelyWebPdfUrl,
  findPdfHeaderOffset,
  normalizePdfBytes,
  uint8ArrayToBase64,
  base64ToUint8Array
} from '../src/utils/pdf-url';
import { computePlaceholderShellRange } from '../src/core/viewport';
import type { Annotation, PenAnnotation, StickyNoteAnnotation, TextAnnotation } from '../src/core/types';

describe('Fix 2: Sticky Note Zero-Lag Eraser & Full Tool Parity', () => {
  const makeNote = (): StickyNoteAnnotation =>
    stickyNoteTool.createStickyNote(0, 'layer-default', { x: 100, y: 100, width: 220, height: 220 }, 'Note', {
      strokes: [
        {
          id: 'st_1',
          tool: 'pen',
          color: '#1e293b',
          strokeWidth: 3,
          points: [
            { x: 120, y: 160, pressure: 0.4 },
            { x: 140, y: 160, pressure: 0.6 },
            { x: 160, y: 160, pressure: 0.8 },
            { x: 180, y: 160, pressure: 0.7 },
            { x: 200, y: 160, pressure: 0.5 },
            { x: 220, y: 160, pressure: 0.5 },
            { x: 240, y: 160, pressure: 0.5 }
          ]
        }
      ],
      items: [
        {
          id: 'txt_embedded_1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'text',
          box: { x: 120, y: 200, width: 80, height: 26 },
          text: 'Inner text',
          fontSize: 14,
          fontFamily: 'Manrope',
          color: '#111827',
          opacity: 1,
          createdAt: 10,
          updatedAt: 10
        } as TextAnnotation
      ]
    });

  it('returns modified=false when eraser misses all strokes and items (prevents redundant page repaints)', () => {
    const note = makeNote();
    const res = eraseStickyNoteContent(note, [{ x: 300, y: 300 }], 10, 'stroke');
    expect(res.modified).toBe(false);
    expect(res.strokes.length).toBe(1);
    expect(res.items.length).toBe(1);
  });

  it('erases an entire stroke in stroke mode when touched', () => {
    const note = makeNote();
    const res = eraseStickyNoteContent(note, [{ x: 160, y: 160 }], 8, 'stroke');
    expect(res.modified).toBe(true);
    expect(res.strokes.length).toBe(0);
    expect(res.items.length).toBe(1);
  });

  it('splits a stroke into two valid segments in pixel mode preserving pressure and style', () => {
    const note = makeNote();
    const res = eraseStickyNoteContent(note, [{ x: 180, y: 160 }], 12, 'pixel');
    expect(res.modified).toBe(true);
    expect(res.strokes.length).toBe(2);
    expect(res.strokes[0].points.length).toBeGreaterThanOrEqual(2);
    expect(res.strokes[1].points.length).toBeGreaterThanOrEqual(2);
    expect(res.strokes[0].color).toBe('#1e293b');
    expect(res.strokes[1].points[0].pressure).toBeGreaterThan(0);
  });

  it('erases embedded items inside a sticky note and hit-tests embedded items accurately', () => {
    const note = makeNote();
    const hit = hitTestStickyNoteEmbeddedItem(note, { x: 140, y: 210 });
    expect(hit?.id).toBe('txt_embedded_1');

    const miss = hitTestStickyNoteEmbeddedItem(note, { x: 290, y: 290 });
    expect(miss).toBeNull();

    const erased = eraseStickyNoteContent(note, [{ x: 140, y: 210 }], 8, 'stroke');
    expect(erased.modified).toBe(true);
    expect(erased.items.length).toBe(0);
  });
});

describe('Fix 3: Hybrid Vector + Cropped Raster PDF Flattening', () => {
  it('isolates existing page content streams with q...Q and produces valid vector flattened PDFs across all rotations', async () => {
    for (const rot of [0, 90, 180, 270]) {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 800]);
      page.setRotation(degrees(rot));
      // Draw something first so page has a real /Contents stream
      page.drawRectangle({ x: 20, y: 20, width: 100, height: 50 });

      isolatePageContentStream(pdfDoc, page);
      const metrics = getPageBoxMetrics(page);

      const sampleAnns: Annotation[] = [
        {
          id: 'p1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'pen',
          color: '#dc2626',
          strokeWidth: 3,
          points: [
            { x: 50, y: 60, pressure: 0.5 },
            { x: 120, y: 90, pressure: 0.7 },
            { x: 200, y: 120, pressure: 0.5 }
          ],
          box: { x: 50, y: 60, width: 150, height: 60 },
          opacity: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'h1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'highlighter',
          color: 'rgba(253, 224, 71, 0.45)',
          strokeWidth: 16,
          points: [
            { x: 50, y: 150, pressure: 0.5 },
            { x: 250, y: 150, pressure: 0.5 }
          ],
          box: { x: 50, y: 142, width: 200, height: 16 },
          blendMode: 'multiply',
          opacity: 0.45,
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'r1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'rectangle',
          strokeColor: '#2563eb',
          fillColor: '#bfdbfe',
          fillOpacity: 0.5,
          strokeWidth: 2,
          strokeStyle: 'dashed',
          cornerRadius: 6,
          box: { x: 80, y: 200, width: 140, height: 80 },
          opacity: 1,
          createdAt: 3,
          updatedAt: 3
        },
        {
          id: 'e1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'ellipse',
          strokeColor: '#059669',
          fillColor: 'transparent',
          strokeWidth: 2,
          strokeStyle: 'solid',
          box: { x: 260, y: 200, width: 100, height: 60 },
          opacity: 1,
          createdAt: 4,
          updatedAt: 4
        },
        {
          id: 'a1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'arrow',
          strokeColor: '#7c3aed',
          strokeWidth: 2.5,
          strokeStyle: 'solid',
          points: [
            { x: 100, y: 320 },
            { x: 240, y: 360 }
          ],
          box: { x: 100, y: 320, width: 140, height: 40 },
          arrowEnd: true,
          opacity: 1,
          createdAt: 5,
          updatedAt: 5
        },
        {
          id: 'sig1',
          pageIndex: 0,
          layerId: 'layer-default',
          type: 'signature',
          color: '#0f172a',
          points: [[{ x: 0, y: 20, pressure: 0.5 }, { x: 40, y: 0, pressure: 0.5 }, { x: 80, y: 30, pressure: 0.5 }]],
          box: { x: 120, y: 400, width: 96, height: 46 },
          opacity: 1,
          createdAt: 6,
          updatedAt: 6
        }
      ];

      expect(sampleAnns.every(canVectorFlattenAnnotation)).toBe(true);
      const emitted = flattenVectorAnnotationsToPage(pdfDoc, page, sampleAnns, metrics);
      expect(emitted).toBe(true);

      const saved = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
      const reloaded = await PDFDocument.load(saved);
      expect(reloaded.getPageCount()).toBe(1);
      expect(reloaded.getPage(0).getRotation().angle).toBe(rot);
    }
  });

  it('safely clamps high-DPI raster scales and maps rotated screen rectangles into PDF user space', () => {
    const scale = resolveSafeRasterScale(2000, 3000, 600 / 72);
    expect(2000 * scale).toBeLessThanOrEqual(MAX_FLATTEN_CANVAS_DIM + 1);
    expect(3000 * scale).toBeLessThanOrEqual(MAX_FLATTEN_CANVAS_DIM + 1);
    expect(2000 * scale * 3000 * scale).toBeLessThanOrEqual(MAX_FLATTEN_CANVAS_PIXELS + 1000);

    const m0 = { boxX: 0, boxY: 0, width: 600, height: 800, pageRot: 0, screenWidth: 600, screenHeight: 800 };
    expect(screenPointToPdf({ x: 100, y: 200 }, m0)).toEqual([100, 600]);
    const pdfRect = screenRectToPdfRect({ x: 50, y: 100, width: 100, height: 200 }, m0);
    expect(pdfRect).toEqual({ x: 50, y: 500, width: 100, height: 200 });

    const union = computeUnionScreenBounds([
      {
        id: 't1',
        pageIndex: 0,
        layerId: 'layer-default',
        type: 'text',
        text: 'Hello',
        fontSize: 16,
        fontFamily: 'Manrope',
        color: '#000',
        box: { x: 40, y: 50, width: 100, height: 30 },
        opacity: 1,
        createdAt: 1,
        updatedAt: 1
      } as TextAnnotation
    ], 600, 800);
    expect(union).not.toBeNull();
    expect(union!.width).toBeLessThan(600);
    expect(union!.height).toBeLessThan(800);
  });
});

describe('Fix 4: Incremental Ink Hashing & Fast Save', () => {
  it('reuses unchanged native /Ink annotation streams on repeat saves via /VEditorInkHash', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);
    const stroke: PenAnnotation = {
      id: 'ink_cached_1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'pen',
      color: '#1d4ed8',
      strokeWidth: 2.5,
      points: [
        { x: 40, y: 40, pressure: 0.5 },
        { x: 90, y: 80, pressure: 0.6 },
        { x: 140, y: 120, pressure: 0.5 }
      ],
      box: { x: 40, y: 40, width: 100, height: 80 },
      opacity: 1,
      createdAt: 1,
      updatedAt: 1
    };

    const firstChanged = syncNativeInkAnnotations(pdfDoc, { 0: [stroke] });
    expect(firstChanged).toBe(true);

    // Reloading and syncing identical strokes should detect exact hash match and skip rebuilding!
    const savedBytes = await pdfDoc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(savedBytes);
    const secondChanged = syncNativeInkAnnotations(reloaded, { 0: [stroke] });
    expect(secondChanged).toBe(false);

    // Modifying a point changes fingerprint and triggers an update
    const movedStroke: PenAnnotation = {
      ...stroke,
      points: stroke.points.map(p => ({ ...p, x: p.x + 15 }))
    };
    expect(computeInkFingerprint(stroke, 0, 0, 600, 800, 0)).not.toBe(
      computeInkFingerprint(movedStroke, 0, 0, 600, 800, 0)
    );
    const thirdChanged = syncNativeInkAnnotations(reloaded, { 0: [movedStroke] });
    expect(thirdChanged).toBe(true);
  });

  it('applyFormValuesToPdfLibDoc safely skips documents without AcroForm', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);
    expect(pdfDoc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(applyFormValuesToPdfLibDoc(pdfDoc, { field1: 'val' }, true)).toBe(false);
  });
});

describe('Fix 5: Direct Web PDF Opening & Extension Permissions', () => {
  it('unwraps nested browser PDF viewer URLs, query parameters, and hashes', () => {
    expect(
      resolveWebPdfUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.com%2Fpaper.pdf')
    ).toBe('https://example.com/paper.pdf');

    expect(
      resolveWebPdfUrl('https://docs.google.com/viewer?url=https%3A%2F%2Farxiv.org%2Fpdf%2F2401.12345')
    ).toBe('https://arxiv.org/pdf/2401.12345');

    expect(
      resolveWebPdfUrl('https://viewer.example.org/web/viewer.html#file=https%3A%2F%2Ffiles.example.org%2Fdoc.pdf')
    ).toBe('https://files.example.org/doc.pdf');

    expect(extractCleanPdfFilename('https://arxiv.org/pdf/2401.12345?download=1')).toBe('2401.12345.pdf');
    expect(isLikelyWebPdfUrl('https://arxiv.org/pdf/2401.12345')).toBe(true);
    expect(isLikelyWebPdfUrl('https://example.com/report.PDF?token=xyz')).toBe(true);
    expect(isLikelyWebPdfUrl('https://example.com/article.html')).toBe(false);
  });

  it('normalizes PDF buffers with leading BOM/whitespace and round-trips base64 cleanly', () => {
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(findPdfHeaderOffset(raw)).toBe(4);
    const normalized = normalizePdfBytes(raw);
    expect(normalized).not.toBeNull();
    expect(normalized![0]).toBe(0x25); // '%'
    expect(normalized!.length).toBe(8);

    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>Login required</body></html>');
    expect(normalizePdfBytes(html)).toBeNull();

    const encoded = uint8ArrayToBase64(normalized!);
    const decoded = base64ToUint8Array(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(normalized!));
  });

  it('declares host_permissions in both Chrome and Firefox manifests for cross-origin PDF fetching', () => {
    const chromeManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.chrome.json'), 'utf8'));
    const firefoxManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.firefox.json'), 'utf8'));
    expect(chromeManifest.host_permissions).toContain('<all_urls>');
    expect(firefoxManifest.host_permissions).toContain('<all_urls>');
    expect(firefoxManifest.background?.type).toBe('module');
  });
});

describe('Fix 6: Seamless Placeholder Scroll, Zero Black Blinks, & Electron Linux Wayland Pinch/Coast', () => {
  it('pre-mounts all placeholder shells up to 240 pages and maintains a wide radius on large PDFs', () => {
    expect(computePlaceholderShellRange(5, 200, 100)).toEqual({ start: 0, end: 199 });
    expect(computePlaceholderShellRange(150, 500, 100)).toEqual({ start: 50, end: 250 });
    expect(computePlaceholderShellRange(0, 500, 100)).toEqual({ start: 0, end: 100 });
  });

  it('uses opacity-only fade (no visibility:hidden) on unrendered PDF canvases to prevent cold GPU black flashes', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/styles/main.css'), 'utf8');
    const ruleMatch = css.match(/\.pdf-page-container:not\(\.is-page-rendered\)\s+\.pdf-page-canvas\s*\{([^}]*)\}/);
    expect(ruleMatch).not.toBeNull();
    expect(ruleMatch![1]).toContain('opacity: 0');
    expect(ruleMatch![1]).not.toContain('visibility: hidden');
  });

  it('configures Electron Linux main/preload with Wayland Ozone pinch and subpixel-safe kinetic coasting', () => {
    const mainCjs = readFileSync(resolve(process.cwd(), 'electron/main.cjs'), 'utf8');
    const preloadCjs = readFileSync(resolve(process.cwd(), 'electron/preload.cjs'), 'utf8');
    expect(mainCjs).toContain("'ozone-platform', 'wayland'");
    expect(mainCjs).toContain("'enable-pinch'");
    expect(mainCjs).toContain('setVisualZoomLevelLimits(1, 3)');
    expect(preloadCjs).toContain('setVisualZoomLevelLimits(1, 3)');
    expect(preloadCjs).toContain('kineticScrolling');
    expect(preloadCjs).toContain('Math.trunc(moveY)');
  });
});
