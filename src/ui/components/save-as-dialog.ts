/**
 * Unified Save As, Export & Import Modal
 * Supports exporting as PDF (.pdf, with optional password encryption),
 * High-DPI Image (.png / .jpg — single file or multi-page ZIP bundle with Light/Dark theme),
 * Adobe XFDF (.xfdf), or Annotations Backup (.json), plus importing JSON backups.
 */

import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';

export type SaveAsFormat = 'pdf' | 'png' | 'jpeg' | 'xfdf' | 'json';
type SaveAsDpi = 72 | 150 | 300 | 600;
type SaveAsRangeMode = 'all' | 'current' | 'selected' | 'custom';

export interface SaveAsOptions {
  format: SaveAsFormat;
  filename: string;
  dpi: SaveAsDpi;
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

const DPI_PRESETS: readonly { value: SaveAsDpi; label: string; descEn: string; descFa: string }[] = [
  { value: 72, label: '72', descEn: 'Compact web', descFa: 'کم‌حجم وب' },
  { value: 150, label: '150', descEn: 'Balanced', descFa: 'متعادل' },
  { value: 300, label: '300', descEn: 'Print quality', descFa: 'کیفیت چاپ' },
  { value: 600, label: '600', descEn: 'Archival max', descFa: 'حداکثر کیفیت' }
];

function stripKnownExtension(filename: string): string {
  return filename.replace(/\.(pdf|png|jpe?g|xfdf|json|zip)$/i, '').trim() || 'document';
}

export function replaceFileExtension(filename: string, format: SaveAsFormat): string {
  const ext = FORMAT_EXTENSIONS[format] || '.pdf';
  return `${stripKnownExtension(filename)}${ext}`;
}

export class SaveAsDialogComponent {
  private _container: HTMLElement;
  private _opts: SaveAsDialogOpts;
  private _format: SaveAsFormat = 'pdf';
  private _dpi: SaveAsDpi = 150;
  private _darkMode: boolean;
  private _rangeMode: SaveAsRangeMode = 'all';
  private _busy = false;
  private _keyHandler?: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, opts: SaveAsDialogOpts) {
    this._container = container;
    this._opts = opts;
    this._darkMode = Boolean(opts.displayedDark);
  }

