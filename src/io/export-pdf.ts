/**
 * PDF Export Engine powered by pdf-lib
 * Supports high-resolution annotation flattening, vector embedding, and redaction scrubbing.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { annotationEngine } from '../annotations/engine';
import { syncNativeInkAnnotations, stripNativeInkAnnotations } from '../core/native-ink';
import { syncNativeAnnotations, stripImportedNativeAnnotations } from '../core/native-annotations';
import unicodeFontUrl from '@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff?url';

async function loadUnicodeFont(): Promise<Uint8Array> {
  const response = await fetch(unicodeFontUrl);
  if (!response.ok) throw new Error('Could not load the bundled Unicode font');
  return new Uint8Array(await response.arrayBuffer());
}

export interface PDFExportOptions {
  flatten: boolean;
  dpi: 72 | 150 | 300 | 600;
  applyRedactions: boolean;
  pageRange?: { start: number; end: number }; // 1-indexed
  /** Exact zero-indexed pages, used by sidebar multi-selection. */
  pageIndices?: number[];
  /**
   * True bakes the on-screen dark theme into the exported pages (the same
   * inversion filter the viewer uses); false/undefined keeps original page
   * colors untouched. Only ever applied when explicitly requested.
   */
  darkMode?: boolean;
}

export class PDFExporter {
  /**
   * Exports document with annotations.
   */
  public async exportPDF(options: PDFExportOptions = { flatten: true, dpi: 150, applyRedactions: true }): Promise<Uint8Array> {
    const doc = store.activeDocument;
    if (!doc || !doc.fileData) {
      throw new Error('No PDF document loaded to export');
    }

    // Load original PDF using pdf-lib to preserve structure and metadata
    const pdfDoc = await PDFDocument.load(doc.fileData, { ignoreEncryption: true });
    // Bidirectionally sync Veditor pen/highlighter vector ink into native PDF /Ink dicts
    if (!options.flatten) {
      await syncNativeAnnotations(pdfDoc, doc.annotations, loadUnicodeFont);
      syncNativeInkAnnotations(pdfDoc, doc.annotations);
    } else {
      stripImportedNativeAnnotations(pdfDoc);
      stripNativeInkAnnotations(pdfDoc);
    }
    const pages = pdfDoc.getPages();

    const selectedIndices = options.pageIndices?.length
      ? [...new Set(options.pageIndices)].filter(i => i >= 0 && i < pages.length).sort((a, b) => a - b)
      : options.pageRange
        ? Array.from(
          { length: Math.max(0, options.pageRange.end - options.pageRange.start + 1) },
          (_, offset) => options.pageRange!.start - 1 + offset
        ).filter(i => i >= 0 && i < pages.length)
        : pages.map((_, index) => index);

    for (const i of selectedIndices) {
      const pdfPage = pages[i];
      const pageAnnotations = doc.annotations[i] || [];

      if (!options.darkMode && pageAnnotations.length === 0) continue;

      if (options.darkMode) {
        // Dark theme baking: renders the page through the same inversion the
        // viewer applies, then overlays annotations in their original colors.
        const { width, height } = pdfPage.getSize();
        const dpiScale = options.dpi / 72;
        const totalRotation = store.pageRotations[i] || 0;

        const rawCanvas = document.createElement('canvas');
        const rendered = await pdfEngine.renderPageAtScale(i, rawCanvas, dpiScale, totalRotation);
        if (rendered) {
          const darkCanvas = document.createElement('canvas');
          darkCanvas.width = rawCanvas.width;
          darkCanvas.height = rawCanvas.height;
          const darkCtx = darkCanvas.getContext('2d');
          if (darkCtx) {
            darkCtx.filter = 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(1.05)';
            darkCtx.drawImage(rawCanvas, 0, 0);
            darkCtx.filter = 'none';

            if (options.flatten) annotationEngine.renderAnnotationsToCanvas(darkCtx, i, dpiScale);

            const jpgBytes = await this.canvasToBytes(darkCanvas, 'image/jpeg', 0.92);
            const embeddedImg = await pdfDoc.embedJpg(jpgBytes);
            pdfPage.drawImage(embeddedImg, { x: 0, y: 0, width, height, opacity: 1.0 });
          }
        }
      } else if (options.flatten) {
        // High-DPI Flattening onto the page content stream
        const { width, height } = pdfPage.getSize();
        const dpiScale = options.dpi / 72; // e.g. 150 / 72 = 2.08x

        // Create offscreen canvas at high resolution
        const offCanvas = document.createElement('canvas');
        offCanvas.width = Math.floor(width * dpiScale);
        offCanvas.height = Math.floor(height * dpiScale);

        const ctx = offCanvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);
          // Render annotations at export scale
          annotationEngine.renderAnnotationsToCanvas(ctx, i, dpiScale);

          const pngBytes = await this.canvasToBytes(offCanvas, 'image/png');
          const embeddedPng = await pdfDoc.embedPng(pngBytes);
          pdfPage.drawImage(embeddedPng, {
            x: 0,
            y: 0,
            width,
            height,
            opacity: 1.0
          });
        }
      } else {
        // Vector annotations embedding
        for (const ann of pageAnnotations) {
          if (ann.type === 'rectangle' || ann.type === 'redaction') {
            const { height: pageHeight } = pdfPage.getSize();
            // Invert Y coordinate (PDF 0,0 is bottom-left, Canvas 0,0 is top-left)
            const pdfY = pageHeight - ann.box.y - ann.box.height;

            if (ann.type === 'redaction' && options.applyRedactions) {
              pdfPage.drawRectangle({
                x: ann.box.x,
                y: pdfY,
                width: ann.box.width,
                height: ann.box.height,
                color: rgb(0, 0, 0)
              });
            }
          }
        }
      }
    }

    // Copy selected pages into a fresh document. This is more reliable than
    // removing pages in-place across Firefox's pdf-lib worker boundary, and
    // it supports non-contiguous sidebar selections.
    if (options.pageRange || options.pageIndices?.length) {
      const selectedDocument = await PDFDocument.create();
      const copiedPages = await selectedDocument.copyPages(pdfDoc, selectedIndices);
      copiedPages.forEach(page => selectedDocument.addPage(page));
      return selectedDocument.save();
    }

    return await pdfDoc.save();
  }

  /**
   * Prompts user to save the exported PDF to their computer.
   */
  public async saveToFile(bytes: Uint8Array, defaultName: string): Promise<void> {
    await this.saveToFileReturningHandle(bytes, defaultName);
  }

  /**
   * Same as saveToFile but returns the FileSystemFileHandle when the
   * File System Access API path was used (null on fallback/cancel).
   * Throws on real failures; returns null when the user cancels.
   */
  public async saveToFileReturningHandle(bytes: Uint8Array, defaultName: string): Promise<any | null> {
    const result = await this.saveToFileWithResult(bytes, defaultName);
    return result.cancelled ? null : result.handle;
  }

  /**
   * Full result distinguishing user-cancel from the Firefox/Safari fallback
   * download (both yield handle=null from the legacy method).
   */
  public async saveToFileWithResult(bytes: Uint8Array, defaultName: string): Promise<{ handle: any | null; cancelled: boolean }> {
    const filename = defaultName.endsWith('.pdf') ? defaultName : `${defaultName}.pdf`;

    // Try File System Access API (Modern Chrome/Edge)
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [
            {
              description: 'PDF Document',
              accept: { 'application/pdf': ['.pdf'] }
            }
          ]
        });
        const writable = await handle.createWritable();
        await writable.write(bytes as any);
        await writable.close();
        return { handle, cancelled: false };
      } catch (err: any) {
        if (err.name === 'AbortError') return { handle: null, cancelled: true }; // User cancelled
      }
    }

    // Direct download fallback (Firefox & Safari)
    const blob = new Blob([bytes as any], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { handle: null, cancelled: false };
  }

  /**
   * Canvas → encoded bytes without a base64 round-trip: `toBlob` avoids the
   * ~3x peak memory and main-thread stall of `toDataURL` + `atob` on large
   * high-DPI pages. Falls back to the data-URL path when `toBlob` yields null.
   */
  private canvasToBytes(
    canvas: HTMLCanvasElement,
    type: 'image/png' | 'image/jpeg',
    quality?: number
  ): Promise<Uint8Array> {
    return new Promise((resolveBytes, rejectBytes) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          try {
            resolveBytes(this.dataUrlToUint8Array(canvas.toDataURL(type, quality)));
          } catch (err) {
            rejectBytes(err);
          }
          return;
        }
        blob.arrayBuffer()
          .then(buf => resolveBytes(new Uint8Array(buf)))
          .catch(rejectBytes);
      }, type, quality);
    });
  }

  private dataUrlToUint8Array(dataUrl: string): Uint8Array {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

export const pdfExporter = new PDFExporter();
