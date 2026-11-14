/**
 * PDF Export Engine powered by pdf-lib
 * Supports high-resolution annotation flattening and native vector/composite embedding.
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { store } from '../core/store';
import { pdfEngine } from '../core/pdf-engine';
import { annotationEngine } from '../annotations/engine';
import { syncNativeInkAnnotations, stripNativeInkAnnotations } from '../core/native-ink';
import { syncNativeAnnotations, stripImportedNativeAnnotations } from '../core/native-annotations';
import { applyFormValuesToPdfLibDoc } from '../core/pdf-forms';
import { encryptAndSavePdfDocument } from '../core/pdf-encrypt';
import unicodeFontUrl from '@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff?url';

let cachedUnicodeFontBytes: Uint8Array | null = null;

async function loadUnicodeFont(): Promise<Uint8Array> {
  if (cachedUnicodeFontBytes) return cachedUnicodeFontBytes;
  const response = await fetch(unicodeFontUrl);
  if (!response.ok) throw new Error('Could not load the bundled Unicode font');
  cachedUnicodeFontBytes = new Uint8Array(await response.arrayBuffer());
  return cachedUnicodeFontBytes;
}

/**
 * Counter-rotates a screen-space rendered canvas back into unrotated PDF user
 * space when the PDF page has a non-zero `/Rotate` entry (90, 180, 270), so
 * `pdfPage.drawImage` at `{ x: boxX, y: boxY, width, height }` aligns with the
 * page's `/Rotate` dictionary without stretching or inversion.
 */
