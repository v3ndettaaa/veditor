/**
 * Collapsible Side Panels Component
 * Manages Page Thumbnails, Document Outline/Bookmarks, Search, and Action History.
 */

import { store } from '../../core/store';
import { history, DeleteAnnotationsCommand } from '../../core/history';
import { viewportManager } from '../../core/viewport';
import { pdfEngine } from '../../core/pdf-engine';
import { pageActions } from '../../core/page-actions';
import { onPageStructureChanged } from '../../core/page-ops';
import { Annotation, DocumentSession, PDFBookmarkItem } from '../../core/types';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { t, tr } from '../i18n';
import { openContextMenu, MenuEntry } from './context-menu';
import { cropDialog } from './crop-dialog';
import { showToast } from './toast';
import { findMatchesInPageLayout, PdfSearchMatch } from '../../core/pdf-text-layout';
import { triggerAutoSave } from '../../io/storage';
import {
  AnnotationFilterCategory,
  describeAnnotationItem,
  buildAnnotationsMarkdownSummary
} from '../../core/annotations-summary';

export {
  type AnnotationFilterCategory,
  describeAnnotationItem,
  buildAnnotationsMarkdownSummary
};

export let sidePanelsInstance: SidePanelsComponent | null = null;

export class SidePanelsComponent {
  private _container: HTMLElement;
  /**
   * Rendered page previews as data URLs, keyed by
   * `${docId}:${structureRevision}:${pageIndex}`.
   */
  private _thumbnailCache: Map<string, string> = new Map();
  /**
   * Last rendered thumbnail per `${docId}:${pageIndex}` used as an instant placeholder
   * during page structure reloads so thumbnails update in-place without flashing blank.
   */
  private _prevThumbnailByPage: Map<string, string> = new Map();
  /** Zoom never changes sidebar output — skip full rebuilds on zoom-only notifies. */
  private _lastRenderKey: string = '';
  private _lastRenderedTab: string = '';
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
  private _annotationFilter: AnnotationFilterCategory = 'all';

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
   * Called by main.ts after `pdfEngine.loadFromBytes(..., true)` has finished hot-swapping
   * the updated PDF document in memory, ensuring thumbnails re-rasterize from the new PDF.
   */
  public refreshAfterStructureReload(): void {
    this._thumbnailCache.clear();
    this._structureRevision++;
    this._lastRenderKey = '';
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

    const userBmSig = (doc?.userBookmarks || [])
      .map(b => `${b.id}:${b.pageIndex}:${b.title}:${b.note || ''}`)
      .join(',');
    const outlineSig = doc ? `${doc.bookmarks?.length ?? 0}:${userBmSig}` : '0:';
    const historySig = activeTab === 'history' ? String(history.historyList.length) : '0';
    const annotSig = activeTab === 'annotations' && doc
      ? `${this._annotationFilter}:` + Object.entries(doc.annotations || {})
          .map(([k, list]) => `${k}:${(list || []).map(a => `${a.id}:${a.updatedAt}`).join(',')}`)
          .join(';')
      : '0';

    const renderKey = [
      activeTab,
      doc?.id ?? '',
      doc?.pageCount ?? 0,
      this._structureRevision,
      outlineSig,
      historySig,
      annotSig,
      store.appSettings.language
    ].join('|');

    // Auto-collapse sidebar whenever sidebarOpen is false OR there is no active PDF document
    if (!isOpen || !doc) {
      this._container.classList.add('collapsed');
      if (this._thumbObserver) {
        this._thumbObserver.disconnect();
        this._thumbObserver = null;
      }
      this._thumbWarmupToken++;
      if (!doc) {
        this._lastRenderKey = '';
      }
      return;
    }

    const wasCollapsed = this._container.classList.contains('collapsed');
    this._container.classList.remove('collapsed');

    if (renderKey === this._lastRenderKey && this._container.innerHTML !== '') {
      this.syncPageSelection();
      this.syncPageBadges();
      this.syncOutlineState();
      this.syncAnnotationSelection();
      if (activeTab === 'search') {
        this.syncActiveSearchCard();
      } else if (activeTab === 'thumbnails' && (wasCollapsed || !this._thumbObserver)) {
        const contentArea = this._container.querySelector<HTMLElement>('#sidebar-tab-content');
        if (contentArea) {
          this.fillThumbnails(contentArea, doc.id, doc.pages.length, this._structureRevision);
        }
      }
      return;
    }
    this._lastRenderKey = renderKey;

    if (this._anchorDocId !== (doc?.id ?? null)) {
      this._anchorDocId = doc?.id ?? null;
      this._pageAnchor = null;
    }

    const lang = store.appSettings.language;
    const tabTitleMap: Record<string, string> = {
      thumbnails: t('sidebar.thumbnails'),
      outline: t('sidebar.outline'),
      annotations: lang === 'fa' ? 'حاشیه‌نویسی‌ها و هایلایت‌ها' : 'Annotations & Highlights',
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
    } else if (activeTab === 'annotations') {
      const totalAnn = Object.values(doc.annotations || {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0);
      if (totalAnn > 0) activeTabBadge = `<span class="badge">${totalAnn}</span>`;
    } else if (activeTab === 'history') {
      const hLen = history.historyList.length;
      if (hLen > 0) activeTabBadge = `<span class="badge">${hLen}</span>`;
    }

    const prevThumbListScrollTop = this._container.querySelector<HTMLElement>('#thumbnail-list')?.scrollTop ?? null;

    this._container.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-tabs-nav" role="tablist">
          <button class="sidebar-tab-btn ${activeTab === 'thumbnails' ? 'active' : ''}" data-tab="thumbnails" role="tab" aria-selected="${activeTab === 'thumbnails'}" title="${escapeHtml(t('sidebar.thumbnails'))}" aria-label="${escapeHtml(t('sidebar.thumbnails'))}">
            <span class="sidebar-tab-icon">${getIconSvg('gridView', 15)}</span>
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'outline' ? 'active' : ''}" data-tab="outline" role="tab" aria-selected="${activeTab === 'outline'}" title="${escapeHtml(t('sidebar.outline'))}" aria-label="${escapeHtml(t('sidebar.outline'))}">
            <span class="sidebar-tab-icon">${getIconSvg('bookmark', 15)}</span>
          </button>
          <button class="sidebar-tab-btn ${activeTab === 'annotations' ? 'active' : ''}" data-tab="annotations" role="tab" aria-selected="${activeTab === 'annotations'}" title="${lang === 'fa' ? 'حاشیه‌نویسی‌ها و هایلایت‌ها' : 'Annotations & Highlights'}" aria-label="${lang === 'fa' ? 'حاشیه‌نویسی‌ها و هایلایت‌ها' : 'Annotations & Highlights'}">
            <span class="sidebar-tab-icon">${getIconSvg('annotations', 15)}</span>
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
    if (prevThumbListScrollTop !== null && prevThumbListScrollTop > 0) {
      const nextThumbList = this._container.querySelector<HTMLElement>('#thumbnail-list');
      if (nextThumbList) {
        nextThumbList.scrollTop = prevThumbListScrollTop;
      }
      this._lastActivePageIndex = store.activePageIndex;
    } else {
      this._lastActivePageIndex = -1;
    }
    this.syncPageSelection();
    this.syncOutlineState();
  }

