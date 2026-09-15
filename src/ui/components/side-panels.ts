/**
 * Collapsible Side Panels Component
 * Manages Page Thumbnails, Document Outline/Bookmarks, Search, and Action History.
 */

import { store } from '../../core/store';
import { history } from '../../core/history';
import { viewportManager } from '../../core/viewport';
import { pdfEngine } from '../../core/pdf-engine';
import { pageActions } from '../../core/page-actions';
import { onPageStructureChanged } from '../../core/page-ops';
import { DocumentSession } from '../../core/types';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { t } from '../i18n';
import { openContextMenu, MenuEntry } from './context-menu';
import { showToast } from './toast';

export class SidePanelsComponent {
  private _container: HTMLElement;
  /**
   * Rendered page previews as data URLs, keyed by
   * `${docId}:${structureRevision}:${pageIndex}`. Stored as images rather than
   * canvases so a cached preview can be inserted into the panel repeatedly -
   * cloning a canvas element does not copy its bitmap, and a canvas can only be
   * attached at one place in the document.
   */
  private _thumbnailCache: Map<string, string> = new Map();
  /** Zoom never changes sidebar output — skip full rebuilds on zoom-only notifies. */
  private _lastRenderKey: string = '';
  /**
   * Anchor for shift-click page ranges. Held on the component rather than in
   * the click handler's closure because selecting re-renders the list.
   */
  private _pageAnchor: number | null = null;
  /** Document the anchor belongs to; page indices are document-scoped. */
  private _anchorDocId: string | null = null;
  /**
   * Bumped on every page-structure change. Thunderstorms of annotation edits
   * touch `lastModifiedAt` constantly, so that cannot drive the cache; this
   * only moves when the page list itself is renumbered.
   */
  private _structureRevision = 0;
  /** Last page whose thumbnail was scrolled into view (avoids re-scrolling). */
  private _lastActivePageIndex: number = -1;

  constructor(container: HTMLElement) {
    this._container = container;
    store.subscribe(() => this.render());
    // A page operation renumbers every thumbnail, so the cached previews are
    // all stale at once; dropping them here keeps the cache from growing with
    // one dead generation per operation.
    onPageStructureChanged(() => {
      this._thumbnailCache.clear();
      this._structureRevision++;
      this._lastRenderKey = '';
    });
    this.render();
  }

  public render(): void {
    const isOpen = store.sidebarOpen;
    const activeTab = store.activeSidebarTab;
    const doc = store.activeDocument;

    // Zoom/page-scroll-independent parts first: collapsed state is trivial.
    // Full rebuild key excludes zoom — zoom commits must not rebuild O(n)
    // thumbnail DOM or refire thumbnail renders. The page selection and the
    // active page are also excluded: both are applied by syncPageSelection() to
    // the existing cards, so neither ctrl-clicking twenty pages nor scrolling
    // through the document rebuilds the list (a rebuild also resets the list's
    // scroll offset, which made the panel jump on every page change).
    // `lastModifiedAt` is excluded for the same reason: it changes on every
    // stroke, which would re-decode every thumbnail in the document. Page
    // renumbering is signalled by `_structureRevision` instead.
    const renderKey = [
      isOpen ? 1 : 0, activeTab,
      doc?.id ?? '', doc?.pageCount ?? 0,
      this._structureRevision,
      store.appSettings.language
    ].join('|');
    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') {
      this.syncPageSelection();
      this.syncPageBadges();
      return;
    }
    this._lastRenderKey = renderKey;

