/**
 * Unified Save As, Export & Import Modal
 * Supports exporting as PDF (.pdf, with optional password encryption),
 * High-DPI Image (.png / .jpg — single file or multi-page ZIP bundle with Light/Dark theme),
 * Adobe XFDF (.xfdf), or Annotations Backup (.json), plus importing JSON backups.
 */

import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';

export type SaveAsFormat = 'pdf' | 'png' | 'jpeg' | 'xfdf' | 'json';

export interface SaveAsOptions {
  format: SaveAsFormat;
  filename: string;
  dpi: 72 | 150 | 300 | 600;
  flatten: boolean;
  /** Bake the dark viewing theme into the saved pages (PDF, PNG, JPEG). */
  darkMode?: boolean;
  /** Optional RC4-128 encryption password for PDF exports. */
  password?: string;
  pageRange?: { start: number; end: number };
  pageIndices?: number[];
}

interface SaveAsDialogOpts {
  defaultFilename: string;
  pageCount: number;
  activePageIndex?: number;
  selectedPageIndices?: number[];
  /** Preselects the theme choice to match the current on-screen appearance. */
  displayedDark?: boolean;
  supportsPicker: boolean;
  onSubmit: (opts: SaveAsOptions) => void | Promise<void>;
  onImportJson?: () => void | Promise<void>;
  onClose?: () => void;
}

const FORMAT_EXTENSIONS: Record<SaveAsFormat, string> = {
  pdf: '.pdf',
  png: '.png',
  jpeg: '.jpg',
  xfdf: '.xfdf',
  json: '.json'
};

export function replaceFileExtension(filename: string, format: SaveAsFormat): string {
  const ext = FORMAT_EXTENSIONS[format] || '.pdf';
  const stripped = filename.replace(/\.(pdf|png|jpe?g|xfdf|json|zip)$/i, '').trim() || 'document';
  return `${stripped}${ext}`;
}

