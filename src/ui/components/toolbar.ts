/**
 * Floating & Dockable Toolbar Component with Goodnotes-Inspired Popover Cards
 * Clicking a tool reveals its vertical configuration card with a live visual
 * preview stage, icon-first mode tiles, smooth filled sliders, and toggle switches.
 * In-place DOM updates ensure clicking swatches, sliders, or tiles never closes the popup.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand, ModifyAnnotationCommand } from '../../core/history';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { ToolType, EraserMode, toolbarFamily, ToolbarDock, classifyToolbarDock, ToolOptionKey, SEGMENT_TOOLS } from '../../core/types';

/** Short labels for tools, reused by Settings → Toolbar. */
export const TOOL_SHORT_LABELS: Record<string, string> = {
  select: 'Select',
  hand: 'Hand',
  pen: 'Pen',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  polygon: 'Polygon',
  text: 'Text',
  'sticky-note': 'Note',
  stamp: 'Stamp',
  'measure-distance': 'Measure',
  signature: 'Signature',
  redaction: 'Redaction',
  scratchpad: 'Scratchpad'
};

/** Parses free-typed numeric input, falling back when empty/invalid. */
function clampTypedNumber(raw: string, min: number, max: number, fallback: number): number {
  const n = parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sliderPercent(val: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
}

/**
 * Built-in swatches for `groupKey` (e.g. "pen"), minus any the user removed
 * from that specific picker. Every swatch — default or custom — can be
 * right-clicked off; `data-remove-key` tells the shared handler which list
 * (the group's hidden-defaults, or the shared custom palette) to update.
 */
function renderDefaultSwatches(groupKey: string, dataAttr: string, swatchClass: string, colors: string[], activeColor: string, extraStyle: string = ''): string {
  const removed = new Set(store.appSettings.removedDefaultColors);
  return colors
    .filter(c => !removed.has(`${groupKey}:${c}`))
    .map(c => `
      <button type="button" class="color-swatch ${swatchClass} ${activeColor.toLowerCase() === c.toLowerCase() ? 'active' : ''}"
              style="background-color:${c};${extraStyle}" data-${dataAttr}="${c}" data-remove-key="default:${groupKey}:${c}"
              title="${c} \u2014 right-click to remove" aria-label="${c}"
              aria-pressed="${activeColor.toLowerCase() === c.toLowerCase()}"></button>
    `).join('');
}

/**
 * Extra swatches for the user's own saved colors (`appSettings.customPalette`),
 * shared by every pen/highlighter/shape/text color picker so "my colors"
 * follow the user across tools instead of being siloed or re-typed each time.
 */
function renderCustomPaletteSwatches(dataAttr: string, swatchClass: string, activeColor: string): string {
  return store.appSettings.customPalette.map(c => `
    <button type="button" class="color-swatch ${swatchClass} custom-palette-swatch" style="background-color:${c};"
            data-${dataAttr}="${c}" data-remove-key="custom:${c}"
            title="${c} \u2014 right-click to remove from My Colors" aria-label="${c}"
            aria-pressed="${activeColor.toLowerCase() === c.toLowerCase()}"></button>
  `).join('');
}

/** "+" affordance that opens a native color picker (seeded at the tool's current color) and saves the chosen color into the shared custom palette. */
function renderAddToPaletteButton(seed: string = '#000000'): string {
  const safeSeed = /^#[0-9a-fA-F]{6}$/.test(seed) ? seed : '#000000';
  return `
    <button type="button" class="color-swatch add-to-palette-btn" data-add-palette-trigger title="Pick a color to save to My Colors">+</button>
    <input type="color" class="add-to-palette-input" data-add-palette-input value="${safeSeed}" style="position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;">
  `;
}

/** Validates free-typed hex colors (`#rrggbb`, `#rgb`, with/without `#`). */
function parseHexColor(raw: string): string | null {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h) return null;
  if (h[0] !== '#') h = '#' + h;
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = '#' + h.slice(1).split('').map(c => c + c).join('');
  }
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

function shapeDashArray(style: string, width: number): string {
  const sw = Math.max(1.5, Math.min(10, width));
  if (style === 'dashed') return `${sw * 3.2} ${sw * 2.2}`;
  if (style === 'dotted') return `${sw * 0.4} ${sw * 2.4}`;
  return 'none';
}