  private syncOutlineState(): void {
    const lang = store.appSettings.language;
    const curPage = store.activePageIndex + 1;

    const addBtnLabel = this._container.querySelector<HTMLElement>('#add-page-bookmark-btn span');
    if (addBtnLabel) {
      const nextText = lang === 'fa' ? `افزودن ص ${curPage}` : `+ Page ${curPage}`;
      if (addBtnLabel.textContent !== nextText) {
        addBtnLabel.textContent = nextText;
      }
    }

    const titleInput = this._container.querySelector<HTMLInputElement>('#custom-bookmark-input');
    if (titleInput) {
      const nextPlaceholder = lang === 'fa' ? `عنوان نشانک (صفحه ${curPage})…` : `Bookmark title (Page ${curPage})…`;
      if (titleInput.placeholder !== nextPlaceholder) {
        titleInput.placeholder = nextPlaceholder;
      }
    }

    this._container.querySelectorAll<HTMLElement>('.bookmark-item[data-bookmark-page]').forEach(item => {
      const pageIdx = parseInt(item.getAttribute('data-bookmark-page') || '-1', 10);
      const isCurrent = pageIdx === store.activePageIndex;
      if (item.classList.contains('is-current') !== isCurrent) {
        item.classList.toggle('is-current', isCurrent);
      }
    });
  }

  private syncAnnotationSelection(): void {
    this._container.querySelectorAll<HTMLElement>('.annot-card[data-annot-jump-id]').forEach(card => {
      const id = card.getAttribute('data-annot-jump-id') || '';
      const isCurrent = id.length > 0 && store.selectedAnnotationIds.has(id);
      if (card.classList.contains('is-current') !== isCurrent) {
        card.classList.toggle('is-current', isCurrent);
      }
    });
  }

