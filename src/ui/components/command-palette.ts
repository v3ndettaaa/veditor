/**
 * Command Palette (Cmd + K / Ctrl + K)
 * Instant fuzzy action search for power users.
 */

import { store } from '../../core/store';
import { viewportManager } from '../../core/viewport';
import { pageActions } from '../../core/page-actions';
import { saveActiveDocument, saveActiveDocumentAs } from '../../io/save';
import { duplicateSelectedAnnotations } from '../../annotations/duplicate';
import { dataExporter } from '../../io/export-data';
import { cropDialog } from './crop-dialog';
import { sidePanelsInstance } from './side-panels';
import { showToast } from './toast';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { toggleFullscreen } from '../fullscreen';
import { t, tr } from '../i18n';

interface PaletteCommand {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export class CommandPaletteComponent {
  private _container: HTMLElement;
  private _selectedIndex: number = 0;
  private _filteredCommands: PaletteCommand[] = [];
  private _wasOpen: boolean = false;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.setupGlobalShortcut();
  }

  private setupGlobalShortcut() {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.setCommandPaletteOpen(!store.commandPaletteOpen);
      } else if (e.key === 'Escape' && store.commandPaletteOpen) {
        store.setCommandPaletteOpen(false);
      }
    });
  }

  private getAllCommands(): PaletteCommand[] {
    const catTools = tr('Tools', 'ابزارها');
    const catView = tr('View', 'نمایش');
    const catFile = tr('File', 'فایل');
    const catSettings = tr('Settings', 'تنظیمات');
    const catHelp = tr('Help', 'راهنما');
    const catEdit = tr('Edit', 'ویرایش');

    return [
      { id: 'tool-select', title: tr('Select & Transform Tool', 'ابزار انتخاب و تغییر شکل'), category: catTools, shortcut: 'V', action: () => store.setActiveTool('select') },
      { id: 'tool-hand', title: tr('Hand Tool (drag to pan)', 'ابزار دست (جابه‌جایی صفحه)'), category: catTools, shortcut: 'Space', action: () => store.setActiveTool('hand') },
      { id: 'tool-pen', title: tr('Freehand Pen Tool', 'ابزار قلم آزاد'), category: catTools, shortcut: 'P', action: () => store.setActiveTool('pen') },
      { id: 'tool-highlighter', title: tr('Highlighter Tool', 'ابزار ماژیک هایلایت'), category: catTools, shortcut: 'H', action: () => store.setActiveTool('highlighter') },
      { id: 'tool-eraser', title: tr('Eraser Tool', 'ابزار پاک‌کن'), category: catTools, shortcut: 'E', action: () => store.setActiveTool('eraser') },
      { id: 'tool-rect', title: tr('Rectangle Shape Tool', 'ابزار رسم مستطیل'), category: catTools, shortcut: 'R', action: () => store.setActiveTool('rectangle') },
      { id: 'tool-ellipse', title: tr('Ellipse Shape Tool', 'ابزار رسم دایره و بیضی'), category: catTools, shortcut: 'O', action: () => store.setActiveTool('ellipse') },
      { id: 'tool-line', title: tr('Line Tool', 'ابزار رسم خط صاف'), category: catTools, shortcut: 'L', action: () => store.setActiveTool('line') },
      { id: 'tool-arrow', title: tr('Arrow Tool', 'ابزار رسم پیکان (فلش)'), category: catTools, shortcut: 'A', action: () => store.setActiveTool('arrow') },
      { id: 'tool-polygon', title: tr('Multi-Point Polygon Tool', 'ابزار رسم چندضلعی'), category: catTools, shortcut: 'G', action: () => store.setActiveTool('polygon') },
      { id: 'tool-freeform', title: tr('Freeform Shape Tool (freehand closed outline)', 'ابزار شکل آزاد (مسیر بسته)'), category: catTools, action: () => store.setActiveTool('freeform-shape') },
      { id: 'tool-text', title: tr('Text Box Tool', 'ابزار کادر متن'), category: catTools, shortcut: 'T', action: () => store.setActiveTool('text') },
      { id: 'tool-sticky-note', title: tr('Sticky Note Tool', 'ابزار یادداشت چسبان'), category: catTools, action: () => store.setActiveTool('sticky-note') },
      { id: 'tool-stamp', title: tr('Vector Stamp Tool', 'ابزار مهر و تصویر'), category: catTools, shortcut: 'M', action: () => store.setActiveTool('stamp') },
      { id: 'tool-signature', title: tr('Signature Pad', 'پد امضای دیجیتال'), category: catTools, shortcut: 'K', action: () => store.setSignatureModalOpen(true) },
      { id: 'tool-measure', title: tr('Measure Distance Tool', 'ابزار اندازه‌گیری فاصله (خط‌کش)'), category: catTools, action: () => store.setActiveTool('measure-distance') },
      { id: 'tool-lasso', title: tr('Lasso Select Tool', 'ابزار انتخاب کمند (آزاد)'), category: catTools, shortcut: 'Q', action: () => store.setActiveTool('lasso') },
      { id: 'tool-scratchpad', title: tr('Floating Scratchpad', 'چرک‌نویس شناور'), category: catTools, shortcut: 'N', action: () => { store.setActiveTool('scratchpad'); store.setScratchpadOpen(true); } },

      { id: 'view-customize-toolbar', title: tr('Customize toolbar layout', 'شخصی‌سازی چیدمان نوار ابزار'), category: catView, action: () => { store.setSettingsModalOpen(true); store.settingsTabRequest = 'toolbar'; } },
      { id: 'view-fit-width', title: tr('Fit to Width', 'تنظیم به عرض صفحه'), category: catView, action: () => viewportManager.fitToWidth() },
      { id: 'view-fit-page', title: tr('Fit to Page', 'نمایش کامل صفحه'), category: catView, action: () => viewportManager.fitToPage() },
      { id: 'view-zoom-in', title: tr('Zoom In', 'بزرگ‌نمایی'), category: catView, shortcut: 'Ctrl +', action: () => store.setZoom(store.zoom * 1.2) },
      { id: 'view-zoom-out', title: tr('Zoom Out', 'کوچک‌نمایی'), category: catView, shortcut: 'Ctrl -', action: () => store.setZoom(store.zoom / 1.2) },
      { id: 'view-continuous', title: tr('View: Continuous Vertical Scroll', 'نمایش: اسکرول عمودی پیوسته'), category: catView, action: () => store.setViewMode('continuous') },
      { id: 'view-single', title: tr('View: Single Page Mode', 'نمایش: حالت تک‌صفحه‌ای'), category: catView, action: () => store.setViewMode('single') },
      { id: 'view-twopage', title: tr('View: Two-Page Facing Mode', 'نمایش: حالت دوصفحه‌ای (روبه‌رو)'), category: catView, action: () => store.setViewMode('two-page') },
      { id: 'view-focus', title: tr('Toggle Focus Mode', 'حالت تمرکز (مخفی‌سازی پنل‌ها)'), category: catView, action: () => store.toggleFocusMode() },
      {
        id: 'view-fullscreen',
        title: tr('Toggle Fullscreen Mode', 'حالت تمام‌صفحه'),
        category: catView,
        action: () => {
          toggleFullscreen().catch(() => showToast(tr('Fullscreen is unavailable in this browser context', 'حالت تمام‌صفحه در این مرورگر در دسترس نیست'), 'error'));
        }
      },

      {
        id: 'file-save',
        title: tr('Save (write into this PDF)', 'ذخیره در همین فایل PDF'),
        category: catFile,
        shortcut: 'Ctrl+S',
        action: () => { void saveActiveDocument(); }
      },
      {
        id: 'file-save-as',
        title: tr('Save As (new file/location)', 'ذخیره به نام دیگر (فایل جدید)'),
        category: catFile,
        shortcut: 'Ctrl+Shift+S',
        action: () => { void saveActiveDocumentAs(); }
      },
      {
        id: 'export-json',
        title: tr('Export Annotations to JSON', 'خروجی JSON از حاشیه‌نویسی‌ها'),
        category: catFile,
        action: () => {
          const json = dataExporter.exportToJSON();
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${store.activeDocument?.name || 'document'}-annotations.json`;
          a.click();
          showToast(tr('Annotations JSON exported', 'فایل JSON حاشیه‌نویسی‌ها ذخیره شد'), 'success');
        }
      },

      {
        id: 'theme-toggle',
        title: store.appSettings.theme === 'dark'
          ? tr('Switch Theme to Light Mode', 'تغییر پوسته به حالت روشن')
          : tr('Switch Theme to Dark Mode', 'تغییر پوسته به حالت تاریک'),
        category: catSettings,
        action: () => {
          store.updateAppSettings({ theme: store.appSettings.theme === 'dark' ? 'light' : 'dark' });
        }
      },
      {
        id: 'lang-toggle',
        title: store.appSettings.language === 'en'
          ? 'Switch Language to فارسی (Persian)'
          : 'تغییر زبان برنامه به انگلیسی (English)',
        category: catSettings,
        action: () => {
          store.updateAppSettings({ language: store.appSettings.language === 'en' ? 'fa' : 'en' });
        }
      },
      { id: 'shortcuts-modal', title: tr('Keyboard Shortcuts Reference', 'راهنمای میانبرهای صفحه‌کلید'), category: catHelp, shortcut: '?', action: () => store.setShortcutsModalOpen(true) },
      { id: 'edit-duplicate', title: tr('Duplicate Selection', 'تکثیر موارد انتخاب‌شده'), category: catEdit, shortcut: 'Ctrl+D', action: () => { duplicateSelectedAnnotations(); } },
      { id: 'page-crop', title: tr('Crop Page Margins…', 'برش حاشیه صفحات…'), category: catEdit, action: () => { void cropDialog.open(store.activePageIndex); } },
      { id: 'page-merge', title: tr('Merge External PDF into Document…', 'ادغام فایل پی‌دی‌اف خارجی در سند…'), category: catFile, action: () => { sidePanelsInstance?.promptMergeExternalPdf(); } },
      {
        id: 'page-extract',
        title: tr('Extract Selected Page(s) as New PDF…', 'استخراج صفحات انتخاب‌شده به‌صورت فایل پی‌دی‌اف مجزا…'),
        category: catFile,
        action: () => {
          const sel = store.effectivePageSelection();
          void pageActions.extractPagesToFile(sel).then(ok => {
            if (ok) showToast(t('sidebar.pages.extracted', { count: sel.length }), 'success');
          });
        }
      },
      { id: 'nav-jump-back', title: tr('Jump Back to Previous Page', 'بازگشت به مکان قبلی پس از پرش صفحه'), category: catView, shortcut: 'Alt+←', action: () => { viewportManager.popAndRestoreJump(); } },
      { id: 'settings-modal', title: tr('Open Settings', 'باز کردن تنظیمات برنامه'), category: catHelp, action: () => store.setSettingsModalOpen(true) }
    ];
  }

  public render(): void {
    if (!store.commandPaletteOpen) {
      if (this._wasOpen) {
        this._wasOpen = false;
        const overlay = this._container.querySelector<HTMLElement>('#palette-overlay');
        if (overlay) {
          overlay.classList.add('is-closing');
          window.setTimeout(() => {
            if (!store.commandPaletteOpen) this._container.innerHTML = '';
          }, 150);
        } else {
          this._container.innerHTML = '';
        }
      }
      return;
    }
    if (this._wasOpen && this._container.querySelector('#palette-overlay')) {
      return;
    }
    this._wasOpen = true;

    const all = this.getAllCommands();
    this._filteredCommands = all;
    this._selectedIndex = 0;

    this._container.innerHTML = `
      <div class="modal-overlay" id="palette-overlay">
        <div class="modal-dialog palette-dialog" role="dialog" aria-modal="true" aria-label="${tr('Command palette', 'پالت فرمان')}">
          <div class="palette-search">
            <span class="palette-search-icon">${getIconSvg('search', 17)}</span>
            <input type="text" id="palette-input" class="palette-input" autofocus
                   placeholder="${tr('Search tools, views and commands…', 'جستجوی ابزارها، نماها و فرمان‌ها…')}" aria-label="${tr('Search commands', 'جستجوی فرمان‌ها')}">
            <span class="kbd">Esc</span>
          </div>

          <div id="palette-list" class="palette-list" role="listbox"></div>

          <div class="palette-footer">
            <span><span class="kbd">↑</span><span class="kbd">↓</span> ${tr('navigate', 'جابه‌جایی')}</span>
            <span><span class="kbd">↵</span> ${tr('run', 'اجرا')}</span>
          </div>
        </div>
      </div>
    `;

    const input = this._container.querySelector('#palette-input') as HTMLInputElement;
    const list = this._container.querySelector('#palette-list') as HTMLElement;
    const overlay = this._container.querySelector('#palette-overlay') as HTMLElement;

    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) store.setCommandPaletteOpen(false);
    });

    const updateList = () => {
      const query = input.value.toLowerCase().trim();
      this._filteredCommands = all.filter(c =>
        c.title.toLowerCase().includes(query) || c.category.toLowerCase().includes(query)
      );

      if (this._filteredCommands.length === 0) {
        list.innerHTML = `<div class="empty-note">${tr(`No commands match “${escapeHtml(input.value.trim())}”`, `هیچ فرمانی با «${escapeHtml(input.value.trim())}» مطابقت ندارد`)}</div>`;
        return;
      }

      list.innerHTML = this._filteredCommands.map((c, idx) => `
        <div class="palette-item ${idx === this._selectedIndex ? 'is-selected' : ''}" data-idx="${idx}"
             role="option" aria-selected="${idx === this._selectedIndex}">
          <span class="palette-item-label">
            <span class="palette-item-category">${escapeHtml(c.category)}</span>
            <span class="palette-item-title">${escapeHtml(c.title)}</span>
          </span>
          ${c.shortcut ? `<span class="kbd">${escapeHtml(c.shortcut)}</span>` : ''}
        </div>
      `).join('');

      list.querySelectorAll('.palette-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.getAttribute('data-idx') || '0', 10);
          this.executeCommand(this._filteredCommands[idx]);
        });
      });

      // Keep the keyboard-selected row inside the scroll viewport.
      list.querySelector('.palette-item.is-selected')?.scrollIntoView({ block: 'nearest' });
    };

    input?.addEventListener('input', () => {
      this._selectedIndex = 0;
      updateList();
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex + 1) % this._filteredCommands.length;
        updateList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex - 1 + this._filteredCommands.length) % this._filteredCommands.length;
        updateList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this._filteredCommands[this._selectedIndex]) {
          this.executeCommand(this._filteredCommands[this._selectedIndex]);
        }
      }
    });

    updateList();
    setTimeout(() => input?.focus(), 50);
  }

  private executeCommand(cmd: PaletteCommand) {
    store.setCommandPaletteOpen(false);
    cmd.action();
  }
}
