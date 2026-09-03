/**
 * Advanced Settings & Preferences Modal Component
 * Features an intuitive icon-driven tabbed interface for Appearance,
 * Performance on Large PDFs, Stylus & Input, Localization, and Storage.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';
import { ThemeMode, LanguageMode, BackgroundPattern } from '../../core/types';
import { pdfEngine } from '../../core/pdf-engine';
import { viewportManager } from '../../core/viewport';

type SettingsTab = 'appearance' | 'performance' | 'stylus' | 'language' | 'storage' | 'about';

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
        <div class="modal-dialog" style="max-width:680px; height:540px; display:flex; flex-direction:column; padding:0; overflow:hidden;">
          <!-- Header -->
          <div class="panel-header" style="padding:14px 20px; border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex; align-items:center; gap:8px;">
              ${getIconSvg('settings', 18)}
              <span style="font-weight:600; font-size:15px;">${t('settings.title')}</span>
            </div>
            <button id="close-settings-btn" class="header-btn" style="padding:6px;">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <!-- Body with Tabs -->
          <div style="display:flex; flex:1; min-height:0;">
            <!-- Left Tab Navigation -->
            <div style="width:180px; border-right:1px solid var(--border-subtle); background:var(--bg-surface); padding:12px 8px; display:flex; flex-direction:column; gap:4px;">
              <button class="settings-tab-btn ${this._activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                ${getIconSvg('palette', 15)}
                <span>Appearance</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'performance' ? 'active' : ''}" data-tab="performance">
                ${getIconSvg('zap', 15)}
                <span>Performance</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'stylus' ? 'active' : ''}" data-tab="stylus">
                ${getIconSvg('pen', 15)}
                <span>Pen & Stylus</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'language' ? 'active' : ''}" data-tab="language">
                ${getIconSvg('globe', 15)}
                <span>Language</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'storage' ? 'active' : ''}" data-tab="storage">
                ${getIconSvg('database', 15)}
                <span>Storage</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'about' ? 'active' : ''}" data-tab="about">
                ${getIconSvg('info', 15)}
                <span>About</span>
              </button>
            </div>

            <!-- Right Content Area -->
            <div style="flex:1; padding:20px; overflow-y:auto;">
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
        { name: 'Cyan', color: '#06b6d4' }
      ];

      return `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <!-- Theme -->
          <div class="prop-group">
            <span class="prop-label" style="display:flex; align-items:center; gap:6px;">
              ${getIconSvg('sun', 14)}
              <span>Theme Mode</span>
            </span>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <button class="secondary-btn ${app.theme === 'dark' ? 'primary-btn' : ''}" data-set-theme="dark" style="display:flex; align-items:center; justify-content:center; gap:8px;">
                ${getIconSvg('moon', 15)}
                <span>Dark Theme</span>
              </button>
              <button class="secondary-btn ${app.theme === 'light' ? 'primary-btn' : ''}" data-set-theme="light" style="display:flex; align-items:center; justify-content:center; gap:8px;">
                ${getIconSvg('sun', 15)}
                <span>Light Theme</span>
              </button>
            </div>
          </div>

          <!-- Accent Color -->
          <div class="prop-group">
            <span class="prop-label">Accent Color</span>
            <div style="display:flex; gap:10px; align-items:center;">
              ${accents.map(a => `
                <div class="color-swatch ${(app.accentColor || '#6366f1').toLowerCase() === a.color.toLowerCase() ? 'active' : ''}" 
                     style="background-color:${a.color}; width:28px; height:28px;" data-set-accent="${a.color}" title="${a.name}"></div>
              `).join('')}
            </div>
          </div>

          <!-- Background Paper Pattern -->
          <div class="prop-group">
            <span class="prop-label">Paper Background Pattern</span>
            <select id="pattern-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="none" ${app.backgroundPattern === 'none' ? 'selected' : ''}>Blank (Standard PDF Canvas)</option>
              <option value="grid" ${app.backgroundPattern === 'grid' ? 'selected' : ''}>Grid Paper (Math & Notes)</option>
              <option value="dots" ${app.backgroundPattern === 'dots' ? 'selected' : ''}>Dot Grid (Bullet Journal)</option>
              <option value="lined" ${app.backgroundPattern === 'lined' ? 'selected' : ''}>Lined Paper (Legal & Notebook)</option>
              <option value="isometric" ${app.backgroundPattern === 'isometric' ? 'selected' : ''}>Isometric Grid (Technical Drafting)</option>
            </select>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'performance') {
      return `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <div style="padding:12px; background:var(--accent-subtle); border-radius:8px; border:1px solid var(--border-subtle); font-size:12px; line-height:1.5;">
            ⚡ <strong>Extreme Efficiency Engine Active</strong>: Off-screen page canvases automatically shrink to 1x1 to reclaim GPU VRAM immediately, keeping memory usage ultra-light even on 1,000+ page books.
          </div>

          <div class="prop-group" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size:13px; font-weight:600;">Offscreen Memory Reclamation</div>
              <div style="font-size:11px; color:var(--text-tertiary);">Reclaims uncompressed canvas bitmaps when pages leave the viewport</div>
            </div>
            <input type="checkbox" checked disabled style="width:18px; height:18px;">
          </div>

          <div class="prop-group" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size:13px; font-weight:600;">High-DPI Retina Rendering</div>
              <div style="font-size:11px; color:var(--text-tertiary);">Renders crisp vector text at native display pixel density</div>
            </div>
            <input type="checkbox" checked disabled style="width:18px; height:18px;">
          </div>

          <div class="prop-group">
            <button id="flush-cache-btn" class="secondary-btn" style="width:100%; display:flex; align-items:center; justify-content:center; gap:6px;">
              ${getIconSvg('trash', 14)}
              <span>Flush Render Cache & Reclaim Memory</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'stylus') {
      return `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <div class="prop-group">
            <span class="prop-label">Stylus Pressure Calibration</span>
            <select id="curve-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="linear" ${tools.pressureCurve === 'linear' ? 'selected' : ''}>Linear (Standard 1:1 Mapping)</option>
              <option value="soft" ${tools.pressureCurve === 'soft' ? 'selected' : ''}>Soft (High Sensitivity for Light Touch)</option>
              <option value="firm" ${tools.pressureCurve === 'firm' ? 'selected' : ''}>Firm (Calligraphy & Heavy Pressure)</option>
              <option value="exponential" ${tools.pressureCurve === 'exponential' ? 'selected' : ''}>Exponential (High Dynamic Range)</option>
            </select>
          </div>

          <div class="prop-group" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size:13px; font-weight:600;">Intelligent Palm Rejection</div>
              <div style="font-size:11px; color:var(--text-tertiary);">Filters out wrist and palm contact while drawing with a stylus</div>
            </div>
            <input type="checkbox" id="palm-toggle" ${tools.palmRejectionEnabled ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer;">
          </div>

          <div class="prop-group" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size:13px; font-weight:600;">Stylus Inverted Tip Auto-Eraser</div>
              <div style="font-size:11px; color:var(--text-tertiary);">Automatically switches to eraser when stylus physical eraser tip touches screen</div>
            </div>
            <input type="checkbox" checked disabled style="width:18px; height:18px;">
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'language') {
      return `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <div class="prop-group">
            <span class="prop-label">Interface Language</span>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <button class="secondary-btn ${app.language === 'en' ? 'primary-btn' : ''}" data-set-lang="en" style="padding:14px; text-align:center;">
                <div style="font-weight:600; font-size:14px;">English</div>
                <div style="font-size:11px; opacity:0.8;">Inter Typography</div>
              </button>
              <button class="secondary-btn ${app.language === 'fa' ? 'primary-btn' : ''}" data-set-lang="fa" style="padding:14px; text-align:center; font-family:'Vazirmatn', sans-serif;">
                <div style="font-weight:600; font-size:14px;">فارسی</div>
                <div style="font-size:11px; opacity:0.8;">قلم وزیرمتن و راست‌چین کامل</div>
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'storage') {
      return `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <div class="prop-group">
            <span class="prop-label">Auto-Save Frequency</span>
            <select id="autosave-select" style="
              width:100%; padding:9px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
              border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:13px;
            ">
              <option value="5000">Every 5 seconds</option>
              <option value="15000" selected>Every 15 seconds</option>
              <option value="30000">Every 30 seconds</option>
              <option value="60000">Every 1 minute</option>
            </select>
          </div>

          <div class="prop-group">
            <button id="clear-local-db-btn" class="secondary-btn" style="color:var(--danger); width:100%; display:flex; align-items:center; justify-content:center; gap:6px;">
              ${getIconSvg('trash', 14)}
              <span>Clear Recent Documents & History</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'about') {
      return `
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; gap:12px; padding:20px 0;">
          <div style="width:52px; height:52px; border-radius:14px; background:var(--accent); display:flex; align-items:center; justify-content:center; color:#fff; box-shadow:0 8px 24px var(--accent-glow);">
            ${getIconSvg('pen', 26)}
          </div>
          <div style="font-size:18px; font-weight:700;">veditor</div>
          <div style="font-size:12px; color:var(--text-tertiary);">Version 1.0.0 • Manifest V3 & WebExtensions</div>
          <div style="max-width:380px; font-size:12px; line-height:1.6; color:var(--text-secondary); margin-top:8px;">
            World-class, high-performance offline PDF annotator and editor. 100% private with zero telemetry, zero trackers, and local storage.
          </div>
          <button id="about-shortcuts-btn" class="primary-btn" style="margin-top:16px;">
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
        }
      });
    });

    // Pattern select
    const patSelect = this._container.querySelector<HTMLSelectElement>('#pattern-select');
    patSelect?.addEventListener('change', () => {
      store.updateAppSettings({ backgroundPattern: patSelect.value as BackgroundPattern });
      viewportManager.updateLayout(true);
    });

    // Pressure curve
    const curveSelect = this._container.querySelector<HTMLSelectElement>('#curve-select');
    curveSelect?.addEventListener('change', () => {
      store.updateToolSettings({ pressureCurve: curveSelect.value as any });
    });

    // Palm toggle
    const palmToggle = this._container.querySelector<HTMLInputElement>('#palm-toggle');
    palmToggle?.addEventListener('change', () => {
      store.updateToolSettings({ palmRejectionEnabled: palmToggle.checked });
    });

    // Language toggle
    this._container.querySelectorAll('[data-set-lang]').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-set-lang') as LanguageMode;
        store.updateAppSettings({ language: lang });
        document.documentElement.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
        document.documentElement.setAttribute('lang', lang);
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
