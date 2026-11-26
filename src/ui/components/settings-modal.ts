/**
 * Studio Preferences Modal Component
 * Unified split-rail preferences dialog with grouped navigation, live visual
 * controls, SVG pressure curve calibration, helpful switch notes, and Esc close.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { APP_LOGO_DATA_URL } from '../../utils/app-logo';
import { t, tr } from '../i18n';
import { AppSettings, ThemeMode, LanguageMode, BackgroundPattern, ToolType } from '../../core/types';
import { pdfEngine } from '../../core/pdf-engine';
import { viewportManager } from '../../core/viewport';
import { clearAllStorage } from '../../io/storage';
import { getToolShortLabel } from './toolbar';
import { shortcutManager, type ShortcutAction } from '../../input/shortcuts';
import { getAppVersion } from '../../core/app-version';
import { isDesktop, isElectron } from '../../core/platform';
import { showToast } from './toast';
import { nativeConfirm } from '../../io/native-fs';
import {
  type SettingsTab,
  getTabHeaderMeta,
  renderSettingsNav,
  renderTabPane,
} from './settings-templates';

const VALID_TABS: SettingsTab[] = [
  'appearance',
  'toolbar',
  'input',
  'shortcuts',
  'viewer',
  'performance',
  'storage',
  'language',
  'about',
];

export class SettingsModalComponent {
  private _container: HTMLElement;
  private _activeTab: SettingsTab = 'appearance';
  private _lastRenderKey: string | null = null;
  private _renderedLanguage: string | null = null;
  private _activeRebindCleanup: (() => void) | null = null;
  private _escHandler: ((e: KeyboardEvent) => void) | null = null;

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

  private detachEscHandler(): void {
    if (this._escHandler) {
      window.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  }

  private attachEscHandler(): void {
    this.detachEscHandler();
    this._escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!store.settingsModalOpen) return;
      // Do not close the modal if the user is cancelling a shortcut rebind.
      if (this._activeRebindCleanup) return;
      e.preventDefault();
      store.setSettingsModalOpen(false);
    };
    window.addEventListener('keydown', this._escHandler);
  }

  private updateStageHeader(): void {
    const meta = getTabHeaderMeta(this._activeTab);
    const titleEl = this._container.querySelector<HTMLElement>('.sg-stage-title');
    const subEl = this._container.querySelector<HTMLElement>('.sg-stage-subtitle');
    const headEl = this._container.querySelector<HTMLElement>('.sg-stage-head');
    if (titleEl) titleEl.textContent = meta.title;
    if (subEl) subEl.textContent = meta.subtitle;
    if (headEl) headEl.classList.toggle('is-compact', this._activeTab === 'about');
  }

  /**
   * Instant tab switch with NO overlay rebuild so the dialog entrance
   * animation never flickers or replays.
   */
  private switchTab(tab: SettingsTab): void {
    if (tab === this._activeTab) return;
    this._activeRebindCleanup?.();
    this._activeRebindCleanup = null;
    try {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch (_) {}
    this._activeTab = tab;
    this._lastRenderKey = this.computeRenderKey();

    this._container.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
      const active = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });

    this.updateStageHeader();

    const content = this._container.querySelector<HTMLElement>('.settings-content');
    if (content) {
      content.classList.remove('settings-tab-enter');
      void content.offsetWidth;
      content.classList.add('settings-tab-enter');
      content.innerHTML = this.renderCurrentTab();
      content.scrollTop = 0;
    }
    this.bindContentEvents();
  }

  private renderCurrentTab(): string {
    return renderTabPane(
      this._activeTab,
      store.appSettings,
      store.toolSettings,
      store.toolbarLayout,
      shortcutManager.all()
    );
  }

  public render(): void {
    if (!store.settingsModalOpen) {
      this._activeRebindCleanup?.();
      this._activeRebindCleanup = null;
      this.detachEscHandler();
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

    if (store.settingsTabRequest) {
      const req = store.settingsTabRequest as SettingsTab;
      store.settingsTabRequest = null;
      if (VALID_TABS.includes(req)) this._activeTab = req;
    }

    const app = store.appSettings;
    const renderKey = this.computeRenderKey();
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') {
      return;
    }

    const activeEl = document.activeElement as HTMLElement | null;
    const userIsEditing =
      !!activeEl &&
      this._container.contains(activeEl) &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName) &&
      (activeEl as HTMLInputElement).type !== 'checkbox';
    if (userIsEditing && this._container.innerHTML !== '') {
      return;
    }

    const existingOverlay = this._container.querySelector<HTMLElement>('#settings-overlay');
    if (existingOverlay) {
      existingOverlay.classList.remove('is-closing');
    }

    if (existingOverlay && this._renderedLanguage === app.language) {
      this._lastRenderKey = renderKey;
      const content = this._container.querySelector<HTMLElement>('.settings-content');
      const prevScroll = content?.scrollTop ?? 0;
      this._container.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
        const active = btn.getAttribute('data-tab') === this._activeTab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-current', active ? 'page' : 'false');
      });
      this.updateStageHeader();
      if (content) {
        content.innerHTML = this.renderCurrentTab();
        content.scrollTop = prevScroll;
      }
      this.bindContentEvents();
      return;
    }

    this._lastRenderKey = renderKey;
    this._renderedLanguage = app.language;
    const prevScroll = this._container.querySelector<HTMLElement>('.settings-content')?.scrollTop ?? 0;
    const headerMeta = getTabHeaderMeta(this._activeTab);

    this._container.innerHTML = `
      <div class="modal-overlay" id="settings-overlay">
        <div class="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-label="${t('settings.title')}">
          <div class="settings-body">
            <!-- Left Navigation Rail -->
            <aside class="settings-nav" aria-label="${tr('Settings sections', 'بخش‌های تنظیمات')}">
              <div class="sg-rail-brand">
                <img src="${APP_LOGO_DATA_URL}" alt="" class="sg-rail-emblem" width="26" height="26" decoding="sync" aria-hidden="true" />
                <div class="sg-rail-brand-text">
                  <span class="sg-rail-title">${t('settings.title')}</span>
                  <span class="sg-rail-app">${t('appName')}</span>
                </div>
              </div>
              <nav class="sg-rail-scroll">
                ${renderSettingsNav(this._activeTab)}
              </nav>
            </aside>

            <!-- Right Content Stage -->
            <div class="sg-stage">
              <header class="sg-stage-head ${this._activeTab === 'about' ? 'is-compact' : ''}">
                <div class="sg-stage-titles">
                  <h2 class="sg-stage-title">${headerMeta.title}</h2>
                  <p class="sg-stage-subtitle">${headerMeta.subtitle}</p>
                </div>
                <div class="sg-stage-close-wrap">
                  <kbd class="sg-esc-hint" aria-hidden="true">Esc</kbd>
                  <button
                    type="button"
                    id="close-settings-btn"
                    class="icon-btn sg-close-btn"
                    title="${t('actions.close')}"
                    aria-label="${t('actions.close')}"
                  >
                    ${getIconSvg('close', 14)}
                  </button>
                </div>
              </header>

              <div class="settings-content">
                ${this.renderCurrentTab()}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.attachEscHandler();
    const content = this._container.querySelector<HTMLElement>('.settings-content');
    if (content && prevScroll > 0) content.scrollTop = prevScroll;
  }

  private bindEvents(): void {
    this.bindShellEvents();
    this.bindContentEvents();
  }

  /** Overlay, close button, tab nav — bound once per dialog mount. */
  private bindShellEvents(): void {
    const overlay = this._container.querySelector('#settings-overlay');
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setSettingsModalOpen(false);
    });

    this._container.querySelector('#close-settings-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
    });

    this._container.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') as SettingsTab | null;
        if (tab) this.switchTab(tab);
      });
    });
  }

  /** Controls inside the content pane — rebound after every content swap. */
  private bindContentEvents(): void {
    // Theme cards
    this._container.querySelectorAll<HTMLElement>('[data-set-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-set-theme') as ThemeMode | null;
        if (theme) store.updateAppSettings({ theme });
      });
    });

    // Accent color swatches
    this._container.querySelectorAll<HTMLElement>('[data-set-accent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const accent = btn.getAttribute('data-set-accent');
        if (accent) store.updateAppSettings({ accentColor: accent });
      });
    });

    // Custom accent color picker
    const customAccent = this._container.querySelector<HTMLInputElement>('#custom-accent-picker');
    const accentHexEl = this._container.querySelector<HTMLElement>('#accent-hex-display');
    customAccent?.addEventListener('input', () => {
      if (accentHexEl) accentHexEl.textContent = customAccent.value.toUpperCase();
      const swatchWrap = customAccent.parentElement;
      if (swatchWrap) swatchWrap.style.background = customAccent.value;
      store.updateAppSettings({ accentColor: customAccent.value });
    });

    // Paper background pattern tiles
    this._container.querySelectorAll<HTMLElement>('[data-set-pattern]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pattern = btn.getAttribute('data-set-pattern') as BackgroundPattern | null;
        if (pattern) store.updateAppSettings({ backgroundPattern: pattern });
      });
    });

    // UI Density segmented buttons
    this._container.querySelectorAll<HTMLElement>('[data-set-density]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const density = btn.getAttribute('data-set-density') as 'comfortable' | 'compact' | null;
        if (density) store.updateAppSettings({ uiDensity: density });
      });
    });

    // Toolbar visibility switches
    this._container.querySelectorAll<HTMLInputElement>('[data-toolbar-visible]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-toolbar-visible') as ToolType | null;
        if (!id) return;
        const hidden = store.toolbarLayout.filter((l) => !l.visible).map((l) => l.id);
        store.setToolbarHidden(box.checked ? hidden.filter((h) => h !== id) : [...hidden, id]);
      });
    });

    // Toolbar reorder up/down
    const moveToolbarItem = (id: ToolType, dir: -1 | 1) => {
      const order = store.toolbarLayout.map((l) => l.id);
      const idx = order.indexOf(id);
      const swapWith = idx + dir;
      if (idx === -1 || swapWith < 0 || swapWith >= order.length) return;
      [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
      store.setToolbarOrder(order);
    };
    this._container.querySelectorAll<HTMLElement>('[data-toolbar-up]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toolbar-up') as ToolType | null;
        if (id) moveToolbarItem(id, -1);
      });
    });
    this._container.querySelectorAll<HTMLElement>('[data-toolbar-down]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toolbar-down') as ToolType | null;
        if (id) moveToolbarItem(id, 1);
      });
    });
    this._container.querySelector('#toolbar-layout-reset-btn')?.addEventListener('click', () => {
      store.resetToolbarLayout();
      showToast(tr('Toolbar layout reset to defaults', 'چیدمان نوار ابزار بازنشانی شد'), 'success');
    });

    // Toolbar dock edge diagrams
    this._container.querySelectorAll<HTMLElement>('[data-set-dock]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dock = btn.getAttribute('data-set-dock') as AppSettings['toolbarDock'] | null;
        if (dock === 'top' || dock === 'bottom' || dock === 'left' || dock === 'right') {
          store.updateAppSettings({ toolbarDock: dock });
        }
      });
    });

    // Pen & Input switches
    const pressureToggle = this._container.querySelector<HTMLInputElement>('#pressure-master-toggle');
    pressureToggle?.addEventListener('change', () => {
      store.updateToolSettings({ pressureSensitivityEnabled: pressureToggle.checked });
    });

    const mousePressureToggle = this._container.querySelector<HTMLInputElement>('#mouse-pressure-toggle');
    mousePressureToggle?.addEventListener('change', () => {
      store.updateToolSettings({ mousePressureSimulation: mousePressureToggle.checked });
    });

    this._container.querySelectorAll<HTMLElement>('[data-set-curve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const curve = btn.getAttribute('data-set-curve') as 'linear' | 'soft' | 'firm' | 'exponential' | null;
        if (curve) store.updateToolSettings({ pressureCurve: curve });
      });
    });

    this._container.querySelectorAll<HTMLElement>('[data-set-pressure-strength]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const strength = btn.getAttribute('data-set-pressure-strength') as 'light' | 'balanced' | 'strong' | null;
        if (strength) store.updateToolSettings({ pressureStrength: strength });
      });
    });

    this._container.querySelectorAll<HTMLElement>('[data-set-smoothing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const smoothing = btn.getAttribute('data-set-smoothing') as 'none' | 'subtle' | 'medium' | 'high' | null;
        if (smoothing) store.updateToolSettings({ strokeSmoothing: smoothing });
      });
    });

    const palmToggle = this._container.querySelector<HTMLInputElement>('#palm-toggle');
    palmToggle?.addEventListener('change', () => {
      store.updateToolSettings({ palmRejectionEnabled: palmToggle.checked });
    });

    const invertedEraserToggle = this._container.querySelector<HTMLInputElement>('#inverted-eraser-toggle');
    invertedEraserToggle?.addEventListener('change', () => {
      store.updateToolSettings({ stylusInvertedEraserEnabled: invertedEraserToggle.checked });
    });

    // Viewer & Reading visual controls
    this._container.querySelectorAll<HTMLElement>('[data-set-view-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-set-view-mode') as AppSettings['defaultViewMode'] | null;
        if (mode) {
          store.updateAppSettings({ defaultViewMode: mode });
          store.setViewMode(mode);
        }
      });
    });

    this._container.querySelectorAll<HTMLElement>('[data-set-zoom-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-set-zoom-preset') as AppSettings['defaultZoomMode'] | null;
        if (!val) return;
        store.updateAppSettings({ defaultZoomMode: val });
        if (val === 'fitWidth') viewportManager.fitToWidth();
        else if (val === 'fitPage') viewportManager.fitToPage();
        else if (val === '100%') store.setZoom(1.0);
        else if (val === '125%') store.setZoom(1.25);
        else if (val === '150%') store.setZoom(1.5);
      });
    });

    const shadowsToggle = this._container.querySelector<HTMLInputElement>('#shadows-toggle');
    shadowsToggle?.addEventListener('change', () => {
      store.updateAppSettings({ showPageShadows: shadowsToggle.checked });
    });

    const smoothScrollToggle = this._container.querySelector<HTMLInputElement>('#smooth-scroll-toggle');
    smoothScrollToggle?.addEventListener('change', () => {
      store.updateAppSettings({ smoothScroll: smoothScrollToggle.checked });
    });

    this._container.querySelectorAll<HTMLInputElement>('[data-fullscreen-autohide-toggle]').forEach((toggle) => {
      toggle.addEventListener('change', () => {
        store.updateAppSettings({ autoHideHeaderInFullscreen: toggle.checked });
      });
    });

    // Performance DPI + presets
    const targetDpiInput = this._container.querySelector<HTMLInputElement>('#target-dpi-input');
    let dpiDebounce: number | null = null;
    const commitTargetDpi = () => {
      if (!targetDpiInput) return;
      if (dpiDebounce !== null) {
        window.clearTimeout(dpiDebounce);
        dpiDebounce = null;
      }
      const raw = parseInt(targetDpiInput.value, 10);
      const dpi = Number.isFinite(raw) ? Math.max(72, Math.min(600, raw)) : 150;
      targetDpiInput.value = String(dpi);
      store.updateAppSettings({ targetDPI: dpi });
      viewportManager.updateLayout(true);
    };
    targetDpiInput?.addEventListener('input', () => {
      if (dpiDebounce !== null) window.clearTimeout(dpiDebounce);
      dpiDebounce = window.setTimeout(() => {
        dpiDebounce = null;
        commitTargetDpi();
      }, 350);
    });
    targetDpiInput?.addEventListener('change', commitTargetDpi);
    targetDpiInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTargetDpi();
      }
    });
    this._container.querySelectorAll<HTMLElement>('[data-dpi-preset]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const dpi = parseInt(chip.dataset.dpiPreset || '', 10);
        if (!Number.isFinite(dpi) || !targetDpiInput) return;
        targetDpiInput.value = String(dpi);
        commitTargetDpi();
      });
    });

    // Performance preload buffer cards
    this._container.querySelectorAll<HTMLElement>('[data-set-preload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pages = parseInt(btn.getAttribute('data-set-preload') || '', 10);
        if (Number.isFinite(pages)) {
          store.updateAppSettings({ maxRenderBufferPages: pages });
          viewportManager.handleScroll(true);
        }
      });
    });

    // Flush cache
    this._container.querySelector('#flush-cache-btn')?.addEventListener('click', () => {
      pdfEngine.destroy();
      viewportManager.updateLayout(true);
      showToast(tr('Render caches flushed and memory reclaimed!', 'کش رندر پاک‌سازی و حافظه آزاد شد!'), 'success');
    });

    // Storage auto-save cadence
    this._container.querySelectorAll<HTMLElement>('[data-set-autosave]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ms = parseInt(btn.getAttribute('data-set-autosave') || '', 10);
        if (Number.isFinite(ms)) {
          store.updateAppSettings({ autoSaveIntervalMs: ms });
        }
      });
    });

    // Reset preferences
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

    // Clear local storage
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
        showToast(
          tr('All offline document caches and settings have been cleared!', 'تمامی حافظه‌های پنهان و تنظیمات پاک شدند!'),
          'success'
        );
        window.location.reload();
      }
    });

    // Language specimen cards
    this._container.querySelectorAll<HTMLElement>('[data-set-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-set-lang') as LanguageMode | null;
        if (lang) store.updateAppSettings({ language: lang });
      });
    });

    // About shortcuts button
    this._container.querySelector('#about-shortcuts-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(false);
      store.setShortcutsModalOpen(true);
    });

    // About runtime version + copy
    const versionEl = this._container.querySelector('#about-version-text');
    const copyVersionBtn = this._container.querySelector<HTMLButtonElement>('#about-copy-version-btn');
    let resolvedVersion = '';
    const platformLabel = isElectron()
      ? tr('Desktop App (Electron)', 'نسخه دسکتاپ (الکترون)')
      : isDesktop()
        ? tr('Desktop App', 'نسخه دسکتاپ')
        : tr('Web & Extension', 'وب و اکستنشن');
    if (versionEl) {
      void getAppVersion().then((version) => {
        resolvedVersion = version.replace(/^v/i, '').trim();
        versionEl.textContent = `v${resolvedVersion}`;
      });
    }
    copyVersionBtn?.addEventListener('click', async () => {
      const ver = resolvedVersion || (await getAppVersion()).replace(/^v/i, '').trim();
      const summary = `veditor v${ver} (${platformLabel})`;
      try {
        await navigator.clipboard.writeText(summary);
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = summary;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } catch (_) {}
        ta.remove();
      }
      copyVersionBtn.classList.add('is-copied');
      copyVersionBtn.innerHTML = getIconSvg('check', 12);
      showToast(tr(`Copied ${summary}`, `مشخصات نسخه کپی شد: v${ver}`), 'success');
      window.setTimeout(() => {
        if (copyVersionBtn.isConnected) {
          copyVersionBtn.classList.remove('is-copied');
          copyVersionBtn.innerHTML = getIconSvg('copy', 12);
        }
      }, 1600);
    });

    // About manual update checker
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
          signal: controller.signal,
        });
        window.clearTimeout(timer);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const latestTag = String(data?.tag_name || '').replace(/^v/i, '').trim();
        const releaseUrl = String(data?.html_url || 'https://github.com/v3ndettaaa/veditor/releases/latest');
        if (!latestTag) throw new Error('No release tag');

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

    // Keyboard shortcut rebinding
    const refreshShortcutsPane = (conflictMsg = '') => {
      this._activeRebindCleanup?.();
      this._activeRebindCleanup = null;
      const content = this._container.querySelector('.settings-content');
      if (content) {
        content.innerHTML = this.renderCurrentTab();
        this.bindContentEvents();
        const hint = this._container.querySelector<HTMLElement>('#shortcut-conflict');
        if (hint && conflictMsg) {
          hint.innerHTML = `${getIconSvg('info', 14)}<span>${conflictMsg}</span>`;
          hint.classList.add('is-visible');
        }
      }
    };

    this._container.querySelectorAll<HTMLElement>('[data-rebind]').forEach((row) => {
      row.addEventListener('click', () => {
        const action = row.getAttribute('data-rebind') as ShortcutAction | null;
        if (!action) return;

        this._activeRebindCleanup?.();
        this._activeRebindCleanup = null;
        this._container.querySelectorAll('.sc-row.is-listening').forEach((el) => {
          el.classList.remove('is-listening');
        });

        row.classList.add('is-listening');
        const kbd = row.querySelector<HTMLElement>('.sc-keycap');
        const prevText = kbd?.textContent ?? '';
        if (kbd) kbd.textContent = tr('Press key…', 'کلیدی بزنید…');

        const conflictHint = this._container.querySelector<HTMLElement>('#shortcut-conflict');
        if (conflictHint) {
          conflictHint.innerHTML = '';
          conflictHint.classList.remove('is-visible');
        }

        const detach = () => {
          window.removeEventListener('keydown', onKey, true);
          row.classList.remove('is-listening');
          if (kbd && kbd.textContent === tr('Press key…', 'کلیدی بزنید…')) {
            kbd.textContent = prevText;
          }
        };

        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
          detach();
          this._activeRebindCleanup = null;

          if (e.key === 'Escape') {
            refreshShortcutsPane();
            return;
          }

          if (e.ctrlKey || e.metaKey || e.altKey) {
            refreshShortcutsPane(
              tr(
                'Tool shortcuts must be a single key without Ctrl, Alt, or Cmd.',
                'میانبر ابزارها باید یک کلید تکی بدون Ctrl، Alt یا Cmd باشد.'
              )
            );
            return;
          }

          const conflict = shortcutManager.set(action, e.key === ' ' ? 'space' : e.key);
          if (conflict) {
            const keyLabel = e.key === ' ' ? 'Space' : e.key.toUpperCase();
            const conflictLabel = getToolShortLabel(conflict);
            refreshShortcutsPane(
              tr(
                `“${keyLabel}” is already assigned to ${conflictLabel}.`,
                `کلید «${keyLabel}» قبلاً برای ابزار «${conflictLabel}» ثبت شده است.`
              )
            );
            return;
          }
          refreshShortcutsPane();
        };

        this._activeRebindCleanup = detach;
        window.addEventListener('keydown', onKey, true);
      });
    });

    this._container.querySelector('#shortcuts-reset-btn')?.addEventListener('click', () => {
      shortcutManager.reset();
      refreshShortcutsPane();
      showToast(tr('Keyboard shortcuts reset to defaults', 'کلیدهای میانبر بازنشانی شدند'), 'success');
    });
  }

  private compareSemver(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
