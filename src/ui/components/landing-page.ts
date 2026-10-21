/**
 * World-Class Landing Page & Document Library Studio Component for veditor
 * Features:
 * - Editorial Studio Hero & Interactive Drag-and-Drop Launchpad
 * - Visual Cover Previews (First-page PDF thumbnails, live Notebook paper miniatures, or typographic sheets)
 * - Live Search, Multi-Criteria Sorting (Recent, Name, Page Count), and Gallery Grid / Compact List View Toggle
 * - Inline Document Renaming, Custom Color/Icon Folder Categorization, and Instant Optimistic Updates
 */

import {
  getRecentDocuments,
  getFolders,
  saveFolder,
  deleteFolder,
  assignDocToFolder,
  deleteRecentDocument,
  renameRecentDocument
} from '../../io/storage';
import { generateSamplePDF } from '../../io/sample-pdf';
import { buildNotebookPdf, PAPER_PRESETS } from '../../io/notebook';
import { getIconSvg } from '../../utils/icons';
import { escapeHtml } from '../../utils/html';
import { PDFFolder, RecentDocItem, NotebookSpec } from '../../core/types';
import { NotebookDialogComponent } from './notebook-dialog';

export interface LandingPageCallbacks {
  onOpenFile: () => void;
  /** `notebook` marks the bytes as a generated notebook that can be restyled. */
  onOpenBytes: (name: string, bytes: Uint8Array, notebook?: NotebookSpec) => Promise<void>;
  onOpenRecent: (docId: string) => Promise<void>;
}

type LibraryViewMode = 'grid' | 'list';
type LibrarySortBy = 'recent' | 'name' | 'pages';

const VIEW_MODE_STORAGE_KEY = 'veditor_library_view_mode';
const SORT_BY_STORAGE_KEY = 'veditor_library_sort_by';

export class LandingPageComponent {
  private _container: HTMLElement;
  private _callbacks: LandingPageCallbacks;
  private _activeFolderId: string = 'all'; // 'all', 'uncategorized', or folder.id
  private _folders: PDFFolder[] = [];
  private _recentDocs: RecentDocItem[] = [];
  private _searchQuery: string = '';
  private _viewMode: LibraryViewMode = 'grid';
  private _sortBy: LibrarySortBy = 'recent';
  private _editingDocId: string | null = null;
  private _showCreateFolderModal: boolean = false;
  private _selectedFolderColor: string = '#6366f1';
  private _selectedFolderIcon: string = 'folder';

  constructor(container: HTMLElement, callbacks: LandingPageCallbacks) {
    this._container = container;
    this._callbacks = callbacks;
    this.loadPreferences();
  }

  private loadPreferences(): void {
    try {
      const savedView = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (savedView === 'grid' || savedView === 'list') {
        this._viewMode = savedView;
      }
      const savedSort = localStorage.getItem(SORT_BY_STORAGE_KEY);
      if (savedSort === 'recent' || savedSort === 'name' || savedSort === 'pages') {
        this._sortBy = savedSort;
      }
    } catch (_) {}
  }