  public render(): void {
    const stemName = stripKnownExtension(this._opts.defaultFilename);
    const activePageNum = (this._opts.activePageIndex ?? 0) + 1;
    const hasSelected = Boolean(this._opts.selectedPageIndices && this._opts.selectedPageIndices.length > 0);
    const escapedStem = stemName.replace(/"/g, '&quot;');

    this._container.innerHTML = `
      <div class="modal-overlay saveas-overlay" id="saveas-overlay">
        <div class="modal-dialog form-dialog saveas-dialog" role="dialog" aria-modal="true" aria-labelledby="saveas-title">
          <!-- Quiet, airy header with live typographic summary -->
          <div class="saveas-header">
            <div class="saveas-header-copy">
              <h2 class="saveas-title" id="saveas-title">${tr('Save As', 'ذخیره با نام')}</h2>
              <p class="saveas-subtitle" id="saveas-live-summary"></p>
            </div>
            <button type="button" id="saveas-close" class="saveas-close-btn" title="${tr('Close', 'بستن')}" aria-label="${tr('Close', 'بستن')}">
              ${getIconSvg('close', 16)}
            </button>
          </div>

          <div class="saveas-body">
            <!-- Hero Filename Field with live integrated extension suffix -->
            <div class="saveas-section">
              <label class="saveas-label" for="saveas-name">${t('saveAs.filename')}</label>
              <div class="saveas-filename-box">
                <span class="saveas-filename-icon" id="saveas-filename-icon" aria-hidden="true">
                  ${getIconSvg('fileText', 16)}
                </span>
                <input
                  id="saveas-name"
                  class="saveas-filename-input"
                  type="text"
                  value="${escapedStem}"
                  placeholder="${tr('Untitled document', 'سند بدون عنوان')}"
                  spellcheck="false"
                  autocomplete="off"
                />
                <span class="saveas-ext-suffix" id="saveas-ext-suffix">.pdf</span>
              </div>
              <p class="saveas-caption" id="saveas-format-hint"></p>
            </div>

            <!-- Unified Tactile Segmented Format Rail -->
            <div class="saveas-section">
              <span class="saveas-label">${tr('Format', 'فرمت خروجی')}</span>
              <div id="saveas-format-grid" class="saveas-segment-rail saveas-format-rail" role="tablist" aria-label="${tr('Export Format', 'فرمت خروجی')}">
                ${([
                  { id: 'pdf', label: 'PDF', sub: '.pdf' },
                  { id: 'png', label: 'PNG', sub: '.png' },
                  { id: 'jpeg', label: 'JPEG', sub: '.jpg' },
                  { id: 'xfdf', label: 'XFDF', sub: 'XML' },
                  { id: 'json', label: 'JSON', sub: tr('Backup', 'پشتیبان') }
                ] as const).map(fmt => `
                  <button
                    type="button"
                    role="tab"
                    aria-selected="${this._format === fmt.id ? 'true' : 'false'}"
                    class="saveas-seg-btn saveas-fmt-btn ${this._format === fmt.id ? 'active' : ''}"
                    data-saveas-format="${fmt.id}"
                  >
                    <span class="saveas-fmt-name">${fmt.label}</span>
                    <span class="saveas-fmt-ext">${fmt.sub}</span>
                  </button>
                `).join('')}
              </div>
            </div>

            <!-- Pages Selection (PDF & Images) -->
            <div class="saveas-section" id="saveas-pages-group">
              <span class="saveas-label">${t('saveAs.pages')}</span>
              <div class="saveas-segment-rail saveas-pages-rail" role="radiogroup" aria-label="${t('saveAs.pages')}">
                <button type="button" role="radio" aria-checked="true" class="saveas-seg-btn active" data-saveas-range="all">
                  <span>${t('saveAs.allPages')}</span>
                  <span class="saveas-seg-count tabular-nums">${this._opts.pageCount}</span>
                </button>
                <button type="button" role="radio" aria-checked="false" class="saveas-seg-btn" data-saveas-range="current">
                  <span>${tr('Current', 'فعلی')}</span>
                  <span class="saveas-seg-count tabular-nums">${activePageNum}</span>
                </button>
                ${hasSelected ? `
                <button type="button" role="radio" aria-checked="false" class="saveas-seg-btn" data-saveas-range="selected">
                  <span>${tr('Selected', 'انتخابی')}</span>
                  <span class="saveas-seg-count tabular-nums">${this._opts.selectedPageIndices!.length}</span>
                </button>` : ''}
                <button type="button" role="radio" aria-checked="false" class="saveas-seg-btn" data-saveas-range="custom">
                  <span>${t('saveAs.custom')}</span>
                </button>
              </div>
              <div id="saveas-custom-row" class="saveas-custom-row" hidden>
                <label class="saveas-custom-field">
                  <span class="saveas-custom-label">${tr('From', 'از صفحه')}</span>
                  <input id="saveas-start" class="saveas-num-input tabular-nums" type="number" min="1" max="${this._opts.pageCount}" value="1" />
                </label>
                <span class="saveas-range-dash" aria-hidden="true">–</span>
                <label class="saveas-custom-field">
                  <span class="saveas-custom-label">${tr('To', 'تا صفحه')}</span>
                  <input id="saveas-end" class="saveas-num-input tabular-nums" type="number" min="1" max="${this._opts.pageCount}" value="${this._opts.pageCount}" />
                </label>
              </div>
            </div>

            <!-- Quality (DPI) & Paper Appearance Split Row -->
            <div class="saveas-controls-split" id="saveas-visual-controls">
              <div class="saveas-section" id="saveas-dpi-group">
                <div class="saveas-label-row">
                  <span class="saveas-label">${t('saveAs.quality')}</span>
                  <span class="saveas-label-meta" id="saveas-dpi-meta">${tr('Balanced', 'متعادل')}</span>
                </div>
                <div class="saveas-segment-rail saveas-dpi-rail" role="radiogroup" aria-label="${t('saveAs.quality')}">
                  ${DPI_PRESETS.map(p => `
                    <button
                      type="button"
                      role="radio"
                      aria-checked="${this._dpi === p.value ? 'true' : 'false'}"
                      class="saveas-seg-btn saveas-dpi-btn tabular-nums ${this._dpi === p.value ? 'active' : ''}"
                      data-saveas-dpi="${p.value}"
                    >${p.label}</button>
                  `).join('')}
                </div>
              </div>

              <div class="saveas-section" id="saveas-theme-group">
                <span class="saveas-label">${tr('Paper', 'تم صفحه')}</span>
                <div class="saveas-segment-rail saveas-theme-rail" role="radiogroup" aria-label="${tr('Page Theme', 'تم رنگی صفحات')}">
                  <button
                    type="button"
                    role="radio"
                    aria-checked="${!this._darkMode ? 'true' : 'false'}"
                    class="saveas-seg-btn saveas-theme-btn ${!this._darkMode ? 'active' : ''}"
                    data-saveas-theme="light"
                  >
                    ${getIconSvg('sun', 13)}
                    <span>${tr('Light', 'روشن')}</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked="${this._darkMode ? 'true' : 'false'}"
                    class="saveas-seg-btn saveas-theme-btn ${this._darkMode ? 'active' : ''}"
                    data-saveas-theme="dark"
                  >
                    ${getIconSvg('moon', 13)}
                    <span>${tr('Dark', 'تاریک')}</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- Hairline-Separated Option Rows with Crisp Toggle Switches -->
            <div class="saveas-options-list" id="saveas-pdf-extras">
              <label class="saveas-toggle-row" id="saveas-flatten-group" for="saveas-flatten">
                <span class="saveas-toggle-copy">
                  <span class="saveas-toggle-title">${t('saveAs.flatten')}</span>
                  <span class="saveas-toggle-desc">${t('saveAs.flattenHint')}</span>
                </span>
                <span class="saveas-switch">
                  <input id="saveas-flatten" type="checkbox" role="switch" />
                  <span class="saveas-switch-track" aria-hidden="true"></span>
                </span>
              </label>

              <div class="saveas-password-block" id="saveas-password-group">
                <label class="saveas-toggle-row" for="saveas-encrypt-toggle">
                  <span class="saveas-toggle-copy">
                    <span class="saveas-toggle-title" id="saveas-encrypt-label">${tr('Password protection', 'رمزگذاری فایل خروجی')}</span>
                    <span class="saveas-toggle-desc" id="saveas-encrypt-desc">${tr('Encrypt PDF with a password before saving', 'قفل کردن فایل PDF با رمز عبور پیش از ذخیره')}</span>
                  </span>
                  <span class="saveas-switch">
                    <input id="saveas-encrypt-toggle" type="checkbox" role="switch" />
                    <span class="saveas-switch-track" aria-hidden="true"></span>
                  </span>
                </label>

                <div id="saveas-password-fields" class="saveas-password-fields" hidden>
                  <div class="saveas-pwd-grid">
                    <div class="saveas-pwd-input-wrap">
                      <input id="saveas-pwd-input" class="saveas-pwd-input" type="password" placeholder="${tr('Password', 'رمز عبور')}" autocomplete="new-password" />
                      <button type="button" id="saveas-pwd-eye" class="saveas-pwd-eye" title="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}" aria-label="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}">
                        ${getIconSvg('eye', 14)}
                      </button>
                    </div>
                    <input id="saveas-pwd-confirm" class="saveas-pwd-input" type="password" placeholder="${tr('Confirm password', 'تکرار رمز عبور')}" autocomplete="new-password" />
                  </div>
                  <div id="saveas-pwd-error" class="saveas-pwd-error" role="alert" hidden></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Serene Footer -->
          <div class="saveas-footer">
            ${this._opts.onImportJson ? `
            <button type="button" id="saveas-import-json" class="saveas-ghost-btn" title="${tr('Import annotations from a .json backup file into this document', 'وارد کردن حاشیه‌نویسی‌ها از فایل پشتیبان JSON')}">
              ${getIconSvg('fileUp', 14)}
              <span>${tr('Import JSON…', 'وارد کردن JSON…')}</span>
            </button>
            ` : '<span></span>'}
            <div class="saveas-footer-cta">
              <button type="button" id="saveas-cancel" class="saveas-secondary-btn">${t('saveAs.cancel')}</button>
              <button type="button" id="saveas-submit" class="saveas-primary-btn">
                ${getIconSvg('save', 14)}
                <span id="saveas-submit-label">${t('saveAs.save')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bind();
    this.syncUI();

    // Focus and select filename stem immediately for effortless typing + Enter
    requestAnimationFrame(() => {
      const nameInput = this._container.querySelector<HTMLInputElement>('#saveas-name');
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    });
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

  private getEffectivePageSelection(): { count: number; summaryLabel: string } {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    const total = Math.max(1, this._opts.pageCount);
    if (this._rangeMode === 'current') {
      const cur = Math.max(1, Math.min(total, (this._opts.activePageIndex ?? 0) + 1));
      return { count: 1, summaryLabel: tr(`Page ${cur}`, `صفحه ${cur}`) };
    }
    if (this._rangeMode === 'selected' && this._opts.selectedPageIndices?.length) {
      const n = this._opts.selectedPageIndices.length;
      return {
        count: n,
        summaryLabel: n === 1 ? tr('1 selected page', '۱ صفحه انتخابی') : tr(`${n} selected pages`, `${n} صفحه انتخابی`)
      };
    }
    if (this._rangeMode === 'custom') {
      const rawStart = Math.floor(Number(q<HTMLInputElement>('#saveas-start')?.value) || 1);
      const rawEnd = Math.floor(Number(q<HTMLInputElement>('#saveas-end')?.value) || total);
      const s = Math.max(1, Math.min(total, rawStart));
      const e = Math.max(1, Math.min(total, rawEnd));
      const lo = Math.min(s, e);
      const hi = Math.max(s, e);
      const n = hi - lo + 1;
      return {
        count: n,
        summaryLabel: lo === hi ? tr(`Page ${lo}`, `صفحه ${lo}`) : tr(`Pages ${lo}–${hi}`, `صفحات ${lo} تا ${hi}`)
      };
    }
    return {
      count: total,
      summaryLabel: total === 1 ? tr('1 page', '۱ صفحه') : tr(`${total} pages`, `${total} صفحه`)
    };
  }

  private syncUI(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    const fmt = this._format;
    const isPdf = fmt === 'pdf';
    const isImage = fmt === 'png' || fmt === 'jpeg';
    const isVisual = isPdf || isImage;
    const supportsPassword = fmt === 'pdf' || fmt === 'png' || fmt === 'jpeg' || fmt === 'xfdf';
    const passwordChecked = q<HTMLInputElement>('#saveas-encrypt-toggle')?.checked === true;
    const pageInfo = this.getEffectivePageSelection();

    const visualControls = q('#saveas-visual-controls');
    const pagesGroup = q('#saveas-pages-group');
    const pdfExtras = q('#saveas-pdf-extras');
    const flattenGroup = q('#saveas-flatten-group');
    const passwordGroup = q('#saveas-password-group');
    const customRow = q('#saveas-custom-row');
    const extSuffix = q('#saveas-ext-suffix');
    const filenameIcon = q('#saveas-filename-icon');
    const encryptLabel = q('#saveas-encrypt-label');
    const encryptDesc = q('#saveas-encrypt-desc');
    const hint = q('#saveas-format-hint');
    const liveSummary = q('#saveas-live-summary');
    const dpiMeta = q('#saveas-dpi-meta');
    const submitLabel = q('#saveas-submit-label');

    if (visualControls) visualControls.style.display = isVisual ? '' : 'none';
    if (pagesGroup) pagesGroup.style.display = isVisual ? '' : 'none';
    if (pdfExtras) pdfExtras.style.display = supportsPassword ? '' : 'none';
    if (flattenGroup) flattenGroup.style.display = isPdf ? '' : 'none';
    if (passwordGroup) passwordGroup.style.display = supportsPassword ? '' : 'none';
    if (customRow) customRow.hidden = this._rangeMode !== 'custom';

    // Update extension suffix to match the exact output artifact
    const outputsZip =
      (isImage && (passwordChecked || pageInfo.count > 1)) ||
      (fmt === 'xfdf' && passwordChecked);
    const displayedExt = outputsZip ? '.zip' : FORMAT_EXTENSIONS[fmt];
    if (extSuffix) extSuffix.textContent = displayedExt;

    if (filenameIcon) {
      const iconName = isImage ? 'imagePlus' : fmt === 'json' || fmt === 'xfdf' ? 'code' : 'fileText';
      filenameIcon.innerHTML = getIconSvg(iconName, 16);
    }

    // Update DPI preset descriptor
    if (dpiMeta) {
      const preset = DPI_PRESETS.find(p => p.value === this._dpi) || DPI_PRESETS[1];
      dpiMeta.textContent = tr(preset.descEn, preset.descFa);
    }

    // Update password row wording
    if (encryptLabel) {
      encryptLabel.textContent = isPdf
        ? tr('Password protection', 'رمزگذاری فایل PDF')
        : tr('Password-locked ZIP archive', 'رمزگذاری خروجی در آرشیو ZIP');
    }
    if (encryptDesc) {
      encryptDesc.textContent = isPdf
        ? tr('Encrypt the PDF with a password before saving', 'قفل کردن فایل PDF با رمز عبور پیش از ذخیره')
        : tr('Wrap the exported output in an encrypted .zip archive', 'بسته‌بندی خروجی در یک فایل ZIP رمزگذاری‌شده');
    }

    // Clean typographic summary under the modal title (zero pills!)
    if (liveSummary) {
      if (fmt === 'xfdf') {
        liveSummary.textContent = passwordChecked
          ? tr('All annotations · Adobe XML · Encrypted ZIP', 'همه حاشیه‌نویسی‌ها · XML ادوبی · ZIP رمزگذاری‌شده')
          : tr('All annotations · Standard Adobe XFDF', 'همه حاشیه‌نویسی‌ها · فرمت استاندارد XFDF');
      } else if (fmt === 'json') {
        liveSummary.textContent = tr('Annotations & layers · Lossless backup', 'حاشیه‌نویسی‌ها و لایه‌ها · نسخه پشتیبان کامل');
      } else {
        const themeText = this._darkMode ? tr('Dark paper', 'کاغذ تاریک') : tr('Light paper', 'کاغذ روشن');
        const extra = outputsZip
          ? ` · ${tr('ZIP archive', 'آرشیو ZIP')}`
          : passwordChecked && isPdf
            ? ` · ${tr('Encrypted', 'رمزگذاری‌شده')}`
            : '';
        liveSummary.textContent = `${pageInfo.summaryLabel} · ${this._dpi} DPI · ${themeText}${extra}`;
      }
    }

    // Subtle contextual hint below filename
    if (hint) {
      if (fmt === 'xfdf') {
        hint.textContent = passwordChecked
          ? tr('Packages XFDF annotations inside a password-protected .zip archive.', 'حاشیه‌نویسی‌های XFDF را در یک فایل ZIP رمزگذاری‌شده ذخیره می‌کند.')
          : tr('Exports all annotations in standard Adobe XFDF XML format.', 'تمامی حاشیه‌نویسی‌ها را با فرمت استاندارد Adobe XFDF ذخیره می‌کند.');
      } else if (fmt === 'json') {
        hint.textContent = tr('Exports all annotations and layers as a lossless veditor backup.', 'تمامی حاشیه‌نویسی‌ها و لایه‌ها را به صورت فایل پشتیبان JSON ذخیره می‌کند.');
      } else if (isImage) {
        hint.textContent = passwordChecked
          ? tr('Packages exported image(s) inside a password-protected .zip archive.', 'تصویر(های) خروجی را در یک فایل ZIP رمزگذاری‌شده ذخیره می‌کند.')
          : pageInfo.count > 1
            ? tr(`Bundles ${pageInfo.count} rendered images cleanly into one .zip archive.`, `${pageInfo.count} تصویر خروجی را به صورت یکپارچه در یک فایل ZIP ذخیره می‌کند.`)
            : tr('Downloads the selected page directly as a single high-DPI image.', 'صفحه انتخاب‌شده را مستقیماً به صورت یک تصویر باکیفیت ذخیره می‌کند.');
      } else {
        hint.textContent = this._opts.supportsPicker
          ? t('saveAs.locationPicker')
          : t('saveAs.locationDownload');
      }
    }

    // Dynamic action button label
    if (submitLabel) {
      if (isPdf) {
        submitLabel.textContent = tr('Save PDF', 'ذخیره PDF');
      } else if (outputsZip) {
        submitLabel.textContent = tr('Export ZIP', 'خروجی ZIP');
      } else {
        submitLabel.textContent = tr(`Export ${fmt.toUpperCase()}`, `خروجی ${fmt.toUpperCase()}`);
      }
    }
  }

  private bind(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);
    q('#saveas-close')?.addEventListener('click', () => { if (!this._busy) this.close(); });
    q('#saveas-cancel')?.addEventListener('click', () => { if (!this._busy) this.close(); });
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

    // Format segmented rail
    this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-format]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-saveas-format') as SaveAsFormat | null;
        if (!fmt || fmt === this._format) return;
        this._format = fmt;
        this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-format]').forEach(el => {
          const isActive = el.getAttribute('data-saveas-format') === fmt;
          el.classList.toggle('active', isActive);
          el.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        this.syncUI();
      });
    });

    // Pages segmented rail
    this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-saveas-range') as SaveAsRangeMode | null;
        if (!mode || mode === this._rangeMode) return;
        this._rangeMode = mode;
        this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-range]').forEach(el => {
          const isActive = el.getAttribute('data-saveas-range') === mode;
          el.classList.toggle('active', isActive);
          el.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
        this.syncUI();
        if (mode === 'custom') {
          requestAnimationFrame(() => q<HTMLInputElement>('#saveas-start')?.focus());
        }
      });
    });

    q('#saveas-start')?.addEventListener('input', () => this.syncUI());
    q('#saveas-end')?.addEventListener('input', () => this.syncUI());

    // DPI segmented rail
    this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-dpi]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dpi = Number(btn.getAttribute('data-saveas-dpi')) as SaveAsDpi;
        if (!dpi || dpi === this._dpi) return;
        this._dpi = dpi;
        this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-dpi]').forEach(el => {
          const isActive = Number(el.getAttribute('data-saveas-dpi')) === dpi;
          el.classList.toggle('active', isActive);
          el.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
        this.syncUI();
      });
    });

    // Paper theme segmented toggle
    this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dark = btn.getAttribute('data-saveas-theme') === 'dark';
        if (dark === this._darkMode) return;
        this._darkMode = dark;
        this._container.querySelectorAll<HTMLButtonElement>('[data-saveas-theme]').forEach(el => {
          const isActive = (el.getAttribute('data-saveas-theme') === 'dark') === dark;
          el.classList.toggle('active', isActive);
          el.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
        this.syncUI();
      });
    });

    q('#saveas-import-json')?.addEventListener('click', async () => {
      if (this._busy || !this._opts.onImportJson) return;
      this.close();
      await this._opts.onImportJson();
    });

    // Optional password encryption controls
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
      this.syncUI();
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
      const rawName = (q<HTMLInputElement>('#saveas-name')?.value || '').trim();
      if (!rawName) {
        q<HTMLInputElement>('#saveas-name')?.focus();
        return;
      }

      let password: string | undefined;
      if (this._format !== 'json' && encryptToggle?.checked) {
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

      const name = replaceFileExtension(rawName, this._format);
      const flatten = q<HTMLInputElement>('#saveas-flatten')?.checked === true;
      const start = q<HTMLInputElement>('#saveas-start');
      const end = q<HTMLInputElement>('#saveas-end');

      let pageRange: { start: number; end: number } | undefined;
      let pageIndices: number[] | undefined;
      if (this._rangeMode === 'custom') {
        const s = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(start?.value) || 1)));
        const e = Math.max(1, Math.min(this._opts.pageCount, Math.floor(Number(end?.value) || this._opts.pageCount)));
        pageRange = { start: Math.min(s, e), end: Math.max(s, e) };
      } else if (this._rangeMode === 'current') {
        const cur = Math.max(0, Math.min(this._opts.pageCount - 1, this._opts.activePageIndex ?? 0));
        pageIndices = [cur];
      } else if (this._rangeMode === 'selected') {
        pageIndices = this._opts.selectedPageIndices;
      }

      this._busy = true;
      const submitBtn = q<HTMLButtonElement>('#saveas-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('is-busy');
      }
      try {
        await this._opts.onSubmit({
          format: this._format,
          filename: name,
          dpi: this._dpi,
          flatten,
          darkMode: this._darkMode,
          password,
          pageRange,
          pageIndices
        });
        this.destroy();
      } finally {
        this._busy = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('is-busy');
        }
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
