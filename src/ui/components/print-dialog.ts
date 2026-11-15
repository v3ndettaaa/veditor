/**
 * Print Preview Studio & Zero-Lag Print Engine
 * Browser-grade split-pane preview studio with live sheet thumbnails, N-up layout (1 / 2 / 4),
 * Color / Grayscale / Dark modes, custom page ranges, annotation toggle, and async Blob printing.
 */

import { PDFDocument } from 'pdf-lib';
import { store } from '../../core/store';
import { pdfEngine } from '../../core/pdf-engine';
import { annotationEngine } from '../../annotations/engine';
import { renderPageFormValuesToCanvas } from '../../core/pdf-forms';
import { pdfExporter } from '../../io/export-pdf';
import { getIconSvg } from '../../utils/icons';
import { showToast } from './toast';
import { tr } from '../i18n';

import {
  parsePrintPageRange,
  groupPagesIntoSheets,
  buildPrintPageCss,
  type PrintPagesPerSheet
} from '../../core/print-utils';

export { parsePrintPageRange, groupPagesIntoSheets, type PrintPagesPerSheet };
export type PrintColorMode = 'color' | 'grayscale' | 'dark';

export interface PrintOptions {
  pageIndices: number[];
  includeAnnotations: boolean;
  dpi: 150 | 300;
  colorMode: PrintColorMode;
  pagesPerSheet: PrintPagesPerSheet;
}

export interface RenderedSheetAsset {
  url: string;
  isObjectUrl: boolean;
  pngBytes: Uint8Array;
  width: number;
  height: number;
}

export interface ExecutePrintResult {
  opened: boolean;
  blockedBySandbox?: boolean;
  sheets: RenderedSheetAsset[];
  releaseSheets: () => void;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function canvasToPngAsset(canvas: HTMLCanvasElement): Promise<RenderedSheetAsset> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (blob) {
          const pngBytes = new Uint8Array(await blob.arrayBuffer());
          resolve({
            url: URL.createObjectURL(blob),
            isObjectUrl: true,
            pngBytes,
            width: canvas.width,
            height: canvas.height
          });
        } else {
          try {
            const dataUrl = canvas.toDataURL('image/png');
            const b64 = dataUrl.split(',')[1] || '';
            const bin = atob(b64);
            const pngBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) pngBytes[i] = bin.charCodeAt(i);
            resolve({
              url: dataUrl,
              isObjectUrl: false,
              pngBytes,
              width: canvas.width,
              height: canvas.height
            });
          } catch (err) {
            reject(err);
          }
        }
      },
      'image/png'
    );
  });
}

async function renderSinglePrintPageCanvas(
  pageIdx: number,
  scale: number,
  includeAnnotations: boolean,
  colorMode: PrintColorMode
): Promise<HTMLCanvasElement> {
  const userRot = store.pageRotations[pageIdx] || 0;
  const baseCanvas = document.createElement('canvas');
  await pdfEngine.renderPageAtScale(pageIdx, baseCanvas, scale, userRot);

  let working = baseCanvas;
  if (colorMode === 'dark') {
    const darkCanvas = document.createElement('canvas');
    darkCanvas.width = baseCanvas.width;
    darkCanvas.height = baseCanvas.height;
    const dctx = darkCanvas.getContext('2d');
    if (dctx) {
      dctx.filter = 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(1.05)';
      dctx.drawImage(baseCanvas, 0, 0);
      dctx.filter = 'none';
      working = darkCanvas;
    }
  }

  if (includeAnnotations) {
    const ctx = working.getContext('2d');
    const doc = store.activeDocument;
    if (ctx && doc) {
      const anns = doc.annotations[pageIdx] || [];
      const layers = doc.layers[pageIdx] || [];
      if (anns.length > 0) {
        annotationEngine.renderCommittedAnnotations(ctx, anns, layers, scale);
      }
      await renderPageFormValuesToCanvas(ctx, pageIdx, scale, userRot);
    }
  }

  if (colorMode === 'grayscale') {
    const grayCanvas = document.createElement('canvas');
    grayCanvas.width = working.width;
    grayCanvas.height = working.height;
    const gctx = grayCanvas.getContext('2d');
    if (gctx) {
      gctx.filter = 'grayscale(1)';
      gctx.drawImage(working, 0, 0);
      gctx.filter = 'none';
      working = grayCanvas;
    }
  }

  return working;
}

