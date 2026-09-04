/**
 * Annotation Properties Inspector Panel
 * Allows adjusting colors, stroke widths, opacities, and alignment of selected annotations.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand } from '../../core/history';
import { selectionManager } from '../../annotations/selection';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { Annotation } from '../../core/types';

export class PropertiesPanelComponent {
  private _container: HTMLElement;

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
      return;
    }

    const firstAnn = selectedAnnotations[0];
    const hasShape = selectedAnnotations.some(ann => 'fillColor' in ann || ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'polygon' || ann.type === 'freeform-shape');
    const firstFillColor = (firstAnn as any).fillColor || 'transparent';

    this._container.innerHTML = `
      <div class="panel-header">
        <span>${t('properties.title')} (${selectedAnnotations.length})</span>
        <button id="close-props-btn" class="header-btn" style="padding:4px;">
          ${getIconSvg('close', 14)}
        </button>
      </div>

      <div class="panel-body">
        <!-- Stroke Color Picker -->
        <div class="prop-group">
          <span class="prop-label">${hasShape ? 'Stroke Color' : t('properties.color')}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="color-picker-wrapper" style="width:26px; height:26px;" title="Color">
              <input type="color" id="prop-color-picker" class="color-picker-input" value="${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}">
            </div>
            <span style="font-size:12px; font-family:monospace; color:var(--text-secondary);" id="prop-color-val">
              ${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}
            </span>
          </div>
        </div>

        <!-- Fill Color (if shape selected) -->
        ${hasShape ? `
          <div class="prop-group">
            <span class="prop-label">Fill Color</span>
            <div style="display:flex; align-items:center; gap:8px;">
              <button id="prop-no-fill-btn" class="header-btn ${firstFillColor === 'transparent' ? 'active' : ''}" style="padding:4px 8px; font-size:11px;">
                No Fill
              </button>
              <div class="color-picker-wrapper" style="width:26px; height:26px;" title="Fill Color">
                <input type="color" id="prop-fill-picker" class="color-picker-input" value="${firstFillColor === 'transparent' ? '#ffffff' : firstFillColor}">
              </div>
              <span style="font-size:12px; font-family:monospace; color:var(--text-secondary);" id="prop-fill-val">
                ${firstFillColor === 'transparent' ? 'None' : firstFillColor}
              </span>
            </div>
          </div>
        ` : ''}

        <!-- Stroke Width -->
        <div class="prop-group">
          <div style="display:flex; justify-content:space-between;">
            <span class="prop-label">${t('properties.strokeWidth')}</span>
            <span style="font-size:12px; font-weight:600;" id="prop-width-val">${(firstAnn as any).strokeWidth || 3}px</span>
          </div>
          <input type="range" id="prop-width-slider" min="1" max="48" value="${(firstAnn as any).strokeWidth || 3}" style="width:100%; cursor:pointer;">
        </div>

        <!-- Opacity -->
        <div class="prop-group">
          <div style="display:flex; justify-content:space-between;">
            <span class="prop-label">${t('properties.opacity')}</span>
            <span style="font-size:12px; font-weight:600;" id="prop-opacity-val">${Math.round((firstAnn.opacity || 1) * 100)}%</span>
          </div>
          <input type="range" id="prop-opacity-slider" min="10" max="100" value="${Math.round((firstAnn.opacity || 1) * 100)}" style="width:100%; cursor:pointer;">
        </div>

        <!-- Alignment (if multi-select) -->
        ${selectedAnnotations.length > 1 ? `
          <div class="prop-group">
            <span class="prop-label">Alignment</span>
            <div style="display:flex; gap:4px;">
              <button class="header-btn" data-align="left" style="flex:1;">Left</button>
              <button class="header-btn" data-align="center" style="flex:1;">Center</button>
              <button class="header-btn" data-align="right" style="flex:1;">Right</button>
            </div>
          </div>
        ` : ''}

        <!-- Actions -->
        <div class="prop-group" style="margin-top:auto; padding-top:12px; border-top:1px solid var(--border-subtle); display:flex; gap:8px;">
          <button id="prop-delete-btn" class="header-btn" style="flex:1; color:#ef4444; border-color:rgba(239, 68, 68, 0.3);">
            ${getIconSvg('trash', 14)} ${t('properties.delete')}
          </button>
        </div>
      </div>
    `;

    this._container.querySelector('#close-props-btn')?.addEventListener('click', () => {
      store.clearSelection();
    });

    // Color picker change
    const colorPicker = this._container.querySelector('#prop-color-picker') as HTMLInputElement;
    colorPicker?.addEventListener('input', () => {
      const val = colorPicker.value;
      const colorValEl = this._container.querySelector('#prop-color-val');
      if (colorValEl) colorValEl.textContent = val;

      selectedAnnotations.forEach(ann => {
        const prev = { ...ann };
        const next = { ...ann };
        if ('color' in next) (next as any).color = val;
        if ('strokeColor' in next) (next as any).strokeColor = val;
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
      });
      store.setActivePageIndex(store.activePageIndex);
    });

    // Fill picker & No-Fill button
    const fillPicker = this._container.querySelector('#prop-fill-picker') as HTMLInputElement;
    const onFillChange = (val: string) => {
      const fillValEl = this._container.querySelector('#prop-fill-val');
      if (fillValEl) fillValEl.textContent = val === 'transparent' ? 'None' : val;
      const noFillBtn = this._container.querySelector('#prop-no-fill-btn');
      noFillBtn?.classList.toggle('active', val === 'transparent');

      selectedAnnotations.forEach(ann => {
        if ('fillColor' in ann) {
          const prev = { ...ann };
          const next = { ...ann, fillColor: val };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    fillPicker?.addEventListener('input', () => onFillChange(fillPicker.value));
    fillPicker?.addEventListener('change', () => onFillChange(fillPicker.value));

    this._container.querySelector('#prop-no-fill-btn')?.addEventListener('click', () => {
      onFillChange('transparent');
    });

    // Width slider change
    const widthSlider = this._container.querySelector('#prop-width-slider') as HTMLInputElement;
    widthSlider?.addEventListener('input', () => {
      const val = parseInt(widthSlider.value, 10);
      const widthValEl = this._container.querySelector('#prop-width-val');
      if (widthValEl) widthValEl.textContent = `${val}px`;

      selectedAnnotations.forEach(ann => {
        if ('strokeWidth' in ann) {
          const prev = { ...ann };
          const next = { ...ann, strokeWidth: val };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    });

    // Opacity slider change
    const opacitySlider = this._container.querySelector('#prop-opacity-slider') as HTMLInputElement;
    opacitySlider?.addEventListener('input', () => {
      const val = parseInt(opacitySlider.value, 10) / 100;
      const opValEl = this._container.querySelector('#prop-opacity-val');
      if (opValEl) opValEl.textContent = `${Math.round(val * 100)}%`;

      selectedAnnotations.forEach(ann => {
        const prev = { ...ann };
        const next = { ...ann, opacity: val };
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
      });
      store.setActivePageIndex(store.activePageIndex);
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
