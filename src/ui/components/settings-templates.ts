/**
 * Studio Preferences Modal — Pure HTML Templates & Visual Diagrams
 * Keeps SettingsModalComponent focused on lifecycle & event wiring while
 * providing rich editorial layouts, miniature visual selectors, SVG pressure
 * diagrams, and practical switch notes across English (LTR) and Persian (RTL).
 */

import { getIconSvg } from '../../utils/icons';
import { APP_LOGO_DATA_URL } from '../../utils/app-logo';
import { t, tr } from '../i18n';
import { AppSettings, ToolSettings, ToolType } from '../../core/types';
import { DEFAULT_ACCENT } from '../theme';
import { resolveRenderDpr, clampRenderMultiplier } from '../../utils/dpi';
import { getToolShortLabel } from './toolbar';
import { type ShortcutAction } from '../../input/shortcuts';
import { isDesktop, isElectron } from '../../core/platform';

export type SettingsTab =
  | 'appearance'
  | 'toolbar'
  | 'input'
  | 'shortcuts'
  | 'viewer'
  | 'performance'
  | 'storage'
  | 'language'
  | 'about';

export interface ToolbarLayoutEntry {
  id: ToolType;
  visible: boolean;
}

export const TOOLBAR_ICONS: Record<string, string> = {
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
  'sticky-note': 'stickyNote',
  stamp: 'stamp',
  'measure-distance': 'measure',
  signature: 'signature',
  scratchpad: 'scratchpad',
};

export interface TabHeaderMeta {
  title: string;
  subtitle: string;
}

export function getTabHeaderMeta(tab: SettingsTab): TabHeaderMeta {
  switch (tab) {
    case 'appearance':
      return {
        title: tr('Appearance', 'ظاهر و پوسته'),
        subtitle: tr(
          'Theme atmosphere, accent hue, canvas paper, and interface rhythm.',
          'پوسته روشن و تاریک، رنگ شاخص، پس‌زمینه صفحات و تراکم رابط کاربری.'
        ),
      };
    case 'toolbar':
      return {
        title: tr('Toolbar', 'نوار ابزار'),
        subtitle: tr(
          'Choose where the tool dock rests and curate the tools within reach.',
          'محل قرارگیری نوار ابزار و نمایش یا ترتیب دکمه‌های کاربردی را تنظیم کنید.'
        ),
      };
    case 'input':
      return {
        title: tr('Pen & Input', 'قلم و ورودی'),
        subtitle: tr(
          'Calibrate stylus pressure curves, stroke stabilization, and palm handling.',
          'تنظیم دقیق منحنی فشار قلم، لرزش‌گیر دست‌خط و رفتار سخت‌افزار قلم نوری.'
        ),
      };
    case 'shortcuts':
      return {
        title: tr('Keyboard Shortcuts', 'کلیدهای میانبر'),
        subtitle: tr(
          'Click any tool to assign a single-key shortcut. Press Esc to cancel.',
          'روی هر ابزار کلیک کنید و کلید جدید را بزنید. برای لغو Esc را فشار دهید.'
        ),
      };
    case 'viewer':
      return {
        title: tr('Viewer & Reading', 'نمایش و مطالعه'),
        subtitle: tr(
          'Default page flow, opening zoom level, and distraction-free reading.',
          'چیدمان پیش‌فرض صفحات، بزرگ‌نمایی اولیه و تنظیمات راحتی مطالعه.'
        ),
      };
    case 'performance':
      return {
        title: tr('Performance', 'عملکرد و گرافیک'),
        subtitle: tr(
          'Balance razor-sharp canvas DPI with GPU memory and page preloading.',
          'تعادل میان وضوح بالای رندر صفحات، مصرف حافظه گرافیکی و پیش‌بارگذاری.'
        ),
      };
    case 'storage':
      return {
        title: tr('Storage & Backup', 'حافظه و بازیابی'),
        subtitle: tr(
          'Local-first auto-save cadence, offline guarantees, and reset controls.',
          'ذخیره‌سازی خودکار محلی، تضمین حریم خصوصی آفلاین و ابزارهای بازنشانی.'
        ),
      };
    case 'language':
      return {
        title: tr('Language', 'زبان برنامه'),
        subtitle: tr(
          'Switch interface script, layout directionality, and bundled typography.',
          'تغییر زبان رابط کاربری، جهت چیدمان صفحات و خانواده فونت برنامه.'
        ),
      };
    case 'about':
      return {
        title: tr('About', 'درباره برنامه'),
        subtitle: tr(
          'Build metadata, release updates, and studio typography colophon.',
          'مشخصات نسخه، بررسی بروزرسانی و شناسنامه تایپوگرافی برنامه.'
        ),
      };
  }
}

export function renderSettingsNav(activeTab: SettingsTab): string {
  const groups: {
    label: string;
    items: { id: SettingsTab; icon: string; label: string }[];
  }[] = [
    {
      label: tr('Workspace', 'محیط کار'),
      items: [
        { id: 'appearance', icon: 'palette', label: tr('Appearance', 'ظاهر و پوسته') },
        { id: 'toolbar', icon: 'sliders', label: tr('Toolbar', 'نوار ابزار') },
        { id: 'language', icon: 'globe', label: tr('Language', 'زبان برنامه') },
      ],
    },
    {
      label: tr('Canvas & Reading', 'نگارش و مطالعه'),
      items: [
        { id: 'input', icon: 'pen', label: tr('Pen & Input', 'قلم و ورودی') },
        { id: 'viewer', icon: 'eye', label: tr('Viewer & Reading', 'نمایش و مطالعه') },
        { id: 'shortcuts', icon: 'command', label: tr('Keyboard Shortcuts', 'کلیدهای میانبر') },
      ],
    },
    {
      label: tr('System', 'سیستم'),
      items: [
        { id: 'performance', icon: 'zap', label: tr('Performance', 'عملکرد و گرافیک') },
        { id: 'storage', icon: 'database', label: tr('Storage & Backup', 'حافظه و بازیابی') },
        { id: 'about', icon: 'info', label: tr('About', 'درباره برنامه') },
      ],
    },
  ];

  return groups
    .map(
      (g) => `
      <div class="sg-nav-group">
        <div class="sg-nav-group-label">${g.label}</div>
        <div class="sg-nav-items">
          ${g.items
            .map(
              (item) => `
            <button
              type="button"
              class="settings-tab-btn ${activeTab === item.id ? 'active' : ''}"
              data-tab="${item.id}"
              aria-current="${activeTab === item.id ? 'page' : 'false'}"
            >
              <span class="sg-nav-icon">${getIconSvg(item.icon, 15)}</span>
              <span class="sg-nav-label">${item.label}</span>
            </button>
          `
            )
            .join('')}
        </div>
      </div>
    `
    )
    .join('');
}

function renderNote(text: string): string {
  return `
    <div class="sg-note">
      <span class="sg-note-icon" aria-hidden="true">${getIconSvg('info', 12)}</span>
      <span class="sg-note-text">${text}</span>
    </div>
  `;
}

