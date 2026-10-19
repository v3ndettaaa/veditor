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
import { STICKY_NOTE_COLORS } from '../../annotations/tools/sticky-note';
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
    const isSingleText = selected.length === 1 && first.type === 'text';
    const isSingleSticky = selected.length === 1 && first.type === 'sticky-note';
    const isAllSticky = selected.every(a => a.type === 'sticky-note');
    const currentColor = first.color || first.strokeColor || '#4f46e5';
    const currentWidth = Math.round(Number(first.strokeWidth || first.fontSize || 3));
    const currentOpacity = Math.round((first.opacity ?? 1.0) * 100);
    const isLocked = first.locked === true;

    const stickyInk = isSingleSticky ? pointerHandler.getStickyInkMode() : null;
    const isNotePenActive = isSingleSticky && stickyInk?.noteId === first.id && stickyInk?.mode === 'pen';
    const isNoteEraserActive = isSingleSticky && stickyInk?.noteId === first.id && stickyInk?.mode === 'eraser';

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
          <label class="props-color-bubble-wrap" title="${isAllSticky ? 'Note paper color' : 'Pick color'}">
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
            <label class="props-color-bubble-wrap" title="Text & ink color">
              <span class="props-color-bubble" style="background-color: ${first.textColor || '#3b2f1e'}; width: 16px; height: 16px;"></span>
              <input type="color" class="props-native-color-picker" id="fp-note-textcolor-picker" value="${this.ensureHex(first.textColor || '#3b2f1e')}">
            </label>
            ${!first.collapsed ? `
              <button class="props-pill-btn" id="fp-edit-note-btn" title="Edit note text">
                Edit Text
              </button>
              <button class="props-icon-btn ${isNotePenActive ? 'active' : ''}" id="fp-note-pen-btn" title="Draw inside note with pen">
                ${getIconSvg('pen', 14)}
              </button>
              <button class="props-icon-btn ${isNoteEraserActive ? 'active' : ''}" id="fp-note-eraser-btn" title="Erase ink strokes inside note">
                ${getIconSvg('eraser', 14)}
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
        const nextFill = (!current || current === 'transparent') ? (a.color || a.strokeColor || '#6366f1') : 'transparent';
        const next = { ...a, fillColor: nextFill, updatedAt: Date.now() };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
      });
      store.setActivePageIndex(pageIndex);
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
      const inkMode = pointerHandler.getStickyInkMode();
      if (inkMode?.noteId === first.id) {
        pointerHandler.setStickyInkMode(first.id, inkMode.mode, val, inkMode.strokeWidth);
      }
      store.updateToolSettings({ noteTextColor: val });
      window.app?.repaintAllRenderedAnnotations();
    });

    // Sticky Note Edit Text button
    this._container.querySelector('#fp-edit-note-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      pointerHandler.setStickyInkMode(null);
      const pageContainer = document.querySelector<HTMLElement>(`.pdf-page-container[data-page-index="${first.pageIndex}"]`);
      const scratchCanvas = pageContainer?.querySelector<HTMLCanvasElement>('.scratchpad-canvas');
      if (scratchCanvas) {
        this.hideImmediate();
        pointerHandler.editExistingStickyNote(first, first.pageIndex, scratchCanvas, () => {
          window.app?.repaintAllRenderedAnnotations();
        });
      }
    });

    // Sticky Note In-Note Pen toggle
    this._container.querySelector('#fp-note-pen-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      const cur = pointerHandler.getStickyInkMode();
      if (cur?.noteId === first.id && cur.mode === 'pen') {
        pointerHandler.setStickyInkMode(null);
      } else {
        pointerHandler.setStickyInkMode(first.id, 'pen', first.textColor || '#3b2f1e', 2.5);
      }
      this.renderContent();
    });

    // Sticky Note In-Note Eraser toggle
    this._container.querySelector('#fp-note-eraser-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      const cur = pointerHandler.getStickyInkMode();
      if (cur?.noteId === first.id && cur.mode === 'eraser') {
        pointerHandler.setStickyInkMode(null);
      } else {
        pointerHandler.setStickyInkMode(first.id, 'eraser', first.textColor || '#3b2f1e', 2.5);
      }
      this.renderContent();
    });

    // Sticky Note Collapse / Expand toggle
    this._container.querySelector('#fp-note-collapse-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = selected[0];
      if (!first || first.type !== 'sticky-note') return;
      pointerHandler.setStickyInkMode(null);
      const next: StickyNoteAnnotation = {
        ...first,
        collapsed: !first.collapsed,
        updatedAt: Date.now()
      };
      history.execute(new ModifyAnnotationCommand(first.pageIndex, first, next));
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
      pointerHandler.setStickyInkMode(null);
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
