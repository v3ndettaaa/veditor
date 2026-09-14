/**
 * Annotation Properties Inspector Panel
 * Allows adjusting colors, stroke widths, opacities, and alignment of selected annotations.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand } from '../../core/history';
import { selectionManager } from '../../annotations/selection';
import { normalizeHighlighterColor } from '../../annotations/spline';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { Annotation } from '../../core/types';

/** Validates free-typed hex colors (`#rrggbb`, `#rgb`, with/without `#`). */
function parseHexInput(raw: string): string | null {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h) return null;
  if (h[0] !== '#') h = '#' + h;
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = '#' + h.slice(1).split('').map(c => c + c).join('');
  }
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

export class PropertiesPanelComponent {
  private _container: HTMLElement;
  private _lastSelectedKey: string | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const isOpen = store.propertiesPanelOpen;
    const selectedIds = Array.from(store.selectedAnnotationIds);

    if (!isOpen || selectedIds.length === 0) {
      this._container.classList.add('collapsed');
      return;
    }

    this._container.classList.remove('collapsed');

    const doc = store.activeDocument;
    if (!doc) return;

    // Find selected annotations
    const selectedAnnotations: Annotation[] = [];
    for (const [, list] of Object.entries(doc.annotations)) {
      for (const ann of list) {
        if (store.selectedAnnotationIds.has(ann.id)) {
          selectedAnnotations.push(ann);
        }
      }
    }

    if (selectedAnnotations.length === 0) {
      this._container.classList.add('collapsed');
      this._lastSelectedKey = null;
      return;
    }