function renderSwitchRow(opts: {
  id?: string;
  dataAttr?: string;
  checked: boolean;
  title: string;
  desc: string;
  note?: string;
}): string {
  const inputAttrs = [
    opts.id ? `id="${opts.id}"` : '',
    opts.dataAttr ? opts.dataAttr : '',
    opts.checked ? 'checked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `
    <div class="sg-row sg-row-switch">
      <div class="sg-row-body">
        <div class="sg-row-title">${opts.title}</div>
        <div class="sg-row-desc">${opts.desc}</div>
        ${opts.note ? renderNote(opts.note) : ''}
      </div>
      <label class="setting-switch" aria-label="${opts.title}">
        <input type="checkbox" ${inputAttrs}>
        <span class="setting-slider"></span>
      </label>
    </div>
  `;
}

export function renderTabPane(
  tab: SettingsTab,
  app: AppSettings,
  tools: ToolSettings,
  toolbarLayout: ToolbarLayoutEntry[],
  bindings: Record<ShortcutAction, string>
): string {
  switch (tab) {
    case 'appearance':
      return renderAppearanceTab(app);
    case 'toolbar':
      return renderToolbarTab(app, toolbarLayout);
    case 'input':
      return renderInputTab(tools);
    case 'shortcuts':
      return renderShortcutsTab(bindings);
    case 'viewer':
      return renderViewerTab(app);
    case 'performance':
      return renderPerformanceTab(app);
    case 'storage':
      return renderStorageTab(app);
    case 'language':
      return renderLanguageTab(app);
    case 'about':
      return renderAboutTab();
  }
}

/* --------------------------------------------------------------------------
 * 1. APPEARANCE
 * -------------------------------------------------------------------------- */
function renderAppearanceTab(app: AppSettings): string {
  const activeAccent = (app.accentColor || DEFAULT_ACCENT).toUpperCase();
  const accents = [
    { name: tr('Indigo', 'نیلی'), color: DEFAULT_ACCENT },
    { name: tr('Violet', 'بنفش'), color: '#8b5cf6' },
    { name: tr('Emerald', 'زمردی'), color: '#10b981' },
    { name: tr('Rose', 'سرخابی'), color: '#f43f5e' },
    { name: tr('Amber', 'کهربایی'), color: '#f59e0b' },
    { name: tr('Cyan', 'فیروزه‌ای'), color: '#06b6d4' },
    { name: tr('Cobalt', 'آبی'), color: '#2563eb' },
    { name: tr('Crimson', 'زرشکی'), color: '#dc2626' },
  ];

  const patterns: {
    id: AppSettings['backgroundPattern'];
    label: string;
    hint: string;
  }[] = [
    { id: 'none', label: tr('Blank', 'ساده'), hint: tr('Pure canvas', 'بدون الگو') },
    { id: 'grid', label: tr('Square Grid', 'شطرنجی'), hint: tr('Math & tech', 'ریاضی و فنی') },
    { id: 'dots', label: tr('Dot Grid', 'نقطه‌ای'), hint: tr('Bullet notes', 'بولت‌ژورنال') },
    { id: 'lined', label: tr('Lined', 'خط‌دار'), hint: tr('Ruled notes', 'یادداشت') },
    { id: 'isometric', label: tr('Isometric', 'ایزومتریک'), hint: tr('3D drafting', 'طراحی سه‌بعدی') },
  ];

  return `
    <div class="sg-pane">
      <!-- Theme Studio Cards -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Theme Atmosphere', 'پوسته و نورپردازی')}</h3>
        </div>
        <div class="sg-theme-grid">
          <button
            type="button"
            class="sg-theme-card is-dark ${app.theme === 'dark' ? 'is-selected' : ''}"
            data-set-theme="dark"
            aria-pressed="${app.theme === 'dark'}"
          >
            <div class="sg-theme-preview is-dark" aria-hidden="true">
              <div class="sg-tp-bar">
                <span class="sg-tp-dot"></span>
                <span class="sg-tp-dot"></span>
                <span class="sg-tp-pill"></span>
              </div>
              <div class="sg-tp-body">
                <div class="sg-tp-rail">
                  <span class="sg-tp-rail-line is-active"></span>
                  <span class="sg-tp-rail-line"></span>
                  <span class="sg-tp-rail-line"></span>
                </div>
                <div class="sg-tp-canvas">
                  <div class="sg-tp-sheet">
                    <span class="sg-tp-ink is-accent"></span>
                    <span class="sg-tp-ink"></span>
                    <span class="sg-tp-ink is-short"></span>
                  </div>
                </div>
              </div>
            </div>
            <div class="sg-theme-foot">
              <div class="sg-theme-meta">
                <span class="sg-theme-name">${t('settings.dark')}</span>
                <span class="sg-theme-caption">${tr('Obsidian studio · Low glare', 'تاریک عمیق · مناسب مطالعه شب')}</span>
              </div>
              <span class="sg-check-indicator" aria-hidden="true">${getIconSvg('check', 12)}</span>
            </div>
          </button>

          <button
            type="button"
            class="sg-theme-card is-light ${app.theme === 'light' ? 'is-selected' : ''}"
            data-set-theme="light"
            aria-pressed="${app.theme === 'light'}"
          >
            <div class="sg-theme-preview is-light" aria-hidden="true">
              <div class="sg-tp-bar">
                <span class="sg-tp-dot"></span>
                <span class="sg-tp-dot"></span>
                <span class="sg-tp-pill"></span>
              </div>
              <div class="sg-tp-body">
                <div class="sg-tp-rail">
                  <span class="sg-tp-rail-line is-active"></span>
                  <span class="sg-tp-rail-line"></span>
                  <span class="sg-tp-rail-line"></span>
                </div>
                <div class="sg-tp-canvas">
                  <div class="sg-tp-sheet">
                    <span class="sg-tp-ink is-accent"></span>
                    <span class="sg-tp-ink"></span>
                    <span class="sg-tp-ink is-short"></span>
                  </div>
                </div>
              </div>
            </div>
            <div class="sg-theme-foot">
              <div class="sg-theme-meta">
                <span class="sg-theme-name">${t('settings.light')}</span>
                <span class="sg-theme-caption">${tr('Crisp daylight · High contrast', 'روشن کاغذی · وضوح بالا در روز')}</span>
              </div>
              <span class="sg-check-indicator" aria-hidden="true">${getIconSvg('check', 12)}</span>
            </div>
          </button>
        </div>
      </section>

      <!-- Accent Hue -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Accent Brand Color', 'رنگ شاخص برنامه')}</h3>
          <span class="sg-meta-mono" id="accent-hex-display">${activeAccent}</span>
        </div>
        <div class="sg-group">
          <div class="sg-row sg-accent-row">
            <div class="sg-swatch-list">
              ${accents
                .map((a) => {
                  const selected = activeAccent === a.color.toUpperCase();
                  return `
                    <button
                      type="button"
                      class="sg-accent-swatch ${selected ? 'is-selected' : ''}"
                      style="--swatch-color:${a.color};"
                      data-set-accent="${a.color}"
                      title="${a.name}"
                      aria-label="${a.name}"
                      aria-pressed="${selected}"
                    >
                      ${selected ? getIconSvg('check', 12) : ''}
                    </button>
                  `;
                })
                .join('')}
            </div>
            <label class="sg-custom-color" title="${tr('Pick any custom accent color', 'انتخاب رنگ دلخواه')}">
              <span class="sg-custom-swatch" style="background:${activeAccent};">
                <input type="color" id="custom-accent-picker" class="sg-custom-input" value="${app.accentColor || DEFAULT_ACCENT}">
              </span>
              <span class="sg-custom-label">${tr('Custom', 'دلخواه')}</span>
            </label>
          </div>
        </div>
      </section>

      <!-- Paper Background Pattern -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Canvas Paper Overlay', 'الگوی کمکی پس‌زمینه')}</h3>
          <span class="sg-meta-quiet">${tr('Overlay guide for PDFs & notes', 'راهنمای بصری روی صفحات')}</span>
        </div>
        <div class="sg-pattern-grid">
          ${patterns
            .map((p) => {
              const selected = (app.backgroundPattern || 'none') === p.id;
              return `
                <button
                  type="button"
                  class="sg-pattern-card ${selected ? 'is-selected' : ''}"
                  data-set-pattern="${p.id}"
                  aria-pressed="${selected}"
                >
                  <span class="sg-pattern-thumb is-${p.id}" aria-hidden="true"></span>
                  <span class="sg-pattern-title">${p.label}</span>
                  <span class="sg-pattern-hint">${p.hint}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>

      <!-- Layout & Fullscreen -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Interface & Fullscreen', 'تراکم و تمام‌صفحه')}</h3>
        </div>
        <div class="sg-group">
          <div class="sg-row">
            <div class="sg-row-body">
              <div class="sg-row-title">${tr('Interface Density', 'تراکم عناصر رابط کاربری')}</div>
              <div class="sg-row-desc">${tr('Choose between airy studio spacing or tighter compact chrome for smaller screens.', 'انتخاب میان فضای باز و راحت یا چیدمان فشرده‌تر برای نمایشگرهای کوچک‌تر.')}</div>
            </div>
            <div class="sg-segmented" role="group" aria-label="${tr('Interface Density', 'تراکم رابط کاربری')}">
              <button
                type="button"
                class="sg-seg-btn ${app.uiDensity !== 'compact' ? 'is-active' : ''}"
                data-set-density="comfortable"
                aria-pressed="${app.uiDensity !== 'compact'}"
              >${tr('Comfortable', 'استاندارد')}</button>
              <button
                type="button"
                class="sg-seg-btn ${app.uiDensity === 'compact' ? 'is-active' : ''}"
                data-set-density="compact"
                aria-pressed="${app.uiDensity === 'compact'}"
              >${tr('Compact', 'فشرده')}</button>
            </div>
          </div>

          ${renderSwitchRow({
            dataAttr: 'data-fullscreen-autohide-toggle',
            checked: app.autoHideHeaderInFullscreen !== false,
            title: t('settings.autoHideFullscreen'),
            desc: t('settings.autoHideFullscreenDesc'),
            note: tr(
              'Move your cursor to the top edge of the screen—or press Esc—to reveal the header and tabs at any moment.',
              'برای نمایش مجدد نوار بالا در حالت تمام‌صفحه کافی است نشانگر ماوس را به لبه بالایی ببرید یا کلید Esc را فشار دهید.'
            ),
          })}
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 2. TOOLBAR
 * -------------------------------------------------------------------------- */
function renderToolbarTab(app: AppSettings, layout: ToolbarLayoutEntry[]): string {
  const visibleCount = layout.filter((l) => l.visible).length;
  const dockOptions: { edge: 'top' | 'bottom' | 'left' | 'right'; label: string }[] = [
    { edge: 'top', label: tr('Top', 'بالا') },
    { edge: 'bottom', label: tr('Bottom', 'پایین') },
    { edge: 'left', label: tr('Left', 'چپ') },
    { edge: 'right', label: tr('Right', 'راست') },
  ];

  return `
    <div class="sg-pane">
      <!-- Dock Position Visual Diagrams -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Dock Position', 'محل قرارگیری نوار ابزار')}</h3>
          <span class="sg-meta-quiet">${
            app.toolbarDock === 'float'
              ? tr('Currently floating freely', 'هم‌اکنون شناور آزاد')
              : tr('Snap to workspace edge', 'اتصال به لبه صفحه')
          }</span>
        </div>
        <div class="sg-dock-grid">
          ${dockOptions
            .map((d) => {
              const selected = app.toolbarDock === d.edge;
              return `
                <button
                  type="button"
                  class="sg-dock-card ${selected ? 'is-selected' : ''}"
                  data-set-dock="${d.edge}"
                  aria-pressed="${selected}"
                >
                  <span class="sg-dock-frame is-${d.edge}" aria-hidden="true">
                    <span class="sg-dock-bar"></span>
                    <span class="sg-dock-page"></span>
                  </span>
                  <span class="sg-dock-label">${d.label}</span>
                </button>
              `;
            })
            .join('')}
        </div>
        ${
          app.toolbarDock === 'float'
            ? renderNote(
                tr(
                  'Toolbar is currently free-floating on the canvas. Drag its grip handle to any edge to dock it, or pick an edge above.',
                  'نوار ابزار هم‌اکنون به‌صورت شناور آزاد است؛ با کشیدن دستگیره به لبه‌ها می‌چسبد یا از گزینه‌های بالا لبه دلخواه را انتخاب کنید.'
                )
              )
            : ''
        }
      </section>

      <!-- Tools Visibility & Ordering -->
      <section class="sg-section">
        <div class="sg-section-head">
          <div class="sg-section-head-left">
            <h3 class="sg-heading">${tr('Visible Tools & Order', 'ابزارهای فعال و ترتیب چیدمان')}</h3>
            <span class="sg-meta-mono">${visibleCount} / ${layout.length}</span>
          </div>
          <button type="button" id="toolbar-layout-reset-btn" class="sg-inline-btn">
            ${getIconSvg('rotate', 12)}
            <span>${tr('Reset Defaults', 'بازنشانی پیش‌فرض')}</span>
          </button>
        </div>

        <div class="sg-group sg-toolbar-group" id="toolbar-list">
          ${layout
            .map(
              (item, idx) => `
            <div class="sg-tool-row ${item.visible ? '' : 'is-dimmed'}" data-toolbar-row="${item.id}">
              <span class="sg-tool-icon">${getIconSvg(TOOLBAR_ICONS[item.id] ?? 'pen', 15)}</span>
              <span class="sg-tool-name">${getToolShortLabel(item.id)}</span>
              <div class="sg-tool-actions">
                <div class="sg-order-btns">
                  <button
                    type="button"
                    class="sg-order-btn"
                    data-toolbar-up="${item.id}"
                    title="${tr('Move earlier', 'انتقال به بالاتر')}"
                    aria-label="${tr('Move up', 'انتقال به بالا')}: ${getToolShortLabel(item.id)}"
                    ${idx === 0 ? 'disabled' : ''}
                  >${getIconSvg('chevronUp', 13)}</button>
                  <button
                    type="button"
                    class="sg-order-btn"
                    data-toolbar-down="${item.id}"
                    title="${tr('Move later', 'انتقال به پایین‌تر')}"
                    aria-label="${tr('Move down', 'انتقال به پایین')}: ${getToolShortLabel(item.id)}"
                    ${idx === layout.length - 1 ? 'disabled' : ''}
                  >${getIconSvg('chevronDown', 13)}</button>
                </div>
                <label class="setting-switch" title="${tr('Show in toolbar', 'نمایش در نوار ابزار')}">
                  <input type="checkbox" data-toolbar-visible="${item.id}" ${item.visible ? 'checked' : ''}>
                  <span class="setting-slider"></span>
                </label>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 3. PEN & INPUT
 * -------------------------------------------------------------------------- */
function renderInputTab(tools: ToolSettings): string {
  const pressureEnabled = tools.pressureSensitivityEnabled !== false;
  const currentCurve = tools.pressureCurve || 'linear';
  const currentStrength = tools.pressureStrength || 'balanced';
  const currentSmoothing = tools.strokeSmoothing || 'medium';

  const curves: {
    id: ToolSettings['pressureCurve'];
    label: string;
    caption: string;
    path: string;
  }[] = [
    {
      id: 'linear',
      label: tr('Linear', 'خطی'),
      caption: tr('True 1:1 response', 'پاسخ‌دهی ۱ به ۱'),
      path: 'M 4 32 L 52 4',
    },
    {
      id: 'soft',
      label: tr('Soft', 'نرم'),
      caption: tr('Light hand touch', 'مناسب فشار ملایم'),
      path: 'M 4 32 Q 14 8 52 4',
    },
    {
      id: 'firm',
      label: tr('Firm', 'سفت'),
      caption: tr('Controlled & bold', 'کنترل بالا و خوشنویسی'),
      path: 'M 4 32 Q 40 28 52 4',
    },
    {
      id: 'exponential',
      label: tr('Exponential', 'نمایی'),
      caption: tr('Dramatic contrast', 'تفاوت شدید ضخامت'),
      path: 'M 4 32 C 30 32 46 24 52 4',
    },
  ];

  const strengths: {
    id: ToolSettings['pressureStrength'];
    label: string;
    range: string;
    strokePath: string;
  }[] = [
    {
      id: 'light',
      label: tr('Subtle', 'ملایم'),
      range: '0.6× – 1.4×',
      strokePath: 'M 6 12 C 28 10 56 10 84 11 C 56 15 28 15 6 14 Z',
    },
    {
      id: 'balanced',
      label: tr('Balanced', 'متعادل'),
      range: '0.3× – 1.8×',
      strokePath: 'M 6 12 C 30 8 58 7 84 11 C 58 17 30 16 6 13 Z',
    },
    {
      id: 'strong',
      label: tr('Dramatic', 'قوی'),
      range: '0.1× – 2.4×',
      strokePath: 'M 6 12.2 C 30 5.5 60 4 84 11.5 C 60 20 30 18.5 6 12.8 Z',
    },
  ];

  const smoothingOptions: { id: ToolSettings['strokeSmoothing']; label: string }[] = [
    { id: 'none', label: tr('None', 'خاموش') },
    { id: 'subtle', label: tr('Subtle', 'ملایم') },
    { id: 'medium', label: tr('Medium', 'متوسط') },
    { id: 'high', label: tr('High', 'زیاد') },
  ];

  return `
    <div class="sg-pane">
      <!-- Pressure Switches -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Pressure Dynamics', 'پویایی و حساسیت به فشار')}</h3>
        </div>
        <div class="sg-group">
          ${renderSwitchRow({
            id: 'pressure-master-toggle',
            checked: pressureEnabled,
            title: tr('Dynamic Pressure Sensitivity', 'حساسیت پویا به فشار قلم'),
            desc: tr(
              'Modulate stroke thickness organically from stylus force.',
              'تغییر طبیعی ضخامت خط متناسب با میزان فشار دست روی قلم نوری.'
            ),
            note: tr(
              'Turn this off when sketching technical diagrams, equations, or charts where perfectly uniform stroke width is preferred.',
              'هنگام رسم نمودارهای فنی، معادلات ریاضی یا اشکالی که ضخامت کاملاً یکنواخت می‌خواهید، این گزینه را خاموش کنید.'
            ),
          })}

          ${renderSwitchRow({
            id: 'mouse-pressure-toggle',
            checked: !!tools.mousePressureSimulation,
            title: tr('Simulate Pressure with Pointer Speed', 'شبیه‌سازی فشار با سرعت حرکت ماوس'),
            desc: tr(
              'Emulate fountain-pen taper from cursor velocity when drawing with a mouse or trackpad.',
              'شبیه‌سازی ظرافت قلم بر اساس سرعت حرکت دست هنگام نوشتن با ماوس یا تاچ‌پد.'
            ),
            note: tr(
              'Faster strokes taper thinner while slower strokes thicken. Automatically ignored whenever a real pressure-sensitive stylus is detected.',
              'حرکت سریع‌تر خط را نازک‌تر و حرکت آرام‌تر آن را ضخیم‌تر می‌کند. در صورت اتصال قلم نوری واقعی، به‌طور خودکار از فشار واقعی قلم استفاده می‌شود.'
            ),
          })}
        </div>
      </section>

      <!-- Visual Pressure Curve Picker -->
      <section class="sg-section ${pressureEnabled ? '' : 'is-soft-disabled'}">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Pressure Response Curve', 'منحنی پاسخ‌دهی فشار')}</h3>
          <span class="sg-meta-quiet">${tr('Force → stroke width mapping', 'تبدیل فشار به ضخامت')}</span>
        </div>
        <div class="sg-curve-grid">
          ${curves
            .map((c) => {
              const selected = currentCurve === c.id;
              return `
                <button
                  type="button"
                  class="sg-curve-card ${selected ? 'is-selected' : ''}"
                  data-set-curve="${c.id}"
                  aria-pressed="${selected}"
                >
                  <svg class="sg-curve-svg" viewBox="0 0 56 36" fill="none" aria-hidden="true">
                    <line x1="4" y1="32" x2="52" y2="32" class="sg-curve-axis" />
                    <line x1="4" y1="4" x2="4" y2="32" class="sg-curve-axis" />
                    <line x1="4" y1="18" x2="52" y2="18" class="sg-curve-gridline" />
                    <line x1="28" y1="4" x2="28" y2="32" class="sg-curve-gridline" />
                    <path d="${c.path}" class="sg-curve-line" />
                    <circle cx="52" cy="4" r="2.2" class="sg-curve-end" />
                  </svg>
                  <span class="sg-curve-name">${c.label}</span>
                  <span class="sg-curve-cap">${c.caption}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>

      <!-- Dynamic Thickness Range -->
      <section class="sg-section ${pressureEnabled ? '' : 'is-soft-disabled'}">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Pressure Thickness Range', 'دامنه تغییر ضخامت با فشار')}</h3>
        </div>
        <div class="sg-taper-grid">
          ${strengths
            .map((s) => {
              const selected = currentStrength === s.id;
              return `
                <button
                  type="button"
                  class="sg-taper-card ${selected ? 'is-selected' : ''}"
                  data-set-pressure-strength="${s.id}"
                  aria-pressed="${selected}"
                >
                  <svg class="sg-taper-svg" viewBox="0 0 90 24" aria-hidden="true">
                    <path d="${s.strokePath}" class="sg-taper-path" />
                  </svg>
                  <div class="sg-taper-meta">
                    <span class="sg-taper-name">${s.label}</span>
                    <span class="sg-taper-range">${s.range}</span>
                  </div>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>

      <!-- Stabilization & Stylus Hardware -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Stabilization & Stylus Hardware', 'لرزش‌گیر دست‌خط و سخت‌افزار قلم')}</h3>
        </div>
        <div class="sg-group">
          <div class="sg-row sg-row-stacked">
            <div class="sg-row-top-split">
              <div class="sg-row-body">
                <div class="sg-row-title">${tr('Stroke Smoothing', 'نرم‌سازی و لرزش‌گیر دست‌خط')}</div>
                <div class="sg-row-desc">${tr('Filter micro-jitter while keeping live ink faithful to your hand.', 'حذف لرزش‌های ریز دست هنگام نوشتن بدون تغییر فرم اصلی خط.')}</div>
              </div>
              <div class="sg-segmented" role="group" aria-label="${tr('Stroke Smoothing', 'نرم‌سازی دست‌خط')}">
                ${smoothingOptions
                  .map(
                    (opt) => `
                  <button
                    type="button"
                    class="sg-seg-btn ${currentSmoothing === opt.id ? 'is-active' : ''}"
                    data-set-smoothing="${opt.id}"
                    aria-pressed="${currentSmoothing === opt.id}"
                  >${opt.label}</button>
                `
                  )
                  .join('')}
              </div>
            </div>
            ${renderNote(
              tr(
                'None captures raw 1:1 pointer coordinates with zero filtering. Subtle and Medium gently dampen hand tremor without altering where your stroke ends.',
                'حالت «خاموش» نقاط ورودی قلم را بدون هیچ فیلتری ثبت می‌کند. حالت‌های «ملایم» و «متوسط» لرزش دست را می‌گیرند بدون آنکه انتهای خط شما را تغییر دهند.'
              )
            )}
          </div>

          ${renderSwitchRow({
            id: 'palm-toggle',
            checked: !!tools.palmRejectionEnabled,
            title: tr('Intelligent Palm Rejection', 'تشخیص هوشمند کف دست (Palm Rejection)'),
            desc: tr(
              'Ignores accidental wrist and palm touches while writing with an active stylus.',
              'نادیده گرفتن برخورد تصادفی مچ و کف دست با نمایشگر هنگام نوشتن با قلم نوری.'
            ),
            note: tr(
              'Recommended for tablets and 2-in-1 touchscreens. Only disable this if you intentionally draw with your finger while holding a stylus.',
              'برای تبلت‌ها و لپ‌تاپ‌های لمسی بسیار توصیه می‌شود. فقط در صورتی خاموش کنید که بخواهید هم‌زمان با انگشت و قلم طراحی کنید.'
            ),
          })}

          ${renderSwitchRow({
            id: 'inverted-eraser-toggle',
            checked: tools.stylusInvertedEraserEnabled !== false,
            title: tr('Stylus Inverted Tip & Barrel Eraser', 'پاک‌کن خودکار با دکمه یا تهِ قلم نوری'),
            desc: tr(
              'Automatically switches to the eraser when using your stylus eraser button or tail end.',
              'فعال شدن خودکار پاک‌کن هنگام فشردن دکمه پاک‌کن روی بدنه قلم یا استفاده از سرِ پشتی آن.'
            ),
            note: tr(
              'Your previous drawing tool is restored immediately once you release the stylus eraser button or flip the pen back.',
              'به‌محض رها کردن دکمه پاک‌کن یا برگرداندن قلم، ابزار قبلی شما به‌طور خودکار برمی‌گردد.'
            ),
          })}
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 4. KEYBOARD SHORTCUTS
 * -------------------------------------------------------------------------- */
function renderShortcutsTab(bindings: Record<ShortcutAction, string>): string {
  const formatKeycap = (raw: string) => {
    if (raw === 'space') return 'Space';
    return raw.length === 1 ? raw.toUpperCase() : raw;
  };

  const actionMeta: Record<ShortcutAction, { descEn: string; descFa: string }> = {
    select: { descEn: 'Select, move & resize', descFa: 'انتخاب و تغییر اندازه' },
    hand: { descEn: 'Pan across pages', descFa: 'جابه‌جایی آزاد صفحه' },
    lasso: { descEn: 'Freehand lasso select', descFa: 'انتخاب کمندی آزاد' },
    pen: { descEn: 'Pressure ink stylus', descFa: 'قلم رسم حساس به فشار' },
    highlighter: { descEn: 'Translucent marker', descFa: 'ماژیک هایلایت شفاف' },
    eraser: { descEn: 'Stroke & point eraser', descFa: 'پاک‌کن خطی یا نقطه‌ای' },
    rectangle: { descEn: 'Box & rounded frame', descFa: 'مستطیل و کادر' },
    ellipse: { descEn: 'Circle or oval shape', descFa: 'دایره و بیضی' },
    line: { descEn: 'Straight segment', descFa: 'خط مستقیم' },
    arrow: { descEn: 'Directional pointer', descFa: 'پیکان جهت‌دار' },
    polygon: { descEn: 'Multi-point shape', descFa: 'چندضلعی دلخواه' },
    text: { descEn: 'Editable text box', descFa: 'افزودن کادر متن' },
    stamp: { descEn: 'Stamps & custom image', descFa: 'مهر آماده و تصویر' },
  };

  const groups: { titleEn: string; titleFa: string; icon: string; items: ShortcutAction[] }[] = [
    {
      titleEn: 'Navigation & Selection',
      titleFa: 'پیمایش و انتخاب',
      icon: 'select',
      items: ['select', 'hand', 'lasso'],
    },
    {
      titleEn: 'Ink & Erasing',
      titleFa: 'نگارش و پاک‌کردن',
      icon: 'pen',
      items: ['pen', 'highlighter', 'eraser'],
    },
    {
      titleEn: 'Shapes, Text & Markup',
      titleFa: 'اشکال، متن و نشانه‌گذاری',
      icon: 'rectangle',
      items: ['rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'text', 'stamp'],
    },
  ];

  const renderRow = (action: ShortcutAction) => {
    const raw = bindings[action];
    const keyLabel = formatKeycap(raw);
    const isSpace = raw === 'space';
    const meta = actionMeta[action];
    const iconName = TOOLBAR_ICONS[action] ?? 'pen';
    return `
      <button type="button" class="sc-row" data-rebind="${action}" aria-label="${getToolShortLabel(action)} (${keyLabel})">
        <span class="sc-row-icon">${getIconSvg(iconName, 15)}</span>
        <span class="sc-row-info">
          <span class="sc-row-title">${getToolShortLabel(action)}</span>
          <span class="sc-row-desc">${tr(meta.descEn, meta.descFa)}</span>
        </span>
        <span class="sc-row-key">
          <kbd class="sc-keycap ${isSpace ? 'is-wide' : ''}">${keyLabel}</kbd>
        </span>
      </button>`;
  };

  const systemHints = [
    { labelEn: 'Undo / Redo', labelFa: 'بازگشت / تکرار عمل', keys: ['Ctrl + Z', 'Ctrl + Shift + Z'] },
    { labelEn: 'Print Document', labelFa: 'چاپ سند', keys: ['Ctrl + P'] },
    { labelEn: 'Lock Aspect Ratio', labelFa: 'حفظ تناسب اندازه', keys: ['Shift + Drag'] },
    { labelEn: 'Temporary Hand Pan', labelFa: 'جابه‌جایی موقت صفحه', keys: ['Space'] },
  ];

  return `
    <div class="sg-pane sc-root">
      <div class="sg-section-head">
        <span class="sg-meta-quiet">${tr('All changes save immediately to your local profile.', 'تمام تغییرات بلافاصله ذخیره می‌شوند.')}</span>
        <button type="button" id="shortcuts-reset-btn" class="sg-inline-btn">
          ${getIconSvg('rotate', 12)}
          <span>${tr('Reset to Defaults', 'بازنشانی پیش‌فرض')}</span>
        </button>
      </div>

      <div class="sc-conflict-banner" id="shortcut-conflict" role="status" aria-live="polite"></div>

      <div class="sc-groups" id="shortcut-rows">
        ${groups
          .map(
            (group) => `
          <section class="sc-group">
            <div class="sc-group-header">
              <span class="sc-group-icon">${getIconSvg(group.icon, 13)}</span>
              <span class="sc-group-title">${tr(group.titleEn, group.titleFa)}</span>
            </div>
            <div class="sc-grid">
              ${group.items.map(renderRow).join('')}
            </div>
          </section>
        `
          )
          .join('')}

        <section class="sc-group sc-group-ref">
          <div class="sc-group-header">
            <span class="sc-group-icon">${getIconSvg('command', 13)}</span>
            <span class="sc-group-title">${tr('Built-in Editor Controls', 'میانبرهای ثابت ویرایشگر')}</span>
          </div>
          <div class="sc-ref-list">
            ${systemHints
              .map(
                (h) => `
              <div class="sc-ref-item">
                <span class="sc-ref-label">${tr(h.labelEn, h.labelFa)}</span>
                <span class="sc-ref-keys">
                  ${h.keys.map((k) => `<kbd class="sc-keycap is-static">${k}</kbd>`).join('')}
                </span>
              </div>
            `
              )
              .join('')}
          </div>
        </section>
      </div>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 5. VIEWER & READING
 * -------------------------------------------------------------------------- */
function renderViewerTab(app: AppSettings): string {
  const viewModes: {
    id: AppSettings['defaultViewMode'];
    label: string;
    caption: string;
  }[] = [
    {
      id: 'continuous',
      label: tr('Continuous', 'پیوسته'),
      caption: tr('Seamless vertical stream', 'پیمایش عمودی پشت‌سرهم'),
    },
    {
      id: 'single',
      label: tr('Single Page', 'تک‌صفحه‌ای'),
      caption: tr('Focused one-page view', 'تمرکز روی یک برگه'),
    },
    {
      id: 'two-page',
      label: tr('Book Spread', 'دوصفحه‌ای'),
      caption: tr('Facing two-page spread', 'نمایش روبه‌رو مانند کتاب'),
    },
  ];

  const zoomOptions: { id: AppSettings['defaultZoomMode']; label: string }[] = [
    { id: 'fitWidth', label: tr('Fit Width', 'عرض صفحه') },
    { id: 'fitPage', label: tr('Fit Page', 'کل صفحه') },
    { id: '100%', label: '100%' },
    { id: '125%', label: '125%' },
    { id: '150%', label: '150%' },
  ];

  return `
    <div class="sg-pane">
      <!-- Page Flow Visual Cards -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Default Page Layout', 'چیدمان پیش‌فرض صفحات')}</h3>
        </div>
        <div class="sg-viewmode-grid">
          ${viewModes
            .map((m) => {
              const selected = (app.defaultViewMode || 'continuous') === m.id;
              return `
                <button
                  type="button"
                  class="sg-viewmode-card ${selected ? 'is-selected' : ''}"
                  data-set-view-mode="${m.id}"
                  aria-pressed="${selected}"
                >
                  <span class="sg-vm-diagram is-${m.id}" aria-hidden="true">
                    ${
                      m.id === 'continuous'
                        ? '<span class="sg-vm-sheet"></span><span class="sg-vm-sheet is-peek"></span>'
                        : m.id === 'single'
                        ? '<span class="sg-vm-sheet is-solo"></span>'
                        : '<span class="sg-vm-spread"><span class="sg-vm-sheet"></span><span class="sg-vm-sheet"></span></span>'
                    }
                  </span>
                  <span class="sg-vm-title">${m.label}</span>
                  <span class="sg-vm-cap">${m.caption}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>

      <!-- Opening Zoom Preset -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Opening Zoom Level', 'بزرگ‌نمایی پیش‌فرض')}</h3>
        </div>
        <div class="sg-group">
          <div class="sg-row sg-row-stacked">
            <div class="sg-row-body">
              <div class="sg-row-title">${tr('Default Zoom Preset', 'مقیاس اولیه هنگام باز کردن سند')}</div>
              <div class="sg-row-desc">${tr('Applied immediately to the active document and used whenever new files open.', 'بلافاصله روی سند فعلی اعمال می‌شود و پیش‌فرض فایل‌های جدید خواهد بود.')}</div>
            </div>
            <div class="sg-segmented is-full" role="group" aria-label="${tr('Default Zoom Level', 'بزرگ‌نمایی پیش‌فرض')}">
              ${zoomOptions
                .map(
                  (z) => `
                <button
                  type="button"
                  class="sg-seg-btn sg-seg-mono ${(app.defaultZoomMode || 'fitWidth') === z.id ? 'is-active' : ''}"
                  data-set-zoom-preset="${z.id}"
                  aria-pressed="${(app.defaultZoomMode || 'fitWidth') === z.id}"
                >${z.label}</button>
              `
                )
                .join('')}
            </div>
          </div>
        </div>
      </section>

      <!-- Reading Comfort Switches -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Reading Comfort & Fullscreen', 'راحتی مطالعه و تمام‌صفحه')}</h3>
        </div>
        <div class="sg-group">
          ${renderSwitchRow({
            dataAttr: 'data-fullscreen-autohide-toggle',
            checked: app.autoHideHeaderInFullscreen !== false,
            title: t('settings.autoHideFullscreen'),
            desc: t('settings.autoHideFullscreenDesc'),
            note: tr(
              'Hover near the top edge of your screen—or press Esc—to temporarily reveal the navigation bar without leaving fullscreen.',
              'با بردن نشانگر ماوس به لبه بالای صفحه یا زدن کلید Esc، نوار بالا بدون خروج از حالت تمام‌صفحه نمایش داده می‌شود.'
            ),
          })}

          ${renderSwitchRow({
            id: 'shadows-toggle',
            checked: app.showPageShadows !== false,
            title: tr('Realistic Page Drop Shadows', 'سایه طبیعی دور صفحات'),
            desc: tr(
              'Renders soft depth elevation around each PDF page sheet.',
              'نمایش سایه نرم در اطراف هر برگه برای تفکیک بهتر از پس‌زمینه.'
            ),
            note: tr(
              'Improves visual contrast between paper and canvas. Turning shadows off can save battery and reduce GPU load on older laptops.',
              'تفکیک بصری برگه‌ها را بهتر می‌کند. خاموش کردن آن می‌تواند مصرف باتری و فشار گرافیکی را در دستگاه‌های قدیمی‌تر کاهش دهد.'
            ),
          })}

          ${renderSwitchRow({
            id: 'smooth-scroll-toggle',
            checked: app.smoothScroll !== false,
            title: tr('Smooth Scrolling Dynamics', 'پیمایش نرم هنگام پرش بین صفحات'),
            desc: tr(
              'Applies fluid easing when jumping to pages from thumbnails, bookmarks, or search.',
              'حرکت نرم و پیوسته هنگام پرش به صفحات از طریق فهرست، نشانک‌ها یا جستجو.'
            ),
            note: tr(
              'Applies only to programmatic page jumps—regular mouse wheel and trackpad scrolling always stays direct and instantaneous.',
              'فقط برای پرش خودکار به صفحات اعمال می‌شود؛ اسکرول مستقیم با ماوس یا تاچ‌پد همیشه بدون تأخیر و آنی باقی می‌ماند.'
            ),
          })}
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 6. PERFORMANCE
 * -------------------------------------------------------------------------- */
function renderPerformanceTab(app: AppSettings): string {
  const effectiveDpi = Math.round(app.targetDPI || 150);
  const requestedScale = resolveRenderDpr(effectiveDpi);
  const cappedScale = clampRenderMultiplier(612, 792, requestedScale);
  const capped = cappedScale < requestedScale - 1e-6;
  const effectiveLabel = `${(capped ? cappedScale : requestedScale).toFixed(2)}× · ${
    capped ? Math.round(cappedScale * 72) : effectiveDpi
  } DPI`;

  const dpiHint = capped
    ? tr(
        `Each canvas axis is safely capped at 4096 px to prevent GPU texture eviction. Zoom in closer to unlock the full ${effectiveDpi} DPI resolution.`,
        `برای جلوگیری از پر شدن حافظه گرافیکی، هر ضلع بوم به ۴۰۹۶ پیکسل محدود شده است. با بزرگ‌نمایی بیشتر تمام دقت ${effectiveDpi} DPI اعمال می‌شود.`
      )
    : tr(
        `Higher DPI produces crisper fine typography and vector diagrams at the cost of higher RAM and VRAM usage.`,
        `مقادیر بالاتر DPI وضوح متن‌های ریز و نمودارها را افزایش می‌دهند، اما مصرف رم و حافظه گرافیکی را بیشتر می‌کنند.`
      );

  const rawPreload = app.maxRenderBufferPages || 3;
  const preloadPages = rawPreload <= 1 ? 1 : rawPreload >= 5 ? 5 : 3;
  const preloadOptions = [
    {
      val: 1,
      figure: '1',
      label: tr('Ultra-Light', 'فوق‌سبک'),
      desc: tr('Minimal memory · Ideal for 8 GB laptops', 'کمترین مصرف رم · مناسب سیستم‌های سبک'),
    },
    {
      val: 3,
      figure: '3',
      label: tr('Balanced', 'متعادل'),
      desc: tr('Recommended · Smooth everyday reading', 'پیشنهادی · تعادل عالی سرعت و رم'),
    },
    {
      val: 5,
      figure: '5',
      label: tr('Rapid Flip', 'ورق‌زدن سریع'),
      desc: tr('Pre-renders ahead for fast skimming', 'آماده‌سازی بیشتر برای مرور سریع کتاب‌ها'),
    },
  ];

  return `
    <div class="sg-pane">
      <!-- Engine Summary Strip -->
      <div class="sg-callout-strip">
        <span class="sg-callout-icon" aria-hidden="true">${getIconSvg('zap', 15)}</span>
        <div class="sg-callout-copy">
          <div class="sg-callout-title">${tr('Automatic Viewport Memory Recycling', 'بازیافت هوشمند حافظه صفحات خارج از دید')}</div>
          <div class="sg-callout-text">${tr(
            'Off-screen page canvases automatically shrink to 1×1 pixels when scrolled out of range, keeping multi-hundred-page textbooks fast and lightweight.',
            'بوم صفحاتی که از کادر دید خارج می‌شوند به‌طور خودکار آزاد می‌گردند تا حتی در کتاب‌های چندصد صفحه‌ای مصرف رم بسیار پایین بماند.'
          )}</div>
        </div>
      </div>

      <!-- Canvas Render DPI -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Canvas Render Resolution', 'وضوح رندر صفحات (DPI)')}</h3>
          <span class="sg-meta-mono">${effectiveLabel}</span>
        </div>
        <div class="sg-group">
          <div class="sg-row sg-row-stacked">
            <div class="sg-dpi-bar">
              <div class="sg-dpi-input-wrap">
                <input
                  type="number"
                  id="target-dpi-input"
                  class="field sg-dpi-input"
                  min="72"
                  max="600"
                  step="1"
                  value="${effectiveDpi}"
                  aria-label="${tr('Canvas Render Resolution (DPI)', 'وضوح رندر صفحات (DPI)')}"
                />
                <span class="sg-dpi-unit">DPI</span>
              </div>
              <div class="sg-segmented" role="group" aria-label="${tr('DPI presets', 'مقادیر آماده DPI')}">
                ${[72, 150, 300, 600]
                  .map(
                    (d) => `
                  <button
                    type="button"
                    class="sg-seg-btn sg-seg-mono ${effectiveDpi === d ? 'is-active' : ''}"
                    data-dpi-preset="${d}"
                    aria-pressed="${effectiveDpi === d}"
                  >${d}</button>
                `
                  )
                  .join('')}
              </div>
            </div>
            <div class="sg-note" id="dpi-effective-hint">
              <span class="sg-note-icon" aria-hidden="true">${getIconSvg('info', 12)}</span>
              <span class="sg-note-text">${dpiHint}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Preload Buffer -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Off-screen Page Preload Buffer', 'بافر پیش‌بارگذاری صفحات')}</h3>
          <span class="sg-meta-quiet">${tr('Pages rendered ahead & behind', 'تعداد صفحات آماده در اطراف')}</span>
        </div>
        <div class="sg-buffer-grid">
          ${preloadOptions
            .map((opt) => {
              const selected = preloadPages === opt.val;
              return `
                <button
                  type="button"
                  class="sg-buffer-card ${selected ? 'is-selected' : ''}"
                  data-set-preload="${opt.val}"
                  aria-pressed="${selected}"
                >
                  <span class="sg-buffer-num">${opt.figure}<span class="sg-buffer-unit">${tr('pg', 'ص')}</span></span>
                  <span class="sg-buffer-label">${opt.label}</span>
                  <span class="sg-buffer-desc">${opt.desc}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>

      <!-- Cache Flush -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Memory Maintenance', 'مدیریت حافظه گرافیکی')}</h3>
        </div>
        <div class="sg-group">
          <div class="sg-row">
            <div class="sg-row-body">
              <div class="sg-row-title">${tr('Flush Render Cache', 'پاک‌سازی کش رندر صفحات')}</div>
              <div class="sg-row-desc">${tr('Immediately reclaims cached page bitmaps from GPU memory and repaints the visible viewport.', 'حافظه گرافیکی صفحات کش‌شده را فوراً آزاد می‌کند و صفحه فعلی را دوباره رندر می‌نماید.')}</div>
              ${renderNote(
                tr(
                  'Safe to use anytime—your open documents, annotations, and undo history stay completely untouched.',
                  'استفاده از آن کاملاً بی‌خطر است؛ اسناد باز، یادداشت‌ها و تاریخچه ویرایش شما هیچ تغییری نمی‌کنند.'
                )
              )}
            </div>
            <button type="button" id="flush-cache-btn" class="secondary-btn sg-action-btn">
              ${getIconSvg('refresh', 13)}
              <span>${tr('Flush Cache', 'آزادسازی کش')}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 7. STORAGE & BACKUP
 * -------------------------------------------------------------------------- */
function renderStorageTab(app: AppSettings): string {
  const interval = app.autoSaveIntervalMs || 15000;
  const intervals = [
    { val: 5000, label: tr('5 sec', '۵ ثانیه') },
    { val: 15000, label: tr('15 sec', '۱۵ ثانیه') },
    { val: 30000, label: tr('30 sec', '۳۰ ثانیه') },
    { val: 60000, label: tr('1 min', '۱ دقیقه') },
  ];

  return `
    <div class="sg-pane">
      <!-- Auto-Save Cadence -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Local Auto-Save Cadence', 'ذخیره‌سازی خودکار محلی')}</h3>
          <span class="sg-meta-mono">${intervals.find((i) => i.val === interval)?.label || '15 sec'}</span>
        </div>
        <div class="sg-group">
          <div class="sg-row sg-row-stacked">
            <div class="sg-row-top-split">
              <div class="sg-row-body">
                <div class="sg-row-title">${tr('Annotation Save Interval', 'فاصله زمانی ذخیره خودکار یادداشت‌ها')}</div>
                <div class="sg-row-desc">${tr('How frequently ink strokes, notes, and changes commit to IndexedDB.', 'هر چند ثانیه تغییرات و یادداشت‌های شما در حافظه محلی ذخیره شوند.')}</div>
              </div>
              <div class="sg-segmented" role="group" aria-label="${tr('Auto-Save Frequency', 'فاصله زمانی ذخیره خودکار')}">
                ${intervals
                  .map(
                    (opt) => `
                  <button
                    type="button"
                    class="sg-seg-btn sg-seg-mono ${interval === opt.val ? 'is-active' : ''}"
                    data-set-autosave="${opt.val}"
                    aria-pressed="${interval === opt.val}"
                  >${opt.label}</button>
                `
                  )
                  .join('')}
              </div>
            </div>
            ${renderNote(
              tr(
                '15 seconds is ideal for most workflows. Choose 5 seconds for intensive live lecture notes, or 30–60 seconds to reduce disk writes on massive PDFs.',
                '۱۵ ثانیه برای اکثر کارها بهترین تعادل است. برای جزوه‌نویسی سریع ۵ ثانیه و برای فایل‌های بسیار حجیم ۳۰ تا ۶۰ ثانیه را انتخاب کنید.'
              )
            )}
          </div>
        </div>
      </section>

      <!-- Privacy Guarantee -->
      <div class="sg-callout-strip is-calm">
        <span class="sg-callout-icon" aria-hidden="true">${getIconSvg('shieldCheck', 15)}</span>
        <div class="sg-callout-copy">
          <div class="sg-callout-title">${tr('100% Local IndexedDB Architecture', 'تضمین حریم خصوصی و ذخیره کاملاً محلی')}</div>
          <div class="sg-callout-text">${tr(
            'Every PDF, notebook, vector stroke, signature, and preference remains exclusively on your own device. Nothing is ever uploaded or tracked.',
            'تمامی فایل‌های PDF، دفترها، امضاها و تنظیمات شما صرفاً روی دستگاه خودتان ذخیره می‌شوند و هیچ داده‌ای به سرور ارسال نمی‌شود.'
          )}</div>
        </div>
      </div>

      <!-- Reset & Danger Zone -->
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Reset & Recovery', 'بازنشانی و پاک‌سازی اطلاعات')}</h3>
        </div>
        <div class="sg-group">
          <div class="sg-row">
            <div class="sg-row-body">
              <div class="sg-row-title">${tr('Reset Preferences to Defaults', 'بازگردانی تنظیمات به حالت پیش‌فرض')}</div>
              <div class="sg-row-desc">${tr('Restores theme, accent color, toolbar layout, and pen calibration to factory defaults.', 'پوسته، رنگ شاخص، نوار ابزار و تنظیمات قلم را به حالت اولیه برمی‌گرداند.')}</div>
              ${renderNote(
                tr(
                  'Your library, notebooks, PDFs, and saved annotations remain completely safe.',
                  'فایل‌ها، دفترها و یادداشت‌های ذخیره‌شده شما بدون کوچک‌ترین تغییری حفظ می‌شوند.'
                )
              )}
            </div>
            <button type="button" id="reset-settings-btn" class="secondary-btn sg-action-btn">
              ${getIconSvg('rotate', 13)}
              <span>${tr('Reset Preferences', 'بازنشانی تنظیمات')}</span>
            </button>
          </div>

          <div class="sg-row sg-row-danger">
            <div class="sg-row-body">
              <div class="sg-row-title is-danger">${tr('Clear Offline Storage & Cache', 'پاک کردن حافظه آفلاین و فایل‌های اخیر')}</div>
              <div class="sg-row-desc">${tr('Wipes all cached recent documents, local notebooks, and saved annotations from IndexedDB.', 'تمامی اسناد کش‌شده، دفترهای محلی و حافظه یادداشت‌ها را به‌طور کامل حذف می‌کند.')}</div>
              ${renderNote(
                tr(
                  'This action is irreversible and reloads the application afterward. Export any important PDFs before continuing.',
                  'این عملیات غیرقابل بازگشت است و پس از انجام، برنامه دوباره بارگذاری می‌شود. پیش از ادامه از فایل‌های مهم خروجی بگیرید.'
                )
              )}
            </div>
            <button type="button" id="clear-local-db-btn" class="danger-btn sg-action-btn">
              ${getIconSvg('trash', 13)}
              <span>${tr('Clear All Data', 'پاک‌سازی کامل')}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 8. LANGUAGE
 * -------------------------------------------------------------------------- */
function renderLanguageTab(app: AppSettings): string {
  return `
    <div class="sg-pane">
      <section class="sg-section">
        <div class="sg-section-head">
          <h3 class="sg-heading">${tr('Interface Language & Script', 'زبان و تایپوگرافی رابط کاربری')}</h3>
        </div>

        <div class="sg-lang-grid">
          <button
            type="button"
            class="sg-lang-card is-en ${app.language === 'en' ? 'is-selected' : ''}"
            data-set-lang="en"
            aria-pressed="${app.language === 'en'}"
          >
            <div class="sg-lang-top">
              <span class="sg-lang-specimen is-en" aria-hidden="true">Aa</span>
              <span class="sg-check-indicator" aria-hidden="true">${getIconSvg('check', 12)}</span>
            </div>
            <div class="sg-lang-name">English</div>
            <div class="sg-lang-meta">LTR · Plus Jakarta Sans & Manrope</div>
            <div class="sg-lang-sample">Crisp Latin geometry with tabular JetBrains Mono readouts.</div>
          </button>

          <button
            type="button"
            class="sg-lang-card is-fa ${app.language === 'fa' ? 'is-selected' : ''}"
            data-set-lang="fa"
            aria-pressed="${app.language === 'fa'}"
          >
            <div class="sg-lang-top">
              <span class="sg-lang-specimen is-fa" aria-hidden="true">آ ب</span>
              <span class="sg-check-indicator" aria-hidden="true">${getIconSvg('check', 12)}</span>
            </div>
            <div class="sg-lang-name">فارسی</div>
            <div class="sg-lang-meta">راست‌چین کامل (RTL) · فونت وزیرمتن</div>
            <div class="sg-lang-sample">چیدمان بومی راست‌به‌چپ با تایپوگرافی دقیق و خوانای فارسی.</div>
          </button>
        </div>

        ${renderNote(
          tr(
            'Switching languages immediately mirrors panels, switches, and scrollbars between LTR and RTL while preserving crisp tabular numerals for page numbers, zoom percentages, and shortcuts.',
            'تغییر زبان بلافاصله جهت پنل‌ها، کلیدها و چیدمان را میان راست‌چین و چپ‌چین تنظیم می‌کند و خوانایی اعداد، بزرگ‌نمایی و میانبرها را حفظ می‌نماید.'
          )
        )}
      </section>
    </div>
  `;
}

/* --------------------------------------------------------------------------
 * 9. ABOUT (Swiss Editorial Studio Colophon)
 * -------------------------------------------------------------------------- */
function renderAboutTab(): string {
  const platformLabel = isElectron()
    ? tr('Desktop App (Electron)', 'نسخه دسکتاپ (الکترون)')
    : isDesktop()
      ? tr('Desktop App', 'نسخه دسکتاپ')
      : tr('Web & Extension', 'وب و اکستنشن');

  return `
    <div class="about-pane">
      <!-- Editorial Studio Masthead -->
      <section class="about-masthead">
        <div class="about-masthead-top">
          <div class="about-emblem" aria-hidden="true">
            <img src="${APP_LOGO_DATA_URL}" alt="${t('appName')}" class="about-emblem-img" width="56" height="56" decoding="sync" />
          </div>
          <div class="about-masthead-identity">
            <h2 class="about-wordmark">${t('appName')}</h2>
            <div class="about-meta-line">
              <span class="about-version-val" id="about-version-text">v…</span>
              <button
                type="button"
                id="about-copy-version-btn"
                class="about-copy-btn"
                title="${tr('Copy version info', 'کپی مشخصات نسخه')}"
                aria-label="${tr('Copy version info', 'کپی مشخصات نسخه')}"
              >
                ${getIconSvg('copy', 12)}
              </button>
              <span class="about-meta-sep" aria-hidden="true">·</span>
              <span class="about-meta-item" id="about-platform-text">${platformLabel}</span>
              <span class="about-meta-sep" aria-hidden="true">·</span>
              <span class="about-meta-item">${tr('MIT License', 'مجوز MIT')}</span>
            </div>
          </div>
        </div>

        <div class="about-masthead-body">
          <p class="about-lead">
            ${tr(
              'Built for zero-latency ink, crisp typography, and complete local ownership.',
              'ساخته‌شده برای نگارش بی‌تأخیر، تایپوگرافی دقیق و مالکیت کامل فایل‌ها روی دستگاه شما.'
            )}
          </p>
          <p class="about-blurb">
            ${tr(
              'An offline-first PDF editor and notebook studio engineered to feel as immediate as paper—with pressure-aware vector strokes, multi-tab workflows, and zero cloud tracking.',
              'ویرایشگر آفلاین PDF و دفتر یادداشت دیجیتال که حس طبیعی کاغذ را با قلم حساس به فشار، مدیریت چندزبانه اسناد و بدون ارسال هیچ داده‌ای به سرور ارائه می‌دهد.'
            )}
          </p>
        </div>
      </section>

      <!-- Architectural Spec Ledger -->
      <section class="about-specs" aria-label="${tr('Core specifications', 'مشخصات کلیدی')}">
        <div class="about-spec-cell">
          <div class="about-spec-figure">100%</div>
          <div class="about-spec-label">${tr('Local & Private', 'محلی و خصوصی')}</div>
          <div class="about-spec-note">${tr('Stored solely in IndexedDB', 'ذخیره‌سازی صرفاً روی دستگاه')}</div>
        </div>
        <div class="about-spec-cell">
          <div class="about-spec-figure is-accent">120 Hz</div>
          <div class="about-spec-label">${tr('Vector Ink', 'موتور برداری')}</div>
          <div class="about-spec-note">${tr('WYSIWYG pressure strokes', 'خطوط روان حساس به فشار')}</div>
        </div>
        <div class="about-spec-cell">
          <div class="about-spec-figure">MIT</div>
          <div class="about-spec-label">${tr('Open Source', 'متن‌باز')}</div>
          <div class="about-spec-note">${tr('Auditable, zero telemetry', 'شفاف و بدون ردیابی')}</div>
        </div>
      </section>

      <!-- Software Updates Strip -->
      <section class="about-update-card">
        <div class="about-update-row">
          <div class="about-update-info">
            <div class="about-update-title">${tr('Software Updates', 'بروزرسانی برنامه')}</div>
            <div class="about-update-desc">${tr('Check GitHub Releases for the latest build', 'بررسی انتشار آخرین نسخه در مخزن رسمی گیت‌هاب')}</div>
          </div>
          <button type="button" id="check-updates-btn" class="secondary-btn about-update-btn">
            ${getIconSvg('refresh', 13)}
            <span>${tr('Check for Updates', 'بررسی نسخه جدید')}</span>
          </button>
        </div>
        <div id="update-status-box" class="about-update-status" aria-live="polite"></div>
      </section>

      <!-- Action Index -->
      <nav class="about-links-list" aria-label="${tr('Resources & shortcuts', 'منابع و میانبرها')}">
        <button type="button" id="about-shortcuts-btn" class="about-link-row is-featured">
          <span class="about-link-icon">${getIconSvg('command', 16)}</span>
          <span class="about-link-text">
            <span class="about-link-title">${tr('Keyboard Shortcuts', 'کلیدهای میانبر')}</span>
            <span class="about-link-sub">${tr('Master every tool and navigation keystroke', 'آشنایی با تمام میانبرهای ابزارها و پیمایش')}</span>
          </span>
          <span class="about-link-trailing">
            <kbd class="about-kbd">?</kbd>
            <span class="about-link-arrow">${getIconSvg('arrowRight', 14)}</span>
          </span>
        </button>

        <div class="about-links-pair">
          <a href="https://github.com/v3ndettaaa/veditor" target="_blank" rel="noopener noreferrer" class="about-link-row">
            <span class="about-link-icon">${getIconSvg('github', 15)}</span>
            <span class="about-link-text">
              <span class="about-link-title">${tr('GitHub Repository', 'مخزن گیت‌هاب')}</span>
              <span class="about-link-sub about-link-mono">v3ndettaaa/veditor</span>
            </span>
            <span class="about-link-trailing">
              <span class="about-link-arrow is-ext">${getIconSvg('externalLink', 13)}</span>
            </span>
          </a>

          <a href="https://github.com/v3ndettaaa/veditor/issues" target="_blank" rel="noopener noreferrer" class="about-link-row">
            <span class="about-link-icon">${getIconSvg('info', 15)}</span>
            <span class="about-link-text">
              <span class="about-link-title">${tr('Report an Issue', 'گزارش مشکل')}</span>
              <span class="about-link-sub">${tr('Bugs & feature ideas', 'خطاها و پیشنهادها')}</span>
            </span>
            <span class="about-link-trailing">
              <span class="about-link-arrow is-ext">${getIconSvg('externalLink', 13)}</span>
            </span>
          </a>
        </div>
      </nav>

      <!-- Typeface Colophon -->
      <footer class="about-colophon">
        <span class="about-colophon-label">${tr('Typeset in', 'تایپوگرافی')}</span>
        <span class="about-colophon-faces">
          <span class="about-font-sample is-jakarta">Plus Jakarta Sans</span>
          <span class="about-meta-sep" aria-hidden="true">·</span>
          <span class="about-font-sample is-manrope">Manrope</span>
          <span class="about-meta-sep" aria-hidden="true">·</span>
          <span class="about-font-sample is-mono">JetBrains Mono</span>
          <span class="about-meta-sep" aria-hidden="true">·</span>
          <span class="about-font-sample is-vazir">وزیرمتن</span>
        </span>
      </footer>
    </div>
  `;
}