  private syncPageSelection(): void {
    const selected = store.selectedPageIndices;
    const active = store.activePageIndex;
    const effective = store.effectivePageSelection();
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

      const img = card.querySelector<HTMLImageElement>('[data-thumb-frame] img');
      if (img) {
        const rot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
        const nextTransform = rot ? `rotate(${rot}deg)` : '';
        if (img.style.transform !== nextTransform) {
          img.style.transform = nextTransform;
        }
      }

      if (isActive) activeCard = card;
    });

    // Keep the top Extract button label synced with the number of selected pages
    const extractBtnLabel = this._container.querySelector<HTMLElement>('#sidebar-extract-pdf-btn span');
    if (extractBtnLabel) {
      extractBtnLabel.textContent = effective.length > 1
        ? `${tr('Extract', 'استخراج')} (${effective.length})`
        : tr('Extract', 'استخراج');
    }

    if (activeCard && this._lastActivePageIndex !== active) {
      (activeCard as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    this._lastActivePageIndex = active;
  }

  /**
   * Opens a file picker to merge one or more external PDF files at `atIndex`
   * (defaults to right after the currently selected/active page).
   */
  public promptMergeExternalPdf(atIndex?: number): void {
    const doc = store.activeDocument;
    if (!doc || doc.notebook) return;
    const selection = store.effectivePageSelection();
    const targetIdx = atIndex !== undefined
      ? Math.max(0, Math.min(doc.pageCount, atIndex))
      : (selection.length > 0 ? selection[selection.length - 1] + 1 : (store.activePageIndex || 0) + 1);

    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.accept = 'application/pdf,.pdf';
    tempInput.multiple = true;
    tempInput.style.display = 'none';
    document.body.appendChild(tempInput);

    tempInput.addEventListener('change', async () => {
      const files = Array.from(tempInput.files || []).filter(
        f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      tempInput.remove();
      if (files.length === 0) return;
      await this.mergeDroppedOrPickedFiles(files, targetIdx);
    });

    tempInput.click();
  }

  private async mergeDroppedOrPickedFiles(files: File[], insertAt: number): Promise<void> {
    const doc = store.activeDocument;
    if (!doc || doc.notebook || files.length === 0) return;
    if (pageActions.isBusy) return;

    try {
      const buffers: Uint8Array[] = [];
      for (const file of files) {
        const ab = await file.arrayBuffer();
        if (ab.byteLength > 0) {
          buffers.push(new Uint8Array(ab));
        }
      }
      if (buffers.length === 0) return;
      const inserted = await pageActions.mergeExternalPdfBytes(insertAt, buffers);
      if (inserted > 0) {
        showToast(t('sidebar.pages.merged', { count: inserted }), 'success');
      } else {
        showToast(t('sidebar.pages.failed'), 'error');
      }
    } catch (err) {
      console.error('Could not merge external PDF files:', err);
      showToast(t('sidebar.pages.failed'), 'error');
    }
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
    if (this._lastRenderedTab !== tab) {
      el.classList.remove('sidebar-tab-enter');
      void el.offsetWidth;
      el.classList.add('sidebar-tab-enter');
      this._lastRenderedTab = tab;
    }

    if (!doc) {
      el.innerHTML = `<div class="empty-note">${lang === 'fa' ? 'هیچ سندی باز نیست' : 'No document active'}</div>`;
      return;
    }

    if (tab === 'thumbnails') {
      const selected = store.selectedPageIndices;
      const isNotebook = !!doc.notebook;
      el.innerHTML = `
        <div class="sidebar-pages-toolbar">
          <button type="button" class="sidebar-page-action-btn" id="sidebar-merge-pdf-btn" ${isNotebook ? 'disabled' : ''} title="${escapeHtml(tr('Merge external PDF file(s) into this document (or drag & drop PDF here)', 'ادغام فایل پی‌دی‌اف خارجی در این سند (یا رها کردن فایل در اینجا)'))}">
            ${getIconSvg('merge', 13)}
            <span>${tr('Merge', 'ادغام')}</span>
          </button>
          <button type="button" class="sidebar-page-action-btn" id="sidebar-extract-pdf-btn" title="${escapeHtml(tr('Extract selected page(s) as a standalone PDF file', 'استخراج صفحات انتخاب‌شده به‌صورت فایل پی‌دی‌اف مجزا'))}">
            ${getIconSvg('extract', 13)}
            <span>${tr('Extract', 'استخراج')}</span>
          </button>
          <button type="button" class="sidebar-page-action-btn" id="sidebar-crop-pdf-btn" ${isNotebook ? 'disabled' : ''} title="${escapeHtml(tr('Crop page margins', 'برش حاشیه صفحات'))}">
            ${getIconSvg('crop', 13)}
            <span>${tr('Crop', 'برش')}</span>
          </button>
        </div>
        <div class="thumbnail-list" id="thumbnail-list" tabindex="0" role="listbox" aria-multiselectable="true">
          <div class="thumbnail-drop-indicator" id="thumbnail-drop-indicator" aria-hidden="true"></div>
          ${doc.pages.map((_p, idx) => {
            const isActive = idx === store.activePageIndex;
            const isSelected = selected.has(idx);
            const annotCount = doc.annotations[idx]?.length || 0;
            const cachedSrc = this._thumbnailCache.get(`${doc.id}:${this._structureRevision}:${idx}`);
            const fallbackSrc = cachedSrc || this._prevThumbnailByPage.get(`${doc.id}:${idx}`);
            const isStale = !cachedSrc && Boolean(fallbackSrc);
            const rot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
            const rotStyle = rot ? ` style="transform: rotate(${rot}deg);"` : '';
            return `
              <button class="thumbnail-card ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}"
                      data-page="${idx}" role="option" draggable="true"
                      aria-current="${isActive ? 'true' : 'false'}"
                      aria-selected="${isSelected ? 'true' : 'false'}"
                      title="${escapeHtml(t('sidebar.pages.goTo', { page: idx + 1 }))}">
                <span class="thumbnail-frame ${fallbackSrc ? '' : 'is-loading'}" data-thumb-frame="${idx}">
                  ${fallbackSrc ? `<img src="${fallbackSrc}" ${isStale ? 'data-stale="true"' : ''} decoding="async" alt="Page ${idx + 1} preview"${rotStyle}>` : ''}
                  ${annotCount > 0 ? `<span class="thumbnail-badge">${annotCount}</span>` : ''}
                </span>
                <span class="thumbnail-label">${idx + 1}</span>
              </button>
            `;
          }).join('')}
        </div>
      `;

      el.querySelector('#sidebar-merge-pdf-btn')?.addEventListener('click', () => {
        this.promptMergeExternalPdf();
      });
      el.querySelector('#sidebar-extract-pdf-btn')?.addEventListener('click', () => {
        const sel = store.effectivePageSelection();
        void this.runPageAction(async () => {
          const ok = await pageActions.extractPagesToFile(sel);
          if (ok) showToast(t('sidebar.pages.extracted', { count: sel.length }), 'success');
          return ok;
        });
      });
      el.querySelector('#sidebar-crop-pdf-btn')?.addEventListener('click', () => {
        void cropDialog.open(store.activePageIndex);
      });

      const list = el.querySelector<HTMLElement>('#thumbnail-list');
      if (list) this.bindThumbnailList(list, doc);
      this.fillThumbnails(el, doc.id, doc.pages.length, this._structureRevision);
    } else if (tab === 'outline') {
      const userBookmarks = doc.userBookmarks || [];
      const pdfOutline = doc.bookmarks || [];
      const curPage = store.activePageIndex + 1;

      el.innerHTML = `
        <div class="panel-stack">
          <div class="bookmark-add-stack">
            <div class="bookmark-add-box">
              <input type="text" id="custom-bookmark-input" class="field bookmark-add-input" dir="auto"
                     placeholder="${lang === 'fa' ? `عنوان نشانک (صفحه ${curPage})…` : `Bookmark title (Page ${curPage})…`}"
                     aria-label="${lang === 'fa' ? 'عنوان نشانک' : 'Bookmark title'}">
              <button type="button" class="primary-btn is-sm bookmark-add-btn" id="add-page-bookmark-btn" title="${lang === 'fa' ? 'نشانه‌گذاری صفحه فعلی' : 'Bookmark current page'}">
                ${getIconSvg('bookmarkPlus', 14)}
                <span>${lang === 'fa' ? `افزودن ص ${curPage}` : `+ Page ${curPage}`}</span>
              </button>
            </div>
            <input type="text" id="custom-bookmark-note-input" class="field bookmark-note-input" dir="auto"
                   placeholder="${lang === 'fa' ? 'یادداشت کوتاه برای این نشانک (اختیاری)…' : 'Add a note for this bookmark (optional)…'}"
                   aria-label="${lang === 'fa' ? 'یادداشت نشانک' : 'Bookmark note'}">
          </div>

          ${userBookmarks.length > 0 ? `
            <div class="sidebar-section-bar" style="margin-top:4px;">
              <span class="sidebar-section-label">${lang === 'fa' ? 'نشانک‌های من' : 'Saved Bookmarks'}</span>
              <span class="badge">${userBookmarks.length}</span>
            </div>
            <div class="panel-stack">
              ${userBookmarks.map(ub => `
                <div class="bookmark-card-wrapper" data-bookmark-wrapper="${escapeHtml(ub.id)}">
                  <div class="list-card is-interactive bookmark-item ${ub.pageIndex === store.activePageIndex ? 'is-current' : ''}"
                       data-bookmark-page="${ub.pageIndex}">
                    <span class="list-card-icon" style="color:var(--accent);">${getIconSvg('bookmark', 13)}</span>
                    <div class="bookmark-item-body">
                      <span class="list-card-title bookmark-item-title" dir="auto">${escapeHtml(ub.title)}</span>
                      ${ub.note ? `<div class="bookmark-note-preview" dir="auto">${escapeHtml(ub.note)}</div>` : ''}
                    </div>
                    <span class="bookmark-page-pill">${ub.pageIndex + 1}</span>
                    <button type="button" class="bookmark-edit-btn" data-edit-bookmark="${escapeHtml(ub.id)}" title="${lang === 'fa' ? 'ویرایش عنوان و یادداشت' : 'Edit title & note'}" aria-label="${lang === 'fa' ? 'ویرایش نشانک' : 'Edit bookmark'}">
                      ${getIconSvg('pen', 11)}
                    </button>
                    <button type="button" class="bookmark-delete-btn" data-remove-bookmark="${escapeHtml(ub.id)}" title="${lang === 'fa' ? 'حذف نشانک' : 'Remove bookmark'}" aria-label="${lang === 'fa' ? 'حذف نشانک' : 'Remove bookmark'}">
                      ${getIconSvg('close', 11)}
                    </button>
                  </div>
                  <div class="bookmark-inline-editor is-hidden" data-bookmark-editor="${escapeHtml(ub.id)}">
                    <input type="text" class="field bookmark-edit-title-input" data-edit-bm-title="${escapeHtml(ub.id)}" dir="auto"
                           value="${escapeHtml(ub.title)}"
                           placeholder="${lang === 'fa' ? 'عنوان نشانک…' : 'Bookmark title…'}">
                    <textarea class="field bookmark-edit-note-input" data-edit-bm-note="${escapeHtml(ub.id)}" dir="auto" rows="2"
                              placeholder="${lang === 'fa' ? 'یادداشت برای این نشانک…' : 'Note for this bookmark…'}">${escapeHtml(ub.note || '')}</textarea>
                    <div class="bookmark-inline-editor-actions">
                      <button type="button" class="secondary-btn is-compact" data-cancel-bm="${escapeHtml(ub.id)}">${lang === 'fa' ? 'انصراف' : 'Cancel'}</button>
                      <button type="button" class="primary-btn is-compact" data-save-bm="${escapeHtml(ub.id)}">${lang === 'fa' ? 'ذخیره' : 'Save'}</button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${pdfOutline.length > 0 ? `
            <div class="sidebar-section-bar" style="margin-top:${userBookmarks.length > 0 ? '8px' : '2px'};">
              <span class="sidebar-section-label">${lang === 'fa' ? 'فهرست مطالب کتاب' : 'Document Outline'}</span>
              <span class="badge">${pdfOutline.length}</span>
            </div>
            <div class="panel-stack outline-tree-root">
              ${this.renderOutlineTreeHtml(pdfOutline, 0)}
            </div>
          ` : userBookmarks.length === 0 ? `
            <div class="sidebar-section-bar" style="margin-top:2px;">
              <span class="sidebar-section-label">${lang === 'fa' ? 'فهرست مطالب کتاب' : 'Document Outline'}</span>
            </div>
            <div class="sidebar-empty-state">
              <div class="sidebar-empty-icon">${getIconSvg('bookOpen', 22)}</div>
              <div class="sidebar-empty-title">${lang === 'fa' ? 'فهرستی در این پی‌دی‌اف ثبت نشده است' : 'No table of contents in this PDF'}</div>
              <div class="sidebar-empty-sub">${lang === 'fa' ? 'می‌توانید از دکمه بالا برای نشانه‌گذاری صفحات دلخواه استفاده کنید.' : 'Use the button above to bookmark any page for quick access.'}</div>
            </div>
          ` : ''}
        </div>
      `;

      const bookmarkInput = el.querySelector<HTMLInputElement>('#custom-bookmark-input');
      const bookmarkNoteInput = el.querySelector<HTMLInputElement>('#custom-bookmark-note-input');
      const addBookmarkBtn = el.querySelector<HTMLButtonElement>('#add-page-bookmark-btn');
      const handleAddBookmark = () => {
        const pageIdx = store.activePageIndex;
        const customTitle = bookmarkInput?.value.trim() || `${lang === 'fa' ? 'صفحه' : 'Page'} ${pageIdx + 1}`;
        const customNote = bookmarkNoteInput?.value.trim() || undefined;
        store.addUserBookmark(pageIdx, customTitle, customNote);
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
      bookmarkNoteInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddBookmark();
        }
      });

      el.querySelectorAll<HTMLElement>('[data-edit-bookmark]').forEach((editBtn) => {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bmId = editBtn.getAttribute('data-edit-bookmark');
          if (!bmId) return;
          const editor = el.querySelector<HTMLElement>(`[data-bookmark-editor="${CSS.escape(bmId)}"]`);
          if (!editor) return;
          const isHidden = editor.classList.toggle('is-hidden');
          if (!isHidden) {
            const noteInput = editor.querySelector<HTMLTextAreaElement>(`[data-edit-bm-note="${CSS.escape(bmId)}"]`);
            noteInput?.focus();
          }
        });
      });

      el.querySelectorAll<HTMLElement>('[data-cancel-bm]').forEach((cancelBtn) => {
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bmId = cancelBtn.getAttribute('data-cancel-bm');
          if (!bmId) return;
          const editor = el.querySelector<HTMLElement>(`[data-bookmark-editor="${CSS.escape(bmId)}"]`);
          editor?.classList.add('is-hidden');
        });
      });

      el.querySelectorAll<HTMLElement>('[data-save-bm]').forEach((saveBtn) => {
        saveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bmId = saveBtn.getAttribute('data-save-bm');
          if (!bmId) return;
          const titleField = el.querySelector<HTMLInputElement>(`[data-edit-bm-title="${CSS.escape(bmId)}"]`);
          const noteField = el.querySelector<HTMLTextAreaElement>(`[data-edit-bm-note="${CSS.escape(bmId)}"]`);
          store.updateUserBookmark(bmId, {
            title: titleField?.value.trim() || undefined,
            note: noteField?.value.trim() ?? ''
          });
          triggerAutoSave();
          showToast(lang === 'fa' ? 'نشانک بروزرسانی شد' : 'Bookmark updated', 'success');
        });
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
          const target = e.target as HTMLElement;
          if (target.closest('[data-remove-bookmark]') || target.closest('[data-edit-bookmark]')) return;
          const pageIdx = parseInt(itemEl.getAttribute('data-bookmark-page') || '-1', 10);
          if (Number.isFinite(pageIdx) && pageIdx >= 0 && pageIdx < doc.pageCount) {
            viewportManager.navigateWithJumpHistory(pageIdx);
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
    } else if (tab === 'annotations') {
      const filter = this._annotationFilter;
      const filterChips: Array<{ id: AnnotationFilterCategory; label: string }> = [
        { id: 'all', label: lang === 'fa' ? 'همه' : 'All' },
        { id: 'ink', label: lang === 'fa' ? 'قلم' : 'Ink' },
        { id: 'text', label: lang === 'fa' ? 'یادداشت' : 'Notes' },
        { id: 'shapes', label: lang === 'fa' ? 'اشکال' : 'Shapes' }
      ];

      const pageGroups: Array<{ pageIndex: number; items: Array<{ ann: Annotation; info: ReturnType<typeof describeAnnotationItem> }> }> = [];
      let totalMatching = 0;

      const sortedPages = Object.keys(doc.annotations || {})
        .map(Number)
        .filter((idx) => Number.isFinite(idx) && Array.isArray(doc.annotations[idx]) && doc.annotations[idx].length > 0)
        .sort((a, b) => a - b);

      for (const pageIdx of sortedPages) {
        const rawList = doc.annotations[pageIdx] || [];
        const filtered = rawList
          .map((ann) => ({ ann, info: describeAnnotationItem(ann, lang) }))
          .filter((entry) => filter === 'all' || entry.info.category === filter);
        if (filtered.length > 0) {
          pageGroups.push({ pageIndex: pageIdx, items: filtered });
          totalMatching += filtered.length;
        }
      }

      el.innerHTML = `
        <div class="panel-stack">
          <div class="annot-filter-bar" role="tablist" aria-label="${lang === 'fa' ? 'فیلتر حاشیه‌نویسی‌ها' : 'Filter annotations'}">
            ${filterChips.map((chip) => `
              <button type="button"
                      class="annot-filter-tab ${filter === chip.id ? 'is-active' : ''}"
                      data-annot-filter="${chip.id}"
                      role="tab"
                      aria-selected="${filter === chip.id ? 'true' : 'false'}">
                ${escapeHtml(chip.label)}
              </button>
            `).join('')}
          </div>

          <div class="annot-actions-bar">
            <button type="button" class="annot-util-btn" id="sidebar-copy-annots-md">
              ${getIconSvg('copy', 12)}
              <span>${lang === 'fa' ? 'کپی خلاصه' : 'Copy Summary'}</span>
            </button>
            <button type="button" class="annot-util-btn" id="sidebar-export-annots-md">
              ${getIconSvg('fileDown', 12)}
              <span>${lang === 'fa' ? 'خروجی .md' : 'Export .md'}</span>
            </button>
          </div>

          ${totalMatching === 0 ? `
            <div class="sidebar-empty-state">
              <div class="sidebar-empty-icon">${getIconSvg('annotations', 22)}</div>
              <div class="sidebar-empty-title">${lang === 'fa' ? 'موردی در این دسته‌بندی یافت نشد' : 'No annotations in this view'}</div>
              <div class="sidebar-empty-sub">${lang === 'fa' ? 'با ابزارهای هایلایت، یادداشت، متن یا اندازه‌گیری روی صفحات علامت‌گذاری کنید.' : 'Use Highlighter, Sticky Notes, Shapes, or Measure tools on any page to see them listed here.'}</div>
            </div>
          ` : pageGroups.map((group) => `
            <div class="sidebar-section-bar annot-page-bar">
              <span class="sidebar-section-label">${lang === 'fa' ? `صفحه ${group.pageIndex + 1}` : `Page ${group.pageIndex + 1}`}</span>
              <span class="annot-page-count tabular-nums">${group.items.length}</span>
            </div>
            <div class="annot-card-list">
              ${group.items.map(({ ann, info }) => {
                const isSelected = store.selectedAnnotationIds.has(ann.id);
                return `
                  <div class="list-card is-interactive annot-card ${isSelected ? 'is-current' : ''}"
                       data-annot-jump-page="${ann.pageIndex}"
                       data-annot-jump-id="${escapeHtml(ann.id)}">
                    <span class="annot-card-swatch" style="background:${escapeHtml(info.color)};"></span>
                    <span class="annot-card-icon" style="color:${escapeHtml(info.color)};">${getIconSvg(info.icon as any, 13)}</span>
                    <div class="annot-card-body">
                      <span class="annot-card-title" dir="auto">${escapeHtml(info.title)}</span>
                      <div class="annot-card-sub tabular-nums" dir="auto">${escapeHtml(info.subtitle)}</div>
                    </div>
                    <button type="button" class="bookmark-delete-btn annot-card-delete"
                            data-delete-annot-page="${ann.pageIndex}"
                            data-delete-annot-id="${escapeHtml(ann.id)}"
                            title="${lang === 'fa' ? 'حذف این مورد' : 'Delete annotation'}"
                            aria-label="${lang === 'fa' ? 'حذف این مورد' : 'Delete annotation'}">
                      ${getIconSvg('trash', 12)}
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
          `).join('')}
        </div>
      `;

      el.querySelectorAll<HTMLButtonElement>('[data-annot-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextFilter = btn.getAttribute('data-annot-filter') as AnnotationFilterCategory;
          if (nextFilter && nextFilter !== this._annotationFilter) {
            this._annotationFilter = nextFilter;
            this._lastRenderKey = '';
            this.render();
          }
        });
      });

      el.querySelector('#sidebar-copy-annots-md')?.addEventListener('click', async () => {
        const md = buildAnnotationsMarkdownSummary(doc, lang);
        try {
          await navigator.clipboard.writeText(md);
          showToast(lang === 'fa' ? 'خلاصه حاشیه‌نویسی‌ها در کلیپ‌بورد کپی شد' : 'Markdown summary copied to clipboard', 'success');
        } catch {
          showToast(lang === 'fa' ? 'امکان کپی در کلیپ‌بورد وجود ندارد' : 'Clipboard copy unavailable', 'error');
        }
      });

      el.querySelector('#sidebar-export-annots-md')?.addEventListener('click', () => {
        const md = buildAnnotationsMarkdownSummary(doc, lang);
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const baseName = (doc.name || 'document').replace(/\.pdf$/i, '');
        a.download = `${baseName}-notes.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showToast(lang === 'fa' ? 'فایل خلاصه Markdown دانلود شد' : 'Markdown summary exported', 'success');
      });

      el.querySelectorAll<HTMLElement>('[data-annot-jump-id]').forEach((card) => {
        card.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-delete-annot-id]')) return;
          const pageIdx = parseInt(card.getAttribute('data-annot-jump-page') || '-1', 10);
          const annId = card.getAttribute('data-annot-jump-id') || '';
          if (pageIdx >= 0 && pageIdx < doc.pageCount) {
            viewportManager.navigateWithJumpHistory(pageIdx);
            if (annId) {
              store.selectAnnotation(annId);
              window.app?.repaintAllRenderedAnnotations();
            }
          }
        });
      });

      el.querySelectorAll<HTMLButtonElement>('[data-delete-annot-id]').forEach((delBtn) => {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pageIdx = parseInt(delBtn.getAttribute('data-delete-annot-page') || '-1', 10);
          const annId = delBtn.getAttribute('data-delete-annot-id') || '';
          const pageAnns = doc.annotations[pageIdx] || [];
          const target = pageAnns.find((a) => a.id === annId);
          if (target) {
            history.execute(new DeleteAnnotationsCommand(pageIdx, [target]));
            triggerAutoSave();
            window.app?.repaintAllRenderedAnnotations();
          }
        });
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
    let dropInsertIndex: number | null = null;
    let dragRafId: number | null = null;
    let autoScrollRafId: number | null = null;
    let autoScrollVelocity = 0;
    let lastClientX = 0;
    let lastClientY = 0;

    const cards = Array.from(list.querySelectorAll<HTMLElement>('.thumbnail-card[data-page]'));
    const indicator = list.querySelector<HTMLElement>('#thumbnail-drop-indicator');
    const scrollParent = list.closest<HTMLElement>('#sidebar-tab-content') || list.parentElement;

    const selectionFor = (idx: number): number[] => {
      const effective = store.effectivePageSelection(idx);
      return effective.includes(idx) && effective.length > 0 ? effective : [idx];
    };

    const stopAutoScroll = () => {
      autoScrollVelocity = 0;
      if (autoScrollRafId !== null) {
        cancelAnimationFrame(autoScrollRafId);
        autoScrollRafId = null;
      }
    };

    const hideDropIndicator = () => {
      stopAutoScroll();
      if (dragRafId !== null) {
        cancelAnimationFrame(dragRafId);
        dragRafId = null;
      }
      dropInsertIndex = null;
      list.classList.remove('is-external-file-drag');
      for (const c of cards) c.classList.remove('is-drop-target');
      if (indicator) {
        indicator.classList.remove('is-visible');
      }
    };

    const updateIndicatorPosition = (clientX: number, clientY: number) => {
      if (!indicator || cards.length === 0) return;
      const listRect = list.getBoundingClientRect();
      const isRtl = document.documentElement.dir === 'rtl';

      // Find the card in the 2-column grid closest to (clientX, clientY)
      let bestCardIdx = 0;
      let bestScore = Infinity;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
        const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
        // Weight vertical row matching higher so pointer stays within the hovered row
        const score = dy * 4 + dx;
        if (score < bestScore) {
          bestScore = score;
          bestCardIdx = i;
        }
      }

      const targetCard = cards[bestCardIdx];
      const rect = targetCard.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      // Determine whether insertion is BEFORE or AFTER `targetCard`
      const insertBefore = isRtl ? clientX > midX : clientX < midX;
      const bestInsertIdx = insertBefore ? bestCardIdx : bestCardIdx + 1;
      dropInsertIndex = bestInsertIdx;

      for (let i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('is-drop-target', i === bestCardIdx);
      }

      // Position the vertical insertion bar on the single target card's left or right edge
      const cardTop = rect.top - listRect.top;
      const cardLeft = rect.left - listRect.left;
      const placeOnLeftEdge = isRtl ? !insertBefore : insertBefore;
      const edgeX = placeOnLeftEdge
        ? Math.max(2, cardLeft - 6)
        : Math.min(listRect.width - 6, cardLeft + rect.width + 2);

      indicator.style.height = `${Math.round(rect.height)}px`;
      indicator.style.transform = `translate3d(${Math.round(edgeX)}px, ${Math.round(cardTop)}px, 0)`;
      indicator.dataset.dropSlot = String(bestInsertIdx + 1);
      if (!indicator.classList.contains('is-visible')) {
        indicator.classList.add('is-visible');
      }
    };

    const tickAutoScroll = () => {
      if (!scrollParent || autoScrollVelocity === 0) {
        autoScrollRafId = null;
        return;
      }
      scrollParent.scrollTop += autoScrollVelocity;
      updateIndicatorPosition(lastClientX, lastClientY);
      autoScrollRafId = requestAnimationFrame(tickAutoScroll);
    };

    const hasExternalFiles = (dt: DataTransfer | null): boolean => {
      if (!dt || dragging.length > 0) return false;
      const types = Array.from(dt.types || []);
      return types.includes('Files');
    };

    for (const card of cards) {
      const idx = parseInt(card.dataset.page || '0', 10);

      card.addEventListener('click', (e) => {
        if (e.shiftKey) {
          const anchor = this._pageAnchor ?? store.activePageIndex;
          const from = Math.min(anchor, idx);
          const to = Math.max(anchor, idx);
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
        store.setSelectedPageIndices([idx]);
        viewportManager.scrollToPage(idx);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const effective = store.effectivePageSelection();
        if (!effective.includes(idx)) {
          this._pageAnchor = idx;
          store.setSelectedPageIndices([idx]);
        } else if (store.selectedPageIndices.size === 0) {
          store.setSelectedPageIndices([idx]);
        }
        this.openPageMenu(e.clientX, e.clientY, idx);
      });

      card.addEventListener('dragstart', (e) => {
        dragging = selectionFor(idx);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        }
        for (const selIdx of dragging) {
          cards[selIdx]?.classList.add('is-dragging');
        }
      });

      card.addEventListener('dragend', () => {
        for (const c of cards) c.classList.remove('is-dragging');
        dragging = [];
        hideDropIndicator();
      });
    }

    list.addEventListener('dragover', (e) => {
      const isExternal = hasExternalFiles(e.dataTransfer);
      if (dragging.length === 0 && !isExternal) return;
      if (isExternal && doc.notebook) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move';
      }
      list.classList.toggle('is-external-file-drag', isExternal);
      lastClientX = e.clientX;
      lastClientY = e.clientY;

      if (scrollParent) {
        const spRect = scrollParent.getBoundingClientRect();
        const edgeThreshold = 48;
        if (e.clientY < spRect.top + edgeThreshold) {
          const ratio = Math.min(1, (spRect.top + edgeThreshold - e.clientY) / edgeThreshold);
          autoScrollVelocity = -Math.ceil(ratio * 10);
        } else if (e.clientY > spRect.bottom - edgeThreshold) {
          const ratio = Math.min(1, (e.clientY - (spRect.bottom - edgeThreshold)) / edgeThreshold);
          autoScrollVelocity = Math.ceil(ratio * 10);
        } else {
          autoScrollVelocity = 0;
        }
        if (autoScrollVelocity !== 0 && autoScrollRafId === null) {
          autoScrollRafId = requestAnimationFrame(tickAutoScroll);
        }
      }

      if (dragRafId === null) {
        dragRafId = requestAnimationFrame(() => {
          dragRafId = null;
          updateIndicatorPosition(lastClientX, lastClientY);
        });
      }
    });

    list.addEventListener('dragleave', (e) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !list.contains(related)) {
        hideDropIndicator();
      }
    });

    list.addEventListener('drop', (e) => {
      const isExternal = hasExternalFiles(e.dataTransfer);
      if (dragging.length === 0 && !isExternal) return;

      e.preventDefault();
      e.stopPropagation();

      updateIndicatorPosition(e.clientX, e.clientY);
      const targetIndex = dropInsertIndex ?? doc.pageCount;
      const moving = dragging;
      dragging = [];
      for (const c of cards) c.classList.remove('is-dragging');
      hideDropIndicator();

      if (isExternal && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const pdfFiles = Array.from(e.dataTransfer.files).filter(
          f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
        );
        if (pdfFiles.length > 0) {
          void this.mergeDroppedOrPickedFiles(pdfFiles, targetIndex);
        }
        return;
      }

      if (moving.length === 0) return;
      if (moving.length === 1 && (targetIndex === moving[0] || targetIndex === moving[0] + 1)) {
        return;
      }
      void this.runPageAction(() => pageActions.movePages(moving, targetIndex));
    });

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
      { kind: 'action', id: 'page-merge-before', label: t('sidebar.pages.mergeBefore'), icon: 'merge',
        disabled: notebook,
        run: () => { this.promptMergeExternalPdf(selection[0]); } },
      { kind: 'action', id: 'page-merge-after', label: t('sidebar.pages.mergeAfter'), icon: 'merge',
        disabled: notebook,
        run: () => { this.promptMergeExternalPdf(selection[selection.length - 1] + 1); } },
      { kind: 'action', id: 'page-extract', label: many
          ? t('sidebar.pages.extractMany', { count: selection.length })
          : t('sidebar.pages.extract'),
        icon: 'extract',
        run: () => { void this.runPageAction(async () => {
          const ok = await pageActions.extractPagesToFile(selection);
          if (ok) showToast(t('sidebar.pages.extracted', { count: selection.length }), 'success');
          return ok;
        }); } },
      { kind: 'action', id: 'page-crop', label: t('sidebar.pages.crop'), icon: 'crop',
        disabled: notebook,
        run: () => { void cropDialog.open(selection[0]); } },
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

    // O(N) single-pass lookup map instead of O(N^2) el.querySelector('[data-thumb-frame="..."]')
    const frameByIndex = new Map<number, HTMLElement>();
    el.querySelectorAll<HTMLElement>('[data-thumb-frame]').forEach((f) => {
      const idx = Number(f.dataset.thumbFrame);
      if (Number.isFinite(idx)) frameByIndex.set(idx, f);
    });

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
          this._prevThumbnailByPage.set(`${docId}:${idx}`, src);
        } finally {
          inFlight.delete(idx);
        }
      } else {
        this._prevThumbnailByPage.set(`${docId}:${idx}`, src);
      }

      const frame = frameByIndex.get(idx) ?? el.querySelector<HTMLElement>(`[data-thumb-frame="${idx}"]`);
      if (!frame || !frame.isConnected) return;
      const existingImg = frame.querySelector<HTMLImageElement>('img');
      if (existingImg) {
        if (existingImg.hasAttribute('data-stale')) {
          existingImg.src = src;
          existingImg.removeAttribute('data-stale');
          const rot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
          existingImg.style.transform = rot ? `rotate(${rot}deg)` : '';
        }
        frame.classList.remove('is-loading');
        return;
      }

      const img = document.createElement('img');
      img.src = src;
      img.decoding = 'async';
      img.alt = `Page ${idx + 1} preview`;
      const rot = ((store.pageRotations[idx] || 0) % 360 + 360) % 360;
      if (rot) img.style.transform = `rotate(${rot}deg)`;
      frame.classList.remove('is-loading');
      frame.prepend(img);
    };

    // 1. Immediate priority batch around the current page (activePageIndex ± 4)
    const center = store.activePageIndex;
    const priorityIndices: number[] = [];
    for (let radius = 0; radius <= 4; radius++) {
      const a = center - radius;
      const b = center + radius;
      if (a >= 0 && a < pageCount) priorityIndices.push(a);
      if (radius > 0 && b >= 0 && b < pageCount) priorityIndices.push(b);
    }

    // 2. Smooth-margin IntersectionObserver for scroll lookahead without flooding open transition
    this._thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._thumbObserver?.unobserve(entry.target);
        const frame = entry.target as HTMLElement;
        const idx = Number(frame.dataset.thumbFrame);
        if (Number.isFinite(idx)) void fillFrame(idx);
      }
    }, { rootMargin: '480px' });

    for (const [, frame] of frameByIndex) {
      const existingImg = frame.querySelector('img');
      if (!existingImg || existingImg.hasAttribute('data-stale')) {
        this._thumbObserver.observe(frame);
      }
    }

    // 3. Yield one frame so sidebar slide-in animation starts at 60fps, then warm thumbnails in gentle batches
    void (async () => {
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const batchSize = 2;
      for (let i = 0; i < priorityIndices.length; i += batchSize) {
        if (warmupToken !== this._thumbWarmupToken || store.activeDocument?.id !== docId || !store.sidebarOpen) return;
        const slice = priorityIndices.slice(i, i + batchSize);
        await Promise.all(slice.map(idx => fillFrame(idx)));
        await new Promise(r => setTimeout(r, 12));
      }

      const maxWarmup = Math.min(pageCount, 120);
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
          await new Promise(r => setTimeout(r, 16));
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