async function composeSheetCanvas(
  sheetPages: number[],
  scale: number,
  pagesPerSheet: PrintPagesPerSheet,
  includeAnnotations: boolean,
  colorMode: PrintColorMode
): Promise<HTMLCanvasElement> {
  if (pagesPerSheet === 1) {
    return renderSinglePrintPageCanvas(sheetPages[0], scale, includeAnnotations, colorMode);
  }

  const pageCanvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < sheetPages.length; i++) {
    pageCanvases.push(await renderSinglePrintPageCanvas(sheetPages[i], scale, includeAnnotations, colorMode));
    if (i > 0 && i % 4 === 0) await nextAnimationFrame();
  }

  const refW = Math.max(1, pageCanvases[0]?.width || 800);
  const refH = Math.max(1, pageCanvases[0]?.height || 1035);
  const cols = 2;
  const rows = pagesPerSheet === 4 ? 2 : 1;
  const gap = Math.round(refW * 0.035);
  const margin = Math.round(refW * 0.045);

  const cellW = refW;
  const cellH = refH;
  const sheetW = margin * 2 + cols * cellW + (cols - 1) * gap;
  const sheetH = margin * 2 + rows * cellH + (rows - 1) * gap;

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = sheetW;
  sheetCanvas.height = sheetH;
  const sctx = sheetCanvas.getContext('2d');
  if (!sctx) return pageCanvases[0];

  sctx.fillStyle = colorMode === 'dark' ? '#111318' : '#ffffff';
  sctx.fillRect(0, 0, sheetW, sheetH);

  pageCanvases.forEach((pCanvas, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const slotX = margin + col * (cellW + gap);
    const slotY = margin + row * (cellH + gap);
    const fit = Math.min(cellW / Math.max(1, pCanvas.width), cellH / Math.max(1, pCanvas.height));
    const drawW = pCanvas.width * fit;
    const drawH = pCanvas.height * fit;
    const drawX = slotX + (cellW - drawW) / 2;
    const drawY = slotY + (cellH - drawH) / 2;
    sctx.drawImage(pCanvas, drawX, drawY, drawW, drawH);
    pCanvas.width = 0;
    pCanvas.height = 0;
  });

  return sheetCanvas;
}

/** Builds a downloadable PDF byte buffer from formatted sheet assets. */
export async function buildPrintablePdfBytesFromSheets(
  sheets: RenderedSheetAsset[]
): Promise<Uint8Array | null> {
  if (sheets.length === 0) return null;
  const outDoc = await PDFDocument.create();
  for (const s of sheets) {
    const embedded = await outDoc.embedPng(s.pngBytes);
    const scalePt = 72 / 150;
    const wPt = Math.max(100, s.width * scalePt);
    const hPt = Math.max(100, s.height * scalePt);
    const page = outDoc.addPage([wPt, hPt]);
    page.drawImage(embedded, { x: 0, y: 0, width: wPt, height: hPt });
  }
  return outDoc.save();
}

function triggerBlobDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as any], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Builds and triggers a downloadable PDF directly without async picker gesture expiration. */
export async function downloadPrintablePdfFromSheets(
  sheets: RenderedSheetAsset[],
  docName: string,
  prebuiltBytes?: Uint8Array | null
): Promise<void> {
  const pdfBytes = prebuiltBytes && prebuiltBytes.length > 0
    ? prebuiltBytes
    : await buildPrintablePdfBytesFromSheets(sheets);
  if (!pdfBytes || pdfBytes.length === 0) {
    throw new Error('No printable pages available');
  }
  const baseName = (docName || 'Document').replace(/\.pdf$/i, '');
  const filename = `${baseName}-printable.pdf`;
  const inSubframe = typeof window !== 'undefined' && window.self !== window.top;
  if (inSubframe || !('showSaveFilePicker' in window) || prebuiltBytes === undefined) {
    triggerBlobDownload(pdfBytes, filename);
    return;
  }
  await pdfExporter.saveToFile(pdfBytes, filename);
}

function removePrintDom(): void {
  document.getElementById('veditor-print-root')?.remove();
  document.getElementById('veditor-print-page-style')?.remove();
}

