/**
 * Floating Contextual Properties Toolbar
 * Replaces the static right sidebar with an elegant, responsive floating toolbar
 * positioned right over/under selected annotations that appears on hover.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand, AddAnnotationCommand } from '../../core/history';
import { getAnnotationSelectionBox } from '../../annotations/selection';
import { mergeBoundingBoxes } from '../../utils/geometry';
import { viewportManager } from '../../core/viewport';
import { getIconSvg } from '../../utils/icons';
import { Annotation } from '../../core/types';

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
      if (!this._isHoveredOverItem && !this._isHoveredOverBar) {
        this.hideImmediate();
      }
    }, 250);
  }

  private hideImmediate(): void {
    this._container.classList.add('is-hidden');
    this._isVisible = false;
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
    const isSticky = selected.some(a => a.type === 'sticky-note');
    const currentColor = isSticky
      ? (first.paper?.paperColor || '#fef08a')
      : (first.color || '#4f46e5');
    const currentWidth = Math.round(Number(first.strokeWidth || first.fontSize || 3));
    const currentOpacity = Math.round((first.opacity ?? 1.0) * 100);
    const isLocked = first.locked === true;

    this._container.innerHTML = `
      <div class="props-bar-inner">
        <!-- Color Preview & Quick Swatches -->
        <div class="props-bar-group">
          <label class="props-color-bubble-wrap" title="Pick color">
            <span class="props-color-bubble" style="background-color: ${currentColor}"></span>
            <input type="color" class="props-native-color-picker" id="fp-color-picker" value="${this.ensureHex(currentColor)}">
          </label>
          <div class="props-swatch-strip">
            <button class="props-mini-swatch" data-fp-color="#0f172a" style="background: #0f172a;" title="Black"></button>
            <button class="props-mini-swatch" data-fp-color="#6366f1" style="background: #6366f1;" title="Indigo"></button>
            <button class="props-mini-swatch" data-fp-color="#10b981" style="background: #10b981;" title="Emerald"></button>
            <button class="props-mini-swatch" data-fp-color="#f59e0b" style="background: #f59e0b;" title="Amber"></button>
            <button class="props-mini-swatch" data-fp-color="#f43f5e" style="background: #f43f5e;" title="Rose"></button>
            ${isSticky ? `<button class="props-mini-swatch" data-fp-color="#fef08a" style="background: #fef08a;" title="Yellow note"></button>` : ''}
          </div>
        </div>

        <div class="props-bar-divider"></div>

        <!-- Width / Size Stepper -->
        <div class="props-bar-group">
          <button class="props-icon-btn" id="fp-width-dec" title="Decrease size">−</button>
          <span class="props-size-badge" id="fp-width-readout">${currentWidth}px</span>
          <button class="props-icon-btn" id="fp-width-inc" title="Increase size">+</button>
        </div>

        <!-- Opacity Presets -->
        <div class="props-bar-divider"></div>
        <div class="props-bar-group">
          <button class="props-pill-btn ${currentOpacity <= 35 ? 'active' : ''}" data-fp-opacity="0.3">30%</button>
          <button class="props-pill-btn ${currentOpacity > 35 && currentOpacity <= 75 ? 'active' : ''}" data-fp-opacity="0.6">60%</button>
          <button class="props-pill-btn ${currentOpacity > 75 ? 'active' : ''}" data-fp-opacity="1.0">100%</button>
        </div>

        ${isShape ? `
          <div class="props-bar-divider"></div>
          <div class="props-bar-group">
            <button class="props-pill-btn ${first.fillColor && first.fillColor !== 'transparent' ? 'active' : ''}" id="fp-fill-toggle">
              Fill
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

    // Opacity
    this._container.querySelectorAll('[data-fp-opacity]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const op = parseFloat(btn.getAttribute('data-fp-opacity') || '1.0');
        selected.forEach(ann => {
          const next = { ...ann, opacity: op, updatedAt: Date.now() };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        });
        store.setActivePageIndex(pageIndex);
        this.renderContent();
      });
    });

    // Shape Fill Toggle
    this._container.querySelector('#fp-fill-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selected.forEach(ann => {
        const a = ann as any;
        const current = a.fillColor;
        const nextFill = (!current || current === 'transparent') ? (a.color || '#6366f1') : 'transparent';
        const next = { ...a, fillColor: nextFill, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.setActivePageIndex(pageIndex);
      this.renderContent();
    });

    // Duplicate
    this._container.querySelector('#fp-duplicate-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const newIds: string[] = [];
      selected.forEach(ann => {
        const duplicate = JSON.parse(JSON.stringify(ann));
        duplicate.id = 'ann_' + Math.random().toString(36).substring(2, 9);
        duplicate.box.x += 16;
        duplicate.box.y += 16;
        if (Array.isArray(duplicate.points)) {
          duplicate.points = duplicate.points.map((p: any) => ({ ...p, x: p.x + 16, y: p.y + 16 }));
        }
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
      let next: any;
      if (ann.type === 'sticky-note') {
        next = {
          ...prev,
          paper: { ...(prev.paper || {}), paperColor: color },
          updatedAt: Date.now()
        };
      } else {
        next = { ...prev, color, updatedAt: Date.now() };
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
      } else if ('fontSize' in a) {
        const nf = Math.max(6, Math.min(120, (a.fontSize || 14) + delta * 2));
        const next = { ...a, fontSize: nf, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, a, next));
      }
    });
    store.setActivePageIndex(selected[0].pageIndex);
    this.renderContent();
  }
}