export class SaveAsDialogComponent {
  private _container: HTMLElement;
  private _opts: SaveAsDialogOpts;
  private _format: SaveAsFormat = 'pdf';
  private _busy = false;
  private _keyHandler?: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, opts: SaveAsDialogOpts) {
    this._container = container;
    this._opts = opts;
  }

  public render(): void {
    const defName = replaceFileExtension(this._opts.defaultFilename, this._format);
    const pickerHint = this._opts.supportsPicker
      ? t('saveAs.locationPicker')
      : t('saveAs.locationDownload');
    const activePageNum = (this._opts.activePageIndex ?? 0) + 1;
    const hasSelected = Boolean(this._opts.selectedPageIndices && this._opts.selectedPageIndices.length > 0);

    this._container.innerHTML = `
      <div class="modal-overlay" id="saveas-overlay">
        <div class="modal-dialog form-dialog saveas-dialog" role="dialog" aria-modal="true" aria-label="${tr('Save As & Export', 'ذخیره با نام و خروجی')}">
          <div class="panel-header">
            <span>${getIconSvg('save', 15)} ${tr('Save As & Export', 'ذخیره با نام و خروجی')}</span>
            <button type="button" id="saveas-close" class="icon-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">${getIconSvg('close', 14)}</button>
          </div>
          <div class="form-dialog-body saveas-body">
            <!-- Visual Format Selector -->
            <div class="form-field">
              <span class="form-label">${tr('Export Format', 'فرمت خروجی')}</span>
              <div id="saveas-format-grid" class="saveas-format-grid">
                ${([
                  { id: 'pdf', label: 'PDF', sub: '.pdf' },
                  { id: 'png', label: 'PNG', sub: '.png' },
                  { id: 'jpeg', label: 'JPEG', sub: '.jpg' },
                  { id: 'xfdf', label: 'XFDF', sub: 'Adobe' },
                  { id: 'json', label: 'JSON', sub: tr('Backup', 'پشتیبان') }
                ] as const).map(fmt => `
                  <button type="button"
                          class="size-pill saveas-fmt-btn ${this._format === fmt.id ? 'active' : ''}"
                          data-saveas-format="${fmt.id}">
                    <span class="saveas-fmt-name">${fmt.label}</span>
                    <span class="saveas-fmt-ext">${fmt.sub}</span>
                  </button>
                `).join('')}
              </div>
            </div>

            <div class="saveas-two-col">
              <label class="form-field saveas-col-span">
                <span class="form-label">${t('saveAs.filename')}</span>
                <input id="saveas-name" class="field" type="text" value="${defName.replace(/"/g, '&quot;')}" spellcheck="false" />
              </label>

              <label class="form-field" id="saveas-dpi-group">
                <span class="form-label">${t('saveAs.quality')}</span>
                <select id="saveas-dpi" class="field">
                  <option value="72">${tr('72 DPI — compact', '۷۲ DPI — کم‌حجم')}</option>
                  <option value="150" selected>${tr('150 DPI — balanced', '۱۵۰ DPI — متعادل')}</option>
                  <option value="300">${tr('300 DPI — print quality', '۳۰۰ DPI — کیفیت چاپ')}</option>
                  <option value="600">${tr('600 DPI — maximum', '۶۰۰ DPI — حداکثر کیفیت')}</option>
                </select>
              </label>

              <label class="form-field" id="saveas-theme-group">
                <span class="form-label">${tr('Page Theme', 'تم رنگی صفحات')}</span>
                <select id="saveas-theme" class="field">
                  <option value="light" ${this._opts.displayedDark ? '' : 'selected'}>${tr('Light — original paper', 'روشن — رنگ اصلی کاغذ')}</option>
                  <option value="dark" ${this._opts.displayedDark ? 'selected' : ''}>${tr('Dark — night theme', 'تاریک — تم شب')}</option>
                </select>
              </label>
            </div>
            <div class="form-hint" id="saveas-format-hint">${pickerHint}</div>

            <!-- Pages Selector: crisp grid row + dedicated custom From-To row -->
            <div class="form-field" id="saveas-pages-group">
              <span class="form-label">${t('saveAs.pages')}</span>
              <div class="saveas-range-options" role="radiogroup" aria-label="${t('saveAs.pages')}">
                <label class="saveas-radio-chip">
                  <input type="radio" name="saveas-range" value="all" checked />
                  <span>${t('saveAs.allPages')} <span class="tabular-nums">(${this._opts.pageCount})</span></span>
                </label>
                <label class="saveas-radio-chip">
                  <input type="radio" name="saveas-range" value="current" />
                  <span>${tr('Current', 'صفحه فعلی')} <span class="tabular-nums">(${activePageNum})</span></span>
                </label>
                ${hasSelected ? `
                <label class="saveas-radio-chip">
                  <input type="radio" name="saveas-range" value="selected" />
                  <span>${tr('Selected', 'انتخابی')} <span class="tabular-nums">(${this._opts.selectedPageIndices!.length})</span></span>
                </label>` : ''}
                <label class="saveas-radio-chip">
                  <input type="radio" name="saveas-range" value="custom" />
                  <span>${t('saveAs.custom')}</span>
                </label>
              </div>
              <div id="saveas-custom-row" class="saveas-custom-row is-disabled">
                <label class="saveas-custom-field">
                  <span class="saveas-custom-label">${tr('From', 'از صفحه')}</span>
                  <input id="saveas-start" class="field tabular-nums" type="number" min="1" max="${this._opts.pageCount}" value="1" disabled />
                </label>
                <span class="saveas-range-dash" aria-hidden="true">–</span>
                <label class="saveas-custom-field">
                  <span class="saveas-custom-label">${tr('To', 'تا صفحه')}</span>
                  <input id="saveas-end" class="field tabular-nums" type="number" min="1" max="${this._opts.pageCount}" value="${this._opts.pageCount}" disabled />
                </label>
              </div>
            </div>

            <!-- PDF-only Options: Flatten & Optional Password Encryption -->
            <div class="saveas-pdf-extras" id="saveas-pdf-extras">
              <div class="form-field" id="saveas-flatten-group">
                <label class="saveas-check-row">
                  <input id="saveas-flatten" type="checkbox" />
                  <span>${t('saveAs.flatten')}</span>
                </label>
                <div class="form-hint" style="margin:0; padding-inline-start:23px;">${t('saveAs.flattenHint')}</div>
              </div>

              <div class="form-field" id="saveas-password-group">
                <label class="saveas-check-row">
                  <input id="saveas-encrypt-toggle" type="checkbox" />
                  <span>${getIconSvg('lock', 13)} ${tr('Protect PDF with a password', 'رمزگذاری فایل PDF خروجی')}</span>
                </label>
                <div id="saveas-password-fields" class="saveas-password-fields" hidden>
                  <div class="saveas-pwd-input-wrap">
                    <input id="saveas-pwd-input" class="field" type="password" placeholder="${tr('Password', 'رمز عبور')}" autocomplete="new-password" />
                    <button type="button" id="saveas-pwd-eye" class="icon-btn saveas-pwd-eye" title="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}" aria-label="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}">
                      ${getIconSvg('eye', 14)}
                    </button>
                  </div>
                  <input id="saveas-pwd-confirm" class="field" type="password" placeholder="${tr('Confirm password', 'تکرار رمز عبور')}" autocomplete="new-password" />
                  <div id="saveas-pwd-error" class="saveas-pwd-error" hidden></div>
                </div>
              </div>
            </div>

            <div class="form-actions saveas-footer">
              ${this._opts.onImportJson ? `
              <button type="button" id="saveas-import-json" class="header-btn" title="${tr('Import annotations from a .json backup file into this document', 'وارد کردن حاشیه‌نویسی‌ها از فایل پشتیبان JSON')}">
                ${getIconSvg('fileUp', 14)}
                <span>${tr('Import JSON…', 'وارد کردن JSON…')}</span>
              </button>
              ` : '<span></span>'}
              <div class="saveas-footer-cta">
                <button type="button" id="saveas-cancel" class="header-btn">${t('saveAs.cancel')}</button>
                <button type="button" id="saveas-submit" class="header-btn primary">${getIconSvg('save', 14)}<span id="saveas-submit-label">${t('saveAs.save')}</span></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    this.bind();
    this.syncFormatVisibility();
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

  private updateCustomRangeState(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    const customRow = q('#saveas-custom-row');
    const start = q<HTMLInputElement>('#saveas-start');
    const end = q<HTMLInputElement>('#saveas-end');
    const isCustom = q<HTMLInputElement>('input[name="saveas-range"]:checked')?.value === 'custom';
    if (start) start.disabled = !isCustom;
    if (end) end.disabled = !isCustom;
    customRow?.classList.toggle('is-disabled', !isCustom);
  }

  private syncFormatVisibility(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    const fmt = this._format;
    const isPdf = fmt === 'pdf';
    const isImage = fmt === 'png' || fmt === 'jpeg';
    const isData = fmt === 'xfdf' || fmt === 'json';

    const dpiGroup = q('#saveas-dpi-group');
    const themeGroup = q('#saveas-theme-group');
    const pdfExtras = q('#saveas-pdf-extras');
    const pagesGroup = q('#saveas-pages-group');
    const hint = q('#saveas-format-hint');
    const submitLabel = q('#saveas-submit-label');

    if (dpiGroup) dpiGroup.style.display = (isPdf || isImage) ? '' : 'none';
    if (themeGroup) themeGroup.style.display = (isPdf || isImage) ? '' : 'none';
    if (pdfExtras) pdfExtras.style.display = isPdf ? '' : 'none';
    if (pagesGroup) pagesGroup.style.display = (isPdf || isImage) ? '' : 'none';

    if (hint) {
      if (fmt === 'xfdf') {
        hint.textContent = tr(
          'Exports all annotations in standard Adobe XFDF XML format.',
          'تمامی حاشیه‌نویسی‌ها را با فرمت استاندارد Adobe XFDF استخراج می‌کند.'
        );
      } else if (fmt === 'json') {
        hint.textContent = tr(
          'Exports all annotations & layers as a lossless veditor JSON backup.',
          'تمامی حاشیه‌نویسی‌ها و لایه‌ها را به صورت فایل پشتیبان JSON ذخیره می‌کند.'
        );
      } else if (isImage) {
        hint.textContent = tr(
          '1 page downloads as an image; 2+ pages bundle cleanly into one .zip archive.',
          'تک‌صفحه به صورت تصویر مستقیم و چند صفحه به صورت یک فایل یکپارچه ZIP خروجی گرفته می‌شود.'
        );
      } else {
        hint.textContent = this._opts.supportsPicker
          ? t('saveAs.locationPicker')
          : t('saveAs.locationDownload');
      }
    }

    if (submitLabel) {
      submitLabel.textContent = isData || isImage
        ? tr('Export', 'خروجی گرفتن')
        : t('saveAs.save');
    }

    this.updateCustomRangeState();
  }

  private bind(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    q('#saveas-close')?.addEventListener('click', () => this.close());
    q('#saveas-cancel')?.addEventListener('click', () => this.close());
    q('#saveas-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'saveas-overlay' && !this._busy) this.close();
    });

    this._keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this._busy) this.close();
      } else if (
        e.key === 'Enter' &&
        (e.target as HTMLElement)?.tagName === 'INPUT' &&
        (e.target as HTMLInputElement).type !== 'checkbox' &&
        (e.target as HTMLInputElement).type !== 'radio'
      ) {
        e.preventDefault();
        e.stopPropagation();
        q<HTMLButtonElement>('#saveas-submit')?.click();
      }
    };
    window.addEventListener('keydown', this._keyHandler, true);

    this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-format]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-saveas-format') as SaveAsFormat | null;
        if (!fmt) return;
        this._format = fmt;
        this._container.querySelectorAll('[data-saveas-format]').forEach(el => {
          el.classList.toggle('active', el.getAttribute('data-saveas-format') === fmt);
        });
        const nameInput = q<HTMLInputElement>('#saveas-name');
        if (nameInput) {
          nameInput.value = replaceFileExtension(nameInput.value, fmt);
        }
        this.syncFormatVisibility();
      });
    });

    q('#saveas-import-json')?.addEventListener('click', async () => {
      if (this._busy || !this._opts.onImportJson) return;
      this.close();
      await this._opts.onImportJson();
    });

    this._container.querySelectorAll<HTMLInputElement>('input[name="saveas-range"]').forEach(r => {
      r.addEventListener('change', () => this.updateCustomRangeState());
    });

    // Optional PDF password encryption controls
    const encryptToggle = q<HTMLInputElement>('#saveas-encrypt-toggle');
    const pwdFields = q<HTMLElement>('#saveas-password-fields');
    const pwdInput = q<HTMLInputElement>('#saveas-pwd-input');
    const pwdConfirm = q<HTMLInputElement>('#saveas-pwd-confirm');
    const pwdEye = q<HTMLButtonElement>('#saveas-pwd-eye');
    const pwdError = q<HTMLElement>('#saveas-pwd-error');

    const clearPwdError = () => {
      if (pwdError) {
        pwdError.hidden = true;
        pwdError.textContent = '';
      }
    };

    encryptToggle?.addEventListener('change', () => {
      const enabled = encryptToggle.checked;
      if (pwdFields) pwdFields.hidden = !enabled;
      clearPwdError();
      if (enabled) requestAnimationFrame(() => pwdInput?.focus());
    });

    pwdEye?.addEventListener('click', () => {
      if (!pwdInput) return;
      const hidden = pwdInput.type === 'password';
      pwdInput.type = hidden ? 'text' : 'password';
      if (pwdConfirm) pwdConfirm.type = hidden ? 'text' : 'password';
      pwdEye.innerHTML = getIconSvg(hidden ? 'eyeOff' : 'eye', 14);
      pwdInput.focus();
    });

    pwdInput?.addEventListener('input', clearPwdError);
    pwdConfirm?.addEventListener('input', clearPwdError);

    q('#saveas-submit')?.addEventListener('click', async () => {
      if (this._busy) return;
      let name = (q<HTMLInputElement>('#saveas-name')?.value || '').trim();
      if (!name) {
        q<HTMLInputElement>('#saveas-name')?.focus();
        return;
      }

      let password: string | undefined;
      if (this._format === 'pdf' && encryptToggle?.checked) {
        const p1 = pwdInput?.value || '';
        const p2 = pwdConfirm?.value || '';
        if (!p1) {
          if (pwdError) {
            pwdError.hidden = false;
            pwdError.textContent = tr('Please enter a password.', 'لطفاً رمز عبور را وارد کنید.');
          }
          pwdInput?.focus();
          return;
        }
        if (p1 !== p2) {
          if (pwdError) {
            pwdError.hidden = false;
            pwdError.textContent = tr('Passwords do not match.', 'رمز عبور و تکرار آن یکسان نیستند.');
          }
          pwdConfirm?.focus();
          return;
        }
        password = p1;
      }

      name = replaceFileExtension(name, this._format);
      const dpi = Number(q<HTMLSelectElement>('#saveas-dpi')?.value || 150) as 72 | 150 | 300 | 600;
      const flatten = q<HTMLInputElement>('#saveas-flatten')?.checked === true;
      const darkMode = q<HTMLSelectElement>('#saveas-theme')?.value === 'dark';
      const rangeMode = this._container.querySelector<HTMLInputElement>('input[name="saveas-range"]:checked')?.value || 'all';
      const start = q<HTMLInputElement>('#saveas-start');
      const end = q<HTMLInputElement>('#saveas-end');

      let pageRange: { start: number; end: number } | undefined;
      let pageIndices: number[] | undefined;
      if (rangeMode === 'custom') {
        const s = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(start?.value) || 1)));
        const e = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(end?.value) || this._opts.pageCount)));
        pageRange = { start: Math.min(s, e), end: Math.max(s, e) };
      } else if (rangeMode === 'current') {
        const cur = Math.max(0, Math.min(this._opts.pageCount - 1, this._opts.activePageIndex ?? 0));
        pageIndices = [cur];
      } else if (rangeMode === 'selected') {
        pageIndices = this._opts.selectedPageIndices;
      }

      this._busy = true;
      (q('#saveas-submit') as HTMLButtonElement | null)?.setAttribute('disabled', '');
      try {
        await this._opts.onSubmit({
          format: this._format,
          filename: name,
          dpi,
          flatten,
          darkMode,
          password,
          pageRange,
          pageIndices
        });
        this.destroy();
      } finally {
        this._busy = false;
      }
    });
  }
}

/** Opens the dialog body-hosted; resolves when closed or saved. */
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