/**
 * Renders requested sheets into `#veditor-print-root` paired with `@media print` CSS,
 * calls `window.print()` directly (preserving main-window printer dialogs across Chrome,
 * Edge, Firefox, Safari, and extension tabs), and verifies `beforeprint` activation.
 */
export async function executeDocumentPrint(opts: PrintOptions): Promise<ExecutePrintResult> {
  const doc = store.activeDocument;
  const noopRelease = () => {};
  if (!doc || opts.pageIndices.length === 0) {
    return { opened: false, sheets: [], releaseSheets: noopRelease };
  }

  const sheetsSpec = groupPagesIntoSheets(opts.pageIndices, opts.pagesPerSheet);
  const rawScale = opts.dpi / 72;
  const effectiveScale = opts.pagesPerSheet === 4
    ? rawScale * 0.65
    : opts.pagesPerSheet === 2
      ? rawScale * 0.82
      : rawScale;

  const sheetAssets: RenderedSheetAsset[] = [];
  for (let i = 0; i < sheetsSpec.length; i++) {
    if (i > 0 && i % 4 === 0) await nextAnimationFrame();
    const sheetCanvas = await composeSheetCanvas(
      sheetsSpec[i],
      effectiveScale,
      opts.pagesPerSheet,
      opts.includeAnnotations,
      opts.colorMode
    );
    const asset = await canvasToPngAsset(sheetCanvas);
    sheetCanvas.width = 0;
    sheetCanvas.height = 0;
    sheetAssets.push(asset);
  }

  let released = false;
  const releaseSheets = () => {
    if (released) return;
    released = true;
    removePrintDom();
    for (const asset of sheetAssets) {
      if (asset.isObjectUrl) URL.revokeObjectURL(asset.url);
    }
  };

  if (sheetAssets.length === 0) {
    return { opened: false, sheets: [], releaseSheets };
  }

  removePrintDom();

  const isLandscape = opts.pagesPerSheet === 2;
  const styleEl = document.createElement('style');
  styleEl.id = 'veditor-print-page-style';
  styleEl.textContent = buildPrintPageCss(isLandscape, opts.colorMode === 'dark');
  document.head.appendChild(styleEl);

  const printRoot = document.createElement('div');
  printRoot.id = 'veditor-print-root';
  printRoot.setAttribute('aria-hidden', 'true');
  for (const asset of sheetAssets) {
    const sheetDiv = document.createElement('div');
    sheetDiv.className = 'veditor-print-sheet';
    const img = document.createElement('img');
    img.src = asset.url;
    img.alt = '';
    sheetDiv.appendChild(img);
    printRoot.appendChild(sheetDiv);
  }
  document.body.appendChild(printRoot);

  const imgs = Array.from(printRoot.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      if (!img.complete) {
        await new Promise<void>((res) => {
          img.onload = () => res();
          img.onerror = () => res();
        });
      }
      if (typeof img.decode === 'function') {
        await img.decode().catch(() => {});
      }
    })
  );

  let beforePrintFired = false;
  let afterPrintFired = false;
  const onBeforePrint = () => {
    beforePrintFired = true;
  };
  const onAfterPrint = () => {
    afterPrintFired = true;
    window.removeEventListener('beforeprint', onBeforePrint);
    releaseSheets();
  };
  window.addEventListener('beforeprint', onBeforePrint, { once: true });
  window.addEventListener('afterprint', onAfterPrint, { once: true });

  let printThrew = false;
  try {
    window.focus?.();
    window.print();
  } catch (err) {
    printThrew = true;
    console.warn('window.print() threw:', err);
  }

  if (!beforePrintFired && !printThrew) {
    await new Promise<void>(r => setTimeout(r, 120));
  }

  if (printThrew || !beforePrintFired) {
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
    removePrintDom();
    return {
      opened: false,
      blockedBySandbox: true,
      sheets: sheetAssets,
      releaseSheets
    };
  }

  if (!afterPrintFired) {
    window.setTimeout(() => {
      releaseSheets();
    }, 60_000);
  }

  return {
    opened: true,
    sheets: sheetAssets,
    releaseSheets
  };
}

let printInFlight = false;