function orientCanvasForPdfPage(
  source: HTMLCanvasElement,
  pageRotationDeg: number
): HTMLCanvasElement {
  const rot = ((pageRotationDeg % 360) + 360) % 360;
  if (rot === 0 || typeof document === 'undefined') return source;
  const out = document.createElement('canvas');
  if (rot === 90 || rot === 270) {
    out.width = source.height;
    out.height = source.width;
  } else {
    out.width = source.width;
    out.height = source.height;
  }
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.save();
  ctx.translate(out.width / 2, out.height / 2);
  // Screen space is rotated clockwise by `rot`; counter-rotate by `-rot`
  ctx.rotate((-rot * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  ctx.restore();
  return out;
}

export interface PDFExportOptions {
  flatten: boolean;
  dpi: 72 | 150 | 300 | 600;
  pageRange?: { start: number; end: number }; // 1-indexed
  /** Exact zero-indexed pages, used by sidebar multi-selection. */
  pageIndices?: number[];
  /**
   * True bakes the on-screen dark theme into the exported pages (the same
   * inversion filter the viewer uses); false/undefined keeps original page
   * colors untouched. Only ever applied when explicitly requested.
   */
  darkMode?: boolean;
  /**
   * When flatten is false, embeds composite annotations (signatures and
   * measurements) onto exported pages so external PDF viewers display them.
   * Defaults to true.
   */
  embedCompositeAnnotations?: boolean;
  /**
   * When true (default), bakes user page rotations from `store.pageRotations`
   * into the exported PDF's `/Rotate` dictionary so external PDF viewers and
   * saved files preserve page rotations. Set to false for in-memory session
   * bytes where `store.pageRotations` remains active on top of native rotation.
   */
  bakePageRotations?: boolean;
  /** Optional user password to encrypt the exported PDF with RC4-128 security. */
  password?: string;
}

export class PDFExporter {
  /**
   * Exports document with annotations.
   */
  public async exportPDF(options: PDFExportOptions = { flatten: true, dpi: 150 }): Promise<Uint8Array> {
    const doc = store.activeDocument;
    if (!doc || !doc.fileData) {
      throw new Error('No PDF document loaded to export');
    }

    // Load original PDF using pdf-lib to preserve structure and metadata
    const pdfDoc = await PDFDocument.load(doc.fileData, { ignoreEncryption: true });
    applyFormValuesToPdfLibDoc(pdfDoc, doc.formValues, options.flatten);
    const fallbackBakedIds = new Set<string>();

    // Bake user-applied page rotations into the PDF /Rotate dictionary when exporting to disk
    if (options.bakePageRotations !== false) {
      const pdfPages = pdfDoc.getPages();
      for (let idx = 0; idx < pdfPages.length; idx++) {
        const userRot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
        if (userRot !== 0) {
          const nativeRot = ((pdfPages[idx].getRotation().angle % 360) + 360) % 360;
          pdfPages[idx].setRotation(degrees((nativeRot + userRot) % 360));
        }
      }
    }

    // Bidirectionally sync Veditor pen/highlighter vector ink into native PDF /Ink dicts
    if (!options.flatten) {
      const normalizedAnnotations: Record<number, any[]> = {};
      for (const [pageKey, list] of Object.entries(doc.annotations)) {
        const pageIdx = Number(pageKey);
        if (!Array.isArray(list)) continue;
        normalizedAnnotations[pageIdx] = list
          .filter((a) => {
            if (a.type === 'stamp' && a.stampType === 'custom') {
              fallbackBakedIds.add(a.id);
              return false;
            }
            return true;
          })
          .map((a) => {
            if (a.type === 'highlighter' && 'quadPoints' in a && Array.isArray(a.quadPoints) && a.quadPoints.length > 0) {
              return { ...a, points: [], blendMode: a.blendMode || 'multiply' };
            }
            return a;
          });
      }

      try {
        await syncNativeAnnotations(pdfDoc, normalizedAnnotations, loadUnicodeFont);
      } catch (err) {
        console.warn('Native annotation sync encountered an unsupported item; falling back to composite bake for affected items:', err);
        for (const list of Object.values(doc.annotations)) {
          if (!Array.isArray(list)) continue;
          for (const a of list) {
            if (['text', 'sticky-note', 'rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'freeform-shape', 'stamp'].includes(a.type) || (a.type === 'highlighter' && 'quadPoints' in a)) {
              fallbackBakedIds.add(a.id);
            }
          }
        }
      }
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

    // Collect composite annotations per page for lossless round-trip restoration
    const compositeStateByPage: Record<number, any[]> = {};
    for (const i of selectedIndices) {
      const pageAnns = doc.annotations[i] || [];
      const comp = pageAnns.filter(
        (a) =>
          a.type === 'signature' ||
          a.type === 'measure-distance' ||
          a.type === 'measure-angle' ||
          a.type === 'measure-area' ||
          (a.type === 'stamp' && a.stampType === 'custom') ||
          fallbackBakedIds.has(a.id)
      );
      if (comp.length > 0) {
        compositeStateByPage[i] = comp;
      }
    }

    for (const i of selectedIndices) {
      const pdfPage = pages[i];
      const pageAnnotations = doc.annotations[i] || [];

      if (!options.darkMode && pageAnnotations.length === 0) continue;

      const crop = pdfPage.getCropBox();
      const media = pdfPage.getMediaBox();
      const boxX = Math.max(crop.x, media.x);
      const boxY = Math.max(crop.y, media.y);
      const width = Math.max(1, Math.min(crop.x + crop.width, media.x + media.width) - boxX);
      const height = Math.max(1, Math.min(crop.y + crop.height, media.y + media.height) - boxY);
      const pageRot = ((pdfPage.getRotation().angle || 0) % 360 + 360) % 360;
      const isOddRot = pageRot === 90 || pageRot === 270;
      const screenWidth = isOddRot ? height : width;
      const screenHeight = isOddRot ? width : height;

      if (options.darkMode && typeof document !== 'undefined') {
        // Dark theme baking: renders the page through the same inversion the
        // viewer applies, then overlays annotations in their original colors.
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

            const orientedCanvas = orientCanvasForPdfPage(darkCanvas, pageRot);
            const jpgBytes = await this.canvasToBytes(orientedCanvas, 'image/jpeg', 0.92);
            const embeddedImg = await pdfDoc.embedJpg(jpgBytes);
            pdfPage.drawImage(embeddedImg, { x: boxX, y: boxY, width, height, opacity: 1.0 });
          }
        }
      } else if (options.flatten && typeof document !== 'undefined') {
        // High-DPI Flattening onto the page content stream
        const dpiScale = options.dpi / 72; // e.g. 150 / 72 = 2.08x

        // Create offscreen canvas in screen-oriented coordinates
        const offCanvas = document.createElement('canvas');
        offCanvas.width = Math.max(1, Math.floor(screenWidth * dpiScale));
        offCanvas.height = Math.max(1, Math.floor(screenHeight * dpiScale));

        const ctx = offCanvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);
          // Render annotations at export scale
          annotationEngine.renderAnnotationsToCanvas(ctx, i, dpiScale);

          const orientedCanvas = orientCanvasForPdfPage(offCanvas, pageRot);
          const pngBytes = await this.canvasToBytes(orientedCanvas, 'image/png');
          const embeddedPng = await pdfDoc.embedPng(pngBytes);
          pdfPage.drawImage(embeddedPng, {
            x: boxX,
            y: boxY,
            width,
            height,
            opacity: 1.0
          });
        }
      } else if (options.embedCompositeAnnotations !== false && typeof document !== 'undefined') {
        // Embed composite annotations (signatures, measurements, custom image stamps,
        // and any fallback items) as a removable /Stamp annotation (VEditorComposite = 1)
        // so external PDF viewers display them while VEditor can cleanly strip/update them.
        const compositeAnns = compositeStateByPage[i] || [];
        if (compositeAnns.length > 0) {
          const dpiScale = (options.dpi || 150) / 72;
          const offCanvas = document.createElement('canvas');
          offCanvas.width = Math.max(1, Math.floor(screenWidth * dpiScale));
          offCanvas.height = Math.max(1, Math.floor(screenHeight * dpiScale));
          const ctx = offCanvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);
            annotationEngine.renderCommittedAnnotations(ctx, compositeAnns, [], dpiScale);
            const orientedCanvas = orientCanvasForPdfPage(offCanvas, pageRot);
            const pngBytes = await this.canvasToBytes(orientedCanvas, 'image/png');
            const embeddedPng = await pdfDoc.embedPng(pngBytes);

            const rect = [boxX, boxY, boxX + width, boxY + height];
            const streamOps = `q\n${width.toFixed(4)} 0 0 ${height.toFixed(4)} ${boxX.toFixed(4)} ${boxY.toFixed(4)} cm\n/Im0 Do\nQ\n`;
            const formStream = pdfDoc.context.flateStream(streamOps, {
              Type: 'XObject',
              Subtype: 'Form',
              FormType: 1,
              BBox: rect,
              Matrix: [1, 0, 0, 1, 0, 0],
              Resources: {
                XObject: { Im0: embeddedPng.ref }
              }
            });
            const formRef = pdfDoc.context.register(formStream);
            const compDict = pdfDoc.context.obj({
              Type: 'Annot',
              Subtype: 'Stamp',
              NM: PDFHexString.fromText(`veditor-composite-${i}`),
              VEditorComposite: PDFNumber.of(1),
              F: PDFNumber.of(4),
              Rect: rect,
              AP: { N: formRef }
            }) as PDFDict;
            const compRef = pdfDoc.context.register(compDict);
            const existingAnnots = pdfPage.node.Annots();
            const keptAnnots: any[] = [];
            if (existingAnnots instanceof PDFArray) {
              for (let k = 0; k < existingAnnots.size(); k++) {
                const rawItem = existingAnnots.get(k);
                const d = pdfDoc.context.lookup(rawItem);
                if (d instanceof PDFDict && d.lookupMaybe(PDFName.of('VEditorComposite'), PDFNumber)?.asNumber() === 1) {
                  continue;
                }
                keptAnnots.push(rawItem);
              }
            }
            keptAnnots.push(compRef);
            pdfPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj(keptAnnots));
          }
        }
      }
    }

    const writeVEditorCatalogState = (targetDoc: PDFDocument, pageMapping?: number[]) => {
      if (options.flatten) {
        targetDoc.catalog.delete(PDFName.of('VEditorState'));
        return;
      }
      const rawBookmarks = doc.userBookmarks || [];
      const mappedBookmarks = pageMapping
        ? rawBookmarks
            .map((bm) => {
              const newPageIdx = pageMapping.indexOf(bm.pageIndex);
              return newPageIdx >= 0 ? { ...bm, pageIndex: newPageIdx } : null;
            })
            .filter((bm): bm is NonNullable<typeof bm> => bm !== null)
        : rawBookmarks;

      const mappedComposite: Record<number, any[]> = {};
      if (pageMapping) {
        pageMapping.forEach((origPageIdx, newPageIdx) => {
          const list = compositeStateByPage[origPageIdx];
          if (list && list.length > 0) {
            mappedComposite[newPageIdx] = list.map(a => ({ ...a, pageIndex: newPageIdx }));
          }
        });
      } else {
        for (const [k, list] of Object.entries(compositeStateByPage)) {
          if (list && list.length > 0) mappedComposite[Number(k)] = list;
        }
      }

      const formValues = doc.formValues && Object.keys(doc.formValues).length > 0
        ? doc.formValues
        : undefined;

      if (mappedBookmarks.length === 0 && Object.keys(mappedComposite).length === 0 && !formValues) {
        targetDoc.catalog.delete(PDFName.of('VEditorState'));
        return;
      }

      const statePayload = JSON.stringify({
        version: 4,
        userBookmarks: mappedBookmarks,
        compositeAnnotations: mappedComposite,
        ...(formValues ? { formValues } : {})
      });
      targetDoc.catalog.set(PDFName.of('VEditorState'), PDFHexString.fromText(statePayload));
    };

    // Copy selected pages into a fresh document. This is more reliable than
    // removing pages in-place across Firefox's pdf-lib worker boundary, and
    // it supports non-contiguous sidebar selections.
    if (options.pageRange || options.pageIndices?.length) {
      const selectedDocument = await PDFDocument.create();
      const copiedPages = await selectedDocument.copyPages(pdfDoc, selectedIndices);
      copiedPages.forEach(page => selectedDocument.addPage(page));
      writeVEditorCatalogState(selectedDocument, selectedIndices);
      if (options.password) {
        return encryptAndSavePdfDocument(selectedDocument, options.password);
      }
      return selectedDocument.save();
    }

    writeVEditorCatalogState(pdfDoc);
    if (options.password) {
      return encryptAndSavePdfDocument(pdfDoc, options.password);
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
