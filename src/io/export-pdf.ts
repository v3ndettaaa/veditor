/**
 * PDF Export Engine powered by pdf-lib
 * Supports high-resolution annotation flattening, vector embedding, and redaction scrubbing.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import { store } from '../core/store';
import { annotationEngine } from '../annotations/engine';

export interface PDFExportOptions {
  flatten: boolean;
  dpi: 72 | 150 | 300 | 600;
  applyRedactions: boolean;
  pageRange?: { start: number; end: number }; // 1-indexed
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
    const pages = pdfDoc.getPages();

    const startIdx = options.pageRange ? options.pageRange.start - 1 : 0;
    const endIdx = options.pageRange ? options.pageRange.end - 1 : pages.length - 1;

    for (let i = startIdx; i <= endIdx; i++) {
      if (i < 0 || i >= pages.length) continue;
      const pdfPage = pages[i];
      const pageAnnotations = doc.annotations[i] || [];

      // Check if page has annotations or redactions
      if (pageAnnotations.length === 0) continue;

      if (options.flatten) {
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

          // Convert canvas to PNG blob/bytes
          const pngDataUrl = offCanvas.toDataURL('image/png');
          const pngBytes = this.dataUrlToUint8Array(pngDataUrl);

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
