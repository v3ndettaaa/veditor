/**
 * Paper editor for notebooks.
 *
 * One component serves both jobs, because they configure the same thing:
 * `mode: 'create'` builds a new notebook, `mode: 'edit'` restyles the paper of
 * the one already open. Every control live-updates the preview, which is drawn
 * from the generator's own geometry.
 */

import { getIconSvg } from '../../utils/icons';
import { PaperStyle, PaperPattern, PageSizeName, PAGE_SIZES } from '../../core/types';
import {
  PAPER_PRESETS,
  DEFAULT_PAPER,
  SPACING_MIN,
  SPACING_MAX
} from '../../io/notebook';
import { drawPaperPreview } from '../paper-preview';
import { t } from '../i18n';

/** `id` doubles as the translation key (`notebook.patterns.<id>`). */
const PATTERNS: { id: PaperPattern; icon: string }[] = [
  { id: 'blank', icon: 'blankPage' },
  { id: 'lined', icon: 'linedPage' },
  { id: 'grid', icon: 'gridPage' },
  { id: 'dots', icon: 'dotsPage' },
  { id: 'isometric', icon: 'isoPage' }
];

export interface NotebookDialogResult {
  paper: PaperStyle;
  pageSize: PageSizeName;
  pageCount: number;
}

export interface NotebookDialogOptions {
  mode: 'create' | 'edit';
  paper?: PaperStyle;
  pageSize?: PageSizeName;
  onSubmit: (result: NotebookDialogResult) => void | Promise<void>;
  onClose?: () => void;
}

export class NotebookDialogComponent {
  private _container: HTMLElement;
  private _opts: NotebookDialogOptions;
  private _paper: PaperStyle;
  private _pageSize: PageSizeName;
  private _pageCount = 4;
  private _busy = false;

  constructor(container: HTMLElement, opts: NotebookDialogOptions) {
    this._container = container;
    this._opts = opts;
    this._paper = { ...DEFAULT_PAPER, ...(opts.paper ?? {}) };
    this._pageSize = opts.pageSize ?? 'letter';
  }

  public render(): void {
    const isEdit = this._opts.mode === 'edit';
    const p = this._paper;

    this._container.innerHTML = `
      <div class="modal-overlay" id="notebook-overlay">
        <div class="modal-dialog notebook-dialog" role="dialog" aria-modal="true"
             aria-label="${isEdit ? t('notebook.paperTitle') : t('notebook.new')}">
          <div class="panel-header">
            <span class="panel-header-title">
              ${getIconSvg('notebook', 16)}
              ${isEdit ? t('notebook.paperTitle') : t('notebook.new')}
            </span>
            <button id="nb-close" class="icon-btn is-small" title="Close" aria-label="Close">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <div class="notebook-body">
            <div class="notebook-preview">
              <canvas id="nb-preview" class="paper-preview"></canvas>
              <span class="notebook-preview-caption">
                ${PAGE_SIZES[this._pageSize].label} &middot; ${PAGE_SIZES[this._pageSize].width}&times;${PAGE_SIZES[this._pageSize].height} pt
              </span>
            </div>

            <div class="notebook-controls">
              <div class="form-field">
                <span class="form-label">${t('notebook.preset')}</span>
                <div class="chip-row">
                  ${PAPER_PRESETS.map(preset => `
                    <button type="button" class="secondary-btn is-compact"
                            data-nb-preset="${preset.id}">${t('notebook.presets.' + preset.id)}</button>
                  `).join('')}
                </div>
              </div>

              <div class="form-field">
                <span class="form-label">${t('notebook.pattern')}</span>
                <div class="chip-row">
                  ${PATTERNS.map(pat => `
                    <button type="button"
                            class="secondary-btn is-compact ${p.pattern === pat.id ? 'is-selected' : ''}"
                            data-nb-pattern="${pat.id}" aria-pressed="${p.pattern === pat.id}">
                      ${getIconSvg(pat.icon, 14)} ${t('notebook.patterns.' + pat.id)}
                    </button>
                  `).join('')}
                </div>
              </div>

              <div class="form-field" ${p.pattern === 'blank' ? 'hidden' : ''}>
                <div class="prop-label-row">
                  <span class="form-label">${t('notebook.spacing')}</span>
                  <span class="prop-value" id="nb-spacing-out">${p.spacing}pt</span>
                </div>
                <input type="range" id="nb-spacing" class="prop-slider"
                       min="${SPACING_MIN}" max="${SPACING_MAX}" value="${p.spacing}"
                       aria-label="${t('notebook.spacing')}">
              </div>

              <div class="notebook-color-row">
                <div class="form-field">
                  <span class="form-label">${t('notebook.paperColor')}</span>
                  <div class="chip-row">
                    <input type="color" id="nb-paper-color" class="swatch-input"
                           value="${p.paperColor}" aria-label="${t('notebook.paperColor')}">
                    <code class="prop-color-value" id="nb-paper-out">${p.paperColor}</code>
                  </div>
                </div>
                <div class="form-field" ${p.pattern === 'blank' ? 'hidden' : ''}>
                  <span class="form-label">${t('notebook.ruleColor')}</span>
                  <div class="chip-row">
                    <input type="color" id="nb-line-color" class="swatch-input"
                           value="${p.lineColor}" aria-label="${t('notebook.ruleColor')}">
                    <code class="prop-color-value" id="nb-line-out">${p.lineColor}</code>
                  </div>
                </div>
              </div>

              <div class="form-field">
                <span class="form-label">${t('notebook.pageSize')}</span>
                <select id="nb-page-size" class="field" aria-label="${t('notebook.pageSize')}">
                  ${(Object.keys(PAGE_SIZES) as PageSizeName[]).map(key => `
                    <option value="${key}" ${this._pageSize === key ? 'selected' : ''}>
                      ${PAGE_SIZES[key].label} (${PAGE_SIZES[key].width}&times;${PAGE_SIZES[key].height})
                    </option>
                  `).join('')}
                </select>
              </div>

              <label class="notebook-check" ${p.pattern === 'lined' ? '' : 'hidden'}>
                <input type="checkbox" id="nb-margin" ${p.margin ? 'checked' : ''}>
                <span>${t('notebook.marginRule')}</span>
              </label>

              ${isEdit ? `
                <p class="empty-note is-inline">${t('notebook.restyleHint')}</p>
              ` : `
                <div class="form-field">
                  <div class="prop-label-row">
                    <span class="form-label">${t('notebook.startingPages')}</span>
                    <span class="prop-value" id="nb-pages-out">${this._pageCount}</span>
                  </div>
                  <input type="range" id="nb-pages" class="prop-slider"
                         min="1" max="20" value="${this._pageCount}"
                         aria-label="${t('notebook.startingPages')}">
                  <p class="empty-note is-inline">${t('notebook.autoExtendHint')}</p>
                </div>
              `}
            </div>
          </div>

          <div class="form-actions notebook-actions">
            <button id="nb-cancel" class="secondary-btn">${t('notebook.cancel')}</button>
            <button id="nb-submit" class="primary-btn">
              ${isEdit ? t('notebook.apply') : t('notebook.create')}
            </button>
          </div>
        </div>
      </div>
    `;

    this.bind();
    this.paint();
  }