    // Never rebuild while the user is typing in a panel field: slider drags
    // and keystrokes fire store notifies that would otherwise destroy the
    // focused control mid-edit. Rebuild only when the selection itself changes.
    const selectedKey = selectedIds.slice().sort().join(',');
    const activeEl = document.activeElement as HTMLElement | null;
    const userIsEditing = !!activeEl && this._container.contains(activeEl) &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName);
    if (userIsEditing && selectedKey === this._lastSelectedKey &&
        this._container.querySelector('#prop-width-val, #prop-color-picker')) {
      return;
    }
    this._lastSelectedKey = selectedKey;

    const firstAnn = selectedAnnotations[0];
    const hasShape = selectedAnnotations.some(ann => 'fillColor' in ann || ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'polygon' || ann.type === 'freeform-shape');
    const firstFillColor = (firstAnn as any).fillColor || 'transparent';
    const hasSticky = selectedAnnotations.some(ann => ann.type === 'sticky-note');
    const firstStickyColor = hasSticky ? ((firstAnn as any).paper?.paperColor || '#fef08a') : null;
    const hasOutlineToggle = selectedAnnotations.some(ann =>
      ann.type === 'rectangle' || ann.type === 'ellipse' ||
      ann.type === 'polygon' || ann.type === 'freeform-shape' || ann.type === 'callout'
    );
    const firstOutline = (firstAnn as any).outline !== false;

    this._container.innerHTML = `
      <div class="panel-header">
        <span>${t('properties.title')} <span class="badge">${selectedAnnotations.length}</span></span>
        <button id="close-props-btn" class="icon-btn" title="Clear selection" aria-label="Clear selection">
          ${getIconSvg('close', 14)}
        </button>
      </div>

      <div class="panel-body">
        <!-- Sticky Note Paper Color Picker (if sticky note selected) -->
        ${hasSticky ? `
          <div class="prop-group">
            <span class="prop-label">Note Color</span>
            <div class="prop-color-row">
              <div class="color-picker-wrapper is-lg" title="Note Color">
                <input type="color" id="prop-sticky-picker" class="color-picker-input" value="${firstStickyColor}">
              </div>
              <input type="text" class="prop-color-value prop-hex-input" id="prop-sticky-val"
                     value="${firstStickyColor}"
                     spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Note color hex">
            </div>
          </div>
        ` : ''}

        <!-- Stroke Color Picker -->
        ${!hasSticky ? `
        <div class="prop-group">
          <span class="prop-label">${hasShape ? 'Stroke Color' : t('properties.color')}</span>
          <div class="prop-color-row">
            <div class="color-picker-wrapper is-lg" title="Color">
              <input type="color" id="prop-color-picker" class="color-picker-input" value="${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}">
            </div>
            <input type="text" class="prop-color-value prop-hex-input" id="prop-color-val"
                   value="${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}"
                   spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Stroke color hex">
          </div>
        </div>
        ` : ''}

        <!-- Fill Color (if shape selected) -->
        ${hasShape ? `
          <div class="prop-group">
            <span class="prop-label">Fill Color</span>
            <div class="prop-color-row">
              <button id="prop-no-fill-btn" class="secondary-btn is-compact ${firstFillColor === 'transparent' ? 'is-selected' : ''}">
                No fill
              </button>
              <div class="color-picker-wrapper is-lg" title="Fill Color">
                <input type="color" id="prop-fill-picker" class="color-picker-input" value="${firstFillColor === 'transparent' ? '#ffffff' : firstFillColor}">
              </div>
              <input type="text" class="prop-color-value prop-hex-input" id="prop-fill-val"
                     value="${firstFillColor === 'transparent' ? '' : firstFillColor}"
                     placeholder="None" spellcheck="false" maxlength="7"
                     title="Type any hex fill color, empty = none" aria-label="Fill color hex">
            </div>
          </div>
        ` : ''}

        <!-- Outline Toggle -->
        ${hasOutlineToggle ? `
          <div class="prop-group">
            <span class="prop-label">Outline</span>
            <div class="prop-btn-row">
              <button class="secondary-btn ${firstOutline ? 'is-selected' : ''}" data-prop-outline="on">On</button>
              <button class="secondary-btn ${firstOutline ? '' : 'is-selected'}" data-prop-outline="off">Off</button>
            </div>
          </div>
        ` : ''}

        <!-- Stroke Width -->
        <div class="prop-group">
          <div class="prop-label-row">
            <span class="prop-label">${t('properties.strokeWidth')}</span>
            <input type="number" class="prop-value prop-num-input" id="prop-width-val"
                   min="0.5" max="100" step="0.5" value="${(firstAnn as any).strokeWidth || 3}"
                   title="Type any width (0.5-100px)" aria-label="${t('properties.strokeWidth')}">
          </div>
        </div>

        <!-- Opacity -->
        <div class="prop-group">
          <div class="prop-label-row">
            <span class="prop-label">${t('properties.opacity')}</span>
            <input type="number" class="prop-value prop-num-input" id="prop-opacity-val"
                   min="1" max="100" step="1" value="${Math.round((firstAnn.opacity || 1) * 100)}"
                   title="Type any opacity (1-100%)" aria-label="${t('properties.opacity')}">
          </div>
        </div>

        <!-- Alignment (if multi-select) -->
        ${selectedAnnotations.length > 1 ? `
          <div class="prop-group">
            <span class="prop-label">Alignment</span>
            <div class="prop-btn-row">
              <button class="secondary-btn" data-align="left">Left</button>
              <button class="secondary-btn" data-align="center">Center</button>
              <button class="secondary-btn" data-align="right">Right</button>
            </div>
          </div>
        ` : ''}

        <!-- Actions -->
        <div class="prop-group prop-actions">
          <button id="prop-delete-btn" class="danger-btn" style="width:100%;">
            ${getIconSvg('trash', 14)} ${t('properties.delete')}
          </button>
        </div>
      </div>
    `;

    this._container.querySelector('#close-props-btn')?.addEventListener('click', () => {
      store.clearSelection();
    });

    const syncHexInput = (selector: string, val: string) => {
      const el = this._container.querySelector<HTMLInputElement>(selector);
      if (el && document.activeElement !== el && el.value !== val) el.value = val;
    };

    const applyStrokeColor = (val: string) => {
      selectedAnnotations.forEach(ann => {
        const prev = { ...ann };
        const next = { ...ann };
        if ('color' in next) (next as any).color = val;
        if ('strokeColor' in next) (next as any).strokeColor = val;
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    // Color picker change
    const colorPicker = this._container.querySelector('#prop-color-picker') as HTMLInputElement;
    colorPicker?.addEventListener('input', () => {
      const val = colorPicker.value;
      syncHexInput('#prop-color-val', val);
      applyStrokeColor(val);
    });

    // Typed hex stroke color (Enter/blur commits, Escape reverts)
    const colorHex = this._container.querySelector<HTMLInputElement>('#prop-color-val');
    const commitColorHex = () => {
      if (!colorHex) return;
      const parsed = parseHexInput(colorHex.value);
      const current = String((firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5');
      if (parsed) {
        if (parsed !== current.toLowerCase()) applyStrokeColor(parsed);
        colorHex.value = parsed;
      } else {
        colorHex.value = current;
      }
    };
    colorHex?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitColorHex(); colorHex.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); colorHex.value = String((firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'); colorHex.blur(); }
    });
    colorHex?.addEventListener('focus', () => colorHex.select());
    colorHex?.addEventListener('blur', () => commitColorHex());

    // Fill picker & No-Fill button
    const fillPicker = this._container.querySelector('#prop-fill-picker') as HTMLInputElement;
    const onFillChange = (val: string) => {
      syncHexInput('#prop-fill-val', val === 'transparent' ? '' : val);
      const noFillBtn = this._container.querySelector('#prop-no-fill-btn');
      noFillBtn?.classList.toggle('is-selected', val === 'transparent');

      selectedAnnotations.forEach(ann => {
        if ('fillColor' in ann) {
          const prev = { ...ann };
          const next = { ...ann, fillColor: val };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    // Typed hex fill color (empty = none)
    const fillHex = this._container.querySelector<HTMLInputElement>('#prop-fill-val');
    const commitFillHex = () => {
      if (!fillHex) return;
      const raw = fillHex.value.trim();
      if (raw === '') {
        onFillChange('transparent');
        fillHex.value = '';
        return;
      }
      const parsed = parseHexInput(raw);
      if (parsed) {
        onFillChange(parsed);
        fillHex.value = parsed;
      } else {
        fillHex.value = firstFillColor === 'transparent' ? '' : firstFillColor;
      }
    };
    fillHex?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitFillHex(); fillHex.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); fillHex.value = firstFillColor === 'transparent' ? '' : firstFillColor; fillHex.blur(); }
    });
    fillHex?.addEventListener('focus', () => fillHex.select());
    fillHex?.addEventListener('blur', () => commitFillHex());

    fillPicker?.addEventListener('input', () => onFillChange(fillPicker.value));
    fillPicker?.addEventListener('change', () => onFillChange(fillPicker.value));

    this._container.querySelector('#prop-no-fill-btn')?.addEventListener('click', () => {
      onFillChange('transparent');
    });

    const applyStrokeWidth = (val: number) => {
      selectedAnnotations.forEach(ann => {
        if ('strokeWidth' in ann) {
          const prev = { ...ann };
          const next = { ...ann, strokeWidth: val };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    const applyOpacity = (val: number) => {
      selectedAnnotations.forEach(ann => {
        const prev = { ...ann };
        const next = { ...ann, opacity: val };
        if (ann.type === 'highlighter') {
          (next as any).color = normalizeHighlighterColor((ann as any).color, val);
        }
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    const applyStickyColor = (val: string) => {
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'sticky-note') {
          const prev = ann as any;
          const next = {
            ...prev,
            paper: { ...(prev.paper || {}), paperColor: val },
            updatedAt: Date.now()
          };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    // Sticky note color picker change
    const stickyPicker = this._container.querySelector<HTMLInputElement>('#prop-sticky-picker');
    stickyPicker?.addEventListener('input', () => {
      const val = stickyPicker.value;
      syncHexInput('#prop-sticky-val', val);
      applyStickyColor(val);
    });

    // Typed hex sticky note color
    const stickyHex = this._container.querySelector<HTMLInputElement>('#prop-sticky-val');
    const commitStickyHex = () => {
      if (!stickyHex) return;
      const parsed = parseHexInput(stickyHex.value);
      const current = String(firstStickyColor || '#fef08a');
      if (parsed) {
        if (parsed !== current.toLowerCase()) applyStickyColor(parsed);
        stickyHex.value = parsed;
      } else {
        stickyHex.value = current;
      }
    };
    stickyHex?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitStickyHex(); stickyHex.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); stickyHex.value = String(firstStickyColor || '#fef08a'); stickyHex.blur(); }
    });
    stickyHex?.addEventListener('focus', () => stickyHex.select());
    stickyHex?.addEventListener('blur', () => commitStickyHex());

    // Typed width (Enter/blur commits)
    const widthNum = this._container.querySelector<HTMLInputElement>('#prop-width-val');
    const commitWidthNum = () => {
      if (!widthNum) return;
      const fallback = Number((firstAnn as any).strokeWidth) || 3;
      const n = parseFloat(widthNum.value);
      const val = Number.isFinite(n) ? Math.min(100, Math.max(0.5, n)) : fallback;
      widthNum.value = String(val);
      applyStrokeWidth(val);
    };
    widthNum?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitWidthNum(); widthNum.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); widthNum.value = String((firstAnn as any).strokeWidth || 3); widthNum.blur(); }
    });
    widthNum?.addEventListener('focus', () => widthNum.select());
    widthNum?.addEventListener('change', () => commitWidthNum());
    widthNum?.addEventListener('blur', () => commitWidthNum());

    // Typed opacity (Enter/blur commits)
    const opacityNum = this._container.querySelector<HTMLInputElement>('#prop-opacity-val');
    const commitOpacityNum = () => {
      if (!opacityNum) return;
      const fallback = Math.round((firstAnn.opacity || 1) * 100);
      const n = parseFloat(opacityNum.value);
      const pct = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : fallback;
      opacityNum.value = String(pct);
      applyOpacity(pct / 100);
    };
    opacityNum?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitOpacityNum(); opacityNum.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); opacityNum.value = String(Math.round((firstAnn.opacity || 1) * 100)); opacityNum.blur(); }
    });
    opacityNum?.addEventListener('focus', () => opacityNum.select());
    opacityNum?.addEventListener('change', () => commitOpacityNum());
    opacityNum?.addEventListener('blur', () => commitOpacityNum());

    // Outline toggle
    this._container.querySelectorAll('[data-prop-outline]').forEach(btn => {
      btn.addEventListener('click', () => {
        const on = btn.getAttribute('data-prop-outline') === 'on';
        selectedAnnotations.forEach(ann => {
          if (ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'polygon' ||
              ann.type === 'freeform-shape' || ann.type === 'callout') {
            const prev = { ...ann };
            const next = { ...ann, outline: on };
            history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
          }
        });
        store.setActivePageIndex(store.activePageIndex);
      });
    });

    // Delete button
    this._container.querySelector('#prop-delete-btn')?.addEventListener('click', () => {
      const pageIndex = firstAnn.pageIndex;
      history.execute(new DeleteAnnotationsCommand(pageIndex, selectedAnnotations));
      store.clearSelection();
      store.setActivePageIndex(pageIndex);
    });

    // Align buttons
    this._container.querySelectorAll('[data-align]').forEach(btn => {
      btn.addEventListener('click', () => {
        const alignType = btn.getAttribute('data-align') as any;
        const aligned = selectionManager.alignAnnotations(selectedAnnotations, alignType);
        aligned.forEach(ann => {
          const prev = selectedAnnotations.find(a => a.id === ann.id)!;
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, ann));
        });
        store.setActivePageIndex(store.activePageIndex);
      });
    });
  }
}