    if (this._anchorDocId !== (doc?.id ?? null)) {
      this._anchorDocId = doc?.id ?? null;
      this._pageAnchor = null;
    }

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
    // A fresh list starts at the top, so the current page's card has to be
    // brought back into view (the in-place sync below would skip it, believing
    // it was already handled).
    this._lastActivePageIndex = -1;
    this.syncPageSelection();
  }

  /**
   * Applies the page selection *and* the active-page highlight to the rendered
   * cards in place. Both change far more often than the list itself (every
   * ctrl-click, every page turn), so neither may pay for a full O(n) rebuild
   * and thumbnail re-decode — nor for the scroll reset a rebuild implies.
   */
  private syncPageSelection(): void {
    const selected = store.selectedPageIndices;
    const active = store.activePageIndex;
    let activeCard: HTMLElement | null = null;
    // This runs on every store notify (including every pen sample), so each
    // write is guarded: a 500-page document must not pay 2000 attribute writes
    // per stroke to re-assert values that did not change.
    this._container.querySelectorAll<HTMLElement>('.thumbnail-card[data-page]').forEach(card => {
      const idx = parseInt(card.dataset.page || '-1', 10);

      const isSelected = selected.has(idx);
      if (card.classList.contains('is-selected') !== isSelected) {
        card.classList.toggle('is-selected', isSelected);
        card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      }

      const isActive = idx === active;
      if (card.classList.contains('is-active') !== isActive) {
        card.classList.toggle('is-active', isActive);
        card.setAttribute('aria-current', isActive ? 'true' : 'false');
      }
      if (isActive) activeCard = card;
    });

    // Keep the current page's thumbnail in view as the reader scrolls, without
    // stealing focus or scrolling a card that is already visible.
    if (activeCard && this._lastActivePageIndex !== active) {
      (activeCard as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    this._lastActivePageIndex = active;
  }

  /**
   * Patches the per-page annotation-count badges in place. The list is no
   * longer rebuilt on every edit (that would re-decode every thumbnail), so the
   * badge has to be maintained its own way.
   */
  private syncPageBadges(): void {
    const doc = store.activeDocument;
    if (!doc) return;
    this._container.querySelectorAll<HTMLElement>('.thumbnail-card[data-page]').forEach(card => {
      const idx = parseInt(card.dataset.page || '-1', 10);
      const frame = card.querySelector<HTMLElement>('[data-thumb-frame]');
      if (!frame) return;
      const count = doc.annotations[idx]?.length || 0;
      const badge = frame.querySelector<HTMLElement>('.thumbnail-badge');
      if (count === 0) {
        badge?.remove();
      } else if (badge) {
        if (badge.textContent !== String(count)) badge.textContent = String(count);
      } else {
        const el = document.createElement('span');
        el.className = 'thumbnail-badge';
        el.textContent = String(count);
        frame.appendChild(el);
      }
    });
  }

  private renderTabContent(el: HTMLElement, tab: string) {
    const doc = store.activeDocument;
    if (!doc) {
      el.innerHTML = `<div class="empty-note">No document active</div>`;
      return;
    }

    if (tab === 'thumbnails') {
      const selected = store.selectedPageIndices;
      el.innerHTML = `
        <div class="thumbnail-list" id="thumbnail-list" tabindex="0" role="listbox" aria-multiselectable="true">
          ${doc.pages.map((_p, idx) => {
            const isActive = idx === store.activePageIndex;
            const isSelected = selected.has(idx);
            const annotCount = doc.annotations[idx]?.length || 0;
            return `
              <button class="thumbnail-card ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}"
                      data-page="${idx}" role="option" draggable="true"
                      aria-current="${isActive ? 'true' : 'false'}"
                      aria-selected="${isSelected ? 'true' : 'false'}"
                      title="${escapeHtml(t('sidebar.pages.goTo', { page: idx + 1 }))}">
                <span class="thumbnail-frame is-loading" data-thumb-frame="${idx}">
                  ${annotCount > 0 ? `<span class="thumbnail-badge">${annotCount}</span>` : ''}
                </span>
                <span class="thumbnail-label">${idx + 1}</span>
              </button>
            `;
          }).join('')}
        </div>
      `;

      const list = el.querySelector<HTMLElement>('#thumbnail-list');
      if (list) this.bindThumbnailList(list, doc);
      this.fillThumbnails(el, doc.id, doc.pages.length, this._structureRevision);
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
   * Wires the whole thumbnail interaction model on the freshly rendered list:
   * click selection, ctrl/shift extension, the page context menu, drag-to-
   * reorder and the keyboard shortcuts that mirror the menu.
   */
  private bindThumbnailList(list: HTMLElement, doc: DocumentSession): void {
    /** Pages picked up by an in-flight drag. */
    let dragging: number[] = [];

    const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-page]'));

    const selectionFor = (idx: number): number[] => {
      const explicit = store.selectedPageIndices;
      return explicit.size > 0 ? [...explicit].sort((a, b) => a - b) : [idx];
    };

    for (const card of cards) {
      const idx = parseInt(card.dataset.page || '0', 10);

      card.addEventListener('click', (e) => {
        if (e.shiftKey && this._pageAnchor !== null) {
          const from = Math.min(this._pageAnchor, idx);
          const to = Math.max(this._pageAnchor, idx);
          const range: number[] = [];
          for (let i = from; i <= to; i++) range.push(i);
          store.setSelectedPageIndices(range);
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          this._pageAnchor = idx;
          store.togglePageIndex(idx);
          return;
        }
        this._pageAnchor = idx;
        store.setSelectedPageIndices([]);
        viewportManager.scrollToPage(idx);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Right-clicking outside the current selection re-targets it, which is
        // what every file manager does and what makes Delete unambiguous.
        if (!store.selectedPageIndices.has(idx)) {
          this._pageAnchor = idx;
          store.setSelectedPageIndices([]);
        }
        this.openPageMenu(e.clientX, e.clientY, idx);
      });

      card.addEventListener('dragstart', (e) => {
        dragging = selectionFor(idx);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        }
        card.classList.add('is-dragging');
      });

      card.addEventListener('dragend', () => {
        dragging = [];
        card.classList.remove('is-dragging');
      });

      card.addEventListener('dragover', (e) => {
        if (dragging.length === 0) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        card.classList.add('is-drop-target');
      });

      card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('is-drop-target');
        const moving = dragging;
        dragging = [];
        // Dropping onto one of the dragged pages is a no-op, not a jump.
        if (moving.length === 0 || moving.includes(idx)) return;
        // Dragged upward -> land before the target; downward -> after it.
        const toIndex = moving[0] > idx ? idx : idx + 1;
        void this.runPageAction(() => pageActions.movePages(moving, toIndex));
      });
    }

    list.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      // Let the search field inside other tabs keep its own keys.
      if (target && target.tagName === 'INPUT') return;
      const mod = e.ctrlKey || e.metaKey;
      const current = store.effectivePageSelection();

      // Every handled key stops propagating: the window-level shortcut handler
      // would otherwise act on the annotation selection at the same time
      // (Delete deletes pages *and* annotations).
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (mod && e.key.toLowerCase() === 'a') {
        handled();
        const all: number[] = [];
        for (let i = 0; i < doc.pageCount; i++) all.push(i);
        store.setSelectedPageIndices(all);
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        handled();
        void this.runPageAction(async () => {
          const ok = await pageActions.copyPages(current);
          if (ok) showToast(t('sidebar.pages.copied', { count: current.length }), 'success');
          return ok;
        });
        return;
      }
      if (mod && e.key.toLowerCase() === 'x') {
        handled();
        void this.runPageAction(async () => {
          const ok = await pageActions.cutPages(current);
          if (ok) showToast(t('sidebar.pages.cutDone'), 'success');
          return ok;
        });
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        handled();
        const clip = store.pageClipboard;
        if (!clip) return;
        const at = current[current.length - 1];
        void this.runPageAction(async () => {
          const ok = await pageActions.pastePages(at, 'after');
          if (ok) showToast(t('sidebar.pages.pasted', { count: clip.pageCount }), 'success');
          return ok;
        });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        handled();
        if (current.length === 0 || current.length >= doc.pageCount) return;
        void this.runPageAction(async () => {
          const ok = await pageActions.deletePages(current);
          if (ok) {
            showToast(current.length > 1
              ? t('sidebar.pages.deletedMany', { count: current.length })
              : t('sidebar.pages.deleted'), 'success');
          }
          return ok;
        });
      }
    });
  }

  /** Wraps a page action so failures surface once, as a toast. */
  private async runPageAction(run: () => Promise<boolean>): Promise<void> {
    const doc = store.activeDocument;
    if (!doc) return;
    // A page op is already in flight: dropping the click beats queueing it and
    // then reporting the runner's own busy-guard rejection as a failure.
    if (pageActions.isBusy) return;
    let ok = false;
    try {
      ok = await run();
    } catch (err) {
      console.error('Page action failed:', err);
    }
    if (!ok) showToast(t('sidebar.pages.failed'), 'error');
  }

  private openPageMenu(x: number, y: number, pageIndex: number): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const selection = store.effectivePageSelection(pageIndex);
    const many = selection.length > 1;
    const clip = store.pageClipboard;
    const notebook = !!doc.notebook;

    const entries: MenuEntry[] = [
      { kind: 'action', id: 'page-copy', label: t('sidebar.pages.copy'), icon: 'copy', shortcut: 'Ctrl+C',
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.copyPages(selection);
          if (ok) showToast(t('sidebar.pages.copied', { count: selection.length }), 'success');
          return ok;
        }); } },
      { kind: 'action', id: 'page-cut', label: t('sidebar.pages.cut'), icon: 'cut', shortcut: 'Ctrl+X',
        disabled: notebook,
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.cutPages(selection);
          if (ok) showToast(t('sidebar.pages.cutDone'), 'success');
          return ok;
        }); } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-paste-before', label: t('sidebar.pages.pasteBefore'), icon: 'clipboard',
        disabled: !pageActions.canPaste('before', selection[0]),
        run: () => { void this.runPageAction(async () => {
          const at = selection[0];
          const ok = await pageActions.pastePages(at, 'before');
          if (ok) showToast(t('sidebar.pages.pasted', { count: clip?.pageCount ?? 0 }), 'success');
          return ok;
        }); } },
      { kind: 'action', id: 'page-paste-after', label: t('sidebar.pages.pasteAfter'), icon: 'clipboard',
        disabled: !pageActions.canPaste('after', selection[selection.length - 1]),
        run: () => { void this.runPageAction(async () => {
          const at = selection[selection.length - 1];
          const ok = await pageActions.pastePages(at, 'after');
          if (ok) showToast(t('sidebar.pages.pasted', { count: clip?.pageCount ?? 0 }), 'success');
          return ok;
        }); } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-duplicate', label: t('sidebar.pages.duplicate'), icon: 'plus',
        run: () => { void this.runPageAction(() => pageActions.duplicatePages(selection)); } },
      { kind: 'action', id: 'page-blank-before', label: t('sidebar.pages.insertBlankBefore'), icon: 'blankPage',
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.insertBlankPages(selection[0], 1);
          if (ok) showToast(t('sidebar.pages.blankInserted'), 'success');
          return ok;
        }); } },
      { kind: 'action', id: 'page-blank-after', label: t('sidebar.pages.insertBlankAfter'), icon: 'blankPage',
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.insertBlankPages(selection[selection.length - 1] + 1, 1);
          if (ok) showToast(t('sidebar.pages.blankInserted'), 'success');
          return ok;
        }); } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-up', label: t('sidebar.pages.moveUp'), icon: 'arrowUp',
        disabled: notebook || selection[0] === 0,
        run: () => { void this.runPageAction(() => pageActions.movePages(selection, selection[0] - 1)); } },
      { kind: 'action', id: 'page-down', label: t('sidebar.pages.moveDown'), icon: 'arrowDown',
        disabled: notebook || selection[selection.length - 1] >= doc.pageCount - 1,
        run: () => { void this.runPageAction(() => pageActions.movePages(selection, selection[selection.length - 1] + 2)); } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-rotate-cw', label: t('sidebar.pages.rotateCw'), icon: 'rotate',
        run: () => { void this.runPageAction(() => pageActions.rotatePages(selection, 90)); } },
      { kind: 'action', id: 'page-rotate-ccw', label: t('sidebar.pages.rotateCcw'), icon: 'rotate',
        run: () => { void this.runPageAction(() => pageActions.rotatePages(selection, -90)); } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-select-all', label: t('sidebar.pages.selectAll'), icon: 'select', shortcut: 'Ctrl+A',
        disabled: doc.pageCount === 0,
        run: () => {
          const all: number[] = [];
          for (let i = 0; i < doc.pageCount; i++) all.push(i);
          store.setSelectedPageIndices(all);
        } },
      { kind: 'separator' },
      { kind: 'action', id: 'page-delete', label: many
          ? t('sidebar.pages.deleteMany', { count: selection.length })
          : t('sidebar.pages.delete'),
        icon: 'trash', danger: true, shortcut: 'Del',
        disabled: selection.length === 0 || selection.length >= doc.pageCount,
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.deletePages(selection);
          if (ok) {
            showToast(many
              ? t('sidebar.pages.deletedMany', { count: selection.length })
              : t('sidebar.pages.deleted'), 'success');
          }
          return ok;
        }); } }
    ];

    // Parented to the body, not the sidebar: the sidebar re-renders on every
    // store notify, which would tear down an open menu mid-interaction.
    openContextMenu(x, y, entries);
  }

  /**
   * Renders each page preview once and reuses it afterwards, so switching tabs
   * or moving between pages does not re-rasterise the whole document.
   */
  private async fillThumbnails(el: HTMLElement, docId: string, pageCount: number, revision: number): Promise<void> {
    for (let idx = 0; idx < pageCount; idx++) {
      const frame = el.querySelector<HTMLElement>(`[data-thumb-frame="${idx}"]`);
      if (!frame) continue;

      // `revision` is the page-structure generation: a page op renumbers every
      // page, so a cache entry from before it would show the wrong page. The
      // handler above also clears the cache, which makes this belt-and-braces.
      const key = `${docId}:${revision}:${idx}`;
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
