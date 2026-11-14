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

async function canvasToPreviewUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(URL.createObjectURL(blob));
        } else {
          try {
            resolve(canvas.toDataURL('image/png'));
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

/** Builds a downloadable PDF file directly from formatted sheet assets. */
export async function downloadPrintablePdfFromSheets(
  sheets: RenderedSheetAsset[],
  docName: string
): Promise<void> {
  if (sheets.length === 0) return;
  const outDoc = await PDFDocument.create();
  for (const s of sheets) {
    const embedded = await outDoc.embedPng(s.pngBytes);
    // Scale to reasonable PDF points (~72 DPI) preserving aspect ratio
    const scalePt = 72 / 150;
    const wPt = Math.max(100, s.width * scalePt);
    const hPt = Math.max(100, s.height * scalePt);
    const page = outDoc.addPage([wPt, hPt]);
    page.drawImage(embedded, { x: 0, y: 0, width: wPt, height: hPt });
  }
  const pdfBytes = await outDoc.save();
  const baseName = (docName || 'Document').replace(/\.pdf$/i, '');
  await pdfExporter.saveToFile(pdfBytes, `${baseName}-printable.pdf`);
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

  // Allow one short tick in case the browser dispatches beforeprint asynchronously
  if (!beforePrintFired && !printThrew) {
    await new Promise<void>(r => setTimeout(r, 120));
  }

  if (printThrew || !beforePrintFired) {
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
    removePrintDom();
    // Retain sheetAssets cleanly so the user can immediately download the Print-Ready PDF fallback
    return {
      opened: false,
      blockedBySandbox: true,
      sheets: sheetAssets,
      releaseSheets
    };
  }

  // Fallback timer in case a browser ignores `afterprint` after closing
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

/**
 * Opens the Split-Pane Print Preview Studio modal.
 */
export function openPrintDialog(): void {
  const doc = store.activeDocument;
  if (!doc) {
    showToast(tr('Open a PDF document before printing', 'ابتدا یک سند PDF باز کنید'), 'error');
    return;
  }

  const pageCount = doc.pageCount;
  const activePageNum = store.activePageIndex + 1;
  const selectedIndices = [...store.selectedPageIndices].sort((a, b) => a - b);

  const host = document.createElement('div');
  document.body.appendChild(host);

  let busy = false;
  let closed = false;
  let rangeMode: 'all' | 'current' | 'selected' | 'custom' = 'all';
  let customRangeRaw = `1-${pageCount}`;
  let pagesPerSheet: PrintPagesPerSheet = 1;
  // Always default to crisp Light Paper color mode so dark UI theme never ruins physical printouts
  let colorMode: PrintColorMode = 'color';
  let dpi: 150 | 300 = 150;
  let includeAnnotations = true;
  let renderGeneration = 0;
  let pendingFallbackRelease: (() => void) | null = null;
  let pendingFallbackSheets: RenderedSheetAsset[] | null = null;

  const clearPendingFallback = () => {
    pendingFallbackRelease?.();
    pendingFallbackRelease = null;
    pendingFallbackSheets = null;
    const notice = host.querySelector<HTMLElement>('#print-sandbox-notice');
    if (notice) notice.hidden = true;
  };

  // Cache rendered low-DPI preview thumbnails keyed by pageIdx|anns|colorMode
  const thumbCache = new Map<string, string>();
  const revokeThumbCache = () => {
    for (const url of thumbCache.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    thumbCache.clear();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    renderGeneration++;
    window.removeEventListener('keydown', onKey, true);
    clearPendingFallback();
    revokeThumbCache();
    host.remove();
  };

  const resolvePageIndices = (): number[] => {
    if (rangeMode === 'all') {
      return Array.from({ length: pageCount }, (_, i) => i);
    }
    if (rangeMode === 'current') {
      return [store.activePageIndex];
    }
    if (rangeMode === 'selected') {
      return selectedIndices.length > 0 ? selectedIndices : [store.activePageIndex];
    }
    return parsePrintPageRange(customRangeRaw, pageCount);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (
      e.key === 'Enter' &&
      (e.target as HTMLElement)?.tagName === 'INPUT' &&
      (e.target as HTMLInputElement).type === 'text'
    ) {
      e.preventDefault();
      e.stopPropagation();
      host.querySelector<HTMLButtonElement>('#print-submit')?.click();
    }
  };
  window.addEventListener('keydown', onKey, true);

  host.innerHTML = `
    <div class="modal-overlay" id="print-overlay">
      <div class="modal-dialog print-studio-dialog" role="dialog" aria-modal="true" aria-label="${tr('Print Preview Studio', 'پیش‌نمایش و تنظیمات چاپ')}">
        <!-- Left Stage: Live Paper Sheet Preview -->
        <div class="print-studio-preview" id="print-preview-stage">
          <div class="print-studio-sheets" id="print-sheets-list"></div>
        </div>

        <!-- Right Inspector: Printer & Sheet Controls -->
        <div class="print-studio-inspector">
          <div class="print-inspector-header">
            <div class="print-inspector-title-group">
              <span class="print-inspector-title">${tr('Print', 'چاپ سند')}</span>
              <span class="print-sheet-summary tabular-nums" id="print-sheet-summary"></span>
            </div>
            <button type="button" id="print-close" class="icon-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">${getIconSvg('close', 14)}</button>
          </div>

          <div class="print-inspector-body">
            <!-- System Printer Destination Info -->
            <div class="print-row">
              <label class="print-row-label" for="print-destination-display">${tr('Destination', 'چاپگر مقصد')}</label>
              <div class="print-row-control">
                <div id="print-destination-display" class="print-dest-box">
                  ${getIconSvg('printer', 14)}
                  <span>${tr('System Printers & PDF', 'چاپگرهای سیستم و Save as PDF')}</span>
                </div>
                <button type="button" id="print-system-link" class="print-system-link">
                  <span>${tr('Open system printer dialog…', 'انتخاب چاپگر و چاپ در پنجره سیستم…')}</span>
                  ${getIconSvg('externalLink', 12)}
                </button>
              </div>
            </div>

            <!-- Pages Selection -->
            <div class="print-row">
              <label class="print-row-label" for="print-pages-select">${tr('Pages', 'صفحات')}</label>
              <div class="print-row-control">
                <select id="print-pages-select" class="field">
                  <option value="all" selected>${tr(`All (${pageCount})`, `همه صفحات (${pageCount})`)}</option>
                  <option value="current">${tr(`Current page (${activePageNum})`, `صفحه فعلی (${activePageNum})`)}</option>
                  ${selectedIndices.length > 0 ? `<option value="selected">${tr(`Selected in sidebar (${selectedIndices.length})`, `صفحات انتخابی (${selectedIndices.length})`)}</option>` : ''}
                  <option value="custom">${tr('Custom range…', 'بازه دلخواه…')}</option>
                </select>
                <input id="print-custom-input" class="field tabular-nums" type="text" placeholder="${tr('e.g. 1-3, 5', 'مثلاً 1-3, 5')}" value="1-${pageCount}" hidden />
                <div id="print-range-error" class="saveas-pwd-error" hidden></div>
              </div>
            </div>

            <!-- Pages Per Sheet (1 / 2 / 4) -->
            <div class="print-row">
              <span class="print-row-label">${tr('Pages per sheet', 'صفحه در هر برگ')}</span>
              <div class="print-row-control">
                <div class="print-segmented" role="group" aria-label="${tr('Pages per sheet', 'تعداد صفحه در هر برگ')}">
                  <button type="button" class="print-seg-btn active" data-print-nup="1">1</button>
                  <button type="button" class="print-seg-btn" data-print-nup="2">2</button>
                  <button type="button" class="print-seg-btn" data-print-nup="4">4</button>
                </div>
              </div>
            </div>

            <!-- Color Mode -->
            <div class="print-row">
              <label class="print-row-label" for="print-color-select">${tr('Color mode', 'حالت رنگ')}</label>
              <div class="print-row-control">
                <select id="print-color-select" class="field">
                  <option value="color" selected>${tr('Color (Light Paper)', 'رنگی (کاغذ روشن)')}</option>
                  <option value="grayscale">${tr('Black & White (Grayscale)', 'سیاه‌وسفید (Grayscale)')}</option>
                  <option value="dark">${tr('Dark Theme (Night Mode)', 'تم تاریک (حالت شب)')}</option>
                </select>
              </div>
            </div>

            <!-- Quality -->
            <div class="print-row">
              <label class="print-row-label" for="print-dpi">${tr('Quality', 'کیفیت چاپ')}</label>
              <div class="print-row-control">
                <select id="print-dpi" class="field">
                  <option value="150" selected>${tr('150 DPI — Standard', '۱۵۰ DPI — استاندارد')}</option>
                  <option value="300">${tr('300 DPI — High Resolution', '۳۰۰ DPI — وضوح بالا')}</option>
                </select>
              </div>
            </div>

            <!-- Include Annotations & Forms -->
            <div class="print-row print-row-options">
              <span class="print-row-label">${tr('Options', 'تنظیمات')}</span>
              <div class="print-row-control">
                <label class="saveas-check-row">
                  <input id="print-include-anns" type="checkbox" checked />
                  <span>${tr('Annotations & form fields', 'حاشیه‌نویسی‌ها و فرم‌ها')}</span>
                </label>
              </div>
            </div>

            <!-- Honest notice if the host browser/iframe sandbox blocks window.print() -->
            <div id="print-sandbox-notice" class="print-sandbox-notice" role="alert" hidden>
              <div class="print-sandbox-notice-msg">
                ${getIconSvg('alertTriangle', 15)}
                <span>${tr(
                  'Your browser or embedded preview frame blocked the system print dialog. Download a print-ready PDF copy below to print directly.',
                  'مرورگر یا قاب پیش‌نمایش جاسازی‌شده اجازه باز شدن پنجره چاپ سیستم را نداد. برای چاپ می‌توانید نسخه آماده چاپ PDF را دانلود کنید.'
                )}</span>
              </div>
              <button type="button" id="print-fallback-pdf-btn" class="header-btn primary">
                ${getIconSvg('download', 14)}
                <span>${tr('Download Print-Ready PDF', 'دانلود نسخه آماده چاپ (PDF)')}</span>
              </button>
            </div>
          </div>

          <div class="print-inspector-footer">
            <button type="button" id="print-cancel" class="header-btn">${tr('Cancel', 'انصراف')}</button>
            <button type="button" id="print-submit" class="header-btn primary">
              ${getIconSvg('printer', 14)}
              <span id="print-submit-label">${tr('Print…', 'چاپ…')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const sheetsEl = q<HTMLElement>('#print-sheets-list')!;
  const summaryEl = q<HTMLElement>('#print-sheet-summary')!;
  const rangeErrEl = q<HTMLElement>('#print-range-error')!;
  const sandboxNoticeEl = q<HTMLElement>('#print-sandbox-notice');
  const submitBtn = q<HTMLButtonElement>('#print-submit');
  const submitLabel = q<HTMLElement>('#print-submit-label');
  const systemLinkBtn = q<HTMLButtonElement>('#print-system-link');

  const updatePreview = async () => {
    clearPendingFallback();
    const gen = ++renderGeneration;
    const indices = resolvePageIndices();
    const sheets = groupPagesIntoSheets(indices, pagesPerSheet);

    if (rangeMode === 'custom' && indices.length === 0) {
      rangeErrEl.hidden = false;
      rangeErrEl.textContent = tr('Enter valid pages (e.g. 1-3, 5)', 'بازه معتبر وارد کنید (مثلاً 1-3, 5)');
    } else {
      rangeErrEl.hidden = true;
      rangeErrEl.textContent = '';
    }

    summaryEl.textContent = sheets.length === 0
      ? tr('0 sheets', '۰ برگ')
      : sheets.length === 1
        ? tr('1 sheet of paper', '۱ برگ کاغذ')
        : tr(`${sheets.length} sheets of paper`, `${sheets.length} برگ کاغذ`);

    if (sheets.length === 0) {
      sheetsEl.innerHTML = `<div class="print-preview-empty">${tr('No pages selected in range.', 'صفحه‌ای در این بازه وجود ندارد.')}</div>`;
      return;
    }

    // Build crisp paper sheet DOM placeholders immediately (zero jank)
    sheetsEl.innerHTML = sheets
      .map((sheetPages, sIdx) => {
        const slots = sheetPages
          .map(
            (pIdx) => `
            <div class="print-sheet-slot" data-preview-page="${pIdx}">
              <div class="print-slot-loading"></div>
            </div>
          `
          )
          .join('');
        return `
          <div class="print-sheet-wrapper">
            <div class="print-paper-sheet is-nup-${pagesPerSheet} ${colorMode === 'dark' ? 'is-dark-paper' : ''}">
              ${slots}
            </div>
            <div class="print-sheet-caption tabular-nums">${tr(`Sheet ${sIdx + 1} · Pages ${sheetPages.map(p => p + 1).join(', ')}`, `برگ ${sIdx + 1} · صفحات ${sheetPages.map(p => p + 1).join('، ')}`)}</div>
          </div>
        `;
      })
      .join('');

    // Render preview page thumbnails incrementally across frames so UI never freezes
    const previewScale = pagesPerSheet === 4 ? 0.55 : pagesPerSheet === 2 ? 0.72 : 0.95;
    for (const pIdx of indices) {
      if (closed || gen !== renderGeneration) return;
      const cacheKey = `${pIdx}|${includeAnnotations}|${colorMode}|${pagesPerSheet}`;
      let url = thumbCache.get(cacheKey);
      if (!url) {
        await nextAnimationFrame();
        if (closed || gen !== renderGeneration) return;
        const pageCanvas = await renderSinglePrintPageCanvas(pIdx, previewScale, includeAnnotations, colorMode);
        if (closed || gen !== renderGeneration) {
          pageCanvas.width = 0;
          pageCanvas.height = 0;
          return;
        }
        url = await canvasToPreviewUrl(pageCanvas);
        pageCanvas.width = 0;
        pageCanvas.height = 0;
        if (closed || gen !== renderGeneration) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          return;
        }
        thumbCache.set(cacheKey, url);
      }

      const slot = sheetsEl.querySelector<HTMLElement>(`.print-sheet-slot[data-preview-page="${pIdx}"]`);
      if (slot) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = `Page ${pIdx + 1} print preview`;
        img.decoding = 'async';
        slot.innerHTML = '';
        slot.appendChild(img);
      }
    }
  };

  q('#print-close')?.addEventListener('click', close);
  q('#print-cancel')?.addEventListener('click', close);
  q('#print-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'print-overlay' && !busy) close();
  });

  const pagesSelect = q<HTMLSelectElement>('#print-pages-select');
  const customInput = q<HTMLInputElement>('#print-custom-input');
  let customDebounce: number | null = null;

  pagesSelect?.addEventListener('change', () => {
    rangeMode = (pagesSelect.value as typeof rangeMode) || 'all';
    if (customInput) {
      customInput.hidden = rangeMode !== 'custom';
      if (rangeMode === 'custom') {
        requestAnimationFrame(() => {
          customInput.focus();
          customInput.select();
        });
      }
    }
    void updatePreview();
  });

  customInput?.addEventListener('input', () => {
    customRangeRaw = customInput.value;
    if (customDebounce !== null) window.clearTimeout(customDebounce);
    customDebounce = window.setTimeout(() => {
      customDebounce = null;
      void updatePreview();
    }, 180);
  });

  host.querySelectorAll<HTMLButtonElement>('[data-print-nup]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = Number(btn.getAttribute('data-print-nup') || 1) as PrintPagesPerSheet;
      pagesPerSheet = n === 2 || n === 4 ? n : 1;
      host.querySelectorAll('[data-print-nup]').forEach(el => {
        el.classList.toggle('active', el === btn);
      });
      void updatePreview();
    });
  });

  q<HTMLSelectElement>('#print-color-select')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value as PrintColorMode;
    colorMode = val === 'grayscale' || val === 'dark' ? val : 'color';
    void updatePreview();
  });

  q<HTMLSelectElement>('#print-dpi')?.addEventListener('change', (e) => {
    clearPendingFallback();
    dpi = Number((e.target as HTMLSelectElement).value) === 300 ? 300 : 150;
  });

  q<HTMLInputElement>('#print-include-anns')?.addEventListener('change', (e) => {
    includeAnnotations = (e.target as HTMLInputElement).checked;
    void updatePreview();
  });

  q('#print-fallback-pdf-btn')?.addEventListener('click', async () => {
    if (!pendingFallbackSheets || pendingFallbackSheets.length === 0) return;
    const btn = q<HTMLButtonElement>('#print-fallback-pdf-btn');
    if (btn) btn.disabled = true;
    try {
      await downloadPrintablePdfFromSheets(pendingFallbackSheets, doc.name);
      showToast(tr('Print-ready PDF saved', 'نسخه آماده چاپ (PDF) ذخیره شد'), 'success');
      close();
    } catch (err: any) {
      showToast(tr(`Export failed: ${err?.message || err}`, `خطا در خروجی: ${err?.message || err}`), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  const setPrintBusy = (state: boolean) => {
    busy = state;
    if (submitBtn) submitBtn.disabled = state;
    if (systemLinkBtn) systemLinkBtn.disabled = state;
    if (submitLabel) {
      submitLabel.textContent = state
        ? tr('Preparing…', 'در حال آماده‌سازی…')
        : tr('Print…', 'چاپ…');
    }
  };

  const triggerPrintRun = async () => {
    if (busy || closed) return;
    const pageIndices = resolvePageIndices();
    if (pageIndices.length === 0) {
      showToast(tr('Please enter a valid page range (e.g. 1-3, 5)', 'لطفاً یک بازه صفحه معتبر وارد کنید (مثلاً 1-3, 5)'), 'error');
      customInput?.focus();
      return;
    }

    clearPendingFallback();
    setPrintBusy(true);
    try {
      const result = await executeDocumentPrint({
        pageIndices,
        includeAnnotations,
        dpi,
        colorMode,
        pagesPerSheet
      });

      if (result.opened) {
        showToast(tr('Print dialog ready', 'پنجره چاپ آماده شد'), 'success');
        close();
      } else if (result.blockedBySandbox) {
        pendingFallbackSheets = result.sheets;
        pendingFallbackRelease = result.releaseSheets;
        if (sandboxNoticeEl) sandboxNoticeEl.hidden = false;
        showToast(
          tr(
            'System print dialog is blocked in this embedded preview frame. Use Download Print-Ready PDF instead.',
            'پنجره چاپ سیستم در این قاب پیش‌نمایش مسدود است؛ از دکمه دانلود PDF آماده چاپ استفاده کنید.'
          ),
          'info'
        );
      }
    } catch (err: any) {
      showToast(tr(`Print failed: ${err?.message || err}`, `خطا در چاپ: ${err?.message || err}`), 'error');
    } finally {
      if (!closed) setPrintBusy(false);
    }
  };

  submitBtn?.addEventListener('click', () => {
    void triggerPrintRun();
  });
  systemLinkBtn?.addEventListener('click', () => {
    void triggerPrintRun();
  });

  // Kick off live preview rendering asynchronously without blocking modal open
  void updatePreview();
}

