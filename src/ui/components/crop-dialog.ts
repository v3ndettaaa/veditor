/**
 * Interactive Crop Page Modal Controller
 * Renders a live page preview with an 8-handle interactive crop frame,
 * numeric margin inputs (in PDF points), and scope selection (Current Page,
 * All Pages, or Custom Range). Applies non-destructive PDF MediaBox/CropBox
 * modifications via `pageActions.cropPages` and `pageActions.resetPageCrops`.
 */

import { pageActions } from '../../core/page-actions';
import { pdfEngine } from '../../core/pdf-engine';
import { store } from '../../core/store';
import { PageCropMargins } from '../../core/types';
import { rotatedPageSize } from '../../core/viewport';
import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';
import { showToast } from './toast';

type CropScope = 'current' | 'all' | 'range';
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

function parsePageRangeInput(raw: string, pageCount: number): number[] {
  const result = new Set<number>();
  const parts = raw.split(/[,;]+/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(pageCount, Math.max(a, b));
      for (let p = start; p <= end; p++) result.add(p - 1);
    } else {
      const single = parseInt(trimmed, 10);
      if (Number.isFinite(single) && single >= 1 && single <= pageCount) {
        result.add(single - 1);
      }
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

class CropDialogController {
  private _backdrop: HTMLElement | null = null;
  private _pageIndex = 0;
  private _pageWidthPt = 612;
  private _pageHeightPt = 792;
  private _previewScale = 1;
  private _margins: PageCropMargins = { top: 24, right: 24, bottom: 24, left: 24 };
  private _scope: CropScope = 'current';
  private _rangeStr = '';
  private _escHandler: ((e: KeyboardEvent) => void) | null = null;

  public async open(initialPageIndex?: number): Promise<void> {
    const doc = store.activeDocument;
    if (!doc || !doc.fileData) return;
    if (doc.notebook) {
      showToast(
        tr('Notebook pages have fixed template dimensions', 'صفحات دفترچه دارای ابعاد قالب ثابت هستند'),
        'info'
      );
      return;
    }

    this.closeImmediate();

    const pageIdx = initialPageIndex !== undefined
      ? Math.max(0, Math.min(doc.pageCount - 1, initialPageIndex))
      : Math.max(0, Math.min(doc.pageCount - 1, store.activePageIndex || 0));
    this._pageIndex = pageIdx;

    const pageInfo = doc.pages[pageIdx] || doc.pages[0];
    const userRot = store.pageRotations[pageIdx] || 0;
    const size = rotatedPageSize(pageInfo, userRot);
    this._pageWidthPt = Math.max(72, Math.round(size.width));
    this._pageHeightPt = Math.max(72, Math.round(size.height));

    // Default initial crop inset: 5% on each side so the user immediately sees the handles
    const defaultInsetX = Math.round(this._pageWidthPt * 0.05);
    const defaultInsetY = Math.round(this._pageHeightPt * 0.05);
    this._margins = {
      top: defaultInsetY,
      right: defaultInsetX,
      bottom: defaultInsetY,
      left: defaultInsetX
    };

    const selected = store.effectivePageSelection(pageIdx);
    const initialScope: string = selected.length > 1 ? 'range' : 'current';
    this._scope = initialScope as CropScope;
    this._rangeStr = selected.length > 1
      ? this.formatIndicesAsRange(selected)
      : `${pageIdx + 1}-${doc.pageCount}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop crop-modal-backdrop';
    backdrop.id = 'crop-page-modal-backdrop';

    backdrop.innerHTML = `
      <div class="crop-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="crop-modal-title">
        <div class="crop-modal-header">
          <div class="crop-modal-title-wrap">
            <span class="crop-modal-icon">${getIconSvg('crop', 18)}</span>
            <div>
              <h3 class="crop-modal-title" id="crop-modal-title">${tr('Crop Page Margins', 'برش حاشیه صفحات')}</h3>
              <span class="crop-modal-subtitle">${tr(`Page ${pageIdx + 1} of ${doc.pageCount}`, `صفحه ${pageIdx + 1} از ${doc.pageCount}`)}</span>
            </div>
          </div>
          <button type="button" class="icon-btn" id="btn-close-crop-modal" title="${t('common.close')}" aria-label="${t('common.close')}">
            ${getIconSvg('close', 16)}
          </button>
        </div>

        <div class="crop-modal-body">
          <div class="crop-preview-column">
            <div class="crop-preview-stage" id="crop-preview-stage">
              <div class="crop-canvas-wrap" id="crop-canvas-wrap">
                <canvas id="crop-preview-canvas" class="crop-preview-canvas"></canvas>
                <div class="crop-selection-shade crop-shade-top" id="crop-shade-top"></div>
                <div class="crop-selection-shade crop-shade-bottom" id="crop-shade-bottom"></div>
                <div class="crop-selection-shade crop-shade-left" id="crop-shade-left"></div>
                <div class="crop-selection-shade crop-shade-right" id="crop-shade-right"></div>
                <div class="crop-box-overlay" id="crop-box-overlay" data-handle="move">
                  <div class="crop-grid-line crop-grid-h1"></div>
                  <div class="crop-grid-line crop-grid-h2"></div>
                  <div class="crop-grid-line crop-grid-v1"></div>
                  <div class="crop-grid-line crop-grid-v2"></div>
                  <span class="crop-handle crop-handle-nw" data-handle="nw"></span>
                  <span class="crop-handle crop-handle-n" data-handle="n"></span>
                  <span class="crop-handle crop-handle-ne" data-handle="ne"></span>
                  <span class="crop-handle crop-handle-e" data-handle="e"></span>
                  <span class="crop-handle crop-handle-se" data-handle="se"></span>
                  <span class="crop-handle crop-handle-s" data-handle="s"></span>
                  <span class="crop-handle crop-handle-sw" data-handle="sw"></span>
                  <span class="crop-handle crop-handle-w" data-handle="w"></span>
                </div>
              </div>
            </div>
            <div class="crop-dimensions-pill" id="crop-dimensions-readout"></div>
          </div>

          <div class="crop-controls-column">
            <div class="crop-control-group">
              <div class="crop-group-header">
                <span class="crop-group-label">${tr('Margin Offsets (pt)', 'اندازه برش از لبه‌ها (پوینت)')}</span>
              </div>
              <div class="crop-margins-grid">
                <label class="crop-input-field">
                  <span class="crop-input-label">${tr('Top', 'بالا')}</span>
                  <div class="crop-input-box">
                    <input type="number" id="crop-in-top" min="0" step="1" value="${this._margins.top}" />
                    <span class="crop-input-unit">pt</span>
                  </div>
                </label>
                <label class="crop-input-field">
                  <span class="crop-input-label">${tr('Bottom', 'پایین')}</span>
                  <div class="crop-input-box">
                    <input type="number" id="crop-in-bottom" min="0" step="1" value="${this._margins.bottom}" />
                    <span class="crop-input-unit">pt</span>
                  </div>
                </label>
                <label class="crop-input-field">
                  <span class="crop-input-label">${tr('Left', 'چپ')}</span>
                  <div class="crop-input-box">
                    <input type="number" id="crop-in-left" min="0" step="1" value="${this._margins.left}" />
                    <span class="crop-input-unit">pt</span>
                  </div>
                </label>
                <label class="crop-input-field">
                  <span class="crop-input-label">${tr('Right', 'راست')}</span>
                  <div class="crop-input-box">
                    <input type="number" id="crop-in-right" min="0" step="1" value="${this._margins.right}" />
                    <span class="crop-input-unit">pt</span>
                  </div>
                </label>
              </div>
              <div class="crop-quick-presets">
                <button type="button" class="crop-preset-btn" data-preset="zero">${tr('0 pt', 'بدون برش')}</button>
                <button type="button" class="crop-preset-btn" data-preset="tight">${tr('18 pt', 'کم (۱۸)')}</button>
                <button type="button" class="crop-preset-btn" data-preset="medium">${tr('36 pt', 'متوسط (۳۶)')}</button>
                <button type="button" class="crop-preset-btn" data-preset="wide">${tr('54 pt', 'زیاد (۵۴)')}</button>
              </div>
            </div>

            <div class="crop-control-group">
              <span class="crop-group-label">${tr('Apply To', 'اعمال برش روی')}</span>
              <div class="crop-scope-options">
                <label class="crop-radio-row ${initialScope === 'current' ? 'is-selected' : ''}">
                  <input type="radio" name="crop-scope" value="current" ${initialScope === 'current' ? 'checked' : ''} />
                  <span>${tr(`Current Page (Page ${pageIdx + 1})`, `صفحه فعلی (صفحه ${pageIdx + 1})`)}</span>
                </label>
                <label class="crop-radio-row ${initialScope === 'all' ? 'is-selected' : ''}">
                  <input type="radio" name="crop-scope" value="all" ${initialScope === 'all' ? 'checked' : ''} />
                  <span>${tr(`All Pages (1–${doc.pageCount})`, `همه صفحات (۱ تا ${doc.pageCount})`)}</span>
                </label>
                <label class="crop-radio-row ${initialScope === 'range' ? 'is-selected' : ''}">
                  <input type="radio" name="crop-scope" value="range" ${initialScope === 'range' ? 'checked' : ''} />
                  <span>${tr('Custom Page Range', 'بازه صفحات دلخواه')}</span>
                </label>
                <input
                  type="text"
                  id="crop-range-input"
                  class="crop-range-input"
                  dir="ltr"
                  placeholder="e.g. 1-3, 5"
                  value="${this._rangeStr}"
                  ${initialScope === 'range' ? '' : 'disabled'}
                />
              </div>
            </div>

            <div class="crop-control-group crop-reset-group">
              <button type="button" class="secondary-btn is-block crop-reset-btn" id="btn-reset-crop">
                ${getIconSvg('refresh', 14)}
                <span>${tr('Restore Original Page Size', 'بازگردانی به ابعاد اصلی بدون برش')}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="crop-modal-footer">
          <button type="button" class="secondary-btn" id="btn-cancel-crop">${tr('Cancel', 'انصراف')}</button>
          <button type="button" class="primary-btn" id="btn-apply-crop">
            ${getIconSvg('crop', 15)}
            <span>${tr('Apply Crop', 'اعمال برش')}</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    this._backdrop = backdrop;

    this.bindEvents(backdrop);
    await this.renderPreviewCanvas(backdrop);
    this.syncOverlayGeometry(backdrop);
  }

  public close(): void {
    const backdrop = this._backdrop;
    if (!backdrop) return;
    this._backdrop = null;
    if (this._escHandler) {
      window.removeEventListener('keydown', this._escHandler, true);
      this._escHandler = null;
    }
    backdrop.classList.add('is-closing');
    setTimeout(() => {
      backdrop.remove();
    }, 160);
  }

  private closeImmediate(): void {
    if (this._escHandler) {
      window.removeEventListener('keydown', this._escHandler, true);
      this._escHandler = null;
    }
    if (this._backdrop) {
      this._backdrop.remove();
      this._backdrop = null;
    }
  }

  private formatIndicesAsRange(indices: number[]): string {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    if (sorted.length === 0) return '1';
    const parts: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      if (cur === prev + 1) {
        prev = cur;
      } else {
        parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
        start = cur;
        prev = cur;
      }
    }
    return parts.join(', ');
  }

  private async renderPreviewCanvas(backdrop: HTMLElement): Promise<void> {
    const canvas = backdrop.querySelector<HTMLCanvasElement>('#crop-preview-canvas');
    const wrap = backdrop.querySelector<HTMLElement>('#crop-canvas-wrap');
    if (!canvas || !wrap) return;

    const maxPreviewW = 340;
    const maxPreviewH = 400;
    const scale = Math.min(maxPreviewW / this._pageWidthPt, maxPreviewH / this._pageHeightPt);
    this._previewScale = scale;

    const cssW = Math.max(60, Math.round(this._pageWidthPt * scale));
    const cssH = Math.max(60, Math.round(this._pageHeightPt * scale));
    wrap.style.width = `${cssW}px`;
    wrap.style.height = `${cssH}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const userRot = store.pageRotations[this._pageIndex] || 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    await pdfEngine.renderPageAtScale(this._pageIndex, canvas, scale * dpr, userRot);
  }

  private clampMargins(next: PageCropMargins): PageCropMargins {
    const minRemaining = 36;
    let left = Math.max(0, Math.round(next.left));
    let right = Math.max(0, Math.round(next.right));
    let top = Math.max(0, Math.round(next.top));
    let bottom = Math.max(0, Math.round(next.bottom));

    if (left + right > this._pageWidthPt - minRemaining) {
      const overflow = (left + right) - (this._pageWidthPt - minRemaining);
      if (right >= overflow) right -= overflow;
      else {
        left = Math.max(0, this._pageWidthPt - minRemaining - right);
      }
    }
    if (top + bottom > this._pageHeightPt - minRemaining) {
      const overflow = (top + bottom) - (this._pageHeightPt - minRemaining);
      if (bottom >= overflow) bottom -= overflow;
      else {
        top = Math.max(0, this._pageHeightPt - minRemaining - bottom);
      }
    }
    return { top, right, bottom, left };
  }

  private syncOverlayGeometry(backdrop: HTMLElement): void {
    const box = backdrop.querySelector<HTMLElement>('#crop-box-overlay');
    const shadeTop = backdrop.querySelector<HTMLElement>('#crop-shade-top');
    const shadeBottom = backdrop.querySelector<HTMLElement>('#crop-shade-bottom');
    const shadeLeft = backdrop.querySelector<HTMLElement>('#crop-shade-left');
    const shadeRight = backdrop.querySelector<HTMLElement>('#crop-shade-right');
    const readout = backdrop.querySelector<HTMLElement>('#crop-dimensions-readout');
    if (!box || !shadeTop || !shadeBottom || !shadeLeft || !shadeRight) return;

    const s = this._previewScale;
    const totalW = Math.round(this._pageWidthPt * s);
    const totalH = Math.round(this._pageHeightPt * s);

    const topPx = Math.round(this._margins.top * s);
    const bottomPx = Math.round(this._margins.bottom * s);
    const leftPx = Math.round(this._margins.left * s);
    const rightPx = Math.round(this._margins.right * s);

    const cropW = Math.max(16, totalW - leftPx - rightPx);
    const cropH = Math.max(16, totalH - topPx - bottomPx);

    box.style.left = `${leftPx}px`;
    box.style.top = `${topPx}px`;
    box.style.width = `${cropW}px`;
    box.style.height = `${cropH}px`;

    shadeTop.style.left = '0px';
    shadeTop.style.top = '0px';
    shadeTop.style.width = `${totalW}px`;
    shadeTop.style.height = `${topPx}px`;

    shadeBottom.style.left = '0px';
    shadeBottom.style.top = `${topPx + cropH}px`;
    shadeBottom.style.width = `${totalW}px`;
    shadeBottom.style.height = `${Math.max(0, totalH - topPx - cropH)}px`;

    shadeLeft.style.left = '0px';
    shadeLeft.style.top = `${topPx}px`;
    shadeLeft.style.width = `${leftPx}px`;
    shadeLeft.style.height = `${cropH}px`;

    shadeRight.style.left = `${leftPx + cropW}px`;
    shadeRight.style.top = `${topPx}px`;
    shadeRight.style.width = `${Math.max(0, totalW - leftPx - cropW)}px`;
    shadeRight.style.height = `${cropH}px`;

    const inTop = backdrop.querySelector<HTMLInputElement>('#crop-in-top');
    const inBottom = backdrop.querySelector<HTMLInputElement>('#crop-in-bottom');
    const inLeft = backdrop.querySelector<HTMLInputElement>('#crop-in-left');
    const inRight = backdrop.querySelector<HTMLInputElement>('#crop-in-right');
    if (inTop && document.activeElement !== inTop) inTop.value = String(this._margins.top);
    if (inBottom && document.activeElement !== inBottom) inBottom.value = String(this._margins.bottom);
    if (inLeft && document.activeElement !== inLeft) inLeft.value = String(this._margins.left);
    if (inRight && document.activeElement !== inRight) inRight.value = String(this._margins.right);

    if (readout) {
      const finalW = Math.max(36, this._pageWidthPt - this._margins.left - this._margins.right);
      const finalH = Math.max(36, this._pageHeightPt - this._margins.top - this._margins.bottom);
      readout.textContent = `${finalW} × ${finalH} pt  (${tr('Original:', 'ابعاد فعلی:')} ${this._pageWidthPt} × ${this._pageHeightPt} pt)`;
    }
  }

  private resolveTargetIndices(): number[] {
    const doc = store.activeDocument;
    if (!doc) return [];
    if (this._scope === 'current') {
      return [this._pageIndex];
    }
    if (this._scope === 'all') {
      return Array.from({ length: doc.pageCount }, (_, i) => i);
    }
    return parsePageRangeInput(this._rangeStr, doc.pageCount);
  }

  private bindEvents(backdrop: HTMLElement): void {
    const closeBtn = backdrop.querySelector('#btn-close-crop-modal');
    const cancelBtn = backdrop.querySelector('#btn-cancel-crop');
    closeBtn?.addEventListener('click', () => this.close());
    cancelBtn?.addEventListener('click', () => this.close());
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) this.close();
    });

    this._escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this._escHandler, true);

    const bindNumInput = (selector: string, key: keyof PageCropMargins) => {
      const input = backdrop.querySelector<HTMLInputElement>(selector);
      input?.addEventListener('input', () => {
        const val = Math.max(0, parseInt(input.value || '0', 10) || 0);
        this._margins = this.clampMargins({ ...this._margins, [key]: val });
        this.syncOverlayGeometry(backdrop);
      });
    };
    bindNumInput('#crop-in-top', 'top');
    bindNumInput('#crop-in-bottom', 'bottom');
    bindNumInput('#crop-in-left', 'left');
    bindNumInput('#crop-in-right', 'right');

    backdrop.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        const val = preset === 'zero' ? 0 : preset === 'tight' ? 18 : preset === 'medium' ? 36 : 54;
        this._margins = this.clampMargins({ top: val, right: val, bottom: val, left: val });
        this.syncOverlayGeometry(backdrop);
      });
    });

    const rangeInput = backdrop.querySelector<HTMLInputElement>('#crop-range-input');
    const radioRows = backdrop.querySelectorAll<HTMLElement>('.crop-radio-row');
    backdrop.querySelectorAll<HTMLInputElement>('input[name="crop-scope"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          this._scope = radio.value as CropScope;
          radioRows.forEach(row => {
            const r = row.querySelector<HTMLInputElement>('input[name="crop-scope"]');
            row.classList.toggle('is-selected', Boolean(r?.checked));
          });
          if (rangeInput) rangeInput.disabled = this._scope !== 'range';
          if (this._scope === 'range') rangeInput?.focus();
        }
      });
    });
    rangeInput?.addEventListener('input', () => {
      this._rangeStr = rangeInput.value;
    });

    // Interactive pointer dragging on the crop box and its 8 handles
    const wrap = backdrop.querySelector<HTMLElement>('#crop-canvas-wrap');
    wrap?.addEventListener('pointerdown', (e: PointerEvent) => {
      const handleEl = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]');
      if (!handleEl) return;
      const handle = handleEl.dataset.handle as HandleId;
      e.preventDefault();
      handleEl.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const startMargins = { ...this._margins };
      const scale = this._previewScale || 1;

      const onMove = (ev: PointerEvent) => {
        const dxPt = Math.round((ev.clientX - startX) / scale);
        const dyPt = Math.round((ev.clientY - startY) / scale);
        const next = { ...startMargins };

        if (handle === 'move') {
          const boxW = this._pageWidthPt - startMargins.left - startMargins.right;
          const boxH = this._pageHeightPt - startMargins.top - startMargins.bottom;
          const newLeft = Math.max(0, Math.min(this._pageWidthPt - boxW, startMargins.left + dxPt));
          const newTop = Math.max(0, Math.min(this._pageHeightPt - boxH, startMargins.top + dyPt));
          next.left = newLeft;
          next.right = Math.max(0, this._pageWidthPt - boxW - newLeft);
          next.top = newTop;
          next.bottom = Math.max(0, this._pageHeightPt - boxH - newTop);
        } else {
          if (handle.includes('n')) next.top = Math.max(0, startMargins.top + dyPt);
          if (handle.includes('s')) next.bottom = Math.max(0, startMargins.bottom - dyPt);
          if (handle.includes('w')) next.left = Math.max(0, startMargins.left + dxPt);
          if (handle.includes('e')) next.right = Math.max(0, startMargins.right - dxPt);
        }

        this._margins = this.clampMargins(next);
        this.syncOverlayGeometry(backdrop);
      };

      const onUp = (ev: PointerEvent) => {
        try { handleEl.releasePointerCapture(ev.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    // Apply Crop button
    backdrop.querySelector('#btn-apply-crop')?.addEventListener('click', async () => {
      const indices = this.resolveTargetIndices();
      if (indices.length === 0) {
        showToast(tr('Please enter a valid page range', 'لطفاً یک بازه صفحات معتبر وارد کنید'), 'info');
        return;
      }
      if (
        this._margins.top <= 0 &&
        this._margins.right <= 0 &&
        this._margins.bottom <= 0 &&
        this._margins.left <= 0
      ) {
        this.close();
        return;
      }
      this.close();
      const ok = await pageActions.cropPages(indices, this._margins);
      if (ok) {
        showToast(t('sidebar.pages.cropped', { n: indices.length }), 'success');
      }
    });

    // Reset Original Page Size button
    backdrop.querySelector('#btn-reset-crop')?.addEventListener('click', async () => {
      const indices = this.resolveTargetIndices();
      if (indices.length === 0) return;
      this.close();
      const ok = await pageActions.resetPageCrops(indices);
      if (ok) {
        showToast(t('sidebar.pages.cropReset', { n: indices.length }), 'success');
      }
    });
  }
}

export const cropDialog = new CropDialogController();
