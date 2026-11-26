/**
 * Notebook Studio Dialog (Create & Edit Cover + Paper).
 *
 * Goodnotes-inspired split-pane studio:
 * - Left rail: Title input, Cover preview card (active focus frame), Paper preview card
 * - Right top bar: Page size selector, Paper tone selector (on Paper tab),
 *   Portrait/Landscape orientation toggle, Close
 * - Right main pane:
 *   - Cover tab: Categorized Cover gallery (Common, Simple, Solid, Textured + No cover)
 *   - Paper tab: Categorized Paper Template gallery (Essentials, Writing papers, Planner)
 *     tinted live by Paper Tone + full Customize section preserving all existing controls
 *     (Pattern, Spacing, Paper/Rule colors, Margin rule, Starting pages)
 * - Footer: Cancel & Create Notebook / Save Changes
 */

import { getIconSvg } from '../../utils/icons';
import {
  PaperStyle,
  PaperPattern,
  PageSizeName,
  NotebookOrientation,
  NotebookCoverSpec,
  PAGE_SIZES,
  resolveNotebookPageDimensions
} from '../../core/types';
import {
  PAPER_TONES,
  PAPER_TEMPLATES,
  PaperToneId,
  PaperTemplateSpec,
  DEFAULT_PAPER,
  SPACING_MIN,
  SPACING_MAX,
  getPaperToneById,
  inferPaperToneId,
  paperStyleForTemplate,
  findMatchingPaperTemplate
} from '../../io/notebook';
import {
  NO_COVER_SPEC,
  getCommonCovers,
  getCoversByCategory,
  getDefaultNotebookCover,
  getNotebookCoverById,
  getCoverDisplayName,
  renderNotebookCoverSvg
} from '../../io/notebook-covers';
import { drawPaperPreview } from '../paper-preview';
import { t, isFa } from '../i18n';
import { enhanceRangeSliders } from '../slider-scrub';

/** All paper patterns exposed in the Customize controls (`id` matches `notebook.patterns.<id>`). */
const PATTERNS: { id: PaperPattern; icon: string }[] = [
  { id: 'blank', icon: 'blankPage' },
  { id: 'lined', icon: 'linedPage' },
  { id: 'grid', icon: 'gridPage' },
  { id: 'dots', icon: 'dotsPage' },
  { id: 'isometric', icon: 'isoPage' },
  { id: 'cornell', icon: 'linedPage' },
  { id: 'two-column', icon: 'linedPage' },
  { id: 'three-column', icon: 'linedPage' },
  { id: 'weekly', icon: 'gridPage' },
  { id: 'checklist', icon: 'linedPage' }
];

export interface NotebookDialogResult {
  title: string;
  cover: NotebookCoverSpec;
  paper: PaperStyle;
  pageSize: PageSizeName;
  orientation: NotebookOrientation;
  pageCount: number;
}

