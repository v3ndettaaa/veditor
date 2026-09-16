/**
 * Bypasses a real-world PDF-annotation-tool quirk: apps like PDF Annotator
 * save freehand ink as a native PDF /Ink annotation whose appearance stream
 * (/AP) is a rasterized image baked at a fixed, usually low (72–96), DPI.
 * Any viewer that trusts that /AP — pdf.js included — draws that raster
 * as-is, so the strokes look chalky and jagged the moment you zoom in.
 *
 * The fix has two independent halves:
 *  - `stripNativeInkAnnotations` (here) removes the /Ink entries from a
 *    pdf-lib document before it's rendered or exported, so neither the
 *    on-screen pdf.js viewer nor a Save/Export ever draws the baked raster.
 *  - `pdfEngine.extractNativeInkStrokes` reads those same annotations' raw
 *    vector /InkList coordinates — never the /AP — and reconstructs them as
 *    ordinary veditor pen strokes, so they render through the same smoothed,
 *    resolution-independent spline pipeline as hand-drawn ones.
 */
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';

/** Cheap presence check so PDFs with no ink annotations skip the pdf-lib parse entirely. */
export function bytesMayContainInkAnnotations(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes).includes('/Ink');
}

const INK_NAME = PDFName.of('Ink').asString();

/** Removes every /Subtype /Ink annotation from `pdfDoc`, in place. Returns whether anything changed. */
export function stripNativeInkAnnotations(pdfDoc: PDFDocument): boolean {
  let changed = false;
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept: any[] = [];
    let pageChanged = false;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
      if (subtype?.asString() === INK_NAME) {
        pageChanged = true;
        continue;
      }
      kept.push(annots.get(i));
    }
    if (pageChanged) {
      changed = true;
      page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(kept));
    }
  }
  return changed;
}

/** Loads `bytes`, strips native /Ink annotations, and re-serializes. Returns the original bytes untouched on any failure. */
export async function stripNativeInkAnnotationsFromBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!bytesMayContainInkAnnotations(bytes)) return bytes;
  try {
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const changed = stripNativeInkAnnotations(pdfDoc);
    if (!changed) return bytes;
    return await pdfDoc.save({ useObjectStreams: false });
  } catch (e) {
    console.warn('Could not strip native Ink annotations; showing the PDF unmodified:', e);
    return bytes;
  }
}