/** Shows a clean recovery modal when the browser/iframe blocks window.print(), pre-baking PDF bytes so download is instant. */
function showPrintFallbackModal(docName: string, sheets: RenderedSheetAsset[], releaseSheets: () => void): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let closed = false;
  let prebuiltBytes: Uint8Array | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    releaseSheets();
    host.remove();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener('keydown', onKey, true);

  host.innerHTML = `
    <div class="modal-overlay" id="print-fallback-overlay">
      <div class="modal-dialog form-dialog print-theme-dialog" role="dialog" aria-modal="true" aria-label="${tr('Print Recovery', 'نسخه آماده چاپ')}">
        <div class="panel-header">
          <span>${getIconSvg('printer', 15)} ${tr('Download Print-Ready PDF', 'دانلود نسخه آماده چاپ (PDF)')}</span>
          <button type="button" id="print-fallback-close" class="icon-btn" aria-label="${tr('Close', 'بستن')}">${getIconSvg('close', 14)}</button>
        </div>
        <div class="form-dialog-body">
          <div class="print-sandbox-notice" role="alert">
            <div class="print-sandbox-notice-msg">
              ${getIconSvg('alertTriangle', 15)}
              <span>${tr(
                'Your browser or embedded preview frame blocked the system print dialog. Download the print-ready PDF file directly to print it.',
                'مرورگر یا قاب پیش‌نمایش اجازه باز شدن پنجره چاپ سیستم را نداد. نسخه آماده چاپ (PDF) را دانلود و چاپ کنید.'
              )}</span>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" id="print-fallback-cancel" class="header-btn">${tr('Cancel', 'بستن')}</button>
            <button type="button" id="print-fallback-pdf-btn" class="header-btn primary">
              ${getIconSvg('download', 14)}
              <span id="print-fallback-btn-label">${tr('Preparing PDF…', 'در حال آماده‌سازی PDF…')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const btn = host.querySelector<HTMLButtonElement>('#print-fallback-pdf-btn');
  const btnLabel = host.querySelector<HTMLElement>('#print-fallback-btn-label');
  if (btn) btn.disabled = true;

  void buildPrintablePdfBytesFromSheets(sheets)
    .then((bytes) => {
      if (closed) return;
      prebuiltBytes = bytes;
      if (btn) btn.disabled = !bytes;
      if (btnLabel) btnLabel.textContent = tr('Download Print-Ready PDF', 'دانلود نسخه آماده چاپ (PDF)');
    })
    .catch(() => {
      if (closed) return;
      if (btn) btn.disabled = false;
      if (btnLabel) btnLabel.textContent = tr('Download Print-Ready PDF', 'دانلود نسخه آماده چاپ (PDF)');
    });

  host.querySelector('#print-fallback-close')?.addEventListener('click', cleanup);
  host.querySelector('#print-fallback-cancel')?.addEventListener('click', cleanup);
  host.querySelector('#print-fallback-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'print-fallback-overlay') cleanup();
  });

  btn?.addEventListener('click', async () => {
    try {
      if (prebuiltBytes && prebuiltBytes.length > 0) {
        const baseName = (docName || 'Document').replace(/\.pdf$/i, '');
        triggerBlobDownload(prebuiltBytes, `${baseName}-printable.pdf`);
      } else {
        await downloadPrintablePdfFromSheets(sheets, docName);
      }
      showToast(tr('Print-ready PDF saved', 'نسخه آماده چاپ (PDF) ذخیره شد'), 'success');
      cleanup();
    } catch (err: any) {
      showToast(tr(`Export failed: ${err?.message || err}`, `خطا در خروجی: ${err?.message || err}`), 'error');
    }
  });
}

async function runDirectBrowserPrint(docName: string, pageCount: number, colorMode: PrintColorMode): Promise<void> {
  if (printInFlight) return;
  printInFlight = true;
  showToast(tr('Preparing print sheets…', 'در حال آماده‌سازی صفحات برای چاپ…'), 'progress');
  try {
    const pageIndices = Array.from({ length: pageCount }, (_, i) => i);
    const result = await executeDocumentPrint({
      pageIndices,
      includeAnnotations: true,
      dpi: 150,
      colorMode,
      pagesPerSheet: 1
    });
    if (result.opened) {
      showToast(tr('Print dialog ready', 'پنجره چاپ آماده شد'), 'success');
    } else if (result.blockedBySandbox) {
      showPrintFallbackModal(docName, result.sheets, result.releaseSheets);
    }
  } catch (err: any) {
    showToast(tr(`Print failed: ${err?.message || err}`, `خطا در چاپ: ${err?.message || err}`), 'error');
  } finally {
    printInFlight = false;
  }
}

/**
 * Triggers printing:
 * - In Light Mode: opens the browser's built-in system print dialog immediately.
 * - In Dark Mode: briefly asks the user whether to print on Light Paper or Dark Mode,
 *   then immediately opens the browser's built-in system print dialog.
 */
export function openPrintDialog(): void {
  const doc = store.activeDocument;
  if (!doc) {
    showToast(tr('Open a PDF document before printing', 'ابتدا یک سند PDF باز کنید'), 'error');
    return;
  }
  if (printInFlight) return;

  const isDarkPdf = Boolean(
    store.appSettings.invertDocumentOled ||
    document.body.classList.contains('invert-pdf-document')
  );

  if (!isDarkPdf) {
    void runDirectBrowserPrint(doc.name, doc.pageCount, 'color');
    return;
  }

  // Dark Mode active: ask user cleanly whether to print in Light Paper or Dark Mode before invoking browser print dialog.
  const host = document.createElement('div');
  document.body.appendChild(host);
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    host.remove();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener('keydown', onKey, true);

  host.innerHTML = `
    <div class="modal-overlay" id="print-theme-overlay">
      <div class="modal-dialog form-dialog print-theme-dialog" role="dialog" aria-modal="true" aria-label="${tr('Print Paper Appearance', 'نحوه چاپ در حالت تاریک')}">
        <div class="panel-header">
          <span>${getIconSvg('printer', 15)} ${tr('Print in Dark Mode', 'نحوه چاپ صفحات')}</span>
          <button type="button" id="print-theme-close" class="icon-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">${getIconSvg('close', 14)}</button>
        </div>
        <div class="form-dialog-body print-theme-body">
          <p class="print-theme-desc">${tr(
            'Dark viewing mode is active. Choose how your printed pages should look before opening the system print dialog:',
            'نمای تاریک فعال است. پیش از باز شدن پنجره چاپ سیستم، حالت کاغذ را انتخاب کنید:'
          )}</p>
          <div class="print-theme-choices">
            <button type="button" id="print-choice-light" class="print-theme-card is-recommended">
              <span class="print-theme-swatch is-light" aria-hidden="true">Aa</span>
              <span class="print-theme-info">
                <span class="print-theme-title">${tr('Light Paper (Recommended)', 'کاغذ روشن (پیشنهادی)')}</span>
                <span class="print-theme-sub">${tr('Crisp white background · saves printer ink', 'پس‌زمینه سفید اصلی · صرفه‌جویی در جوهر')}</span>
              </span>
            </button>
            <button type="button" id="print-choice-dark" class="print-theme-card">
              <span class="print-theme-swatch is-dark" aria-hidden="true">Aa</span>
              <span class="print-theme-info">
                <span class="print-theme-title">${tr('Dark Mode (As Displayed)', 'تم تاریک (مشابه صفحه)')}</span>
                <span class="print-theme-sub">${tr('Dark background · keeps current night look', 'پس‌زمینه تیره مطابق نمای فعلی برنامه')}</span>
              </span>
            </button>
          </div>
          <div class="form-actions">
            <button type="button" id="print-theme-cancel" class="header-btn">${tr('Cancel', 'انصراف')}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  host.querySelector('#print-theme-close')?.addEventListener('click', cleanup);
  host.querySelector('#print-theme-cancel')?.addEventListener('click', cleanup);
  host.querySelector('#print-theme-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'print-theme-overlay') cleanup();
  });

  host.querySelector('#print-choice-light')?.addEventListener('click', () => {
    cleanup();
    void runDirectBrowserPrint(doc.name, doc.pageCount, 'color');
  });

  host.querySelector('#print-choice-dark')?.addEventListener('click', () => {
    cleanup();
    void runDirectBrowserPrint(doc.name, doc.pageCount, 'dark');
  });
}

