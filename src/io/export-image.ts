/**
 * High-DPI Image Exporter
 * Exports annotated PDF pages as ultra-crisp PNG or JPEG images with selectable DPI.
 */

import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { annotationEngine } from '../annotations/engine';
import { renderPageFormValuesToCanvas } from '../core/pdf-forms';

export interface ImageExportOptions {
  format?: 'png' | 'jpeg' | 'image/png' | 'image/jpeg';
  dpi?: 72 | 150 | 300 | 600;
  quality?: number;
  includeAnnotations?: boolean;
  darkMode?: boolean;
}

export class ImageExporter {
  public async exportPageToImage(
    pageIndex: number,
    optionsOrFormat: ImageExportOptions | 'image/png' | 'image/jpeg' = 'image/png',
    dpiArg: 72 | 150 | 300 | 600 = 300,
    qualityArg: number = 0.95
  ): Promise<Blob> {
    const doc = store.activeDocument;
    if (!doc) throw new Error('No active document');

    const pageInfo = doc.pages[pageIndex];
    if (!pageInfo) throw new Error(`Page ${pageIndex + 1} not found`);

    let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
    let dpi: 72 | 150 | 300 | 600 = dpiArg;
    let quality = qualityArg;
    let includeAnnotations = true;
    let darkMode = false;

    if (typeof optionsOrFormat === 'string') {
      mimeType = optionsOrFormat;
    } else if (optionsOrFormat && typeof optionsOrFormat === 'object') {
      if (optionsOrFormat.format === 'jpeg' || optionsOrFormat.format === 'image/jpeg') {
        mimeType = 'image/jpeg';
      } else {
        mimeType = 'image/png';
      }
      if (optionsOrFormat.dpi) dpi = optionsOrFormat.dpi;
      if (typeof optionsOrFormat.quality === 'number') quality = optionsOrFormat.quality;
      if (typeof optionsOrFormat.includeAnnotations === 'boolean') {
        includeAnnotations = optionsOrFormat.includeAnnotations;
      }
      if (typeof optionsOrFormat.darkMode === 'boolean') {
        darkMode = optionsOrFormat.darkMode;
      }
    }

    const scale = dpi / 72;
    const userRot = store.pageRotations[pageIndex] || 0;
    const rawCanvas = document.createElement('canvas');

    // 1. Render PDF base
    await pdfEngine.renderPageAtScale(pageIndex, rawCanvas, scale, userRot);

    let canvas = rawCanvas;
    if (darkMode) {
      const darkCanvas = document.createElement('canvas');
      darkCanvas.width = rawCanvas.width;
      darkCanvas.height = rawCanvas.height;
      const darkCtx = darkCanvas.getContext('2d');
      if (darkCtx) {
        darkCtx.filter = 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(1.05)';
        darkCtx.drawImage(rawCanvas, 0, 0);
        darkCtx.filter = 'none';
        canvas = darkCanvas;
      }
    }

    // 2. Render Annotations & Form Fields on top in original colors
    if (includeAnnotations) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const anns = doc.annotations[pageIndex] || [];
        const layers = doc.layers[pageIndex] || [];
        annotationEngine.renderCommittedAnnotations(ctx, anns, layers, scale);
        await renderPageFormValuesToCanvas(ctx, pageIndex, scale, userRot);
      }
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to generate image blob'));
        },
        mimeType,
        quality
      );
    });
  }

  public downloadImage(blob: Blob, filename: string): void {
    this.downloadImageBlob(blob, filename);
  }

  public downloadImageBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export const imageExporter = new ImageExporter();
