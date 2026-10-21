/**
 * Annotation Properties Inspector Panel
 * Goodnotes-inspired visual inspector for adjusting colors, stroke widths,
 * opacities, outline toggles, and alignment of selected annotations.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand } from '../../core/history';
import { selectionManager } from '../../annotations/selection';
import { normalizeHighlighterColor } from '../../annotations/spline';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { Annotation } from '../../core/types';
import { textTool } from '../../annotations/tools/text';
import { stickyNoteTool } from '../../annotations/tools/sticky-note';

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

function sliderPercent(val: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
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

    // Never rebuild while the user is actively interacting with a slider or input
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
    const hasShape = selectedAnnotations.some(ann =>
      'fillColor' in ann || ann.type === 'rectangle' || ann.type === 'ellipse' ||
      ann.type === 'polygon' || ann.type === 'freeform-shape'
    );
    const firstFillColor = (firstAnn as any).fillColor || 'transparent';
    const hasOutlineToggle = selectedAnnotations.some(ann =>
      ann.type === 'rectangle' || ann.type === 'ellipse' ||
      ann.type === 'polygon' || ann.type === 'freeform-shape'
    );
    const hasCornerRadius = selectedAnnotations.some(ann =>
      ann.type === 'rectangle' || ann.type === 'polygon' || ann.type === 'freeform-shape'
    );
    const cornerRadiusVal = Math.max(0, Math.min(48, Math.round(Number.isFinite((firstAnn as any).cornerRadius) ? (firstAnn as any).cornerRadius : 0)));
    const firstOutline = (firstAnn as any).outline !== false;
    const strokeCol = (firstAnn as any).color || (firstAnn as any).strokeColor || '#4f46e5';
    const isTextAnn = 'fontSize' in firstAnn;
    const isStickyNote = firstAnn.type === 'sticky-note';
    const widthVal = Number((firstAnn as any).strokeWidth || (firstAnn as any).fontSize || 3);
    const widthMax = isTextAnn ? 120 : 60;
    const opacityPct = Math.round((firstAnn.opacity ?? 1) * 100);

    this._container.innerHTML = `
      <div class="panel-header">
        <span>${t('properties.title')} <span class="badge is-accent">${selectedAnnotations.length}</span></span>
        <button id="close-props-btn" class="icon-btn" title="Clear selection" aria-label="Clear selection">
          ${getIconSvg('close', 14)}
        </button>
      </div>

      <div class="panel-body">
        <!-- Live Preview Stage -->
        <div class="gn-preview-stage" style="height:56px;">
          <svg class="gn-preview-svg" viewBox="0 0 220 56" fill="none" aria-hidden="true">
            <path id="prop-live-preview-path" d="M 24 38 C 76 62, 144 10, 196 32"
                  stroke="${strokeCol}"
                  stroke-opacity="${firstAnn.opacity ?? 1}"
                  stroke-width="${Math.min(22, Math.max(1.8, widthVal * (isTextAnn ? 0.25 : 1)))}"
                  stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <!-- Stroke Color Picker -->
        <div class="prop-group">
          <div class="prop-label-row">
            <span class="prop-label">${hasShape ? 'Stroke Color' : t('properties.color')}</span>
            <input type="text" class="prop-color-value prop-hex-input" id="prop-color-val"
                   value="${strokeCol}"
                   spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Stroke color hex">
          </div>
          <div class="prop-color-row">
            <div class="color-picker-wrapper is-lg" title="Color">
              <input type="color" id="prop-color-picker" class="color-picker-input" value="${strokeCol}">
            </div>
            <div class="color-swatches-group" style="flex-wrap:wrap;">
              ${['#000000', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'].map(c => `
                <button type="button" class="color-swatch ${strokeCol.toLowerCase() === c ? 'active' : ''}"
                        style="background-color:${c};" data-prop-quick-color="${c}" title="${c}"></button>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Fill Color & Fill Opacity (if shape selected) -->
        ${hasShape ? `
          <div class="prop-group">
            <div class="prop-label-row">
              <span class="prop-label">Fill Color</span>
              <input type="text" class="prop-color-value prop-hex-input" id="prop-fill-val"
                     value="${firstFillColor === 'transparent' ? '' : firstFillColor}"
                     placeholder="None" spellcheck="false" maxlength="7"
                     title="Type any hex fill color, empty = none" aria-label="Fill color hex">
            </div>
            <div class="prop-color-row">
              <button id="prop-no-fill-btn" class="color-swatch gn-nofill-swatch ${firstFillColor === 'transparent' ? 'active' : ''}" title="No Fill">
                ${getIconSvg('noFill', 14)}
              </button>
              <div class="color-picker-wrapper is-lg" title="Fill Color">
                <input type="color" id="prop-fill-picker" class="color-picker-input" value="${firstFillColor === 'transparent' ? '#ffffff' : firstFillColor}">
              </div>
              <div class="color-swatches-group" style="flex-wrap:wrap;">
                ${['#ef4444', '#3b82f6', '#10b981', '#fef08a', '#f59e0b'].map(c => `
                  <button type="button" class="color-swatch ${firstFillColor.toLowerCase() === c ? 'active' : ''}"
                          style="background-color:${c};" data-prop-quick-fill="${c}" title="${c}"></button>
                `).join('')}
              </div>
            </div>
            <div class="prop-label-row" style="margin-top: 10px;">
              <span class="prop-label">Fill Opacity</span>
              <div class="gn-num-badge">
                <input type="number" class="prop-value prop-num-input" id="prop-fill-opacity-val"
                       min="0" max="100" step="1" value="${Math.round(((firstAnn as any).fillOpacity ?? 1) * 100)}"
                       title="Fill opacity (0-100%, outline stays solid)" aria-label="Fill opacity percentage">
                <span class="gn-unit">%</span>
              </div>
            </div>
            <div class="gn-slider-wrap">
              <input type="range" id="prop-fill-opacity-slider" class="gn-range-slider"
                     min="0" max="100" step="1" value="${Math.round(((firstAnn as any).fillOpacity ?? 1) * 100)}"
                     style="--slider-pct:${sliderPercent(Math.round(((firstAnn as any).fillOpacity ?? 1) * 100), 0, 100)}%"
                     aria-label="Fill opacity slider">
            </div>
          </div>
        ` : ''}

        <!-- Stroke Width / Font Size Slider + Input -->
        <div class="prop-group">
          <div class="prop-label-row">
            <span class="prop-label">${isTextAnn ? 'Font Size' : t('properties.strokeWidth')}</span>
            <div class="gn-num-badge">
              <input type="number" class="prop-value prop-num-input" id="prop-width-val"
                     min="0.5" max="120" step="0.5" value="${widthVal}"
                     title="Type any size" aria-label="${t('properties.strokeWidth')}">
              <span class="gn-unit">px</span>
            </div>
          </div>
          <div class="gn-slider-wrap">
            <input type="range" id="prop-width-slider" class="gn-range-slider"
                   min="0.5" max="${widthMax}" step="0.5" value="${Math.min(widthMax, widthVal)}"
                   style="--slider-pct:${sliderPercent(Math.min(widthMax, widthVal), 0.5, widthMax)}%"
                   aria-label="Width slider">
          </div>
        </div>

        ${hasCornerRadius ? `
          <div class="prop-group">
            <div class="prop-label-row">
              <span class="prop-label">Corner Radius</span>
              <div class="gn-num-badge">
                <input type="number" class="prop-value prop-num-input" id="prop-corner-radius-val"
                       min="0" max="48" step="1" value="${cornerRadiusVal}"
                       title="Corner radius (0 = sharp, up to 48px)" aria-label="Corner radius">
                <span class="gn-unit">px</span>
              </div>
            </div>
            <div class="gn-slider-wrap">
              <input type="range" id="prop-corner-radius-slider" class="gn-range-slider"
                     min="0" max="48" step="1" value="${cornerRadiusVal}"
                     style="--slider-pct:${sliderPercent(cornerRadiusVal, 0, 48)}%"
                     aria-label="Corner radius slider">
            </div>
          </div>
        ` : ''}

        <!-- Opacity Slider + Input -->
        <div class="prop-group">
          <div class="prop-label-row">
            <span class="prop-label">${t('properties.opacity')}</span>
            <div class="gn-num-badge">
              <input type="number" class="prop-value prop-num-input" id="prop-opacity-val"
                     min="1" max="100" step="1" value="${opacityPct}"
                     title="Type any opacity (1-100%)" aria-label="${t('properties.opacity')}">
              <span class="gn-unit">%</span>
            </div>
          </div>
          <div class="gn-slider-wrap gn-slider-notched">
            <input type="range" id="prop-opacity-slider" class="gn-range-slider"
                   min="5" max="100" step="1" value="${opacityPct}"
                   style="--slider-pct:${sliderPercent(opacityPct, 5, 100)}%"
                   aria-label="Opacity slider">
          </div>
        </div>

        <!-- Outline Switch -->
        ${hasOutlineToggle ? `
          <div class="prop-group">
            <button type="button" class="gn-setting-row" id="prop-outline-switch" aria-pressed="${firstOutline}">
              <span class="gn-setting-label">
                ${getIconSvg('outlineOn', 15)}
                <span>Shape Border (Outline)</span>
              </span>
              <span class="gn-switch ${firstOutline ? 'is-on' : ''}">
                <span class="gn-switch-thumb"></span>
              </span>
            </button>
          </div>
        ` : ''}

        <!-- Alignment (if multi-select) -->
        ${selectedAnnotations.length > 1 ? `
          <div class="prop-group">
            <span class="prop-label">Alignment</span>
            <div class="gn-tile-grid cols-3">
              <button type="button" class="gn-icon-tile is-compact" data-align="left" title="Align Left">
                <span class="gn-tile-icon">${getIconSvg('alignLeft', 18)}</span>
                <span class="gn-tile-label">Left</span>
              </button>
              <button type="button" class="gn-icon-tile is-compact" data-align="center" title="Align Center">
                <span class="gn-tile-icon">${getIconSvg('alignCenter', 18)}</span>
                <span class="gn-tile-label">Center</span>
              </button>
              <button type="button" class="gn-icon-tile is-compact" data-align="right" title="Align Right">
                <span class="gn-tile-icon">${getIconSvg('alignRight', 18)}</span>
                <span class="gn-tile-label">Right</span>
              </button>
            </div>
          </div>
        ` : ''}

        ${isStickyNote ? `
          <div class="prop-group">
            <div class="prop-label-row">
              <span class="prop-label">Text & Ink Color</span>
              <input type="color" id="prop-note-textcolor" class="color-picker-input"
                     style="width:28px; height:28px; border-radius:6px; cursor:pointer;"
                     value="${(firstAnn as any).textColor || '#3b2f1e'}">
            </div>
          </div>
          <div class="prop-group" style="display:flex; gap:8px;">
            <button type="button" id="prop-note-collapse-btn" class="gn-setting-row" style="flex:1; justify-content:center;">
              ${getIconSvg((firstAnn as any).collapsed ? 'expand' : 'compress', 14)}
              <span>${(firstAnn as any).collapsed ? 'Expand Note' : 'Collapse Note'}</span>
            </button>
            ${((firstAnn as any).strokes?.length ?? 0) > 0 ? `
              <button type="button" id="prop-note-clear-ink-btn" class="gn-setting-row" style="flex:1; justify-content:center;">
                ${getIconSvg('eraser', 14)}
                <span>Clear Ink</span>
              </button>
            ` : ''}
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

    this._container.querySelectorAll<HTMLElement>('.gn-num-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = badge.querySelector<HTMLInputElement>('input');
        if (inp && document.activeElement !== inp) {
          inp.focus();
          inp.select();
        }
      });
    });

    const syncHexInput = (selector: string, val: string) => {
      const el = this._container.querySelector<HTMLInputElement>(selector);
      if (el && document.activeElement !== el && el.value !== val) el.value = val;
    };

    const updateLivePreview = (color?: string, width?: number, opacity?: number) => {
      const path = this._container.querySelector<SVGPathElement>('#prop-live-preview-path');
      if (!path) return;
      if (color) path.setAttribute('stroke', color);
      if (width !== undefined) {
        path.setAttribute('stroke-width', String(Math.min(22, Math.max(1.8, width * (isTextAnn ? 0.25 : 1)))));
      }
      if (opacity !== undefined) {
        path.setAttribute('stroke-opacity', String(opacity));
      }
    };

    const applyStrokeColor = (val: string) => {
      updateLivePreview(val);
      selectedAnnotations.forEach(ann => {
        const prev = { ...ann };
        const next = { ...ann };
        if ('color' in next) (next as any).color = val;
        if ('strokeColor' in next) (next as any).strokeColor = val;
        history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    const colorPicker = this._container.querySelector('#prop-color-picker') as HTMLInputElement;
    colorPicker?.addEventListener('input', () => {
      const val = colorPicker.value;
      syncHexInput('#prop-color-val', val);
      applyStrokeColor(val);
    });

    this._container.querySelectorAll('[data-prop-quick-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-prop-quick-color');
        if (val) {
          syncHexInput('#prop-color-val', val);
          if (colorPicker) colorPicker.value = val;
          applyStrokeColor(val);
        }
      });
    });

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

    this._container.querySelectorAll('[data-prop-quick-fill]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-prop-quick-fill');
        if (val) {
          if (fillPicker) fillPicker.value = val;
          onFillChange(val);
        }
      });
    });

    this._container.querySelector('#prop-no-fill-btn')?.addEventListener('click', () => {
      onFillChange('transparent');
    });

    const fillOpNum = this._container.querySelector<HTMLInputElement>('#prop-fill-opacity-val');
    const fillOpSlider = this._container.querySelector<HTMLInputElement>('#prop-fill-opacity-slider');
    const applyFillOpacity = (pctRaw: number) => {
      const pct = Math.max(0, Math.min(100, Math.round(pctRaw)));
      const fillOp = pct / 100;
      if (fillOpSlider && document.activeElement !== fillOpSlider) fillOpSlider.value = String(pct);
      if (fillOpSlider) fillOpSlider.style.setProperty('--slider-pct', `${sliderPercent(pct, 0, 100)}%`);
      if (fillOpNum && document.activeElement !== fillOpNum) fillOpNum.value = String(pct);
      selectedAnnotations.forEach(ann => {
        if ('fillColor' in ann || ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'polygon' || ann.type === 'freeform-shape') {
          const prev = { ...ann } as any;
          const nextFillColor = (!prev.fillColor || prev.fillColor === 'transparent') && pct > 0
            ? (store.toolSettings.shapeFillColor !== 'transparent' ? store.toolSettings.shapeFillColor : (prev.strokeColor || '#6366f1'))
            : prev.fillColor;
          const next = { ...prev, fillColor: pct === 0 ? 'transparent' : nextFillColor, fillOpacity: fillOp };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.updateToolSettings({ shapeFillOpacity: fillOp });
      store.setActivePageIndex(store.activePageIndex);
    };
    fillOpSlider?.addEventListener('input', () => {
      const val = parseFloat(fillOpSlider.value || '100');
      if (Number.isFinite(val)) applyFillOpacity(val);
    });
    fillOpNum?.addEventListener('input', () => {
      const val = parseFloat(fillOpNum.value);
      if (Number.isFinite(val)) applyFillOpacity(val);
    });
    fillOpNum?.addEventListener('change', () => {
      const val = parseFloat(fillOpNum.value);
      if (Number.isFinite(val)) applyFillOpacity(val);
    });

    const applyStrokeWidth = (val: number) => {
      updateLivePreview(undefined, val);
      selectedAnnotations.forEach(ann => {
        if ('strokeWidth' in ann) {
          const prev = { ...ann };
          const next = { ...ann, strokeWidth: val };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        } else if ('fontSize' in ann) {
          const a = ann as any;
          const nf = Math.max(8, Math.min(120, val));
          const measured = textTool.measureTextBox(
            a.text || '',
            nf,
            a.fontFamily || 'Inter',
            a.padding ?? 8,
            a.fontWeight,
            a.fontStyle
          );
          const prev = { ...ann };
          const next = {
            ...ann,
            fontSize: nf,
            box: {
              x: a.box.x,
              y: a.box.y,
              width: measured.width,
              height: measured.height
            }
          };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    };

    const applyOpacity = (val: number) => {
      updateLivePreview(undefined, undefined, val);
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

    // Width slider & input sync
    const widthNum = this._container.querySelector<HTMLInputElement>('#prop-width-val');
    const widthSlider = this._container.querySelector<HTMLInputElement>('#prop-width-slider');
    widthSlider?.addEventListener('input', () => {
      const val = parseFloat(widthSlider.value || '3');
      widthSlider.style.setProperty('--slider-pct', `${sliderPercent(val, 0.5, widthMax)}%`);
      if (widthNum) widthNum.value = String(val);
      applyStrokeWidth(val);
    });

    const commitWidthNum = () => {
      if (!widthNum) return;
      const fallback = Number((firstAnn as any).strokeWidth || (firstAnn as any).fontSize) || 3;
      const n = parseFloat(widthNum.value);
      const val = Number.isFinite(n) ? Math.min(120, Math.max(0.5, n)) : fallback;
      widthNum.value = String(val);
      if (widthSlider) {
        widthSlider.value = String(Math.min(widthMax, val));
        widthSlider.style.setProperty('--slider-pct', `${sliderPercent(Math.min(widthMax, val), 0.5, widthMax)}%`);
      }
      applyStrokeWidth(val);
    };
    widthNum?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitWidthNum(); widthNum.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); widthNum.value = String((firstAnn as any).strokeWidth || (firstAnn as any).fontSize || 3); widthNum.blur(); }
    });
    widthNum?.addEventListener('focus', () => widthNum.select());
    widthNum?.addEventListener('change', () => commitWidthNum());
    widthNum?.addEventListener('blur', () => commitWidthNum());

    // Corner Radius slider & input sync
    const cornerRadNum = this._container.querySelector<HTMLInputElement>('#prop-corner-radius-val');
    const cornerRadSlider = this._container.querySelector<HTMLInputElement>('#prop-corner-radius-slider');
    const applyCornerRadius = (rawVal: number) => {
      const r = Math.max(0, Math.min(48, Math.round(rawVal)));
      if (cornerRadSlider && document.activeElement !== cornerRadSlider) cornerRadSlider.value = String(r);
      if (cornerRadSlider) cornerRadSlider.style.setProperty('--slider-pct', `${sliderPercent(r, 0, 48)}%`);
      if (cornerRadNum && document.activeElement !== cornerRadNum) cornerRadNum.value = String(r);
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'rectangle' || ann.type === 'polygon' || ann.type === 'freeform-shape') {
          const prev = { ...ann };
          const next = { ...ann, cornerRadius: r };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
      });
      store.updateToolSettings({ shapeCornerRadius: r });
      store.setActivePageIndex(store.activePageIndex);
    };
    cornerRadSlider?.addEventListener('input', () => {
      const val = parseFloat(cornerRadSlider.value || '0');
      if (Number.isFinite(val)) applyCornerRadius(val);
    });
    cornerRadNum?.addEventListener('input', () => {
      const val = parseFloat(cornerRadNum.value);
      if (Number.isFinite(val)) applyCornerRadius(val);
    });
    cornerRadNum?.addEventListener('change', () => {
      const val = parseFloat(cornerRadNum.value);
      if (Number.isFinite(val)) applyCornerRadius(val);
    });

    // Opacity slider & input sync
    const opacityNum = this._container.querySelector<HTMLInputElement>('#prop-opacity-val');
    const opacitySlider = this._container.querySelector<HTMLInputElement>('#prop-opacity-slider');
    opacitySlider?.addEventListener('input', () => {
      const pct = Math.round(parseFloat(opacitySlider.value || '100'));
      opacitySlider.style.setProperty('--slider-pct', `${sliderPercent(pct, 5, 100)}%`);
      if (opacityNum) opacityNum.value = String(pct);
      applyOpacity(pct / 100);
    });

    const commitOpacityNum = () => {
      if (!opacityNum) return;
      const fallback = Math.round((firstAnn.opacity || 1) * 100);
      const n = parseFloat(opacityNum.value);
      const pct = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : fallback;
      opacityNum.value = String(pct);
      if (opacitySlider) {
        opacitySlider.value = String(Math.max(5, pct));
        opacitySlider.style.setProperty('--slider-pct', `${sliderPercent(Math.max(5, pct), 5, 100)}%`);
      }
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

    // Outline switch
    const outlineSwitch = this._container.querySelector<HTMLElement>('#prop-outline-switch');
    outlineSwitch?.addEventListener('click', () => {
      const currentlyOn = outlineSwitch.getAttribute('aria-pressed') === 'true';
      const nextOn = !currentlyOn;
      outlineSwitch.setAttribute('aria-pressed', String(nextOn));
      outlineSwitch.querySelector('.gn-switch')?.classList.toggle('is-on', nextOn);
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'rectangle' || ann.type === 'ellipse' || ann.type === 'polygon' ||
            ann.type === 'freeform-shape') {
          const prev = { ...ann };
          const next = { ...ann, outline: nextOn };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, prev, next));
        }
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

    // Sticky Note specific controls
    const noteTextColInput = this._container.querySelector<HTMLInputElement>('#prop-note-textcolor');
    noteTextColInput?.addEventListener('input', () => {
      const val = noteTextColInput.value;
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'sticky-note') {
          const next = { ...ann, textColor: val, updatedAt: Date.now() };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        }
      });
      store.updateToolSettings({ noteTextColor: val });
      store.setActivePageIndex(store.activePageIndex);
    });

    const noteAuthorInput = this._container.querySelector<HTMLInputElement>('#prop-note-author');
    noteAuthorInput?.addEventListener('change', () => {
      const val = noteAuthorInput.value;
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'sticky-note') {
          const next = { ...ann, author: val, updatedAt: Date.now() };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        }
      });
      store.updateToolSettings({ noteAuthor: val });
      store.setActivePageIndex(store.activePageIndex);
    });

    this._container.querySelector('#prop-note-collapse-btn')?.addEventListener('click', () => {
      let anyCollapsed = false;
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'sticky-note') {
          const pageMeta = store.activeDocument?.pages?.[ann.pageIndex];
          const rot = (((store.pageRotations?.[ann.pageIndex] ?? pageMeta?.rotation ?? 0) % 360) + 360) % 360;
          const swapped = rot === 90 || rot === 270;
          const pageW = pageMeta ? (swapped ? pageMeta.height : pageMeta.width) : 0;
          const pageH = pageMeta ? (swapped ? pageMeta.width : pageMeta.height) : 0;
          const next = ann.collapsed
            ? stickyNoteTool.expandStickyNoteForPage(ann, pageW, pageH)
            : stickyNoteTool.collapseStickyNote(ann);
          if (next.collapsed) anyCollapsed = true;
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        }
      });
      if (anyCollapsed) {
        store.setActiveTool('select');
      }
      store.setActivePageIndex(store.activePageIndex);
    });

    this._container.querySelector('#prop-note-clear-ink-btn')?.addEventListener('click', () => {
      selectedAnnotations.forEach(ann => {
        if (ann.type === 'sticky-note' && (ann.strokes?.length ?? 0) > 0) {
          const next = { ...ann, strokes: [], updatedAt: Date.now() };
          history.execute(new ModifyAnnotationCommand(ann.pageIndex, ann, next));
        }
      });
      store.setActivePageIndex(store.activePageIndex);
    });
  }
}
