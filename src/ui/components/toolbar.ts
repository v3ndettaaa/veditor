/**
 * Floating & Dockable Toolbar Component with Click-to-Pin Configuration Cards
 * Clicking a tool reveals its configuration card. The bar can be dragged to
 * any window edge, with a matching vertical layout on the left/right flanks.
 * In-place DOM updates ensure clicking swatches, size pills, or sliders never closes the popup!
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

  public render(): void {
    this._container.dataset.dock = store.appSettings.toolbarDock;
    // Mirrored on <body> so sibling overlays (e.g. the zoom controls) can
    // reposition themselves around a bottom-docked toolbar with pure CSS.
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

    const shapeColors = ['#ef4444', '#3b82f6', '#10b981', '#000000', '#ffffff', '#f59e0b', '#8b5cf6'];
    const shapeWidths = [1, 2, 4, 8];

    const textColors = ['#000000', '#ffffff', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    const textSizes = [12, 14, 18, 24, 32, 48];

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
            <div class="tool-hover-card">
              <span class="sub-row-label">${selectedIds.length} Selected</span>
              <button id="del-selected-btn" class="mode-toggle-btn" style="color:var(--danger);" title="Delete selected">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                Delete
              </button>
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
                  ${renderDefaultSwatches('pen', 'pen-color', 'pen-swatch', penColors, s.penColor)}
                  ${renderCustomPaletteSwatches('pen-color', 'pen-swatch', s.penColor)}
                  ${renderAddToPaletteButton(s.penColor)}
                  <div class="color-picker-wrapper" title="Custom color picker">
                    <input type="color" id="hover-pen-color-picker" class="color-picker-input" value="${s.penColor}">
                  </div>
                  <input type="text" id="hover-pen-color-hex" class="hex-type-input" value="${s.penColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color, e.g. #4f46e5" aria-label="Pen color hex">
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
                  <input type="number" id="hover-pen-width-input" class="size-readout size-type-input pen-readout"
                         min="1" max="50" step="1" value="${s.penWidth}" title="Type any width (1-50px)" aria-label="Pen width">
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Cursor</span>
                <button class="mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'pen' ? 'active' : ''}" data-drawing-cursor="pen">Pen</button>
                <button class="mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'dot' ? 'active' : ''}" data-drawing-cursor="dot">Dot</button>
                <button class="mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'circle' ? 'active' : ''}" data-drawing-cursor="circle">Circle</button>
                <button class="mode-toggle-btn cursor-toggle-btn ${s.drawingCursor === 'crosshair' ? 'active' : ''}" data-drawing-cursor="crosshair">Crosshair</button>
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
                  ${renderDefaultSwatches('highlighter', 'hl-color', 'hl-swatch', hlColors, s.highlighterColor, ' opacity:0.85;')}
                  ${renderCustomPaletteSwatches('hl-color', 'hl-swatch', s.highlighterColor)}
                  ${renderAddToPaletteButton(s.highlighterColor)}
                  <div class="color-picker-wrapper" title="Custom highlighter color">
                    <input type="color" id="hover-hl-color-picker" class="color-picker-input" value="${s.highlighterColor}">
                  </div>
                  <input type="text" id="hover-hl-color-hex" class="hex-type-input" value="${s.highlighterColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color, e.g. #fef08a" aria-label="Highlighter color hex">
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
                  <input type="number" id="hover-hl-width-input" class="size-readout size-type-input hl-readout"
                         min="2" max="100" step="1" value="${s.highlighterWidth}" title="Type any width (2-100px)" aria-label="Highlighter width">
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Snap</span>
                <button class="mode-toggle-btn hl-line-btn ${!s.highlighterStraightLine ? 'active' : ''}" data-hl-straight="false">Freehand</button>
                <button class="mode-toggle-btn hl-line-btn ${s.highlighterStraightLine ? 'active' : ''}" data-hl-straight="true">Straight (Shift)</button>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Tip</span>
                <button class="mode-toggle-btn hl-tip-btn ${s.highlighterTipShape === 'round' ? 'active' : ''}" data-hl-tip="round">Round</button>
                <button class="mode-toggle-btn hl-tip-btn ${s.highlighterTipShape === 'chisel' ? 'active' : ''}" data-hl-tip="chisel">Chisel</button>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Opacity</span>
                <div class="size-pills-group">
                  ${[0.25, 0.45, 0.7].map(op => `
                    <button class="size-pill hl-op-pill ${Math.abs((s.highlighterOpacity ?? 0.45) - op) < 0.05 ? 'active' : ''}" data-hl-opacity="${op}">${Math.round(op * 100)}%</button>
                  `).join('')}
                </div>
                <div class="size-slider-wrapper">
                  <input type="number" id="hover-hl-opacity-input" class="size-readout size-type-input hl-op-readout"
                         min="10" max="90" step="5" value="${Math.round((s.highlighterOpacity ?? 0.45) * 100)}" title="Type opacity (10-90%)" aria-label="Highlighter opacity">
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Cursor</span>
                <button class="mode-toggle-btn hl-cursor-btn ${(s.highlighterCursor || 'rectangle') === 'rectangle' ? 'active' : ''}" data-hl-cursor="rectangle">Rect</button>
                <button class="mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'chisel' ? 'active' : ''}" data-hl-cursor="chisel">Chisel</button>
                <button class="mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'circle' ? 'active' : ''}" data-hl-cursor="circle">Circle</button>
                <button class="mode-toggle-btn hl-cursor-btn ${s.highlighterCursor === 'crosshair' ? 'active' : ''}" data-hl-cursor="crosshair">Cross</button>
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
                  <input type="number" id="hover-eraser-width-input" class="size-readout size-type-input eraser-readout"
                         min="4" max="120" step="1" value="${s.eraserWidth}" title="Type any width (4-120px)" aria-label="Eraser width">
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

          <!-- Polygon with Hover Card -->
          <div class="tool-btn-wrapper ${this._pinnedTool === 'polygon' ? 'is-pinned' : ''}" data-wrapper-tool="polygon">
            <button class="tool-btn ${activeTool === 'polygon' ? 'active' : ''}" data-tool="polygon" title="Custom Multi-Point Polygon (G)">
              ${getIconSvg('polygon')}
              <span class="tool-color-dot shape-dot" style="background-color:${s.shapeColor};"></span>
            </button>
            <div class="tool-hover-card">
              ${this.renderShapeHoverCard(s, 'polygon')}
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
                  ${renderDefaultSwatches('text', 'text-color', 'text-swatch', textColors, s.textColor)}
                  ${renderCustomPaletteSwatches('text-color', 'text-swatch', s.textColor)}
                  ${renderAddToPaletteButton(s.textColor)}
                  <div class="color-picker-wrapper" title="Custom text color">
                    <input type="color" id="hover-text-color-picker" class="color-picker-input" value="${s.textColor}">
                  </div>
                  <input type="text" id="hover-text-color-hex" class="hex-type-input" value="${s.textColor}"
                         spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Text color hex">
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
                <div class="size-slider-wrapper">
                  <input type="number" id="hover-font-size-input" class="size-readout size-type-input"
                         min="6" max="144" step="1" value="${s.fontSize}" title="Type any size (6-144px)" aria-label="Font size">
                </div>
              </div>

              <div class="sub-row-separator"></div>

              <div class="sub-row-section">
                <span class="sub-row-label">Font</span>
                <button class="mode-toggle-btn font-fam-btn ${(s.fontFamily || 'Inter').includes('Inter') ? 'active' : ''}" data-font-fam="Inter">Inter</button>
                <button class="mode-toggle-btn font-fam-btn ${(s.fontFamily || '').includes('Vazirmatn') ? 'active' : ''}" data-font-fam="Vazirmatn">وزیرمتن</button>
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
                ${['APPROVED', 'CONFIDENTIAL', 'DRAFT', 'SIGN_HERE', 'PAID', 'VOID'].map(st => `
                  <button class="mode-toggle-btn ${(s.stampPreset || 'APPROVED') === st ? 'active' : ''}" data-stamp-choice="${st}">${st.replace('_', ' ')}</button>
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
              <button class="mode-toggle-btn ${(s.redactionColor || '#000000') === '#000000' ? 'active' : ''}" data-redact-color="#000000">Blackout</button>
              <button class="mode-toggle-btn ${(s.redactionColor || '#000000') === '#ffffff' ? 'active' : ''}" data-redact-color="#ffffff">Whiteout</button>
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
  }

  /**
   * Reorders / hides toolbar buttons per the user's saved layout WITHOUT
   * re-templating: elements (and their bound listeners) are moved in place
   * and family separators rebuilt. Hidden tools are simply left out (they
   * live only in Settings → Toolbar), so nothing here ever mutates the layout.
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

    // Clear the row except the undo group: emptied template shells and
    // separators go, and hidden tools are left out entirely (they live only
    // in Settings → Toolbar). byId keeps references to every tool element
    // (with listeners intact), so removal here is safe.
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

    // 1. Pen Indicators
    const penDot = this._container.querySelector<HTMLElement>('.pen-dot');
    if (penDot) penDot.style.backgroundColor = s.penColor;

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

    this._container.querySelectorAll<HTMLInputElement>('.hex-type-input#hover-pen-color-hex').forEach(el => {
      if (document.activeElement !== el && el.value !== s.penColor) el.value = s.penColor;
    });

    this._container.querySelectorAll('[data-drawing-cursor]').forEach(el => {
      const cur = el.getAttribute('data-drawing-cursor');
      el.classList.toggle('active', cur === (s.drawingCursor || 'pen'));
    });

    // 2. Highlighter Indicators
    const hlDot = this._container.querySelector<HTMLElement>('.hl-dot');
    if (hlDot) {
      hlDot.style.backgroundColor = s.highlighterColor;
      hlDot.style.opacity = String(s.highlighterOpacity ?? 0.45);
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

    const hlHex = this._container.querySelector<HTMLInputElement>('#hover-hl-color-hex');
    if (hlHex && document.activeElement !== hlHex && hlHex.value !== s.highlighterColor) hlHex.value = s.highlighterColor;

    this._container.querySelectorAll('[data-hl-straight]').forEach(el => {
      const isStr = el.getAttribute('data-hl-straight') === 'true';
      el.classList.toggle('active', isStr === !!s.highlighterStraightLine);
    });

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
      hlOpReadout.value = String(Math.round((s.highlighterOpacity ?? 0.45) * 100));
    }

    this._container.querySelectorAll('[data-hl-cursor]').forEach(el => {
      const cur = el.getAttribute('data-hl-cursor');
      el.classList.toggle('active', cur === (s.highlighterCursor || 'rectangle'));
    });

    // 4. Eraser Indicators
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

    // 4. Shape Indicators across all 5 shape cards
    const shapeDot = this._container.querySelector<HTMLElement>('.shape-dot');
    if (shapeDot) shapeDot.style.backgroundColor = s.shapeColor;

    this._container.querySelectorAll('[data-shape-color]').forEach(el => {
      const c = el.getAttribute('data-shape-color');
      el.classList.toggle('active', !!c && c.toLowerCase() === s.shapeColor.toLowerCase());
    });

    this._container.querySelectorAll<HTMLInputElement>('.shape-color-picker').forEach(picker => {
      if (picker.value !== s.shapeColor) picker.value = s.shapeColor;
    });

    this._container.querySelectorAll('[data-shape-width]').forEach(el => {
      const w = parseInt(el.getAttribute('data-shape-width') || '0', 10);
      el.classList.toggle('active', w === s.shapeWidth);
    });

    this._container.querySelectorAll('[data-shape-style]').forEach(el => {
      const st = el.getAttribute('data-shape-style');
      el.classList.toggle('active', st === s.shapeStyle);
    });

    this._container.querySelectorAll('[data-shape-outline]').forEach(el => {
      const on = el.getAttribute('data-shape-outline') === 'on';
      el.classList.toggle('active', on === (s.shapeOutline !== false));
    });

    // Per-tool precision pills. `setToolOption` does not change any of the
    // keys `onStoreUpdate` watches, so this path — not a re-render — is what
    // has to show the new state.
    this._container.querySelectorAll<HTMLElement>('[data-shape-opt]').forEach(el => {
      const key = el.getAttribute('data-shape-opt') as ToolOptionKey | null;
      const tool = el.closest<HTMLElement>('[data-wrapper-tool]')?.dataset.wrapperTool as ToolType | undefined;
      if (!key || !tool) return;
      el.classList.toggle('active', store.toolOption(tool, key));
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

    // 5. Text Indicators
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

    this._container.querySelectorAll('[data-font-size]').forEach(el => {
      const sz = parseInt(el.getAttribute('data-font-size') || '0', 10);
      el.classList.toggle('active', sz === s.fontSize);
    });

    this._container.querySelectorAll('[data-font-fam]').forEach(el => {
      const fam = el.getAttribute('data-font-fam');
      const activeFam = s.fontFamily || 'Inter';
      el.classList.toggle('active', fam ? activeFam.includes(fam) : false);
    });

    // 6. Stamp Indicators
    this._container.querySelectorAll('[data-stamp-choice]').forEach(el => {
      const st = el.getAttribute('data-stamp-choice');
      el.classList.toggle('active', st === (s.stampPreset || 'APPROVED'));
    });

    // 7. Measure Indicators
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

  private renderShapeHoverCard(s: typeof store.toolSettings, shapeType: string): string {
    const shapeColors = ['#ef4444', '#3b82f6', '#10b981', '#000000', '#ffffff', '#f59e0b', '#8b5cf6'];
    const strokeWidths = [1, 2, 4, 8];

    return `
      <div class="sub-row-section">
        <span class="sub-row-label">Stroke</span>
        <div class="color-swatches-group">
          ${renderDefaultSwatches('shape', 'shape-color', 'shape-swatch', shapeColors, s.shapeColor)}
          ${renderCustomPaletteSwatches('shape-color', 'shape-swatch', s.shapeColor)}
          ${renderAddToPaletteButton(s.shapeColor)}
          <div class="color-picker-wrapper" title="Custom stroke color">
            <input type="color" class="color-picker-input shape-color-picker" value="${s.shapeColor}">
          </div>
          <input type="text" class="hex-type-input shape-stroke-hex" value="${s.shapeColor}"
                 spellcheck="false" maxlength="7" title="Type any hex color" aria-label="Shape stroke color hex">
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
        <div class="size-slider-wrapper">
          <input type="number" class="size-readout size-type-input shape-width-input"
                 min="0.5" max="40" step="0.5" value="${s.shapeWidth}" title="Type any width (0.5-40px)" aria-label="Shape stroke width">
        </div>
      </div>

      <div class="sub-row-separator"></div>

      <div class="sub-row-section">
        <span class="sub-row-label">Style</span>
        <button class="mode-toggle-btn ${s.shapeStyle === 'solid' ? 'active' : ''}" data-shape-style="solid">Solid</button>
        <button class="mode-toggle-btn ${s.shapeStyle === 'dashed' ? 'active' : ''}" data-shape-style="dashed">Dashed</button>
        <button class="mode-toggle-btn ${s.shapeStyle === 'dotted' ? 'active' : ''}" data-shape-style="dotted">Dotted</button>
      </div>

      ${shapeType === 'rectangle' || shapeType === 'ellipse' || shapeType === 'polygon' ? `
        <div class="sub-row-separator"></div>
        <div class="sub-row-section">
          <span class="sub-row-label">Outline</span>
          <button class="mode-toggle-btn ${(s.shapeOutline ?? true) ? 'active' : ''}" data-shape-outline="on" title="Stroke the shape border">On</button>
          <button class="mode-toggle-btn ${(s.shapeOutline ?? true) ? '' : 'active'}" data-shape-outline="off" title="Fill only, no border">Off</button>
        </div>
      ` : ''}

      ${shapeType === 'rectangle' || shapeType === 'ellipse' || shapeType === 'polygon' ? `
        <div class="sub-row-separator"></div>
        <div class="sub-row-section">
          <span class="sub-row-label">Fill</span>
          <div class="color-swatches-group">
            <button class="mode-toggle-btn ${s.shapeFillColor === 'transparent' ? 'active' : ''}" data-shape-fill="transparent" title="No Fill">None</button>
            ${renderDefaultSwatches('shape-fill', 'shape-fill-color', 'shape-fill-swatch', shapeColors, s.shapeFillColor)}
            ${renderCustomPaletteSwatches('shape-fill-color', 'shape-fill-swatch', s.shapeFillColor)}
            ${renderAddToPaletteButton(s.shapeFillColor === 'transparent' ? '#ffffff' : s.shapeFillColor)}
            <div class="color-picker-wrapper" title="Custom Fill Color">
              <input type="color" class="color-picker-input shape-fill-picker" value="${s.shapeFillColor === 'transparent' ? '#ffffff' : s.shapeFillColor}">
            </div>
            <input type="text" class="hex-type-input shape-fill-hex" value="${s.shapeFillColor === 'transparent' ? '' : s.shapeFillColor}"
                   spellcheck="false" maxlength="7" placeholder="None" title="Type any hex fill color, empty = none" aria-label="Shape fill color hex">
          </div>
        </div>
      ` : ''}

      ${SEGMENT_TOOLS.includes(shapeType as ToolType) ? `
        <div class="sub-row-separator"></div>
        <div class="sub-row-section">
          <span class="sub-row-label">Precision</span>
          <button class="mode-toggle-btn shape-opt-btn ${store.toolOption(shapeType as ToolType, 'snapAngle15') ? 'active' : ''}"
                  data-shape-opt="snapAngle15" title="Constrain this tool's segments to 15° increments (Shift always does)">Snap 15°</button>
          <button class="mode-toggle-btn shape-opt-btn ${store.toolOption(shapeType as ToolType, 'connectLines') ? 'active' : ''}"
                  data-shape-opt="connectLines" title="Merge this line with a coincident endpoint into one continuous path">Connect lines</button>
        </div>
      ` : ''}
    `;
  }

  private bindEvents(s: typeof store.toolSettings) {
    // Tool buttons click & toggle pin (arrangement lives in Settings → Toolbar)
    this._container.querySelectorAll<HTMLElement>('.tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
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

    this._container.querySelectorAll('[data-hl-straight]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const isStraight = el.getAttribute('data-hl-straight') === 'true';
        store.updateToolSettings({ highlighterStraightLine: isStraight });
        this.updateIndicators();
      });
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

    // Free-typed numeric + hex inputs (Enter/blur commits, Escape reverts).
    // Commits skip no-op values so tabbing through never spams store notifies.
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
        // 'change' covers spinner arrows + picker-like commits; blur covers typing.
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
        store.updateToolSettings({ shapeWidth: w });
        this.updateIndicators();
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
    bindHex('.shape-stroke-hex', () => store.toolSettings.shapeColor, (hex) => store.updateToolSettings({ shapeColor: hex }));
    // Fill allows empty (= None / transparent).
    bindTyped('.shape-fill-hex', (el) => {
      const raw = el.value.trim();
      if (raw === '') {
        if (store.toolSettings.shapeFillColor !== 'transparent') {
          store.updateToolSettings({ shapeFillColor: 'transparent' });
          this.updateIndicators();
        }
        el.value = '';
        return;
      }
      const parsed = parseHexColor(raw);
      const current = store.toolSettings.shapeFillColor;
      if (parsed && parsed !== current.toLowerCase()) {
        store.updateToolSettings({ shapeFillColor: parsed });
        this.updateIndicators();
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
        const w = parseInt(el.getAttribute('data-shape-width') || '2', 10);
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

    this._container.querySelectorAll('[data-shape-outline]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        applyShapeOutline(el.getAttribute('data-shape-outline') === 'on');
      });
    });

    // Per-tool precision options (Snap-15° / Connect-lines). The hover-card
    // belongs to one tool, so the option is written for whichever segment tool
    // rendered this card.
    this._container.querySelectorAll('[data-shape-opt]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = el.getAttribute('data-shape-opt') as ToolOptionKey | null;
        const wrapper = el.closest<HTMLElement>('[data-wrapper-tool]');
        const tool = wrapper?.dataset.wrapperTool as ToolType | undefined;
        if (!key || !tool) return;
        store.setToolOption(tool, key, !store.toolOption(tool, key));
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
    // the shared palette; right-click on ANY swatch removes it (a default
    // hides only from its own picker group, a custom leaves the palette).
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
      // 'change' (not 'input') commits once the picker closes, so the
      // re-render can't tear the native dialog down mid-drag.
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