export interface NotebookDialogOptions {
  mode: 'create' | 'edit';
  title?: string;
  cover?: NotebookCoverSpec | null;
  paper?: PaperStyle;
  pageSize?: PageSizeName;
  orientation?: NotebookOrientation;
  initialTab?: 'cover' | 'paper';
  onSubmit: (result: NotebookDialogResult) => void | Promise<void>;
  onClose?: () => void;
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class NotebookDialogComponent {
  private _container: HTMLElement;
  private _opts: NotebookDialogOptions;
  private _title: string;
  private _cover: NotebookCoverSpec;
  private _paper: PaperStyle;
  private _paperTone: PaperToneId;
  private _activeTemplateId: string | null;
  private _pageSize: PageSizeName;
  private _orientation: NotebookOrientation;
  private _activeTab: 'cover' | 'paper';
  private _pageCount = 4;
  private _busy = false;
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private _onResize: (() => void) | null = null;

  constructor(container: HTMLElement, opts: NotebookDialogOptions) {
    this._container = container;
    this._opts = opts;
    this._title = (opts.title ?? '').replace(/\.pdf$/i, '');
    this._cover = opts.cover !== undefined
      ? (opts.cover ? getNotebookCoverById(opts.cover.id) : NO_COVER_SPEC)
      : (opts.mode === 'create' ? getDefaultNotebookCover() : NO_COVER_SPEC);
    this._paper = { ...DEFAULT_PAPER, ...(opts.paper ?? {}) };
    this._paperTone = inferPaperToneId(this._paper.paperColor);
    this._activeTemplateId = findMatchingPaperTemplate(this._paper)?.id ?? null;
    this._pageSize = opts.pageSize ?? 'letter';
    this._orientation = opts.orientation ?? 'portrait';
    this._activeTab = opts.initialTab ?? 'cover';
  }

  public render(): void {
    if (this._container.querySelector('#notebook-overlay')) {
      this.syncControls();
      this.paint();
      return;
    }

    const isEdit = this._opts.mode === 'edit';
    const fa = isFa();
    const lang: 'en' | 'fa' = fa ? 'fa' : 'en';
    const p = this._paper;

    const commonCovers = getCommonCovers();
    const simpleCovers = getCoversByCategory('simple');
    const solidCovers = getCoversByCategory('solid');
    const texturedCovers = getCoversByCategory('textured');

    const essentialTemplates = PAPER_TEMPLATES.filter(tpl => tpl.category === 'essentials');
    const writingTemplates = PAPER_TEMPLATES.filter(tpl => tpl.category === 'writing');
    const plannerTemplates = PAPER_TEMPLATES.filter(tpl => tpl.category === 'planner');

    const renderCoverSection = (sectionId: string, heading: string, covers: NotebookCoverSpec[]) => `
      <section class="nb-cover-section" data-nb-section="${sectionId}">
        <button type="button" class="nb-section-toggle" data-nb-toggle-section="${sectionId}" aria-expanded="true">
          <span class="nb-section-chevron" aria-hidden="true">▾</span>
          <span>${heading}</span>
        </button>
        <div class="nb-cover-grid" data-nb-section-body="${sectionId}">
          ${covers.map(c => {
            const selected = this._cover.id === c.id;
            const label = getCoverDisplayName(c, lang);
            return `
              <button type="button"
                      class="nb-cover-tile ${selected ? 'is-selected' : ''} ${c.category === 'none' ? 'is-no-cover' : ''}"
                      data-nb-cover="${c.id}"
                      aria-pressed="${selected}"
                      aria-label="${escapeAttr(label)}">
                <span class="nb-cover-frame">
                  ${renderNotebookCoverSvg(c, { landscape: this._orientation === 'landscape', compact: true })}
                </span>
                <span class="nb-cover-label">${escapeAttr(label)}</span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;

    const renderPaperSection = (sectionId: string, heading: string, templates: PaperTemplateSpec[]) => `
      <section class="nb-cover-section" data-nb-section="${sectionId}">
        <button type="button" class="nb-section-toggle" data-nb-toggle-section="${sectionId}" aria-expanded="true">
          <span class="nb-section-chevron" aria-hidden="true">▾</span>
          <span>${heading}</span>
        </button>
        <div class="nb-cover-grid nb-paper-grid" data-nb-section-body="${sectionId}">
          ${templates.map(tpl => {
            const selected = this._activeTemplateId === tpl.id;
            const label = fa ? tpl.labelFa : tpl.label;
            return `
              <button type="button"
                      class="nb-cover-tile nb-paper-tile ${selected ? 'is-selected' : ''}"
                      data-nb-paper-tpl="${tpl.id}"
                      aria-pressed="${selected}"
                      aria-label="${escapeAttr(label)}">
                <span class="nb-cover-frame nb-paper-frame">
                  <canvas class="nb-paper-tile-canvas" data-nb-tpl-canvas="${tpl.id}"></canvas>
                </span>
                <span class="nb-cover-label">${escapeAttr(label)}</span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;

    this._container.innerHTML = `
      <div class="modal-overlay" id="notebook-overlay">
        <div class="modal-dialog notebook-dialog is-studio" role="dialog" aria-modal="true"
             aria-label="${isEdit ? t('notebook.editTitle') : t('notebook.new')}">

          <div class="nb-studio-layout">
            <!-- Left Preview Rail (Title + Cover + Paper) -->
            <aside class="nb-studio-rail">
              <div class="nb-rail-field">
                <label class="nb-rail-heading" for="nb-title">${t('notebook.titleLabel')}</label>
                <input type="text"
                       id="nb-title"
                       class="field nb-title-input"
                       value="${escapeAttr(this._title)}"
                       placeholder="${escapeAttr(t('notebook.untitledPlaceholder'))}"
                       maxlength="80"
                       autocomplete="off" />
              </div>

              <div class="nb-rail-group">
                <span class="nb-rail-heading">${t('notebook.coverLabel')}</span>
                <button type="button"
                        class="nb-rail-card ${this._activeTab === 'cover' ? 'is-active' : ''}"
                        data-nb-tab="cover"
                        aria-pressed="${this._activeTab === 'cover'}">
                  <span class="nb-rail-art nb-rail-cover-art" id="nb-rail-cover-art">
                    ${renderNotebookCoverSvg(this._cover, { landscape: this._orientation === 'landscape', compact: true })}
                  </span>
                  <span class="nb-rail-card-label" id="nb-rail-cover-name">
                    ${escapeAttr(getCoverDisplayName(this._cover, lang))}
                  </span>
                </button>
              </div>

              <div class="nb-rail-group">
                <span class="nb-rail-heading">${t('notebook.paperLabel')}</span>
                <button type="button"
                        class="nb-rail-card ${this._activeTab === 'paper' ? 'is-active' : ''}"
                        data-nb-tab="paper"
                        aria-pressed="${this._activeTab === 'paper'}">
                  <span class="nb-rail-art nb-rail-paper-art">
                    <canvas id="nb-preview" class="paper-preview nb-rail-paper-canvas"></canvas>
                  </span>
                  <span class="nb-rail-card-label" id="nb-rail-paper-name">
                    ${escapeAttr(this.getPaperLabel())}
                  </span>
                </button>
              </div>
            </aside>

            <!-- Right Content Area -->
            <div class="nb-studio-main">
              <header class="nb-studio-topbar">
                <div class="nb-topbar-controls">
                  <label class="nb-size-select-wrap">
                    <span class="nb-size-icon" aria-hidden="true">${getIconSvg('blankPage', 14)}</span>
                    <select id="nb-page-size" class="nb-topbar-select" aria-label="${t('notebook.pageSize')}">
                      ${(Object.keys(PAGE_SIZES) as PageSizeName[]).map(key => `
                        <option value="${key}" ${this._pageSize === key ? 'selected' : ''}>
                          ${PAGE_SIZES[key].label}
                        </option>
                      `).join('')}
                    </select>
                  </label>

                  <label class="nb-size-select-wrap nb-tone-select-wrap" id="nb-tone-wrap" ${this._activeTab === 'paper' ? '' : 'hidden'}>
                    <select id="nb-paper-tone" class="nb-topbar-select" aria-label="${t('notebook.paperTone')}">
                      ${PAPER_TONES.map(tone => `
                        <option value="${tone.id}" ${this._paperTone === tone.id ? 'selected' : ''}>
                          ${escapeAttr(fa ? tone.labelFa : tone.label)}
                        </option>
                      `).join('')}
                    </select>
                  </label>

                  <div class="nb-orient-group" role="group" aria-label="${fa ? 'جهت صفحه' : 'Orientation'}">
                    <button type="button"
                            class="nb-orient-btn ${this._orientation === 'portrait' ? 'is-active' : ''}"
                            data-nb-orientation="portrait"
                            aria-pressed="${this._orientation === 'portrait'}"
                            title="${t('notebook.portrait')}"
                            aria-label="${t('notebook.portrait')}">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="3.5" y="1.75" width="9" height="12.5" rx="1.6"/>
                        <line x1="6" y1="5" x2="10" y2="5"/>
                      </svg>
                    </button>
                    <button type="button"
                            class="nb-orient-btn ${this._orientation === 'landscape' ? 'is-active' : ''}"
                            data-nb-orientation="landscape"
                            aria-pressed="${this._orientation === 'landscape'}"
                            title="${t('notebook.landscape')}"
                            aria-label="${t('notebook.landscape')}">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="1.75" y="3.5" width="12.5" height="9" rx="1.6"/>
                        <line x1="5" y1="6" x2="5" y2="10"/>
                      </svg>
                    </button>
                  </div>
                </div>

                <button type="button" id="nb-close" class="icon-btn is-small" title="${t('notebook.cancel')}" aria-label="${t('notebook.cancel')}">
                  ${getIconSvg('close', 14)}
                </button>
              </header>

              <div class="nb-studio-scroll">
                <!-- Cover Gallery Pane -->
                <div class="nb-pane nb-pane-cover" id="nb-pane-cover" ${this._activeTab === 'cover' ? '' : 'hidden'}>
                  ${renderCoverSection('common', t('notebook.commonCovers'), commonCovers)}
                  ${renderCoverSection('simple', t('notebook.simpleCovers'), simpleCovers)}
                  ${renderCoverSection('solid', t('notebook.solidCovers'), solidCovers)}
                  ${renderCoverSection('textured', t('notebook.texturedCovers'), texturedCovers)}
                </div>

                <!-- Paper Template Gallery + Full Customization Controls -->
                <div class="nb-pane nb-pane-paper-gallery" id="nb-pane-paper" ${this._activeTab === 'paper' ? '' : 'hidden'}>
                  ${renderPaperSection('paper-essentials', t('notebook.paperEssentials'), essentialTemplates)}
                  ${renderPaperSection('paper-writing', t('notebook.paperWriting'), writingTemplates)}
                  ${renderPaperSection('paper-planner', t('notebook.paperPlanner'), plannerTemplates)}

                  <section class="nb-cover-section nb-customize-section" data-nb-section="paper-customize">
                    <div class="nb-customize-header">
                      <button type="button" class="nb-section-toggle" data-nb-toggle-section="paper-customize" aria-expanded="true">
                        <span class="nb-section-chevron" aria-hidden="true">▾</span>
                        <span>${t('notebook.paperCustomize')}</span>
                      </button>
                      <span class="notebook-preview-caption" id="nb-preview-caption"></span>
                    </div>

                    <div class="nb-customize-body" data-nb-section-body="paper-customize">
                      <div class="form-field">
                        <span class="form-label">${t('notebook.pattern')}</span>
                        <div class="chip-row">
                          ${PATTERNS.map(pat => `
                            <button type="button"
                                    class="secondary-btn is-compact ${p.pattern === pat.id ? 'is-selected' : ''}"
                                    data-nb-pattern="${pat.id}" aria-pressed="${p.pattern === pat.id}">
                              ${getIconSvg(pat.icon, 13)} ${t('notebook.patterns.' + pat.id)}
                            </button>
                          `).join('')}
                        </div>
                      </div>

                      <div class="nb-customize-grid">
                        <div class="form-field" id="nb-spacing-field" ${p.pattern === 'blank' ? 'hidden' : ''}>
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
                          <div class="form-field" id="nb-rule-color-field" ${p.pattern === 'blank' ? 'hidden' : ''}>
                            <span class="form-label">${t('notebook.ruleColor')}</span>
                            <div class="chip-row">
                              <input type="color" id="nb-line-color" class="swatch-input"
                                     value="${p.lineColor}" aria-label="${t('notebook.ruleColor')}">
                              <code class="prop-color-value" id="nb-line-out">${p.lineColor}</code>
                            </div>
                          </div>
                        </div>
                      </div>

                      <label class="notebook-check" id="nb-margin-field" ${p.pattern === 'lined' ? '' : 'hidden'}>
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
                  </section>
                </div>
              </div>
            </div>
          </div>

          <footer class="nb-studio-footer">
            <button type="button" id="nb-cancel" class="secondary-btn nb-footer-cancel">${t('notebook.cancel')}</button>
            <button type="button" id="nb-submit" class="primary-btn nb-footer-submit">
              ${isEdit ? t('notebook.apply') : t('notebook.create')}
            </button>
          </footer>
        </div>
      </div>
    `;

    this.bind();
    enhanceRangeSliders(this._container);
    this.syncControls();
    this.paint();
  }

  public destroy(): void {
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    this._container.innerHTML = '';
  }

  private getPaperLabel(): string {
    const fa = isFa();
    if (this._activeTemplateId) {
      const tpl = PAPER_TEMPLATES.find(item => item.id === this._activeTemplateId);
      if (tpl) return fa ? tpl.labelFa : tpl.label;
    }
    const matched = findMatchingPaperTemplate(this._paper);
    if (matched) return fa ? matched.labelFa : matched.label;
    return t(`notebook.patterns.${this._paper.pattern}`);
  }

  private paint(): void {
    const railCanvas = this._container.querySelector<HTMLCanvasElement>('#nb-preview');
    if (railCanvas) {
      drawPaperPreview(railCanvas, this._paper, this._pageSize, this._orientation);
    }
    if (this._activeTab === 'paper') {
      this.paintPaperGalleryThumbnails();
    }
  }

  /** Paints every paper template tile using the active paper tone, size, and orientation. */
  private paintPaperGalleryThumbnails(): void {
    const tone = getPaperToneById(this._paperTone);
    this._container.querySelectorAll<HTMLCanvasElement>('[data-nb-tpl-canvas]').forEach(canvas => {
      const tplId = canvas.dataset.nbTplCanvas;
      const tpl = PAPER_TEMPLATES.find(item => item.id === tplId);
      if (!tpl) return;
      const style = paperStyleForTemplate(tpl, tone);
      drawPaperPreview(canvas, style, this._pageSize, this._orientation);
    });
  }

  private refreshCoverPreviews(): void {
    const lang: 'en' | 'fa' = isFa() ? 'fa' : 'en';
    const isLand = this._orientation === 'landscape';

    const railArt = this._container.querySelector<HTMLElement>('#nb-rail-cover-art');
    if (railArt) {
      railArt.innerHTML = renderNotebookCoverSvg(this._cover, { landscape: isLand, compact: true });
    }
    const railName = this._container.querySelector<HTMLElement>('#nb-rail-cover-name');
    if (railName) {
      railName.textContent = getCoverDisplayName(this._cover, lang);
    }

    this._container.querySelectorAll<HTMLElement>('[data-nb-cover]').forEach(btn => {
      const id = btn.dataset.nbCover || 'none';
      const active = id === this._cover.id;
      btn.classList.toggle('is-selected', active);
      btn.setAttribute('aria-pressed', String(active));
      const frame = btn.querySelector<HTMLElement>('.nb-cover-frame');
      if (frame) {
        const cov = getNotebookCoverById(id);
        frame.innerHTML = renderNotebookCoverSvg(cov, { landscape: isLand, compact: true });
      }
    });
  }

  /** Synchronizes all UI states in place without flashing or rebuilding the modal DOM. */
  private syncControls(): void {
    const p = this._paper;
    const q = <T extends HTMLElement>(sel: string) => this._container.querySelector<T>(sel);

    // Tabs (Cover / Paper)
    this._container.querySelectorAll<HTMLElement>('[data-nb-tab]').forEach(btn => {
      const active = btn.dataset.nbTab === this._activeTab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const coverPane = q('#nb-pane-cover');
    const paperPane = q('#nb-pane-paper');
    if (coverPane) coverPane.hidden = this._activeTab !== 'cover';
    if (paperPane) paperPane.hidden = this._activeTab !== 'paper';

    const toneWrap = q('#nb-tone-wrap');
    if (toneWrap) toneWrap.hidden = this._activeTab !== 'paper';
    const toneSelect = q<HTMLSelectElement>('#nb-paper-tone');
    if (toneSelect && toneSelect.value !== this._paperTone) {
      toneSelect.value = this._paperTone;
    }

    // Orientation buttons
    this._container.querySelectorAll<HTMLElement>('[data-nb-orientation]').forEach(btn => {
      const active = btn.dataset.nbOrientation === this._orientation;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    // Cover highlight & SVG sync
    const lang: 'en' | 'fa' = isFa() ? 'fa' : 'en';
    this._container.querySelectorAll<HTMLElement>('[data-nb-cover]').forEach(btn => {
      const active = btn.dataset.nbCover === this._cover.id;
      btn.classList.toggle('is-selected', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const railArt = q('#nb-rail-cover-art');
    if (railArt) {
      railArt.innerHTML = renderNotebookCoverSvg(this._cover, {
        landscape: this._orientation === 'landscape',
        compact: true
      });
    }
    const railCoverName = q('#nb-rail-cover-name');
    if (railCoverName) railCoverName.textContent = getCoverDisplayName(this._cover, lang);
    const railPaperName = q('#nb-rail-paper-name');
    if (railPaperName) railPaperName.textContent = this.getPaperLabel();

    // Paper template tiles
    this._container.querySelectorAll<HTMLElement>('[data-nb-paper-tpl]').forEach(btn => {
      const active = btn.dataset.nbPaperTpl === this._activeTemplateId;
      btn.classList.toggle('is-selected', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    // Paper patterns in Customize section
    this._container.querySelectorAll<HTMLElement>('[data-nb-pattern]').forEach(btn => {
      const active = btn.dataset.nbPattern === p.pattern;
      btn.classList.toggle('is-selected', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const isBlank = p.pattern === 'blank';
    const spacingField = q('#nb-spacing-field');
    if (spacingField) spacingField.hidden = isBlank;

    const ruleColorField = q('#nb-rule-color-field');
    if (ruleColorField) ruleColorField.hidden = isBlank;

    const marginField = q('#nb-margin-field');
    if (marginField) marginField.hidden = p.pattern !== 'lined';

    const spacingInput = q<HTMLInputElement>('#nb-spacing');
    if (spacingInput) {
      if (document.activeElement !== spacingInput && spacingInput.dataset.dragging !== '1') {
        spacingInput.value = String(p.spacing);
      }
      const spPct = Math.max(0, Math.min(100, ((p.spacing - SPACING_MIN) / (SPACING_MAX - SPACING_MIN)) * 100));
      spacingInput.style.setProperty('--slider-pct', `${spPct}%`);
    }
    const pagesInput = q<HTMLInputElement>('#nb-pages');
    if (pagesInput) {
      const pgPct = Math.max(0, Math.min(100, ((this._pageCount - 1) / 19) * 100));
      pagesInput.style.setProperty('--slider-pct', `${pgPct}%`);
    }
    const spacingOut = q('#nb-spacing-out');
    if (spacingOut) spacingOut.textContent = `${p.spacing}pt`;

    const paperColorInput = q<HTMLInputElement>('#nb-paper-color');
    if (paperColorInput && document.activeElement !== paperColorInput) {
      paperColorInput.value = p.paperColor;
    }
    const paperOut = q('#nb-paper-out');
    if (paperOut) paperOut.textContent = p.paperColor;

    const lineColorInput = q<HTMLInputElement>('#nb-line-color');
    if (lineColorInput && document.activeElement !== lineColorInput) {
      lineColorInput.value = p.lineColor;
    }
    const lineOut = q('#nb-line-out');
    if (lineOut) lineOut.textContent = p.lineColor;

    const marginInput = q<HTMLInputElement>('#nb-margin');
    if (marginInput) marginInput.checked = Boolean(p.margin);

    const pageSizeSelect = q<HTMLSelectElement>('#nb-page-size');
    if (pageSizeSelect && pageSizeSelect.value !== this._pageSize) {
      pageSizeSelect.value = this._pageSize;
    }

    const caption = q('#nb-preview-caption');
    if (caption) {
      const dims = resolveNotebookPageDimensions(this._pageSize, this._orientation);
      const sz = PAGE_SIZES[this._pageSize];
      caption.innerHTML = `${sz.label} &middot; ${dims.width}&times;${dims.height} pt`;
    }
  }

  private updatePaper(patch: Partial<PaperStyle>, explicitTemplateId?: string | null): void {
    this._paper = { ...this._paper, ...patch };
    if (patch.paperColor) {
      this._paperTone = inferPaperToneId(this._paper.paperColor);
    }
    if (explicitTemplateId !== undefined) {
      this._activeTemplateId = explicitTemplateId;
    } else {
      this._activeTemplateId = findMatchingPaperTemplate(this._paper)?.id ?? null;
    }
    this.syncControls();
    this.paint();
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

    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Title input
    const titleInput = q<HTMLInputElement>('#nb-title');
    titleInput?.addEventListener('input', () => {
      this._title = titleInput.value;
    });
    titleInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    // Rail tab switcher (Cover <-> Paper)
    this._container.querySelectorAll<HTMLElement>('[data-nb-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextTab = btn.dataset.nbTab as 'cover' | 'paper';
        if (nextTab === 'cover' || nextTab === 'paper') {
          this._activeTab = nextTab;
          this.syncControls();
          this.paint();
        }
      });
    });

    // Collapsible sections (Cover & Paper galleries + Customize)
    this._container.querySelectorAll<HTMLElement>('[data-nb-toggle-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        const secId = btn.dataset.nbToggleSection;
        if (!secId) return;
        const body = this._container.querySelector<HTMLElement>(`[data-nb-section-body="${secId}"]`);
        if (!body) return;
        const expanded = btn.getAttribute('aria-expanded') !== 'false';
        btn.setAttribute('aria-expanded', String(!expanded));
        body.hidden = expanded;
        const chev = btn.querySelector('.nb-section-chevron');
        if (chev) chev.textContent = expanded ? '▸' : '▾';
        if (!expanded && secId.startsWith('paper-')) {
          this.paintPaperGalleryThumbnails();
        }
      });
    });

    // Cover tile selection
    this._container.querySelectorAll<HTMLElement>('[data-nb-cover]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.nbCover;
        this._cover = getNotebookCoverById(id);
        this.syncControls();
      });
    });

    // Paper template tile selection
    this._container.querySelectorAll<HTMLElement>('[data-nb-paper-tpl]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tplId = btn.dataset.nbPaperTpl;
        const tpl = PAPER_TEMPLATES.find(item => item.id === tplId);
        if (!tpl) return;
        const tone = getPaperToneById(this._paperTone);
        this.updatePaper(paperStyleForTemplate(tpl, tone), tpl.id);
      });
    });

    // Paper tone dropdown (White Paper / Yellow Paper / Warm Paper / Dark Paper)
    q<HTMLSelectElement>('#nb-paper-tone')?.addEventListener('change', (e) => {
      const toneId = (e.target as HTMLSelectElement).value as PaperToneId;
      const tone = getPaperToneById(toneId);
      this._paperTone = tone.id;
      this.updatePaper(
        { paperColor: tone.paperColor, lineColor: tone.lineColor },
        this._activeTemplateId
      );
    });

    // Orientation buttons
    this._container.querySelectorAll<HTMLElement>('[data-nb-orientation]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ori = btn.dataset.nbOrientation as NotebookOrientation;
        if (ori === 'portrait' || ori === 'landscape') {
          this._orientation = ori;
          this.syncControls();
          this.refreshCoverPreviews();
          this.paint();
        }
      });
    });

