/**
 * PDF Export Engine powered by pdf-lib
 * Supports high-resolution annotation flattening, vector embedding, and redaction scrubbing.
 */

import { PDFDocument, rgb, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFRawStream } from 'pdf-lib';
import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { annotationEngine } from '../annotations/engine';
import type { StickyNoteAnnotation } from '../core/types';

export interface PDFExportOptions {
  flatten: boolean;
  dpi: 72 | 150 | 300 | 600;
  applyRedactions: boolean;
  pageRange?: { start: number; end: number }; // 1-indexed
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
    const pages = pdfDoc.getPages();

    const startIdx = options.pageRange ? options.pageRange.start - 1 : 0;
    const endIdx = options.pageRange ? options.pageRange.end - 1 : pages.length - 1;

    for (let i = startIdx; i <= endIdx; i++) {
      if (i < 0 || i >= pages.length) continue;
      const pdfPage = pages[i];
      const pageAnnotations = doc.annotations[i] || [];

      // Check if page has annotations, redactions or dark mode enabled
      if (!options.darkMode && pageAnnotations.length === 0) continue;

      if (options.darkMode) {
        // True Dark Mode Baking: renders page in OLED Dark mode matching screen view
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

            // Render annotations on top in their original colors
            annotationEngine.renderAnnotationsToCanvas(darkCtx, i, dpiScale);

            const jpgDataUrl = darkCanvas.toDataURL('image/jpeg', 0.92);
            const jpgBytes = this.dataUrlToUint8Array(jpgDataUrl);
            const embeddedImg = await pdfDoc.embedJpg(jpgBytes);
            pdfPage.drawImage(embeddedImg, {
              x: 0,
              y: 0,
              width,
              height,
              opacity: 1.0
            });
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

    // Hybrid sticky notes: interactive /Text + /Popup pins plus a /Stamp
    // appearance for expanded cards (vector mode) and private round-trip
    // state in PieceInfo. Flatten mode already rasterized the visuals.
    await this.embedStickyNotes(pdfDoc, options);

    return await pdfDoc.save();
  }

  /** Plain-text extract of a sticky note for /Contents and XFDF. */
  private stickyText(ann: StickyNoteAnnotation): string {
    const text = ann.texts.map(t => t.text).join('\n').trim();
    if (text) return text;
    if (ann.ink.length > 0) return '(handwritten note)';
    return '(empty note)';
  }

  /** Renders an expanded note card to PNG bytes at the export scale. */
  private renderNoteCard(ann: StickyNoteAnnotation, dpiScale: number): Uint8Array | null {
    const w = Math.max(1, Math.floor(ann.box.width * dpiScale));
    const h = Math.max(1, Math.floor(ann.box.height * dpiScale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpiScale, dpiScale);
    ctx.translate(-ann.box.x, -ann.box.y);
    annotationEngine.renderSingleAnnotation(ctx, ann as any, 1);
    return this.dataUrlToUint8Array(canvas.toDataURL('image/png'));
  }

  /**
   * Portable sticky-note export per the PDF spec:
   * - /Text + /Popup: the gold-standard sticky note every reader shows.
   * - /Stamp + /AP /N: vector-mode appearance so expanded cards print
   *   faithfully (flatten mode already drew them into the page raster).
   * - PieceInfo/VEditor/Private: collapse state + anchors for round-trip.
   *   Never load-bearing — readers may drop private metadata freely.
   */
  private async embedStickyNotes(pdfDoc: PDFDocument, options: PDFExportOptions): Promise<void> {
    const doc = store.activeDocument;
    if (!doc) return;
    const ctx = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const startIdx = options.pageRange ? options.pageRange.start - 1 : 0;
    const endIdx = options.pageRange ? options.pageRange.end - 1 : pages.length - 1;
    const dpiScale = options.dpi / 72;
    const now = new Date();
    const pieceNotes: any[] = [];

    for (let i = startIdx; i <= endIdx; i++) {
      if (i < 0 || i >= pages.length) continue;
      const pdfPage = pages[i];
      const leaf = pdfPage.node;
      const { height: pageHeight } = pdfPage.getSize();
      const notes = (doc.annotations[i] || []).filter(a => a.type === 'sticky-note') as StickyNoteAnnotation[];
      if (notes.length === 0) continue;

      for (const note of notes) {
        const text = this.stickyText(note);
        const pinSize = 24;
        // Anchor is the pin tip: center the 24pt pin rect on it (Y-flipped).
        const pinX = note.anchor.x - pinSize / 2;
        const pinPdfY = pageHeight - note.anchor.y - pinSize / 2;
        const cardPdfY = pageHeight - note.box.y - note.box.height;

        // --- /Text pin + /Popup pair ---
        const textDict = PDFDict.withContext(ctx);
        textDict.set(PDFName.of('Type'), PDFName.of('Annot'));
        textDict.set(PDFName.of('Subtype'), PDFName.of('Text'));
        const pinRect = PDFArray.withContext(ctx);
        pinRect.push(PDFNumber.of(pinX));
        pinRect.push(PDFNumber.of(pinPdfY));
        pinRect.push(PDFNumber.of(pinX + pinSize));
        pinRect.push(PDFNumber.of(pinPdfY + pinSize));
        textDict.set(PDFName.of('Rect'), pinRect);
        textDict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
        textDict.set(PDFName.of('T'), PDFString.of('veditor'));
        textDict.set(PDFName.of('M'), PDFString.fromDate(now));
        textDict.set(PDFName.of('Name'), PDFName.of('Comment'));
        textDict.set(PDFName.of('Open'), note.collapsed ? PDFBool.False : PDFBool.True);
        textDict.set(PDFName.of('C'), ctx.obj([1, 0.78, 0.25]));
        textDict.set(PDFName.of('F'), PDFNumber.of(4));
        textDict.set(PDFName.of('Border'), ctx.obj([0, 0, 1]));

        const popupDict = PDFDict.withContext(ctx);
        popupDict.set(PDFName.of('Type'), PDFName.of('Annot'));
        popupDict.set(PDFName.of('Subtype'), PDFName.of('Popup'));
        const popRect = PDFArray.withContext(ctx);
        popRect.push(PDFNumber.of(note.box.x));
        popRect.push(PDFNumber.of(cardPdfY));
        popRect.push(PDFNumber.of(note.box.x + note.box.width));
        popRect.push(PDFNumber.of(cardPdfY + note.box.height));
        popupDict.set(PDFName.of('Rect'), popRect);
        popupDict.set(PDFName.of('Open'), note.collapsed ? PDFBool.False : PDFBool.True);

        const textRef = ctx.register(textDict);
        const popupRef = ctx.register(popupDict);
        textDict.set(PDFName.of('Popup'), popupRef);
        popupDict.set(PDFName.of('Parent'), textRef);
        leaf.addAnnot(textRef);
        leaf.addAnnot(popupRef);

        // --- /Stamp appearance for expanded cards (vector mode only) ---
        if (!note.collapsed && !options.flatten) {
          const cardBytes = this.renderNoteCard(note, dpiScale);
          if (cardBytes) {
            const img = await pdfDoc.embedPng(cardBytes);
            const w = note.box.width;
            const h = note.box.height;
            const xRes = PDFDict.withContext(ctx);
            xRes.set(PDFName.of('VImg'), img.ref);
            const resources = PDFDict.withContext(ctx);
            resources.set(PDFName.of('XObject'), xRes);
            const apDict = PDFDict.withContext(ctx);
            apDict.set(PDFName.of('Type'), PDFName.of('XObject'));
            apDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
            const bbox = PDFArray.withContext(ctx);
            bbox.push(PDFNumber.of(0));
            bbox.push(PDFNumber.of(0));
            bbox.push(PDFNumber.of(w));
            bbox.push(PDFNumber.of(h));
            apDict.set(PDFName.of('BBox'), bbox);
            apDict.set(PDFName.of('Resources'), resources);
            const ops = `q\n${w} 0 0 ${h} 0 0 cm\n/VImg Do\nQ\n`;
            const apRef = ctx.register(PDFRawStream.of(apDict, new TextEncoder().encode(ops)));

            const stampDict = PDFDict.withContext(ctx);
            stampDict.set(PDFName.of('Type'), PDFName.of('Annot'));
            stampDict.set(PDFName.of('Subtype'), PDFName.of('Stamp'));
            const stampRect = PDFArray.withContext(ctx);
            stampRect.push(PDFNumber.of(note.box.x));
            stampRect.push(PDFNumber.of(cardPdfY));
            stampRect.push(PDFNumber.of(note.box.x + w));
            stampRect.push(PDFNumber.of(cardPdfY + h));
            stampDict.set(PDFName.of('Rect'), stampRect);
            stampDict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
            stampDict.set(PDFName.of('T'), PDFString.of('veditor'));
            stampDict.set(PDFName.of('M'), PDFString.fromDate(now));
            stampDict.set(PDFName.of('Name'), PDFName.of('Approved'));
            stampDict.set(PDFName.of('F'), PDFNumber.of(4));
            stampDict.set(PDFName.of('C'), ctx.obj([1, 0.85, 0.4]));
            const ap = PDFDict.withContext(ctx);
            ap.set(PDFName.of('N'), apRef);
            stampDict.set(PDFName.of('AP'), ap);
            leaf.addAnnot(ctx.register(stampDict));
          }
        }

        const anchorArr = PDFArray.withContext(ctx);
        anchorArr.push(PDFNumber.of(note.anchor.x));
        anchorArr.push(PDFNumber.of(note.anchor.y));
        const entry = PDFDict.withContext(ctx);
        entry.set(PDFName.of('id'), PDFString.of(note.id));
        entry.set(PDFName.of('page'), PDFNumber.of(i));
        entry.set(PDFName.of('anchor'), anchorArr);
        entry.set(PDFName.of('collapsed'), note.collapsed ? PDFBool.True : PDFBool.False);
        pieceNotes.push(entry);
      }
    }

    if (pieceNotes.length > 0) {
      const arr = PDFArray.withContext(ctx);
      for (const entry of pieceNotes) arr.push(entry);
      const priv = PDFDict.withContext(ctx);
      priv.set(PDFName.of('StickyNotes'), arr);
      const veditor = PDFDict.withContext(ctx);
      veditor.set(PDFName.of('LastModified'), PDFString.fromDate(now));
      veditor.set(PDFName.of('Private'), priv);
      const pieceInfo = PDFDict.withContext(ctx);
      pieceInfo.set(PDFName.of('VEditor'), veditor);
      (pdfDoc.catalog as PDFDict).set(PDFName.of('PieceInfo'), pieceInfo);
    }
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
