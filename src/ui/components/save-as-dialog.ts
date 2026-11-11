/**
 * Save As dialog: filename + quality + pages options.
 * Transient body-hosted modal (like NotebookDialog) so header re-renders
 * can't tear it down mid-edit.
 */

import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';

export interface SaveAsOptions {
  filename: string;
  dpi: 72 | 150 | 300 | 600;
  flatten: boolean;
  /** Bake the dark viewing theme into the saved pages. */
  darkMode?: boolean;
  pageRange?: { start: number; end: number };
  pageIndices?: number[];
}

interface SaveAsDialogOpts {
  defaultFilename: string;
  pageCount: number;
  selectedPageIndices?: number[];
  /** Preselects the theme choice to match the current on-screen appearance. */
  displayedDark?: boolean;
  supportsPicker: boolean;
  onSubmit: (opts: SaveAsOptions) => void | Promise<void>;
  onClose?: () => void;
}

export class SaveAsDialogComponent {
  private _container: HTMLElement;
  private _opts: SaveAsDialogOpts;
  private _busy = false;
  private _keyHandler?: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, opts: SaveAsDialogOpts) {
    this._container = container;
    this._opts = opts;
  }

  public render(): void {
    const defName = this._opts.defaultFilename.endsWith('.pdf')
      ? this._opts.defaultFilename
      : `${this._opts.defaultFilename}.pdf`;
    const pickerHint = this._opts.supportsPicker
      ? t('saveAs.locationPicker')
      : t('saveAs.locationDownload');

    this._container.innerHTML = `
      <div class="modal-overlay" id="saveas-overlay">
        <div class="modal-dialog form-dialog" role="dialog" aria-modal="true" aria-label="${t('saveAs.title')}">
          <div class="panel-header">
            <span>${getIconSvg('save', 15)} ${t('saveAs.title')}</span>
            <button id="saveas-close" class="icon-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">${getIconSvg('close', 14)}</button>
          </div>
          <div class="form-dialog-body">
            <label class="form-field">
              <span class="form-label">${t('saveAs.filename')}</span>
              <input id="saveas-name" class="field" type="text" value="${defName.replace(/"/g, '&quot;')}" spellcheck="false" />
            </label>
            <div class="form-hint">${pickerHint}</div>

            <label class="form-field">
              <span class="form-label">${t('saveAs.quality')}</span>
              <select id="saveas-dpi" class="field">
                <option value="72">${tr('72 DPI — smallest file', '۷۲ DPI — کمترین حجم فایل')}</option>
                <option value="150" selected>${tr('150 DPI — balanced (recommended)', '۱۵۰ DPI — متعادل (پیشنهادی)')}</option>
                <option value="300">${tr('300 DPI — print quality', '۳۰۰ DPI — کیفیت چاپ')}</option>
                <option value="600">${tr('600 DPI — largest file', '۶۰۰ DPI — بالاترین کیفیت و حجم')}</option>
              </select>
            </label>

            <label class="form-field">
              <span class="form-label">${tr('Theme', 'تم رنگی صفحات')}</span>
              <select id="saveas-theme" class="field">
                <option value="light" ${this._opts.displayedDark ? '' : 'selected'}>${tr('Light — original page colors', 'روشن — رنگ‌های اصلی صفحات')}</option>
                <option value="dark" ${this._opts.displayedDark ? 'selected' : ''}>${tr('Dark — as displayed in dark mode', 'تاریک — همانند نمایش در حالت تاریک')}</option>
              </select>
            </label>

            <label class="form-field form-check">
              <input id="saveas-flatten" type="checkbox" />
              <span>${t('saveAs.flatten')}</span>
            </label>
            <div class="form-hint">${t('saveAs.flattenHint')}</div>

            <div class="form-field">
              <span class="form-label">${t('saveAs.pages')}</span>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <label style="display:flex; gap:4px; align-items:center;">
                  <input type="radio" name="saveas-range" value="all" checked /> ${t('saveAs.allPages')} (${this._opts.pageCount})
                </label>
                <label style="display:flex; gap:4px; align-items:center;">
                  <input type="radio" name="saveas-range" value="custom" /> ${t('saveAs.custom')}
                </label>
                ${this._opts.selectedPageIndices?.length ? `
                <label style="display:flex; gap:4px; align-items:center;">
                  <input type="radio" name="saveas-range" value="selected" /> ${tr('Selected', 'انتخاب‌شده')} (${this._opts.selectedPageIndices.length})
                </label>` : ''}
                <input id="saveas-start" class="field" type="number" min="1" max="${this._opts.pageCount}" value="1" style="width:64px;" disabled />
                <span>–</span>
                <input id="saveas-end" class="field" type="number" min="1" max="${this._opts.pageCount}" value="${this._opts.pageCount}" style="width:64px;" disabled />
              </div>
            </div>

            <div class="form-actions">
              <button id="saveas-cancel" class="header-btn">${t('saveAs.cancel')}</button>
              <button id="saveas-submit" class="header-btn primary">${getIconSvg('save', 14)}<span>${t('saveAs.save')}</span></button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.bind();
  }

  public destroy(): void {
    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = undefined;
    }
    this._container.innerHTML = '';
  }

  private close(): void {
    this.destroy();
    this._opts.onClose?.();
  }

  private bind(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    q('#saveas-close')?.addEventListener('click', () => this.close());
    q('#saveas-cancel')?.addEventListener('click', () => this.close());
    q('#saveas-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'saveas-overlay') this.close();
    });

    this._keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this._busy) this.close();
      } else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
        e.preventDefault();
        e.stopPropagation();
        q<HTMLButtonElement>('#saveas-submit')?.click();
      }
    };
    window.addEventListener('keydown', this._keyHandler, true);

    const radios = this._container.querySelectorAll<HTMLInputElement>('input[name="saveas-range"]');
    const start = q<HTMLInputElement>('#saveas-start');
    const end = q<HTMLInputElement>('#saveas-end');
    radios.forEach(r => r.addEventListener('change', () => {
      const custom = this._container.querySelector<HTMLInputElement>('input[name="saveas-range"]:checked')?.value === 'custom';
      if (start) start.disabled = !custom;
      if (end) end.disabled = !custom;
    }));

    q('#saveas-submit')?.addEventListener('click', async () => {
      if (this._busy) return;
      let name = (q<HTMLInputElement>('#saveas-name')?.value || '').trim();
      if (!name) {
        q<HTMLInputElement>('#saveas-name')?.focus();
        return;
      }
      if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
      const dpi = Number(q<HTMLSelectElement>('#saveas-dpi')?.value || 150) as 72 | 150 | 300 | 600;
      const flatten = q<HTMLInputElement>('#saveas-flatten')?.checked === true;
      const darkMode = q<HTMLSelectElement>('#saveas-theme')?.value === 'dark';
      const custom = this._container.querySelector<HTMLInputElement>('input[name="saveas-range"]:checked')?.value === 'custom';
      let pageRange: { start: number; end: number } | undefined;
      let pageIndices: number[] | undefined;
      if (custom) {
        const s = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(start?.value) || 1)));
        const e = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(end?.value) || this._opts.pageCount)));
        pageRange = { start: Math.min(s, e), end: Math.max(s, e) };
      }
      if (this._container.querySelector<HTMLInputElement>('input[name="saveas-range"]:checked')?.value === 'selected') {
        pageIndices = this._opts.selectedPageIndices;
      }
      this._busy = true;
      (q('#saveas-submit') as HTMLButtonElement | null)?.setAttribute('disabled', '');
      try {
        await this._opts.onSubmit({ filename: name, dpi, flatten, darkMode, pageRange, pageIndices });
        this.destroy();
      } finally {
        this._busy = false;
      }
    });
  }
}

/** Opens the dialog body-hosted; resolves true when a save completed. */
export function openSaveAsDialog(opts: Omit<SaveAsDialogOpts, 'onClose'> & { onClose?: () => void }): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const cleanup = () => host.remove();
  const dialog = new SaveAsDialogComponent(host, {
    ...opts,
    onSubmit: async (result) => {
      try {
        await opts.onSubmit(result);
      } finally {
        cleanup();
      }
    },
    onClose: () => {
      cleanup();
      opts.onClose?.();
    }
  });
  dialog.render();
}