    // Customize pattern chips
    this._container.querySelectorAll<HTMLElement>('[data-nb-pattern]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.updatePaper({ pattern: btn.dataset.nbPattern as PaperPattern });
      });
    });

    const spacing = q<HTMLInputElement>('#nb-spacing');
    spacing?.addEventListener('input', () => {
      const out = q('#nb-spacing-out');
      if (out) out.textContent = `${spacing.value}pt`;
      this.updatePaper({ spacing: Number(spacing.value) });
    });

    const paperColor = q<HTMLInputElement>('#nb-paper-color');
    paperColor?.addEventListener('input', () => {
      const out = q('#nb-paper-out');
      if (out) out.textContent = paperColor.value;
      this.updatePaper({ paperColor: paperColor.value });
    });

    const lineColor = q<HTMLInputElement>('#nb-line-color');
    lineColor?.addEventListener('input', () => {
      const out = q('#nb-line-out');
      if (out) out.textContent = lineColor.value;
      this.updatePaper({ lineColor: lineColor.value });
    });

    q<HTMLInputElement>('#nb-margin')?.addEventListener('change', (e) => {
      this.updatePaper({ margin: (e.target as HTMLInputElement).checked });
    });

    q<HTMLSelectElement>('#nb-page-size')?.addEventListener('change', (e) => {
      this._pageSize = (e.target as HTMLSelectElement).value as PageSizeName;
      this.syncControls();
      this.paint();
    });

    const pages = q<HTMLInputElement>('#nb-pages');
    pages?.addEventListener('input', () => {
      this._pageCount = Number(pages.value);
      const pgPct = Math.max(0, Math.min(100, ((this._pageCount - 1) / 19) * 100));
      pages.style.setProperty('--slider-pct', `${pgPct}%`);
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
          title: this._title.trim(),
          cover: { ...this._cover },
          paper: { ...this._paper },
          pageSize: this._pageSize,
          orientation: this._orientation,
          pageCount: this._pageCount
        });
        this.destroy();
      } finally {
        this._busy = false;
      }
    });

    this._onResize = () => this.paint();
    window.addEventListener('resize', this._onResize);
  }
}
