/**
 * High-DPI Image Exporter
 * Exports annotated PDF pages as ultra-crisp PNG or JPEG images with selectable DPI.
 */

import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { annotationEngine } from '../annotations/engine';

export class ImageExporter {
  public async exportPageToImage(
    pageIndex: number,
    format: 'image/png' | 'image/jpeg' = 'image/png',
    dpi: 72 | 150 | 300 | 600 = 300,
    quality: number = 0.95
  ): Promise<Blob> {
    const doc = store.activeDocument;
    if (!doc) throw new Error('No active document');

    const pageInfo = doc.pages[pageIndex];
    if (!pageInfo) throw new Error(`Page ${pageIndex + 1} not found`);

    const scale = dpi / 72;
    const canvas = document.createElement('canvas');

    // 1. Render PDF base
    await pdfEngine.renderPageToCanvas(pageIndex, canvas, scale);

    // 2. Render Annotations on top
    const ctx = canvas.getContext('2d');
    if (ctx) {
      annotationEngine.renderAnnotationsToCanvas(ctx, pageIndex, scale);
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to generate image blob'));
        },
        format,
        quality
      );
    });
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
