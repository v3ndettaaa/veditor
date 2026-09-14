/**
 * Advanced Settings & Preferences Modal Component
 * Features an intuitive icon-driven tabbed interface for Appearance, Toolbar,
 * Pen & Stylus Input (Pressure sensitivity, curves, mouse velocity),
 * Viewer & Reading, Performance, Storage, Localization, and About with GitHub link.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { ThemeMode, LanguageMode, BackgroundPattern, ToolType } from '../../core/types';
import { pdfEngine } from '../../core/pdf-engine';
import { viewportManager } from '../../core/viewport';
import { clearAllStorage } from '../../io/storage';
import { DEFAULT_ACCENT } from '../theme';
import { TOOL_SHORT_LABELS } from './toolbar';

type SettingsTab = 'appearance' | 'toolbar' | 'input' | 'viewer' | 'performance' | 'storage' | 'language' | 'about';

/** Toolbar tool id → icon name, mirroring the toolbar template. */
const TOOLBAR_ICONS: Record<string, string> = {
  select: 'select',
  hand: 'hand',
  'zoom-lens': 'zoomIn',
  pen: 'pen',
  highlighter: 'highlighter',
  eraser: 'eraser',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  polygon: 'polygon',
  text: 'text',
  stamp: 'stamp',
  'measure-distance': 'measure',
  callout: 'callout',
  signature: 'signature',
  redaction: 'redaction',
  laser: 'laser'
};

