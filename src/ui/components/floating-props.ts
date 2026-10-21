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
import { Annotation, TextAnnotation, StickyNoteAnnotation } from '../../core/types';
import { textTool } from '../../annotations/tools/text';
import { STICKY_NOTE_COLORS, stickyNoteTool } from '../../annotations/tools/sticky-note';
import { pointerHandler } from '../../input/pointer-handler';

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

  private show(): void {
    if (this._hoverTimeout !== null) {
      window.clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }

    if (store.selectedAnnotationIds.size === 0) {
      this.hideImmediate();
      return;
    }

    this.renderContent();
    this.updatePosition();
    this._container.classList.remove('is-hidden');
    this._isVisible = true;
  }

  private scheduleHide(): void {
    if (this._hoverTimeout !== null) {
      window.clearTimeout(this._hoverTimeout);
    }
    this._hoverTimeout = window.setTimeout(() => {
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
    if (store.selectedAnnotationIds.size === 0) {
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
    if (annotations.length === 0) {
      this.hideImmediate();
      return;
    }

    const first = annotations[0];
    const pageIndex = first.pageIndex;
    const pageLayout = viewportManager.getLayout(pageIndex);
    const scroller = document.getElementById('document-scroll-container');
    if (!pageLayout || !scroller) return;

    const merged = mergeBoundingBoxes(annotations.map(getAnnotationSelectionBox));
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
    let posY = boxBottom + 34;
    if (posY + barHeight > window.innerHeight - 30) {
      // If close to bottom of screen, flip above with generous clearance
      // so it stays well above the top rotation handle (which is at -24px).
      posY = boxScreenY - barHeight - 48;
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
    if (selected.length === 0) return;

    const first = selected[0] as any;
    const isShape = selected.some(a => ['rectangle', 'ellipse', 'polygon', 'freeform-shape'].includes(a.type));
    const hasCornerShape = selected.some(a => ['rectangle', 'polygon', 'freeform-shape'].includes(a.type));
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
          { hex: '#0f172a', label: 'Black' },
          { hex: '#6366f1', label: 'Indigo' },
          { hex: '#10b981', label: 'Emerald' },
          { hex: '#f59e0b', label: 'Amber' },
          { hex: '#f43f5e', label: 'Rose' }
        ];

    this._container.innerHTML = `
      <div class="props-bar-inner">
        <!-- Color Preview & Quick Swatches -->
        <div class="props-bar-group">
          <label class="props-color-bubble-wrap" title="${isAllSticky ? 'Note paper color' : (isShape ? 'Border / Stroke color' : 'Pick color')}">
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
          <button class="props-icon-btn" id="fp-width-dec" title="Decrease size">−</button>
          <span class="props-size-badge" id="fp-width-readout">${currentWidth}px</span>
          <button class="props-icon-btn" id="fp-width-inc" title="Increase size">+</button>
        </div>

        ${isShape ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group props-slider-group">
            <button class="props-pill-btn ${hasFill ? 'active' : ''}" id="fp-fill-toggle" title="Toggle interior fill">
              Fill
            </button>
            <label class="props-color-bubble-wrap" title="Fill color">
              <span class="props-color-bubble" id="fp-fill-color-bubble" style="background-color: ${currentFillColor}; width: 16px; height: 16px; opacity: ${hasFill ? Math.max(0.25, currentFillOpacity / 100) : 0.35};"></span>
              <input type="color" class="props-native-color-picker" id="fp-fill-color-picker" value="${this.ensureHex(currentFillColor)}">
            </label>
            <input type="range" class="props-range-slider fp-live-input" id="fp-fill-opacity-slider"
                   min="0" max="100" step="1" value="${hasFill ? currentFillOpacity : 0}"
                   style="--slider-pct:${hasFill ? currentFillOpacity : 0}%"
                   title="Fill opacity (0-100%, outline stays solid)" aria-label="Shape fill opacity slider">
            <div class="props-num-badge" title="Type fill opacity percentage (0-100%)">
              <input type="number" class="props-num-input fp-live-input" id="fp-fill-opacity-input"
                     min="0" max="100" step="1" value="${hasFill ? currentFillOpacity : 0}"
                     aria-label="Shape fill opacity percentage">
              <span class="props-num-unit">%</span>
            </div>
          </div>
          ${hasCornerShape ? `
            <div class="props-bar-divider"></div>
            <div class="props-bar-group props-slider-group">
              <span class="props-slider-label" title="Corner radius (0 = sharp, up to 48px)">Corner</span>
              <input type="range" class="props-range-slider fp-live-input" id="fp-corner-radius-slider"
                     min="0" max="48" step="1" value="${currentCornerRadius}"
                     style="--slider-pct:${Math.round((currentCornerRadius / 48) * 100)}%"
                     title="Corner radius (0 = sharp, up to 48px)" aria-label="Shape corner radius slider">
              <div class="props-num-badge" title="Type corner radius in px (0-48)">
                <input type="number" class="props-num-input fp-live-input" id="fp-corner-radius-input"
                       min="0" max="48" step="1" value="${currentCornerRadius}"
                       aria-label="Shape corner radius">
                <span class="props-num-unit">px</span>
              </div>
            </div>
          ` : ''}
        ` : `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group props-slider-group">
            <span class="props-slider-label">Opacity</span>
            <input type="range" class="props-range-slider fp-live-input" id="fp-opacity-slider"
                   min="5" max="100" step="1" value="${currentOpacity}"
                   style="--slider-pct:${Math.round(((currentOpacity - 5) / 95) * 100)}%"
                   title="Opacity (5-100%)" aria-label="Annotation opacity slider">
            <div class="props-num-badge" title="Type opacity percentage (5-100%)">
              <input type="number" class="props-num-input fp-live-input" id="fp-opacity-input"
                     min="5" max="100" step="1" value="${currentOpacity}"
                     aria-label="Annotation opacity percentage">
              <span class="props-num-unit">%</span>
            </div>
          </div>
        `}

        ${isSingleText ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group">
            <button class="props-pill-btn" id="fp-edit-text-btn" title="Double-click or click to edit text">
              Edit Text
            </button>
          </div>
        ` : ''}

        ${isSingleSticky ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group">
            <label class="props-color-bubble-wrap" title="Text color">
              <span class="props-color-bubble" style="background-color: ${first.textColor || '#3b2f1e'}; width: 16px; height: 16px;"></span>
              <input type="color" class="props-native-color-picker" id="fp-note-textcolor-picker" value="${this.ensureHex(first.textColor || '#3b2f1e')}">
            </label>
            ${!first.collapsed ? `
              <button class="props-pill-btn" id="fp-edit-note-btn" title="Edit note text">
                Edit Text
              </button>
            ` : ''}
            <button class="props-icon-btn" id="fp-note-collapse-btn" title="${first.collapsed ? 'Expand note' : 'Collapse note to icon'}">
              ${getIconSvg(first.collapsed ? 'expand' : 'compress', 14)}
            </button>
          </div>
        ` : ''}

        <div class="props-bar-divider"></div>

        <!-- Actions: Duplicate, Lock, Delete -->
        <div class="props-bar-group">
          <button class="props-icon-btn" id="fp-duplicate-btn" title="Duplicate (Ctrl+D)">
            ${getIconSvg('plus', 14)}
          </button>
          <button class="props-icon-btn ${isLocked ? 'active' : ''}" id="fp-lock-btn" title="${isLocked ? 'Unlock' : 'Lock'}">
            ${getIconSvg(isLocked ? 'lock' : 'unlock', 14)}
          </button>
          <button class="props-icon-btn is-danger" id="fp-delete-btn" title="Delete">
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
}