  public destroy(): void {
    this._container.innerHTML = '';
  }

  private paint(): void {
    const canvas = this._container.querySelector<HTMLCanvasElement>('#nb-preview');
    if (canvas) drawPaperPreview(canvas, this._paper, this._pageSize);
  }

  /** Applies a change, then re-renders only if it changes which controls show. */
  private update(patch: Partial<PaperStyle>, structural = false): void {
    this._paper = { ...this._paper, ...patch };
    if (structural) this.render();
    else this.paint();
  }

  private close(): void {
    this.destroy();
    this._opts.onClose?.();
  }

  private bind(): void {
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);

    q('#nb-close')?.addEventListener('click', () => this.close());
    q('#nb-cancel')?.addEventListener('click', () => this.close());
    q('#notebook-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'notebook-overlay') this.close();
    });

    this._container.querySelectorAll<HTMLElement>('[data-nb-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = PAPER_PRESETS.find(p => p.id === btn.dataset.nbPreset);
        if (preset) this.update({ ...preset.paper }, true);
      });
    });

    this._container.querySelectorAll<HTMLElement>('[data-nb-pattern]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.update({ pattern: btn.dataset.nbPattern as PaperPattern }, true);
      });
    });

    const spacing = q<HTMLInputElement>('#nb-spacing');
    spacing?.addEventListener('input', () => {
      const out = q('#nb-spacing-out');
      if (out) out.textContent = `${spacing.value}pt`;
      this.update({ spacing: Number(spacing.value) });
    });

    const paperColor = q<HTMLInputElement>('#nb-paper-color');
    paperColor?.addEventListener('input', () => {
      const out = q('#nb-paper-out');
      if (out) out.textContent = paperColor.value;
      this.update({ paperColor: paperColor.value });
    });

    const lineColor = q<HTMLInputElement>('#nb-line-color');
    lineColor?.addEventListener('input', () => {
      const out = q('#nb-line-out');
      if (out) out.textContent = lineColor.value;
      this.update({ lineColor: lineColor.value });
    });

    q<HTMLInputElement>('#nb-margin')?.addEventListener('change', (e) => {
      this.update({ margin: (e.target as HTMLInputElement).checked });
    });

    q<HTMLSelectElement>('#nb-page-size')?.addEventListener('change', (e) => {
      this._pageSize = (e.target as HTMLSelectElement).value as PageSizeName;
      this.render();
    });

    const pages = q<HTMLInputElement>('#nb-pages');
    pages?.addEventListener('input', () => {
      this._pageCount = Number(pages.value);
      const out = q('#nb-pages-out');
      if (out) out.textContent = pages.value;
    });

    const submit = q<HTMLButtonElement>('#nb-submit');
    submit?.addEventListener('click', async () => {
      if (this._busy) return;
      this._busy = true;
      submit.disabled = true;
      try {
        await this._opts.onSubmit({
          paper: { ...this._paper },
          pageSize: this._pageSize,
          pageCount: this._pageCount
        });
        this.destroy();
      } finally {
        this._busy = false;
      }
    });

    // Re-fit the preview when the dialog is resized by the viewport.
    window.addEventListener('resize', () => this.paint(), { once: true });
  }
}
