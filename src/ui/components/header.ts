/**
 * Top Application Header Component
 * Multi-document dropdown menu, quick actions, export buttons, and system settings.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { saveActiveDocument, saveActiveDocumentAs, isDocumentDirty, forgetFileHandle } from '../../io/save';
import { openPrintDialog } from './print-dialog';
import { isFullscreen, toggleFullscreen, initFullscreenSync } from '../fullscreen';
import { showToast } from './toast';
import { t } from '../i18n';
import { notebookController } from '../../core/notebook';
import { NotebookDialogComponent } from './notebook-dialog';
import { nativeConfirm } from '../../io/native-fs';
import { openContextMenu, type MenuEntry } from './context-menu';

export class HeaderComponent {
  private _container: HTMLElement;
  private _onOpenFileRequested: () => void;
  private _onAddTabRequested: () => void;
  /** Zoom never changes header output — skip full rebuilds on zoom-only notifies. */
  private _lastRenderKey: string = '';
  private _isFullscreen = false;
  private _dropdownOpen = false;

  constructor(
    container: HTMLElement,
    onOpenFileRequested: () => void,
    onAddTabRequested?: () => void
  ) {
    this._container = container;
    this._onOpenFileRequested = onOpenFileRequested;
    // The "+" button opens the full landing (recents, folders, new file)
    // instead of jumping straight to the file picker.
    this._onAddTabRequested = onAddTabRequested ?? onOpenFileRequested;
    initFullscreenSync();
    store.subscribe(() => this.render());
    document.addEventListener('fullscreenchange', () => this.render());
    window.addEventListener('veditor:fullscreenchange', () => this.render());

    // Keep header revealed while hovering directly over the header or hover zone,
    // and hide it again when the pointer leaves the header in fullscreen / focus mode.
    const isAutoHideActive = () =>
      (document.body.classList.contains('is-fullscreen') &&
        document.body.classList.contains('fullscreen-autohide')) ||
      document.body.classList.contains('focus-mode');

    this._container.addEventListener('mouseenter', () => {
      if (isAutoHideActive()) {
        document.body.classList.add('header-peek');
      }
    });
    this._container.addEventListener('mouseleave', (e: MouseEvent) => {
      if (this._dropdownOpen) return;
      if (e.clientY <= 6) return;
      if (isAutoHideActive()) {
        document.body.classList.remove('header-peek');
      }
    });
    const hoverZone = document.getElementById('header-hover-zone');
    hoverZone?.addEventListener('mouseenter', () => {
      if (isAutoHideActive()) {
        document.body.classList.add('header-peek');
      }
    });

    // Close the open documents dropdown when clicking outside or pressing Escape
    document.addEventListener('pointerdown', (e) => {
      if (!this._dropdownOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.header-docs-dropdown-wrap')) return;
      this.setDropdownOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._dropdownOpen) {
        this.setDropdownOpen(false);
      }
    });

    this.render();
  }

  private setDropdownOpen(open: boolean): void {
    this._dropdownOpen = open;
    const menu = this._container.querySelector<HTMLElement>('#header-docs-menu');
    const trigger = this._container.querySelector<HTMLElement>('#header-docs-dropdown-btn');
    if (menu) {
      menu.classList.toggle('is-open', open);
    }
    if (trigger) {
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      trigger.classList.toggle('is-open', open);
    }
  }

  public render(): void {
    const activeDoc = store.activeDocument;
    const tabs = store.documentTabs;
    const lang = store.appSettings.language;
    const fa = lang === 'fa';
    const theme = store.appSettings.theme;
    const isNotebook = notebookController.isNotebook(activeDoc);
    const fullscreen = isFullscreen();

    if (tabs.length === 0 && this._dropdownOpen) {
      this._dropdownOpen = false;
    }

    const renderKey = [
      activeDoc?.id ?? '',
      tabs.map(t => {
        const d = store.openDocuments.get(t.id);
        return `${t.id}:${t.name}:${d?.pageCount ?? 0}:${isDocumentDirty(t.id) ? 1 : 0}`;
      }).join(','),
      lang, theme, isNotebook ? 1 : 0, fullscreen ? 1 : 0
    ].join('|');
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') return;
    this._lastRenderKey = renderKey;
    this._isFullscreen = fullscreen;

    const activeTabName = activeDoc?.name || tabs[0]?.name || t('header.documents');
    const activeDirty = activeDoc ? isDocumentDirty(activeDoc.id) : false;

    this._container.innerHTML = `
      <div class="header-left">
        <button id="header-sidebar-btn" class="header-btn" title="${t('header.toggleSidebar')}" ${!activeDoc ? 'style="display:none;"' : ''}>
          ${getIconSvg('sidebar')}
        </button>

        <div class="header-logo" id="header-logo-btn">
          <img src="icons/icon-32.png" alt="veditor" class="header-logo-icon">
          <span>${t('appName')}</span>
        </div>

        <div class="document-tabs-bar header-docs-dropdown-wrap" ${tabs.length === 0 ? 'style="display:none;"' : ''}>
          <button type="button"
                  id="header-docs-dropdown-btn"
                  class="header-docs-trigger ${this._dropdownOpen ? 'is-open' : ''}"
                  aria-haspopup="listbox"
                  aria-expanded="${this._dropdownOpen ? 'true' : 'false'}"
                  title="${escapeHtml(activeTabName)} (${tabs.length} ${fa ? 'باز' : 'open'})">
            <span class="doc-tab-icon">${getIconSvg('fileText', 15)}</span>
            <span class="doc-tab-title">${escapeHtml(activeTabName)}</span>
            ${activeDirty ? `<span class="doc-tab-dirty" title="${t('header.unsavedChanges')}">●</span>` : ''}
            <span class="header-docs-count" title="${tabs.length} ${fa ? 'پی‌دی‌اف باز' : `open PDF${tabs.length === 1 ? '' : 's'}`}">${tabs.length}</span>
            <span class="header-docs-chevron">${getIconSvg('chevronDown', 14)}</span>
          </button>

          <button type="button" id="header-add-tab-btn" class="doc-tab-add" title="${t('header.openInNewTab')}">
            ${getIconSvg('plus', 15)}
          </button>

          <div id="header-docs-menu" class="header-docs-menu ${this._dropdownOpen ? 'is-open' : ''}" role="listbox" aria-label="${t('header.openDocuments')}">
            <div class="header-docs-menu-header">
              <span>${t('header.openDocuments')}</span>
              <span class="badge">${tabs.length}</span>
            </div>
            <div class="header-docs-menu-list">
              ${tabs.map(tab => {
                const isActive = activeDoc?.id === tab.id;
                const dirty = isDocumentDirty(tab.id);
                const docSession = store.openDocuments.get(tab.id);
                const pagesCount = docSession?.pageCount || 0;
                return `
                  <div class="doc-tab header-docs-item ${isActive ? 'active' : ''}"
                       data-tab-id="${escapeHtml(tab.id)}"
                       role="option"
                       aria-selected="${isActive ? 'true' : 'false'}"
                       title="${escapeHtml(tab.name)}">
                    <span class="doc-tab-icon">${getIconSvg('fileText', 14)}</span>
                    <div class="header-docs-item-info">
                      <span class="doc-tab-title">${escapeHtml(tab.name)}</span>
                      ${pagesCount > 0 ? `<span class="header-docs-item-meta">${pagesCount} ${fa ? 'صفحه' : (pagesCount === 1 ? 'page' : 'pages')}</span>` : ''}
                    </div>
                    ${dirty ? `<span class="doc-tab-dirty" title="${t('header.unsavedChanges')}">●</span>` : ''}
                    <button type="button" class="doc-tab-close" data-close-tab="${escapeHtml(tab.id)}" title="${t('header.closeTab')}" aria-label="${t('header.closeTab')} ${escapeHtml(tab.name)}">
                      ${getIconSvg('close', 12)}
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
            ${tabs.length > 1 ? `
              <div class="header-docs-menu-footer">
                <button type="button" class="header-docs-footer-btn" id="header-docs-close-others">
                  ${t('header.closeOthers')}
                </button>
                <button type="button" class="header-docs-footer-btn is-danger" id="header-docs-close-all">
                  ${t('header.closeAll')}
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="header-right">
        ${isNotebook ? `
          <button id="header-paper-btn" class="header-btn" title="${t('notebook.paperTitle')}">
            ${getIconSvg('paper', 15)}
            <span>${t('notebook.paperBtn')}</span>
          </button>
          <button id="header-add-page-btn" class="header-btn" title="${t('notebook.addPageTitle')}">
            ${getIconSvg('plus', 15)}
            <span>${t('notebook.addPage')}</span>
          </button>
          <div class="toolbar-separator" style="height:20px;"></div>
        ` : ''}

        <button id="header-save-btn" class="header-btn primary" ${!activeDoc ? 'style="display:none;"' : ''} title="${t('header.saveTooltip')}">
          ${getIconSvg('save', 15)}
          <span>${t('actions.save')}</span>
        </button>

        <button id="header-saveas-btn" class="header-btn" ${!activeDoc ? 'style="display:none;"' : ''} title="${t('header.saveAsTooltip')}">
          ${getIconSvg('saveAll', 15)}
          <span>${t('actions.saveAs')}</span>
        </button>

        <button id="header-print-btn" class="header-btn" ${!activeDoc ? 'style="display:none;"' : ''} title="${fa ? 'چاپ سند (Ctrl+P)' : 'Print Document (Ctrl+P)'}">
          ${getIconSvg('printer', 15)}
        </button>

        <div class="toolbar-separator" style="height:20px; ${!activeDoc ? 'display:none;' : ''}"></div>

        <button id="header-palette-btn" class="header-btn" title="${t('header.commandPaletteTooltip')}">
          ${getIconSvg('command', 16)}
        </button>

        <button id="header-fullscreen-btn" class="header-btn" title="${t('view.fullscreen')}" aria-pressed="${fullscreen ? 'true' : 'false'}">
          ${getIconSvg(fullscreen ? 'compress' : 'expand', 16)}
        </button>

        <button id="header-theme-btn" class="header-btn" title="${t('header.toggleTheme')}">
          ${getIconSvg(theme === 'dark' ? 'sun' : 'moon', 16)}
        </button>

        <button id="header-settings-btn" class="header-btn" title="${t('settings.title')}">
          ${getIconSvg('settings', 16)}
        </button>
      </div>
    `;

    // Events
    this._container.querySelector('#header-sidebar-btn')?.addEventListener('click', () => {
      store.toggleSidebar();
    });

    this._container.querySelector('#header-logo-btn')?.addEventListener('click', () => {
      this._dropdownOpen = false;
      store.setActiveDocument(null);
    });

    this._container.querySelector('#header-paper-btn')?.addEventListener('click', () => {
      this.openPaperDialog();
    });

    this._container.querySelector('#header-add-page-btn')?.addEventListener('click', async () => {
      if (notebookController.atPageLimit()) {
        showToast(fa ? 'این دفترچه به حداکثر تعداد صفحات رسیده است.' : 'This notebook has reached its page limit.', 'error');
        return;
      }
      const added = await notebookController.addPages(1);
      if (added) {
        showToast(
          fa ? `صفحه ${store.activeDocument?.pageCount} اضافه شد` : `Page ${store.activeDocument?.pageCount} added`,
          'success'
        );
      }
    });

    this._container.querySelector('#header-save-btn')?.addEventListener('click', async () => {
      if (!store.activeDocument) return;
      await saveActiveDocument();
    });

    this._container.querySelector('#header-saveas-btn')?.addEventListener('click', async () => {
      if (!store.activeDocument) return;
      await saveActiveDocumentAs();
    });

    this._container.querySelector('#header-print-btn')?.addEventListener('click', () => {
      if (!store.activeDocument) return;
      openPrintDialog();
    });

    this._container.querySelector('#header-palette-btn')?.addEventListener('click', () => {
      store.setCommandPaletteOpen(true);
    });

    this._container.querySelector('#header-fullscreen-btn')?.addEventListener('click', async (e) => {
      (e.currentTarget as HTMLElement | null)?.blur?.();
      document.body.classList.remove('header-peek');
      try {
        await toggleFullscreen();
      } catch (err) {
        console.error('Fullscreen unavailable:', err);
        showToast(fa ? 'حالت تمام‌صفحه در این محیط در دسترس نیست' : 'Fullscreen is unavailable in this browser context', 'error');
      }
    });

    this._container.querySelector('#header-theme-btn')?.addEventListener('click', () => {
      store.updateAppSettings({ theme: theme === 'dark' ? 'light' : 'dark' });
    });

    this._container.querySelector('#header-settings-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(true);
    });

    // Open Documents Dropdown toggle
    this._container.querySelector('#header-docs-dropdown-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setDropdownOpen(!this._dropdownOpen);
    });

    // Tab item click events inside dropdown
    this._container.querySelectorAll('[data-tab-id]').forEach(tabEl => {
      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-close-tab]')) return;
        const tabId = tabEl.getAttribute('data-tab-id');
        this.setDropdownOpen(false);
        if (tabId) {
          store.switchDocumentTab(tabId);
        }
      });
    });

    this._container.querySelectorAll('[data-close-tab]').forEach(closeEl => {
      closeEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabId = closeEl.getAttribute('data-close-tab');
        if (!tabId) return;
        await this.closeTabWithConfirm(tabId);
      });
    });

    this._container.querySelector('#header-docs-close-others')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentId = store.activeDocument?.id;
      if (!currentId) return;
      this.setDropdownOpen(false);
      void this.closeTabsWithConfirm(tabs.filter(t => t.id !== currentId).map(t => t.id));
    });

    this._container.querySelector('#header-docs-close-all')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setDropdownOpen(false);
      void this.closeTabsWithConfirm(tabs.map(t => t.id));
    });

    this._container.querySelectorAll<HTMLElement>('[data-tab-id]').forEach(tabEl => {
      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const tabId = tabEl.getAttribute('data-tab-id');
        if (tabId) this.openTabContextMenu(e as MouseEvent, tabId);
      });
    });

    this._container.querySelector('#header-add-tab-btn')?.addEventListener('click', () => {
      this.setDropdownOpen(false);
      this._onAddTabRequested();
    });
  }

  /** Themed right-click menu for a document tab: close/close others/close all, save, save as. */
  private openTabContextMenu(e: MouseEvent, tabId: string): void {
    const tabs = store.documentTabs;
    const isActive = store.activeDocument?.id === tabId;
    const entries: MenuEntry[] = [
      {
        kind: 'action', id: 'switch', label: t('header.switchToTab'), icon: 'fileText', disabled: isActive,
        run: () => store.switchDocumentTab(tabId)
      },
      { kind: 'separator' },
      {
        kind: 'action', id: 'save', label: t('actions.save'), icon: 'save', disabled: !isActive,
        run: () => { void saveActiveDocument(); }
      },
      {
        kind: 'action', id: 'save-as', label: `${t('actions.saveAs')}\u2026`, icon: 'saveAll', disabled: !isActive,
        run: () => { void saveActiveDocumentAs(); }
      },
      { kind: 'separator' },
      {
        kind: 'action', id: 'close', label: t('actions.close'), icon: 'close',
        run: () => { void this.closeTabWithConfirm(tabId); }
      },
      {
        kind: 'action', id: 'close-others', label: t('header.closeOthers'), icon: 'close', disabled: tabs.length <= 1,
        run: () => { void this.closeTabsWithConfirm(tabs.filter(t => t.id !== tabId).map(t => t.id)); }
      },
      {
        kind: 'action', id: 'close-all', label: t('header.closeAll'), icon: 'close', danger: true,
        run: () => { void this.closeTabsWithConfirm(tabs.map(t => t.id)); }
      }
    ];
    openContextMenu(e.clientX, e.clientY, entries);
  }

  private async closeTabWithConfirm(tabId: string): Promise<void> {
    const fa = store.appSettings.language === 'fa';
    if (isDocumentDirty(tabId)) {
      const ok = await nativeConfirm(
        fa
          ? 'این سند دارای تغییرات ذخیره‌نشده است. بدون ذخیره‌سازی بسته شود؟'
          : 'This document has unsaved changes. Close without saving?'
      );
      if (!ok) return;
    }
    forgetFileHandle(tabId);
    store.closeDocumentTab(tabId);
  }

  private async closeTabsWithConfirm(tabIds: string[]): Promise<void> {
    const fa = store.appSettings.language === 'fa';
    const dirtyCount = tabIds.filter(isDocumentDirty).length;
    if (dirtyCount > 0) {
      const ok = await nativeConfirm(
        fa
          ? `${dirtyCount} سند دارای تغییرات ذخیره‌نشده هستند. بدون ذخیره‌سازی بسته شوند؟`
          : `${dirtyCount} document${dirtyCount > 1 ? 's' : ''} have unsaved changes. Close without saving?`
      );
      if (!ok) return;
    }
    for (const tabId of tabIds) {
      forgetFileHandle(tabId);
      store.closeDocumentTab(tabId);
    }
  }

  /**
   * Hosted on the body rather than inside the header, which re-renders on every
   * store change and would otherwise tear the dialog down mid-edit.
   */
  private openPaperDialog(): void {
    const doc = store.activeDocument;
    if (!doc?.notebook) return;
    const fa = store.appSettings.language === 'fa';

    const host = document.createElement('div');
    document.body.appendChild(host);

    const dialog = new NotebookDialogComponent(host, {
      mode: 'edit',
      paper: doc.notebook.paper,
      pageSize: doc.notebook.pageSize,
      onClose: () => host.remove(),
      onSubmit: async ({ paper, pageSize }) => {
        try {
          showToast(fa ? 'در حال اعمال کاغذ…' : 'Applying paper…', 'progress');
          await notebookController.restyle(paper, pageSize);
          showToast(fa ? 'طرح کاغذ به‌روزرسانی شد' : 'Paper updated', 'success');
        } catch (err: any) {
          showToast(fa ? `خطا در اعمال کاغذ: ${err.message}` : `Could not apply paper: ${err.message}`, 'error');
        } finally {
          host.remove();
        }
      }
    });
    dialog.render();
  }
}
