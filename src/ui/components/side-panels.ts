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
import { DocumentSession, PDFBookmarkItem } from '../../core/types';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { t } from '../i18n';
import { openContextMenu, MenuEntry } from './context-menu';
import { showToast } from './toast';
import { findMatchesInPageLayout, PdfSearchMatch } from '../../core/pdf-text-layout';
import { triggerAutoSave } from '../../io/storage';

export let sidePanelsInstance: SidePanelsComponent | null = null;

export class SidePanelsComponent {
  private _container: HTMLElement;
  /**
   * Rendered page previews as data URLs, keyed by
   * `${docId}:${structureRevision}:${pageIndex}`.
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
   * Bumped on every page-structure change.
   */
  private _structureRevision = 0;
  /** Last page whose thumbnail was scrolled into view (avoids re-scrolling). */
  private _lastActivePageIndex: number = -1;
  /** Lazy thumbnail rasteriser for the current list generation. */
  private _thumbObserver: IntersectionObserver | null = null;
  /** Token to cancel stale background thumbnail warmup passes. */
  private _thumbWarmupToken = 0;
  /** Monotonic token to cancel stale in-flight searches immediately. */
  private _searchToken = 0;
  private _searchDebounceTimer: number | null = null;

  constructor(container: HTMLElement) {
    sidePanelsInstance = this;
    this._container = container;
    store.subscribe(() => this.render());
    onPageStructureChanged(() => {
      this._thumbnailCache.clear();
      this._structureRevision++;
      this._lastRenderKey = '';
    });
    this.render();
  }

  /**
   * Immediately cancels any in-flight search, clears the search input and results,
   * removes all yellow canvas highlights, and repaints the viewport.
   */
  public cancelAndResetSearch(): boolean {
    const hadSearch =
      store.searchMatches.length > 0 ||
      store.searchQuery.length > 0 ||
      this._searchDebounceTimer !== null;

    this._searchToken++;
    if (this._searchDebounceTimer !== null) {
      window.clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }

    const searchInput = this._container.querySelector<HTMLInputElement>('#pdf-search-input');
    const hadInputText = Boolean(searchInput && searchInput.value.length > 0);
    if (searchInput) {
      searchInput.value = '';
      searchInput.blur();
    }

    store.clearSearchResults();
    this.renderSearchResultsList();
    window.app?.repaintAllRenderedAnnotations();
    return hadSearch || hadInputText;
  }

  public render(): void {
    const isOpen = store.sidebarOpen;
    const activeTab = store.activeSidebarTab;
    const doc = store.activeDocument;

    const outlineSig = doc ? `${doc.bookmarks?.length ?? 0}:${doc.userBookmarks?.length ?? 0}` : '0:0';
    const historySig = activeTab === 'history' ? String(history.historyList.length) : '0';

    const renderKey = [
      isOpen && doc ? 1 : 0,
      activeTab,
      doc?.id ?? '',
      doc?.pageCount ?? 0,
      this._structureRevision,
      outlineSig,
      historySig,
      store.appSettings.language
    ].join('|');

    // Auto-collapse sidebar whenever sidebarOpen is false OR there is no active PDF document
    if (!isOpen || !doc) {
      this._container.classList.add('collapsed');
      this._thumbObserver?.disconnect();
      this._thumbWarmupToken++;
      this._lastRenderKey = renderKey;
      return;
    }

    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') {
      this.syncPageSelection();
      this.syncPageBadges();
      if (activeTab === 'search') {
        this.syncActiveSearchCard();
      }
      return;
    }
    this._lastRenderKey = renderKey;

    if (this._anchorDocId !== (doc?.id ?? null)) {
      this._anchorDocId = doc?.id ?? null;
      this._pageAnchor = null;
    }

    this._container.classList.remove('collapsed');

    const lang = store.appSettings.language;
    const tabTitleMap: Record<string, string> = {
      thumbnails: t('sidebar.thumbnails'),
      outline: t('sidebar.outline'),
      search: t('sidebar.search'),
      history: t('sidebar.history')
    };
    const activeTabTitle = tabTitleMap[activeTab] || t('sidebar.thumbnails');
    let activeTabBadge = '';
    if (activeTab === 'thumbnails') {
      activeTabBadge = `<span class="badge">${doc.pages.length}</span>`;
    } else if (activeTab === 'outline') {
      const totalBm = (doc.bookmarks?.length || 0) + (doc.userBookmarks?.length || 0);
      if (totalBm > 0) activeTabBadge = `<span class="badge">${totalBm}</span>`;
    } else if (activeTab === 'history') {
      const hLen = history.historyList.length;
      if (hLen > 0) activeTabBadge = `<span class="badge">${hLen}</span>`;
    }

