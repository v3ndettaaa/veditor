/**
 * Top Application Header Component
 * Multi-document dropdown menu, quick actions, export buttons, and system settings.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { saveActiveDocument, saveActiveDocumentAs, isDocumentDirty, forgetFileHandle } from '../../io/save';
import { isFullscreen, toggleFullscreen } from '../fullscreen';
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
    store.subscribe(() => this.render());
    document.addEventListener('fullscreenchange', () => this.render());

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

    const activeTabName = activeDoc?.name || tabs[0]?.name || 'Documents';
    const activeDirty = activeDoc ? isDocumentDirty(activeDoc.id) : false;

    this._container.innerHTML = `
      <div class="header-left">
        <button id="header-sidebar-btn" class="header-btn" title="Toggle Sidebar" ${!activeDoc ? 'style="display:none;"' : ''}>
          ${getIconSvg('sidebar', 16)}
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
                  title="${escapeHtml(activeTabName)} (${tabs.length} open)">
            <span class="doc-tab-icon">${getIconSvg('fileText', 14)}</span>
            <span class="doc-tab-title">${escapeHtml(activeTabName)}</span>
            ${activeDirty ? '<span class="doc-tab-dirty" title="Unsaved changes">●</span>' : ''}
            <span class="header-docs-count" title="${tabs.length} open PDF${tabs.length === 1 ? '' : 's'}">${tabs.length}</span>
            <span class="header-docs-chevron">${getIconSvg('chevronDown', 13)}</span>
          </button>

          <button type="button" id="header-add-tab-btn" class="doc-tab-add" title="Open PDF in new tab">
            ${getIconSvg('plus', 14)}
          </button>

          <div id="header-docs-menu" class="header-docs-menu ${this._dropdownOpen ? 'is-open' : ''}" role="listbox" aria-label="Open documents">
            <div class="header-docs-menu-header">
              <span>${lang === 'fa' ? 'پی‌دی‌اف‌های باز' : 'Open Documents'}</span>
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
                      ${pagesCount > 0 ? `<span class="header-docs-item-meta">${pagesCount} ${lang === 'fa' ? 'صفحه' : (pagesCount === 1 ? 'page' : 'pages')}</span>` : ''}
                    </div>
                    ${dirty ? '<span class="doc-tab-dirty" title="Unsaved changes">●</span>' : ''}
                    <button type="button" class="doc-tab-close" data-close-tab="${escapeHtml(tab.id)}" title="Close Tab" aria-label="Close ${escapeHtml(tab.name)}">
                      ${getIconSvg('close', 12)}
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
            ${tabs.length > 1 ? `
              <div class="header-docs-menu-footer">
                <button type="button" class="header-docs-footer-btn" id="header-docs-close-others">
                  ${lang === 'fa' ? 'بستن بقیه تب‌ها' : 'Close Others'}
                </button>
                <button type="button" class="header-docs-footer-btn is-danger" id="header-docs-close-all">
                  ${lang === 'fa' ? 'بستن همه' : 'Close All'}
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="header-right">
        ${isNotebook ? `
          <button id="header-paper-btn" class="header-btn" title="${t('notebook.paperTitle')}">
            ${getIconSvg('paper', 14)}
            <span>${t('notebook.paperBtn')}</span>
          </button>
          <button id="header-add-page-btn" class="header-btn" title="${t('notebook.addPageTitle')}">
            ${getIconSvg('plus', 14)}
            <span>${t('notebook.addPage')}</span>
          </button>
          <div class="toolbar-separator" style="height:18px;"></div>
        ` : ''}

        <button id="header-save-btn" class="header-btn primary" ${!activeDoc ? 'style="display:none;"' : ''} title="Save (Ctrl+S)">
          ${getIconSvg('save', 14)}
          <span>Save</span>
        </button>

        <button id="header-saveas-btn" class="header-btn" ${!activeDoc ? 'style="display:none;"' : ''} title="Save As (Ctrl+Shift+S)">
          ${getIconSvg('saveAll', 14)}
          <span>Save As</span>
        </button>

        <div class="toolbar-separator" style="height:18px; ${!activeDoc ? 'display:none;' : ''}"></div>

        <button id="header-palette-btn" class="header-btn" title="Command Palette (Cmd+K)">
          ${getIconSvg('command', 15)}
        </button>

        <button id="header-lang-btn" class="header-btn" title="Switch Language">
          ${getIconSvg('globe', 15)}
          <span class="header-language-label">${lang === 'en' ? 'FA' : 'EN'}</span>
        </button>

        <button id="header-fullscreen-btn" class="header-btn" title="${t('view.fullscreen')}" aria-pressed="${fullscreen ? 'true' : 'false'}">
          ${getIconSvg(fullscreen ? 'compress' : 'expand', 15)}
        </button>

        <button id="header-theme-btn" class="header-btn" title="Toggle Dark/Light Mode">
          ${getIconSvg(theme === 'dark' ? 'sun' : 'moon', 15)}
        </button>

        <button id="header-settings-btn" class="header-btn" title="${t('settings.title')}">
          ${getIconSvg('settings', 15)}
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
        showToast('This notebook has reached its page limit.', 'error');
        return;
      }
      const added = await notebookController.addPages(1);
      if (added) showToast(`Page ${store.activeDocument?.pageCount} added`, 'success');
    });

    this._container.querySelector('#header-save-btn')?.addEventListener('click', async () => {
      if (!store.activeDocument) return;
      await saveActiveDocument();
    });

    this._container.querySelector('#header-saveas-btn')?.addEventListener('click', async () => {
      if (!store.activeDocument) return;
      await saveActiveDocumentAs();
    });

    this._container.querySelector('#header-palette-btn')?.addEventListener('click', () => {
      store.setCommandPaletteOpen(true);
    });

    this._container.querySelector('#header-lang-btn')?.addEventListener('click', () => {
      store.updateAppSettings({ language: lang === 'en' ? 'fa' : 'en' });
    });

    this._container.querySelector('#header-fullscreen-btn')?.addEventListener('click', async () => {
      try {
        await toggleFullscreen();
      } catch (err) {
        console.error('Fullscreen unavailable:', err);
        showToast('Fullscreen is unavailable in this browser context', 'error');
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
        kind: 'action', id: 'switch', label: 'Switch to tab', icon: 'fileText', disabled: isActive,
        run: () => store.switchDocumentTab(tabId)
      },
      { kind: 'separator' },
      {
        kind: 'action', id: 'save', label: 'Save', icon: 'save', disabled: !isActive,
        run: () => { void saveActiveDocument(); }
      },
      {
        kind: 'action', id: 'save-as', label: 'Save As\u2026', icon: 'saveAll', disabled: !isActive,
        run: () => { void saveActiveDocumentAs(); }
      },
      { kind: 'separator' },
      {
        kind: 'action', id: 'close', label: 'Close', icon: 'close',
        run: () => { void this.closeTabWithConfirm(tabId); }
      },
      {
        kind: 'action', id: 'close-others', label: 'Close others', icon: 'close', disabled: tabs.length <= 1,
        run: () => { void this.closeTabsWithConfirm(tabs.filter(t => t.id !== tabId).map(t => t.id)); }
      },
      {
        kind: 'action', id: 'close-all', label: 'Close all', icon: 'close', danger: true,
        run: () => { void this.closeTabsWithConfirm(tabs.map(t => t.id)); }
      }
    ];
    openContextMenu(e.clientX, e.clientY, entries);
  }

  private async closeTabWithConfirm(tabId: string): Promise<void> {
    if (isDocumentDirty(tabId)) {
      const ok = await nativeConfirm('This document has unsaved changes. Close without saving?');
      if (!ok) return;
    }
    forgetFileHandle(tabId);
    store.closeDocumentTab(tabId);
  }

  private async closeTabsWithConfirm(tabIds: string[]): Promise<void> {
    const dirtyCount = tabIds.filter(isDocumentDirty).length;
    if (dirtyCount > 0) {
      const ok = await nativeConfirm(`${dirtyCount} document${dirtyCount > 1 ? 's' : ''} have unsaved changes. Close without saving?`);
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

    const host = document.createElement('div');
    document.body.appendChild(host);

    const dialog = new NotebookDialogComponent(host, {
      mode: 'edit',
      paper: doc.notebook.paper,
      pageSize: doc.notebook.pageSize,
      onClose: () => host.remove(),
      onSubmit: async ({ paper, pageSize }) => {
        try {
          showToast('Applying paper…', 'progress');
          await notebookController.restyle(paper, pageSize);
          showToast('Paper updated', 'success');
        } catch (err: any) {
          showToast(`Could not apply paper: ${err.message}`, 'error');
        } finally {
          host.remove();
        }
      }
    });
    dialog.render();
  }
}
