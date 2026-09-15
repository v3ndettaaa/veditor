/**
 * Collapsible Side Panels Component
 * Manages Page Thumbnails, Document Outline/Bookmarks, Search, and Action History.
 */

import { store } from '../../core/store';
import { history } from '../../core/history';
import { viewportManager } from '../../core/viewport';
import { pdfEngine } from '../../core/pdf-engine';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { t } from '../i18n';

export class SidePanelsComponent {
  private _container: HTMLElement;
  /**
   * Rendered page previews as data URLs, keyed by `${docId}:${pageIndex}`.
   * Stored as images rather than canvases so a cached preview can be inserted
   * into the panel repeatedly - cloning a canvas element does not copy its
   * bitmap, and a canvas can only be attached at one place in the document.
   */
  private _thumbnailCache: Map<string, string> = new Map();
  /** Zoom never changes sidebar output — skip full rebuilds on zoom-only notifies. */
  private _lastRenderKey: string = '';

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const isOpen = store.sidebarOpen;
    const activeTab = store.activeSidebarTab;
    const doc = store.activeDocument;

    // Zoom/page-scroll-independent parts first: collapsed state is trivial.
    // Full rebuild key excludes zoom — zoom commits must not rebuild O(n)
    // thumbnail DOM or refire thumbnail renders.
    const renderKey = [
      isOpen ? 1 : 0, activeTab,
      doc?.id ?? '', doc?.pageCount ?? 0,
      store.activePageIndex,
      doc?.lastModifiedAt ?? 0,
      store.appSettings.language
    ].join('|');
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') return;
    this._lastRenderKey = renderKey;

    if (!isOpen) {
      this._container.classList.add('collapsed');
      return;
    }

    this._container.classList.remove('collapsed');

