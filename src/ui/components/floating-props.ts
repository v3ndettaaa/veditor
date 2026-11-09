/**
 * Floating Contextual Properties Toolbar
 * Replaces the static right sidebar with an elegant, responsive floating toolbar
 * positioned right over/under selected annotations that appears on hover.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand, AddAnnotationCommand } from '../../core/history';
import { getAnnotationSelectionBox, offsetAnnotation } from '../../annotations/selection';
import { mergeBoundingBoxes } from '../../utils/geometry';
import { viewportManager } from '../../core/viewport';
import { getIconSvg } from '../../utils/icons';
import { Annotation, TextAnnotation, StickyNoteAnnotation, HighlighterAnnotation, ShapeAnnotation, Point } from '../../core/types';
import { textTool } from '../../annotations/tools/text';
import { STICKY_NOTE_COLORS, stickyNoteTool } from '../../annotations/tools/sticky-note';
import { pointerHandler } from '../../input/pointer-handler';
import { showToast } from './toast';
import { tr } from '../i18n';

export let floatingPropsBar: FloatingPropsBarComponent | null = null;

export class FloatingPropsBarComponent {
  private _container: HTMLElement;
  private _hoverTimeout: number | null = null;
  private _isHoveredOverItem: boolean = false;
  private _isHoveredOverBar: boolean = false;
  private _isVisible: boolean = false;

  constructor(parent: HTMLElement) {
    floatingPropsBar = this;
    this._container = document.createElement('div');
    this._container.id = 'floating-props-bar';
    this._container.className = 'floating-props-bar is-hidden';
    parent.appendChild(this._container);

    this.bindEvents();
    store.subscribe(() => this.updateState());
  }

  private bindEvents(): void {
    this._container.addEventListener('pointerenter', () => {
      this._isHoveredOverBar = true;
      this.show();
    });

    this._container.addEventListener('pointerleave', () => {
      this._isHoveredOverBar = false;
      this.scheduleHide();
    });

    // Track scroll and zoom to keep toolbar anchored to the selected annotation
    const scroller = document.getElementById('document-scroll-container');
    scroller?.addEventListener('scroll', () => {
      if (this._isVisible) this.updatePosition();
    }, { passive: true });

    window.addEventListener('resize', () => {
      if (this._isVisible) this.updatePosition();
    }, { passive: true });
  }

  /**
   * Called from pointer-handler / canvas when hovering over the selected item.
   */
  public setHoverState(isHovered: boolean): void {
    this._isHoveredOverItem = isHovered;
    // Programmatic selection after creation must not summon the contextual
    // bar; hovering remains the only implicit trigger.
    if (isHovered && store.suppressAutoPanels) return;
    if (isHovered) {
      this.show();
    } else {
      this.scheduleHide();
    }
  }

  public show(): void {
    if (this._hoverTimeout !== null) {
      window.clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }

    if (store.selectedAnnotationIds.size === 0 && !store.textSelection) {
      this.hideImmediate();
      return;
    }

    this.renderContent();
    this.updatePosition();
    this._container.classList.remove('is-hidden');
    this._isVisible = true;
  }

  public showForTextSelection(): void {
    if (!store.textSelection || !store.textSelection.text.trim()) {
      this.hideImmediate();
      return;
    }
    this._isHoveredOverItem = true;
    this.show();
  }

  private scheduleHide(): void {
    if (this._hoverTimeout !== null) {
      window.clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }
    // Keep the floating action bar persistently visible while PDF text is selected
    // until the user clicks elsewhere on the page, presses Escape, or runs an action.
    if (store.textSelection) {
      return;
    }
    this._hoverTimeout = window.setTimeout(() => {
      if (store.textSelection) return;
      const activeEl = document.activeElement;
      if (activeEl && this._container.contains(activeEl)) return;
      if (!this._isHoveredOverItem && !this._isHoveredOverBar) {
        this.hideImmediate();
      }
    }, 250);
  }

  private hideImmediate(): void {
    this._container.classList.add('is-hidden');
    this._isVisible = false;
  }

  /**
   * Used after programmatic selection of a newly created annotation. The
   * selection itself is needed for transform handles, but the contextual bar
   * must stay out of the way until the user deliberately hovers or acts.
   */
  public hideForProgrammaticSelection(): void {
    this._isHoveredOverItem = false;
    this._isHoveredOverBar = false;
    this.hideImmediate();
  }

  private updateState(): void {
    if (store.selectedAnnotationIds.size === 0 && !store.textSelection) {
      this.hideImmediate();
    } else if (this._isVisible) {
      this.renderContent();
      this.updatePosition();
    }
  }

  private getSelectedAnnotations(): Annotation[] {
    const doc = store.activeDocument;
    if (!doc) return [];
    const res: Annotation[] = [];
    for (const [, list] of Object.entries(doc.annotations)) {
      for (const ann of list) {
        if (store.selectedAnnotationIds.has(ann.id)) {
          res.push(ann);
        }
      }
    }
    return res;
  }

  public updatePosition(): void {
    const annotations = this.getSelectedAnnotations();
    const textSel = store.textSelection;
    if (annotations.length === 0 && !textSel) {
      this.hideImmediate();
      return;
    }

    const pageIndex = annotations.length > 0 ? annotations[0].pageIndex : textSel!.pageIndex;
    const pageLayout = viewportManager.getLayout(pageIndex);
    const scroller = document.getElementById('document-scroll-container');
    if (!pageLayout || !scroller) return;

    const merged = annotations.length > 0
      ? mergeBoundingBoxes(annotations.map(getAnnotationSelectionBox))
      : textSel!.bounds;
    const zoom = store.zoom;

    // Convert page coordinates to scrollContainer viewport relative coordinates
    const boxScreenX = pageLayout.left + merged.x * zoom - scroller.scrollLeft;
    const boxScreenY = pageLayout.top + merged.y * zoom - scroller.scrollTop;
    const boxScreenW = merged.width * zoom;

    // Position centered horizontally over the bounding box
    const centerX = boxScreenX + boxScreenW / 2;

    // Check vertical space:
    // Place below the selection by default (16px gap), which guarantees
    // zero collision with the top rotation handle and its stem line.
    const barHeight = 44;
    const boxBottom = boxScreenY + merged.height * zoom;
    let posY = boxBottom + (annotations.length > 0 ? 34 : 14);
    if (posY + barHeight > window.innerHeight - 30) {
      // If close to bottom of screen, flip above with generous clearance
      posY = boxScreenY - barHeight - (annotations.length > 0 ? 48 : 14);
    }

    const toolbarWidth = this._container.offsetWidth || 340;
    const minLeft = toolbarWidth / 2 + 16;
    const maxLeft = window.innerWidth - toolbarWidth / 2 - 16;
    const clampedCenterX = Math.max(minLeft, Math.min(maxLeft, centerX));

    this._container.style.left = `${clampedCenterX}px`;
    this._container.style.top = `${Math.max(65, posY)}px`;
  }

  private renderContent(): void {
    const selected = this.getSelectedAnnotations();
    if (selected.length === 0) {
      if (store.textSelection) {
        this.renderTextSelectionContent();
      }
      return;
    }

    const first = selected[0] as any;
    const isShape = selected.some(a => ['rectangle', 'ellipse', 'polygon', 'freeform-shape'].includes(a.type));
    const hasCornerShape = selected.some(a => ['rectangle', 'polygon', 'freeform-shape'].includes(a.type));
    const isSingleRect = selected.length === 1 && first.type === 'rectangle';
    const isSingleQuadPoly =
      selected.length === 1 &&
      first.type === 'polygon' &&
      Array.isArray(first.points) &&
      first.points.length === 4;
    const rectLockActive = pointerHandler.rectCornerLockMode;
    const currentCornerRadius = Math.max(0, Math.min(48, Math.round(Number.isFinite(first.cornerRadius) ? first.cornerRadius : 0)));
    const isSingleText = selected.length === 1 && first.type === 'text';
    const isSingleSticky = selected.length === 1 && first.type === 'sticky-note';
    const isAllSticky = selected.every(a => a.type === 'sticky-note');
    const currentColor = first.color || first.strokeColor || '#4f46e5';
    const currentWidth = Math.round(Number(first.strokeWidth || first.fontSize || 3));
    const currentOpacity = Math.round((first.opacity ?? 1.0) * 100);
    const hasFill = Boolean(first.fillColor && first.fillColor !== 'transparent');
    const currentFillColor = hasFill ? first.fillColor : (first.strokeColor || store.toolSettings.shapeColor || '#6366f1');
    const currentFillOpacity = hasFill
      ? Math.round((first.fillOpacity ?? 1.0) * 100)
      : Math.round((first.fillOpacity ?? store.toolSettings.shapeFillOpacity ?? 1.0) * 100);
    const isLocked = first.locked === true;

    // Preserve active slider/number input interaction so dragging or typing never loses focus
    const activeEl = document.activeElement;
    if (activeEl && this._container.contains(activeEl) && activeEl.classList.contains('fp-live-input')) {
      return;
    }

    const swatchColors = isAllSticky
      ? STICKY_NOTE_COLORS
      : [
          { hex: '#0f172a', label: tr('Black', 'مشکی') },
          { hex: '#6366f1', label: tr('Indigo', 'نیلی') },
          { hex: '#10b981', label: tr('Emerald', 'زمردی') },
          { hex: '#f59e0b', label: tr('Amber', 'کهربایی') },
          { hex: '#f43f5e', label: tr('Rose', 'سرخابی') }
        ];

    this._container.innerHTML = `
      <div class="props-bar-inner">
        <!-- Color Preview & Quick Swatches -->
        <div class="props-bar-group">
          <label class="props-color-bubble-wrap" title="${isAllSticky ? tr('Note paper color', 'رنگ کاغذ یادداشت') : (isShape ? tr('Border / Stroke color', 'رنگ کادر شکل') : tr('Pick color', 'انتخاب رنگ'))}">
            <span class="props-color-bubble" style="background-color: ${currentColor}"></span>
            <input type="color" class="props-native-color-picker" id="fp-color-picker" value="${this.ensureHex(currentColor)}">
          </label>
          <div class="props-swatch-strip">
            ${swatchColors.map(sw => `
              <button class="props-mini-swatch" data-fp-color="${sw.hex}" style="background: ${sw.hex};" title="${sw.label}"></button>
            `).join('')}
          </div>
        </div>

        <div class="props-bar-divider"></div>

        <!-- Width / Size Stepper -->
        <div class="props-bar-group">
          <button class="props-icon-btn" id="fp-width-dec" title="${tr('Decrease size', 'کاهش اندازه')}">−</button>
          <span class="props-size-badge" id="fp-width-readout">${currentWidth}px</span>
          <button class="props-icon-btn" id="fp-width-inc" title="${tr('Increase size', 'افزایش اندازه')}">+</button>
        </div>

        ${isShape ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group props-slider-group">
            <button class="props-pill-btn ${hasFill ? 'active' : ''}" id="fp-fill-toggle" title="${tr('Toggle interior fill', 'فعال/غیرفعال کردن رنگ داخل شکل')}">
              ${tr('Fill', 'داخل')}
            </button>
            <label class="props-color-bubble-wrap" title="${tr('Fill color', 'رنگ داخل شکل')}">
              <span class="props-color-bubble" id="fp-fill-color-bubble" style="background-color: ${currentFillColor}; width: 16px; height: 16px; opacity: ${hasFill ? Math.max(0.25, currentFillOpacity / 100) : 0.35};"></span>
              <input type="color" class="props-native-color-picker" id="fp-fill-color-picker" value="${this.ensureHex(currentFillColor)}">
            </label>
            <input type="range" class="props-range-slider fp-live-input" id="fp-fill-opacity-slider"
                   min="0" max="100" step="1" value="${hasFill ? currentFillOpacity : 0}"
                   style="--slider-pct:${hasFill ? currentFillOpacity : 0}%"
                   title="${tr('Fill opacity (0-100%, outline stays solid)', 'شفافیت داخل شکل (۰ تا ۱۰۰٪، کادر ثابت می‌ماند)')}" aria-label="${tr('Shape fill opacity slider', 'شفافیت داخل شکل')}">
            <div class="props-num-badge" title="${tr('Type fill opacity percentage (0-100%)', 'درصد شفافیت داخل شکل (۰ تا ۱۰۰٪)')}">
              <input type="number" class="props-num-input fp-live-input" id="fp-fill-opacity-input"
                     min="0" max="100" step="1" value="${hasFill ? currentFillOpacity : 0}"
                     aria-label="${tr('Shape fill opacity percentage', 'درصد شفافیت داخل شکل')}">
              <span class="props-num-unit">%</span>
            </div>
          </div>
          ${hasCornerShape ? `
            <div class="props-bar-divider"></div>
            <div class="props-bar-group props-slider-group">
              <span class="props-slider-label" title="${tr('Corner radius (0 = sharp, up to 48px)', 'گردی گوشه‌ها (۰ = تیز، تا ۴۸ پیکسل)')}">${tr('Corner', 'گوشه')}</span>
              <input type="range" class="props-range-slider fp-live-input" id="fp-corner-radius-slider"
                     min="0" max="48" step="1" value="${currentCornerRadius}"
                     style="--slider-pct:${Math.round((currentCornerRadius / 48) * 100)}%"
                     title="${tr('Corner radius (0 = sharp, up to 48px)', 'گردی گوشه‌ها (۰ = تیز، تا ۴۸ پیکسل)')}" aria-label="${tr('Shape corner radius slider', 'شعاع گردی گوشه')}">
              <div class="props-num-badge" title="${tr('Type corner radius in px (0-48)', 'شعاع گردی گوشه به پیکسل (۰ تا ۴۸)')}">
                <input type="number" class="props-num-input fp-live-input" id="fp-corner-radius-input"
                       min="0" max="48" step="1" value="${currentCornerRadius}"
                       aria-label="${tr('Shape corner radius', 'شعاع گردی گوشه')}">
                <span class="props-num-unit">px</span>
              </div>
              ${isSingleRect ? `
                <button class="props-pill-btn ${rectLockActive ? 'active' : ''}" id="fp-rect-corner-mode-btn"
                        title="${rectLockActive
                          ? tr('Corner drag keeps 90° rectangle (click for Free Corner, or hold Shift while dragging)', 'کشیدن گوشه مستطیل ۹۰ درجه را حفظ می‌کند (برای جابه‌جایی آزاد گوشه کلیک کنید یا Shift را نگه دارید)')
                          : tr('Corner drag moves single vertex freely (click to lock 90° Rectangle, or hold Shift while dragging)', 'کشیدن گوشه فقط همان رأس را آزادانه جابه‌جا می‌کند (برای قفل مستطیل ۹۰ درجه کلیک کنید یا Shift را نگه دارید)')}">
                  ${rectLockActive ? tr('90° Rect', 'مستطیل ۹۰°') : tr('Free Vertex', 'گوشه آزاد')}
                </button>
              ` : ''}
              ${isSingleQuadPoly ? `
                <button class="props-pill-btn" id="fp-make-rect-btn"
                        title="${tr('Snap 4 vertices back into a 90° rectangle', 'تبدیل دوباره ۴ گوشه به مستطیل صاف ۹۰ درجه')}">
                  ${tr('Make 90° Rect', 'تبدیل به مستطیل ۹۰°')}
                </button>
              ` : ''}
            </div>
          ` : ''}
        ` : `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group props-slider-group">
            <span class="props-slider-label">${tr('Opacity', 'شفافیت')}</span>
            <input type="range" class="props-range-slider fp-live-input" id="fp-opacity-slider"
                   min="5" max="100" step="1" value="${currentOpacity}"
                   style="--slider-pct:${Math.round(((currentOpacity - 5) / 95) * 100)}%"
                   title="${tr('Opacity (5-100%)', 'شفافیت (۵ تا ۱۰۰٪)')}" aria-label="${tr('Annotation opacity slider', 'شفافیت')}">
            <div class="props-num-badge" title="${tr('Type opacity percentage (5-100%)', 'درصد شفافیت (۵ تا ۱۰۰٪)')}">
              <input type="number" class="props-num-input fp-live-input" id="fp-opacity-input"
                     min="5" max="100" step="1" value="${currentOpacity}"
                     aria-label="${tr('Annotation opacity percentage', 'درصد شفافیت')}">
              <span class="props-num-unit">%</span>
            </div>
          </div>
        `}

        ${isSingleText ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group">
            <button class="props-pill-btn" id="fp-edit-text-btn" title="${tr('Double-click or click to edit text', 'ویرایش متن')}">
              ${tr('Edit Text', 'ویرایش متن')}
            </button>
          </div>
        ` : ''}

        ${isSingleSticky ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group">
            <label class="props-color-bubble-wrap" title="${tr('Text color', 'رنگ متن یادداشت')}">
              <span class="props-color-bubble" style="background-color: ${first.textColor || '#3b2f1e'}; width: 16px; height: 16px;"></span>
              <input type="color" class="props-native-color-picker" id="fp-note-textcolor-picker" value="${this.ensureHex(first.textColor || '#3b2f1e')}">
            </label>
            ${!first.collapsed ? `
              <button class="props-pill-btn" id="fp-edit-note-btn" title="${tr('Edit note text', 'ویرایش متن یادداشت')}">
                ${tr('Edit Text', 'ویرایش متن')}
              </button>
            ` : ''}
            <button class="props-icon-btn" id="fp-note-collapse-btn" title="${first.collapsed ? tr('Expand note', 'باز کردن یادداشت') : tr('Collapse note to icon', 'جمع کردن یادداشت به آیکون')}">
              ${getIconSvg(first.collapsed ? 'expand' : 'compress', 14)}
            </button>
          </div>
        ` : ''}

        <div class="props-bar-divider"></div>

        <!-- Actions: Duplicate, Lock, Delete -->
        <div class="props-bar-group">
          <button class="props-icon-btn" id="fp-duplicate-btn" title="${tr('Duplicate (Ctrl+D)', 'تکثیر (Ctrl+D)')}">
            ${getIconSvg('plus', 14)}
          </button>
          <button class="props-icon-btn ${isLocked ? 'active' : ''}" id="fp-lock-btn" title="${isLocked ? tr('Unlock', 'باز کردن قفل') : tr('Lock', 'قفل کردن')}">
            ${getIconSvg(isLocked ? 'lock' : 'unlock', 14)}
          </button>
          <button class="props-icon-btn is-danger" id="fp-delete-btn" title="${tr('Delete', 'حذف')}">
            ${getIconSvg('trash', 14)}
          </button>
        </div>
      </div>
    `;

    this.attachHandlers(selected);
  }

  private ensureHex(color: string): string {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    return '#6366f1';
  }

  private attachHandlers(selected: Annotation[]): void {
    const pageIndex = selected[0].pageIndex;

    // Native Color Picker
    const colorPicker = this._container.querySelector<HTMLInputElement>('#fp-color-picker');
    colorPicker?.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      this.applyColor(selected, val);
    });

    // Swatches
    this._container.querySelectorAll('[data-fp-color]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.getAttribute('data-fp-color');
        if (color) this.applyColor(selected, color);
      });
    });

    // Width Stepper
    this._container.querySelector('#fp-width-dec')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.adjustWidth(selected, -1);
    });
    this._container.querySelector('#fp-width-inc')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.adjustWidth(selected, 1);
    });

    // Non-shape Opacity Slider + Number Input
    const opSlider = this._container.querySelector<HTMLInputElement>('#fp-opacity-slider');
    const opInput = this._container.querySelector<HTMLInputElement>('#fp-opacity-input');
    const applyGeneralOpacity = (pctRaw: number, rerender: boolean) => {
      const pct = Math.max(5, Math.min(100, Math.round(pctRaw)));
      const op = pct / 100;
      if (opSlider && document.activeElement !== opSlider) opSlider.value = String(pct);
      if (opSlider) opSlider.style.setProperty('--slider-pct', `${Math.round(((pct - 5) / 95) * 100)}%`);
      if (opInput && document.activeElement !== opInput) opInput.value = String(pct);
      const currentSelected = this.getSelectedAnnotations();
      currentSelected.forEach(ann => {
        const next = { ...ann, opacity: op, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.setActivePageIndex(pageIndex);
      if (rerender) this.renderContent();
    };
    opSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyGeneralOpacity(val, false);
    });
    opInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyGeneralOpacity(val, false);
    });
    opInput?.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyGeneralOpacity(val, false);
    });

    // Shape Fill Toggle, Fill Color Picker, and Independent Fill Opacity Slider + Number Input
    const fillToggleBtn = this._container.querySelector<HTMLButtonElement>('#fp-fill-toggle');
    const fillColorPicker = this._container.querySelector<HTMLInputElement>('#fp-fill-color-picker');
    const fillColorBubble = this._container.querySelector<HTMLElement>('#fp-fill-color-bubble');
    const fillOpSlider = this._container.querySelector<HTMLInputElement>('#fp-fill-opacity-slider');
    const fillOpInput = this._container.querySelector<HTMLInputElement>('#fp-fill-opacity-input');

    const syncFillControlsDOM = (pct: number, hasActiveFill: boolean, fillCol?: string) => {
      if (fillOpSlider && document.activeElement !== fillOpSlider) fillOpSlider.value = String(pct);
      if (fillOpSlider) fillOpSlider.style.setProperty('--slider-pct', `${pct}%`);
      if (fillOpInput && document.activeElement !== fillOpInput) fillOpInput.value = String(pct);
      fillToggleBtn?.classList.toggle('active', hasActiveFill && pct > 0);
      if (fillColorBubble) {
        if (fillCol && fillCol !== 'transparent') fillColorBubble.style.backgroundColor = fillCol;
        fillColorBubble.style.opacity = (hasActiveFill && pct > 0) ? String(Math.max(0.25, pct / 100)) : '0.35';
      }
    };

    fillToggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentSelected = this.getSelectedAnnotations();
      currentSelected.forEach(ann => {
        const a = ann as any;
        const current = a.fillColor;
        const isCurrentlyFilled = Boolean(current && current !== 'transparent' && (a.fillOpacity ?? 1) > 0);
        const nextFill = isCurrentlyFilled
          ? 'transparent'
          : (store.toolSettings.shapeFillColor !== 'transparent'
              ? store.toolSettings.shapeFillColor
              : (a.color || a.strokeColor || '#6366f1'));
        const nextFillOp = isCurrentlyFilled
          ? (a.fillOpacity ?? 1.0)
          : ((a.fillOpacity && a.fillOpacity > 0) ? a.fillOpacity : (store.toolSettings.shapeFillOpacity || 0.35));
        const next = { ...a, fillColor: nextFill, fillOpacity: nextFillOp, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        store.updateToolSettings({ shapeFillColor: nextFill, shapeFillOpacity: nextFillOp });
      });
      store.setActivePageIndex(pageIndex);
      this.renderContent();
    });

    fillColorPicker?.addEventListener('input', (e) => {
      e.stopPropagation();
      const chosenColor = (e.target as HTMLInputElement).value;
      const currentSelected = this.getSelectedAnnotations();
      let appliedPct = 100;
      currentSelected.forEach(ann => {
        const a = ann as any;
        const nextOp = (a.fillOpacity !== undefined && a.fillOpacity > 0) ? a.fillOpacity : (store.toolSettings.shapeFillOpacity || 1.0);
        appliedPct = Math.round(nextOp * 100);
        const next = { ...a, fillColor: chosenColor, fillOpacity: nextOp, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.updateToolSettings({ shapeFillColor: chosenColor });
      syncFillControlsDOM(appliedPct, true, chosenColor);
      store.setActivePageIndex(pageIndex);
    });

    const applyShapeFillOpacityLive = (pctRaw: number) => {
      const pct = Math.max(0, Math.min(100, Math.round(pctRaw)));
      const fillOp = pct / 100;
      const currentSelected = this.getSelectedAnnotations();
      let activeFillHex = '#6366f1';
      currentSelected.forEach(ann => {
        const a = ann as any;
        let nextFillColor = a.fillColor;
        if ((!nextFillColor || nextFillColor === 'transparent') && pct > 0) {
          nextFillColor = store.toolSettings.shapeFillColor !== 'transparent'
            ? store.toolSettings.shapeFillColor
            : (a.strokeColor || a.color || '#6366f1');
        }
        if (nextFillColor && nextFillColor !== 'transparent') {
          activeFillHex = nextFillColor;
        }
        const next = {
          ...a,
          fillColor: pct === 0 ? 'transparent' : nextFillColor,
          fillOpacity: fillOp,
          updatedAt: Date.now()
        };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.updateToolSettings({ shapeFillOpacity: fillOp });
      syncFillControlsDOM(pct, pct > 0, activeFillHex);
      store.setActivePageIndex(pageIndex);
    };

    fillOpSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyShapeFillOpacityLive(val);
    });
    fillOpInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyShapeFillOpacityLive(val);
    });
    fillOpInput?.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyShapeFillOpacityLive(val);
    });

    // Shape Corner Radius Slider + Number Input
    const cornerRadSlider = this._container.querySelector<HTMLInputElement>('#fp-corner-radius-slider');
    const cornerRadInput = this._container.querySelector<HTMLInputElement>('#fp-corner-radius-input');
    const applyCornerRadiusLive = (rawRad: number) => {
      const r = Math.max(0, Math.min(48, Math.round(rawRad)));
      if (cornerRadSlider && document.activeElement !== cornerRadSlider) cornerRadSlider.value = String(r);
      if (cornerRadSlider) cornerRadSlider.style.setProperty('--slider-pct', `${Math.round((r / 48) * 100)}%`);
      if (cornerRadInput && document.activeElement !== cornerRadInput) cornerRadInput.value = String(r);
      const currentSelected = this.getSelectedAnnotations();
      currentSelected.forEach(ann => {
        if (ann.type === 'rectangle' || ann.type === 'polygon' || ann.type === 'freeform-shape') {
          const next = { ...ann, cornerRadius: r, updatedAt: Date.now() };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        }
      });
      store.updateToolSettings({ shapeCornerRadius: r });
      store.setActivePageIndex(pageIndex);
    };
    cornerRadSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyCornerRadiusLive(val);
    });
    cornerRadInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyCornerRadiusLive(val);
    });
    cornerRadInput?.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(val)) applyCornerRadiusLive(val);
    });

    // Rectangle corner-drag mode toggle (Free Vertex vs 90° Rect)
    this._container.querySelector('#fp-rect-corner-mode-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      pointerHandler.setRectCornerLockMode(!pointerHandler.rectCornerLockMode);
      this.renderContent();
    });

    // Convert 4-vertex polygon back to a clean 90° rectangle
    this._container.querySelector('#fp-make-rect-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'polygon') return;
      const next = {
        ...first,
        type: 'rectangle' as const,
        points: undefined,
        updatedAt: Date.now()
      };
      history.execute(new ModifyAnnotationCommand(first.pageIndex, first, next));
      window.app?.repaintAllRenderedAnnotations();
      this.renderContent();
    });

    // Edit Text button
    this._container.querySelector('#fp-edit-text-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'text') return;
      const pageContainer = document.querySelector<HTMLElement>(`.pdf-page-container[data-page-index="${first.pageIndex}"]`);
      const scratchCanvas = pageContainer?.querySelector<HTMLCanvasElement>('.scratchpad-canvas');
      if (scratchCanvas) {
        this.hideImmediate();
        pointerHandler.editExistingTextAnnotation(first as TextAnnotation, first.pageIndex, scratchCanvas, () => {
          window.app?.repaintAllRenderedAnnotations();
        });
      }
    });

    // Sticky Note Text & Ink Color Picker
    const noteTextColorPicker = this._container.querySelector<HTMLInputElement>('#fp-note-textcolor-picker');
    noteTextColorPicker?.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      const next: StickyNoteAnnotation = { ...first, textColor: val, updatedAt: Date.now() };
      history.execute(new ModifyAnnotationCommand(first.pageIndex, first, next));
      store.updateToolSettings({ noteTextColor: val });
      window.app?.repaintAllRenderedAnnotations();
    });

    // Sticky Note Edit Text button
    this._container.querySelector('#fp-edit-note-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      const pageContainer = document.querySelector<HTMLElement>(`.pdf-page-container[data-page-index="${first.pageIndex}"]`);
      const scratchCanvas = pageContainer?.querySelector<HTMLCanvasElement>('.scratchpad-canvas');
      if (scratchCanvas) {
        this.hideImmediate();
        pointerHandler.editExistingStickyNote(first, first.pageIndex, scratchCanvas, () => {
          window.app?.repaintAllRenderedAnnotations();
        });
      }
    });

    // Sticky Note Collapse / Expand toggle
    this._container.querySelector('#fp-note-collapse-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      const pageMeta = store.activeDocument?.pages?.[first.pageIndex];
      const rot = (((store.pageRotations?.[first.pageIndex] ?? pageMeta?.rotation ?? 0) % 360) + 360) % 360;
      const swapped = rot === 90 || rot === 270;
      const pageW = pageMeta ? (swapped ? pageMeta.height : pageMeta.width) : 0;
      const pageH = pageMeta ? (swapped ? pageMeta.width : pageMeta.height) : 0;
      const next: StickyNoteAnnotation = first.collapsed
        ? stickyNoteTool.expandStickyNoteForPage(first, pageW, pageH)
        : stickyNoteTool.collapseStickyNote(first);
      history.execute(new ModifyAnnotationCommand(first.pageIndex, first, next));
      if (next.collapsed) {
        store.setActiveTool('select');
      }
      window.app?.repaintAllRenderedAnnotations();
      this.renderContent();
      this.updatePosition();
    });

    // Duplicate
    this._container.querySelector('#fp-duplicate-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const newIds: string[] = [];
      selected.forEach(ann => {
        const duplicate = offsetAnnotation(ann, 16, 16);
        duplicate.id = 'ann_' + Math.random().toString(36).substring(2, 9);
        duplicate.createdAt = Date.now();
        duplicate.updatedAt = Date.now();
        history.execute(new AddAnnotationCommand(ann.pageIndex, duplicate));
        newIds.push(duplicate.id);
      });
      store.setSelectedAnnotationIds(newIds);
    });

    // Lock / Unlock
    this._container.querySelector('#fp-lock-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selected.forEach(ann => {
        const next = { ...ann, locked: !ann.locked, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.setActivePageIndex(pageIndex);
      this.renderContent();
    });

    // Delete
    this._container.querySelector('#fp-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      history.execute(new DeleteAnnotationsCommand(pageIndex, selected));
      store.clearSelection();
      this.hideImmediate();
    });
  }

  private applyColor(selected: Annotation[], color: string): void {
    selected.forEach(ann => {
      const prev = ann as any;
      const next = { ...prev, updatedAt: Date.now() };
      if ('color' in next) next.color = color;
      if ('strokeColor' in next) next.strokeColor = color;
      if (ann.type === 'sticky-note') {
        store.updateToolSettings({ noteColor: color });
      }
      history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
    });
    store.setActivePageIndex(selected[0].pageIndex);
    this.renderContent();
  }

  private adjustWidth(selected: Annotation[], delta: number): void {
    selected.forEach(ann => {
      const a = ann as any;
      if ('strokeWidth' in a) {
        const nw = Math.max(0.5, Math.min(80, (a.strokeWidth || 3) + delta));
        const next = { ...a, strokeWidth: nw, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, a, next));
      } else if (a.type === 'sticky-note') {
        const nf = Math.max(10, Math.min(96, (a.fontSize || 24) + delta * 2));
        const next: StickyNoteAnnotation = {
          ...a,
          fontSize: nf,
          updatedAt: Date.now()
        };
        store.updateToolSettings({ noteFontSize: nf });
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, a, next));
      } else if ('fontSize' in a) {
        const nf = Math.max(8, Math.min(120, (a.fontSize || 16) + delta * 2));
        const measured = textTool.measureTextBox(
          a.text || '',
          nf,
          a.fontFamily || 'Inter',
          a.padding ?? 8,
          a.fontWeight,
          a.fontStyle
        );
        const next = {
          ...a,
          fontSize: nf,
          box: {
            x: a.box.x,
            y: a.box.y,
            width: measured.width,
            height: measured.height
          },
          updatedAt: Date.now()
        };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, a, next));
      }
    });
    store.setActivePageIndex(selected[0].pageIndex);
    this.renderContent();
  }

  private renderTextSelectionContent(): void {
    const sel = store.textSelection;
    if (!sel) return;

    const highlightSwatches = [
      { hex: '#fde047', rgba: 'rgba(250, 204, 21, 0.38)', label: tr('Highlight Yellow', 'هایلایت زرد') },
      { hex: '#86efac', rgba: 'rgba(74, 222, 128, 0.38)', label: tr('Highlight Green', 'هایلایت سبز') },
      { hex: '#93c5fd', rgba: 'rgba(96, 165, 250, 0.38)', label: tr('Highlight Blue', 'هایلایت آبی') },
      { hex: '#f9a8d4', rgba: 'rgba(244, 114, 182, 0.38)', label: tr('Highlight Pink', 'هایلایت صورتی') },
      { hex: '#fdba74', rgba: 'rgba(251, 146, 60, 0.38)', label: tr('Highlight Orange', 'هایلایت نارنجی') }
    ];

    this._container.innerHTML = `
      <div class="props-bar-inner">
        <div class="props-bar-group" title="${tr('Highlight selected text', 'هایلایت کردن متن انتخاب‌شده')}">
          <div class="props-swatch-strip">
            ${highlightSwatches.map(sw => `
              <button class="props-mini-swatch" data-sel-highlight="${sw.rgba}" style="background: ${sw.hex};" title="${sw.label}"></button>
            `).join('')}
          </div>
        </div>

        <div class="props-bar-divider"></div>

        <div class="props-bar-group">
          <button class="props-pill-btn" id="fp-sel-underline" title="${tr('Underline selected text', 'خط زیر متن انتخاب‌شده')}">
            <span style="text-decoration: underline; font-weight: 600;">U</span>
          </button>
          <button class="props-pill-btn" id="fp-sel-strike" title="${tr('Strikethrough selected text', 'خط خورده کردن متن انتخاب‌شده')}">
            <span style="text-decoration: line-through; font-weight: 600;">S</span>
          </button>
          <button class="props-pill-btn" id="fp-sel-note" title="${tr('Add Sticky Note for selected text', 'افزودن یادداشت چسبان برای متن انتخاب‌شده')}">
            ${getIconSvg('stickyNote', 13)} ${tr('Note', 'یادداشت')}
          </button>
        </div>

        <div class="props-bar-divider"></div>

        <div class="props-bar-group">
          <button class="props-pill-btn" id="fp-sel-copy" title="${tr('Copy selected text (Ctrl+C)', 'کپی کردن متن انتخاب‌شده (Ctrl+C)')}">
            ${getIconSvg('copy', 13)} ${tr('Copy', 'کپی')}
          </button>
        </div>
      </div>
    `;

    this.attachTextSelectionHandlers();
  }

  private attachTextSelectionHandlers(): void {
    const sel = store.textSelection;
    if (!sel) return;

    // Highlight color swatches -> create quadPoints HighlighterAnnotation
    this._container.querySelectorAll<HTMLElement>('[data-sel-highlight]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.getAttribute('data-sel-highlight') || 'rgba(250, 204, 21, 0.38)';
        const currentSel = store.textSelection;
        if (!currentSel || currentSel.rects.length === 0) return;

        const b = currentSel.bounds;
        const bw = Math.max(1, b.width);
        const bh = Math.max(1, b.height);
        const quadPoints: Point[][] = currentSel.rects.map((r) => {
          const x0 = (r.x - b.x) / bw;
          const y0 = (r.y - b.y) / bh;
          const x1 = (r.x + r.width - b.x) / bw;
          const y1 = (r.y + r.height - b.y) / bh;
          return [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 }
          ];
        });

        const now = Date.now();
        const ann: HighlighterAnnotation = {
          id: `hl_${Math.random().toString(36).slice(2, 9)}_${now.toString(36)}`,
          pageIndex: currentSel.pageIndex,
          layerId: 'default',
          type: 'highlighter',
          box: { ...b },
          createdAt: now,
          updatedAt: now,
          opacity: 0.38,
          points: [],
          color,
          strokeWidth: Math.max(8, Math.round(currentSel.rects[0]?.height || 14)),
          blendMode: 'multiply',
          quadPoints,
          tipShape: 'chisel'
        };

        history.execute(new AddAnnotationCommand(currentSel.pageIndex, ann));
        store.setTextSelection(null);
        this.hideImmediate();
        window.app?.repaintAllRenderedAnnotations();
      });
    });

    // Underline / Strikethrough helper
    const createLineMarkup = (mode: 'underline' | 'strike') => {
      const currentSel = store.textSelection;
      if (!currentSel || currentSel.rects.length === 0) return;
      const now = Date.now();
      const strokeColor = mode === 'underline' ? '#2563eb' : '#ef4444';

      for (let i = 0; i < currentSel.rects.length; i++) {
        const r = currentSel.rects[i];
        // Place underline cleanly below the glyph descender box so it never cuts through the middle of letters
        const lineY = mode === 'underline'
          ? r.y + r.height + Math.max(1.2, r.height * 0.06)
          : r.y + r.height * 0.48;
        const ann: ShapeAnnotation = {
          id: `${mode}_${Math.random().toString(36).slice(2, 9)}_${now.toString(36)}_${i}`,
          pageIndex: currentSel.pageIndex,
          layerId: 'default',
          type: 'line',
          box: {
            x: r.x,
            y: Math.max(0, lineY - 2),
            width: Math.max(2, r.width),
            height: 4
          },
          createdAt: now,
          updatedAt: now,
          opacity: 1,
          strokeColor,
          fillColor: 'transparent',
          strokeWidth: 1.6,
          strokeStyle: 'solid',
          points: [
            { x: r.x, y: lineY },
            { x: r.x + r.width, y: lineY }
          ]
        };
        history.execute(new AddAnnotationCommand(currentSel.pageIndex, ann));
      }

      store.setTextSelection(null);
      this.hideImmediate();
      window.app?.repaintAllRenderedAnnotations();
    };

    this._container.querySelector('#fp-sel-underline')?.addEventListener('click', (e) => {
      e.stopPropagation();
      createLineMarkup('underline');
    });

    this._container.querySelector('#fp-sel-strike')?.addEventListener('click', (e) => {
      e.stopPropagation();
      createLineMarkup('strike');
    });

    // Add Sticky Note
    this._container.querySelector('#fp-sel-note')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentSel = store.textSelection;
      if (!currentSel) return;
      const pageMeta = store.activeDocument?.pages?.[currentSel.pageIndex];
      const pageW = pageMeta?.width || 612;
      const pageH = pageMeta?.height || 792;
      const noteX = Math.max(8, Math.min(pageW - 46, currentSel.bounds.x + currentSel.bounds.width + 6));
      const noteY = Math.max(8, Math.min(pageH - 46, currentSel.bounds.y));
      const noteText = currentSel.text.trim();
      const hasRtl = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(noteText);

      const note = stickyNoteTool.createStickyNote(
        currentSel.pageIndex,
        { x: noteX, y: noteY },
        {
          text: noteText,
          color: store.toolSettings.noteColor || '#fef08a',
          textColor: store.toolSettings.noteTextColor || '#3b2f1e',
          textAlign: hasRtl ? 'right' : 'left',
          fontFamily: hasRtl ? 'Vazirmatn' : 'Inter',
          collapsed: false,
        }
      );
      history.execute(new AddAnnotationCommand(currentSel.pageIndex, note));
      store.setTextSelection(null);
      store.selectAnnotation(note.id);
      window.app?.repaintAllRenderedAnnotations();
    });

    // Copy selected text
    this._container.querySelector('#fp-sel-copy')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const currentSel = store.textSelection;
      if (!currentSel || !currentSel.text) return;
      try {
        await navigator.clipboard.writeText(currentSel.text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = currentSel.text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast(tr('Copied text to clipboard', 'متن در کلیپ‌بورد کپی شد'), 'success');
      store.setTextSelection(null);
      this.hideImmediate();
      window.app?.repaintAllRenderedAnnotations();
    });
  }
}
