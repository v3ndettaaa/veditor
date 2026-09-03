/**
 * Top Application Header Component
 * Multi-document tabs, quick actions, export buttons, and system settings.
 */

import { store } from '../../core/store';
import { getIconSvg } from '../../utils/icons';
import { pdfExporter } from '../../io/export-pdf';
import { showToast } from './toast';
import { t } from '../i18n';

export class HeaderComponent {
  private _container: HTMLElement;
  private _onOpenFileRequested: () => void;

  constructor(container: HTMLElement, onOpenFileRequested: () => void) {
    this._container = container;
    this._onOpenFileRequested = onOpenFileRequested;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const activeDoc = store.activeDocument;
    const tabs = store.documentTabs;
    const lang = store.appSettings.language;
    const theme = store.appSettings.theme;

    this._container.innerHTML = `
      <div class="header-left">
        <button id="header-sidebar-btn" class="header-btn" title="Toggle Sidebar">
          ${getIconSvg('sidebar', 16)}
        </button>

        <div class="header-logo" id="header-logo-btn">
          <img src="icons/icon-32.png" alt="veditor" class="header-logo-icon">
          <span>${t('appName')}</span>
        </div>

        <div class="document-tabs-bar">
          ${tabs.map(tab => `
            <div class="doc-tab ${activeDoc?.id === tab.id ? 'active' : ''}" data-tab-id="${tab.id}">
              <span class="doc-tab-title" title="${tab.name}">${tab.name}</span>
              <span class="doc-tab-close" data-close-tab="${tab.id}">×</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="header-right">
        <button id="header-open-btn" class="header-btn">
          ${getIconSvg('upload', 14)}
          <span>${t('openFile')}</span>
        </button>

        <button id="header-export-btn" class="header-btn primary" ${!activeDoc ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>
          ${getIconSvg('download', 14)}
          <span>${t('export')}</span>
        </button>

        <div class="toolbar-separator" style="height:18px;"></div>

        <button id="header-palette-btn" class="header-btn" title="Command Palette (Cmd+K)">
          ${getIconSvg('command', 15)}
        </button>

        <button id="header-lang-btn" class="header-btn" title="Switch Language">
          <span style="font-weight:700; font-size:12px;">${lang === 'en' ? 'FA' : 'EN'}</span>
        </button>

        <button id="header-theme-btn" class="header-btn" title="Toggle Dark/Light Mode">
          ${theme === 'dark' ? '☀️' : '🌙'}
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

    this._container.querySelector('#header-export-btn')?.addEventListener('click', async () => {
      if (!activeDoc) return;
      try {
        showToast('Exporting high-resolution PDF...');
        const bytes = await pdfExporter.exportPDF({ flatten: true, dpi: 150, applyRedactions: true });
        await pdfExporter.saveToFile(bytes, activeDoc.name || 'annotated.pdf');
        showToast(t('toast.exported'));
      } catch (err: any) {
        showToast(`Export failed: ${err.message}`);
      }
    });

    this._container.querySelector('#header-palette-btn')?.addEventListener('click', () => {
      store.setCommandPaletteOpen(true);
    });

    this._container.querySelector('#header-lang-btn')?.addEventListener('click', () => {
      const next = lang === 'en' ? 'fa' : 'en';
      store.updateAppSettings({ language: next });
      document.documentElement.setAttribute('dir', next === 'fa' ? 'rtl' : 'ltr');
      document.documentElement.setAttribute('lang', next);
    });

    this._container.querySelector('#header-theme-btn')?.addEventListener('click', () => {
      const next = theme === 'dark' ? 'light' : 'dark';
      store.updateAppSettings({ theme: next });
      document.body.className = `theme-${next}`;
    });

    this._container.querySelector('#header-settings-btn')?.addEventListener('click', () => {
      store.setSettingsModalOpen(true);
    });

    // Tab click events
    this._container.querySelectorAll('[data-tab-id]').forEach(tabEl => {
      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).hasAttribute('data-close-tab')) return;
        const tabId = tabEl.getAttribute('data-tab-id');
        if (tabId) {
          // Switch to this tab
        }
      });
    });

    this._container.querySelectorAll('[data-close-tab]').forEach(closeEl => {
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = closeEl.getAttribute('data-close-tab');
        if (tabId) store.closeDocumentTab(tabId);
      });
    });
  }
}