    this._container.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-tabs-nav">
          <button class="sidebar-tab-btn ${activeTab === 'thumbnails' ? 'active' : ''}" data-tab="thumbnails">
            ${t('sidebar.thumbnails')}
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'outline' ? 'active' : ''}" data-tab="outline">
            ${t('sidebar.outline')}
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'search' ? 'active' : ''}" data-tab="search">
            ${t('sidebar.search')}
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">
            ${t('sidebar.history')}
          </button>
        </div>
        <button id="sidebar-close-btn" class="icon-btn" title="Close sidebar" aria-label="Close sidebar">
          ${getIconSvg('close', 14)}
        </button>
      </div>

      <div class="sidebar-content" id="sidebar-tab-content"></div>
    `;

    // Tab switcher events
    this._container.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', () => {
        const tab = el.getAttribute('data-tab') as any;
        if (tab) store.setSidebarTab(tab);
      });
    });

    this._container.querySelector('#sidebar-close-btn')?.addEventListener('click', () => {
      store.toggleSidebar();
    });

    const contentArea = this._container.querySelector('#sidebar-tab-content') as HTMLElement;
    if (contentArea) {
      this.renderTabContent(contentArea, activeTab);
    }
  }

  private renderTabContent(el: HTMLElement, tab: string) {
    const doc = store.activeDocument;
    if (!doc) {
      el.innerHTML = `<div class="empty-note">No document active</div>`;
      return;
    }

    if (tab === 'thumbnails') {
      el.innerHTML = `
        <div class="thumbnail-list">
          ${doc.pages.map((_p, idx) => {
            const isActive = idx === store.activePageIndex;
            const annotCount = doc.annotations[idx]?.length || 0;
            return `
              <button class="thumbnail-card ${isActive ? 'is-active' : ''}" data-page="${idx}"
                      aria-current="${isActive ? 'true' : 'false'}" title="Go to page ${idx + 1}">
                <span class="thumbnail-frame is-loading" data-thumb-frame="${idx}">
                  ${annotCount > 0 ? `<span class="thumbnail-badge">${annotCount}</span>` : ''}
                </span>
                <span class="thumbnail-label">${idx + 1}</span>
              </button>
            `;
          }).join('')}
        </div>
      `;

      el.querySelectorAll('[data-page]').forEach(card => {
        card.addEventListener('click', () => {
          const pIdx = parseInt(card.getAttribute('data-page') || '0', 10);
          viewportManager.scrollToPage(pIdx);
        });
      });

      this.fillThumbnails(el, doc.id, doc.pages.length);
    } else if (tab === 'outline') {
      if (doc.bookmarks.length === 0) {
        el.innerHTML = `<div class="empty-note">No outline or bookmarks found in this document</div>`;
      } else {
        el.innerHTML = `
          <div class="panel-stack">
            ${doc.bookmarks.map(b => `
              <div class="list-card is-interactive bookmark-item">
                <span class="list-card-icon">${getIconSvg('book', 13)}</span>
                <span class="list-card-title">${escapeHtml(b.title)}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    } else if (tab === 'search') {
      el.innerHTML = `
        <div class="panel-stack">
          <input type="search" id="pdf-search-input" class="field"
                 placeholder="Search text, then press Enter" aria-label="Search text in document">
          <div id="search-results-list" class="panel-stack"></div>
        </div>
      `;

      const searchInput = el.querySelector('#pdf-search-input') as HTMLInputElement;
      const resultsList = el.querySelector('#search-results-list') as HTMLElement;

      searchInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && searchInput.value.trim().length > 1) {
          const query = searchInput.value.trim().toLowerCase();
          resultsList.innerHTML = `<div class="empty-note">Searching…</div>`;

          const matches: Array<{ pageIndex: number; snippet: string }> = [];

          for (let i = 0; i < doc.pages.length; i++) {
            const { text } = await pdfEngine.getPageText(i);
            const lower = text.toLowerCase();
            const idx = lower.indexOf(query);
            if (idx !== -1) {
              const snippet = text.substring(Math.max(0, idx - 20), Math.min(text.length, idx + query.length + 30));
              matches.push({ pageIndex: i, snippet: `...${snippet}...` });
            }
          }

          if (matches.length === 0) {
            resultsList.innerHTML = `<div class="empty-note">No matches found</div>`;
          } else {
            resultsList.innerHTML = matches.map(m => `
              <div class="list-card is-interactive search-result-card" data-page="${m.pageIndex}"
                   style="flex-direction:column; align-items:stretch;">
                <strong class="search-result-page">Page ${m.pageIndex + 1}</strong>
                <span class="search-result-snippet">${escapeHtml(m.snippet)}</span>
              </div>
            `).join('');

            resultsList.querySelectorAll('.search-result-card').forEach(c => {
              c.addEventListener('click', () => {
                const p = parseInt(c.getAttribute('data-page') || '0', 10);
                viewportManager.scrollToPage(p);
              });
            });
          }
        }
      });
    } else if (tab === 'history') {
      const historyItems = history.historyList;
      if (historyItems.length === 0) {
        el.innerHTML = `<div class="empty-note">No actions recorded yet</div>`;
      } else {
        el.innerHTML = `
          <div class="panel-stack">
            ${historyItems.slice().reverse().map(h => `
              <div class="list-card ${h.isCurrent ? 'is-current' : ''}" style="flex-direction:column; align-items:stretch;">
                <span class="list-card-title">${escapeHtml(h.description)}</span>
                <span class="list-card-meta">${new Date(h.timestamp).toLocaleTimeString()}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    }
  }

  /**
   * Renders each page preview once and reuses it afterwards, so switching tabs
   * or moving between pages does not re-rasterise the whole document.
   */
  private async fillThumbnails(el: HTMLElement, docId: string, pageCount: number): Promise<void> {
    for (let idx = 0; idx < pageCount; idx++) {
      const frame = el.querySelector<HTMLElement>(`[data-thumb-frame="${idx}"]`);
      if (!frame) continue;

      const key = `${docId}:${idx}`;
      let src = this._thumbnailCache.get(key);

      if (!src) {
        const rendered = await pdfEngine.renderThumbnail(idx);
        if (!rendered) continue;
        src = rendered.toDataURL('image/png');
        this._thumbnailCache.set(key, src);
      }

      // The panel may have been re-rendered while this page was rasterising.
      if (!frame.isConnected) return;

      const img = document.createElement('img');
      img.src = src;
      img.alt = `Page ${idx + 1} preview`;
      frame.classList.remove('is-loading');
      frame.prepend(img);
    }
  }
}
