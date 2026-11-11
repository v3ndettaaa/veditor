/**
 * Advanced Settings & Preferences Modal Component
 * Features an intuitive icon-driven tabbed interface for Appearance, Toolbar,
 * Pen & Stylus Input (Pressure sensitivity, curves, mouse velocity),
 * Viewer & Reading, Performance, Storage, Localization, and About with GitHub link.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { t, tr } from '../i18n';
import { AppSettings, ThemeMode, LanguageMode, BackgroundPattern, ToolType } from '../../core/types';
import { pdfEngine } from '../../core/pdf-engine';
import { viewportManager } from '../../core/viewport';
import { clearAllStorage } from '../../io/storage';
import { DEFAULT_ACCENT } from '../theme';
import { resolveRenderDpr, clampRenderMultiplier } from '../../utils/dpi';
import { TOOL_SHORT_LABELS, getToolShortLabel } from './toolbar';
import { shortcutManager, DEFAULT_SHORTCUTS, type ShortcutAction } from '../../input/shortcuts';
import { getAppVersion } from '../../core/app-version';
import { isDesktop } from '../../core/platform';
import { showToast } from './toast';
import { nativeConfirm } from '../../io/native-fs';

type SettingsTab = 'appearance' | 'toolbar' | 'input' | 'shortcuts' | 'viewer' | 'performance' | 'storage' | 'language' | 'about';

/** Toolbar tool id → icon name, mirroring the toolbar template. */
const TOOLBAR_ICONS: Record<string, string> = {
  select: 'select',
  lasso: 'lasso',
  hand: 'hand',
  pen: 'pen',
  highlighter: 'highlighter',
  eraser: 'eraser',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  polygon: 'polygon',
  text: 'text',
  'sticky-note': 'sticky-note',
  stamp: 'stamp',
  'measure-distance': 'measure',
  signature: 'signature',
  scratchpad: 'scratchpad'
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
    const content = this._container.querySelector<HTMLElement>('.settings-content');
    if (content) {
      content.classList.remove('settings-tab-enter');
      void content.offsetWidth;
      content.classList.add('settings-tab-enter');
      content.innerHTML = this.renderTabContent(store.appSettings, store.toolSettings);
      content.scrollTop = 0;
    }
    this.bindContentEvents();
  }

  public render(): void {
    if (!store.settingsModalOpen) {
      const overlay = this._container.querySelector<HTMLElement>('#settings-overlay');
      if (overlay && !overlay.classList.contains('is-closing')) {
        overlay.classList.add('is-closing');
        window.setTimeout(() => {
          if (!store.settingsModalOpen) {
            this._container.innerHTML = '';
          }
        }, 150);
      } else if (!overlay) {
        this._container.innerHTML = '';
      }
      this._lastRenderKey = null;
      this._renderedLanguage = null;
      return;
    }

    // One-shot jump request (e.g. command palette → Toolbar tab).
    if (store.settingsTabRequest) {
      const req = store.settingsTabRequest;
      store.settingsTabRequest = null;
      const tabs: string[] = ['appearance', 'toolbar', 'input', 'shortcuts', 'viewer', 'performance', 'storage', 'language', 'about'];
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
    const langChanged = this._renderedLanguage !== app.language;
    this._renderedLanguage = app.language;
    const prevScroll = this._container.querySelector('.settings-content')?.scrollTop ?? 0;

    const existingOverlay = this._container.querySelector('#settings-overlay');
    const existingContent = this._container.querySelector<HTMLElement>('.settings-content');

    // If the modal dialog is already mounted and language hasn't changed,
    // patch only the tab buttons and right content area in place so the modal
    // overlay and dialog never flash or replay their scale/fade entrance animation.
    if (existingOverlay && existingContent && !langChanged) {
      this._container.querySelectorAll<HTMLElement>('.settings-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === this._activeTab);
      });
      existingContent.innerHTML = this.renderTabContent(app, tools);
      this.bindContentEvents();
      if (prevScroll > 0) existingContent.scrollTop = prevScroll;
      return;
    }

    this._container.innerHTML = `
      <div class="modal-overlay" id="settings-overlay">
        <div class="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-label="${t('settings.title')}">
          <!-- Header -->
          <div class="panel-header settings-header">
            <div class="panel-header-title">
              ${getIconSvg('settings', 18)}
              <span>${t('settings.title')}</span>
            </div>
            <button id="close-settings-btn" class="icon-btn" title="${t('actions.close')}" aria-label="${t('actions.close')}">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <!-- Body with Tabs -->
          <div class="settings-body">
            <!-- Left Tab Navigation -->
            <nav class="settings-nav" aria-label="${tr('Settings sections', 'بخش‌های تنظیمات')}">
              <button class="settings-tab-btn ${this._activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                ${getIconSvg('palette', 15)}
                <span>${tr('Appearance', 'ظاهر و پوسته')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'toolbar' ? 'active' : ''}" data-tab="toolbar">
                ${getIconSvg('sliders', 15)}
                <span>${tr('Toolbar', 'نوار ابزار')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'input' ? 'active' : ''}" data-tab="input">
                ${getIconSvg('pen', 15)}
                <span>${tr('Pen & Input', 'قلم و ورودی')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'shortcuts' ? 'active' : ''}" data-tab="shortcuts">
                ${getIconSvg('command', 15)}
                <span>${tr('Keyboard Shortcuts', 'کلیدهای میانبر')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'viewer' ? 'active' : ''}" data-tab="viewer">
                ${getIconSvg('eye', 15)}
                <span>${tr('Viewer & Reading', 'نمایش و مطالعه')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'performance' ? 'active' : ''}" data-tab="performance">
                ${getIconSvg('zap', 15)}
                <span>${tr('Performance', 'عملکرد و گرافیک')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'storage' ? 'active' : ''}" data-tab="storage">
                ${getIconSvg('database', 15)}
                <span>${tr('Storage & Backup', 'حافظه و بازیابی')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'language' ? 'active' : ''}" data-tab="language">
                ${getIconSvg('globe', 15)}
                <span>${tr('Language', 'زبان برنامه')}</span>
              </button>
              <button class="settings-tab-btn ${this._activeTab === 'about' ? 'active' : ''}" data-tab="about">
                ${getIconSvg('info', 15)}
                <span>${tr('About', 'درباره برنامه')}</span>
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
        { name: tr('Indigo', 'نیلی'), color: DEFAULT_ACCENT },
        { name: tr('Purple', 'بنفش'), color: '#8b5cf6' },
        { name: tr('Emerald', 'زمردی'), color: '#10b981' },
        { name: tr('Rose', 'سرخابی'), color: '#f43f5e' },
        { name: tr('Amber', 'کهربایی'), color: '#f59e0b' },
        { name: tr('Cyan', 'فیروزه‌ای'), color: '#06b6d4' },
        { name: tr('Blue', 'آبی'), color: '#2563eb' },
        { name: tr('Crimson', 'زرشکی'), color: '#dc2626' }
      ];

      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Theme & Visual Styling', 'پوسته و ظاهر برنامه')}</div>

          <!-- Theme -->
          <div class="prop-group">
            <span class="prop-label has-icon">
              ${getIconSvg('sun', 14)}
              <span>${tr('Theme Mode', 'حالت رنگ‌بندی')}</span>
            </span>
            <div class="settings-grid">
              <button class="secondary-btn ${app.theme === 'dark' ? 'is-selected' : ''}" data-set-theme="dark">
                ${getIconSvg('moon', 15)}
                <span>${t('settings.dark')}</span>
              </button>
              <button class="secondary-btn ${app.theme === 'light' ? 'is-selected' : ''}" data-set-theme="light">
                ${getIconSvg('sun', 15)}
                <span>${t('settings.light')}</span>
              </button>
            </div>
          </div>

          <!-- Accent Color -->
          <div class="prop-group">
            <span class="prop-label">${tr('Accent Brand Color', 'رنگ شاخص برنامه')}</span>
            <div class="chip-row">
              ${accents.map(a => `
                <button type="button"
                        class="color-swatch is-square ${(app.accentColor || DEFAULT_ACCENT).toLowerCase() === a.color.toLowerCase() ? 'active' : ''}"
                        style="background-color:${a.color};" data-set-accent="${a.color}"
                        title="${a.name}" aria-label="${a.name}"
                        aria-pressed="${(app.accentColor || DEFAULT_ACCENT).toLowerCase() === a.color.toLowerCase()}"></button>
              `).join('')}
              <div class="accent-custom">
                <div class="color-picker-wrapper is-lg" title="${tr('Custom Accent Color', 'انتخاب رنگ دلخواه')}">
                  <input type="color" id="custom-accent-picker" class="color-picker-input" value="${app.accentColor || DEFAULT_ACCENT}">
                </div>
                <span>${tr('Custom', 'دلخواه')}</span>
              </div>
            </div>
          </div>

          <div class="settings-section-header">${tr('Canvas Paper Settings', 'تنظیمات پس‌زمینه محیط کار')}</div>

          <!-- Background Paper Pattern -->
          <div class="prop-group">
            <span class="prop-label">${tr('Paper Background Pattern', 'الگوی پس‌زمینه صفحات')}</span>
            <select id="pattern-select" class="field">
              <option value="none" ${app.backgroundPattern === 'none' ? 'selected' : ''}>${tr('Blank (Standard PDF Canvas)', 'ساده (بدون الگوی کمکی)')}</option>
              <option value="grid" ${app.backgroundPattern === 'grid' ? 'selected' : ''}>${tr('Square Grid (Math & Technical)', 'شطرنجی (ریاضی و فنی)')}</option>
              <option value="dots" ${app.backgroundPattern === 'dots' ? 'selected' : ''}>${tr('Dot Grid (Bullet Journal)', 'نقطه‌ای (بولت‌ژورنال)')}</option>
              <option value="lined" ${app.backgroundPattern === 'lined' ? 'selected' : ''}>${tr('Lined Paper (Notes & Ruled)', 'خط‌دار (دفتر یادداشت)')}</option>
              <option value="isometric" ${app.backgroundPattern === 'isometric' ? 'selected' : ''}>${tr('Isometric Grid (3D Drafting)', 'ایزومتریک (طراحی سه‌بعدی)')}</option>
            </select>
          </div>

          <!-- UI Density -->
          <div class="prop-group">
            <span class="prop-label">${tr('Interface Layout Density', 'تراکم عناصر رابط کاربری')}</span>
            <div class="settings-grid">
              <button class="secondary-btn ${app.uiDensity !== 'compact' ? 'is-selected' : ''}" data-set-density="comfortable">
                ${tr('Comfortable', 'استاندارد و راحت')}
              </button>
              <button class="secondary-btn ${app.uiDensity === 'compact' ? 'is-selected' : ''}" data-set-density="compact">
                ${tr('Compact', 'فشرده')}
              </button>
            </div>
          </div>

          <!-- Auto-Hide Header in Fullscreen -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${t('settings.autoHideFullscreen')}</div>
              <div class="setting-desc">${t('settings.autoHideFullscreenDesc')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" data-fullscreen-autohide-toggle ${app.autoHideHeaderInFullscreen !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'toolbar') {
      const layout = store.toolbarLayout;
      const dockLabels: Record<string, string> = {
        top: tr('Top', 'بالا'),
        bottom: tr('Bottom', 'پایین'),
        left: tr('Left', 'چپ'),
        right: tr('Right', 'راست')
      };
      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Toolbar Buttons', 'دکمه‌های نوار ابزار')}</div>
          <div class="settings-callout">
            <span class="settings-callout-icon">${getIconSvg('info', 15)}</span>
            <span>${tr('Tick a tool to show it in the bar, untick to hide it. Use the arrows to move it left or right.', 'برای نمایش یا مخفی کردن هر ابزار کلید مقابل آن را تغییر دهید و با فلش‌ها ترتیب چیدمان را تنظیم کنید.')}</span>
          </div>
          <div class="panel-stack" id="toolbar-list">
            ${layout.map((item, idx) => `
              <div class="list-card ${item.visible ? '' : 'is-dimmed'}" data-toolbar-row="${item.id}">
                <label class="setting-switch" title="${tr('Show in toolbar', 'نمایش در نوار ابزار')}">
                  <input type="checkbox" data-toolbar-visible="${item.id}" ${item.visible ? 'checked' : ''}>
                  <span class="setting-slider"></span>
                </label>
                <span class="list-card-icon">${getIconSvg(TOOLBAR_ICONS[item.id] ?? 'pen', 15)}</span>
                <span class="list-card-title" style="flex:1; min-width:0;">${getToolShortLabel(item.id)}</span>
                <button class="icon-btn is-small" data-toolbar-up="${item.id}" title="${tr('Move up (toward bar start)', 'انتقال به بالاتر')}"
                        ${idx === 0 ? 'disabled style="opacity:0.35; cursor:default;"' : ''}>
                  <span aria-hidden="true" style="font-size:14px; font-weight:700;">↑</span>
                </button>
                <button class="icon-btn is-small" data-toolbar-down="${item.id}" title="${tr('Move down (toward bar end)', 'انتقال به پایین‌تر')}"
                        ${idx === layout.length - 1 ? 'disabled style="opacity:0.35; cursor:default;"' : ''}>
                  <span aria-hidden="true" style="font-size:14px; font-weight:700;">↓</span>
                </button>
              </div>
            `).join('')}
          </div>
          <div class="panel-stack">
            <button id="toolbar-layout-reset-btn" class="secondary-btn is-block">
              ${getIconSvg('rotate', 14)}
              <span>${tr('Reset Toolbar to Defaults', 'بازنشانی چیدمان نوار ابزار به پیش‌فرض')}</span>
            </button>
          </div>
          <div class="settings-section-header">${tr('Dock Position', 'محل قرارگیری نوار ابزار')}</div>
          <div class="settings-grid is-quad">
            ${(['top', 'bottom', 'left', 'right'] as const).map(edge => `
              <button class="secondary-btn ${app.toolbarDock === edge ? 'is-selected' : ''}" data-set-dock="${edge}">
                ${dockLabels[edge]}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'input') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Pressure Sensitivity & Dynamics', 'حساسیت فشار قلم و پویایی خط')}</div>

          <!-- Master Pressure Sensitivity Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Dynamic Pressure Sensitivity', 'حساسیت پویا به فشار قلم')}</div>
              <div class="setting-desc">${tr('Vary stroke thickness dynamically with stylus or pointer pressure. When disabled, pen strokes render at fixed, uniform width.', 'تغییر طبیعی ضخامت خط متناسب با فشار قلم نوری یا لمس. در صورت غیرفعال بودن، خطوط با ضخامت کاملاً یکنواخت رسم می‌شوند.')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pressure-master-toggle" ${tools.pressureSensitivityEnabled !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Mouse & Pointer Speed Pressure Simulation -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Simulate Pressure with Pointer Speed', 'شبیه‌سازی فشار با سرعت حرکت ماوس')}</div>
              <div class="setting-desc">${tr('Dynamically simulate natural pressure variations using cursor speed when drawing with a mouse or trackpad.', 'شبیه‌سازی تغییر ضخامت خط بر اساس سرعت حرکت دست هنگام طراحی با ماوس یا تاچ‌پد.')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="mouse-pressure-toggle" ${tools.mousePressureSimulation ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Stylus Pressure Calibration Curve -->
          <div class="prop-group">
            <span class="prop-label">${tr('Pressure Response Curve', 'منحنی پاسخ‌دهی به فشار قلم')}</span>
            <select id="curve-select" class="field">
              <option value="linear" ${tools.pressureCurve === 'linear' ? 'selected' : ''}>${tr('Linear (Standard 1:1 Response)', 'خطی (پاسخ‌دهی استاندارد ۱ به ۱)')}</option>
              <option value="soft" ${tools.pressureCurve === 'soft' ? 'selected' : ''}>${tr('Soft (High Sensitivity for Light Touch)', 'نرم (حساسیت بالا برای فشارهای ملایم)')}</option>
              <option value="firm" ${tools.pressureCurve === 'firm' ? 'selected' : ''}>${tr('Firm (Calligraphy & Heavy Physical Pressure)', 'سفت (مناسب خوشنویسی و فشار بیشتر دست)')}</option>
              <option value="exponential" ${tools.pressureCurve === 'exponential' ? 'selected' : ''}>${tr('Exponential (High Dynamic Contrast)', 'نمایی (کنتراست بالا بین خطوط نازک و ضخیم)')}</option>
            </select>
          </div>

          <!-- Pressure Dynamic Range Factor -->
          <div class="prop-group">
            <span class="prop-label">${tr('Pressure Dynamic Thickness Range', 'دامنه تغییر ضخامت با فشار')}</span>
            <select id="pressure-strength-select" class="field">
              <option value="light" ${tools.pressureStrength === 'light' ? 'selected' : ''}>${tr('Subtle (0.6x - 1.4x Base Width)', 'ملایم (۰.۶ تا ۱.۴ برابر ضخامت پایه)')}</option>
              <option value="balanced" ${tools.pressureStrength === 'balanced' || !tools.pressureStrength ? 'selected' : ''}>${tr('Balanced (0.3x - 1.8x Base Width - Recommended)', 'متعادل (۰.۳ تا ۱.۸ برابر ضخامت پایه - پیشنهادی)')}</option>
              <option value="strong" ${tools.pressureStrength === 'strong' ? 'selected' : ''}>${tr('Dramatic (0.1x - 2.4x Base Width)', 'قوی (۰.۱ تا ۲.۴ برابر ضخامت پایه)')}</option>
            </select>
          </div>

          <div class="settings-section-header">${tr('Stroke Smoothing & Hardware Handling', 'نرم‌سازی خطوط و تنظیمات سخت‌افزار قلم')}</div>

          <!-- Stroke Smoothing -->
          <div class="prop-group">
            <span class="prop-label">${tr('Stroke Smoothing & Stabilization', 'نرم‌سازی و لرزش‌گیر دست‌خط')}</span>
            <select id="smoothing-select" class="field">
              <option value="none" ${tools.strokeSmoothing === 'none' ? 'selected' : ''}>${tr('None (Direct Hardware Input)', 'بدون نرم‌سازی (ورودی مستقیم سخت‌افزار)')}</option>
              <option value="subtle" ${tools.strokeSmoothing === 'subtle' ? 'selected' : ''}>${tr('Subtle (Low Latency)', 'ملایم (تأخیر بسیار کم)')}</option>
              <option value="medium" ${tools.strokeSmoothing === 'medium' || !tools.strokeSmoothing ? 'selected' : ''}>${tr('Medium (Catmull-Rom Centripetal Spline)', 'متوسط (منحنی نرم استاندارد - پیشنهادی)')}</option>
              <option value="high" ${tools.strokeSmoothing === 'high' ? 'selected' : ''}>${tr('High (Cinematic Streamline Stabilization)', 'زیاد (تثبیت و لرزش‌گیری حرفه‌ای خطوط)')}</option>
            </select>
          </div>

          <!-- Intelligent Palm Rejection -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Intelligent Palm Rejection', 'تشخیص هوشمند کف دست (Palm Rejection)')}</div>
              <div class="setting-desc">${tr('Filters out accidental wrist and palm touches while drawing with an active stylus.', 'نادیده گرفتن برخورد تصادفی مچ و کف دست با صفحه هنگام نوشتن با قلم نوری.')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="palm-toggle" ${tools.palmRejectionEnabled ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Stylus Inverted Tip Auto-Eraser -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Stylus Inverted Tip Auto-Eraser', 'پاک‌کن خودکار با تهِ قلم نوری')}</div>
              <div class="setting-desc">${tr('Automatically activates the eraser tool when the physical eraser tail of the stylus touches the glass.', 'فعال شدن خودکار ابزار پاک‌کن هنگام استفاده از سرِ پشتی (پاک‌کن فیزیکی) قلم نوری روی صفحه.')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="inverted-eraser-toggle" ${tools.stylusInvertedEraserEnabled !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'shortcuts') {
      const bindings = shortcutManager.all();
      const rows = (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).map(action => {
        const label = getToolShortLabel(action);
        const key = bindings[action] === 'space' ? 'Space' : bindings[action].toUpperCase();
        return `
          <button type="button" class="secondary-btn shortcut-row" data-rebind="${action}"
                  style="display:flex; justify-content:space-between; align-items:center; width:100%;">
            <span>${label}</span>
            <kbd class="kbd" style="min-width:44px; text-align:center;">${key}</kbd>
          </button>`;
      }).join('');

      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Tool Shortcuts', 'میانبرهای ابزارها')}</div>
          <div class="form-hint">${tr('Click a shortcut, then press the new key to bind it. Press Esc to cancel. Shortcuts are single keys without Ctrl/Alt modifiers and are saved on this device.', 'روی هر ردیف کلیک کنید و کلید جدید را فشار دهید تا ثبت شود (برای انصراف کلید Esc را بزنید). میانبرها روی همین دستگاه ذخیره می‌شوند.')}</div>
          <div class="prop-group" id="shortcut-rows" style="display:flex; flex-direction:column; gap:6px;">
            ${rows}
          </div>
          <div class="form-hint" id="shortcut-conflict" style="color:#f43f5e; min-height:16px;"></div>
          <button id="shortcuts-reset-btn" class="secondary-btn">${tr('Reset to Defaults', 'بازگردانی میانبرها به حالت پیش‌فرض')}</button>
        </div>
      `;
    }

    if (this._activeTab === 'viewer') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Default Document View & Navigation', 'حالت پیش‌فرض نمایش و پیمایش سند')}</div>

          <!-- Default View Mode -->
          <div class="prop-group">
            <span class="prop-label">${tr('Default Page View Layout', 'چیدمان پیش‌فرض نمایش صفحات')}</span>
            <select id="view-mode-select" class="field">
              <option value="continuous" ${app.defaultViewMode === 'continuous' ? 'selected' : ''}>${tr('Continuous Vertical Scroll (Seamless)', 'پیمایش عمودی پیوسته (پشت سر هم)')}</option>
              <option value="single" ${app.defaultViewMode === 'single' ? 'selected' : ''}>${tr('Single Page View', 'نمایش تک‌صفحه‌ای')}</option>
              <option value="two-page" ${app.defaultViewMode === 'two-page' ? 'selected' : ''}>${tr('Two-Page Facing Spread (Book Mode)', 'نمایش دوصفحه‌ای روبه‌رو (حالت کتاب)')}</option>
            </select>
          </div>

          <!-- Default Zoom Preset -->
          <div class="prop-group">
            <span class="prop-label">${tr('Default Zoom Level', 'مقدار بزرگ‌نمایی پیش‌فرض')}</span>
            <select id="zoom-preset-select" class="field">
              <option value="fitWidth" ${app.defaultZoomMode === 'fitWidth' ? 'selected' : ''}>${tr('Fit to Width (Recommended for Laptops & Desktops)', 'متناسب با عرض صفحه (پیشنهادی برای لپ‌تاپ و دسکتاپ)')}</option>
              <option value="fitPage" ${app.defaultZoomMode === 'fitPage' ? 'selected' : ''}>${tr('Fit Whole Page (Recommended for Tablets)', 'نمایش کامل صفحه (پیشنهادی برای تبلت)')}</option>
              <option value="100%" ${app.defaultZoomMode === '100%' ? 'selected' : ''}>${tr('100% Native Resolution', '۱۰۰٪ اندازه واقعی')}</option>
              <option value="125%" ${app.defaultZoomMode === '125%' ? 'selected' : ''}>${tr('125% Comfortable Readability', '۱۲۵٪ خوانایی راحت')}</option>
              <option value="150%" ${app.defaultZoomMode === '150%' ? 'selected' : ''}>${tr('150% High Magnification', '۱۵۰٪ بزرگ‌نمایی زیاد')}</option>
            </select>
          </div>

          <div class="settings-section-header">${tr('Reading Comfort & Fullscreen', 'راحتی مطالعه و حالت تمام‌صفحه')}</div>

          <!-- Auto-Hide Header in Fullscreen -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${t('settings.autoHideFullscreen')}</div>
              <div class="setting-desc">${t('settings.autoHideFullscreenDesc')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" data-fullscreen-autohide-toggle ${app.autoHideHeaderInFullscreen !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Page Shadows Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Realistic Page Drop Shadows', 'سایه طبیعی دور صفحات')}</div>
              <div class="setting-desc">${tr('Renders smooth depth shadows around each page sheet.', 'نمایش سایه نرم در اطراف هر برگه برای تفکیک بهتر از پس‌زمینه.')}</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="shadows-toggle" ${app.showPageShadows !== false ? 'checked' : ''}>
              <span class="setting-slider"></span>
            </label>
          </div>

          <!-- Smooth Scroll Toggle -->
          <div class="setting-card">
            <div class="setting-info">
              <div class="setting-title">${tr('Smooth Scrolling Dynamics', 'پیمایش نرم بین صفحات')}</div>
              <div class="setting-desc">${tr('Enables fluid interpolated scrolling when jumping across pages.', 'حرکت نرم و پیوسته هنگام پرش بین صفحات مختلف.')}</div>
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
      const effectiveDpi = Math.round(store.appSettings.targetDPI || 150);
      const requestedScale = resolveRenderDpr(effectiveDpi);
      // Mirror the real cap so the hint never promises resolution the backing
      // store cannot hold (a 600 DPI Letter page is 5100 px, over the 4096 cap).
      const cappedScale = clampRenderMultiplier(612, 792, requestedScale);
      const capped = cappedScale < requestedScale - 1e-6;
      const dpiHint = capped
        ? tr(
            `Effective backing store: ${(cappedScale).toFixed(2)}× (${Math.round(cappedScale * 72)} DPI). Capped at 4096 px per axis for pages this size — zoom in further to use the full ${effectiveDpi} DPI.`,
            `مقیاس رندر مؤثر: ${(cappedScale).toFixed(2)}× (${Math.round(cappedScale * 72)} DPI). برای حفظ سرعت، هر ضلع بوم به ۴۰۹۶ پیکسل محدود شده است؛ با بزرگ‌نمایی بیشتر تمام دقت ${effectiveDpi} DPI اعمال می‌شود.`
          )
        : tr(
            `Effective backing store: ${requestedScale.toFixed(2)}× (${effectiveDpi} DPI). Higher values are sharper but use more memory.`,
            `مقیاس رندر مؤثر: ${requestedScale.toFixed(2)}× (${effectiveDpi} DPI). مقادیر بالاتر وضوح متن را افزایش می‌دهند اما حافظه بیشتری مصرف می‌کنند.`
          );
      return `
        <div class="settings-stack">
          <div class="settings-callout is-accent">
            <span class="settings-callout-icon">${getIconSvg('zap', 15)}</span>
            <span>${tr(
              '<strong>Extreme efficiency engine active.</strong> Canvases outside the active viewport are automatically recycled and sized to 1x1, reclaiming gigabytes of uncompressed GPU memory when viewing 100+ page books.',
              '<strong>موتور بهینه‌سازی فوق‌سریع فعال است.</strong> بوم‌های خارج از دید صفحه به‌طور خودکار آزاد می‌شوند تا در کتاب‌های صدها صفحه‌ای، مصرف رم و کارت گرافیک در کمترین حالت ممکن بماند.'
            )}</span>
          </div>

          <!-- Custom render DPI. 72 DPI = the PDF point grid; every step up
               multiplies the backing store, so the effective scale and the
               4096 px per-axis cap are surfaced next to the field. -->
          <div class="prop-group">
            <span class="prop-label">${tr('Canvas Render Resolution (DPI)', 'وضوح رندر صفحات (DPI)')}</span>
            <div class="dpi-control-row">
              <input type="number" id="target-dpi-input" class="field dpi-number-input"
                     min="72" max="600" step="1" value="${effectiveDpi}">
              <div class="dpi-preset-chips">
                ${[72, 150, 300, 600].map(d =>
                  `<button type="button" class="dpi-chip ${effectiveDpi === d ? 'active' : ''}" data-dpi-preset="${d}">${d}</button>`
                ).join('')}
              </div>
            </div>
            <div class="setting-desc" id="dpi-effective-hint">${dpiHint}</div>
          </div>

          <!-- Preload buffer -->
          <div class="prop-group">
            <span class="prop-label">${tr('Off-screen Page Preload Buffer', 'تعداد صفحات پیش‌بارگذاری خارج از دید')}</span>
            <select id="preload-select" class="field">
              <option value="1" ${app.maxRenderBufferPages === 1 ? 'selected' : ''}>${tr('1 Page Ahead (Ultra-Low Memory Usage)', '۱ صفحه جلوتر (کمترین مصرف حافظه)')}</option>
              <option value="3" ${app.maxRenderBufferPages === 3 || !app.maxRenderBufferPages ? 'selected' : ''}>${tr('3 Pages Ahead (Balanced - Recommended)', '۳ صفحه جلوتر (متعادل - پیشنهادی)')}</option>
              <option value="5" ${app.maxRenderBufferPages === 5 ? 'selected' : ''}>${tr('5 Pages Ahead (Aggressive Preloading for Fast Flipping)', '۵ صفحه جلوتر (ورق زدن فوق‌سریع)')}</option>
            </select>
          </div>

          <div class="prop-group">
            <button id="flush-cache-btn" class="secondary-btn is-block">
              ${getIconSvg('trash', 14)}
              <span>${tr('Flush Render Cache & Force VRAM Reclaim', 'پاک‌سازی کش رندر و آزادسازی حافظه گرافیکی')}</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'storage') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('IndexedDB Local Persistence', 'ذخیره‌سازی محلی در دستگاه')}</div>

          <!-- Auto-Save Frequency -->
          <div class="prop-group">
            <span class="prop-label">${tr('Auto-Save Annotations Frequency', 'فاصله زمانی ذخیره خودکار یادداشت‌ها')}</span>
            <select id="autosave-select" class="field">
              <option value="5000" ${app.autoSaveIntervalMs === 5000 ? 'selected' : ''}>${tr('Every 5 seconds', 'هر ۵ ثانیه')}</option>
              <option value="15000" ${app.autoSaveIntervalMs === 15000 || !app.autoSaveIntervalMs ? 'selected' : ''}>${tr('Every 15 seconds (Recommended)', 'هر ۱۵ ثانیه (پیشنهادی)')}</option>
              <option value="30000" ${app.autoSaveIntervalMs === 30000 ? 'selected' : ''}>${tr('Every 30 seconds', 'هر ۳۰ ثانیه')}</option>
              <option value="60000" ${app.autoSaveIntervalMs === 60000 ? 'selected' : ''}>${tr('Every 1 minute', 'هر ۱ دقیقه')}</option>
            </select>
          </div>

          <div class="settings-callout">
            <span class="settings-callout-icon">${getIconSvg('shieldCheck', 15)}</span>
            <span>${tr(
              '<strong>Offline storage guarantee.</strong> All PDF documents, markups, layers, signatures, and preferences are stored exclusively on your local machine in browser IndexedDB. Zero cloud uploads, zero tracking.',
              '<strong>تضمین حریم خصوصی و عملکرد کاملاً آفلاین.</strong> تمامی فایل‌های PDF، حاشیه‌نویسی‌ها، امضاها و تنظیمات شما صرفاً روی دستگاه خودتان ذخیره می‌شوند و هیچ داده‌ای به سرور ارسال نمی‌گردد.'
            )}</span>
          </div>

          <div class="settings-section-header">${tr('Reset & Recovery', 'بازنشانی و پاک‌سازی اطلاعات')}</div>

          <div class="panel-stack">
            <button id="reset-settings-btn" class="secondary-btn is-block">
              ${getIconSvg('rotate', 14)}
              <span>${tr('Reset All Settings to Defaults', 'بازگردانی همه تنظیمات به حالت پیش‌فرض')}</span>
            </button>

            <button id="clear-local-db-btn" class="danger-btn is-block">
              ${getIconSvg('trash', 14)}
              <span>${tr('Clear Recent Documents & Annotation Cache', 'پاک کردن لیست فایل‌های اخیر و حافظه پنهان')}</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'language') {
      return `
        <div class="settings-stack">
          <div class="settings-section-header">${tr('Interface Language & Directionality', 'زبان و جهت چیدمان برنامه')}</div>

          <div class="settings-grid">
            <button class="secondary-btn lang-card ${app.language === 'en' ? 'is-selected' : ''}" data-set-lang="en">
              <span class="lang-card-name">English</span>
              <span class="lang-card-desc">Left-to-Right (LTR) • Inter</span>
            </button>
            <button class="secondary-btn lang-card is-fa ${app.language === 'fa' ? 'is-selected' : ''}" data-set-lang="fa">
              <span class="lang-card-name">فارسی</span>
              <span class="lang-card-desc">راست‌چین کامل (RTL) • فونت وزیرمتن</span>
            </button>
          </div>
        </div>
      `;
    }

    if (this._activeTab === 'about') {
      return `
        <div class="about-pane">
          <div class="about-hero-card">
            <div class="about-mark">
              ${getIconSvg('pen', 28)}
            </div>
            <div class="about-identity">
              <div class="about-name">${t('appName')}</div>
              <div class="about-version" id="about-version-text">${tr('Version …', 'نسخه …')}</div>
            </div>
            <p class="about-blurb">
              ${tr(
                'Ultra-fast, professional offline PDF annotator and document editor. Engineered for high performance, sub-millisecond drawing latency, and complete local privacy.',
                'ویرایشگر و حاشیه‌نویس حرفه‌ای، فوق‌سریع و کاملاً آفلاین PDF؛ طراحی‌شده برای نوشتن روان با قلم نوری، کمترین تأخیر و حفظ کامل حریم خصوصی روی دستگاه شما.'
              )}
            </p>
            <div class="about-badges-row">
              <span class="about-feature-pill">
                ${getIconSvg('shieldCheck', 13)}
                <span>${tr('100% Local & Private', '۱۰۰٪ محلی و خصوصی')}</span>
              </span>
              <span class="about-feature-pill">
                ${getIconSvg('zap', 13)}
                <span>${tr('120 Hz Vector Engine', 'موتور برداری ۱۲۰ هرتز')}</span>
              </span>
              <span class="about-feature-pill">
                ${getIconSvg('code', 13)}
                <span>${tr('MIT Open Source', 'متن‌باز با مجوز MIT')}</span>
              </span>
            </div>
          </div>

          <div class="about-update-card">
            <div class="about-update-row">
              <div class="about-update-info">
                <div class="about-update-title">${tr('Software Updates', 'بروزرسانی برنامه')}</div>
                <div class="about-update-desc">${tr('Check GitHub Releases for the latest version', 'بررسی انتشار نسخه جدید در مخزن رسمی گیت‌هاب')}</div>
              </div>
              <button type="button" id="check-updates-btn" class="secondary-btn about-update-btn">
                ${getIconSvg('refresh', 14)}
                <span>${tr('Check for Updates', 'بررسی نسخه جدید')}</span>
              </button>
            </div>
            <div id="update-status-box" class="about-update-status" aria-live="polite"></div>
          </div>

          <div class="about-actions-grid">
            <a href="https://github.com/v3ndettaaa/veditor" target="_blank" rel="noopener noreferrer" class="secondary-btn about-action-btn">
              ${getIconSvg('github', 16)}
              <span>${tr('GitHub Repository', 'مخزن گیت‌هاب')}</span>
              ${getIconSvg('externalLink', 12)}
            </a>
            <a href="https://github.com/v3ndettaaa/veditor/issues" target="_blank" rel="noopener noreferrer" class="secondary-btn about-action-btn">
              ${getIconSvg('info', 15)}
              <span>${tr('Report an Issue', 'گزارش مشکل یا پیشنهاد')}</span>
              ${getIconSvg('externalLink', 12)}
            </a>
            <button type="button" id="about-shortcuts-btn" class="primary-btn about-action-btn is-full-span">
              ${getIconSvg('command', 15)}
              <span>${tr('View Keyboard Shortcuts (?)', 'مشاهده کلیدهای میانبر (؟)')}</span>
            </button>
          </div>
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

    // Toolbar dock position buttons
    this._container.querySelectorAll('[data-set-dock]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dock = btn.getAttribute('data-set-dock') as AppSettings['toolbarDock'] | null;
        if (dock === 'top' || dock === 'bottom' || dock === 'left' || dock === 'right') {
          store.updateAppSettings({ toolbarDock: dock });
        }
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

    // Palm toggle. Palm rejection is a tool/drawing setting, not an app one —
    // writing it through updateAppSettings silently persisted nothing.
    const palmToggle = this._container.querySelector<HTMLInputElement>('#palm-toggle');
    palmToggle?.addEventListener('change', () => {
      store.updateToolSettings({ palmRejectionEnabled: palmToggle.checked });
    });

    // Inverted eraser toggle
    const invertedEraserToggle = this._container.querySelector<HTMLInputElement>('#inverted-eraser-toggle');
    invertedEraserToggle?.addEventListener('change', () => {
      store.updateToolSettings({ stylusInvertedEraserEnabled: invertedEraserToggle.checked });
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

    // Auto-hide header in fullscreen toggle (present in Appearance and Viewer & Reading)
    this._container.querySelectorAll<HTMLInputElement>('[data-fullscreen-autohide-toggle]').forEach(toggle => {
      toggle.addEventListener('change', () => {
        store.updateAppSettings({ autoHideHeaderInFullscreen: toggle.checked });
      });
    });

    // Target render DPI. Typing is debounced so a three-digit value does not
    // re-render every page three times; `change`/Enter commits immediately.
    const targetDpiInput = this._container.querySelector<HTMLInputElement>('#target-dpi-input');
    let dpiDebounce: number | null = null;
    const commitTargetDpi = () => {
      if (!targetDpiInput) return;
      if (dpiDebounce !== null) { window.clearTimeout(dpiDebounce); dpiDebounce = null; }
      const raw = parseInt(targetDpiInput.value, 10);
      const dpi = Number.isFinite(raw) ? Math.max(72, Math.min(600, raw)) : 150;
      targetDpiInput.value = String(dpi);
      store.updateAppSettings({ targetDPI: dpi });
      viewportManager.updateLayout(true);
    };
    targetDpiInput?.addEventListener('input', () => {
      if (dpiDebounce !== null) window.clearTimeout(dpiDebounce);
      dpiDebounce = window.setTimeout(() => { dpiDebounce = null; commitTargetDpi(); }, 350);
    });
    targetDpiInput?.addEventListener('change', commitTargetDpi);
    targetDpiInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTargetDpi(); }
    });
    this._container.querySelectorAll<HTMLElement>('[data-dpi-preset]').forEach(chip => {
      chip.addEventListener('click', () => {
        const dpi = parseInt(chip.dataset.dpiPreset || '', 10);
        if (!Number.isFinite(dpi) || !targetDpiInput) return;
        targetDpiInput.value = String(dpi);
        commitTargetDpi();
      });
    });

    // Preload buffer select
    const preloadSelect = this._container.querySelector<HTMLSelectElement>('#preload-select');
    preloadSelect?.addEventListener('change', () => {
      store.updateAppSettings({ maxRenderBufferPages: parseInt(preloadSelect.value, 10) });
      viewportManager.handleScroll(true);
    });

    // Autosave select
    const autosaveSelect = this._container.querySelector<HTMLSelectElement>('#autosave-select');
    autosaveSelect?.addEventListener('change', () => {
      store.updateAppSettings({ autoSaveIntervalMs: parseInt(autosaveSelect.value, 10) });
    });

    // Reset settings button (subscription render refreshes content in place)
    this._container.querySelector('#reset-settings-btn')?.addEventListener('click', async () => {
      const ok = await nativeConfirm(
        tr(
          'Reset all application preferences to default values?',
          'آیا تمام تنظیمات برنامه به مقادیر پیش‌فرض بازگردانده شوند؟'
        )
      );
      if (ok) {
        store.resetSettingsToDefault();
        showToast(tr('Settings reset to defaults', 'تنظیمات به حالت پیش‌فرض بازگشت'), 'success');
      }
    });

    // Clear local db & caches button
    this._container.querySelector('#clear-local-db-btn')?.addEventListener('click', async () => {
      const ok = await nativeConfirm(
        tr(
          'Clear all recent documents, cached annotations, and offline database storage? This cannot be undone.',
          'آیا تمام لیست فایل‌های اخیر و حافظه پنهان یادداشت‌ها پاک شود؟ این عمل قابل بازگشت نیست.'
        )
      );
      if (ok) {
        await clearAllStorage();
        store.resetSettingsToDefault();
        showToast(tr('All offline document caches and settings have been cleared!', 'تمامی حافظه‌های پنهان و تنظیمات پاک شدند!'), 'success');
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
      showToast(tr('Render caches flushed and memory reclaimed!', 'کش رندر پاک‌سازی و حافظه آزاد شد!'), 'success');
    });

    // Shortcuts button inside about
    this._container.querySelector('#about-shortcuts-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
      store.setShortcutsModalOpen(true);
    });

    // Version is read at runtime (Tauri app metadata / extension manifest)
    // instead of a string hand-copied here, so it never drifts from the
    // actual build.
    const versionEl = this._container.querySelector('#about-version-text');
    if (versionEl) {
      const platformLabel = isDesktop()
        ? tr('Desktop App', 'نسخه دسکتاپ')
        : tr('Manifest V3 & WebExtensions', 'اکستنشن مرورگر و وب');
      void getAppVersion().then(version => {
        versionEl.textContent = `${tr('Version', 'نسخه')} ${version} \u2022 ${platformLabel}`;
      });
    }

    // Manual update checker (queries GitHub Releases API only when clicked)
    const checkUpdatesBtn = this._container.querySelector<HTMLButtonElement>('#check-updates-btn');
    const updateStatusBox = this._container.querySelector<HTMLElement>('#update-status-box');
    checkUpdatesBtn?.addEventListener('click', async () => {
      if (!updateStatusBox || checkUpdatesBtn.disabled) return;
      checkUpdatesBtn.disabled = true;
      checkUpdatesBtn.classList.add('is-checking');
      updateStatusBox.className = 'about-update-status is-visible';
      updateStatusBox.textContent = tr('Checking GitHub releases…', 'در حال بررسی آخرین نسخه در گیت‌هاب…');

      try {
        const currentVer = (await getAppVersion()).replace(/^v/i, '').trim();
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6500);
        const res = await fetch('https://api.github.com/repos/v3ndettaaa/veditor/releases/latest', {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal
        });
        window.clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        const latestTag = String(data?.tag_name || '').replace(/^v/i, '').trim();
        const releaseUrl = String(data?.html_url || 'https://github.com/v3ndettaaa/veditor/releases/latest');

        if (!latestTag) {
          throw new Error('No release tag');
        }

        const isNewer = this.compareSemver(latestTag, currentVer) > 0;
        if (isNewer) {
          updateStatusBox.className = 'about-update-status is-visible is-update-available';
          updateStatusBox.innerHTML = `
            <span>${tr(`New version available: v${latestTag}`, `نسخه جدید منتشر شده است: v${latestTag}`)}</span>
            <a href="${releaseUrl}" target="_blank" rel="noopener noreferrer" class="about-update-download-link">
              <span>${tr('Download Release', 'دریافت نسخه جدید')}</span>
              ${getIconSvg('externalLink', 12)}
            </a>
          `;
        } else {
          updateStatusBox.className = 'about-update-status is-visible is-up-to-date';
          updateStatusBox.textContent = tr(
            `You are running the latest version (v${currentVer}).`,
            `شما از آخرین نسخه برنامه (v${currentVer}) استفاده می‌کنید.`
          );
        }
      } catch (_) {
        updateStatusBox.className = 'about-update-status is-visible is-error';
        updateStatusBox.innerHTML = `
          <span>${tr('Could not reach GitHub Releases.', 'امکان ارتباط با گیت‌هاب وجود نداشت.')}</span>
          <a href="https://github.com/v3ndettaaa/veditor/releases" target="_blank" rel="noopener noreferrer" class="about-update-download-link">
            <span>${tr('Open Releases Page', 'مشاهده صفحه نسخه‌ها')}</span>
            ${getIconSvg('externalLink', 12)}
          </a>
        `;
      } finally {
        checkUpdatesBtn.disabled = false;
        checkUpdatesBtn.classList.remove('is-checking');
      }
    });

    // Keyboard shortcut rebinding: click a row, press the new key.
    const refreshShortcutsPane = () => {
      const content = this._container.querySelector('.settings-content');
      if (content) {
        content.innerHTML = this.renderTabContent(store.appSettings, store.toolSettings);
        this.bindContentEvents();
      }
    };
    this._container.querySelectorAll<HTMLElement>('[data-rebind]').forEach(row => {
      row.addEventListener('click', () => {
        const action = row.getAttribute('data-rebind') as ShortcutAction | null;
        if (!action) return;
        const kbd = row.querySelector('kbd');
        if (kbd) kbd.textContent = '…';
        const conflictHint = this._container.querySelector('#shortcut-conflict');
        if (conflictHint) conflictHint.textContent = '';
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          window.removeEventListener('keydown', onKey, true);
          if (e.key === 'Escape') {
            refreshShortcutsPane();
            return;
          }
          // Modifier presses alone don't bind; wait cancelled instead.
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
            refreshShortcutsPane();
            return;
          }
          const conflict = shortcutManager.set(action, e.key === ' ' ? 'space' : e.key);
          if (conflict) {
            refreshShortcutsPane();
            const hint = this._container.querySelector('#shortcut-conflict');
            if (hint) {
              const keyLabel = e.key === ' ' ? 'Space' : e.key.toUpperCase();
              const conflictLabel = getToolShortLabel(conflict);
              hint.textContent = tr(
                `“${keyLabel}” is already used by ${conflictLabel}.`,
                `کلید «${keyLabel}» قبلاً برای «${conflictLabel}» استفاده شده است.`
              );
            }
            return;
          }
          refreshShortcutsPane();
        };
        window.addEventListener('keydown', onKey, true);
      });
    });
    this._container.querySelector('#shortcuts-reset-btn')?.addEventListener('click', () => {
      shortcutManager.reset();
      refreshShortcutsPane();
    });
  }

  private compareSemver(a: string, b: string): number {
    const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
