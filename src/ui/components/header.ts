/**
 * Top Application Header Component
 * Multi-document tabs, quick actions, export buttons, and system settings.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { saveActiveDocument, saveActiveDocumentAs, isDocumentDirty, forgetFileHandle } from '../../io/save';
import { isFullscreen, toggleFullscreen } from '../fullscreen';
import { showToast } from './toast';
import { t } from '../i18n';
import { notebookController } from '../../core/notebook';
import { NotebookDialogComponent } from './notebook-dialog';

export class HeaderComponent {
  private _container: HTMLElement;
  private _onOpenFileRequested: () => void;
  private _onAddTabRequested: () => void;
  /** Zoom never changes header output — skip full rebuilds on zoom-only notifies. */
  private _lastRenderKey: string = '';
  private _isFullscreen = false;

  constructor(
    container: HTMLElement,
    onOpenFileRequested: () => void,
    onAddTabRequested?: () => void
  ) {
    this._container = container;
    this._onOpenFileRequested = onOpenFileRequested;
    // The tab-strip "+" opens the full landing (recents, folders, new file)
    // instead of jumping straight to the file picker.
    this._onAddTabRequested = onAddTabRequested ?? onOpenFileRequested;
    store.subscribe(() => this.render());
    document.addEventListener('fullscreenchange', () => this.render());
    this.render();
  }

  public render(): void {
    const activeDoc = store.activeDocument;
    const tabs = store.documentTabs;
    const lang = store.appSettings.language;
    const theme = store.appSettings.theme;
    const isNotebook = notebookController.isNotebook(activeDoc);
    const fullscreen = isFullscreen();

    const renderKey = [
      activeDoc?.id ?? '',
      tabs.map(t => `${t.id}:${t.name}:${isDocumentDirty(t.id) ? 1 : 0}`).join(','),
      lang, theme, isNotebook ? 1 : 0, fullscreen ? 1 : 0
    ].join('|');
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') return;
    this._lastRenderKey = renderKey;
    this._isFullscreen = fullscreen;

    this._container.innerHTML = `
      <div class="header-left">
        <button id="header-sidebar-btn" class="header-btn" title="Toggle Sidebar" ${!activeDoc ? 'style="display:none;"' : ''}>
          ${getIconSvg('sidebar', 16)}
        </button>

        <div class="header-logo" id="header-logo-btn">
          <img src="icons/icon-32.png" alt="veditor" class="header-logo-icon">
          <span>${t('appName')}</span>
        </div>

        <div class="document-tabs-bar" ${tabs.length === 0 ? 'style="display:none;"' : ''}>
          ${tabs.map(tab => `
            <div class="doc-tab ${activeDoc?.id === tab.id ? 'active' : ''}" data-tab-id="${tab.id}" title="${tab.name}">
              <span class="doc-tab-icon">${getIconSvg('fileText', 13)}</span>
              <span class="doc-tab-title">${tab.name}</span>
              ${isDocumentDirty(tab.id) ? '<span class="doc-tab-dirty" title="Unsaved changes">●</span>' : ''}
              <span class="doc-tab-close" data-close-tab="${tab.id}" title="Close Tab">${getIconSvg('close', 11)}</span>
            </div>
          `).join('')}
          <button id="header-add-tab-btn" class="doc-tab-add" title="Open PDF in new tab">
            ${getIconSvg('plus', 13)}
          </button>
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

        <button id="header-open-btn" class="header-btn">
          ${getIconSvg('upload', 14)}
          <span>${t('openFile')}</span>
        </button>

        <button id="header-save-btn" class="header-btn primary" ${!activeDoc ? 'style="display:none;"' : ''} title="Save (Ctrl+S)">
          ${getIconSvg('save', 14)}
          <span>Save</span>
        </button>

        <button id="header-saveas-btn" class="header-btn" ${!activeDoc ? 'style="display:none;"' : ''} title="Save As (Ctrl+Shift+S)">
          ${getIconSvg('saveAll', 14)}
          <span>Save As</span>
        </button>

        <div class="toolbar-separator" style="height:18px;"></div>

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
      store.setActiveDocument(null);
    });

    this._container.querySelector('#header-open-btn')?.addEventListener('click', () => {
      this._onOpenFileRequested();
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

    // Tab click events
    this._container.querySelectorAll('[data-tab-id]').forEach(tabEl => {
      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-close-tab]')) return;
        const tabId = tabEl.getAttribute('data-tab-id');
        if (tabId) {
          store.switchDocumentTab(tabId);
        }
      });
    });

    this._container.querySelectorAll('[data-close-tab]').forEach(closeEl => {
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = closeEl.getAttribute('data-close-tab');
        if (!tabId) return;
        if (isDocumentDirty(tabId)) {
          const ok = window.confirm('This document has unsaved changes. Close without saving?');
          if (!ok) return;
        }
        forgetFileHandle(tabId);
        store.closeDocumentTab(tabId);
      });
    });

    this._container.querySelector('#header-add-tab-btn')?.addEventListener('click', () => {
      this._onAddTabRequested();
    });
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
