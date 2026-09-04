/**
 * Advanced Settings & Preferences Modal Component
 * Features an intuitive icon-driven tabbed interface for Appearance,
 * Pen & Stylus Input (Pressure sensitivity, curves, mouse velocity),
 * Viewer & Reading, Performance, Storage, Localization, and About with GitHub link.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { ThemeMode, LanguageMode, BackgroundPattern } from '../../core/types';
import { pdfEngine } from '../../core/pdf-engine';
import { viewportManager } from '../../core/viewport';
import { clearAllStorage } from '../../io/storage';

type SettingsTab = 'appearance' | 'input' | 'viewer' | 'performance' | 'storage' | 'language' | 'about';

export class SettingsModalComponent {
  private _container: HTMLElement;
  private _activeTab: SettingsTab = 'appearance';

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
  }

  public render(): void {
    if (!store.settingsModalOpen) {
      this._container.innerHTML = '';
      return;
    }

    const app = store.appSettings;
    const tools = store.toolSettings;

    this._container.innerHTML = `
      <div class="modal-overlay" id="settings-overlay">
        <div class="modal-dialog" style="max-width:760px; height:580px; display:flex; flex-direction:column; padding:0; overflow:hidden;">
          <!-- Header -->
          <div class="panel-header" style="padding:14px 20px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:8px;">
              ${getIconSvg('settings', 18)}
              <span style="font-weight:600; font-size:15px;">${t('settings.title')}</span>
            </div>
            <button id="close-settings-btn" class="header-btn" style="padding:6px;" title="Close">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <!-- Body with Tabs -->
          <div style="display:flex; flex:1; min-height:0;">
            <!-- Left Tab Navigation -->
            <div style="width:190px; border-right:1px solid var(--border-subtle); background:var(--bg-surface); padding:12px 8px; display:flex; flex-direction:column; gap:4px; flex-shrink:0;">
              <button class="settings-tab-btn ${this._activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                ${getIconSvg('palette', 15)}
                <span>Appearance</span>
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
            </div>

            <!-- Right Content Area -->
            <div style="flex:1; padding:22px; overflow-y:auto;">
              ${this.renderTabContent(app, tools)}
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private renderTabContent(app: typeof store.appSettings, tools: typeof store.toolSettings): string {
    if (this._activeTab === 'appearance') {
      const accents = [
        { name: 'Indigo', color: '#6366f1' },
        { name: 'Purple', color: '#8b5cf6' },
        { name: 'Emerald', color: '#10b981' },
        { name: 'Rose', color: '#f43f5e' },
        { name: 'Amber', color: '#f59e0b' },
        { name: 'Cyan', color: '#06b6d4' },
        { name: 'Blue', color: '#2563eb' },
        { name: 'Crimson', color: '#dc2626' }
      ];

      return `
        <div style="display:flex; flex-direction:column; gap:18px;">
          <div class="settings-section-header">Theme & Visual Styling</div>

          <!-- Theme -->
          <div class="prop-group">
            <span class="prop-label" style="display:flex; align-items:center; gap:6px;">
              ${getIconSvg('sun', 14)}
              <span>Theme Mode</span>
            </span>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <button class="secondary-btn ${app.theme === 'dark' ? 'primary-btn' : ''}" data-set-theme="dark" style="display:flex; align-items:center; justify-content:center; gap:8px;">
                ${getIconSvg('moon', 15)}
                <span>Dark Mode</span>
              </button>
              <button class="secondary-btn ${app.theme === 'light' ? 'primary-btn' : ''}" data-set-theme="light" style="display:flex; align-items:center; justify-content:center; gap:8px;">
                ${getIconSvg('sun', 15)}
                <span>Light Mode</span>
              </button>
            </div>
          </div>

          <!-- Accent Color -->
          <div class="prop-group">
            <span class="prop-label">Accent Brand Color</span>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              ${accents.map(a => `
                <div class="color-swatch ${(app.accentColor || '#6366f1').toLowerCase() === a.color.toLowerCase() ? 'active' : ''}" 
                     style="background-color:${a.color}; width:28px; height:28px; border-radius:6px; cursor:pointer;" data-set-accent="${a.color}" title="${a.name}"></div>
              `).join('')}
              <div style="display:flex; align-items:center; gap:8px; margin-left:6px;">
                <div class="color-picker-wrapper" style="width:28px; height:28px;" title="Custom Accent Color">
                  <input type="color" id="custom-accent-picker" class="color-picker-input" value="${app.accentColor || '#6366f1'}">
                </div>
                <span style="font-size:11px; color:var(--text-tertiary);">Custom</span>
              </div>
            </div>
          </div>

          <div class="settings-section-header" style="margin-top:8px;">Canvas Paper Settings</div>

          <!-- Background Paper Pattern -->
          <div class="prop-group">
            <span class="prop-label">Paper Background Pattern</span>
            <select id="pattern-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
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
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <button class="secondary-btn ${app.uiDensity !== 'compact' ? 'primary-btn' : ''}" data-set-density="comfortable">
                Comfortable
              </button>
              <button class="secondary-btn ${app.uiDensity === 'compact' ? 'primary-btn' : ''}" data-set-density="compact">
                Compact
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'input') {
      return `
        <div style="display:flex; flex-direction:column; gap:16px;">
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
            <select id="curve-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="linear" ${tools.pressureCurve === 'linear' ? 'selected' : ''}>Linear (Standard 1:1 Response)</option>
              <option value="soft" ${tools.pressureCurve === 'soft' ? 'selected' : ''}>Soft (High Sensitivity for Light Touch)</option>
              <option value="firm" ${tools.pressureCurve === 'firm' ? 'selected' : ''}>Firm (Calligraphy & Heavy Physical Pressure)</option>
              <option value="exponential" ${tools.pressureCurve === 'exponential' ? 'selected' : ''}>Exponential (High Dynamic Contrast)</option>
            </select>
          </div>

          <!-- Pressure Dynamic Range Factor -->
          <div class="prop-group">
            <span class="prop-label">Pressure Dynamic Thickness Range</span>
            <select id="pressure-strength-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="light" ${tools.pressureStrength === 'light' ? 'selected' : ''}>Subtle (0.6x - 1.4x Base Width)</option>
              <option value="balanced" ${tools.pressureStrength === 'balanced' || !tools.pressureStrength ? 'selected' : ''}>Balanced (0.3x - 1.8x Base Width - Recommended)</option>
              <option value="strong" ${tools.pressureStrength === 'strong' ? 'selected' : ''}>Dramatic (0.1x - 2.4x Base Width)</option>
            </select>
          </div>

          <div class="settings-section-header" style="margin-top:8px;">Stroke Smoothing & Hardware Handling</div>

          <!-- Stroke Smoothing -->
          <div class="prop-group">
            <span class="prop-label">Stroke Smoothing & Stabilization</span>
            <select id="smoothing-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
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
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;">
              <button class="secondary-btn ${(tools.drawingCursor || 'pen') === 'pen' ? 'primary-btn' : ''}" data-set-cursor="pen">
                Pen
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'dot' ? 'primary-btn' : ''}" data-set-cursor="dot">
                Dot
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'circle' ? 'primary-btn' : ''}" data-set-cursor="circle">
                Circle
              </button>
              <button class="secondary-btn ${tools.drawingCursor === 'crosshair' ? 'primary-btn' : ''}" data-set-cursor="crosshair">
                Crosshair
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'viewer') {
      return `
        <div style="display:flex; flex-direction:column; gap:16px;">
          <div class="settings-section-header">Default Document View & Navigation</div>

          <!-- Default View Mode -->
          <div class="prop-group">
            <span class="prop-label">Default Page View Layout</span>
            <select id="view-mode-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="continuous" ${app.defaultViewMode === 'continuous' ? 'selected' : ''}>Continuous Vertical Scroll (Seamless)</option>
              <option value="single" ${app.defaultViewMode === 'single' ? 'selected' : ''}>Single Page View</option>
              <option value="two-page" ${app.defaultViewMode === 'two-page' ? 'selected' : ''}>Two-Page Facing Spread (Book Mode)</option>
            </select>
          </div>

          <!-- Default Zoom Preset -->
          <div class="prop-group">
            <span class="prop-label">Default Zoom Level</span>
            <select id="zoom-preset-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="fitWidth" ${app.defaultZoomMode === 'fitWidth' ? 'selected' : ''}>Fit to Width (Recommended for Laptops & Desktops)</option>
              <option value="fitPage" ${app.defaultZoomMode === 'fitPage' ? 'selected' : ''}>Fit Whole Page (Recommended for Tablets)</option>
              <option value="100%" ${app.defaultZoomMode === '100%' ? 'selected' : ''}>100% Native Resolution</option>
              <option value="125%" ${app.defaultZoomMode === '125%' ? 'selected' : ''}>125% Comfortable Readability</option>
              <option value="150%" ${app.defaultZoomMode === '150%' ? 'selected' : ''}>150% High Magnification</option>
            </select>
          </div>

          <div class="settings-section-header" style="margin-top:8px;">Reading Comfort & Visuals</div>

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
        <div style="display:flex; flex-direction:column; gap:16px;">
          <div style="padding:14px; background:var(--accent-subtle); border-radius:8px; border:1px solid var(--border-subtle); font-size:12px; line-height:1.6;">
            ⚡ <strong>Extreme Efficiency Engine Active</strong>: Canvases outside the active viewport are automatically recycled and sized to 1x1, reclaiming gigabytes of uncompressed GPU memory when viewing 100+ page books.
          </div>

          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">High-DPI Retina Rendering</div>
              <div class="setting-desc">Renders vector glyphs at native device pixel density (devicePixelRatio) for razor-sharp typography.</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="retina-toggle" ${app.retinaRendering !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Preload buffer -->
          <div class="prop-group">
            <span class="prop-label">Off-screen Page Preload Buffer</span>
            <select id="preload-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="1" ${app.maxRenderBufferPages === 1 ? 'selected' : ''}>1 Page Ahead (Ultra-Low Memory Usage)</option>
              <option value="3" ${app.maxRenderBufferPages === 3 || !app.maxRenderBufferPages ? 'selected' : ''}>3 Pages Ahead (Balanced - Recommended)</option>
              <option value="5" ${app.maxRenderBufferPages === 5 ? 'selected' : ''}>5 Pages Ahead (Aggressive Preloading for Fast Flipping)</option>
            </select>
          </div>

          <div class="prop-group" style="margin-top:10px;">
            <button id="flush-cache-btn" class="secondary-btn" style="width:100%; display:flex; align-items:center; justify-content:center; gap:8px; padding:10px;">
              ${getIconSvg('trash', 14)}
              <span>Flush Render Cache & Force VRAM Reclaim</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'storage') {
      return `
        <div style="display:flex; flex-direction:column; gap:16px;">
          <div class="settings-section-header">IndexedDB Local Persistence</div>

          <!-- Auto-Save Frequency -->
          <div class="prop-group">
            <span class="prop-label">Auto-Save Annotations Frequency</span>
            <select id="autosave-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="5000" ${app.autoSaveIntervalMs === 5000 ? 'selected' : ''}>Every 5 seconds</option>
              <option value="15000" ${app.autoSaveIntervalMs === 15000 || !app.autoSaveIntervalMs ? 'selected' : ''}>Every 15 seconds (Recommended)</option>
              <option value="30000" ${app.autoSaveIntervalMs === 30000 ? 'selected' : ''}>Every 30 seconds</option>
              <option value="60000" ${app.autoSaveIntervalMs === 60000 ? 'selected' : ''}>Every 1 minute</option>
            </select>
          </div>

          <div style="padding:12px; background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); border-radius:6px; font-size:12px; color:var(--text-secondary); line-height:1.5;">
            📁 <strong>Offline Storage Guarantee</strong>: All PDF documents, markups, layers, signatures, and preferences are stored exclusively on your local machine in browser IndexedDB. Zero cloud uploads, zero tracking.
          </div>

          <div class="settings-section-header" style="margin-top:8px;">Reset & Recovery</div>

          <div style="display:flex; flex-direction:column; gap:8px;">
            <button id="reset-settings-btn" class="secondary-btn" style="width:100%; display:flex; align-items:center; justify-content:center; gap:8px; padding:10px;">
              ${getIconSvg('rotate', 14)}
              <span>Reset All Settings to Defaults</span>
            </button>

            <button id="clear-local-db-btn" class="secondary-btn" style="color:var(--danger); width:100%; display:flex; align-items:center; justify-content:center; gap:8px; padding:10px;">
              ${getIconSvg('trash', 14)}
              <span>Clear Recent Documents & Annotation Cache</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'language') {
      return `
        <div style="display:flex; flex-direction:column; gap:16px;">
          <div class="settings-section-header">Interface Language & Directionality</div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <button class="secondary-btn ${app.language === 'en' ? 'primary-btn' : ''}" data-set-lang="en" style="padding:16px; text-align:center;">
              <div style="font-weight:700; font-size:15px;">English</div>
              <div style="font-size:12px; opacity:0.8; margin-top:4px;">Left-to-Right (LTR) • Inter Font</div>
            </button>
            <button class="secondary-btn ${app.language === 'fa' ? 'primary-btn' : ''}" data-set-lang="fa" style="padding:16px; text-align:center; font-family:'Vazirmatn', sans-serif;">
              <div style="font-weight:700; font-size:15px;">فارسی</div>
              <div style="font-size:12px; opacity:0.8; margin-top:4px;">راست‌چین کامل (RTL) • قلم وزیرمتن</div>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'about') {
      return `
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; gap:14px; padding:16px 0;">
          <div style="width:58px; height:58px; border-radius:16px; background:var(--accent); display:flex; align-items:center; justify-content:center; color:#fff; box-shadow:0 8px 24px var(--accent-glow);">
            ${getIconSvg('pen', 28)}
          </div>
          <div>
            <div style="font-size:20px; font-weight:700; letter-spacing:-0.02em;">veditor</div>
            <div style="font-size:12px; color:var(--text-tertiary); margin-top:2px;">Version 1.0.0 • Manifest V3 & WebExtensions</div>
          </div>

          <div style="max-width:440px; font-size:13px; line-height:1.6; color:var(--text-secondary);">
            Ultra-fast, professional offline PDF annotator and document editor. Engineered for high performance, sub-millisecond drawing latency, and complete local privacy.
          </div>

          <!-- Official GitHub Link -->
          <a href="https://github.com/v3ndettaaa/veditor" target="_blank" rel="noopener noreferrer" 
             style="text-decoration:none; display:inline-flex; align-items:center; gap:8px; padding:10px 22px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium); border-radius:8px; color:var(--text-primary); font-size:13px; font-weight:600; transition:all 0.15s ease; box-shadow:var(--shadow-sm); margin-top:6px;">
            ${getIconSvg('github', 18)}
            <span>View Source on GitHub</span>
            ${getIconSvg('externalLink', 13)}
          </a>

          <div style="display:flex; gap:16px; align-items:center; margin-top:6px;">
            <a href="https://github.com/v3ndettaaa/veditor/issues" target="_blank" rel="noopener noreferrer" 
               style="font-size:12px; color:var(--text-secondary); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              ${getIconSvg('info', 13)}
              <span>Report Issue</span>
            </a>
            <span style="color:var(--border-medium);">•</span>
            <span style="font-size:12px; color:var(--text-tertiary);">MIT Licensed</span>
          </div>

          <button id="about-shortcuts-btn" class="primary-btn" style="margin-top:12px; padding:8px 18px;">
            View Keyboard Shortcuts (?)
          </button>
        </div>
      `;
    }

    return '';
  }

  private bindEvents() {
    const overlay = this._container.querySelector('#settings-overlay');
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setSettingsModalOpen(false);
    });

    this._container.querySelector('#close-settings-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
    });

    // Tab buttons
    this._container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') as SettingsTab;
        if (tab) {
          this._activeTab = tab;
          this.render();
        }
      });
    });

    // Theme toggles
    this._container.querySelectorAll('[data-set-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-set-theme') as ThemeMode;
        store.updateAppSettings({ theme });
        document.body.className = `theme-${theme}`;
        this.render();
      });
    });

    // Accent colors
    this._container.querySelectorAll('[data-set-accent]').forEach(btn => {
      btn.addEventListener('click', () => {
        const accent = btn.getAttribute('data-set-accent');
        if (accent) {
          store.updateAppSettings({ accentColor: accent });
          document.documentElement.style.setProperty('--accent', accent);
          document.documentElement.style.setProperty('--accent-hover', accent);
          this.render();
        }
      });
    });

    // Custom accent color picker
    const customAccent = this._container.querySelector<HTMLInputElement>('#custom-accent-picker');
    customAccent?.addEventListener('input', () => {
      store.updateAppSettings({ accentColor: customAccent.value });
      document.documentElement.style.setProperty('--accent', customAccent.value);
      document.documentElement.style.setProperty('--accent-hover', customAccent.value);
    });

    // Pattern select
    const patSelect = this._container.querySelector<HTMLSelectElement>('#pattern-select');
    patSelect?.addEventListener('change', () => {
      store.updateAppSettings({ backgroundPattern: patSelect.value as BackgroundPattern });
      viewportManager.updateLayout(true);
    });

    // UI Density
    this._container.querySelectorAll('[data-set-density]').forEach(btn => {
      btn.addEventListener('click', () => {
        const density = btn.getAttribute('data-set-density') as 'comfortable' | 'compact';
        store.updateAppSettings({ uiDensity: density });
        document.body.classList.toggle('density-compact', density === 'compact');
        this.render();
      });
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
          store.updateAppSettings({ drawingCursor: cursor });
          this.render();
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
      else if (val === '100%') { store.setZoom(1.0); viewportManager.updateLayout(true); }
      else if (val === '125%') { store.setZoom(1.25); viewportManager.updateLayout(true); }
      else if (val === '150%') { store.setZoom(1.5); viewportManager.updateLayout(true); }
    });

    // Page shadows toggle
    const shadowsToggle = this._container.querySelector<HTMLInputElement>('#shadows-toggle');
    shadowsToggle?.addEventListener('change', () => {
      store.updateAppSettings({ showPageShadows: shadowsToggle.checked });
      document.body.classList.toggle('no-page-shadows', !shadowsToggle.checked);
    });

    // Smooth scroll toggle
    const smoothScrollToggle = this._container.querySelector<HTMLInputElement>('#smooth-scroll-toggle');
    smoothScrollToggle?.addEventListener('change', () => {
      store.updateAppSettings({ smoothScroll: smoothScrollToggle.checked });
    });

    // Retina rendering toggle
    const retinaToggle = this._container.querySelector<HTMLInputElement>('#retina-toggle');
    retinaToggle?.addEventListener('change', () => {
      store.updateAppSettings({ retinaRendering: retinaToggle.checked });
      viewportManager.updateLayout(true);
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

    // Reset settings button
    this._container.querySelector('#reset-settings-btn')?.addEventListener('click', () => {
      if (confirm('Reset all application preferences to default values?')) {
        store.resetSettingsToDefault();
        document.body.className = 'theme-dark';
        document.documentElement.style.setProperty('--accent', '#6366f1');
        document.documentElement.style.setProperty('--accent-hover', '#6366f1');
        document.body.classList.remove('density-compact');
        this.render();
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

    // Language toggle
    this._container.querySelectorAll('[data-set-lang]').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-set-lang') as LanguageMode;
        store.updateAppSettings({ language: lang });
        document.documentElement.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
        document.documentElement.setAttribute('lang', lang);
        this.render();
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
