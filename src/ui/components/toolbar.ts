/**
 * Floating & Dockable Toolbar Component with Interactive Hover & Click-to-Pin Configuration Cards
 * Hovering or clicking any tool reveals its floating configuration card.
 * In-place DOM updates ensure clicking swatches, size pills, or sliders never closes the popup!
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand } from '../../core/history';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { ToolType, EraserMode } from '../../core/types';

export class ToolbarComponent {
  private _container: HTMLElement;
  private _lastActiveTool: ToolType | null = null;
  private _lastCanUndo: boolean = false;
  private _lastCanRedo: boolean = false;
  private _lastSelectedCount: number = 0;
  private _pinnedTool: string | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.onStoreUpdate());
    this.render();

    // Clicking anywhere outside the toolbar closes any pinned cards
    document.addEventListener('pointerdown', (e) => {
      if (!this._container.contains(e.target as Node)) {
        this.unpinAll();
      }
    });
  }

  private onStoreUpdate(): void {
    const activeTool = store.activeTool;
    const canUndo = history.canUndo;
    const canRedo = history.canRedo;
    const selectedCount = store.selectedAnnotationIds.size;

    if (
      activeTool !== this._lastActiveTool ||
      canUndo !== this._lastCanUndo ||
      canRedo !== this._lastCanRedo ||
      selectedCount !== this._lastSelectedCount
    ) {
      this.render();
    } else {
      this.updateIndicators();
    }
  }

  private unpinAll(): void {
    if (this._pinnedTool) {
      this._pinnedTool = null;
      this._container.querySelectorAll('.tool-btn-wrapper.is-pinned').forEach(el => {
        el.classList.remove('is-pinned');
      });
    }
  }

  public render(): void {
    const activeTool = store.activeTool;
    const canUndo = history.canUndo;
    const canRedo = history.canRedo;
    const s = store.toolSettings;
    const selectedIds = Array.from(store.selectedAnnotationIds);

    this._lastActiveTool = activeTool;
    this._lastCanUndo = canUndo;
    this._lastCanRedo = canRedo;
    this._lastSelectedCount = selectedIds.length;

    const penColors = ['#000000', '#ffffff', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    const penWidths = [1, 2, 4, 8, 14];

    const hlColors = ['#fef08a', '#86efac', '#f472b6', '#7dd3fc', '#fdba74', '#d8b4fe'];
    const hlWidths = [10, 20, 32, 48];

    const shapeColors = ['#ef4444', '#3b82f6', '#10b981', '#000000', '#ffffff', '#f59e0b', '#8b5cf6'];
    const shapeWidths = [1, 2, 4, 8];

    const textColors = ['#000000', '#ffffff', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    const textSizes = [12, 14, 18, 24, 32, 48];

    this._container.innerHTML = `
      <div class="toolbar-main-row">
        <!-- Selection Tool -->
        <div class="tool-btn-wrapper ${this._pinnedTool === 'select' ? 'is-pinned' : ''}" data-wrapper-tool="select">
          <button class="tool-btn ${activeTool === 'select' ? 'active' : ''}" data-tool="select" title="${t('tools.select')} (V)">
            ${getIconSvg('select')}
          </button>
          ${selectedIds.length > 0 ? `
            <div class="tool-hover-card">
              <span class="sub-row-label">${selectedIds.length} Selected</span>
              <button id="del-selected-btn" class="mode-toggle-btn" style="color:var(--danger);" title="Delete selected">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                Delete
              </button>
            </div>
          ` : ''}
        </div>

        <div class="toolbar-separator"></div>

        <!-- Drawing & Ink Group -->
        <div class="toolbar-group">
          <!-- Pen with Hover Configuration Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'pen' ? 'is-pinned' : ''}" data-wrapper-tool="pen">
            <button class="tool-btn ${activeTool === 'pen' ? 'active' : ''}" data-tool="pen" title="${t('tools.pen')} (P)">
              ${getIconSvg('pen')}
              <span class="tool-color-dot pen-dot" style="background-color:${s.penColor};"></span>
            </button>
            <div class="tool-hover-card">
              <div class="sub-row-section">
                <span class="sub-row-label">Ink</span>
                <div class="color-swatches-group">
                  ${penColors.map(c => `
                    <div class="color-swatch pen-swatch ${s.penColor.toLowerCase() === c.toLowerCase() ? 'active' : ''}" 
                         style="background-color:${c};" data-pen-color="${c}"></div>
                  `).join('')}
                  <div class="color-picker-wrapper" title="Custom color picker">
                    <input type="color" id="hover-pen-color-picker" class="color-picker-input" value="${s.penColor}">
                  </div>
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Size</span>
                <div class="size-pills-group">
                  ${penWidths.map(w => `
                    <button class="size-pill pen-pill ${s.penWidth === w ? 'active' : ''}" data-pen-width="${w}">
                      <span class="size-dot" style="width:${Math.min(14, Math.max(3, w * 1.5))}px; height:${Math.min(14, Math.max(3, w * 1.5))}px;"></span>
                      <span style="margin-left:4px;">${w}px</span>
                    </button>
                  `).join('')}
                </div>
                <div class="size-slider-wrapper">
                  <input type="range" id="hover-pen-slider" class="size-slider" min="1" max="30" value="${s.penWidth}">
                  <span class="size-readout pen-readout">${s.penWidth}px</span>
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Curve</span>
                <button class="mode-toggle-btn curve-btn ${s.pressureCurve === 'linear' ? 'active' : ''}" data-curve="linear">Linear</button>
                <button class="mode-toggle-btn curve-btn ${s.pressureCurve === 'soft' ? 'active' : ''}" data-curve="soft">Soft</button>
                <button class="mode-toggle-btn curve-btn ${s.pressureCurve === 'firm' ? 'active' : ''}" data-curve="firm">Firm</button>
              </div>
            </div>
          </div>

          <!-- Highlighter with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'highlighter' ? 'is-pinned' : ''}" data-wrapper-tool="highlighter">
            <button class="tool-btn ${activeTool === 'highlighter' ? 'active' : ''}" data-tool="highlighter" title="${t('tools.highlighter')} (H)">
              ${getIconSvg('highlighter')}
              <span class="tool-color-dot hl-dot" style="background-color:${s.highlighterColor}; opacity:0.9;"></span>
            </button>
            <div class="tool-hover-card">
              <div class="sub-row-section">
                <span class="sub-row-label">Tint</span>
                <div class="color-swatches-group">
                  ${hlColors.map(c => `
                    <div class="color-swatch hl-swatch ${s.highlighterColor.toLowerCase() === c.toLowerCase() ? 'active' : ''}" 
                         style="background-color:${c}; opacity:0.85;" data-hl-color="${c}"></div>
                  `).join('')}
                  <div class="color-picker-wrapper" title="Custom highlighter color">
                    <input type="color" id="hover-hl-color-picker" class="color-picker-input" value="${s.highlighterColor}">
                  </div>
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Width</span>
                <div class="size-pills-group">
                  ${hlWidths.map(w => `
                    <button class="size-pill hl-pill ${s.highlighterWidth === w ? 'active' : ''}" data-hl-width="${w}">${w}px</button>
                  `).join('')}
                </div>
                <div class="size-slider-wrapper">
                  <input type="range" id="hover-hl-slider" class="size-slider" min="6" max="60" value="${s.highlighterWidth}">
                  <span class="size-readout hl-readout">${s.highlighterWidth}px</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Eraser with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'eraser' ? 'is-pinned' : ''}" data-wrapper-tool="eraser">
            <button class="tool-btn ${activeTool === 'eraser' ? 'active' : ''}" data-tool="eraser" title="${t('tools.eraser')} (E)">
              ${getIconSvg('eraser')}
            </button>
            <div class="tool-hover-card">
              <div class="sub-row-section">
                <span class="sub-row-label">Mode</span>
                <button class="mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'stroke' ? 'active' : ''}" data-eraser-mode="stroke">Stroke</button>
                <button class="mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'object' ? 'active' : ''}" data-eraser-mode="object">Object</button>
                <button class="mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'pixel' ? 'active' : ''}" data-eraser-mode="pixel">Pixel</button>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Size</span>
                <button class="size-pill eraser-pill ${s.eraserWidth === 10 ? 'active' : ''}" data-eraser-width="10">Small</button>
                <button class="size-pill eraser-pill ${s.eraserWidth === 24 ? 'active' : ''}" data-eraser-width="24">Medium</button>
                <button class="size-pill eraser-pill ${s.eraserWidth === 48 ? 'active' : ''}" data-eraser-width="48">Large</button>
                <div class="size-slider-wrapper">
                  <input type="range" id="hover-eraser-slider" class="size-slider" min="6" max="80" value="${s.eraserWidth}">
                  <span class="size-readout eraser-readout">${s.eraserWidth}px</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="toolbar-separator"></div>

        <!-- Shapes Group -->
        <div class="toolbar-group">
          <!-- Rectangle with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'rectangle' ? 'is-pinned' : ''}" data-wrapper-tool="rectangle">
            <button class="tool-btn ${activeTool === 'rectangle' ? 'active' : ''}" data-tool="rectangle" title="${t('tools.rectangle')} (R)">
              ${getIconSvg('rectangle')}
              <span class="tool-color-dot shape-dot" style="background-color:${s.shapeColor};"></span>
            </button>
            <div class="tool-hover-card">
              ${this.renderShapeHoverCard(s, 'rectangle')}
            </div>
          </div>

          <!-- Ellipse with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'ellipse' ? 'is-pinned' : ''}" data-wrapper-tool="ellipse">
            <button class="tool-btn ${activeTool === 'ellipse' ? 'active' : ''}" data-tool="ellipse" title="${t('tools.ellipse')} (O)">
              ${getIconSvg('ellipse')}
            </button>
            <div class="tool-hover-card">
              ${this.renderShapeHoverCard(s, 'ellipse')}
            </div>
          </div>

          <!-- Line with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'line' ? 'is-pinned' : ''}" data-wrapper-tool="line">
            <button class="tool-btn ${activeTool === 'line' ? 'active' : ''}" data-tool="line" title="${t('tools.line')} (L)">
              ${getIconSvg('line')}
            </button>
            <div class="tool-hover-card">
              ${this.renderShapeHoverCard(s, 'line')}
            </div>
          </div>

          <!-- Arrow with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'arrow' ? 'is-pinned' : ''}" data-wrapper-tool="arrow">
            <button class="tool-btn ${activeTool === 'arrow' ? 'active' : ''}" data-tool="arrow" title="${t('tools.arrow')} (A)">
              ${getIconSvg('arrow')}
            </button>
            <div class="tool-hover-card">
              ${this.renderShapeHoverCard(s, 'arrow')}
            </div>
          </div>
        </div>

        <div class="toolbar-separator"></div>

        <!-- Annotation & Media Group -->
        <div class="toolbar-group">
          <!-- Text Tool with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'text' ? 'is-pinned' : ''}" data-wrapper-tool="text">
            <button class="tool-btn ${activeTool === 'text' ? 'active' : ''}" data-tool="text" title="${t('tools.text')} (T)">
              ${getIconSvg('text')}
            </button>
            <div class="tool-hover-card">
              <div class="sub-row-section">
                <span class="sub-row-label">Color</span>
                <div class="color-swatches-group">
                  ${textColors.map(c => `
                    <div class="color-swatch text-swatch ${s.textColor.toLowerCase() === c.toLowerCase() ? 'active' : ''}" 
                         style="background-color:${c};" data-text-color="${c}"></div>
                  `).join('')}
                  <div class="color-picker-wrapper" title="Custom text color">
                    <input type="color" id="hover-text-color-picker" class="color-picker-input" value="${s.textColor}">
                  </div>
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Size</span>
                <div class="size-pills-group">
                  ${textSizes.map(sz => `
                    <button class="size-pill text-pill ${s.fontSize === sz ? 'active' : ''}" data-font-size="${sz}">${sz}</button>
                  `).join('')}
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Font</span>
                <button class="mode-toggle-btn font-fam-btn ${s.fontFamily === 'Inter, sans-serif' ? 'active' : ''}" data-font-fam="Inter, sans-serif">Inter</button>
                <button class="mode-toggle-btn font-fam-btn ${s.fontFamily === 'Vazirmatn, sans-serif' ? 'active' : ''}" data-font-fam="Vazirmatn, sans-serif">وزیرمتن</button>
              </div>
            </div>
          </div>

          <!-- Stamp with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'stamp' ? 'is-pinned' : ''}" data-wrapper-tool="stamp">
            <button class="tool-btn ${activeTool === 'stamp' ? 'active' : ''}" data-tool="stamp" title="${t('tools.stamp')} (M)">
              ${getIconSvg('stamp')}
            </button>
            <div class="tool-hover-card">
              <span class="sub-row-label">Preset Stamp</span>
              <div class="size-pills-group">
                ${['APPROVED', 'CONFIDENTIAL', 'DRAFT', 'SIGN HERE', 'PAID', 'VOID'].map(st => `
                  <button class="mode-toggle-btn" data-stamp-choice="${st}">${st}</button>
                `).join('')}
              </div>
            </div>
          </div>

          <!-- Measure with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'measure-distance' ? 'is-pinned' : ''}" data-wrapper-tool="measure-distance">
            <button class="tool-btn ${activeTool === 'measure-distance' ? 'active' : ''}" data-tool="measure-distance" title="${t('tools.measure')}">
              ${getIconSvg('measure')}
            </button>
            <div class="tool-hover-card">
              <span class="sub-row-label">Unit</span>
              <div class="size-pills-group">
                ${['mm', 'cm', 'm', 'in', 'ft', 'pt', 'px'].map(u => `
                  <button class="size-pill measure-pill ${s.measureUnit === u ? 'active' : ''}" data-measure-unit="${u}">${u}</button>
                `).join('')}
              </div>
            </div>
          </div>

          <!-- Callout -->
          <button class="tool-btn ${activeTool === 'callout' ? 'active' : ''}" data-tool="callout" title="${t('tools.callout')} (C)">
            ${getIconSvg('callout')}
          </button>

          <!-- Signature Pad Trigger -->
          <button class="tool-btn ${activeTool === 'signature' ? 'active' : ''}" id="toolbar-signature-btn" data-tool="signature" title="${t('tools.signature')} (K)">
            ${getIconSvg('signature')}
          </button>

          <!-- Redaction with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'redaction' ? 'is-pinned' : ''}" data-wrapper-tool="redaction">
            <button class="tool-btn ${activeTool === 'redaction' ? 'active' : ''}" data-tool="redaction" title="${t('tools.redaction')} (X)">
              ${getIconSvg('redaction')}
            </button>
            <div class="tool-hover-card">
              <span class="sub-row-label">Mode</span>
              <button class="mode-toggle-btn active" data-redact-color="#000000">Blackout</button>
              <button class="mode-toggle-btn" data-redact-color="#ffffff">Whiteout</button>
            </div>
          </div>

          <!-- Laser Pointer -->
          <button class="tool-btn ${activeTool === 'laser' ? 'active' : ''}" data-tool="laser" title="${t('tools.laser')} (Z)">
            ${getIconSvg('laser')}
          </button>
        </div>

        <div class="toolbar-separator"></div>

        <!-- Undo / Redo -->
        <div class="toolbar-group">
          <button id="toolbar-undo-btn" class="tool-btn" ${!canUndo ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="${t('undo')} (Ctrl+Z)">
            ${getIconSvg('undo')}
          </button>
          <button id="toolbar-redo-btn" class="tool-btn" ${!canRedo ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="${t('redo')} (Ctrl+Y)">
            ${getIconSvg('redo')}
          </button>
        </div>
      </div>
    `;

    this.bindEvents(s);
  }

  private updateIndicators(): void {
    const s = store.toolSettings;

    // Update pen dots and indicators
    const penDot = this._container.querySelector<HTMLElement>('.pen-dot');
    if (penDot) penDot.style.backgroundColor = s.penColor;

    const hlDot = this._container.querySelector<HTMLElement>('.hl-dot');
    if (hlDot) hlDot.style.backgroundColor = s.highlighterColor;

    const shapeDot = this._container.querySelector<HTMLElement>('.shape-dot');
    if (shapeDot) shapeDot.style.backgroundColor = s.shapeColor;

    // Pen swatches & pills
    this._container.querySelectorAll('[data-pen-color]').forEach(el => {
      const c = el.getAttribute('data-pen-color');
      if (c && c.toLowerCase() === s.penColor.toLowerCase()) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    this._container.querySelectorAll('[data-pen-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-pen-width') || '0', 10);
      if (w === s.penWidth) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    const penReadout = this._container.querySelector('.pen-readout');
    if (penReadout) penReadout.textContent = `${s.penWidth}px`;

    const penSlider = this._container.querySelector<HTMLInputElement>('#hover-pen-slider');
    if (penSlider && penSlider.value !== String(s.penWidth)) {
      penSlider.value = String(s.penWidth);
    }

    // Highlighter swatches & pills
    this._container.querySelectorAll('[data-hl-color]').forEach(el => {
      const c = el.getAttribute('data-hl-color');
      if (c && c.toLowerCase() === s.highlighterColor.toLowerCase()) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    this._container.querySelectorAll('[data-hl-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-hl-width') || '0', 10);
      if (w === s.highlighterWidth) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    const hlReadout = this._container.querySelector('.hl-readout');
    if (hlReadout) hlReadout.textContent = `${s.highlighterWidth}px`;

    // Eraser
    this._container.querySelectorAll('[data-eraser-mode]').forEach(el => {
      const m = el.getAttribute('data-eraser-mode');
      if (m === s.eraserMode) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    this._container.querySelectorAll('[data-eraser-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-eraser-width') || '0', 10);
      if (w === s.eraserWidth) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    const eraserReadout = this._container.querySelector('.eraser-readout');
    if (eraserReadout) eraserReadout.textContent = `${s.eraserWidth}px`;

    // Undo / Redo buttons reactive state
    const undoBtn = this._container.querySelector<HTMLButtonElement>('#toolbar-undo-btn');
    if (undoBtn) {
      undoBtn.disabled = !history.canUndo;
      undoBtn.style.opacity = history.canUndo ? '1' : '0.4';
      undoBtn.style.cursor = history.canUndo ? 'pointer' : 'not-allowed';
    }

    const redoBtn = this._container.querySelector<HTMLButtonElement>('#toolbar-redo-btn');
    if (redoBtn) {
      redoBtn.disabled = !history.canRedo;
      redoBtn.style.opacity = history.canRedo ? '1' : '0.4';
      redoBtn.style.cursor = history.canRedo ? 'pointer' : 'not-allowed';
    }
  }

  private renderShapeHoverCard(s: typeof store.toolSettings, shapeType: string): string {
    const shapeColors = ['#ef4444', '#3b82f6', '#10b981', '#000000', '#ffffff', '#f59e0b', '#8b5cf6'];
    const strokeWidths = [1, 2, 4, 8];

    return `
      <div class="sub-row-section">
        <span class="sub-row-label">Stroke</span>
        <div class="color-swatches-group">
          ${shapeColors.map(c => `
            <div class="color-swatch shape-swatch ${s.shapeColor.toLowerCase() === c.toLowerCase() ? 'active' : ''}" 
                 style="background-color:${c};" data-shape-color="${c}"></div>
          `).join('')}
          <div class="color-picker-wrapper" title="Custom stroke color">
            <input type="color" class="color-picker-input shape-color-picker" value="${s.shapeColor}">
          </div>
        </div>
      </div>

      <div class="sub-row-separator"></div>

      <div class="sub-row-section">
        <span class="sub-row-label">Width</span>
        <div class="size-pills-group">
          ${strokeWidths.map(w => `
            <button class="size-pill shape-pill ${s.shapeWidth === w ? 'active' : ''}" data-shape-width="${w}">${w}px</button>
          `).join('')}
        </div>
      </div>

      <div class="sub-row-separator"></div>

      <div class="sub-row-section">
        <span class="sub-row-label">Style</span>
        <button class="mode-toggle-btn ${s.shapeStyle === 'solid' ? 'active' : ''}" data-shape-style="solid">Solid</button>
        <button class="mode-toggle-btn ${s.shapeStyle === 'dashed' ? 'active' : ''}" data-shape-style="dashed">Dashed</button>
        <button class="mode-toggle-btn ${s.shapeStyle === 'dotted' ? 'active' : ''}" data-shape-style="dotted">Dotted</button>
      </div>

      ${shapeType === 'rectangle' || shapeType === 'ellipse' ? `
        <div class="sub-row-separator"></div>
        <div class="sub-row-section">
          <span class="sub-row-label">Fill</span>
          <button class="mode-toggle-btn ${s.shapeFillColor === 'transparent' ? 'active' : ''}" data-shape-fill="transparent">No Fill</button>
          <div class="color-picker-wrapper" title="Fill Color">
            <input type="color" class="color-picker-input shape-fill-picker" value="${s.shapeFillColor === 'transparent' ? '#ffffff' : s.shapeFillColor}">
          </div>
        </div>
      ` : ''}
    `;
  }

  private bindEvents(s: typeof store.toolSettings) {
    // Tool buttons click & toggle pin
    this._container.querySelectorAll<HTMLElement>('.tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tool = btn.getAttribute('data-tool') as ToolType;
        if (!tool) return;

        store.setActiveTool(tool);

        if (tool === 'signature') {
          store.setSignatureModalOpen(true);
          return;
        }

        // Toggle pinned state on click so the popover stays open while selecting settings
        const wrapper = btn.closest('.tool-btn-wrapper');
        if (wrapper) {
          const isCurrentlyPinned = wrapper.classList.contains('is-pinned');
          this.unpinAll();
          if (!isCurrentlyPinned) {
            wrapper.classList.add('is-pinned');
            this._pinnedTool = tool;
          }
        }
      });
    });

    // Undo / Redo
    this._container.querySelector('#toolbar-undo-btn')?.addEventListener('click', () => {
      history.undo();
      store.setActivePageIndex(store.activePageIndex);
    });

    this._container.querySelector('#toolbar-redo-btn')?.addEventListener('click', () => {
      history.redo();
      store.setActivePageIndex(store.activePageIndex);
    });

    // Pen listeners
    this._container.querySelectorAll('[data-pen-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-pen-color');
        if (color) store.updateToolSettings({ penColor: color });
      });
    });

    const penPicker = this._container.querySelector<HTMLInputElement>('#hover-pen-color-picker');
    penPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ penColor: color });
    });

    this._container.querySelectorAll('[data-pen-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-pen-width') || '2', 10);
        store.updateToolSettings({ penWidth: w });
      });
    });

    const penSlider = this._container.querySelector<HTMLInputElement>('#hover-pen-slider');
    penSlider?.addEventListener('input', (e) => {
      const w = parseInt((e.target as HTMLInputElement).value, 10);
      store.updateToolSettings({ penWidth: w });
    });

    this._container.querySelectorAll('[data-curve]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const curve = el.getAttribute('data-curve') as any;
        if (curve) store.updateToolSettings({ pressureCurve: curve });
      });
    });

    // Highlighter listeners
    this._container.querySelectorAll('[data-hl-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-hl-color');
        if (color) store.updateToolSettings({ highlighterColor: color });
      });
    });

    const hlPicker = this._container.querySelector<HTMLInputElement>('#hover-hl-color-picker');
    hlPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ highlighterColor: color });
    });

    this._container.querySelectorAll('[data-hl-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-hl-width') || '20', 10);
        store.updateToolSettings({ highlighterWidth: w });
      });
    });

    const hlSlider = this._container.querySelector<HTMLInputElement>('#hover-hl-slider');
    hlSlider?.addEventListener('input', (e) => {
      const w = parseInt((e.target as HTMLInputElement).value, 10);
      store.updateToolSettings({ highlighterWidth: w });
    });

    // Eraser listeners
    this._container.querySelectorAll('[data-eraser-mode]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = el.getAttribute('data-eraser-mode') as EraserMode;
        if (mode) store.updateToolSettings({ eraserMode: mode });
      });
    });

    this._container.querySelectorAll('[data-eraser-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-eraser-width') || '24', 10);
        store.updateToolSettings({ eraserWidth: w });
      });
    });

    const eraserSlider = this._container.querySelector<HTMLInputElement>('#hover-eraser-slider');
    eraserSlider?.addEventListener('input', (e) => {
      const w = parseInt((e.target as HTMLInputElement).value, 10);
      store.updateToolSettings({ eraserWidth: w });
    });

    // Shapes listeners
    this._container.querySelectorAll('[data-shape-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-shape-color');
        if (color) store.updateToolSettings({ shapeColor: color });
      });
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-color-picker').forEach(picker => {
      picker.addEventListener('input', (e) => {
        const color = (e.target as HTMLInputElement).value;
        store.updateToolSettings({ shapeColor: color });
      });
    });

    this._container.querySelectorAll('[data-shape-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-shape-width') || '2', 10);
        store.updateToolSettings({ shapeWidth: w });
      });
    });

    this._container.querySelectorAll('[data-shape-style]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const st = el.getAttribute('data-shape-style') as any;
        if (st) store.updateToolSettings({ shapeStyle: st });
      });
    });

    this._container.querySelectorAll('[data-shape-fill="transparent"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        store.updateToolSettings({ shapeFillColor: 'transparent' });
      });
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-fill-picker').forEach(picker => {
      picker.addEventListener('input', (e) => {
        const color = (e.target as HTMLInputElement).value;
        store.updateToolSettings({ shapeFillColor: color });
      });
    });

    // Text listeners
    this._container.querySelectorAll('[data-text-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-text-color');
        if (color) store.updateToolSettings({ textColor: color });
      });
    });

    const textPicker = this._container.querySelector<HTMLInputElement>('#hover-text-color-picker');
    textPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ textColor: color });
    });

    this._container.querySelectorAll('[data-font-size]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sz = parseInt(el.getAttribute('data-font-size') || '16', 10);
        store.updateToolSettings({ fontSize: sz });
      });
    });

    this._container.querySelectorAll('[data-font-fam]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const fam = el.getAttribute('data-font-fam');
        if (fam) store.updateToolSettings({ fontFamily: fam });
      });
    });

    // Stamp listeners
    this._container.querySelectorAll('[data-stamp-choice]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const st = el.getAttribute('data-stamp-choice');
        if (st) store.setActiveTool('stamp');
      });
    });

    // Measure listeners
    this._container.querySelectorAll('[data-measure-unit]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const u = el.getAttribute('data-measure-unit') as any;
        if (u) store.updateToolSettings({ measureUnit: u });
      });
    });

    // Delete selected
    this._container.querySelector('#del-selected-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const doc = store.activeDocument;
      const selectedIds = Array.from(store.selectedAnnotationIds);
      if (!doc || selectedIds.length === 0) return;
      for (const pageIdx in doc.annotations) {
        const anns = doc.annotations[pageIdx].filter(a => selectedIds.includes(a.id));
        if (anns.length > 0) {
          history.execute(new DeleteAnnotationsCommand(parseInt(pageIdx, 10), anns));
        }
      }
      store.clearSelection();
    });
  }
}
