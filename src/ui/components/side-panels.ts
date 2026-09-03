/**
 * Collapsible Side Panels Component
 * Manages Page Thumbnails, Document Outline/Bookmarks, Layers, Search, and Action History.
 */

import { store } from '../../core/store';
import { history } from '../../core/history';
import { viewportManager } from '../../core/viewport';
import { layerManager } from '../../annotations/layers';
import { pdfEngine } from '../../core/pdf-engine';
import { getIconSvg } from '../../utils/icons';
import { t } from '../i18n';

export class SidePanelsComponent {
  private _container: HTMLElement;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    const isOpen = store.sidebarOpen;
    const activeTab = store.activeSidebarTab;

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
          <button class="sidebar-tab-btn ${activeTab === 'layers' ? 'active' : ''}" data-tab="layers">
            ${t('sidebar.layers')}
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'search' ? 'active' : ''}" data-tab="search">
            ${t('sidebar.search')}
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">
            ${t('sidebar.history')}
          </button>
        </div>
        <button id="sidebar-close-btn" class="header-btn" style="padding:4px;">
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
      el.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:20px;">No document active</div>`;
      return;
    }

    if (tab === 'thumbnails') {
      let html = `<div style="display:flex; flex-direction:column; gap:12px;">`;
      doc.pages.forEach((p, idx) => {
        const isActive = idx === store.activePageIndex;
        const annotCount = doc.annotations[idx]?.length || 0;
        html += `
          <div class="thumbnail-card" data-page="${idx}" style="
            display:flex; flex-direction:column; align-items:center; padding:8px;
            background:${isActive ? 'var(--bg-surface-elevated)' : 'transparent'};
            border:1px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'};
            border-radius:8px; cursor:pointer;
          ">
            <div style="
              width:120px; height:160px; background:#ffffff; border-radius:4px;
              box-shadow:var(--shadow-sm); display:flex; align-items:center; justify-content:center;
              position:relative; margin-bottom:6px;
            ">
              <span style="color:#94a3b8; font-size:11px; font-weight:600;">Page ${idx + 1}</span>
              ${annotCount > 0 ? `<span style="position:absolute; top:4px; right:4px; background:var(--accent); color:#fff; border-radius:10px; font-size:9px; padding:1px 5px; font-weight:700;">${annotCount}</span>` : ''}
            </div>
            <span style="font-size:11px; color:var(--text-secondary); font-weight:500;">Page ${idx + 1}</span>
          </div>
        `;
      });
      html += `</div>`;
      el.innerHTML = html;

      el.querySelectorAll('[data-page]').forEach(card => {
        card.addEventListener('click', () => {
          const pIdx = parseInt(card.getAttribute('data-page') || '0', 10);
          viewportManager.scrollToPage(pIdx);
        });
      });
    } else if (tab === 'outline') {
      if (doc.bookmarks.length === 0) {
        el.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:20px;">No outline/bookmarks found in this document</div>`;
      } else {
        let html = `<ul style="list-style:none; display:flex; flex-direction:column; gap:6px;">`;
        doc.bookmarks.forEach(b => {
          html += `
            <li style="padding:6px 8px; border-radius:6px; font-size:12px; cursor:pointer; background:var(--bg-surface-hover);" class="bookmark-item">
              📑 ${b.title}
            </li>
          `;
        });
        html += `</ul>`;
        el.innerHTML = html;
      }
    } else if (tab === 'layers') {
      const pIdx = store.activePageIndex;
      const layers = layerManager.getOrCreateDefaultLayers(pIdx);
      let html = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <span style="font-size:12px; font-weight:600; color:var(--text-secondary);">Page ${pIdx + 1} Layers</span>
          <button id="add-layer-btn" class="header-btn" style="font-size:11px; padding:3px 8px;">
            ${getIconSvg('plus', 12)} Add Layer
          </button>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px;">
      `;

      layers.forEach(l => {
        html += `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:var(--bg-surface-elevated); border-radius:6px; border:1px solid var(--border-subtle); font-size:12px;">
            <span style="font-weight:500;">${l.name}</span>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="layer-toggle-btn" data-layer-id="${l.id}" title="Toggle Visibility" style="background:none; border:none; color:var(--text-secondary); cursor:pointer;">
                ${l.visible ? '👁️' : '🙈'}
              </button>
              <button class="layer-lock-btn" data-layer-id="${l.id}" title="Lock Layer" style="background:none; border:none; color:var(--text-secondary); cursor:pointer;">
                ${l.locked ? '🔒' : '🔓'}
              </button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
      el.innerHTML = html;

      el.querySelector('#add-layer-btn')?.addEventListener('click', () => {
        layerManager.addLayer(pIdx);
        store.setActivePageIndex(pIdx);
      });

      el.querySelectorAll('.layer-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const lId = btn.getAttribute('data-layer-id') || '';
          layerManager.toggleLayerVisibility(pIdx, lId);
          store.setActivePageIndex(pIdx);
        });
      });
    } else if (tab === 'search') {
      el.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <input type="text" id="pdf-search-input" placeholder="Search text in document..." style="
            width:100%; padding:8px 12px; background:var(--bg-surface-elevated); border:1px solid var(--border-medium);
            border-radius:6px; color:var(--text-primary); font-size:12px; outline:none;
          ">
          <div id="search-results-list" style="display:flex; flex-direction:column; gap:6px;"></div>
        </div>
      `;

      const searchInput = el.querySelector('#pdf-search-input') as HTMLInputElement;
      const resultsList = el.querySelector('#search-results-list') as HTMLElement;

      searchInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && searchInput.value.trim().length > 1) {
          const query = searchInput.value.trim().toLowerCase();
          resultsList.innerHTML = `<div style="font-size:11px; color:var(--text-muted);">Searching...</div>`;

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
            resultsList.innerHTML = `<div style="font-size:11px; color:var(--text-muted); padding:10px 0;">No matches found</div>`;
          } else {
            resultsList.innerHTML = matches.map(m => `
              <div class="search-result-card" data-page="${m.pageIndex}" style="padding:8px; background:var(--bg-surface-elevated); border-radius:6px; border:1px solid var(--border-subtle); cursor:pointer; font-size:11px;">
                <strong style="color:var(--accent);">Page ${m.pageIndex + 1}</strong>
                <p style="color:var(--text-secondary); margin-top:2px;">${m.snippet}</p>
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
        el.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:20px;">No actions recorded yet</div>`;
      } else {
        let html = `<div style="display:flex; flex-direction:column; gap:6px;">`;
        historyItems.reverse().forEach(h => {
          html += `
            <div style="padding:8px 10px; background:${h.isCurrent ? 'var(--bg-surface-active)' : 'var(--bg-surface-elevated)'}; border-radius:6px; border:1px solid var(--border-subtle); font-size:12px;">
              <span style="font-weight:500;">${h.description}</span>
              <span style="display:block; font-size:10px; color:var(--text-muted); margin-top:2px;">${new Date(h.timestamp).toLocaleTimeString()}</span>
            </div>
          `;
        });
        html += `</div>`;
        el.innerHTML = html;
      }
    }
  }
}
