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

    this._container.innerHTML = `
      <div class="panel-header">
        <span>${t('properties.title')} (${selectedAnnotations.length})</span>
        <button id="close-props-btn" class="header-btn" style="padding:4px;">
          ${getIconSvg('close', 14)}
        </button>
      </div>

      <div class="panel-body">
        <!-- Color Picker -->
        <div class="prop-group">
          <span class="prop-label">${t('properties.color')}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="color" id="prop-color-picker" value="${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}" style="
              width:36px; height:32px; border:none; border-radius:4px; cursor:pointer; background:none;
            ">
            <span style="font-size:12px; font-family:monospace; color:var(--text-secondary);" id="prop-color-val">
              ${(firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5'}
            </span>
          </div>
        </div>

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