  private savePreferences(): void {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, this._viewMode);
      localStorage.setItem(SORT_BY_STORAGE_KEY, this._sortBy);
    } catch (_) {}
  }

  public async render(): Promise<void> {
    try {
      this._folders = await getFolders();
      this._recentDocs = await getRecentDocuments();
    } catch (_) {}

    this.ensureShellMounted();
    this.updateLibraryDOM();
    this.updateFolderModalDOM();
  }

  /**
   * Mounts the static landing page shell (.landing-intro, #landing-library-body,
   * .features-grid, .shortcuts-sheet) ONCE so entry animations never replay
   * when folders, search queries, or recent files are updated.
   */
  private ensureShellMounted(): void {
    const host = this._container as HTMLElement & { __landingInstance?: LandingPageComponent };
    if (host.__landingInstance === this && this._container.querySelector('.landing-container')) {
      return;
    }
    host.__landingInstance = this;

    this._container.innerHTML = `
      <div class="landing-container">
        <!-- Studio Hero & Launchpad -->
        <div class="landing-intro">
          <div class="landing-hero">
            <div class="landing-kicker">
              ${getIconSvg('shieldCheck', 14)}
              <span>Private Offline Workspace</span>
              <span aria-hidden="true">&middot;</span>
              <span>Zero Cloud Uploads</span>
            </div>
            <h1 class="landing-title">Your PDFs.<br><span>Engineered for ink.</span></h1>
            <p class="landing-subtitle">
              Read, annotate, sign, and organize documents and custom notebooks in a high-frame-rate workspace built for stylus, mouse, and touch.
            </p>

            <div class="landing-metrics-strip" aria-label="Workspace capabilities">
              <div class="landing-metric-item">
                <span class="landing-metric-val">120 Hz</span>
                <span class="landing-metric-label">Coalesced spline ink</span>
              </div>
              <div class="landing-metric-divider" aria-hidden="true"></div>
              <div class="landing-metric-item">
                <span class="landing-metric-val">500+ pg</span>
                <span class="landing-metric-label">Virtualized rendering</span>
              </div>
              <div class="landing-metric-divider" aria-hidden="true"></div>
              <div class="landing-metric-item">
                <span class="landing-metric-val">100%</span>
                <span class="landing-metric-label">Local IndexedDB vault</span>
              </div>
            </div>
          </div>

          <!-- Interactive Dropzone & Studio Launchpad -->
          <div class="landing-dropzone" id="landing-dropzone">
            <div class="dropzone-sheet-graphic" aria-hidden="true">
              <div class="dropzone-sheet-back"></div>
              <div class="dropzone-sheet-front">
                ${getIconSvg('fileText', 26)}
                <span class="dropzone-icon-plus">${getIconSvg('plus', 11, 2.5)}</span>
              </div>
            </div>
            <div class="dropzone-prompt">Open a PDF or start a notebook</div>
            <div class="dropzone-hint">Drag and drop any PDF file here, or choose an action below</div>

            <div class="dropzone-actions" id="dropzone-actions-group">
              <button class="primary-btn is-lg" id="landing-open-btn">
                ${getIconSvg('folder', 16)}
                <span>Choose PDF</span>
              </button>

              <button class="secondary-btn is-lg" id="landing-notebook-btn" title="Create a customizable ruled, grid, or dotted notebook">
                ${getIconSvg('notebook', 16)}
                <span>New notebook</span>
              </button>

              <button class="secondary-btn is-lg" id="landing-sample-btn" title="Explore veditor with an interactive sample PDF">
                ${getIconSvg('sparkles', 16)}
                <span>Try sample</span>
              </button>
            </div>

            <div class="dropzone-quick-templates" id="dropzone-quick-templates">
              <span class="dropzone-quick-label">Quick paper:</span>
              <button type="button" class="dropzone-template-btn" data-quick-preset="ruled" title="Create Ruled Notebook">
                ${getIconSvg('linedPage', 12)}
                <span>Ruled</span>
              </button>
              <button type="button" class="dropzone-template-btn" data-quick-preset="graph" title="Create Graph Grid Notebook">
                ${getIconSvg('gridPage', 12)}
                <span>Grid</span>
              </button>
              <button type="button" class="dropzone-template-btn" data-quick-preset="bullet" title="Create Dot Grid Journal">
                ${getIconSvg('dotsPage', 12)}
                <span>Dots</span>
              </button>
              <button type="button" class="dropzone-template-btn" data-quick-preset="dark" title="Create Night Dark Notebook">
                ${getIconSvg('moon', 12)}
                <span>Night</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Document Library Studio -->
        <section class="landing-section library-studio" aria-label="Document Library">
          <div id="landing-library-body"></div>
        </section>

        <!-- Create Folder Modal Slot -->
        <div id="landing-folder-modal-slot"></div>

        <!-- Feature Showcase -->
        <div class="features-grid">
          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(99,102,241,0.12); color:#818cf8;">
              ${getIconSvg('pen', 20)}
            </div>
            <div class="feature-box-title">Stylus & Pressure Dynamics</div>
            <p class="feature-box-desc">Sub-pixel coalesced pointer events, natural tilt & speed sensitivity, Catmull-Rom spline smoothing, and configurable response curves.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(16,185,129,0.12); color:#34d399;">
              ${getIconSvg('zap', 20)}
            </div>
            <div class="feature-box-title">Zero-Flicker Double Buffering</div>
            <p class="feature-box-desc">Offscreen canvas rendering pipeline delivers continuous scrolling and instant page switching across 500+ page technical books.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(244,114,182,0.12); color:#f472b6;">
              ${getIconSvg('eraser', 20)}
            </div>
            <div class="feature-box-title">Precision Segment Eraser</div>
            <p class="feature-box-desc">Switch seamlessly between whole Stroke Erasing, Object Erasing, or surgical Pixel Slicing that divides ink strokes at exact contact points.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(59,130,246,0.12); color:#60a5fa;">
              ${getIconSvg('shieldCheck', 20)}
            </div>
            <div class="feature-box-title">100% Private & Offline</div>
            <p class="feature-box-desc">Runs entirely inside your local sandbox. Zero server uploads, zero analytics, zero external requests. Your documents stay on your machine.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(245,158,11,0.12); color:#fbbf24;">
              ${getIconSvg('stamp', 20)}
            </div>
            <div class="feature-box-title">Vector-Perfect PDF Export</div>
            <p class="feature-box-desc">Save annotations directly into native PDF streams so your ink, shapes, and sticky notes stay razor-sharp at any magnification.</p>
          </div>

          <div class="feature-box">
            <div class="feature-icon-badge" style="background:rgba(139,92,246,0.12); color:#a78bfa;">
              ${getIconSvg('command', 20)}
            </div>
            <div class="feature-box-title">Keyboard-First Workflow</div>
            <p class="feature-box-desc">Single-key tool shortcuts, customizable keybindings, instant zoom presets, per-tab Undo/Redo stacks, and Command Palette.</p>
          </div>
        </div>

        <!-- Shortcuts Quick Cheat Sheet -->
        <div class="shortcuts-sheet">
          <div class="shortcuts-sheet-header">
            <span>Keyboard Shortcuts Reference</span>
            <span class="shortcuts-sheet-sub">All tool keys can be customized in Settings</span>
          </div>
          <div class="shortcuts-sheet-grid">
            <div class="shortcut-item"><span>Select & Transform</span> <kbd class="shortcut-kbd">V</kbd></div>
            <div class="shortcut-item"><span>Freehand Pen</span> <kbd class="shortcut-kbd">P</kbd></div>
            <div class="shortcut-item"><span>Highlighter</span> <kbd class="shortcut-kbd">H</kbd></div>
            <div class="shortcut-item"><span>Eraser</span> <kbd class="shortcut-kbd">E</kbd></div>
            <div class="shortcut-item"><span>Rectangle</span> <kbd class="shortcut-kbd">R</kbd></div>
            <div class="shortcut-item"><span>Polygon</span> <kbd class="shortcut-kbd">G</kbd></div>
            <div class="shortcut-item"><span>Text Box</span> <kbd class="shortcut-kbd">T</kbd></div>
            <div class="shortcut-item"><span>Scratchpad</span> <kbd class="shortcut-kbd">N</kbd></div>
            <div class="shortcut-item"><span>Undo / Redo</span> <kbd class="shortcut-kbd">Ctrl+Z / Y</kbd></div>
            <div class="shortcut-item"><span>Open File</span> <kbd class="shortcut-kbd">Ctrl+O</kbd></div>
            <div class="shortcut-item"><span>Save PDF</span> <kbd class="shortcut-kbd">Ctrl+S</kbd></div>
            <div class="shortcut-item"><span>Command Palette</span> <kbd class="shortcut-kbd">Ctrl+K</kbd></div>
          </div>
        </div>
      </div>
    `;

    this.bindShellEvents();
  }

  /**
   * Builds or updates the Library Studio chrome (header, search/sort/view bar,
   * folder filter strip, and document results container). When the chrome is
   * already mounted, updates the folder strip and results in place so typing
   * in the search box never loses focus.
   */
  private updateLibraryDOM(): void {
    const libraryBody = this._container.querySelector<HTMLElement>('#landing-library-body');
    if (!libraryBody) return;

    if (!libraryBody.querySelector('.library-command-shell')) {
      libraryBody.innerHTML = `
        <div class="library-command-shell">
          <div class="library-top-bar">
            <div class="landing-section-title">
              <span class="landing-section-icon">${getIconSvg('bookOpen', 17)}</span>
              <div>
                <div class="library-heading-row">
                  <span>Document Library</span>
                  <span class="library-total-summary" id="library-total-summary"></span>
                </div>
                <small>Pick up right where you left off — organized locally on your device</small>
              </div>
            </div>

            <div class="library-controls-cluster">
              <!-- Live Search Input -->
              <div class="library-search-box">
                <span class="library-search-icon">${getIconSvg('search', 14)}</span>
                <input
                  type="search"
                  id="library-search-input"
                  class="library-search-input"
                  placeholder="Search documents or folders…"
                  value="${escapeHtml(this._searchQuery)}"
                  aria-label="Search documents in library"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button
                  type="button"
                  id="library-search-clear"
                  class="library-search-clear"
                  title="Clear search"
                  aria-label="Clear search"
                  ${this._searchQuery ? '' : 'hidden'}
                >
                  ${getIconSvg('close', 12)}
                </button>
              </div>

              <!-- Sort Selector -->
              <div class="library-sort-wrap" title="Sort documents">
                <span class="library-sort-icon">${getIconSvg('sort', 13)}</span>
                <select id="library-sort-select" class="field library-sort-select" aria-label="Sort documents">
                  <option value="recent" ${this._sortBy === 'recent' ? 'selected' : ''}>Sort: Recent</option>
                  <option value="name" ${this._sortBy === 'name' ? 'selected' : ''}>Sort: Name (A–Z)</option>
                  <option value="pages" ${this._sortBy === 'pages' ? 'selected' : ''}>Sort: Page count</option>
                </select>
              </div>

              <!-- View Mode Toggle (Gallery Cards vs Compact List) -->
              <div class="library-view-toggle" role="group" aria-label="Library view mode">
                <button
                  type="button"
                  class="library-view-btn ${this._viewMode === 'grid' ? 'active' : ''}"
                  data-library-view="grid"
                  title="Gallery Card View"
                  aria-label="Gallery Card View"
                  aria-pressed="${this._viewMode === 'grid'}"
                >
                  ${getIconSvg('gridView', 14)}
                  <span>Cards</span>
                </button>
                <button
                  type="button"
                  class="library-view-btn ${this._viewMode === 'list' ? 'active' : ''}"
                  data-library-view="list"
                  title="Compact List View"
                  aria-label="Compact List View"
                  aria-pressed="${this._viewMode === 'list'}"
                >
                  ${getIconSvg('listView', 14)}
                  <span>List</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Folder Filter Strip -->
          <div class="folder-tabs-bar" id="library-folder-tabs"></div>
        </div>

        <!-- Dynamic Results Container -->
        <div id="landing-library-results"></div>
      `;

      this.bindLibraryChromeEvents(libraryBody);
    } else {
      // Keep view toggle buttons and sort dropdown synced with current state
      libraryBody.querySelectorAll<HTMLButtonElement>('[data-library-view]').forEach(b => {
        const active = b.getAttribute('data-library-view') === this._viewMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      const sortSelect = libraryBody.querySelector<HTMLSelectElement>('#library-sort-select');
      if (sortSelect && sortSelect.value !== this._sortBy) {
        sortSelect.value = this._sortBy;
      }
    }

    this.renderFolderTabs(libraryBody);
    this.renderLibraryResults(libraryBody);
  }

  private renderFolderTabs(libraryBody: HTMLElement): void {
    const folderBar = libraryBody.querySelector<HTMLElement>('#library-folder-tabs');
    const summaryEl = libraryBody.querySelector<HTMLElement>('#library-total-summary');
    if (!folderBar) return;

    const allCount = this._recentDocs.length;
    const uncategorizedCount = this._recentDocs.filter(d => !d.folderId).length;

    if (summaryEl) {
      summaryEl.textContent = `${allCount} ${allCount === 1 ? 'document' : 'documents'} · ${this._folders.length} ${this._folders.length === 1 ? 'folder' : 'folders'}`;
    }

    folderBar.innerHTML = `
      <div class="folder-pills-scroll">
        <button type="button" class="folder-tab-pill ${this._activeFolderId === 'all' ? 'active' : ''}" data-folder-pill="all">
          <span>All Files</span>
          <span class="folder-count">${allCount}</span>
        </button>

        <button type="button" class="folder-tab-pill ${this._activeFolderId === 'uncategorized' ? 'active' : ''}" data-folder-pill="uncategorized">
          <span>Uncategorized</span>
          <span class="folder-count">${uncategorizedCount}</span>
        </button>

        ${this._folders.map(folder => {
          const count = this._recentDocs.filter(d => d.folderId === folder.id).length;
          const isActive = this._activeFolderId === folder.id;
          return `
            <button type="button" class="folder-tab-pill ${isActive ? 'active' : ''}" data-folder-pill="${escapeHtml(folder.id)}"
                    style="${isActive ? `border-color:${folder.color}; box-shadow:0 0 0 1px ${folder.color}35;` : ''}">
              <span class="folder-pill-icon" style="color:${folder.color};">${getIconSvg(folder.icon, 13)}</span>
              <span>${escapeHtml(folder.name)}</span>
              <span class="folder-count" style="${isActive ? `background:${folder.color}; color:#fff;` : ''}">${count}</span>
            </button>
          `;
        }).join('')}
      </div>

      <button type="button" class="folder-new-btn" id="open-new-folder-modal-btn" title="Create a new folder category">
        ${getIconSvg('folderPlus', 14)}
        <span>New Folder</span>
      </button>
    `;

    // Folder tab switching
    folderBar.querySelectorAll('[data-folder-pill]').forEach(pill => {
      pill.addEventListener('click', () => {
        const folderId = pill.getAttribute('data-folder-pill');
        if (folderId && folderId !== this._activeFolderId) {
          this._activeFolderId = folderId;
          this.renderFolderTabs(libraryBody);
          this.renderLibraryResults(libraryBody);
        }
      });
    });

    // Open New Folder Modal
    folderBar.querySelector('#open-new-folder-modal-btn')?.addEventListener('click', () => {
      this._showCreateFolderModal = true;
      this.updateFolderModalDOM();
    });
  }

  private getFilteredAndSortedDocs(): RecentDocItem[] {
    let list = [...this._recentDocs];

    // 1. Folder filter
    if (this._activeFolderId === 'uncategorized') {
      list = list.filter(d => !d.folderId);
    } else if (this._activeFolderId !== 'all') {
      list = list.filter(d => d.folderId === this._activeFolderId);
    }

    // 2. Search filter (matches document name or folder name)
    const q = this._searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(doc => {
        const nameMatch = doc.name.toLowerCase().includes(q);
        const folder = this._folders.find(f => f.id === doc.folderId);
        const folderMatch = folder ? folder.name.toLowerCase().includes(q) : false;
        return nameMatch || folderMatch;
      });
    }

    // 3. Sort
    if (this._sortBy === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } else if (this._sortBy === 'pages') {
      list.sort((a, b) => (b.pageCount || 0) - (a.pageCount || 0) || (b.lastOpenedAt - a.lastOpenedAt));
    } else {
      list.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    }

    return list;
  }

  /**
   * Renders the visual cover miniature for a document card or list item:
   * - Real first-page PDF thumbnail if available
   * - Authentic ruled/grid/dotted/dark paper miniature if it's a notebook
   * - Clean editorial PDF page sheet otherwise
   */
  private renderDocumentCover(doc: RecentDocItem, folder?: PDFFolder): string {
    const accentColor = folder?.color || '#6366f1';
    const pageBadge = doc.pageCount && doc.pageCount > 0
      ? `<span class="cover-page-count">${doc.pageCount} ${doc.pageCount === 1 ? 'p' : 'pp'}</span>`
      : '';

    if (doc.thumbnailDataUrl) {
      return `
        <div class="doc-cover-sheet has-thumb">
          <img src="${doc.thumbnailDataUrl}" alt="${escapeHtml(doc.name)} cover" class="doc-cover-img" loading="lazy" decoding="async" />
          ${pageBadge}
        </div>
      `;
    }

    const nbPaper = doc.notebook?.paper;
    const isNotebookByName = /notebook/i.test(doc.name);
    if (nbPaper || isNotebookByName) {
      const bg = nbPaper?.paperColor || '#fbfaf7';
      const rule = nbPaper?.lineColor || '#cbd5e1';
      const pat = nbPaper?.pattern || 'lined';
      const hasMargin = nbPaper ? Boolean(nbPaper.margin) : true;
      return `
        <div class="doc-cover-sheet is-notebook-sheet" data-pattern="${pat}"
             style="--sheet-bg:${bg}; --sheet-rule:${rule};">
          ${hasMargin && pat === 'lined' ? '<span class="sheet-margin-line"></span>' : ''}
          <span class="sheet-notebook-badge">${getIconSvg('notebook', 13)}</span>
          ${pageBadge}
        </div>
      `;
    }

    return `
      <div class="doc-cover-sheet is-pdf-sheet" style="--sheet-accent:${accentColor};">
        <span class="sheet-spine"></span>
        <div class="sheet-lines" aria-hidden="true">
          <span class="sheet-line is-title"></span>
          <span class="sheet-line"></span>
          <span class="sheet-line"></span>
          <span class="sheet-line is-short"></span>
        </div>
        <span class="sheet-type-mark">PDF</span>
        ${pageBadge}
      </div>
    `;
  }

  private renderLibraryResults(libraryBody: HTMLElement): void {
    const resultsEl = libraryBody.querySelector<HTMLElement>('#landing-library-results');
    if (!resultsEl) return;

    const filteredDocs = this.getFilteredAndSortedDocs();
    const activeFolder = this._folders.find(f => f.id === this._activeFolderId);

    const activeFolderBarHtml = activeFolder ? `
      <div class="folder-action-bar">
        <div class="folder-action-info">
          <span class="folder-action-swatch" style="background:${activeFolder.color}20; color:${activeFolder.color};">
            ${getIconSvg(activeFolder.icon, 14)}
          </span>
          <span><strong>${escapeHtml(activeFolder.name)}</strong></span>
          <span aria-hidden="true">&middot;</span>
          <span class="tabular-nums">${filteredDocs.length} ${filteredDocs.length === 1 ? 'document' : 'documents'}</span>
        </div>
        <button type="button" class="folder-danger-btn" id="delete-current-folder-btn" data-del-folder="${escapeHtml(activeFolder.id)}" title="Delete this folder category">
          ${getIconSvg('trash', 13)}
          <span>Delete Folder</span>
        </button>
      </div>
    ` : '';

    if (filteredDocs.length === 0) {
      const hasSearch = this._searchQuery.trim().length > 0;
      resultsEl.innerHTML = `
        ${activeFolderBarHtml}
        <div class="folder-empty-state">
          <div class="folder-empty-icon">
            ${getIconSvg(hasSearch ? 'search' : (activeFolder ? activeFolder.icon : 'folder'), 24)}
          </div>
          <div class="folder-empty-title">
            ${hasSearch
              ? `No documents match “${escapeHtml(this._searchQuery.trim())}”`
              : activeFolder
                ? `No documents in “${escapeHtml(activeFolder.name)}” yet`
                : 'Your document library is ready'}
          </div>
          <p class="folder-empty-desc">
            ${hasSearch
              ? 'Try a different keyword or clear the search filter to see all files.'
              : 'Open a PDF from your device, start a fresh notebook, or assign existing files to this folder.'}
          </p>
          <div class="folder-empty-actions">
            ${hasSearch ? `
              <button type="button" class="secondary-btn" id="empty-clear-search-btn">
                ${getIconSvg('close', 13)}
                <span>Clear Search</span>
              </button>
            ` : `
              <button type="button" class="primary-btn" id="empty-open-pdf-btn">
                ${getIconSvg('folder', 14)}
                <span>Choose PDF</span>
              </button>
              <button type="button" class="secondary-btn" id="empty-new-notebook-btn">
                ${getIconSvg('notebook', 14)}
                <span>New Notebook</span>
              </button>
            `}
          </div>
        </div>
      `;
      this.bindResultsEvents(resultsEl, libraryBody);
      return;
    }

    if (this._viewMode === 'list') {
      resultsEl.innerHTML = `
        ${activeFolderBarHtml}
        <div class="recent-list" role="list">
          ${filteredDocs.map(doc => {
            const docFolder = this._folders.find(f => f.id === doc.folderId);
            const isEditing = this._editingDocId === doc.id;
            const cleanDisplayName = doc.name.replace(/\.pdf$/i, '');
            return `
              <div class="recent-list-row" data-recent-id="${escapeHtml(doc.id)}" role="listitem">
                <div class="recent-list-thumb">
                  ${this.renderDocumentCover(doc, docFolder)}
                </div>

                <div class="recent-list-main">
                  ${isEditing ? `
                    <input
                      type="text"
                      class="field recent-rename-input"
                      data-rename-input="${escapeHtml(doc.id)}"
                      value="${escapeHtml(cleanDisplayName)}"
                      aria-label="Rename document"
                    />
                  ` : `
                    <div class="recent-card-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
                  `}
                  <div class="recent-card-meta">
                    <span class="tabular-nums">${doc.pageCount ? `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}` : 'PDF document'}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span class="tabular-nums">${this.formatRelativeTime(doc.lastOpenedAt)}</span>
                    ${docFolder ? `
                      <span aria-hidden="true">&middot;</span>
                      <span class="recent-meta-folder" style="color:${docFolder.color};">
                        ${getIconSvg(docFolder.icon, 11)}
                        <span>${escapeHtml(docFolder.name)}</span>
                      </span>
                    ` : ''}
                  </div>
                </div>

                <div class="recent-card-actions">
                  <select class="recent-folder-select" data-doc-assign="${escapeHtml(doc.id)}" title="Assign folder category" aria-label="Assign folder category">
                    <option value="none" ${!doc.folderId ? 'selected' : ''}>Uncategorized</option>
                    ${this._folders.map(f => `
                      <option value="${escapeHtml(f.id)}" ${doc.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>
                    `).join('')}
                  </select>
                  <button type="button" class="recent-action-btn" data-rename-doc="${escapeHtml(doc.id)}" title="Rename document" aria-label="Rename document">
                    ${getIconSvg('edit', 13)}
                  </button>
                  <button type="button" class="recent-remove-btn" data-remove-recent="${escapeHtml(doc.id)}" title="Remove from library" aria-label="Remove from library">
                    ${getIconSvg('trash', 13)}
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      resultsEl.innerHTML = `
        ${activeFolderBarHtml}
        <div class="recent-grid is-gallery">
          ${filteredDocs.map(doc => {
            const docFolder = this._folders.find(f => f.id === doc.folderId);
            const isEditing = this._editingDocId === doc.id;
            const cleanDisplayName = doc.name.replace(/\.pdf$/i, '');
            return `
              <div class="recent-card is-gallery-card" data-recent-id="${escapeHtml(doc.id)}">
                <div class="recent-card-cover">
                  ${this.renderDocumentCover(doc, docFolder)}
                  <div class="recent-card-floating-actions">
                    <button type="button" class="recent-floating-btn" data-rename-doc="${escapeHtml(doc.id)}" title="Rename document" aria-label="Rename document">
                      ${getIconSvg('edit', 13)}
                    </button>
                    <button type="button" class="recent-floating-btn is-danger" data-remove-recent="${escapeHtml(doc.id)}" title="Remove from library" aria-label="Remove from library">
                      ${getIconSvg('trash', 13)}
                    </button>
                  </div>
                </div>

                <div class="recent-card-body">
                  <div class="recent-card-info">
                    ${isEditing ? `
                      <input
                        type="text"
                        class="field recent-rename-input"
                        data-rename-input="${escapeHtml(doc.id)}"
                        value="${escapeHtml(cleanDisplayName)}"
                        aria-label="Rename document"
                      />
                    ` : `
                      <div class="recent-card-name" data-title-dbl="${escapeHtml(doc.id)}" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
                    `}
                    <div class="recent-card-meta">
                      <span class="tabular-nums">${doc.pageCount ? `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}` : 'PDF'}</span>
                      <span aria-hidden="true">&middot;</span>
                      <span class="tabular-nums">${this.formatRelativeTime(doc.lastOpenedAt)}</span>
                    </div>
                  </div>

                  <div class="recent-card-footer recent-card-actions">
                    <div class="recent-folder-select-wrap">
                      <span class="recent-folder-dot" style="background:${docFolder ? docFolder.color : 'var(--text-muted)'};"></span>
                      <select class="recent-folder-select" data-doc-assign="${escapeHtml(doc.id)}" title="Change Folder Category" aria-label="Change Folder Category">
                        <option value="none" ${!doc.folderId ? 'selected' : ''}>Uncategorized</option>
                        ${this._folders.map(f => `
                          <option value="${escapeHtml(f.id)}" ${doc.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>
                        `).join('')}
                      </select>
                    </div>

                    <span class="recent-open-hint" aria-hidden="true">
                      ${getIconSvg('arrowRight', 13)}
                    </span>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    this.bindResultsEvents(resultsEl, libraryBody);
  }

  private bindLibraryChromeEvents(libraryBody: HTMLElement): void {
    const searchInput = libraryBody.querySelector<HTMLInputElement>('#library-search-input');
    const searchClear = libraryBody.querySelector<HTMLButtonElement>('#library-search-clear');
    const sortSelect = libraryBody.querySelector<HTMLSelectElement>('#library-sort-select');

    searchInput?.addEventListener('input', () => {
      this._searchQuery = searchInput.value;
      if (searchClear) searchClear.hidden = !this._searchQuery;
      this.renderLibraryResults(libraryBody);
    });

    searchInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && this._searchQuery) {
        e.preventDefault();
        this._searchQuery = '';
        searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        this.renderLibraryResults(libraryBody);
      }
    });

    searchClear?.addEventListener('click', () => {
      this._searchQuery = '';
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      searchClear.hidden = true;
      this.renderLibraryResults(libraryBody);
    });

    sortSelect?.addEventListener('change', () => {
      const val = sortSelect.value as LibrarySortBy;
      if (val === 'recent' || val === 'name' || val === 'pages') {
        this._sortBy = val;
        this.savePreferences();
        this.renderLibraryResults(libraryBody);
      }
    });

    libraryBody.querySelectorAll<HTMLButtonElement>('[data-library-view]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.getAttribute('data-library-view') as LibraryViewMode;
        if (mode === 'grid' || mode === 'list') {
          this._viewMode = mode;
          this.savePreferences();
          libraryBody.querySelectorAll<HTMLButtonElement>('[data-library-view]').forEach(b => {
            const active = b.getAttribute('data-library-view') === mode;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', String(active));
          });
          this.renderLibraryResults(libraryBody);
        }
      });
    });
  }

  private bindResultsEvents(resultsEl: HTMLElement, libraryBody: HTMLElement): void {
    // Empty state actions
    resultsEl.querySelector('#empty-clear-search-btn')?.addEventListener('click', () => {
      this._searchQuery = '';
      const searchInput = libraryBody.querySelector<HTMLInputElement>('#library-search-input');
      const searchClear = libraryBody.querySelector<HTMLButtonElement>('#library-search-clear');
      if (searchInput) searchInput.value = '';
      if (searchClear) searchClear.hidden = true;
      this.renderLibraryResults(libraryBody);
    });

    resultsEl.querySelector('#empty-open-pdf-btn')?.addEventListener('click', () => {
      this._callbacks.onOpenFile();
    });

    resultsEl.querySelector('#empty-new-notebook-btn')?.addEventListener('click', () => {
      this.openNotebookDialog();
    });

    // Delete Current Folder
    resultsEl.querySelector('#delete-current-folder-btn')?.addEventListener('click', async () => {
      if (this._activeFolderId !== 'all' && this._activeFolderId !== 'uncategorized') {
        const delId = this._activeFolderId;
        this._folders = this._folders.filter(f => f.id !== delId);
        this._recentDocs = this._recentDocs.map(d => d.folderId === delId ? { ...d, folderId: undefined } : d);
        this._activeFolderId = 'all';
        this.renderFolderTabs(libraryBody);
        this.renderLibraryResults(libraryBody);
        await deleteFolder(delId);
      }
    });

    // Assign Document to Folder (optimistic instant update)
    resultsEl.querySelectorAll<HTMLSelectElement>('[data-doc-assign]').forEach(sel => {
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const docId = sel.getAttribute('data-doc-assign');
        const val = sel.value;
        if (docId) {
          const targetFolderId = val === 'none' || !val ? null : val;
          this._recentDocs = this._recentDocs.map(d =>
            d.id === docId ? { ...d, folderId: targetFolderId || undefined } : d
          );
          this.renderFolderTabs(libraryBody);
          this.renderLibraryResults(libraryBody);
          void assignDocToFolder(docId, targetFolderId);
        }
      });
    });

    // Start Inline Rename via Rename button or double-clicking title
    const startRename = (docId: string) => {
      this._editingDocId = docId;
      this.renderLibraryResults(libraryBody);
      const input = resultsEl.querySelector<HTMLInputElement>(`[data-rename-input="${docId}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    };

    resultsEl.querySelectorAll<HTMLElement>('[data-rename-doc]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const docId = btn.getAttribute('data-rename-doc');
        if (docId) startRename(docId);
      });
    });

    resultsEl.querySelectorAll<HTMLElement>('[data-title-dbl]').forEach(titleEl => {
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const docId = titleEl.getAttribute('data-title-dbl');
        if (docId) startRename(docId);
      });
    });

    // Commit or Cancel Inline Rename
    resultsEl.querySelectorAll<HTMLInputElement>('[data-rename-input]').forEach(input => {
      let committed = false;
      const docId = input.getAttribute('data-rename-input');
      if (!docId) return;

      const commit = () => {
        if (committed) return;
        committed = true;
        const raw = input.value.trim();
        this._editingDocId = null;
        if (raw) {
          const finalName = raw.toLowerCase().endsWith('.pdf') ? raw : `${raw}.pdf`;
          this._recentDocs = this._recentDocs.map(d =>
            d.id === docId ? { ...d, name: finalName } : d
          );
          void renameRecentDocument(docId, finalName);
        }
        this.renderLibraryResults(libraryBody);
      };

      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed = true;
          this._editingDocId = null;
          this.renderLibraryResults(libraryBody);
        }
      });
      input.addEventListener('blur', () => commit());
    });

    // Remove Document from Recents (optimistic instant removal with zero flash)
    resultsEl.querySelectorAll('[data-remove-recent]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const docId = btn.getAttribute('data-remove-recent');
        if (docId) {
          this._recentDocs = this._recentDocs.filter(d => d.id !== docId);
          this.renderFolderTabs(libraryBody);
          this.renderLibraryResults(libraryBody);
          void deleteRecentDocument(docId);
        }
      });
    });

    // Card / Row click to open PDF
    resultsEl.querySelectorAll('[data-recent-id]').forEach(el => {
      el.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest('.recent-card-actions') ||
          target.closest('.recent-card-floating-actions') ||
          target.closest('.recent-rename-input')
        ) {
          return;
        }
        const id = el.getAttribute('data-recent-id');
        if (id) {
          await this._callbacks.onOpenRecent(id);
        }
      });
    });
  }

  private updateFolderModalDOM(): void {
    const slot = this._container.querySelector<HTMLElement>('#landing-folder-modal-slot');
    if (!slot) return;

    if (!this._showCreateFolderModal) {
      slot.innerHTML = '';
      return;
    }

    if (slot.querySelector('#new-folder-modal-overlay')) {
      return;
    }

    const folderColors = [
      '#6366f1', '#10b981', '#f43f5e', '#f59e0b',
      '#8b5cf6', '#06b6d4', '#2563eb', '#dc2626'
    ];
    const folderIcons = ['folder', 'book', 'briefcase', 'star', 'tag', 'code'];

    slot.innerHTML = `
      <div class="modal-overlay" id="new-folder-modal-overlay">
        <div class="modal-dialog form-dialog" role="dialog" aria-modal="true" aria-label="Create category folder">
          <div class="panel-header">
            <span class="panel-header-title">
              ${getIconSvg('folderPlus', 16)}
              Create Category Folder
            </span>
            <button id="close-folder-modal-btn" class="icon-btn is-small" title="Close" aria-label="Close">
              ${getIconSvg('close', 14)}
            </button>
          </div>

          <div class="form-dialog-body">
            <div class="form-field">
              <label class="form-label" for="folder-name-input">Folder Name</label>
              <input type="text" id="folder-name-input" class="field"
                     placeholder="e.g. Mathematics, Contracts, Research" autofocus />
            </div>

            <div class="form-field">
              <span class="form-label">Folder Color</span>
              <div class="chip-row">
                ${folderColors.map(color => `
                  <button type="button"
                          class="color-swatch is-square ${this._selectedFolderColor === color ? 'active' : ''}"
                          data-pick-folder-color="${color}"
                          style="background-color:${color};"
                          title="${color}" aria-label="Colour ${color}"
                          aria-pressed="${this._selectedFolderColor === color}"></button>
                `).join('')}
              </div>
            </div>

            <div class="form-field">
              <span class="form-label">Folder Icon</span>
              <div class="chip-row">
                ${folderIcons.map(icon => `
                  <button type="button"
                          class="secondary-btn is-compact is-capitalized ${this._selectedFolderIcon === icon ? 'is-selected' : ''}"
                          data-pick-folder-icon="${icon}"
                          aria-pressed="${this._selectedFolderIcon === icon}">
                    ${getIconSvg(icon, 15)}
                    ${icon}
                  </button>
                `).join('')}
              </div>
            </div>

            <div class="form-actions">
              <button id="cancel-folder-btn" class="secondary-btn">Cancel</button>
              <button id="submit-folder-btn" class="primary-btn">Create Folder</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindFolderModalEvents(slot);
  }

  /**
   * The paper chooser lives in its own overlay host appended to the body, so it
   * survives the landing page re-rendering underneath it.
   */
  private openNotebookDialog(initialPresetId?: string): void {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const preset = initialPresetId ? PAPER_PRESETS.find(p => p.id === initialPresetId) : undefined;

    const dialog = new NotebookDialogComponent(host, {
      mode: 'create',
      paper: preset ? { ...preset.paper } : undefined,
      onClose: () => host.remove(),
      onSubmit: async ({ paper, pageSize, pageCount }) => {
        try {
          const bytes = await buildNotebookPdf(paper, pageSize, pageCount);
          await this._callbacks.onOpenBytes('Notebook.pdf', bytes, { paper, pageSize });
        } catch (err) {
          console.error('Error generating notebook:', err);
        } finally {
          host.remove();
        }
      }
    });
    dialog.render();
  }

  private bindShellEvents(): void {
    const dropzone = this._container.querySelector('#landing-dropzone');
    const openBtn = this._container.querySelector('#landing-open-btn');
    const sampleBtn = this._container.querySelector('#landing-sample-btn');
    const notebookBtn = this._container.querySelector('#landing-notebook-btn');

    openBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._callbacks.onOpenFile();
    });

    dropzone?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('#dropzone-actions-group') || target.closest('#dropzone-quick-templates')) return;
      this._callbacks.onOpenFile();
    });

    sampleBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const bytes = await generateSamplePDF();
        await this._callbacks.onOpenBytes('Welcome to veditor.pdf', bytes);
      } catch (err: any) {
        console.error('Error generating sample PDF:', err);
      }
    });

    notebookBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openNotebookDialog();
    });

    this._container.querySelectorAll<HTMLElement>('[data-quick-preset]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const presetId = btn.dataset.quickPreset;
        this.openNotebookDialog(presetId);
      });
    });

    dropzone?.addEventListener('dragover', (e: Event) => {
      const dragEvt = e as DragEvent;
      dragEvt.preventDefault();
      dropzone.classList.add('is-dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });

    dropzone?.addEventListener('drop', async (e: Event) => {
      const dragEvt = e as DragEvent;
      dragEvt.preventDefault();
      dropzone.classList.remove('is-dragover');
      if (dragEvt.dataTransfer?.files && dragEvt.dataTransfer.files[0]) {
        const file = dragEvt.dataTransfer.files[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this._callbacks.onOpenBytes(file.name, bytes);
      }
    });
  }

  private bindFolderModalEvents(slot: HTMLElement): void {
    const closeModal = () => {
      this._showCreateFolderModal = false;
      this.updateFolderModalDOM();
    };

    slot.querySelector('#close-folder-modal-btn')?.addEventListener('click', closeModal);
    slot.querySelector('#cancel-folder-btn')?.addEventListener('click', closeModal);
    slot.querySelector('#new-folder-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    slot.querySelectorAll('[data-pick-folder-color]').forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.getAttribute('data-pick-folder-color');
        if (color) {
          this._selectedFolderColor = color;
          slot.querySelectorAll('[data-pick-folder-color]').forEach(s => {
            const active = s.getAttribute('data-pick-folder-color') === color;
            s.classList.toggle('active', active);
            s.setAttribute('aria-pressed', String(active));
          });
        }
      });
    });

    slot.querySelectorAll('[data-pick-folder-icon]').forEach(btn => {
      btn.addEventListener('click', () => {
        const icon = btn.getAttribute('data-pick-folder-icon');
        if (icon) {
          this._selectedFolderIcon = icon;
          slot.querySelectorAll('[data-pick-folder-icon]').forEach(b => {
            const active = b.getAttribute('data-pick-folder-icon') === icon;
            b.classList.toggle('is-selected', active);
            b.setAttribute('aria-pressed', String(active));
          });
        }
      });
    });

    const submitFolder = async () => {
      const input = slot.querySelector<HTMLInputElement>('#folder-name-input');
      const name = input?.value.trim();
      if (!name) {
        input?.focus();
        return;
      }

      const newFolder: PDFFolder = {
        id: `folder-${Date.now()}`,
        name,
        color: this._selectedFolderColor,
        icon: this._selectedFolderIcon,
        createdAt: Date.now()
      };

      this._folders.push(newFolder);
      this._showCreateFolderModal = false;
      this._activeFolderId = newFolder.id;
      this.updateFolderModalDOM();
      const libraryBody = this._container.querySelector<HTMLElement>('#landing-library-body');
      if (libraryBody) {
        this.renderFolderTabs(libraryBody);
        this.renderLibraryResults(libraryBody);
      }
      await saveFolder(newFolder);
    };

    slot.querySelector('#submit-folder-btn')?.addEventListener('click', () => {
      void submitFolder();
    });

    slot.querySelector<HTMLInputElement>('#folder-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submitFolder();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });
  }

  private formatRelativeTime(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }
}