    this._container.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-tabs-nav" role="tablist">
          <button class="sidebar-tab-btn ${activeTab === 'thumbnails' ? 'active' : ''}" data-tab="thumbnails" role="tab" aria-selected="${activeTab === 'thumbnails'}" title="${escapeHtml(t('sidebar.thumbnails'))}" aria-label="${escapeHtml(t('sidebar.thumbnails'))}">
            <span class="sidebar-tab-icon">${getIconSvg('gridView', 15)}</span>
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'outline' ? 'active' : ''}" data-tab="outline" role="tab" aria-selected="${activeTab === 'outline'}" title="${escapeHtml(t('sidebar.outline'))}" aria-label="${escapeHtml(t('sidebar.outline'))}">
            <span class="sidebar-tab-icon">${getIconSvg('bookmark', 15)}</span>
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'search' ? 'active' : ''}" data-tab="search" role="tab" aria-selected="${activeTab === 'search'}" title="${escapeHtml(t('sidebar.search'))}" aria-label="${escapeHtml(t('sidebar.search'))}">
            <span class="sidebar-tab-icon">${getIconSvg('search', 15)}</span>
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history" role="tab" aria-selected="${activeTab === 'history'}" title="${escapeHtml(t('sidebar.history'))}" aria-label="${escapeHtml(t('sidebar.history'))}">
            <span class="sidebar-tab-icon">${getIconSvg('history', 15)}</span>
          </button>
        </div>
        <button type="button" class="sidebar-close-btn" id="sidebar-close-btn" title="${lang === 'fa' ? 'بستن نوار کناری' : 'Close Sidebar'}" aria-label="Close Sidebar">
          ${getIconSvg('close', 14)}
        </button>
      </div>
      <div class="sidebar-active-tab-bar">
        <span class="sidebar-active-tab-title">${escapeHtml(activeTabTitle)}</span>
        ${activeTabBadge}
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
    this._lastActivePageIndex = -1;
    this.syncPageSelection();
  }

  private syncPageSelection(): void {
    if (!store.sidebarOpen) return;
    const selected = store.selectedPageIndices;
    const active = store.activePageIndex;
    let activeCard: HTMLElement | null = null;
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

    if (activeCard && this._lastActivePageIndex !== active) {
      (activeCard as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    this._lastActivePageIndex = active;
  }

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

  private renderOutlineTreeHtml(items: PDFBookmarkItem[], depth = 0): string {
    const isFa = store.appSettings.language === 'fa';
    return items.map((item) => {
      const hasPage = typeof item.pageIndex === 'number' && Number.isFinite(item.pageIndex);
      const hasChildren = Boolean(item.items && item.items.length > 0);
      const padStart = 10 + Math.min(depth, 5) * 14;
      const isCurrent = hasPage && item.pageIndex === store.activePageIndex;
      return `
        <div class="outline-tree-node">
          <button type="button"
                  class="list-card is-interactive bookmark-item ${isCurrent ? 'is-current' : ''}"
                  style="padding-inline-start:${padStart}px;"
                  ${hasPage ? `data-bookmark-page="${item.pageIndex}"` : 'disabled'}>
            <span class="list-card-icon">${getIconSvg(hasChildren ? 'bookOpen' : 'book', 13)}</span>
            <span class="list-card-title bookmark-item-title" dir="auto">${escapeHtml(item.title || (isFa ? 'بخش بدون عنوان' : 'Untitled section'))}</span>
            ${hasPage ? `<span class="bookmark-page-pill">${item.pageIndex! + 1}</span>` : ''}
          </button>
          ${hasChildren ? `<div class="outline-tree-children">${this.renderOutlineTreeHtml(item.items!, depth + 1)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  private localizeHistoryDescription(desc: string, lang: 'en' | 'fa'): string {
    if (lang !== 'fa') return desc;
    return desc
      .replace(/^Add\s+(.+)$/i, 'افزودن $1')
      .replace(/^Modify\s+(.+)$/i, 'ویرایش $1')
      .replace(/^Delete\s+(\d+)\s+annotations?$/i, 'حذف $1 مورد')
      .replace(/^Move\s+\/\s+Transform\s+annotations?$/i, 'جابه‌جایی و تغییر اندازه')
      .replace(/^Slice\s+stroke$/i, 'برش خط با پاک‌کن')
      .replace(/\bpen\b/gi, ' دست‌خط')
      .replace(/\bhighlighter\b/gi, ' هایلایت')
      .replace(/\brectangle\b/gi, ' مستطیل')
      .replace(/\bellipse\b/gi, ' دایره/بیضی')
      .replace(/\bline\b/gi, ' خط')
      .replace(/\barrow\b/gi, ' پیکان')
      .replace(/\bpolygon\b/gi, ' چندضلعی')
      .replace(/\bfreeform-shape\b/gi, ' شکل آزاد')
      .replace(/\btext\b/gi, ' کادر متن')
      .replace(/\bsticky-note\b/gi, ' یادداشت چسبان')
      .replace(/\bstamp\b/gi, ' مهر/تصویر')
      .replace(/\bsignature\b/gi, ' امضا');
  }

  private renderTabContent(el: HTMLElement, tab: string) {
    const doc = store.activeDocument;
    const lang = store.appSettings.language;
    if (!doc) {
      el.innerHTML = `<div class="empty-note">${lang === 'fa' ? 'هیچ سندی باز نیست' : 'No document active'}</div>`;
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
            const cachedSrc = this._thumbnailCache.get(`${doc.id}:${this._structureRevision}:${idx}`);
            return `
              <button class="thumbnail-card ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}"
                      data-page="${idx}" role="option" draggable="true"
                      aria-current="${isActive ? 'true' : 'false'}"
                      aria-selected="${isSelected ? 'true' : 'false'}"
                      title="${escapeHtml(t('sidebar.pages.goTo', { page: idx + 1 }))}">
                <span class="thumbnail-frame ${cachedSrc ? '' : 'is-loading'}" data-thumb-frame="${idx}">
                  ${cachedSrc ? `<img src="${cachedSrc}" decoding="async" alt="Page ${idx + 1} preview">` : ''}
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
      const userBookmarks = doc.userBookmarks || [];
      const pdfOutline = doc.bookmarks || [];
      const curPage = store.activePageIndex + 1;

      el.innerHTML = `
        <div class="panel-stack">
          <div class="bookmark-add-box">
            <input type="text" id="custom-bookmark-input" class="field bookmark-add-input" dir="auto"
                   placeholder="${lang === 'fa' ? `عنوان نشانک (صفحه ${curPage})…` : `Bookmark title (Page ${curPage})…`}"
                   aria-label="${lang === 'fa' ? 'عنوان نشانک' : 'Bookmark title'}">
            <button type="button" class="primary-btn is-sm bookmark-add-btn" id="add-page-bookmark-btn" title="${lang === 'fa' ? 'نشانه‌گذاری صفحه فعلی' : 'Bookmark current page'}">
              ${getIconSvg('bookmarkPlus', 14)}
              <span>${lang === 'fa' ? `افزودن ص ${curPage}` : `+ Page ${curPage}`}</span>
            </button>
          </div>

          ${userBookmarks.length > 0 ? `
            <div class="sidebar-section-bar" style="margin-top:4px;">
              <span class="sidebar-section-label">${lang === 'fa' ? 'نشانک‌های من' : 'Saved Bookmarks'}</span>
              <span class="badge">${userBookmarks.length}</span>
            </div>
            <div class="panel-stack">
              ${userBookmarks.map(ub => `
                <div class="list-card is-interactive bookmark-item ${ub.pageIndex === store.activePageIndex ? 'is-current' : ''}"
                     data-bookmark-page="${ub.pageIndex}">
                  <span class="list-card-icon" style="color:var(--accent);">${getIconSvg('bookmark', 13)}</span>
                  <span class="list-card-title bookmark-item-title" dir="auto">${escapeHtml(ub.title)}</span>
                  <span class="bookmark-page-pill">${ub.pageIndex + 1}</span>
                  <button type="button" class="bookmark-delete-btn" data-remove-bookmark="${escapeHtml(ub.id)}" title="${lang === 'fa' ? 'حذف نشانک' : 'Remove bookmark'}" aria-label="${lang === 'fa' ? 'حذف نشانک' : 'Remove bookmark'}">
                    ${getIconSvg('close', 11)}
                  </button>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <div class="sidebar-section-bar" style="margin-top:${userBookmarks.length > 0 ? '8px' : '2px'};">
            <span class="sidebar-section-label">${lang === 'fa' ? 'فهرست مطالب کتاب' : 'Document Outline'}</span>
            ${pdfOutline.length > 0 ? `<span class="badge">${pdfOutline.length}</span>` : ''}
          </div>

          ${pdfOutline.length === 0 ? `
            <div class="sidebar-empty-state">
              <div class="sidebar-empty-icon">${getIconSvg('bookOpen', 22)}</div>
              <div class="sidebar-empty-title">${lang === 'fa' ? 'فهرستی در این پی‌دی‌اف ثبت نشده است' : 'No table of contents in this PDF'}</div>
              <div class="sidebar-empty-sub">${lang === 'fa' ? 'می‌توانید از دکمه بالا برای نشانه‌گذاری صفحات دلخواه استفاده کنید.' : 'Use the button above to bookmark any page for quick access.'}</div>
            </div>
          ` : `
            <div class="panel-stack outline-tree-root">
              ${this.renderOutlineTreeHtml(pdfOutline, 0)}
            </div>
          `}
        </div>
      `;

      const bookmarkInput = el.querySelector<HTMLInputElement>('#custom-bookmark-input');
      const addBookmarkBtn = el.querySelector<HTMLButtonElement>('#add-page-bookmark-btn');
      const handleAddBookmark = () => {
        const pageIdx = store.activePageIndex;
        const customTitle = bookmarkInput?.value.trim() || `${lang === 'fa' ? 'صفحه' : 'Page'} ${pageIdx + 1}`;
        store.addUserBookmark(pageIdx, customTitle);
        triggerAutoSave();
        showToast(lang === 'fa' ? `صفحه ${pageIdx + 1} نشانه‌گذاری شد` : `Bookmarked Page ${pageIdx + 1}`, 'success');
      };

      addBookmarkBtn?.addEventListener('click', handleAddBookmark);
      bookmarkInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddBookmark();
        }
      });

      el.querySelectorAll<HTMLElement>('[data-remove-bookmark]').forEach((delBtn) => {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bmId = delBtn.getAttribute('data-remove-bookmark');
          if (bmId) {
            store.removeUserBookmark(bmId);
            triggerAutoSave();
          }
        });
      });

      el.querySelectorAll<HTMLElement>('[data-bookmark-page]').forEach((itemEl) => {
        itemEl.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-remove-bookmark]')) return;
          const pageIdx = parseInt(itemEl.getAttribute('data-bookmark-page') || '-1', 10);
          if (Number.isFinite(pageIdx) && pageIdx >= 0 && pageIdx < doc.pageCount) {
            store.setActivePageIndex(pageIdx);
            viewportManager.scrollToPage(pageIdx);
          }
        });
      });
    } else if (tab === 'search') {
      el.innerHTML = `
        <div class="panel-stack">
          <div class="sidebar-search-box">
            <span class="sidebar-search-icon">${getIconSvg('search', 14)}</span>
            <input type="search" id="pdf-search-input" class="sidebar-search-input" dir="auto"
                   value="${escapeHtml(store.searchQuery)}"
                   placeholder="${lang === 'fa' ? 'جستجوی متن در سند…' : 'Search text in document…'}"
                   aria-label="${lang === 'fa' ? 'جستجوی متن در سند' : 'Search text in document'}">
            <span id="search-status-bar" class="sidebar-search-count"></span>
            <div class="sidebar-search-actions">
              <button type="button" class="sidebar-search-nav-btn" id="pdf-search-prev" title="${lang === 'fa' ? 'نتیجه قبلی (Shift+Enter)' : 'Previous match (Shift+Enter)'}" aria-label="${lang === 'fa' ? 'نتیجه قبلی' : 'Previous match'}">
                ${getIconSvg('chevronUp', 14)}
              </button>
              <button type="button" class="sidebar-search-nav-btn" id="pdf-search-next" title="${lang === 'fa' ? 'نتیجه بعدی (Enter)' : 'Next match (Enter)'}" aria-label="${lang === 'fa' ? 'نتیجه بعدی' : 'Next match'}">
                ${getIconSvg('chevronDown', 14)}
              </button>
              <button type="button" class="sidebar-search-nav-btn is-clear" id="pdf-search-clear" title="${lang === 'fa' ? 'پاک کردن جستجو (Esc)' : 'Clear search (Esc)'}" aria-label="${lang === 'fa' ? 'پاک کردن جستجو' : 'Clear search'}">
                ${getIconSvg('close', 13)}
              </button>
            </div>
          </div>
          <div id="search-results-list" class="panel-stack search-results-container"></div>
        </div>
      `;

      const searchInput = el.querySelector<HTMLInputElement>('#pdf-search-input');
      const prevBtn = el.querySelector<HTMLButtonElement>('#pdf-search-prev');
      const nextBtn = el.querySelector<HTMLButtonElement>('#pdf-search-next');
      const clearBtn = el.querySelector<HTMLButtonElement>('#pdf-search-clear');

      this.renderSearchResultsList();

      const triggerSearch = (rawQuery: string, autoJumpFirst: boolean) => {
        void this.executeConcurrentSearch(doc, rawQuery, autoJumpFirst);
      };

      searchInput?.addEventListener('input', () => {
        if (this._searchDebounceTimer !== null) {
          window.clearTimeout(this._searchDebounceTimer);
          this._searchDebounceTimer = null;
        }
        const val = searchInput.value.trim();
        if (!val) {
          this._searchToken++;
          store.clearSearchResults();
          this.renderSearchResultsList();
          window.app?.repaintAllRenderedAnnotations();
          return;
        }
        this._searchDebounceTimer = window.setTimeout(() => {
          this._searchDebounceTimer = null;
          triggerSearch(val, true);
        }, 120);
      });

      searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.cancelAndResetSearch();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this._searchDebounceTimer !== null) {
            window.clearTimeout(this._searchDebounceTimer);
            this._searchDebounceTimer = null;
          }
          const val = searchInput.value.trim();
          if (!val) return;
          if (val.toLowerCase() === store.searchQuery.toLowerCase() && store.searchMatches.length > 0) {
            const delta = e.shiftKey ? -1 : 1;
            const nextIdx = (store.activeSearchMatchIndex + delta + store.searchMatches.length) % store.searchMatches.length;
            this.jumpToSearchMatch(nextIdx);
          } else {
            triggerSearch(val, true);
          }
        }
      });

      prevBtn?.addEventListener('click', () => {
        if (store.searchMatches.length === 0) return;
        const nextIdx = (store.activeSearchMatchIndex - 1 + store.searchMatches.length) % store.searchMatches.length;
        this.jumpToSearchMatch(nextIdx);
      });

      nextBtn?.addEventListener('click', () => {
        if (store.searchMatches.length === 0) return;
        const nextIdx = (store.activeSearchMatchIndex + 1) % store.searchMatches.length;
        this.jumpToSearchMatch(nextIdx);
      });

      clearBtn?.addEventListener('click', () => {
        this.cancelAndResetSearch();
      });
    } else if (tab === 'history') {
      const historyItems = history.historyList;
      if (historyItems.length === 0) {
        el.innerHTML = `
          <div class="sidebar-empty-state">
            <div class="sidebar-empty-icon">${getIconSvg('history', 22)}</div>
            <div class="sidebar-empty-title">${lang === 'fa' ? 'هنوز تغییری ثبت نشده است' : 'No actions recorded yet'}</div>
            <div class="sidebar-empty-sub">${lang === 'fa' ? 'تغییرات و یادداشت‌های شما در اینجا نمایش داده می‌شوند.' : 'Your annotation edits and page actions will appear here.'}</div>
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="panel-stack">
            ${historyItems.slice().reverse().map(h => `
              <div class="list-card history-item-card ${h.isCurrent ? 'is-current' : ''}">
                <span class="list-card-icon">${getIconSvg('clock', 13)}</span>
                <div style="flex:1; min-width:0;">
                  <div class="list-card-title" dir="auto">${escapeHtml(this.localizeHistoryDescription(h.description, lang))}</div>
                  <span class="list-card-meta">${new Date(h.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            `).join('')}
          </div>
        `;
      }
    }
  }

  private bindThumbnailList(list: HTMLElement, doc: DocumentSession): void {
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
        if (moving.length === 0 || moving.includes(idx)) return;
        const toIndex = moving[0] > idx ? idx : idx + 1;
        void this.runPageAction(() => pageActions.movePages(moving, toIndex));
      });
    }

    list.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'INPUT') return;
      const mod = e.ctrlKey || e.metaKey;
      const current = store.effectivePageSelection();

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

  private async runPageAction(run: () => Promise<boolean>): Promise<void> {
    const doc = store.activeDocument;
    if (!doc) return;
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
      { kind: 'action', id: 'page-blank-before', label: t('sidebar.pages.insertBlankBefore'), icon: 'pagePlus',
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.insertBlankPages(selection[0], 1);
          if (ok) showToast(t('sidebar.pages.blankInserted'), 'success');
          return ok;
        }); } },
      { kind: 'action', id: 'page-blank-after', label: t('sidebar.pages.insertBlankAfter'), icon: 'pagePlus',
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

    openContextMenu(x, y, entries);
  }

  /**
   * Ultra-fast thumbnail loader:
   * 1. Encodes thumbnails as fast JPEG (0.80) instead of heavy PNG.
   * 2. Immediately renders the active page neighborhood (`activePageIndex ± 6`) in parallel.
   * 3. Uses a wide 1400px IntersectionObserver lookahead for scrolling.
   * 4. Pre-warms remaining pages in background batches of 4 so thumbnails are ready before scrolling.
   */
  private fillThumbnails(el: HTMLElement, docId: string, pageCount: number, revision: number): void {
    this._thumbObserver?.disconnect();
    const warmupToken = ++this._thumbWarmupToken;
    const inFlight = new Set<number>();

    const fillFrame = async (idx: number): Promise<void> => {
      if (idx < 0 || idx >= pageCount) return;
      const key = `${docId}:${revision}:${idx}`;
      let src = this._thumbnailCache.get(key);

      if (!src) {
        if (inFlight.has(idx)) return;
        inFlight.add(idx);
        try {
          const fast = pdfEngine.thumbnailFromCache(idx);
          const rendered = fast ?? await pdfEngine.renderThumbnail(idx);
          if (!rendered) return;
          src = rendered.toDataURL('image/jpeg', 0.80);
          this._thumbnailCache.set(key, src);
        } finally {
          inFlight.delete(idx);
        }
      }

      const frame = el.querySelector<HTMLElement>(`[data-thumb-frame="${idx}"]`);
      if (!frame || !frame.isConnected) return;
      if (frame.querySelector('img')) {
        frame.classList.remove('is-loading');
        return;
      }

      const img = document.createElement('img');
      img.src = src;
      img.decoding = 'async';
      img.alt = `Page ${idx + 1} preview`;
      frame.classList.remove('is-loading');
      frame.prepend(img);
    };

    // 1. Immediate priority batch around the current page (activePageIndex ± 6)
    const center = store.activePageIndex;
    const priorityIndices: number[] = [];
    for (let radius = 0; radius <= 6; radius++) {
      const a = center - radius;
      const b = center + radius;
      if (a >= 0 && a < pageCount) priorityIndices.push(a);
      if (radius > 0 && b >= 0 && b < pageCount) priorityIndices.push(b);
    }

    // 2. Wide-margin IntersectionObserver for instant scroll lookahead
    this._thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._thumbObserver?.unobserve(entry.target);
        const frame = entry.target as HTMLElement;
        const idx = Number(frame.dataset.thumbFrame);
        if (Number.isFinite(idx)) void fillFrame(idx);
      }
    }, { rootMargin: '1400px' });

    for (let idx = 0; idx < pageCount; idx++) {
      const frame = el.querySelector<HTMLElement>(`[data-thumb-frame="${idx}"]`);
      if (frame && !frame.querySelector('img')) {
        this._thumbObserver.observe(frame);
      }
    }

    // 3. Run priority pages immediately in parallel, then pre-warm remaining pages in background batches of 4
    void (async () => {
      const batchSize = 4;
      for (let i = 0; i < priorityIndices.length; i += batchSize) {
        if (warmupToken !== this._thumbWarmupToken || store.activeDocument?.id !== docId) return;
        const slice = priorityIndices.slice(i, i + batchSize);
        await Promise.all(slice.map(idx => fillFrame(idx)));
      }

      // Background pre-warm remaining pages up to 160 pages so scrolling never hits shimmer
      const maxWarmup = Math.min(pageCount, 160);
      for (let idx = 0; idx < maxWarmup; idx += batchSize) {
        if (warmupToken !== this._thumbWarmupToken || store.activeDocument?.id !== docId || !store.sidebarOpen) return;
        const batch: number[] = [];
        for (let k = idx; k < Math.min(maxWarmup, idx + batchSize); k++) {
          if (!this._thumbnailCache.has(`${docId}:${revision}:${k}`)) {
            batch.push(k);
          }
        }
        if (batch.length > 0) {
          await Promise.all(batch.map(p => fillFrame(p)));
          await new Promise(r => setTimeout(r, 8));
        }
      }
    })();
  }

  private async executeConcurrentSearch(
    doc: DocumentSession,
    rawQuery: string,
    autoJumpFirst: boolean
  ): Promise<void> {
    const query = rawQuery.trim();
    const token = ++this._searchToken;
    const statusBar = this._container.querySelector<HTMLElement>('#search-status-bar');

    if (!query) {
      store.clearSearchResults();
      this.renderSearchResultsList();
      window.app?.repaintAllRenderedAnnotations();
      return;
    }

    if (statusBar) statusBar.textContent = '…';

    const allMatches: PdfSearchMatch[] = [];
    const totalPages = doc.pages.length;
    const batchSize = 8;
    let jumpedToFirst = false;

    for (let batchStart = 0; batchStart < totalPages; batchStart += batchSize) {
      if (token !== this._searchToken || store.activeDocument?.id !== doc.id) return;
      const batchEnd = Math.min(totalPages, batchStart + batchSize);
      const batchPromises: Promise<PdfSearchMatch[]>[] = [];

      for (let pageIdx = batchStart; pageIdx < batchEnd; pageIdx++) {
        batchPromises.push(
          pdfEngine.getPageTextLayout(pageIdx).then((layout) => {
            if (!layout) return [];
            return findMatchesInPageLayout(layout, query);
          })
        );
      }

      const batchResults = await Promise.all(batchPromises);
      if (token !== this._searchToken || store.activeDocument?.id !== doc.id) return;

      let addedInBatch = false;
      for (const pageMatches of batchResults) {
        if (pageMatches.length > 0) {
          allMatches.push(...pageMatches);
          addedInBatch = true;
        }
      }

      if (addedInBatch) {
        const activeIdx = allMatches.length > 0 ? Math.max(0, store.activeSearchMatchIndex) : -1;
        store.setSearchResults(query, [...allMatches], activeIdx);
        this.renderSearchResultsList();
        window.app?.repaintAllRenderedAnnotations();

        if (autoJumpFirst && !jumpedToFirst && allMatches.length > 0) {
          jumpedToFirst = true;
          this.jumpToSearchMatch(0);
        }
      }
    }

    if (token !== this._searchToken || store.activeDocument?.id !== doc.id) return;

    if (allMatches.length === 0) {
      store.setSearchResults(query, [], -1);
      this.renderSearchResultsList();
      window.app?.repaintAllRenderedAnnotations();
    } else {
      this.renderSearchResultsList();
    }
  }

  private jumpToSearchMatch(matchIndex: number): void {
    const matches = store.searchMatches;
    if (matchIndex < 0 || matchIndex >= matches.length) return;
    const match = matches[matchIndex];
    store.setActiveSearchMatchIndex(matchIndex);

    viewportManager.scrollToPage(match.pageIndex);
    const scroller = document.getElementById('document-scroll-container');
    const layout = viewportManager.getLayout(match.pageIndex);
    if (scroller && layout) {
      const zoom = store.zoom;
      const targetCenterY = layout.top + (match.bounds.y + match.bounds.height / 2) * zoom;
      const desiredTop = Math.max(0, targetCenterY - scroller.clientHeight * 0.42);
      scroller.scrollTop = desiredTop;
    }

    this.syncActiveSearchCard();
    window.app?.repaintAllRenderedAnnotations();
  }

  private syncActiveSearchCard(): void {
    const activeIdx = store.activeSearchMatchIndex;
    const matches = store.searchMatches;
    const statusBar = this._container.querySelector<HTMLElement>('#search-status-bar');
    if (statusBar) {
      if (!store.searchQuery) {
        statusBar.textContent = '';
        statusBar.classList.remove('has-matches', 'no-matches');
      } else if (matches.length === 0) {
        statusBar.textContent = '0/0';
        statusBar.classList.add('no-matches');
        statusBar.classList.remove('has-matches');
      } else {
        statusBar.textContent = `${activeIdx + 1}/${matches.length}`;
        statusBar.classList.add('has-matches');
        statusBar.classList.remove('no-matches');
      }
    }

    const cards = this._container.querySelectorAll<HTMLElement>('.search-result-card[data-match-index]');
    cards.forEach((card) => {
      const idx = parseInt(card.dataset.matchIndex || '-1', 10);
      const isCurrent = idx === activeIdx;
      card.classList.toggle('is-current', isCurrent);
      if (isCurrent) {
        card.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  private renderSearchResultsList(): void {
    const resultsList = this._container.querySelector<HTMLElement>('#search-results-list');
    const statusBar = this._container.querySelector<HTMLElement>('#search-status-bar');
    const lang = store.appSettings.language;
    if (!resultsList) return;

    const query = store.searchQuery;
    const matches = store.searchMatches;
    const activeIdx = store.activeSearchMatchIndex;

    if (!query) {
      if (statusBar) {
        statusBar.textContent = '';
        statusBar.classList.remove('has-matches', 'no-matches');
      }
      resultsList.innerHTML = `
        <div class="sidebar-empty-state">
          <div class="sidebar-empty-icon">${getIconSvg('search', 22)}</div>
          <div class="sidebar-empty-title">${lang === 'fa' ? 'جستجو در تمام صفحات' : 'Search across all pages'}</div>
          <div class="sidebar-empty-sub">${lang === 'fa' ? 'عبارت مورد نظر را در کادر بالا بنویسید تا تمام نتایج هایلایت شوند.' : 'Type a word or phrase above to highlight and jump to matches.'}</div>
        </div>
      `;
      return;
    }

    if (matches.length === 0) {
      if (statusBar) {
        statusBar.textContent = '0/0';
        statusBar.classList.add('no-matches');
        statusBar.classList.remove('has-matches');
      }
      resultsList.innerHTML = `
        <div class="sidebar-empty-state">
          <div class="sidebar-empty-icon">${getIconSvg('search', 22)}</div>
          <div class="sidebar-empty-title">${lang === 'fa' ? 'نتیجه‌ای یافت نشد' : 'No matches found'}</div>
          <div class="sidebar-empty-sub">${lang === 'fa' ? 'عبارت دیگری را امتحان کنید.' : 'Try searching for a different keyword.'}</div>
        </div>
      `;
      return;
    }

    if (statusBar) {
      statusBar.textContent = `${activeIdx + 1}/${matches.length}`;
      statusBar.classList.add('has-matches');
      statusBar.classList.remove('no-matches');
    }

    resultsList.innerHTML = matches.map((m, idx) => `
      <div class="list-card is-interactive search-result-card ${idx === activeIdx ? 'is-current' : ''}"
           data-match-index="${idx}" data-page="${m.pageIndex}">
        <div class="search-result-header">
          <span class="search-result-page">${lang === 'fa' ? `صفحه ${m.pageIndex + 1}` : `Page ${m.pageIndex + 1}`}</span>
          <span class="search-result-index">#${idx + 1}</span>
        </div>
        <span class="search-result-snippet" dir="auto">
          ${escapeHtml(m.snippetPre)}<mark class="search-result-mark">${escapeHtml(m.snippetMatch)}</mark>${escapeHtml(m.snippetPost)}
        </span>
      </div>
    `).join('');

    resultsList.querySelectorAll<HTMLElement>('.search-result-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.matchIndex || '0', 10);
        this.jumpToSearchMatch(idx);
      });
    });
  }
}