export class SettingsModalComponent {
  private _container: HTMLElement;
  private _activeTab: SettingsTab = 'appearance';
  private _lastRenderKey: string | null = null;
  private _renderedLanguage: string | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
  }

  private computeRenderKey(): string {
    const app = store.appSettings;
    const tools = store.toolSettings;
    return JSON.stringify({
      tab: this._activeTab,
      app,
      toolbar: store.toolbarLayout,
      pressureSensitivityEnabled: tools.pressureSensitivityEnabled,
      mousePressureSimulation: tools.mousePressureSimulation,
      pressureCurve: tools.pressureCurve,
      pressureStrength: tools.pressureStrength,
      strokeSmoothing: tools.strokeSmoothing,
      palmRejectionEnabled: tools.palmRejectionEnabled,
      stylusInvertedEraserEnabled: tools.stylusInvertedEraserEnabled,
      drawingCursor: tools.drawingCursor,
    });
  }

  /**
   * Instant tab switch with NO overlay rebuild. The overlay/dialog carry open
   * animations (`fadeIn`/`scaleUp`); recreating them restarts the animation
   * and reads as close-then-open flicker. Only the nav highlight + content
   * pane are swapped.
   */
  private switchTab(tab: SettingsTab): void {
    if (tab === this._activeTab) return;
    try {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch (_) {}
    this._activeTab = tab;
    this._lastRenderKey = this.computeRenderKey();

    this._container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    const content = this._container.querySelector('.settings-content');
    if (content) {
      content.innerHTML = this.renderTabContent(store.appSettings, store.toolSettings);
      content.scrollTop = 0;
    }
    this.bindContentEvents();
  }

  public render(): void {
    if (!store.settingsModalOpen) {
      this._container.innerHTML = '';
      this._lastRenderKey = null;
      this._renderedLanguage = null;
      return;
    }

    // One-shot jump request (e.g. command palette → Toolbar tab).
    if (store.settingsTabRequest) {
      const req = store.settingsTabRequest;
      store.settingsTabRequest = null;
      const tabs: string[] = ['appearance', 'toolbar', 'input', 'viewer', 'performance', 'storage', 'language', 'about'];
      if (tabs.includes(req)) this._activeTab = req as SettingsTab;
    }

    // Avoid rebuilding the whole dialog on unrelated store changes (document
    // tab switches, zoom, page scroll, drawing). A full innerHTML rebuild
    // loses scroll position/focus and looks like the panel is loading again —
    // and it destroys color inputs mid-drag while picking a custom color.
    const app = store.appSettings;
    const tools = store.toolSettings;
    const renderKey = this.computeRenderKey();
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') {
      return;
    }
    const activeEl = document.activeElement as HTMLElement | null;
    const userIsEditing = !!activeEl && this._container.contains(activeEl) &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName);
    if (userIsEditing && this._container.innerHTML !== '') {
      // Defer: the change the user is making will trigger another render
      // once focus leaves; rebuilding now would tear down the control.
      return;
    }

    // Targeted refresh when the dialog is already open: leave the overlay +
    // nav shell untouched (no animation restart, no focus loss) and only swap
    // the content pane. Full rebuilds happen on first open or language change
    // (header/nav labels are localized).
    const overlayExists = !!this._container.querySelector('#settings-overlay');
    if (overlayExists && this._renderedLanguage === app.language) {
      this._lastRenderKey = renderKey;
      const content = this._container.querySelector('.settings-content');
      const prevScroll = content?.scrollTop ?? 0;
      this._container.querySelectorAll('[data-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === this._activeTab);
      });
      if (content) {
        content.innerHTML = this.renderTabContent(app, tools);
        content.scrollTop = prevScroll;
      }
      this.bindContentEvents();
      return;
    }

    this._lastRenderKey = renderKey;
    this._renderedLanguage = app.language;
    const prevScroll = this._container.querySelector('.settings-content')?.scrollTop ?? 0;

    this._container.innerHTML = `
      <div class="modal-overlay" id="settings-overlay">
        <div class="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-label="${t('settings.title')}">
          <!-- Header -->
          <div class="panel-header settings-header">
            <div class="panel-header-title">
              ${getIconSvg('settings', 18)}
              <span>${t('settings.title')}</span>
            </div>
            <button id="close-settings-btn" class="icon-btn" title="Close" aria-label="Close settings">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <!-- Body with Tabs -->
          <div class="settings-body">
            <!-- Left Tab Navigation -->
            <nav class="settings-nav" aria-label="Settings sections">
              <button class="settings-tab-btn ${this._activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                ${getIconSvg('palette', 15)}
                <span>Appearance</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'toolbar' ? 'active' : ''}" data-tab="toolbar">
                ${getIconSvg('sliders', 15)}
                <span>Toolbar</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'input' ? 'active' : ''}" data-tab="input">
                ${getIconSvg('pen', 15)}
                <span>Pen & Input</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'viewer' ? 'active' : ''}" data-tab="viewer">
                ${getIconSvg('eye', 15)}
                <span>Viewer & Reading</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'performance' ? 'active' : ''}" data-tab="performance">
                ${getIconSvg('zap', 15)}
                <span>Performance</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'storage' ? 'active' : ''}" data-tab="storage">
                ${getIconSvg('database', 15)}
                <span>Storage & Backup</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'language' ? 'active' : ''}" data-tab="language">
                ${getIconSvg('globe', 15)}
                <span>Language</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'about' ? 'active' : ''}" data-tab="about">
                ${getIconSvg('info', 15)}
                <span>About</span>
              </button>
            </nav>

            <!-- Right Content Area -->
            <div class="settings-content">
              ${this.renderTabContent(app, tools)}
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    const content = this._container.querySelector('.settings-content');
    if (content && prevScroll > 0) content.scrollTop = prevScroll;
  }

  private renderTabContent(app: typeof store.appSettings, tools: typeof store.toolSettings): string {
    if (this._activeTab === 'appearance') {
      const accents = [
        { name: 'Indigo', color: DEFAULT_ACCENT },
        { name: 'Purple', color: '#8b5cf6' },
        { name: 'Emerald', color: '#10b981' },
        { name: 'Rose', color: '#f43f5e' },
        { name: 'Amber', color: '#f59e0b' },
        { name: 'Cyan', color: '#06b6d4' },
        { name: 'Blue', color: '#2563eb' },
        { name: 'Crimson', color: '#dc2626' }
      ];

      return `
        <div class="settings-stack">
          <div class="settings-section-header">Theme & Visual Styling</div>

          <!-- Theme -->
          <div class="prop-group">
            <span class="prop-label has-icon">
              ${getIconSvg('sun', 14)}
              <span>Theme Mode</span>
            </span>
            <div class="settings-grid">
              <button class="secondary-btn ${app.theme === 'dark' ? 'is-selected' : ''}" data-set-theme="dark">
                ${getIconSvg('moon', 15)}
                <span>Dark Mode</span>
              </button>
              <button class="secondary-btn ${app.theme === 'light' ? 'is-selected' : ''}" data-set-theme="light">
                ${getIconSvg('sun', 15)}
                <span>Light Mode</span>
              </button>
            </div>
          </div>

          <!-- Accent Color -->
          <div class="prop-group">
            <span class="prop-label">Accent Brand Color</span>
            <div class="chip-row">
              ${accents.map(a => `
                <button type="button"
                        class="color-swatch is-square ${(app.accentColor || DEFAULT_ACCENT).toLowerCase() === a.color.toLowerCase() ? 'active' : ''}"
                        style="background-color:${a.color};" data-set-accent="${a.color}"
                        title="${a.name}" aria-label="${a.name}"
                        aria-pressed="${(app.accentColor || DEFAULT_ACCENT).toLowerCase() === a.color.toLowerCase()}"></button>
              `).join('')}
              <div class="accent-custom">
                <div class="color-picker-wrapper is-lg" title="Custom Accent Color">
                  <input type="color" id="custom-accent-picker" class="color-picker-input" value="${app.accentColor || DEFAULT_ACCENT}">
                </div>
                <span>Custom</span>
              </div>
            </div>
          </div>

          <div class="settings-section-header">Canvas Paper Settings</div>

          <!-- Background Paper Pattern -->
          <div class="prop-group">
            <span class="prop-label">Paper Background Pattern</span>
            <select id="pattern-select" class="field">
              <option value="none" ${app.backgroundPattern === 'none' ? 'selected' : ''}>Blank (Standard PDF Canvas)</option>
              <option value="grid" ${app.backgroundPattern === 'grid' ? 'selected' : ''}>Square Grid (Math & Technical)</option>
              <option value="dots" ${app.backgroundPattern === 'dots' ? 'selected' : ''}>Dot Grid (Bullet Journal)</option>
              <option value="lined" ${app.backgroundPattern === 'lined' ? 'selected' : ''}>Lined Paper (Notes & Ruled)</option>
              <option value="isometric" ${app.backgroundPattern === 'isometric' ? 'selected' : ''}>Isometric Grid (3D Drafting)</option>
            </select>
          </div>

          <!-- UI Density -->
          <div class="prop-group">
            <span class="prop-label">Interface Layout Density</span>
            <div class="settings-grid">
              <button class="secondary-btn ${app.uiDensity !== 'compact' ? 'is-selected' : ''}" data-set-density="comfortable">
                Comfortable
              </button>
              <button class="secondary-btn ${app.uiDensity === 'compact' ? 'is-selected' : ''}" data-set-density="compact">
                Compact
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'toolbar') {
      const layout = store.toolbarLayout;
      return `
        <div class="settings-stack">
          <div class="settings-section-header">Toolbar Buttons</div>
          <div class="settings-callout">
            <span class="settings-callout-icon">${getIconSvg('info', 15)}</span>
            <span>Tick a tool to show it in the bar, untick to hide it. Use the arrows to move it left or right.</span>
          </div>
          <div class="panel-stack" id="toolbar-list">
            ${layout.map((item, idx) => `
              <div class="list-card ${item.visible ? '' : 'is-dimmed'}" data-toolbar-row="${item.id}">
                <label class="setting-switch" title="Show in toolbar">
                  <input type="checkbox" data-toolbar-visible="${item.id}" ${item.visible ? 'checked' : ''}>
                  <span class="setting-slider"></span>
                </label>
                <span class="list-card-icon">${getIconSvg(TOOLBAR_ICONS[item.id] ?? 'pen', 15)}</span>
                <span class="list-card-title" style="flex:1; min-width:0;">${TOOL_SHORT_LABELS[item.id] ?? item.id}</span>
                <button class="icon-btn is-small" data-toolbar-up="${item.id}" title="Move up (toward bar start)"
                        ${idx === 0 ? 'disabled style="opacity:0.35; cursor:default;"' : ''}>
                  <span aria-hidden="true" style="font-size:14px; font-weight:700;">↑</span>
                </button>
                <button class="icon-btn is-small" data-toolbar-down="${item.id}" title="Move down (toward bar end)"
                        ${idx === layout.length - 1 ? 'disabled style="opacity:0.35; cursor:default;"' : ''}>
                  <span aria-hidden="true" style="font-size:14px; font-weight:700;">↓</span>
                </button>
              </div>
            `).join('')}
          </div>
          <div class="panel-stack">
            <button id="toolbar-layout-reset-btn" class="secondary-btn is-block">
              ${getIconSvg('rotate', 14)}
              <span>Reset Toolbar to Defaults</span>
            </button>
          </div>
          <div style="font-size:11px; color:var(--text-muted); text-align:center;">Toolbar settings • b9</div>
        </div>
      `;
    }

    if (this._activeTab === 'input') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">Pressure Sensitivity & Dynamics</div>

          <!-- Master Pressure Sensitivity Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Dynamic Pressure Sensitivity</div>
              <div class="setting-desc">Vary stroke thickness dynamically with stylus or pointer pressure. When disabled, pen strokes render at fixed, uniform width.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pressure-master-toggle" ${tools.pressureSensitivityEnabled !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Mouse & Pointer Speed Pressure Simulation -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Simulate Pressure with Pointer Speed</div>
              <div class="setting-desc">Dynamically simulate natural pressure variations using cursor speed when drawing with a mouse or trackpad.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="mouse-pressure-toggle" ${tools.mousePressureSimulation ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Stylus Pressure Calibration Curve -->
          <div class="prop-group">
            <span class="prop-label">Pressure Response Curve</span>
            <select id="curve-select" class="field">
              <option value="linear" ${tools.pressureCurve === 'linear' ? 'selected' : ''}>Linear (Standard 1:1 Response)</option>
              <option value="soft" ${tools.pressureCurve === 'soft' ? 'selected' : ''}>Soft (High Sensitivity for Light Touch)</option>
              <option value="firm" ${tools.pressureCurve === 'firm' ? 'selected' : ''}>Firm (Calligraphy & Heavy Physical Pressure)</option>
              <option value="exponential" ${tools.pressureCurve === 'exponential' ? 'selected' : ''}>Exponential (High Dynamic Contrast)</option>
            </select>
          </div>

          <!-- Pressure Dynamic Range Factor -->
          <div class="prop-group">
            <span class="prop-label">Pressure Dynamic Thickness Range</span>
            <select id="pressure-strength-select" class="field">
              <option value="light" ${tools.pressureStrength === 'light' ? 'selected' : ''}>Subtle (0.6x - 1.4x Base Width)</option>
              <option value="balanced" ${tools.pressureStrength === 'balanced' || !tools.pressureStrength ? 'selected' : ''}>Balanced (0.3x - 1.8x Base Width - Recommended)</option>
              <option value="strong" ${tools.pressureStrength === 'strong' ? 'selected' : ''}>Dramatic (0.1x - 2.4x Base Width)</option>
            </select>
          </div>

          <div class="settings-section-header">Stroke Smoothing & Hardware Handling</div>

          <!-- Stroke Smoothing -->
          <div class="prop-group">
            <span class="prop-label">Stroke Smoothing & Stabilization</span>
            <select id="smoothing-select" class="field">
              <option value="none" ${tools.strokeSmoothing === 'none' ? 'selected' : ''}>None (Direct Hardware Input)</option>
              <option value="subtle" ${tools.strokeSmoothing === 'subtle' ? 'selected' : ''}>Subtle (Low Latency)</option>
              <option value="medium" ${tools.strokeSmoothing === 'medium' || !tools.strokeSmoothing ? 'selected' : ''}>Medium (Catmull-Rom Centripetal Spline)</option>
              <option value="high" ${tools.strokeSmoothing === 'high' ? 'selected' : ''}>High (Cinematic Streamline Stabilization)</option>
            </select>
          </div>

          <!-- Intelligent Palm Rejection -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Intelligent Palm Rejection</div>
              <div class="setting-desc">Filters out accidental wrist and palm touches while drawing with an active stylus.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="palm-toggle" ${tools.palmRejectionEnabled ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Stylus Inverted Tip Auto-Eraser -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Stylus Inverted Tip Auto-Eraser</div>
              <div class="setting-desc">Automatically activates the eraser tool when the physical eraser tail of the stylus touches the glass.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="inverted-eraser-toggle" ${tools.stylusInvertedEraserEnabled !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Drawing Cursor Style -->
          <div class="prop-group">
            <span class="prop-label">Drawing Cursor Style</span>
            <div class="settings-grid is-quad">
              <button class="secondary-btn ${(tools.drawingCursor || 'pen') === 'pen' ? 'is-selected' : ''}" data-set-cursor="pen">
                Pen
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'dot' ? 'is-selected' : ''}" data-set-cursor="dot">
                Dot
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'circle' ? 'is-selected' : ''}" data-set-cursor="circle">
                Circle
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'crosshair' ? 'is-selected' : ''}" data-set-cursor="crosshair">
                Crosshair
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'viewer') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">Default Document View & Navigation</div>

          <!-- Default View Mode -->
          <div class="prop-group">
            <span class="prop-label">Default Page View Layout</span>
            <select id="view-mode-select" class="field">
              <option value="continuous" ${app.defaultViewMode === 'continuous' ? 'selected' : ''}>Continuous Vertical Scroll (Seamless)</option>
              <option value="single" ${app.defaultViewMode === 'single' ? 'selected' : ''}>Single Page View</option>
              <option value="two-page" ${app.defaultViewMode === 'two-page' ? 'selected' : ''}>Two-Page Facing Spread (Book Mode)</option>
            </select>
          </div>

          <!-- Default Zoom Preset -->
          <div class="prop-group">
            <span class="prop-label">Default Zoom Level</span>
            <select id="zoom-preset-select" class="field">
              <option value="fitWidth" ${app.defaultZoomMode === 'fitWidth' ? 'selected' : ''}>Fit to Width (Recommended for Laptops & Desktops)</option>
              <option value="fitPage" ${app.defaultZoomMode === 'fitPage' ? 'selected' : ''}>Fit Whole Page (Recommended for Tablets)</option>
              <option value="100%" ${app.defaultZoomMode === '100%' ? 'selected' : ''}>100% Native Resolution</option>
              <option value="125%" ${app.defaultZoomMode === '125%' ? 'selected' : ''}>125% Comfortable Readability</option>
              <option value="150%" ${app.defaultZoomMode === '150%' ? 'selected' : ''}>150% High Magnification</option>
            </select>
          </div>

          <div class="settings-section-header">Reading Comfort & Visuals</div>

          <!-- Page Shadows Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Realistic Page Drop Shadows</div>
              <div class="setting-desc">Renders smooth depth shadows around each page sheet.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="shadows-toggle" ${app.showPageShadows !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Smooth Scroll Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Smooth Scrolling Dynamics</div>
              <div class="setting-desc">Enables fluid interpolated scrolling when jumping across pages.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="smooth-scroll-toggle" ${app.smoothScroll !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'performance') {
      return `
        <div class="settings-stack">
          <div class="settings-callout is-accent">
            <span class="settings-callout-icon">${getIconSvg('zap', 15)}</span>
            <span><strong>Extreme efficiency engine active.</strong> Canvases outside the active viewport are automatically recycled and sized to 1x1, reclaiming gigabytes of uncompressed GPU memory when viewing 100+ page books.</span>
          </div>

          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">Target Render DPI</div>
              <div class="setting-desc">Backing-store resolution for canvas rendering (72–600). Higher values keep vector text sharper at the cost of memory. 72 = 1x; the system default matches your display density.</div>
            </div>
            <input type="number" id="target-dpi-input" class="field is-compact"
                   value="${app.targetDPI ?? ''}" min="72" max="600" step="1"
                   placeholder="System" title="Target render DPI (72–600)"
                   style="width:88px;" aria-label="Target render DPI">
          </div>

          <!-- Preload buffer -->
          <div class="prop-group">
            <span class="prop-label">Off-screen Page Preload Buffer</span>
            <select id="preload-select" class="field">
              <option value="1" ${app.maxRenderBufferPages === 1 ? 'selected' : ''}>1 Page Ahead (Ultra-Low Memory Usage)</option>
              <option value="3" ${app.maxRenderBufferPages === 3 || !app.maxRenderBufferPages ? 'selected' : ''}>3 Pages Ahead (Balanced - Recommended)</option>
              <option value="5" ${app.maxRenderBufferPages === 5 ? 'selected' : ''}>5 Pages Ahead (Aggressive Preloading for Fast Flipping)</option>
            </select>
          </div>

          <div class="prop-group">
            <button id="flush-cache-btn" class="secondary-btn is-block">
              ${getIconSvg('trash', 14)}
              <span>Flush Render Cache & Force VRAM Reclaim</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'storage') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">IndexedDB Local Persistence</div>

          <!-- Auto-Save Frequency -->
          <div class="prop-group">
            <span class="prop-label">Auto-Save Annotations Frequency</span>
            <select id="autosave-select" class="field">
              <option value="5000" ${app.autoSaveIntervalMs === 5000 ? 'selected' : ''}>Every 5 seconds</option>
              <option value="15000" ${app.autoSaveIntervalMs === 15000 || !app.autoSaveIntervalMs ? 'selected' : ''}>Every 15 seconds (Recommended)</option>
              <option value="30000" ${app.autoSaveIntervalMs === 30000 ? 'selected' : ''}>Every 30 seconds</option>
              <option value="60000" ${app.autoSaveIntervalMs === 60000 ? 'selected' : ''}>Every 1 minute</option>
            </select>
          </div>

          <div class="settings-callout">
            <span class="settings-callout-icon">${getIconSvg('shieldCheck', 15)}</span>
            <span><strong>Offline storage guarantee.</strong> All PDF documents, markups, layers, signatures, and preferences are stored exclusively on your local machine in browser IndexedDB. Zero cloud uploads, zero tracking.</span>
          </div>

          <div class="settings-section-header">Reset & Recovery</div>

          <div class="panel-stack">
            <button id="reset-settings-btn" class="secondary-btn is-block">
              ${getIconSvg('rotate', 14)}
              <span>Reset All Settings to Defaults</span>
            </button>

            <button id="clear-local-db-btn" class="danger-btn is-block">
              ${getIconSvg('trash', 14)}
              <span>Clear Recent Documents & Annotation Cache</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'language') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">Interface Language & Directionality</div>

          <div class="settings-grid">
            <button class="secondary-btn lang-card ${app.language === 'en' ? 'is-selected' : ''}" data-set-lang="en">
              <span class="lang-card-name">English</span>
              <span class="lang-card-desc">Left-to-Right (LTR) • Inter</span>
            </button>
            <button class="secondary-btn lang-card is-fa ${app.language === 'fa' ? 'is-selected' : ''}" data-set-lang="fa">
              <span class="lang-card-name">فارسی</span>
              <span class="lang-card-desc">راست‌چین کامل (RTL) • وزیرمتن</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'about') {
      return `
        <div class="about-pane">
          <div class="about-mark">
            ${getIconSvg('pen', 28)}
          </div>
          <div>
            <div class="about-name">veditor</div>
            <div class="about-version">Version 1.0.0 • Manifest V3 &amp; WebExtensions</div>
          </div>

          <p class="about-blurb">
            Ultra-fast, professional offline PDF annotator and document editor. Engineered for high
            performance, sub-millisecond drawing latency, and complete local privacy.
          </p>

          <!-- Official GitHub Link -->
          <a href="https://github.com/v3ndettaaa/veditor" target="_blank" rel="noopener noreferrer" class="secondary-btn about-repo-link">
            ${getIconSvg('github', 18)}
            <span>View Source on GitHub</span>
            ${getIconSvg('externalLink', 13)}
          </a>

          <div class="about-links">
            <a href="https://github.com/v3ndettaaa/veditor/issues" target="_blank" rel="noopener noreferrer" class="about-link">
              ${getIconSvg('info', 13)}
              <span>Report Issue</span>
            </a>
            <span class="about-link-divider">•</span>
            <span class="about-license">MIT Licensed</span>
          </div>

          <button id="about-shortcuts-btn" class="primary-btn">
            View Keyboard Shortcuts (?)
          </button>
        </div>
      `;
    }

    return '';
  }

  private bindEvents() {
    this.bindShellEvents();
    this.bindContentEvents();
  }

  /** Overlay, close button, tab nav — bound once per dialog lifetime. */
  private bindShellEvents() {
    const overlay = this._container.querySelector('#settings-overlay');
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setSettingsModalOpen(false);
    });

    this._container.querySelector('#close-settings-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
    });

    // Tab buttons — targeted swap, never a full overlay rebuild.
    this._container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') as SettingsTab;
        if (tab) this.switchTab(tab);
      });
    });
  }

  /** Controls inside the content pane — rebound after every content swap. */
  private bindContentEvents() {
    // Theme toggles (subscription render refreshes selected states in place)
    this._container.querySelectorAll('[data-set-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-set-theme') as ThemeMode;
        store.updateAppSettings({ theme });
      });
    });

    // Accent colors
    this._container.querySelectorAll('[data-set-accent]').forEach(btn => {
      btn.addEventListener('click', () => {
        const accent = btn.getAttribute('data-set-accent');
        if (accent) {
          store.updateAppSettings({ accentColor: accent });
        }
      });
    });

    // Custom accent color picker
    const customAccent = this._container.querySelector<HTMLInputElement>('#custom-accent-picker');
    customAccent?.addEventListener('input', () => {
      store.updateAppSettings({ accentColor: customAccent.value });
    });

    // Pattern select
    const patSelect = this._container.querySelector<HTMLSelectElement>('#pattern-select');
    patSelect?.addEventListener('change', () => {
      // Paint-only change: the store notify path repaints overlays, no relayout.
      store.updateAppSettings({ backgroundPattern: patSelect.value as BackgroundPattern });
    });

    // UI Density
    this._container.querySelectorAll('[data-set-density]').forEach(btn => {
      btn.addEventListener('click', () => {
        const density = btn.getAttribute('data-set-density') as 'comfortable' | 'compact';
        store.updateAppSettings({ uiDensity: density });
      });
    });

    // Toolbar list: show/hide checkboxes (subscription render refreshes rows)
    this._container.querySelectorAll<HTMLInputElement>('[data-toolbar-visible]').forEach(box => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-toolbar-visible') as ToolType | null;
        if (!id) return;
        const hidden = store.toolbarLayout.filter(l => !l.visible).map(l => l.id);
        store.setToolbarHidden(
          box.checked ? hidden.filter(h => h !== id) : [...hidden, id]
        );
      });
    });

    // Toolbar list: move up/down within the saved order (subscription refreshes)
    const moveToolbarItem = (id: ToolType, dir: -1 | 1) => {
      const order = store.toolbarLayout.map(l => l.id);
      const idx = order.indexOf(id);
      const swapWith = idx + dir;
      if (idx === -1 || swapWith < 0 || swapWith >= order.length) return;
      [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
      store.setToolbarOrder(order);
    };
    this._container.querySelectorAll('[data-toolbar-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toolbar-up') as ToolType | null;
        if (id) moveToolbarItem(id, -1);
      });
    });
    this._container.querySelectorAll('[data-toolbar-down]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toolbar-down') as ToolType | null;
        if (id) moveToolbarItem(id, 1);
      });
    });
    this._container.querySelector('#toolbar-layout-reset-btn')?.addEventListener('click', () => {
      store.resetToolbarLayout();
    });

    // Master Pressure Sensitivity Toggle
    const pressureToggle = this._container.querySelector<HTMLInputElement>('#pressure-master-toggle');
    pressureToggle?.addEventListener('change', () => {
      store.updateToolSettings({ pressureSensitivityEnabled: pressureToggle.checked });
    });

    // Mouse velocity pressure simulation toggle
    const mousePressureToggle = this._container.querySelector<HTMLInputElement>('#mouse-pressure-toggle');
    mousePressureToggle?.addEventListener('change', () => {
      store.updateToolSettings({ mousePressureSimulation: mousePressureToggle.checked });
    });

    // Pressure curve
    const curveSelect = this._container.querySelector<HTMLSelectElement>('#curve-select');
    curveSelect?.addEventListener('change', () => {
      store.updateToolSettings({ pressureCurve: curveSelect.value as any });
    });

    // Pressure strength
    const strengthSelect = this._container.querySelector<HTMLSelectElement>('#pressure-strength-select');
    strengthSelect?.addEventListener('change', () => {
      store.updateToolSettings({ pressureStrength: strengthSelect.value as any });
    });

    // Stroke smoothing
    const smoothingSelect = this._container.querySelector<HTMLSelectElement>('#smoothing-select');
    smoothingSelect?.addEventListener('change', () => {
      store.updateToolSettings({ strokeSmoothing: smoothingSelect.value as any });
    });

    // Palm toggle
    const palmToggle = this._container.querySelector<HTMLInputElement>('#palm-toggle');
    palmToggle?.addEventListener('change', () => {
      store.updateToolSettings({ palmRejectionEnabled: palmToggle.checked });
    });

    // Inverted eraser toggle
    const invertedEraserToggle = this._container.querySelector<HTMLInputElement>('#inverted-eraser-toggle');
    invertedEraserToggle?.addEventListener('change', () => {
      store.updateToolSettings({ stylusInvertedEraserEnabled: invertedEraserToggle.checked });
    });

    // Drawing cursor style buttons
    this._container.querySelectorAll('[data-set-cursor]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cursor = btn.getAttribute('data-set-cursor') as any;
        if (cursor) {
          store.updateToolSettings({ drawingCursor: cursor });
        }
      });
    });

    // View mode select
    const viewModeSelect = this._container.querySelector<HTMLSelectElement>('#view-mode-select');
    viewModeSelect?.addEventListener('change', () => {
      const mode = viewModeSelect.value as any;
      store.updateAppSettings({ defaultViewMode: mode });
      store.setViewMode(mode);
    });

    // Zoom preset select
    const zoomPresetSelect = this._container.querySelector<HTMLSelectElement>('#zoom-preset-select');
    zoomPresetSelect?.addEventListener('change', () => {
      const val = zoomPresetSelect.value as any;
      store.updateAppSettings({ defaultZoomMode: val });
      if (val === 'fitWidth') viewportManager.fitToWidth();
      else if (val === 'fitPage') viewportManager.fitToPage();
      else if (val === '100%') { store.setZoom(1.0); }
      else if (val === '125%') { store.setZoom(1.25); }
      else if (val === '150%') { store.setZoom(1.5); }
    });

    // Page shadows toggle
    const shadowsToggle = this._container.querySelector<HTMLInputElement>('#shadows-toggle');
    shadowsToggle?.addEventListener('change', () => {
      store.updateAppSettings({ showPageShadows: shadowsToggle.checked });
    });

    // Smooth scroll toggle
    const smoothScrollToggle = this._container.querySelector<HTMLInputElement>('#smooth-scroll-toggle');
    smoothScrollToggle?.addEventListener('change', () => {
      store.updateAppSettings({ smoothScroll: smoothScrollToggle.checked });
    });

    // Target render DPI
    const targetDpiInput = this._container.querySelector<HTMLInputElement>('#target-dpi-input');
    const commitTargetDpi = () => {
      if (!targetDpiInput) return;
      const raw = parseInt(targetDpiInput.value, 10);
      const dpi = Number.isFinite(raw) ? Math.max(72, Math.min(600, raw)) : 150;
      targetDpiInput.value = String(dpi);
      store.updateAppSettings({ targetDPI: dpi });
      viewportManager.updateLayout(true);
    };
    targetDpiInput?.addEventListener('change', commitTargetDpi);
    targetDpiInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTargetDpi(); }
    });

    // Preload buffer select
    const preloadSelect = this._container.querySelector<HTMLSelectElement>('#preload-select');
    preloadSelect?.addEventListener('change', () => {
      store.updateAppSettings({ maxRenderBufferPages: parseInt(preloadSelect.value, 10) });
    });

    // Autosave select
    const autosaveSelect = this._container.querySelector<HTMLSelectElement>('#autosave-select');
    autosaveSelect?.addEventListener('change', () => {
      store.updateAppSettings({ autoSaveIntervalMs: parseInt(autosaveSelect.value, 10) });
    });

    // Reset settings button (subscription render refreshes content in place)
    this._container.querySelector('#reset-settings-btn')?.addEventListener('click', () => {
      if (confirm('Reset all application preferences to default values?')) {
        store.resetSettingsToDefault();
      }
    });

    // Clear local db & caches button
    this._container.querySelector('#clear-local-db-btn')?.addEventListener('click', async () => {
      if (confirm('Clear all recent documents, cached annotations, and offline database storage? This cannot be undone.')) {
        await clearAllStorage();
        store.resetSettingsToDefault();
        alert('All offline document caches and settings have been cleared!');
        window.location.reload();
      }
    });

    // Language toggle (full rebuild — header/nav labels are localized)
    this._container.querySelectorAll('[data-set-lang]').forEach(btn => {
      btn.addEventListener('click', () => {
        store.updateAppSettings({ language: btn.getAttribute('data-set-lang') as LanguageMode });
      });
    });

    // Flush cache
    this._container.querySelector('#flush-cache-btn')?.addEventListener('click', () => {
      pdfEngine.destroy();
      viewportManager.updateLayout(true);
      alert('Render caches flushed and memory reclaimed!');
    });

    // Shortcuts button inside about
    this._container.querySelector('#about-shortcuts-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
      store.setShortcutsModalOpen(true);
    });
  }
}