export class ToolbarComponent {
  private _container: HTMLElement;
  private _lastActiveTool: ToolType | null = null;
  private _lastCanUndo: boolean = false;
  private _lastCanRedo: boolean = false;
  private _lastSelectedCount: number = 0;
  private _lastHasDoc: boolean = false;
  private _lastLayoutKey: string = '';
  private _lastDock: ToolbarDock | null = null;
  private _pinnedTool: string | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.onStoreUpdate());
    this.render();

    // Clicking anywhere outside the toolbar closes pinned cards
    document.addEventListener('pointerdown', (e) => {
      if (!this._container.contains(e.target as Node)) {
        this.unpinAll();
      }
    });

    window.addEventListener('resize', () => {
      if (this._pinnedTool) {
        const wrapper = this._container.querySelector<HTMLElement>(`.tool-btn-wrapper[data-wrapper-tool="${this._pinnedTool}"]`);
        if (wrapper) this.positionPopover(wrapper);
      }
    });
  }

  private onStoreUpdate(): void {
    const hasDoc = store.activeDocument !== null;
    const activeTool = store.activeTool;
    const canUndo = history.canUndo;
    const canRedo = history.canRedo;
    const selectedCount = store.selectedAnnotationIds.size;
    const layoutKey = JSON.stringify(store.toolbarLayout);
    const dock = store.appSettings.toolbarDock;

    if (
      hasDoc !== this._lastHasDoc ||
      activeTool !== this._lastActiveTool ||
      canUndo !== this._lastCanUndo ||
      canRedo !== this._lastCanRedo ||
      selectedCount !== this._lastSelectedCount ||
      layoutKey !== this._lastLayoutKey ||
      dock !== this._lastDock
    ) {
      this._lastHasDoc = hasDoc;
      this._lastLayoutKey = layoutKey;
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

  /**
   * Anchors the Goodnotes vertical popover card directly to its trigger button
   * while clamping horizontally/vertically so it never clips off the screen.
   */
  private positionPopover(wrapper: HTMLElement): void {
    const card = wrapper.querySelector<HTMLElement>('.tool-hover-card');
    const btn = wrapper.querySelector<HTMLElement>('.tool-btn');
    const row = this._container.querySelector<HTMLElement>('.toolbar-main-row');
    if (!card || !btn || !row) return;

    const dock = store.appSettings.toolbarDock;
    const rowRect = row.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const cardWidth = card.offsetWidth || 316;
    const cardHeight = card.offsetHeight || 380;

    if (dock === 'left' || dock === 'right') {
      const btnCenterY = (btnRect.top - rowRect.top) + btnRect.height / 2;
      let topPx = btnCenterY - 44;
      const minTop = 8 - rowRect.top;
      const maxTop = window.innerHeight - cardHeight - 8 - rowRect.top;
      topPx = Math.max(minTop, Math.min(maxTop, topPx));
      card.style.top = `${Math.round(topPx)}px`;
      card.style.left = '';
      card.style.right = '';
      const arrowY = Math.max(18, Math.min(cardHeight - 18, btnCenterY - topPx));
      card.style.setProperty('--gn-arrow-pos', `${Math.round(arrowY)}px`);
      return;
    }

    const btnCenterX = (btnRect.left - rowRect.left) + btnRect.width / 2;
    let leftPx = btnCenterX - cardWidth / 2;
    const minLeft = 10 - rowRect.left;
    const maxLeft = window.innerWidth - cardWidth - 10 - rowRect.left;
    leftPx = Math.max(minLeft, Math.min(maxLeft, leftPx));

    card.style.left = `${Math.round(leftPx)}px`;
    card.style.right = 'auto';
    card.style.top = '';
    const arrowX = Math.max(22, Math.min(cardWidth - 22, btnCenterX - leftPx));
    card.style.setProperty('--gn-arrow-pos', `${Math.round(arrowX)}px`);
  }

  public render(): void {
    this._container.dataset.dock = store.appSettings.toolbarDock;
    document.body.dataset.toolbarDock = store.appSettings.toolbarDock;
    if (!store.activeDocument) {
      this._container.style.display = 'none';
      return;
    }
    this._container.style.display = '';

    const activeTool = store.activeTool;
    const canUndo = history.canUndo;
    const canRedo = history.canRedo;
    const s = store.toolSettings;
    const selectedIds = Array.from(store.selectedAnnotationIds);

    this._lastActiveTool = activeTool;
    this._lastCanUndo = canUndo;
    this._lastCanRedo = canRedo;
    this._lastSelectedCount = selectedIds.length;
    this._lastLayoutKey = JSON.stringify(store.toolbarLayout);
    this._lastDock = store.appSettings.toolbarDock;

    const penColors = ['#000000', '#ffffff', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    const penWidths = [1, 2, 4, 8, 14];

    const hlColors = ['#fef08a', '#86efac', '#f472b6', '#7dd3fc', '#fdba74', '#d8b4fe'];
    const hlWidths = [10, 20, 32, 48];

    const textColors = ['#000000', '#ffffff', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    const textSizes = [12, 14, 18, 24, 32, 48];

    const hlOpacityPct = Math.round((s.highlighterOpacity ?? 0.45) * 100);
    const hlPreviewPath = s.highlighterStraightLine
      ? 'M 32 35 L 228 35'
      : 'M 30 46 C 92 78, 168 10, 230 38';

    this._container.innerHTML = `
      <div class="toolbar-main-row">
        <button type="button" class="toolbar-drag-handle" title="Drag to dock top, bottom, left, or right" aria-label="Drag toolbar to dock">
          ${getIconSvg('moreVertical', 14)}
        </button>

        <!-- Selection Tool -->
        <div class="tool-btn-wrapper ${this._pinnedTool === 'select' ? 'is-pinned' : ''}" data-wrapper-tool="select">
          <button class="tool-btn ${activeTool === 'select' ? 'active' : ''}" data-tool="select" title="${t('tools.select')} (V)">
            ${getIconSvg('select')}
          </button>
          ${selectedIds.length > 0 ? `
            <div class="tool-hover-card gn-popover gn-popover-compact">
              <div class="gn-popover-arrow"></div>
              <div class="gn-card-header">
                <span class="gn-card-title">${selectedIds.length} Selected</span>
              </div>
              <div class="gn-section">
                <button id="del-selected-btn" class="danger-btn" style="width:100%;">
                  ${getIconSvg('trash', 14)} Delete Selected
                </button>
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Hand / Pan Tool -->
        <button class="tool-btn ${activeTool === 'hand' ? 'active' : ''}" data-tool="hand" title="${t('tools.hand')}" style="cursor:grab;">
          ${getIconSvg('hand')}
        </button>

        <!-- Lasso Select Tool -->
        <button class="tool-btn ${activeTool === 'lasso' ? 'active' : ''}" data-tool="lasso" title="${t('tools.lasso')} (Q)">
          ${getIconSvg('lasso')}
        </button>

        <div class="toolbar-separator"></div>

        <!-- Drawing & Ink Group -->
        <div class="toolbar-group">
          <!-- Pen with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'pen' ? 'is-pinned' : ''}" data-wrapper-tool="pen">
            <button class="tool-btn has-popover ${activeTool === 'pen' ? 'active' : ''}" data-tool="pen" title="${t('tools.pen')} (P)">
              ${getIconSvg('pen')}
              <span class="tool-color-dot pen-dot" style="background-color:${s.penColor};"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>

              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.pen')}</span>
                <span class="gn-card-meta pen-meta-badge">${s.penWidth}px</span>
              </div>

              <!-- Live Goodnotes S-Curve Stroke Preview -->
              <div class="gn-preview-stage">
                <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
                  <path class="gn-pen-preview-path" d="M 28 46 C 90 80, 170 8, 232 38"
                        stroke="${s.penColor}"
                        stroke-width="${Math.min(28, Math.max(1.6, s.penWidth * 1.15))}"
                        stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </div>

              <!-- Cursor Mode Visual Icon Tiles (replaces plain text buttons) -->
              <div class="gn-section">
                <div class="gn-tile-grid cols-4" role="group" aria-label="Drawing cursor">
                  <button type="button" class="gn-icon-tile mode-toggle-btn cursor-toggle-btn ${(s.drawingCursor || 'pen') === 'pen' ? 'active' : ''}" data-drawing-cursor="pen" title="Stylus Pen Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorPen', 20)}</span>
                    <span class="gn-tile-label">Pen</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'dot' ? 'active' : ''}" data-drawing-cursor="dot" title="Precision Dot Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorDot', 20)}</span>
                    <span class="gn-tile-label">Dot</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'circle' ? 'active' : ''}" data-drawing-cursor="circle" title="Brush Circle Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorCircle', 20)}</span>
                    <span class="gn-tile-label">Circle</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'crosshair' ? 'active' : ''}" data-drawing-cursor="crosshair" title="Crosshair Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorCrosshair', 20)}</span>
                    <span class="gn-tile-label">Cross</span>
                  </button>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Stroke Size: Quick Dots + Editable Input + Smooth Slider -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Stroke Size</span>
                  <div class="gn-size-header-controls">
                    <div class="size-pills-group gn-dots-strip">
                      ${penWidths.map(w => `
                        <button type="button" class="size-pill pen-pill gn-dot-btn ${s.penWidth === w ? 'active' : ''}" data-pen-width="${w}" title="${w}px">
                          <span class="size-dot" style="width:${Math.min(14, Math.max(3.5, w * 1.15))}px; height:${Math.min(14, Math.max(3.5, w * 1.15))}px;"></span>
                        </button>
                      `).join('')}
                    </div>
                    <div class="gn-num-badge">
                      <input type="number" id="hover-pen-width-input" class="size-readout size-type-input pen-readout"
                             min="1" max="50" step="1" value="${s.penWidth}" title="Type any width (1-50px)" aria-label="Pen width">
                      <span class="gn-unit">px</span>
                    </div>
                  </div>
                </div>
                <div class="gn-slider-wrap">
                  <input type="range" id="hover-pen-width-slider" class="gn-range-slider pen-width-slider"
                         min="1" max="50" step="1" value="${s.penWidth}"
                         style="--slider-pct:${sliderPercent(s.penWidth, 1, 50)}%" aria-label="Pen width slider">
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Ink Colors -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Ink Color</span>
                  <input type="text" id="hover-pen-color-hex" class="hex-type-input" value="${s.penColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color, e.g. #4f46e5" aria-label="Pen color hex">
                </div>
                <div class="color-swatches-group gn-swatch-grid">
                  ${renderDefaultSwatches('pen', 'pen-color', 'pen-swatch', penColors, s.penColor)}
                  ${renderCustomPaletteSwatches('pen-color', 'pen-swatch', s.penColor)}
                  ${renderAddToPaletteButton(s.penColor)}
                  <div class="color-picker-wrapper" title="Custom color picker">
                    <input type="color" id="hover-pen-color-picker" class="color-picker-input" value="${s.penColor}">
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Highlighter with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'highlighter' ? 'is-pinned' : ''}" data-wrapper-tool="highlighter">
            <button class="tool-btn has-popover ${activeTool === 'highlighter' ? 'active' : ''}" data-tool="highlighter" title="${t('tools.highlighter')} (H)">
              ${getIconSvg('highlighter')}
              <span class="tool-color-dot hl-dot" style="background-color:${s.highlighterColor}; opacity:0.9;"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>

              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.highlighter')}</span>
                <span class="gn-card-meta hl-meta-badge">${s.highlighterWidth}px · ${hlOpacityPct}%</span>
              </div>

              <!-- Live Highlighter Stroke Preview -->
              <div class="gn-preview-stage">
                <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
                  <path class="gn-hl-preview-path" d="${hlPreviewPath}"
                        stroke="${s.highlighterColor}"
                        stroke-opacity="${s.highlighterOpacity ?? 0.45}"
                        stroke-width="${Math.min(34, Math.max(8, s.highlighterWidth * 0.6))}"
                        stroke-linecap="${(s.highlighterTipShape || 'round') === 'chisel' ? 'butt' : 'round'}"
                        stroke-linejoin="round" />
                </svg>
              </div>

              <!-- Tip Shape Visual Cards -->
              <div class="gn-section">
                <div class="gn-tile-grid cols-2" role="group" aria-label="Highlighter tip shape">
                  <button type="button" class="gn-icon-tile mode-toggle-btn hl-tip-btn ${(s.highlighterTipShape || 'round') === 'round' ? 'active' : ''}" data-hl-tip="round" title="Round Marker Tip">
                    <span class="gn-tile-icon">${getIconSvg('tipRound', 22)}</span>
                    <span class="gn-tile-label">Round Tip</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn hl-tip-btn ${s.highlighterTipShape === 'chisel' ? 'active' : ''}" data-hl-tip="chisel" title="Chisel Marker Tip">
                    <span class="gn-tile-icon">${getIconSvg('tipChisel', 22)}</span>
                    <span class="gn-tile-label">Chisel Tip</span>
                  </button>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Stroke Width Slider + Dots -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Width</span>
                  <div class="gn-size-header-controls">
                    <div class="size-pills-group gn-dots-strip">
                      ${hlWidths.map(w => `
                        <button type="button" class="size-pill hl-pill gn-dot-btn ${s.highlighterWidth === w ? 'active' : ''}" data-hl-width="${w}" title="${w}px">
                          <span class="size-dot" style="width:${Math.min(14, Math.max(5, w * 0.28))}px; height:${Math.min(14, Math.max(5, w * 0.28))}px;"></span>
                        </button>
                      `).join('')}
                    </div>
                    <div class="gn-num-badge">
                      <input type="number" id="hover-hl-width-input" class="size-readout size-type-input hl-readout"
                             min="2" max="100" step="1" value="${s.highlighterWidth}" title="Type any width (2-100px)" aria-label="Highlighter width">
                      <span class="gn-unit">px</span>
                    </div>
                  </div>
                </div>
                <div class="gn-slider-wrap">
                  <input type="range" id="hover-hl-width-slider" class="gn-range-slider hl-width-slider"
                         min="2" max="100" step="1" value="${s.highlighterWidth}"
                         style="--slider-pct:${sliderPercent(s.highlighterWidth, 2, 100)}%" aria-label="Highlighter width slider">
                </div>
              </div>

              <!-- Opacity Notched Slider + Presets -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Opacity</span>
                  <div class="gn-size-header-controls">
                    <div class="size-pills-group">
                      ${[0.25, 0.45, 0.7].map(op => `
                        <button type="button" class="size-pill hl-op-pill ${Math.abs((s.highlighterOpacity ?? 0.45) - op) < 0.05 ? 'active' : ''}" data-hl-opacity="${op}">${Math.round(op * 100)}%</button>
                      `).join('')}
                    </div>
                    <div class="gn-num-badge">
                      <input type="number" id="hover-hl-opacity-input" class="size-readout size-type-input hl-op-readout"
                             min="10" max="90" step="5" value="${hlOpacityPct}" title="Type opacity (10-90%)" aria-label="Highlighter opacity">
                      <span class="gn-unit">%</span>
                    </div>
                  </div>
                </div>
                <div class="gn-slider-wrap gn-slider-notched">
                  <input type="range" id="hover-hl-opacity-slider" class="gn-range-slider hl-opacity-slider"
                         min="10" max="90" step="5" value="${hlOpacityPct}"
                         style="--slider-pct:${sliderPercent(hlOpacityPct, 10, 90)}%" aria-label="Highlighter opacity slider">
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Tint Color Swatches -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Tint Color</span>
                  <input type="text" id="hover-hl-color-hex" class="hex-type-input" value="${s.highlighterColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color, e.g. #fef08a" aria-label="Highlighter color hex">
                </div>
                <div class="color-swatches-group gn-swatch-grid">
                  ${renderDefaultSwatches('highlighter', 'hl-color', 'hl-swatch', hlColors, s.highlighterColor, ' opacity:0.9;')}
                  ${renderCustomPaletteSwatches('hl-color', 'hl-swatch', s.highlighterColor)}
                  ${renderAddToPaletteButton(s.highlighterColor)}
                  <div class="color-picker-wrapper" title="Custom highlighter color">
                    <input type="color" id="hover-hl-color-picker" class="color-picker-input" value="${s.highlighterColor}">
                  </div>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Cursor Tiles & Straight-Line Switch -->
              <div class="gn-section">
                <span class="gn-section-label" style="margin-bottom:6px; display:block;">Cursor & Settings</span>
                <div class="gn-tile-grid cols-4" style="margin-bottom:8px;">
                  <button type="button" class="gn-icon-tile is-compact mode-toggle-btn hl-cursor-btn ${(s.highlighterCursor || 'rectangle') === 'rectangle' ? 'active' : ''}" data-hl-cursor="rectangle" title="Rectangle Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorRect', 17)}</span>
                    <span class="gn-tile-label">Rect</span>
                  </button>
                  <button type="button" class="gn-icon-tile is-compact mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'chisel' ? 'active' : ''}" data-hl-cursor="chisel" title="Chisel Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorChisel', 17)}</span>
                    <span class="gn-tile-label">Chisel</span>
                  </button>
                  <button type="button" class="gn-icon-tile is-compact mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'circle' ? 'active' : ''}" data-hl-cursor="circle" title="Circle Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorCircle', 17)}</span>
                    <span class="gn-tile-label">Circle</span>
                  </button>
                  <button type="button" class="gn-icon-tile is-compact mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'crosshair' ? 'active' : ''}" data-hl-cursor="crosshair" title="Crosshair Cursor">
                    <span class="gn-tile-icon">${getIconSvg('cursorCrosshair', 17)}</span>
                    <span class="gn-tile-label">Cross</span>
                  </button>
                </div>

                <!-- Goodnotes Toggle Switch Row for Straight Line -->
                <button type="button" class="gn-setting-row" data-hl-straight-toggle aria-pressed="${!!s.highlighterStraightLine}">
                  <span class="gn-setting-label">
                    ${getIconSvg('lineStraight', 16)}
                    <span>Draw Straight Line</span>
                  </span>
                  <span class="gn-switch ${s.highlighterStraightLine ? 'is-on' : ''}">
                    <span class="gn-switch-thumb"></span>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <!-- Eraser with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'eraser' ? 'is-pinned' : ''}" data-wrapper-tool="eraser">
            <button class="tool-btn has-popover ${activeTool === 'eraser' ? 'active' : ''}" data-tool="eraser" title="${t('tools.eraser')} (E)">
              ${getIconSvg('eraser')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>

              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.eraser')}</span>
                <span class="gn-card-meta eraser-meta-badge">${s.eraserWidth}px</span>
              </div>

              <!-- Live Eraser Preview Stage -->
              <div class="gn-preview-stage">
                <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
                  <path d="M 34 44 C 92 70, 168 16, 226 36" stroke="currentColor" stroke-opacity="0.25" stroke-width="4" stroke-dasharray="5 5" stroke-linecap="round"/>
                  <circle class="gn-eraser-preview-circle" cx="130" cy="34" r="${Math.min(26, Math.max(5, s.eraserWidth * 0.42))}"
                          fill="var(--danger-subtle)" stroke="var(--danger)" stroke-width="1.75"/>
                </svg>
              </div>

              <!-- Eraser Mode Visual Icon Cards -->
              <div class="gn-section">
                <div class="gn-tile-grid cols-3" role="group" aria-label="Eraser mode">
                  <button type="button" class="gn-icon-tile mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'stroke' ? 'active' : ''}" data-eraser-mode="stroke" title="Erase Entire Stroke">
                    <span class="gn-tile-icon">${getIconSvg('eraserStroke', 22)}</span>
                    <span class="gn-tile-label">Stroke</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'object' ? 'active' : ''}" data-eraser-mode="object" title="Erase Whole Object">
                    <span class="gn-tile-icon">${getIconSvg('eraserObject', 22)}</span>
                    <span class="gn-tile-label">Object</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn eraser-mode-btn ${s.eraserMode === 'pixel' ? 'active' : ''}" data-eraser-mode="pixel" title="Precision Pixel Eraser">
                    <span class="gn-tile-icon">${getIconSvg('eraserPixel', 22)}</span>
                    <span class="gn-tile-label">Pixel</span>
                  </button>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Eraser Size Dots + Smooth Slider -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Eraser Size</span>
                  <div class="gn-size-header-controls">
                    <div class="size-pills-group gn-dots-strip">
                      ${[
                        { w: 10, r: 5, label: 'Small (10px)' },
                        { w: 24, r: 8.5, label: 'Medium (24px)' },
                        { w: 48, r: 12.5, label: 'Large (48px)' }
                      ].map(item => `
                        <button type="button" class="size-pill eraser-pill gn-dot-btn ${s.eraserWidth === item.w ? 'active' : ''}" data-eraser-width="${item.w}" title="${item.label}">
                          <span class="size-dot" style="width:${item.r}px; height:${item.r}px;"></span>
                        </button>
                      `).join('')}
                    </div>
                    <div class="gn-num-badge">
                      <input type="number" id="hover-eraser-width-input" class="size-readout size-type-input eraser-readout"
                             min="4" max="120" step="1" value="${s.eraserWidth}" title="Type any width (4-120px)" aria-label="Eraser width">
                      <span class="gn-unit">px</span>
                    </div>
                  </div>
                </div>
                <div class="gn-slider-wrap">
                  <input type="range" id="hover-eraser-width-slider" class="gn-range-slider eraser-width-slider"
                         min="4" max="120" step="1" value="${s.eraserWidth}"
                         style="--slider-pct:${sliderPercent(s.eraserWidth, 4, 120)}%" aria-label="Eraser width slider">
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="toolbar-separator"></div>

        <!-- Shapes Group -->
        <div class="toolbar-group">
          <!-- Rectangle with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'rectangle' ? 'is-pinned' : ''}" data-wrapper-tool="rectangle">
            <button class="tool-btn has-popover ${activeTool === 'rectangle' ? 'active' : ''}" data-tool="rectangle" title="${t('tools.rectangle')} (R)">
              ${getIconSvg('rectangle')}
              <span class="tool-color-dot shape-dot" style="background-color:${s.shapeColor};"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              ${this.renderShapeHoverCard(s, 'rectangle')}
            </div>
          </div>

          <!-- Ellipse with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'ellipse' ? 'is-pinned' : ''}" data-wrapper-tool="ellipse">
            <button class="tool-btn has-popover ${activeTool === 'ellipse' ? 'active' : ''}" data-tool="ellipse" title="${t('tools.ellipse')} (O)">
              ${getIconSvg('ellipse')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              ${this.renderShapeHoverCard(s, 'ellipse')}
            </div>
          </div>

          <!-- Line with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'line' ? 'is-pinned' : ''}" data-wrapper-tool="line">
            <button class="tool-btn has-popover ${activeTool === 'line' ? 'active' : ''}" data-tool="line" title="${t('tools.line')} (L)">
              ${getIconSvg('line')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              ${this.renderShapeHoverCard(s, 'line')}
            </div>
          </div>

          <!-- Arrow with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'arrow' ? 'is-pinned' : ''}" data-wrapper-tool="arrow">
            <button class="tool-btn has-popover ${activeTool === 'arrow' ? 'active' : ''}" data-tool="arrow" title="${t('tools.arrow')} (A)">
              ${getIconSvg('arrow')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              ${this.renderShapeHoverCard(s, 'arrow')}
            </div>
          </div>

          <!-- Polygon with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'polygon' ? 'is-pinned' : ''}" data-wrapper-tool="polygon">
            <button class="tool-btn has-popover ${activeTool === 'polygon' ? 'active' : ''}" data-tool="polygon" title="Custom Multi-Point Polygon (G)">
              ${getIconSvg('polygon')}
              <span class="tool-color-dot shape-dot" style="background-color:${s.shapeColor};"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              ${this.renderShapeHoverCard(s, 'polygon')}
            </div>
          </div>
        </div>

        <div class="toolbar-separator"></div>

        <!-- Annotation & Media Group -->
        <div class="toolbar-group">
          <!-- Text Tool with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'text' ? 'is-pinned' : ''}" data-wrapper-tool="text">
            <button class="tool-btn has-popover ${activeTool === 'text' ? 'active' : ''}" data-tool="text" title="${t('tools.text')} (T)">
              ${getIconSvg('text')}
              <span class="tool-color-dot text-dot" style="background-color:${s.textColor};"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>

              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.text')}</span>
                <span class="gn-card-meta text-meta-badge">${s.fontSize}px</span>
              </div>

              <!-- Live Typography Preview Stage -->
              <div class="gn-preview-stage gn-text-preview-stage">
                <span class="gn-text-preview-sample"
                      style="color:${s.textColor}; font-family:${s.fontFamily || 'Inter'}; font-size:${Math.min(34, Math.max(12, s.fontSize))}px;">
                  Aa متن نمونه
                </span>
              </div>

              <!-- Font Family Icon Cards -->
              <div class="gn-section">
                <div class="gn-tile-grid cols-2" role="group" aria-label="Font family">
                  <button type="button" class="gn-icon-tile mode-toggle-btn font-fam-btn ${(s.fontFamily || 'Inter').includes('Inter') ? 'active' : ''}" data-font-fam="Inter">
                    <span class="gn-font-glyph" style="font-family:var(--font-en);">Aa</span>
                    <span class="gn-tile-label">Inter</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn font-fam-btn ${(s.fontFamily || '').includes('Vazirmatn') ? 'active' : ''}" data-font-fam="Vazirmatn">
                    <span class="gn-font-glyph" style="font-family:var(--font-fa);">الف</span>
                    <span class="gn-tile-label">وزیرمتن</span>
                  </button>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Font Size Presets + Slider -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Font Size</span>
                  <div class="gn-num-badge">
                    <input type="number" id="hover-font-size-input" class="size-readout size-type-input"
                           min="6" max="144" step="1" value="${s.fontSize}" title="Type any size (6-144px)" aria-label="Font size">
                    <span class="gn-unit">px</span>
                  </div>
                </div>
                <div class="gn-preset-grid cols-6">
                  ${textSizes.map(sz => `
                    <button type="button" class="size-pill text-pill ${s.fontSize === sz ? 'active' : ''}" data-font-size="${sz}">${sz}</button>
                  `).join('')}
                </div>
                <div class="gn-slider-wrap">
                  <input type="range" id="hover-font-size-slider" class="gn-range-slider font-size-slider"
                         min="6" max="144" step="1" value="${s.fontSize}"
                         style="--slider-pct:${sliderPercent(s.fontSize, 6, 144)}%" aria-label="Font size slider">
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Text Color Swatches -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Text Color</span>
                  <input type="text" id="hover-text-color-hex" class="hex-type-input" value="${s.textColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Text color hex">
                </div>
                <div class="color-swatches-group gn-swatch-grid">
                  ${renderDefaultSwatches('text', 'text-color', 'text-swatch', textColors, s.textColor)}
                  ${renderCustomPaletteSwatches('text-color', 'text-swatch', s.textColor)}
                  ${renderAddToPaletteButton(s.textColor)}
                  <div class="color-picker-wrapper" title="Custom text color">
                    <input type="color" id="hover-text-color-picker" class="color-picker-input" value="${s.textColor}">
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Sticky Note Tool with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'sticky-note' ? 'is-pinned' : ''}" data-wrapper-tool="sticky-note">
            <button class="tool-btn has-popover ${activeTool === 'sticky-note' ? 'active' : ''}" data-tool="sticky-note" title="${t('tools.stickyNote')}">
              ${getIconSvg('sticky-note')}
              <span class="tool-color-dot note-dot" style="background-color:${s.noteColor || '#ebd09e'};"></span>
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>

              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.stickyNote')}</span>
                <span class="gn-card-meta note-meta-badge">${s.noteFontSize || 24}px</span>
              </div>

              <!-- Live Sticky Note Mini Card Preview -->
              <div class="gn-preview-stage" style="height:76px; padding:6px;">
                <div class="gn-note-preview-card"
                     style="width:168px; height:60px; border-radius:8px; background:${s.noteColor || '#ebd09e'}; border:1.5px solid rgba(59,47,30,0.22); padding:6px 10px; display:flex; flex-direction:column; justify-content:space-between; box-shadow:0 3px 10px rgba(0,0,0,0.16);">
                  <span class="gn-note-preview-text"
                        style="color:${s.noteTextColor || '#3b2f1e'}; font-family:${s.fontFamily || 'Inter'}; font-size:${Math.min(18, Math.max(11, Math.round((s.noteFontSize || 24) * 0.65)))}px; font-weight:500; line-height:1.2; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">
                    Sticky Note…
                  </span>
                  <span class="gn-note-preview-author"
                        style="color:${s.noteTextColor || '#3b2f1e'}; opacity:0.65; font-size:10px; font-weight:500;">
                    ${(s.noteAuthor !== undefined ? s.noteAuthor : 'Kia Gh') || ' '}
                  </span>
                </div>
              </div>

              <!-- Paper Background Color Swatches -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Note Paper Color</span>
                  <input type="text" id="hover-note-color-hex" class="hex-type-input" value="${s.noteColor || '#ebd09e'}"
                         spellcheck="false" maxlength="7" title="Type any hex paper color" aria-label="Note paper color hex">
                </div>
                <div class="color-swatches-group gn-swatch-grid">
                  ${renderDefaultSwatches('sticky-note', 'note-color', 'note-swatch', ['#ebd09e', '#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#e9d5ff', '#fed7aa'], s.noteColor || '#ebd09e')}
                  ${renderCustomPaletteSwatches('note-color', 'note-swatch', s.noteColor || '#ebd09e')}
                  ${renderAddToPaletteButton(s.noteColor || '#ebd09e')}
                  <div class="color-picker-wrapper" title="Custom note paper color">
                    <input type="color" id="hover-note-color-picker" class="color-picker-input" value="${s.noteColor || '#ebd09e'}">
                  </div>
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Text & Ink Color Swatches -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Text & Ink Color</span>
                  <div class="color-picker-wrapper" title="Custom text & ink color" style="width:22px; height:22px;">
                    <input type="color" id="hover-note-textcolor-picker" class="color-picker-input" value="${s.noteTextColor || '#3b2f1e'}">
                  </div>
                </div>
                <div class="color-swatches-group gn-swatch-grid">
                  ${['#3b2f1e', '#0f172a', '#1e3a8a', '#065f46', '#991b1b', '#581c87'].map(c => `
                    <button type="button" class="color-swatch ${(s.noteTextColor || '#3b2f1e').toLowerCase() === c ? 'active' : ''}"
                            style="background-color:${c};" data-note-textcolor="${c}" title="${c}"></button>
                  `).join('')}
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Note Font Size -->
              <div class="gn-section">
                <div class="gn-section-header">
                  <span class="gn-section-label">Font Size</span>
                  <div class="gn-num-badge">
                    <input type="number" id="hover-note-fontsize-input" class="size-readout size-type-input"
                           min="10" max="96" step="1" value="${s.noteFontSize || 24}" title="Font size (10-96px)" aria-label="Note font size">
                    <span class="gn-unit">px</span>
                  </div>
                </div>
                <div class="gn-slider-wrap">
                  <input type="range" id="hover-note-fontsize-slider" class="gn-range-slider"
                         min="10" max="72" step="1" value="${s.noteFontSize || 24}"
                         style="--slider-pct:${sliderPercent(s.noteFontSize || 24, 10, 72)}%" aria-label="Note font size slider">
                </div>
              </div>

              <div class="gn-divider"></div>

              <!-- Author Signature Label -->
              <div class="gn-section">
                <div class="gn-section-header" style="gap:8px;">
                  <span class="gn-section-label">Author Signature</span>
                  <input type="text" id="hover-note-author-input" class="hex-type-input"
                         style="width:118px; text-align:left; font-family:var(--font-en);"
                         value="${s.noteAuthor !== undefined ? s.noteAuthor : 'Kia Gh'}"
                         placeholder="Author name" maxlength="40" aria-label="Note author signature">
                </div>
              </div>
            </div>
          </div>

          <!-- Stamp with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'stamp' ? 'is-pinned' : ''}" data-wrapper-tool="stamp">
            <button class="tool-btn has-popover ${activeTool === 'stamp' ? 'active' : ''}" data-tool="stamp" title="${t('tools.stamp')} (M)">
              ${getIconSvg('stamp')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover">
              <div class="gn-popover-arrow"></div>
              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.stamp')}</span>
              </div>
              <div class="gn-preview-stage">
                <span class="gn-stamp-preview-badge" data-stamp-preview="${s.stampPreset || 'APPROVED'}">
                  ${(s.stampPreset || 'APPROVED').replace('_', ' ')}
                </span>
              </div>
              <div class="gn-section">
                <div class="gn-tile-grid cols-2">
                  ${['APPROVED', 'CONFIDENTIAL', 'DRAFT', 'SIGN_HERE', 'PAID', 'VOID'].map(st => `
                    <button type="button" class="gn-stamp-tile mode-toggle-btn ${(s.stampPreset || 'APPROVED') === st ? 'active' : ''}" data-stamp-choice="${st}" data-stamp-variant="${st}">
                      ${st.replace('_', ' ')}
                    </button>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- Measure with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'measure-distance' ? 'is-pinned' : ''}" data-wrapper-tool="measure-distance">
            <button class="tool-btn has-popover ${activeTool === 'measure-distance' ? 'active' : ''}" data-tool="measure-distance" title="${t('tools.measure')}">
              ${getIconSvg('measure')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover gn-popover-compact">
              <div class="gn-popover-arrow"></div>
              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.measure')}</span>
                <span class="gn-card-meta measure-meta-badge">${s.measureUnit}</span>
              </div>
              <div class="gn-preview-stage" style="height:52px;">
                <svg class="gn-preview-svg" viewBox="0 0 260 52" fill="none" aria-hidden="true">
                  <line x1="40" y1="28" x2="220" y2="28" stroke="var(--accent)" stroke-width="2"/>
                  <line x1="40" y1="20" x2="40" y2="36" stroke="var(--accent)" stroke-width="2"/>
                  <line x1="220" y1="20" x2="220" y2="36" stroke="var(--accent)" stroke-width="2"/>
                  <text x="130" y="21" text-anchor="middle" fill="var(--text-primary)" font-size="11" font-weight="600" class="gn-measure-preview-text">100 ${s.measureUnit}</text>
                </svg>
              </div>
              <div class="gn-section">
                <span class="gn-section-label" style="margin-bottom:6px; display:block;">Measurement Unit</span>
                <div class="gn-unit-grid">
                  ${['mm', 'cm', 'm', 'in', 'ft', 'pt', 'px'].map(u => `
                    <button type="button" class="size-pill measure-pill ${s.measureUnit === u ? 'active' : ''}" data-measure-unit="${u}">${u}</button>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- Signature Pad Trigger -->
          <button class="tool-btn ${activeTool === 'signature' ? 'active' : ''}" id="toolbar-signature-btn" data-tool="signature" title="${t('tools.signature')} (K)">
            ${getIconSvg('signature')}
          </button>

          <!-- Redaction with Goodnotes Popover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'redaction' ? 'is-pinned' : ''}" data-wrapper-tool="redaction">
            <button class="tool-btn has-popover ${activeTool === 'redaction' ? 'active' : ''}" data-tool="redaction" title="${t('tools.redaction')} (X)">
              ${getIconSvg('redaction')}
              <span class="tool-chevron">${getIconSvg('chevronDown', 9, 2.5)}</span>
            </button>
            <div class="tool-hover-card gn-popover gn-popover-compact">
              <div class="gn-popover-arrow"></div>
              <div class="gn-card-header">
                <span class="gn-card-title">${t('tools.redaction')}</span>
              </div>
              <div class="gn-section">
                <div class="gn-tile-grid cols-2">
                  <button type="button" class="gn-icon-tile mode-toggle-btn ${(s.redactionColor || '#000000') === '#000000' ? 'active' : ''}" data-redact-color="#000000">
                    <span class="gn-tile-icon">${getIconSvg('redactBlack', 22)}</span>
                    <span class="gn-tile-label">Blackout</span>
                  </button>
                  <button type="button" class="gn-icon-tile mode-toggle-btn ${(s.redactionColor || '#000000') === '#ffffff' ? 'active' : ''}" data-redact-color="#ffffff">
                    <span class="gn-tile-icon">${getIconSvg('redactWhite', 22)}</span>
                    <span class="gn-tile-label">Whiteout</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Floating Scratchpad -->
          <button class="tool-btn ${activeTool === 'scratchpad' ? 'active' : ''}" data-tool="scratchpad" title="${t('tools.scratchpad')} (N)">
            ${getIconSvg('scratchpad')}
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
    this.applyCustomLayout();

    if (this._pinnedTool) {
      const wrapper = this._container.querySelector<HTMLElement>(`.tool-btn-wrapper[data-wrapper-tool="${this._pinnedTool}"]`);
      if (wrapper) {
        requestAnimationFrame(() => this.positionPopover(wrapper));
      }
    }
  }

  /**
   * Reorders / hides toolbar buttons per the user's saved layout WITHOUT
   * re-templating: elements (and their bound listeners) are moved in place
   * and family separators rebuilt.
   */
  private applyCustomLayout(): void {
    const row = this._container.querySelector('.toolbar-main-row');
    if (!row) return;
    const layout = store.toolbarLayout;
    const undoGroup = row.querySelector('#toolbar-undo-btn')?.closest('.toolbar-group') as HTMLElement | null;

    const byId = new Map<ToolType, HTMLElement>();
    for (const el of this.toolElements()) {
      const id = this.toolIdOf(el);
      if (id && !byId.has(id)) byId.set(id, el);
    }

    const shown = layout.filter(l => l.visible);

    row.querySelectorAll(':scope > *').forEach(n => {
      if (n !== undoGroup && !(n instanceof HTMLElement && n.classList.contains('toolbar-drag-handle'))) n.remove();
    });

    let lastFamily: string | null = null;
    for (const item of shown) {
      const el = byId.get(item.id);
      if (!el) continue;
      const fam = toolbarFamily(item.id);
      if (lastFamily !== null && fam !== lastFamily) {
        const sep = document.createElement('div');
        sep.className = 'toolbar-separator';
        row.appendChild(sep);
      }
      lastFamily = fam;
      row.appendChild(el);
    }

    if (undoGroup) row.appendChild(undoGroup);
  }

  /** Top-level tool elements: hover-card wrappers + standalone buttons. */
  private toolElements(): HTMLElement[] {
    const els: HTMLElement[] = [];
    this._container.querySelectorAll('.toolbar-main-row [data-wrapper-tool]').forEach(w => {
      els.push(w as HTMLElement);
    });
    this._container.querySelectorAll('.toolbar-main-row .tool-btn[data-tool]').forEach(b => {
      const btn = b as HTMLElement;
      if (!btn.closest('[data-wrapper-tool]')) els.push(btn);
    });
    return els;
  }

  private toolIdOf(el: HTMLElement): ToolType | null {
    if (el.hasAttribute('data-wrapper-tool')) {
      return el.getAttribute('data-wrapper-tool') as ToolType;
    }
    if (el.classList.contains('tool-btn')) {
      return el.getAttribute('data-tool') as ToolType;
    }
    return null;
  }

  private updateIndicators(): void {
    const s = store.toolSettings;

    // 1. Pen Indicators + Live SVG Preview
    const penDot = this._container.querySelector<HTMLElement>('.pen-dot');
    if (penDot) penDot.style.backgroundColor = s.penColor;

    const penMeta = this._container.querySelector<HTMLElement>('.pen-meta-badge');
    if (penMeta) penMeta.textContent = `${s.penWidth}px`;

    const penPath = this._container.querySelector<SVGPathElement>('.gn-pen-preview-path');
    if (penPath) {
      penPath.setAttribute('stroke', s.penColor);
      penPath.setAttribute('stroke-width', String(Math.min(28, Math.max(1.6, s.penWidth * 1.15))));
    }

    this._container.querySelectorAll('[data-pen-color]').forEach(el => {
      const c = el.getAttribute('data-pen-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.penColor.toLowerCase());
    });

    const penPicker = this._container.querySelector<HTMLInputElement>('#hover-pen-color-picker');
    if (penPicker && penPicker.value !== s.penColor) penPicker.value = s.penColor;

    this._container.querySelectorAll('[data-pen-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-pen-width') || '0', 10);
      el.classList.toggle('active', w === s.penWidth);
    });

    const penReadout = this._container.querySelector<HTMLInputElement>('.pen-readout');
    if (penReadout && document.activeElement !== penReadout) penReadout.value = String(s.penWidth);

    const penSlider = this._container.querySelector<HTMLInputElement>('#hover-pen-width-slider');
    if (penSlider) {
      if (document.activeElement !== penSlider) penSlider.value = String(s.penWidth);
      penSlider.style.setProperty('--slider-pct', `${sliderPercent(s.penWidth, 1, 50)}%`);
    }

    this._container.querySelectorAll<HTMLInputElement>('.hex-type-input#hover-pen-color-hex').forEach(el => {
      if (document.activeElement !== el && el.value !== s.penColor) el.value = s.penColor;
    });

    this._container.querySelectorAll('[data-drawing-cursor]').forEach(el => {
      const cur = el.getAttribute('data-drawing-cursor');
      el.classList.toggle('active', cur === (s.drawingCursor || 'pen'));
    });

    // 2. Highlighter Indicators + Live SVG Preview
    const hlDot = this._container.querySelector<HTMLElement>('.hl-dot');
    if (hlDot) {
      hlDot.style.backgroundColor = s.highlighterColor;
      hlDot.style.opacity = String(s.highlighterOpacity ?? 0.45);
    }

    const hlOpPct = Math.round((s.highlighterOpacity ?? 0.45) * 100);
    const hlMeta = this._container.querySelector<HTMLElement>('.hl-meta-badge');
    if (hlMeta) hlMeta.textContent = `${s.highlighterWidth}px · ${hlOpPct}%`;

    const hlPath = this._container.querySelector<SVGPathElement>('.gn-hl-preview-path');
    if (hlPath) {
      hlPath.setAttribute('d', s.highlighterStraightLine ? 'M 32 35 L 228 35' : 'M 30 46 C 92 78, 168 10, 230 38');
      hlPath.setAttribute('stroke', s.highlighterColor);
      hlPath.setAttribute('stroke-opacity', String(s.highlighterOpacity ?? 0.45));
      hlPath.setAttribute('stroke-width', String(Math.min(34, Math.max(8, s.highlighterWidth * 0.6))));
      hlPath.setAttribute('stroke-linecap', (s.highlighterTipShape || 'round') === 'chisel' ? 'butt' : 'round');
    }

    this._container.querySelectorAll('[data-hl-color]').forEach(el => {
      const c = el.getAttribute('data-hl-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.highlighterColor.toLowerCase());
    });

    const hlPicker = this._container.querySelector<HTMLInputElement>('#hover-hl-color-picker');
    if (hlPicker && hlPicker.value !== s.highlighterColor) hlPicker.value = s.highlighterColor;

    this._container.querySelectorAll('[data-hl-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-hl-width') || '0', 10);
      el.classList.toggle('active', w === s.highlighterWidth);
    });

    const hlReadout = this._container.querySelector<HTMLInputElement>('.hl-readout');
    if (hlReadout && document.activeElement !== hlReadout) hlReadout.value = String(s.highlighterWidth);

    const hlWidthSlider = this._container.querySelector<HTMLInputElement>('#hover-hl-width-slider');
    if (hlWidthSlider) {
      if (document.activeElement !== hlWidthSlider) hlWidthSlider.value = String(s.highlighterWidth);
      hlWidthSlider.style.setProperty('--slider-pct', `${sliderPercent(s.highlighterWidth, 2, 100)}%`);
    }

    const hlHex = this._container.querySelector<HTMLInputElement>('#hover-hl-color-hex');
    if (hlHex && document.activeElement !== hlHex && hlHex.value !== s.highlighterColor) hlHex.value = s.highlighterColor;

    const hlStraightToggle = this._container.querySelector<HTMLElement>('[data-hl-straight-toggle]');
    if (hlStraightToggle) {
      hlStraightToggle.setAttribute('aria-pressed', String(!!s.highlighterStraightLine));
      hlStraightToggle.querySelector('.gn-switch')?.classList.toggle('is-on', !!s.highlighterStraightLine);
    }

    this._container.querySelectorAll('[data-hl-tip]').forEach(el => {
      const tip = el.getAttribute('data-hl-tip');
      el.classList.toggle('active', tip === (s.highlighterTipShape || 'round'));
    });

    this._container.querySelectorAll('[data-hl-opacity]').forEach(el => {
      const op = parseFloat(el.getAttribute('data-hl-opacity') || '0.45');
      el.classList.toggle('active', Math.abs((s.highlighterOpacity ?? 0.45) - op) < 0.05);
    });

    const hlOpReadout = this._container.querySelector<HTMLInputElement>('.hl-op-readout');
    if (hlOpReadout && document.activeElement !== hlOpReadout) {
      hlOpReadout.value = String(hlOpPct);
    }

    const hlOpSlider = this._container.querySelector<HTMLInputElement>('#hover-hl-opacity-slider');
    if (hlOpSlider) {
      if (document.activeElement !== hlOpSlider) hlOpSlider.value = String(hlOpPct);
      hlOpSlider.style.setProperty('--slider-pct', `${sliderPercent(hlOpPct, 10, 90)}%`);
    }

    this._container.querySelectorAll('[data-hl-cursor]').forEach(el => {
      const cur = el.getAttribute('data-hl-cursor');
      el.classList.toggle('active', cur === (s.highlighterCursor || 'rectangle'));
    });

    // 3. Eraser Indicators + Live Preview
    const eraserMeta = this._container.querySelector<HTMLElement>('.eraser-meta-badge');
    if (eraserMeta) eraserMeta.textContent = `${s.eraserWidth}px`;

    const eraserCircle = this._container.querySelector<SVGCircleElement>('.gn-eraser-preview-circle');
    if (eraserCircle) {
      eraserCircle.setAttribute('r', String(Math.min(26, Math.max(5, s.eraserWidth * 0.42))));
    }

    this._container.querySelectorAll('[data-eraser-mode]').forEach(el => {
      const m = el.getAttribute('data-eraser-mode');
      el.classList.toggle('active', m === s.eraserMode);
    });

    this._container.querySelectorAll('[data-eraser-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-eraser-width') || '0', 10);
      el.classList.toggle('active', w === s.eraserWidth);
    });

    const eraserReadout = this._container.querySelector<HTMLInputElement>('.eraser-readout');
    if (eraserReadout && document.activeElement !== eraserReadout) eraserReadout.value = String(s.eraserWidth);

    const eraserSlider = this._container.querySelector<HTMLInputElement>('#hover-eraser-width-slider');
    if (eraserSlider) {
      if (document.activeElement !== eraserSlider) eraserSlider.value = String(s.eraserWidth);
      eraserSlider.style.setProperty('--slider-pct', `${sliderPercent(s.eraserWidth, 4, 120)}%`);
    }

    // 4. Shape Indicators across all 5 shape cards
    this._container.querySelectorAll<HTMLElement>('.shape-dot').forEach(dot => {
      dot.style.backgroundColor = s.shapeColor;
    });

    this._container.querySelectorAll<HTMLElement>('.shape-meta-badge').forEach(badge => {
      badge.textContent = `${s.shapeWidth}px`;
    });

    const dashArr = shapeDashArray(s.shapeStyle || 'solid', s.shapeWidth);
    const showOutline = s.shapeOutline !== false;
    const strokeCol = showOutline ? s.shapeColor : 'none';
    const fillCol = s.shapeFillColor === 'transparent' ? 'none' : s.shapeFillColor;
    const previewSw = Math.max(1.5, Math.min(10, s.shapeWidth));

    this._container.querySelectorAll<SVGElement>('.gn-shape-preview-el').forEach(el => {
      const kind = el.getAttribute('data-preview-shape');
      if (kind === 'line' || kind === 'arrow') {
        el.setAttribute('stroke', s.shapeColor);
      } else {
        el.setAttribute('stroke', strokeCol);
        el.setAttribute('fill', fillCol);
      }
      el.setAttribute('stroke-width', String(previewSw));
      if (dashArr === 'none') el.removeAttribute('stroke-dasharray');
      else el.setAttribute('stroke-dasharray', dashArr);
    });

    this._container.querySelectorAll<SVGElement>('.gn-shape-preview-arrow-head').forEach(el => {
      el.setAttribute('stroke', s.shapeColor);
      el.setAttribute('stroke-width', String(previewSw));
    });

    this._container.querySelectorAll('[data-shape-color]').forEach(el => {
      const c = el.getAttribute('data-shape-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.shapeColor.toLowerCase());
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-color-picker').forEach(picker => {
      if (picker.value !== s.shapeColor) picker.value = s.shapeColor;
    });

    this._container.querySelectorAll('[data-shape-width]').forEach(el => {
      const w = parseFloat(el.getAttribute('data-shape-width') || '0');
      el.classList.toggle('active', w === s.shapeWidth);
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-width-slider').forEach(slider => {
      if (document.activeElement !== slider) slider.value = String(s.shapeWidth);
      slider.style.setProperty('--slider-pct', `${sliderPercent(s.shapeWidth, 0.5, 40)}%`);
    });

    this._container.querySelectorAll('[data-shape-style]').forEach(el => {
      const st = el.getAttribute('data-shape-style');
      el.classList.toggle('active', st === s.shapeStyle);
    });

    this._container.querySelectorAll<HTMLElement>('[data-shape-outline-toggle]').forEach(btn => {
      const on = s.shapeOutline !== false;
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('.gn-switch')?.classList.toggle('is-on', on);
    });

    this._container.querySelectorAll<HTMLElement>('[data-shape-opt]').forEach(el => {
      const key = el.getAttribute('data-shape-opt') as ToolOptionKey | null;
      const tool = el.closest<HTMLElement>('[data-wrapper-tool]')?.dataset.wrapperTool as ToolType | undefined;
      if (!key || !tool) return;
      const isOn = store.toolOption(tool, key);
      el.classList.toggle('active', isOn);
      el.setAttribute('aria-pressed', String(isOn));
      el.querySelector('.gn-switch')?.classList.toggle('is-on', isOn);
    });

    this._container.querySelectorAll('[data-shape-fill="transparent"]').forEach(el => {
      el.classList.toggle('active', s.shapeFillColor === 'transparent');
    });

    this._container.querySelectorAll('[data-shape-fill-color]').forEach(el => {
      const c = el.getAttribute('data-shape-fill-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.shapeFillColor.toLowerCase());
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-fill-picker').forEach(picker => {
      if (s.shapeFillColor !== 'transparent' && picker.value !== s.shapeFillColor) {
        picker.value = s.shapeFillColor;
      }
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-width-input').forEach(el => {
      if (document.activeElement !== el && el.value !== String(s.shapeWidth)) el.value = String(s.shapeWidth);
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-stroke-hex').forEach(el => {
      if (document.activeElement !== el && el.value !== s.shapeColor) el.value = s.shapeColor;
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-fill-hex').forEach(el => {
      const shown = s.shapeFillColor === 'transparent' ? '' : s.shapeFillColor;
      if (document.activeElement !== el && el.value !== shown) el.value = shown;
    });

    // 5. Text Indicators + Live Typography Preview
    const textDot = this._container.querySelector<HTMLElement>('.text-dot');
    if (textDot) textDot.style.backgroundColor = s.textColor;

    const textMeta = this._container.querySelector<HTMLElement>('.text-meta-badge');
    if (textMeta) textMeta.textContent = `${s.fontSize}px`;

    const textSample = this._container.querySelector<HTMLElement>('.gn-text-preview-sample');
    if (textSample) {
      textSample.style.color = s.textColor;
      textSample.style.fontFamily = s.fontFamily || 'Inter';
      textSample.style.fontSize = `${Math.min(34, Math.max(12, s.fontSize))}px`;
    }

    this._container.querySelectorAll('[data-text-color]').forEach(el => {
      const c = el.getAttribute('data-text-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.textColor.toLowerCase());
    });

    const textPicker = this._container.querySelector<HTMLInputElement>('#hover-text-color-picker');
    if (textPicker && textPicker.value !== s.textColor) textPicker.value = s.textColor;

    const textHex = this._container.querySelector<HTMLInputElement>('#hover-text-color-hex');
    if (textHex && document.activeElement !== textHex && textHex.value !== s.textColor) textHex.value = s.textColor;

    const fontInput = this._container.querySelector<HTMLInputElement>('#hover-font-size-input');
    if (fontInput && document.activeElement !== fontInput && fontInput.value !== String(s.fontSize)) {
      fontInput.value = String(s.fontSize);
    }

    const fontSlider = this._container.querySelector<HTMLInputElement>('#hover-font-size-slider');
    if (fontSlider) {
      if (document.activeElement !== fontSlider) fontSlider.value = String(s.fontSize);
      fontSlider.style.setProperty('--slider-pct', `${sliderPercent(s.fontSize, 6, 144)}%`);
    }

    this._container.querySelectorAll('[data-font-size]').forEach(el => {
      const sz = parseInt(el.getAttribute('data-font-size') || '0', 10);
      el.classList.toggle('active', sz === s.fontSize);
    });

    this._container.querySelectorAll('[data-font-fam]').forEach(el => {
      const fam = el.getAttribute('data-font-fam');
      const activeFam = s.fontFamily || 'Inter';
      el.classList.toggle('active', fam ? activeFam.includes(fam) : false);
    });

    // 5b. Sticky Note Indicators + Live Preview
    const noteCol = s.noteColor || '#ebd09e';
    const noteTxtCol = s.noteTextColor || '#3b2f1e';
    const noteFs = s.noteFontSize || 24;
    const noteAuth = s.noteAuthor !== undefined ? s.noteAuthor : 'Kia Gh';

    const noteDot = this._container.querySelector<HTMLElement>('.note-dot');
    if (noteDot) noteDot.style.backgroundColor = noteCol;

    const noteMeta = this._container.querySelector<HTMLElement>('.note-meta-badge');
    if (noteMeta) noteMeta.textContent = `${noteFs}px`;

    const notePreviewCard = this._container.querySelector<HTMLElement>('.gn-note-preview-card');
    if (notePreviewCard) notePreviewCard.style.background = noteCol;

    const notePreviewText = this._container.querySelector<HTMLElement>('.gn-note-preview-text');
    if (notePreviewText) {
      notePreviewText.style.color = noteTxtCol;
      notePreviewText.style.fontFamily = s.fontFamily || 'Inter';
      notePreviewText.style.fontSize = `${Math.min(18, Math.max(11, Math.round(noteFs * 0.65)))}px`;
    }

    const notePreviewAuthor = this._container.querySelector<HTMLElement>('.gn-note-preview-author');
    if (notePreviewAuthor) {
      notePreviewAuthor.style.color = noteTxtCol;
      notePreviewAuthor.textContent = noteAuth || ' ';
    }

    this._container.querySelectorAll('[data-note-color]').forEach(el => {
      const c = el.getAttribute('data-note-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === noteCol.toLowerCase());
    });

    this._container.querySelectorAll('[data-note-textcolor]').forEach(el => {
      const c = el.getAttribute('data-note-textcolor');
      el.classList.toggle('active', !!c && c.toLowerCase() === noteTxtCol.toLowerCase());
    });

    const notePicker = this._container.querySelector<HTMLInputElement>('#hover-note-color-picker');
    if (notePicker && notePicker.value !== noteCol) notePicker.value = noteCol;

    const noteHex = this._container.querySelector<HTMLInputElement>('#hover-note-color-hex');
    if (noteHex && document.activeElement !== noteHex && noteHex.value !== noteCol) noteHex.value = noteCol;

    const noteTextPicker = this._container.querySelector<HTMLInputElement>('#hover-note-textcolor-picker');
    if (noteTextPicker && noteTextPicker.value !== noteTxtCol) noteTextPicker.value = noteTxtCol;

    const noteFsInput = this._container.querySelector<HTMLInputElement>('#hover-note-fontsize-input');
    if (noteFsInput && document.activeElement !== noteFsInput && noteFsInput.value !== String(noteFs)) {
      noteFsInput.value = String(noteFs);
    }

    const noteFsSlider = this._container.querySelector<HTMLInputElement>('#hover-note-fontsize-slider');
    if (noteFsSlider) {
      if (document.activeElement !== noteFsSlider) noteFsSlider.value = String(noteFs);
      noteFsSlider.style.setProperty('--slider-pct', `${sliderPercent(noteFs, 10, 72)}%`);
    }

    const noteAuthorInput = this._container.querySelector<HTMLInputElement>('#hover-note-author-input');
    if (noteAuthorInput && document.activeElement !== noteAuthorInput && noteAuthorInput.value !== noteAuth) {
      noteAuthorInput.value = noteAuth;
    }

    // 6. Stamp Indicators
    const stampPreview = this._container.querySelector<HTMLElement>('.gn-stamp-preview-badge');
    if (stampPreview) {
      const preset = s.stampPreset || 'APPROVED';
      stampPreview.textContent = preset.replace('_', ' ');
      stampPreview.setAttribute('data-stamp-preview', preset);
    }
    this._container.querySelectorAll('[data-stamp-choice]').forEach(el => {
      const st = el.getAttribute('data-stamp-choice');
      el.classList.toggle('active', st === (s.stampPreset || 'APPROVED'));
    });

    // 7. Measure Indicators
    const measureMeta = this._container.querySelector<HTMLElement>('.measure-meta-badge');
    if (measureMeta) measureMeta.textContent = s.measureUnit;
    const measureText = this._container.querySelector<SVGTextElement>('.gn-measure-preview-text');
    if (measureText) measureText.textContent = `100 ${s.measureUnit}`;

    this._container.querySelectorAll('[data-measure-unit]').forEach(el => {
      const u = el.getAttribute('data-measure-unit');
      el.classList.toggle('active', u === s.measureUnit);
    });

    // 8. Redaction Indicators
    this._container.querySelectorAll('[data-redact-color]').forEach(el => {
      const rc = el.getAttribute('data-redact-color');
      el.classList.toggle('active', rc === (s.redactionColor || '#000000'));
    });

    // 9. Undo / Redo buttons reactive state
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

  private renderShapePreviewSvg(s: typeof store.toolSettings, shapeType: string): string {
    const showOutline = s.shapeOutline !== false;
    const strokeCol = (shapeType === 'line' || shapeType === 'arrow')
      ? s.shapeColor
      : (showOutline ? s.shapeColor : 'none');
    const fillCol = s.shapeFillColor === 'transparent' ? 'none' : s.shapeFillColor;
    const sw = Math.max(1.5, Math.min(10, s.shapeWidth));
    const dash = shapeDashArray(s.shapeStyle || 'solid', s.shapeWidth);
    const dashAttr = dash === 'none' ? '' : `stroke-dasharray="${dash}"`;

    if (shapeType === 'rectangle') {
      return `
        <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
          <rect class="gn-shape-preview-el" data-preview-shape="rectangle"
                x="68" y="13" width="124" height="40" rx="5"
                stroke="${strokeCol}" fill="${fillCol}" stroke-width="${sw}" ${dashAttr}/>
        </svg>
      `;
    }
    if (shapeType === 'ellipse') {
      return `
        <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
          <ellipse class="gn-shape-preview-el" data-preview-shape="ellipse"
                   cx="130" cy="33" rx="60" ry="21"
                   stroke="${strokeCol}" fill="${fillCol}" stroke-width="${sw}" ${dashAttr}/>
        </svg>
      `;
    }
    if (shapeType === 'line') {
      return `
        <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
          <line class="gn-shape-preview-el" data-preview-shape="line"
                x1="40" y1="46" x2="220" y2="20"
                stroke="${strokeCol}" stroke-width="${sw}" stroke-linecap="round" ${dashAttr}/>
        </svg>
      `;
    }
    if (shapeType === 'arrow') {
      return `
        <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
          <line class="gn-shape-preview-el" data-preview-shape="arrow"
                x1="42" y1="45" x2="214" y2="21"
                stroke="${strokeCol}" stroke-width="${sw}" stroke-linecap="round" ${dashAttr}/>
          <polyline class="gn-shape-preview-arrow-head"
                    points="198 14 216 21 203 36"
                    stroke="${strokeCol}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      `;
    }
    return `
      <svg class="gn-preview-svg" viewBox="0 0 260 66" fill="none" aria-hidden="true">
        <polygon class="gn-shape-preview-el" data-preview-shape="polygon"
                 points="130,10 184,26 164,55 96,55 76,26"
                 stroke="${strokeCol}" fill="${fillCol}" stroke-width="${sw}" stroke-linejoin="round" ${dashAttr}/>
      </svg>
    `;
  }

  private renderShapeHoverCard(s: typeof store.toolSettings, shapeType: string): string {
    const shapeColors = ['#ef4444', '#3b82f6', '#10b981', '#000000', '#ffffff', '#f59e0b', '#8b5cf6'];
    const strokeWidths = [1, 2, 4, 8];
    const hasClosedArea = shapeType === 'rectangle' || shapeType === 'ellipse' || shapeType === 'polygon';
    const isSegment = SEGMENT_TOOLS.includes(shapeType as ToolType);
    const titleLabel = TOOL_SHORT_LABELS[shapeType] || shapeType;

    return `
      <div class="gn-popover-arrow"></div>

      <div class="gn-card-header">
        <span class="gn-card-title">${titleLabel}</span>
        <span class="gn-card-meta shape-meta-badge">${s.shapeWidth}px</span>
      </div>

      <!-- Live SVG Shape Preview Stage -->
      <div class="gn-preview-stage">
        ${this.renderShapePreviewSvg(s, shapeType)}
      </div>

      <!-- Line Style Visual Icon Cards -->
      <div class="gn-section">
        <div class="gn-tile-grid cols-3" role="group" aria-label="Stroke style">
          <button type="button" class="gn-icon-tile mode-toggle-btn ${s.shapeStyle === 'solid' ? 'active' : ''}" data-shape-style="solid" title="Solid Line">
            <span class="gn-tile-icon">${getIconSvg('styleSolid', 20)}</span>
            <span class="gn-tile-label">Solid</span>
          </button>
          <button type="button" class="gn-icon-tile mode-toggle-btn ${s.shapeStyle === 'dashed' ? 'active' : ''}" data-shape-style="dashed" title="Dashed Line">
            <span class="gn-tile-icon">${getIconSvg('styleDashed', 20)}</span>
            <span class="gn-tile-label">Dashed</span>
          </button>
          <button type="button" class="gn-icon-tile mode-toggle-btn ${s.shapeStyle === 'dotted' ? 'active' : ''}" data-shape-style="dotted" title="Dotted Line">
            <span class="gn-tile-icon">${getIconSvg('styleDotted', 20)}</span>
            <span class="gn-tile-label">Dotted</span>
          </button>
        </div>
      </div>

      <div class="gn-divider"></div>

      <!-- Stroke Width Dots + Input + Smooth Slider -->
      <div class="gn-section">
        <div class="gn-section-header">
          <span class="gn-section-label">Stroke Width</span>
          <div class="gn-size-header-controls">
            <div class="size-pills-group gn-dots-strip">
              ${strokeWidths.map(w => `
                <button type="button" class="size-pill shape-pill gn-dot-btn ${s.shapeWidth === w ? 'active' : ''}" data-shape-width="${w}" title="${w}px">
                  <span class="size-dot" style="width:${Math.min(13, Math.max(3.5, w * 1.35))}px; height:${Math.min(13, Math.max(3.5, w * 1.35))}px;"></span>
                </button>
              `).join('')}
            </div>
            <div class="gn-num-badge">
              <input type="number" class="size-readout size-type-input shape-width-input"
                     min="0.5" max="40" step="0.5" value="${s.shapeWidth}" title="Type any width (0.5-40px)" aria-label="Shape stroke width">
              <span class="gn-unit">px</span>
            </div>
          </div>
        </div>
        <div class="gn-slider-wrap">
          <input type="range" class="gn-range-slider shape-width-slider"
                 min="0.5" max="40" step="0.5" value="${s.shapeWidth}"
                 style="--slider-pct:${sliderPercent(s.shapeWidth, 0.5, 40)}%" aria-label="Shape stroke width slider">
        </div>
      </div>

      <div class="gn-divider"></div>

      <!-- Stroke Color Swatches -->
      <div class="gn-section">
        <div class="gn-section-header">
          <span class="gn-section-label">Stroke Color</span>
          <input type="text" class="hex-type-input shape-stroke-hex" value="${s.shapeColor}"
                 spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Shape stroke color hex">
        </div>
        <div class="color-swatches-group gn-swatch-grid">
          ${renderDefaultSwatches('shape', 'shape-color', 'shape-swatch', shapeColors, s.shapeColor)}
          ${renderCustomPaletteSwatches('shape-color', 'shape-swatch', s.shapeColor)}
          ${renderAddToPaletteButton(s.shapeColor)}
          <div class="color-picker-wrapper" title="Custom stroke color">
            <input type="color" class="color-picker-input shape-color-picker" value="${s.shapeColor}">
          </div>
        </div>
      </div>

      ${hasClosedArea ? `
        <div class="gn-divider"></div>
        <div class="gn-section">
          <div class="gn-section-header">
            <span class="gn-section-label">Fill Color</span>
            <input type="text" class="hex-type-input shape-fill-hex" value="${s.shapeFillColor === 'transparent' ? '' : s.shapeFillColor}"
                   spellcheck="false" maxlength="7" placeholder="None" title="Type any hex fill color, empty = none" aria-label="Shape fill color hex">
          </div>
          <div class="color-swatches-group gn-swatch-grid">
            <button type="button" class="color-swatch gn-nofill-swatch ${s.shapeFillColor === 'transparent' ? 'active' : ''}" data-shape-fill="transparent" title="No Fill (Transparent)">
              ${getIconSvg('noFill', 14)}
            </button>
            ${renderDefaultSwatches('shape-fill', 'shape-fill-color', 'shape-fill-swatch', shapeColors, s.shapeFillColor)}
            ${renderCustomPaletteSwatches('shape-fill-color', 'shape-fill-swatch', s.shapeFillColor)}
            ${renderAddToPaletteButton(s.shapeFillColor === 'transparent' ? '#ffffff' : s.shapeFillColor)}
            <div class="color-picker-wrapper" title="Custom Fill Color">
              <input type="color" class="color-picker-input shape-fill-picker" value="${s.shapeFillColor === 'transparent' ? '#ffffff' : s.shapeFillColor}">
            </div>
          </div>
        </div>
      ` : ''}

      ${(hasClosedArea || isSegment) ? `
        <div class="gn-divider"></div>
        <div class="gn-section gn-settings-list">
          <span class="gn-section-label" style="margin-bottom:4px; display:block;">Settings</span>
          ${hasClosedArea ? `
            <button type="button" class="gn-setting-row" data-shape-outline-toggle aria-pressed="${s.shapeOutline !== false}">
              <span class="gn-setting-label">
                ${getIconSvg('outlineOn', 15)}
                <span>Shape Border (Outline)</span>
              </span>
              <span class="gn-switch ${s.shapeOutline !== false ? 'is-on' : ''}">
                <span class="gn-switch-thumb"></span>
              </span>
            </button>
          ` : ''}
          ${isSegment ? `
            <button type="button" class="gn-setting-row shape-opt-btn ${store.toolOption(shapeType as ToolType, 'snapAngle15') ? 'active' : ''}"
                    data-shape-opt="snapAngle15" aria-pressed="${store.toolOption(shapeType as ToolType, 'snapAngle15')}"
                    title="Constrain this tool's segments to 15° increments (Shift always does)">
              <span class="gn-setting-label">
                ${getIconSvg('snapAngle', 15)}
                <span>Snap to 15° Angles</span>
              </span>
              <span class="gn-switch ${store.toolOption(shapeType as ToolType, 'snapAngle15') ? 'is-on' : ''}">
                <span class="gn-switch-thumb"></span>
              </span>
            </button>
            <button type="button" class="gn-setting-row shape-opt-btn ${store.toolOption(shapeType as ToolType, 'connectLines') ? 'active' : ''}"
                    data-shape-opt="connectLines" aria-pressed="${store.toolOption(shapeType as ToolType, 'connectLines')}"
                    title="Merge this line with a coincident endpoint into one continuous path">
              <span class="gn-setting-label">
                ${getIconSvg('connectNodes', 15)}
                <span>Connect Endpoints</span>
              </span>
              <span class="gn-switch ${store.toolOption(shapeType as ToolType, 'connectLines') ? 'is-on' : ''}">
                <span class="gn-switch-thumb"></span>
              </span>
            </button>
          ` : ''}
        </div>
      ` : ''}
    `;
  }

  private bindEvents(s: typeof store.toolSettings) {
    // Tool buttons click & toggle pin
    this._container.querySelectorAll<HTMLElement>('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool') as ToolType;
        if (!tool) return;

        store.setActiveTool(tool);

        if (tool === 'signature') {
          store.setSignatureModalOpen(true);
          return;
        }

        if (tool === 'scratchpad') {
          store.setScratchpadOpen(true);
          return;
        }

        const wrapper = btn.closest<HTMLElement>('.tool-btn-wrapper');
        if (wrapper) {
          const isCurrentlyPinned = wrapper.classList.contains('is-pinned');
          this.unpinAll();
          if (!isCurrentlyPinned) {
            wrapper.classList.add('is-pinned');
            this._pinnedTool = tool;
            this.positionPopover(wrapper);
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
        if (color) {
          store.updateToolSettings({ penColor: color });
          this.updateIndicators();
        }
      });
    });

    const penPicker = this._container.querySelector<HTMLInputElement>('#hover-pen-color-picker');
    penPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ penColor: color });
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-pen-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-pen-width') || '2', 10);
        store.updateToolSettings({ penWidth: w });
        this.updateIndicators();
      });
    });

    const penSlider = this._container.querySelector<HTMLInputElement>('#hover-pen-width-slider');
    penSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const w = parseInt((e.target as HTMLInputElement).value || '2', 10);
      store.updateToolSettings({ penWidth: w });
      this.updateIndicators();
    });

    // Drawing Cursor listener
    this._container.querySelectorAll('[data-drawing-cursor]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const cursor = el.getAttribute('data-drawing-cursor') as any;
        if (cursor) {
          store.updateToolSettings({ drawingCursor: cursor });
          this.updateIndicators();
        }
      });
    });

    // Highlighter listeners
    this._container.querySelectorAll('[data-hl-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-hl-color');
        if (color) {
          store.updateToolSettings({ highlighterColor: color });
          this.updateIndicators();
        }
      });
    });

    const hlPicker = this._container.querySelector<HTMLInputElement>('#hover-hl-color-picker');
    hlPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ highlighterColor: color });
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-hl-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-hl-width') || '20', 10);
        store.updateToolSettings({ highlighterWidth: w });
        this.updateIndicators();
      });
    });

    const hlWidthSlider = this._container.querySelector<HTMLInputElement>('#hover-hl-width-slider');
    hlWidthSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const w = parseInt((e.target as HTMLInputElement).value || '20', 10);
      store.updateToolSettings({ highlighterWidth: w });
      this.updateIndicators();
    });

    const hlOpSlider = this._container.querySelector<HTMLInputElement>('#hover-hl-opacity-slider');
    hlOpSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const pct = parseInt((e.target as HTMLInputElement).value || '45', 10);
      store.updateToolSettings({ highlighterOpacity: pct / 100 });
      this.updateIndicators();
    });

    this._container.querySelector('[data-hl-straight-toggle]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      store.updateToolSettings({ highlighterStraightLine: !store.toolSettings.highlighterStraightLine });
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-hl-tip]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const tip = el.getAttribute('data-hl-tip') as any;
        if (tip) {
          store.updateToolSettings({ highlighterTipShape: tip });
          this.updateIndicators();
        }
      });
    });

    this._container.querySelectorAll('[data-hl-opacity]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const op = parseFloat(el.getAttribute('data-hl-opacity') || '0.45');
        store.updateToolSettings({ highlighterOpacity: op });
        this.updateIndicators();
      });
    });

    this._container.querySelectorAll('[data-hl-cursor]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = el.getAttribute('data-hl-cursor') as any;
        if (cur) {
          store.updateToolSettings({ highlighterCursor: cur });
          this.updateIndicators();
        }
      });
    });

    // Eraser listeners
    this._container.querySelectorAll('[data-eraser-mode]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = el.getAttribute('data-eraser-mode') as EraserMode;
        if (mode) {
          store.updateToolSettings({ eraserMode: mode });
          this.updateIndicators();
        }
      });
    });

    this._container.querySelectorAll('[data-eraser-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseInt(el.getAttribute('data-eraser-width') || '24', 10);
        store.updateToolSettings({ eraserWidth: w });
        this.updateIndicators();
      });
    });

    const eraserSlider = this._container.querySelector<HTMLInputElement>('#hover-eraser-width-slider');
    eraserSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const w = parseInt((e.target as HTMLInputElement).value || '24', 10);
      store.updateToolSettings({ eraserWidth: w });
      this.updateIndicators();
    });

    // Free-typed numeric + hex inputs (Enter/blur commits, Escape reverts)
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

    const bindTyped = (selector: string, commit: (el: HTMLInputElement) => void) => {
      this._container.querySelectorAll<HTMLInputElement>(selector).forEach(el => {
        el.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(el);
            el.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.updateIndicators();
            el.blur();
          }
        });
        el.addEventListener('focus', () => el.select());
        el.addEventListener('change', () => commit(el));
        el.addEventListener('blur', () => commit(el));
      });
    };

    bindTyped('#hover-pen-width-input', (el) => {
      const w = Math.round(clampTypedNumber(el.value, 1, 50, store.toolSettings.penWidth));
      if (w !== store.toolSettings.penWidth) {
        store.updateToolSettings({ penWidth: w });
        this.updateIndicators();
      } else {
        el.value = String(w);
      }
    });

    bindTyped('#hover-hl-width-input', (el) => {
      const w = Math.round(clampTypedNumber(el.value, 2, 100, store.toolSettings.highlighterWidth));
      if (w !== store.toolSettings.highlighterWidth) {
        store.updateToolSettings({ highlighterWidth: w });
        this.updateIndicators();
      } else {
        el.value = String(w);
      }
    });

    bindTyped('#hover-hl-opacity-input', (el) => {
      const pct = Math.round(clampTypedNumber(el.value, 10, 90, Math.round((store.toolSettings.highlighterOpacity ?? 0.45) * 100)));
      const op = pct / 100;
      if (Math.abs((store.toolSettings.highlighterOpacity ?? 0.45) - op) >= 0.01) {
        store.updateToolSettings({ highlighterOpacity: op });
        this.updateIndicators();
      } else {
        el.value = String(pct);
      }
    });

    bindTyped('#hover-eraser-width-input', (el) => {
      const w = Math.round(clampTypedNumber(el.value, 4, 120, store.toolSettings.eraserWidth));
      if (w !== store.toolSettings.eraserWidth) {
        store.updateToolSettings({ eraserWidth: w });
        this.updateIndicators();
      } else {
        el.value = String(w);
      }
    });

    bindTyped('.shape-width-input', (el) => {
      const w = Math.round(clampTypedNumber(el.value, 0.5, 40, store.toolSettings.shapeWidth) * 2) / 2;
      if (w !== store.toolSettings.shapeWidth) {
        applyShapeWidth(w);
      } else {
        el.value = String(w);
      }
    });

    bindTyped('#hover-font-size-input', (el) => {
      const sz = Math.round(clampTypedNumber(el.value, 6, 144, store.toolSettings.fontSize));
      if (sz !== store.toolSettings.fontSize) {
        store.updateToolSettings({ fontSize: sz });
        this.updateIndicators();
      } else {
        el.value = String(sz);
      }
    });

    const bindHex = (selector: string, get: () => string, set: (hex: string) => void) => {
      bindTyped(selector, (el) => {
        const current = get();
        const parsed = parseHexColor(el.value);
        if (parsed && parsed !== current.toLowerCase()) {
          set(parsed);
          this.updateIndicators();
        } else {
          el.value = current;
        }
      });
    };

    bindHex('#hover-pen-color-hex', () => store.toolSettings.penColor, (hex) => store.updateToolSettings({ penColor: hex }));
    bindHex('#hover-hl-color-hex', () => store.toolSettings.highlighterColor, (hex) => store.updateToolSettings({ highlighterColor: hex }));
    bindHex('#hover-text-color-hex', () => store.toolSettings.textColor, (hex) => store.updateToolSettings({ textColor: hex }));
    bindHex('.shape-stroke-hex', () => store.toolSettings.shapeColor, (hex) => applyShapeColor(hex));

    bindTyped('.shape-fill-hex', (el) => {
      const raw = el.value.trim();
      if (raw === '') {
        if (store.toolSettings.shapeFillColor !== 'transparent') {
          applyShapeFill('transparent');
        }
        el.value = '';
        return;
      }
      const parsed = parseHexColor(raw);
      const current = store.toolSettings.shapeFillColor;
      if (parsed && parsed !== current.toLowerCase()) {
        applyShapeFill(parsed);
      } else {
        el.value = current === 'transparent' ? '' : current;
      }
    });

    // Shapes listeners
    const applyShapeColor = (color: string) => {
      store.updateToolSettings({ shapeColor: color });
      this.updateIndicators();

      const doc = store.activeDocument;
      if (doc && store.selectedAnnotationIds.size > 0) {
        for (const pageIdx in doc.annotations) {
          doc.annotations[pageIdx].forEach(ann => {
            if (store.selectedAnnotationIds.has(ann.id) && 'strokeColor' in ann) {
              const prev = { ...ann };
              const next = { ...ann, strokeColor: color };
              history.execute(new ModifyAnnotationCommand(parseInt(pageIdx, 10), prev, next));
            }
          });
        }
        store.setActivePageIndex(store.activePageIndex);
      }
    };

    const applyShapeWidth = (w: number) => {
      store.updateToolSettings({ shapeWidth: w });
      this.updateIndicators();

      const doc = store.activeDocument;
      if (doc && store.selectedAnnotationIds.size > 0) {
        for (const pageIdx in doc.annotations) {
          doc.annotations[pageIdx].forEach(ann => {
            if (store.selectedAnnotationIds.has(ann.id) && 'strokeWidth' in ann) {
              const prev = { ...ann };
              const next = { ...ann, strokeWidth: w };
              history.execute(new ModifyAnnotationCommand(parseInt(pageIdx, 10), prev, next));
            }
          });
        }
        store.setActivePageIndex(store.activePageIndex);
      }
    };

    const applyShapeStyle = (st: 'solid' | 'dashed' | 'dotted') => {
      store.updateToolSettings({ shapeStyle: st });
      this.updateIndicators();

      const doc = store.activeDocument;
      if (doc && store.selectedAnnotationIds.size > 0) {
        for (const pageIdx in doc.annotations) {
          doc.annotations[pageIdx].forEach(ann => {
            if (store.selectedAnnotationIds.has(ann.id) && 'strokeStyle' in ann) {
              const prev = { ...ann };
              const next = { ...ann, strokeStyle: st };
              history.execute(new ModifyAnnotationCommand(parseInt(pageIdx, 10), prev, next));
            }
          });
        }
        store.setActivePageIndex(store.activePageIndex);
      }
    };

    const applyShapeOutline = (on: boolean) => {
      store.updateToolSettings({ shapeOutline: on });
      this.updateIndicators();

      const doc = store.activeDocument;
      if (doc && store.selectedAnnotationIds.size > 0) {
        for (const pageIdx in doc.annotations) {
          doc.annotations[pageIdx].forEach(ann => {
            if (store.selectedAnnotationIds.has(ann.id) && 'outline' in ann) {
              const prev = { ...ann };
              const next = { ...ann, outline: on };
              history.execute(new ModifyAnnotationCommand(parseInt(pageIdx, 10), prev, next));
            }
          });
        }
        store.setActivePageIndex(store.activePageIndex);
      }
    };

    const applyShapeFill = (color: string) => {
      store.updateToolSettings({ shapeFillColor: color });
      this.updateIndicators();

      const doc = store.activeDocument;
      if (doc && store.selectedAnnotationIds.size > 0) {
        for (const pageIdx in doc.annotations) {
          doc.annotations[pageIdx].forEach(ann => {
            if (store.selectedAnnotationIds.has(ann.id) && 'fillColor' in ann) {
              const prev = { ...ann };
              const next = { ...ann, fillColor: color };
              history.execute(new ModifyAnnotationCommand(parseInt(pageIdx, 10), prev, next));
            }
          });
        }
        store.setActivePageIndex(store.activePageIndex);
      }
    };

    this._container.querySelectorAll('[data-shape-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-shape-color');
        if (color) applyShapeColor(color);
      });
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-color-picker').forEach(picker => {
      const handleColor = (e: Event) => {
        const color = (e.target as HTMLInputElement).value;
        applyShapeColor(color);
      };
      picker.addEventListener('input', handleColor);
      picker.addEventListener('change', handleColor);
    });

    this._container.querySelectorAll('[data-shape-width]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = parseFloat(el.getAttribute('data-shape-width') || '2');
        applyShapeWidth(w);
      });
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-width-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        e.stopPropagation();
        const w = parseFloat((e.target as HTMLInputElement).value || '2');
        applyShapeWidth(w);
      });
    });

    this._container.querySelectorAll('[data-shape-style]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const st = el.getAttribute('data-shape-style') as any;
        if (st) applyShapeStyle(st);
      });
    });

    this._container.querySelectorAll('[data-shape-outline-toggle]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        applyShapeOutline(store.toolSettings.shapeOutline === false);
      });
    });

    this._container.querySelectorAll('[data-shape-opt]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = el.getAttribute('data-shape-opt') as ToolOptionKey | null;
        const wrapper = el.closest<HTMLElement>('[data-wrapper-tool]');
        const tool = wrapper?.dataset.wrapperTool as ToolType | undefined;
        if (!key || !tool) return;
        store.setToolOption(tool, key, !store.toolOption(tool, key));
        this.updateIndicators();
      });
    });

    this._container.querySelectorAll('[data-shape-fill="transparent"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        applyShapeFill('transparent');
      });
    });

    this._container.querySelectorAll('[data-shape-fill-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-shape-fill-color');
        if (color) applyShapeFill(color);
      });
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-fill-picker').forEach(picker => {
      const handleFill = (e: Event) => {
        const color = (e.target as HTMLInputElement).value;
        applyShapeFill(color);
      };
      picker.addEventListener('input', handleFill);
      picker.addEventListener('change', handleFill);
    });

    // Text listeners
    this._container.querySelectorAll('[data-text-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-text-color');
        if (color) {
          store.updateToolSettings({ textColor: color });
          this.updateIndicators();
        }
      });
    });

    const textPicker = this._container.querySelector<HTMLInputElement>('#hover-text-color-picker');
    textPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ textColor: color });
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-font-size]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sz = parseInt(el.getAttribute('data-font-size') || '16', 10);
        store.updateToolSettings({ fontSize: sz });
        this.updateIndicators();
      });
    });

    const fontSlider = this._container.querySelector<HTMLInputElement>('#hover-font-size-slider');
    fontSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const sz = parseInt((e.target as HTMLInputElement).value || '16', 10);
      store.updateToolSettings({ fontSize: sz });
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-font-fam]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const fam = el.getAttribute('data-font-fam');
        if (fam) {
          store.updateToolSettings({ fontFamily: fam });
          this.updateIndicators();
        }
      });
    });

    // Sticky Note listeners
    this._container.querySelectorAll('[data-note-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-note-color');
        if (color) {
          store.updateToolSettings({ noteColor: color });
          this.updateIndicators();
        }
      });
    });

    const noteColorPicker = this._container.querySelector<HTMLInputElement>('#hover-note-color-picker');
    noteColorPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ noteColor: color });
      this.updateIndicators();
    });

    const noteColorHex = this._container.querySelector<HTMLInputElement>('#hover-note-color-hex');
    noteColorHex?.addEventListener('change', (e) => {
      const parsed = parseHexColor((e.target as HTMLInputElement).value);
      if (parsed) {
        store.updateToolSettings({ noteColor: parsed });
      }
      this.updateIndicators();
    });

    this._container.querySelectorAll('[data-note-textcolor]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-note-textcolor');
        if (color) {
          store.updateToolSettings({ noteTextColor: color });
          this.updateIndicators();
        }
      });
    });

    const noteTextColorPicker = this._container.querySelector<HTMLInputElement>('#hover-note-textcolor-picker');
    noteTextColorPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ noteTextColor: color });
      this.updateIndicators();
    });

    const noteFsSlider = this._container.querySelector<HTMLInputElement>('#hover-note-fontsize-slider');
    noteFsSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const sz = parseInt((e.target as HTMLInputElement).value || '24', 10);
      store.updateToolSettings({ noteFontSize: sz });
      this.updateIndicators();
    });

    const noteFsInput = this._container.querySelector<HTMLInputElement>('#hover-note-fontsize-input');
    noteFsInput?.addEventListener('change', (e) => {
      e.stopPropagation();
      const sz = clampTypedNumber((e.target as HTMLInputElement).value, 10, 96, store.toolSettings.noteFontSize || 24);
      store.updateToolSettings({ noteFontSize: Math.round(sz) });
      this.updateIndicators();
    });

    const noteAuthorInput = this._container.querySelector<HTMLInputElement>('#hover-note-author-input');
    noteAuthorInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const author = (e.target as HTMLInputElement).value;
      store.updateToolSettings({ noteAuthor: author });
      this.updateIndicators();
    });

    // Stamp listeners
    this._container.querySelectorAll('[data-stamp-choice]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const st = el.getAttribute('data-stamp-choice');
        if (st) {
          store.updateToolSettings({ stampPreset: st });
          store.setActiveTool('stamp');
          this.updateIndicators();
        }
      });
    });

    // Measure listeners
    this._container.querySelectorAll('[data-measure-unit]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const u = el.getAttribute('data-measure-unit') as any;
        if (u) {
          store.updateToolSettings({ measureUnit: u });
          this.updateIndicators();
        }
      });
    });

    // Redaction listeners
    this._container.querySelectorAll('[data-redact-color]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = el.getAttribute('data-redact-color');
        if (color) {
          store.updateToolSettings({ redactionColor: color });
          this.updateIndicators();
        }
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

    // My Colors: "+" opens a native color picker whose choice is saved to
    // the shared palette; right-click on ANY swatch removes it.
    this._container.querySelectorAll<HTMLElement>('[data-add-palette-trigger]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = btn.parentElement?.querySelector<HTMLInputElement>('[data-add-palette-input]')
          ?? btn.nextElementSibling as HTMLInputElement | null;
        if (!input) return;
        try {
          const picker = input as HTMLInputElement & { showPicker?: () => void };
          if (typeof picker.showPicker === 'function') picker.showPicker();
          else input.click();
        } catch { input.click(); }
      });
    });
    this._container.querySelectorAll<HTMLInputElement>('[data-add-palette-input]').forEach(input => {
      input.addEventListener('change', () => {
        const color = input.value;
        if (!color) return;
        const current = store.appSettings.customPalette;
        if (current.some(c => c.toLowerCase() === color.toLowerCase())) return;
        store.updateAppSettings({ customPalette: [...current, color].slice(-24) });
        this.render();
      });
    });
    this._container.querySelectorAll<HTMLElement>('[data-remove-key]').forEach(swatch => {
      swatch.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = swatch.getAttribute('data-remove-key');
        if (!key) return;
        if (key.startsWith('custom:')) {
          const color = key.slice('custom:'.length);
          store.updateAppSettings({
            customPalette: store.appSettings.customPalette.filter(c => c.toLowerCase() !== color.toLowerCase())
          });
        } else if (key.startsWith('default:')) {
          const entry = key.slice('default:'.length);
          if (entry.indexOf(':') < 0) return;
          const current = store.appSettings.removedDefaultColors;
          if (current.includes(entry)) return;
          store.updateAppSettings({ removedDefaultColors: [...current, entry] });
        } else {
          return;
        }
        this.render();
      });
    });

    this.bindDockDrag();
  }

  /** Drag-to-dock handle: dropping near a window edge persists that dock. */
  private bindDockDrag(): void {
    const handle = this._container.querySelector<HTMLElement>('.toolbar-drag-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startDock = store.appSettings.toolbarDock;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}
      const preview = (ev: PointerEvent) => {
        this._container.dataset.dock = classifyToolbarDock(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
      };
      const finish = (ev: PointerEvent | null, commit: boolean) => {
        handle.removeEventListener('pointermove', preview);
        handle.removeEventListener('pointerup', commitUp);
        handle.removeEventListener('pointercancel', cancelDrag);
        if (commit && ev) {
          const dock = classifyToolbarDock(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
          if (dock !== startDock) {
            store.updateAppSettings({ toolbarDock: dock });
            return;
          }
        }
        this._container.dataset.dock = startDock;
      };
      const commitUp = (ev: PointerEvent) => finish(ev, true);
      const cancelDrag = () => finish(null, false);
      handle.addEventListener('pointermove', preview);
      handle.addEventListener('pointerup', commitUp);
      handle.addEventListener('pointercancel', cancelDrag);
    });
  }
}
