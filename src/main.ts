/**
 * veditor - World-Class PDF Editor & Annotator
 * Main Application Bootstrap
 */

import { store } from './core/store';
import { pdfEngine } from './core/pdf-engine';
import { viewportManager } from './core/viewport';
import { annotationEngine } from './annotations/engine';
import { pointerHandler } from './input/pointer-handler';
import { HeaderComponent } from './ui/components/header';
import { ToolbarComponent } from './ui/components/toolbar';
import { SidePanelsComponent } from './ui/components/side-panels';
import { PropertiesPanelComponent } from './ui/components/properties-panel';
import { ViewControlsComponent } from './ui/components/view-controls';
import { ScratchpadComponent } from './ui/components/scratchpad';
import { CommandPaletteComponent } from './ui/components/command-palette';
import { ShortcutsModalComponent } from './ui/components/shortcuts-modal';
import { SettingsModalComponent } from './ui/components/settings-modal';
import { SignatureDialogComponent } from './ui/components/signature-dialog';
import { showToast } from './ui/components/toast';
import { openDocumentSession, getDocumentSession, createDocumentId } from './io/storage';
import { saveActiveDocument, saveActiveDocumentAs, forgetFileHandle } from './io/save';
import { selectionManager } from './annotations/selection';
import { mergeBoundingBoxes } from './utils/geometry';
import { t } from './ui/i18n';
import { LandingPageComponent } from './ui/components/landing-page';
import { initAppearanceSync } from './ui/theme';
import { drawingCursorValue } from './ui/cursor';
import { history, DeleteAnnotationsCommand } from './core/history';
import { duplicateSelectedAnnotations } from './annotations/duplicate';
import { DocumentSession, NotebookSpec, ToolType, MIN_ZOOM, MAX_ZOOM } from './core/types';
import { notebookController } from './core/notebook';
import { gestureEngine } from './input/gestures';

class VeditorApp {
  private _scrollContainer: HTMLElement;
  private _pagesWrapper: HTMLElement;
  private _emptyStateView: HTMLElement;
  private _fileInput: HTMLInputElement;
  private _renderedPages: Map<number, {
    container: HTMLElement;
    pdfCanvas: HTMLCanvasElement;
    patternCanvas: HTMLCanvasElement;
    annotCanvas: HTMLCanvasElement;
    scratchCanvas: HTMLCanvasElement;
  }> = new Map();

  private _lastZoom: number = 1.0;
  private _lastDocId: string | null = null;
  private _lastViewMode: string = 'continuous';
  private _lastRotationSig: string = '';
  /** Generation token: concurrent tab switches invalidate stale async work. */
  private _docSwitchSeq: number = 0;

  /**
   * Lag-free zoom preview: while pinching (touch or trackpad) the pages
   * wrapper is scaled with a compositor-only CSS transform around the focal
   * point — zero store updates, zero re-layouts, zero PDF re-renders, zero
   * annotation repaints. The real zoom commits once when the gesture ends.
   */
  private _zoomPreviewScale: number = 1;
  private _zoomPreviewActive: boolean = false;
  private _zoomCommitTimer: number | null = null;
  /** rAF coalescing for wheel/pinch preview ticks (one layout read per frame). */
  private _previewRafId: number | null = null;
  private _previewPendingFactor: number = 1;
  private _previewPendingCenter: { x: number; y: number } | null = null;
  /** Unscaled wrapper size captured when the preview activates (for truthful scrollHeight). */
  private _previewBaseHeight: number | null = null;
  private _previewBaseWidth: number | null = null;

  /**
   * Hand-tool pan drag: pointer id + grab point + scroll origin. While set,
   * moves scroll the document instead of drawing anything.
   */
  private _handPan: {
    pointerId: number;
    startX: number;
    startY: number;
    scrollL: number;
    scrollT: number;
    canvas: HTMLCanvasElement;
  } | null = null;
  /** Tool to restore when a held Space (temporary hand) is released. */
  private _spacePrevTool: ToolType | null = null;

  constructor() {
    this._scrollContainer = document.getElementById('document-scroll-container') as HTMLElement;
    this._pagesWrapper = document.getElementById('document-pages-wrapper') as HTMLElement;
    this._emptyStateView = document.getElementById('empty-state-view') as HTMLElement;

    // Create hidden file input for opening PDFs
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'application/pdf';
    this._fileInput.style.display = 'none';
    document.body.appendChild(this._fileInput);

    this.init();
  }

  private async init() {
    // 1. Reflect saved theme, accent, density, direction & focus mode onto the
    //    document, and keep them in sync for the rest of the session.
    initAppearanceSync();

    // 2. Initialize Components
    new HeaderComponent(
      document.getElementById('app-header') as HTMLElement,
      () => this._fileInput.click(),
      () => this.openAddTabLanding()
    );
    new ToolbarComponent(document.getElementById('app-floating-toolbar') as HTMLElement);
    new SidePanelsComponent(document.getElementById('app-sidebar') as HTMLElement);
    new PropertiesPanelComponent(document.getElementById('app-properties-panel') as HTMLElement);
    new ViewControlsComponent(document.getElementById('app-view-controls') as HTMLElement);
    new ScratchpadComponent(document.getElementById('app-scratchpad') as HTMLElement);

    if (!store.activeDocument) {
      const tb = document.getElementById('app-floating-toolbar');
      if (tb) tb.style.display = 'none';
      const vc = document.getElementById('app-view-controls');
      if (vc) vc.style.display = 'none';
      const pp = document.getElementById('app-properties-panel');
      if (pp) pp.style.display = 'none';
    }

    const commandPaletteEl = document.getElementById('command-palette-container') || modalContainer;
    const shortcutsModalEl = document.getElementById('shortcuts-modal-container') || modalContainer;
    const settingsModalEl = document.getElementById('settings-modal-container') || modalContainer;
    const signatureModalEl = document.getElementById('signature-modal-container') || modalContainer;

    new CommandPaletteComponent(commandPaletteEl);
    new ShortcutsModalComponent(shortcutsModalEl);
    new SettingsModalComponent(settingsModalEl);
    new SignatureDialogComponent(signatureModalEl);

    // 3. Initialize Viewport Manager
    viewportManager.init(
      this._scrollContainer,
      this._pagesWrapper,
      (visibleIndices) => this.renderVisiblePages(visibleIndices)
    );

    // Background dimension fills (true page sizes arriving after first paint)
    // correct the layout so mixed-size docs stop overlapping. Preserve the
    // user's scroll offset across the correction.
    pdfEngine.onDimensionsUpdated((docId) => {
      if (store.activeDocument?.id !== docId) return;
      if (store.isDocSwitching || this._zoomPreviewActive) return;
      const top = this._scrollContainer.scrollTop;
      const left = this._scrollContainer.scrollLeft;
      viewportManager.updateLayout(true);
      // updateLayout's handleScroll may have nudged activePage; restore exact
      // pixel offset so the correction doesn't visibly jump.
      if (Math.abs(this._scrollContainer.scrollTop - top) > 2) {
        this._scrollContainer.scrollTop = top;
        this._scrollContainer.scrollLeft = left;
      }
    });

    // Rebuilding a notebook replaces its PDF bytes, so every mounted page has
    // to be dropped and re-rendered from the new document.
    notebookController.init(() => {
      this.clearRenderedPages();
      viewportManager.updateLayout(true);
    });

    // 4. Setup Drag & Drop and File Select
    this.setupFileHandling();

    // 5. Setup Zoom, Wheel & Navigation
    this.setupZoomAndNavigation();

    // 6. Setup Keyboard Shortcuts
    this.setupGlobalShortcuts();

    // 7. Check URL parameters
    await this.checkUrlParams();

    // 8. Clean up cached PDF documents and history when a tab is closed
    store.onTabClosed((tabId) => {
      pdfEngine.unloadDoc(tabId);
      history.removeDocument(tabId);
      forgetFileHandle(tabId);
    });

    // 9. Subscribe to document/page changes
    store.subscribe(() => {
      this.handleStoreUpdate();
    });

    this.renderEmptyState();
  }

  private renderEmptyState() {
    if (store.activeDocument) {
      this._emptyStateView.style.display = 'none';
      return;
    }

    this._emptyStateView.style.display = 'flex';
    const landing = new LandingPageComponent(this._emptyStateView, {
      onOpenFile: () => {
        this._fileInput.click();
      },
      onOpenBytes: async (name: string, bytes: Uint8Array, notebook?: NotebookSpec) => {
        await this.loadPDF(name, bytes, undefined, notebook);
      },
      onOpenRecent: async (docId: string) => {
        if (store.openDocuments.has(docId)) {
          store.switchDocumentTab(docId);
          return;
        }
        const session = await getDocumentSession(docId);
        if (session && session.fileData) {
          // Carry the notebook spec + last-viewed position so reopening
          // restores where the user left off instead of page 1.
          await this.loadPDF(session.name, session.fileData, docId, session.notebook, {
            activePageIndex: session.activePageIndex || 0,
            savedScrollTop: session.savedScrollTop,
            savedScrollLeft: session.savedScrollLeft
          });
        }
      }
    });
    landing.render();
  }

  /**
   * Opens the full landing page (recents, folders, sample, notebook, file
   * picker) in a modal so the tab-strip "+" offers every entry point.
   * Hosted on <body> because the header re-renders on every store change and
   * would tear a nested dialog down mid-interaction.
   */
  private openAddTabLanding(): void {
    if (document.getElementById('add-tab-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'add-tab-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog add-tab-dialog" role="dialog" aria-modal="true" aria-label="Add tab">
        <div class="panel-header">
          <span>Add tab</span>
          <button id="close-add-tab-btn" class="icon-btn" title="Close" aria-label="Close">✕</button>
        </div>
        <div id="add-tab-landing" class="add-tab-landing-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const close = () => {
      window.removeEventListener('keydown', onEsc);
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#close-add-tab-btn')?.addEventListener('click', close);
    window.addEventListener('keydown', onEsc);

    const host = overlay.querySelector('#add-tab-landing') as HTMLElement;
    const landing = new LandingPageComponent(host, {
      onOpenFile: () => {
        this._fileInput.click();
      },
      onOpenBytes: async (name: string, bytes: Uint8Array, notebook?: NotebookSpec) => {
        close();
        await this.loadPDF(name, bytes, undefined, notebook);
      },
      onOpenRecent: async (docId: string) => {
        close();
        if (store.openDocuments.has(docId)) {
          store.switchDocumentTab(docId);
          return;
        }
        const session = await getDocumentSession(docId);
        if (session && session.fileData) {
          await this.loadPDF(session.name, session.fileData, docId, session.notebook, {
            activePageIndex: session.activePageIndex || 0,
            savedScrollTop: session.savedScrollTop,
            savedScrollLeft: session.savedScrollLeft
          });
        }
      }
    });
    void landing.render();
  }

  private setupFileHandling() {
    this._fileInput.addEventListener('change', async () => {
      if (this._fileInput.files && this._fileInput.files[0]) {
        const file = this._fileInput.files[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        // A pick from the add-tab landing dismisses it via its own closer
        // (keeps the Escape listener cleanup intact).
        (document.getElementById('close-add-tab-btn') as HTMLButtonElement | null)?.click();
        await this.loadPDF(file.name, bytes);
      }
      // Reset so picking the same file twice still fires change.
      this._fileInput.value = '';
    });

    // Window Drag & Drop
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await this.loadPDF(file.name, bytes);
        }
      }
    });
  }

  public async loadPDF(
    name: string,
    bytes: Uint8Array,
    existingDocId?: string,
    notebook?: NotebookSpec,
    initialState?: { activePageIndex?: number; savedScrollTop?: number; savedScrollLeft?: number }
  ) {
    showToast(`Loading ${name}…`, 'progress');
    try {
      // Caller hands us a fresh buffer (file.arrayBuffer); take ownership with
      // zero extra copies. pdfEngine slices internally before worker transfer.
      const masterBytes = bytes;
      const docId = existingDocId || createDocumentId();
      if (!existingDocId) {
        // Persist in background: IDB structured-clone of large bytes must not
        // block first paint.
        void openDocumentSession(name, masterBytes, undefined, docId).catch(() => {});
      }
      const { pageCount, pages, bookmarks } = await pdfEngine.loadFromBytes(masterBytes, docId);

      const session: DocumentSession = {
        id: docId,
        name,
        fileData: masterBytes,
        pageCount,
        pages,
        bookmarks,
        annotations: {},
        layers: {},
        activePageIndex: initialState?.activePageIndex ?? 0,
        savedScrollTop: initialState?.savedScrollTop,
        savedScrollLeft: initialState?.savedScrollLeft,
        createdAt: Date.now(),
        lastModifiedAt: Date.now(),
        lastSavedAt: Date.now(),
        notebook
      };

      this._lastDocId = docId;
      history.switchDocument(docId);
      // Suppress scroll tracking while the fresh layout builds so the initial
      // handleScroll can't clobber the restored position.
      store.beginDocSwitch();
      try {
        this.resetZoomPreviewState();
        this._scrollContainer.scrollTop = 0;
        this._scrollContainer.scrollLeft = 0;
        viewportManager.clearVisible();
        store.setActiveDocument(session);
        this.clearRenderedPages();
        this.renderEmptyState();
        // Apply the user's default zoom for brand-new docs (reopens keep
        // their restored position/zoom instead).
        if (!existingDocId && !initialState) {
          this.applyDefaultZoomMode();
        }
        viewportManager.updateLayout(true);
        if (typeof session.savedScrollTop === 'number' && session.savedScrollTop > 0) {
          this._scrollContainer.scrollTo({ top: session.savedScrollTop, left: session.savedScrollLeft ?? 0, behavior: 'auto' });
        } else if (session.activePageIndex > 0) {
          viewportManager.scrollToPage(session.activePageIndex, { behavior: 'auto' });
        }
      } finally {
        store.endDocSwitch();
        viewportManager.handleScroll(true);
      }
      showToast(`${name} loaded (${pageCount} pages)`, 'success');
    } catch (err: any) {
      store.endDocSwitch();
      console.error('Error opening PDF:', err);
      showToast(`Error opening PDF: ${err.message}`, 'error');
    }
  }

  private clearRenderedPages() {
    for (const [, p] of this._renderedPages) {
      if (p.container.parentNode === this._pagesWrapper) {
        this._pagesWrapper.removeChild(p.container);
      }
    }
    this._renderedPages.clear();
  }

  private async handleStoreUpdate() {
    const floatingToolbar = document.getElementById('app-floating-toolbar');
    const viewControls = document.getElementById('app-view-controls');
    const propertiesPanel = document.getElementById('app-properties-panel');

    if (!store.activeDocument) {
      if (floatingToolbar) floatingToolbar.style.display = 'none';
      if (viewControls) viewControls.style.display = 'none';
      if (propertiesPanel) propertiesPanel.style.display = 'none';

      // This listener runs on every store change, so only rebuild the landing
      // page when a document is actually closed. Rebuilding unconditionally
      // discarded the landing page's own state (open dialogs, folder filter)
      // and re-queried IndexedDB on unrelated updates such as theme changes.
      if (this._lastDocId !== null) {
        this._lastDocId = null;
        history.switchDocument(null);
        this.clearRenderedPages();
        this.renderEmptyState();
      }
      return;
    }

    if (floatingToolbar) floatingToolbar.style.display = '';
    if (viewControls) viewControls.style.display = '';
    if (propertiesPanel) propertiesPanel.style.display = '';

    this._emptyStateView.style.display = 'none';

    // If zoom, document or viewMode changed, trigger full viewport re-layout
    const zoomChanged = Math.abs(store.zoom - this._lastZoom) > 0.001;
    const docChanged = store.activeDocument.id !== this._lastDocId;
    const viewModeChanged = store.viewMode !== this._lastViewMode;

    if (docChanged) {
      const mySeq = ++this._docSwitchSeq;
      // scrollContainer still holds the OUTGOING doc position: snapshot it
      // into the outgoing session before we lose it.
      const prevDoc = this._lastDocId ? store.openDocuments.get(this._lastDocId) : undefined;
      if (prevDoc) {
        prevDoc.savedScrollTop = this._scrollContainer.scrollTop;
        prevDoc.savedScrollLeft = this._scrollContainer.scrollLeft;
      }
      const targetDoc = store.activeDocument;
      const targetPage = store.activePageIndex;
      const targetScrollTop = targetDoc.savedScrollTop;
      const targetScrollLeft = targetDoc.savedScrollLeft ?? 0;

      this._lastDocId = targetDoc.id;
      this._lastZoom = store.zoom;
      this._lastViewMode = store.viewMode;
      try {
        const rots = store.pageRotations;
        this._lastRotationSig = Object.keys(rots).sort().map(k => `${k}:${rots[Number(k)]}`).join(',');
      } catch (_) { this._lastRotationSig = ''; }
      history.switchDocument(targetDoc.id);

      store.beginDocSwitch();
      try {
        this.resetZoomPreviewState();
        // Reset scroll synchronously BEFORE layout so handleScroll can't map
        // the stale offset onto the new document's page rects.
        this._scrollContainer.scrollTop = 0;
        this._scrollContainer.scrollLeft = 0;
        viewportManager.clearVisible();

        // Instant switch: activate cached document proxy in pdfEngine
        if (targetDoc.fileData) {
          await pdfEngine.loadFromBytes(targetDoc.fileData, targetDoc.id);
        }
        if (mySeq !== this._docSwitchSeq) return; // superseded by newer switch
        if (store.activeDocument?.id !== targetDoc.id) return;

        this.clearRenderedPages();
        viewportManager.updateLayout(true);
        // Instant restore (never smooth): smooth would animate through
        // intermediates and walk activePageIndex 0->1->2 via handleScroll.
        if (typeof targetScrollTop === 'number' && targetScrollTop > 0) {
          this._scrollContainer.scrollTo({ top: targetScrollTop, left: targetScrollLeft, behavior: 'auto' });
        } else if (targetPage > 0) {
          viewportManager.scrollToPage(targetPage, { behavior: 'auto' });
        } else {
          this._scrollContainer.scrollTop = 0;
        }
      } finally {
        store.endDocSwitch();
        // One sync pass so center-page tracking matches the restored offset.
        viewportManager.handleScroll(true);
      }
      return;
    }

    // Rotation changes alter page boxes; detect via signature since the
    // rotate buttons already call updateLayout explicitly (this is the safety net).
    let rotationSig = '';
    try {
      const rots = store.pageRotations;
      rotationSig = Object.keys(rots).sort().map(k => `${k}:${rots[Number(k)]}`).join(',');
    } catch (_) {}
    const rotationChanged = rotationSig !== this._lastRotationSig;

    if (zoomChanged || viewModeChanged || rotationChanged) {
      this._lastZoom = store.zoom;
      this._lastViewMode = store.viewMode;
      this._lastRotationSig = rotationSig;
      if (viewModeChanged || rotationChanged) {
        // Spread-only modes keep stale continuous containers at wrong tops;
        // rotation swaps w/h so every top below shifts. Start clean.
        this.resetZoomPreviewState();
        if (viewModeChanged) {
          this._scrollContainer.scrollTop = 0;
          this._scrollContainer.scrollLeft = 0;
        }
        viewportManager.clearVisible();
        this.clearRenderedPages();
      }
      // The size-indicating cursors are drawn at the on-screen brush size, so
      // they have to be refreshed on zoom as well as on tool changes.
      this.updateCanvasCursors();
      viewportManager.updateLayout(true);
      return;
    }
    this._lastRotationSig = rotationSig;

    // Update drawing cursors
    this.updateCanvasCursors();

    // Repaint all visible canvases
    for (const [pageIndex, p] of this._renderedPages) {
      this.repaintPageAnnotations(pageIndex, p);
    }
  }

  /**
   * Applies an incremental zoom factor as a pure visual preview: scales the
   * whole pages wrapper with a CSS transform around the focal point and keeps
   * the focal point stable via scroll compensation. Deliberately touches
   * nothing else — no store update (so no header/toolbar/sidebar re-render),
   * no viewport re-layout, no PDF re-render, no annotation repaint.
   */
  private previewZoomBy(factor: number, centerClient: { x: number; y: number }): void {
    if (!store.activeDocument) return;
    if (!Number.isFinite(factor) || factor <= 0) return;

    // Coalesce rapid wheel/pinch ticks into one rAF: accumulate the factor and
    // latest focal point so we pay one getBoundingClientRect + one transform
    // write per frame instead of one per tick.
    this._previewPendingFactor *= factor;
    this._previewPendingCenter = { x: centerClient.x, y: centerClient.y };
    if (this._previewRafId === null) {
      this._previewRafId = window.requestAnimationFrame(() => this.flushPreviewZoom());
    }
    this.scheduleZoomCommit();
  }

  private flushPreviewZoom(): void {
    this._previewRafId = null;
    const factor = this._previewPendingFactor;
    const center = this._previewPendingCenter;
    this._previewPendingFactor = 1;
    if (!store.activeDocument) return;
    if (!center || !Number.isFinite(factor) || factor <= 0) return;

    const unclamped = this._zoomPreviewScale * factor;
    // Clamp the TOTAL zoom (committed x preview) to the store's MIN/MAX range.
    const clampedTotal = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom * unclamped)) / store.zoom;
    const inc = clampedTotal / this._zoomPreviewScale;
    if (Math.abs(inc - 1) < 0.0005) {
      return;
    }

    const rect = this._scrollContainer.getBoundingClientRect();
    const fx = center.x - rect.left;
    const fy = center.y - rect.top;
    // With transform-origin 0 0, wrapper point p renders at s*p; keeping the
    // focal viewport point stable gives scroll' = (scroll + f) * inc - f.
    this._scrollContainer.scrollLeft = (this._scrollContainer.scrollLeft + fx) * inc - fx;
    this._scrollContainer.scrollTop = (this._scrollContainer.scrollTop + fy) * inc - fy;

    this._zoomPreviewScale = clampedTotal;
    this._zoomPreviewActive = true;
    this._pagesWrapper.style.transformOrigin = '0 0';
    this._pagesWrapper.style.transform = `scale(${this._zoomPreviewScale})`;
    // CSS transforms don't change scrollHeight, so without this the scroller
    // clamps at the old max-scroll mid-gesture (can't reach content zooming
    // in) and leaves dead space zooming out. Scale the box truthfully; the
    // commit's updateLayout recomputes the real size right after.
    if (this._previewBaseHeight === null) {
      this._previewBaseHeight = parseFloat(this._pagesWrapper.style.height) || this._pagesWrapper.scrollHeight;
      this._previewBaseWidth = parseFloat(this._pagesWrapper.style.width) || this._pagesWrapper.scrollWidth;
    }
    if (this._previewBaseHeight) {
      this._pagesWrapper.style.height = `${Math.max(1, Math.floor(this._previewBaseHeight * this._zoomPreviewScale))}px`;
    }
    if (this._previewBaseWidth) {
      this._pagesWrapper.style.width = `${Math.max(1, Math.floor(this._previewBaseWidth * this._zoomPreviewScale))}px`;
    }
    // Keep visible-page tracking in layout space while the wrapper is scaled.
    viewportManager.setPreviewScale(this._zoomPreviewScale);
  }

  private scheduleZoomCommit(): void {
    if (this._zoomCommitTimer !== null) window.clearTimeout(this._zoomCommitTimer);
    // Commit shortly after the last tick/finger move: one layout + one render
    // pass for the entire gesture instead of dozens per second mid-gesture.
    this._zoomCommitTimer = window.setTimeout(() => this.commitZoomPreview(), 160);
  }

  /** Drops any in-flight pinch/trackpad preview so a tab switch starts 1:1. */
  private resetZoomPreviewState(): void {
    if (this._zoomCommitTimer !== null) {
      window.clearTimeout(this._zoomCommitTimer);
      this._zoomCommitTimer = null;
    }
    if (this._previewRafId !== null) {
      window.cancelAnimationFrame(this._previewRafId);
      this._previewRafId = null;
    }
    this._previewPendingFactor = 1;
    this._previewPendingCenter = null;
    this._previewBaseHeight = null;
    this._previewBaseWidth = null;
    this._zoomPreviewScale = 1;
    this._zoomPreviewActive = false;
    if (this._pagesWrapper) {
      this._pagesWrapper.style.transform = '';
      this._pagesWrapper.style.transformOrigin = '';
    }
    viewportManager.setPreviewScale(1);
  }

  private commitZoomPreview(): void {
    this._zoomCommitTimer = null;
    // Apply any ticks that arrived after the last rAF before committing.
    if (this._previewRafId !== null) {
      window.cancelAnimationFrame(this._previewRafId);
      this._previewRafId = null;
      this.flushPreviewZoom();
    }
    if (!this._zoomPreviewActive) return;
    const finalZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom * this._zoomPreviewScale));
    this._zoomPreviewScale = 1;
    this._zoomPreviewActive = false;
    this._pagesWrapper.style.transform = '';
    this._pagesWrapper.style.transformOrigin = '';
    // Back to 1:1 mapping BEFORE the layout pass so every consumer (visible
    // tracking, mounts, repaints) works in real coordinates again.
    viewportManager.setPreviewScale(1);
    if (Math.abs(finalZoom - store.zoom) > 0.0005) {
      // Single commit: setZoom's notify path does the one layout + render pass
      // (updateLayout recomputes the wrapper box, discarding preview scaling).
      this._previewBaseHeight = null;
      this._previewBaseWidth = null;
      store.setZoom(finalZoom);
    } else {
      // Net-zero gesture: restore the unscaled box, then one clean pass so
      // preview-era mounts settle (no eviction happened mid-preview by design).
      if (this._previewBaseHeight) {
        this._pagesWrapper.style.height = `${Math.max(1, Math.floor(this._previewBaseHeight))}px`;
      }
      if (this._previewBaseWidth) {
        this._pagesWrapper.style.width = `${Math.max(1, Math.floor(this._previewBaseWidth))}px`;
      }
      this._previewBaseHeight = null;
      this._previewBaseWidth = null;
      viewportManager.handleScroll(true);
    }
  }

  /** Applies Settings → default zoom for brand-new documents. */
  private applyDefaultZoomMode(): void {
    const mode = store.appSettings.defaultZoomMode;
    if (mode === 'fitWidth') viewportManager.fitToWidth();
    else if (mode === 'fitPage') viewportManager.fitToPage();
    else if (mode === '100%') store.setZoom(1.0);
    else if (mode === '125%') store.setZoom(1.25);
    else if (mode === '150%') store.setZoom(1.5);
    // 'lastUsed' keeps the current global zoom.
  }

  /**
   * Immediate focal-anchored zoom step (double-click): keeps the clicked point
   * stable via scroll compensation. Single store commit → single layout pass.
   */
  private zoomAtPoint(factor: number, client: { x: number; y: number }): void {
    if (!store.activeDocument) return;
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (this._zoomPreviewActive) this.commitZoomPreview();
    const oldZoom = store.zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    if (Math.abs(newZoom - oldZoom) < 0.0005) return;
    const rect = this._scrollContainer.getBoundingClientRect();
    const fx = client.x - rect.left;
    const fy = client.y - rect.top;
    const ratio = newZoom / oldZoom;
    // Precompute the anchored scroll BEFORE setZoom: the layout pass inside
    // setZoom is suppressed, so only one mount pass happens after correction.
    const targetLeft = (this._scrollContainer.scrollLeft + fx) * ratio - fx;
    const targetTop = (this._scrollContainer.scrollTop + fy) * ratio - fy;
    store.beginZoomAdjust();
    try {
      store.setZoom(newZoom);
      this._scrollContainer.scrollLeft = targetLeft;
      this._scrollContainer.scrollTop = targetTop;
    } finally {
      store.endZoomAdjust();
    }
    viewportManager.handleScroll(true);
  }

  private setupZoomAndNavigation() {
    // Wheel zoom: Ctrl + Wheel (or trackpad pinch to zoom). Feeds the lag-free
    // preview; the real zoom commits once the gesture pauses.
    this._scrollContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Smooth exponential factor for both trackpad pinch and mouse wheel
        const factor = Math.exp(-e.deltaY * 0.0035);
        this.previewZoomBy(factor, { x: e.clientX, y: e.clientY });
      }
    }, { passive: false });

    // Keyboard shortcuts for zoom
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          store.setZoom(store.zoom * 1.2);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          store.setZoom(store.zoom / 1.2);
        } else if (e.key === '0') {
          e.preventDefault();
          viewportManager.fitToWidth();
        }
      }
    });

    // Window resize
    window.addEventListener('resize', () => {
      viewportManager.updateLayout(true);
    });
  }

  /**
   * Virtualization: Mounts and renders only visible pages into the scroll container.
   */
  private async renderVisiblePages(visibleIndices: number[]) {
    // During a tab-switch rebuild the layout is torn down; mounting now would
    // place old-doc pages at new-doc tops. The post-switch updateLayout does
    // the one true mount pass. Same for focal-anchored zoom steps.
    if (store.isDocSwitching || store.isZoomAdjusting) return;
    const doc = store.activeDocument;
    if (!doc) return;
    const docId = doc.id;

    // 1. Warm windowing: only evict pages well outside the viewport to prevent
    // scroll blinking. Never evict mid-preview: the commit 160ms later
    // re-renders sharp anyway, and evicting scaled-but-correct pages is what
    // flashed blank cracks.
    const maxKeepDistance = 6;
    for (const [pageIndex, p] of this._renderedPages) {
      if (store.activeDocument?.id !== docId || store.isDocSwitching) return;
      let minDistance = Infinity;
      for (const v of visibleIndices) {
        const d = Math.abs(pageIndex - v);
        if (d < minDistance) minDistance = d;
      }

      if (!this._zoomPreviewActive && minDistance > maxKeepDistance) {
        // Cancel in-flight PDF render tasks
        pdfEngine.cancelPageRender(pageIndex);

        if (p.container.parentNode === this._pagesWrapper) {
          this._pagesWrapper.removeChild(p.container);
        }
        this._renderedPages.delete(pageIndex);
      }
    }

    // 2. Mount and render newly visible pages
    for (const pageIndex of visibleIndices) {
      if (store.activeDocument?.id !== docId || store.isDocSwitching) return;
      const layout = viewportManager.getLayout(pageIndex);
      if (!layout) continue;

      let pageElements = this._renderedPages.get(pageIndex);
      // Stale container from a previous document (same index, different doc):
      // never reuse — remount so dataset guards + geometry stay correct.
      if (pageElements && pageElements.container.dataset.docId !== undefined && pageElements.container.dataset.docId !== docId) {
        pdfEngine.cancelPageRender(pageIndex);
        if (pageElements.container.parentNode === this._pagesWrapper) {
          this._pagesWrapper.removeChild(pageElements.container);
        }
        this._renderedPages.delete(pageIndex);
        pageElements = undefined;
      }

      if (!pageElements) {
        // Create container and 4-layer canvas architecture
        const container = document.createElement('div');
        container.className = 'pdf-page-container';
        container.dataset.pageIndex = String(pageIndex);
        container.dataset.docId = docId;

        const pdfCanvas = document.createElement('canvas');
        pdfCanvas.className = 'pdf-page-canvas';
        pdfCanvas.dataset.pageIndex = String(pageIndex);
        pdfCanvas.dataset.docId = docId;
        pdfCanvas.style.width = `${layout.width}px`;
        pdfCanvas.style.height = `${layout.height}px`;

        const patternCanvas = document.createElement('canvas');
        patternCanvas.className = 'pattern-canvas';

        const annotCanvas = document.createElement('canvas');
        annotCanvas.className = 'annotation-canvas';

        const scratchCanvas = document.createElement('canvas');
        scratchCanvas.className = 'scratchpad-canvas';
        scratchCanvas.style.cursor = drawingCursorValue(
          store.activeTool,
          store.toolSettings.drawingCursor || 'pen',
          store.zoom
        );

        container.appendChild(pdfCanvas);
        container.appendChild(patternCanvas);
        container.appendChild(annotCanvas);
        container.appendChild(scratchCanvas);

        this._pagesWrapper.appendChild(container);

        pageElements = { container, pdfCanvas, patternCanvas, annotCanvas, scratchCanvas };
        this._renderedPages.set(pageIndex, pageElements);

        // Bind Pointer Events to scratchpad canvas
        this.bindPointerEvents(scratchCanvas, pageIndex);
      }

      // Update position and dimensions from viewport layout
      pageElements.container.dataset.docId = docId;
      pageElements.container.style.top = `${layout.top}px`;
      pageElements.container.style.left = `${layout.left}px`;
      pageElements.container.style.width = `${layout.width}px`;
      pageElements.container.style.height = `${layout.height}px`;

      pageElements.pdfCanvas.dataset.pageIndex = String(pageIndex);
      pageElements.pdfCanvas.dataset.docId = docId;
      pageElements.pdfCanvas.style.width = `${layout.width}px`;
      pageElements.pdfCanvas.style.height = `${layout.height}px`;

      const dpr = store.appSettings.retinaRendering === false ? 1 : (window.devicePixelRatio || 1);
      const w = layout.width * dpr;
      const h = layout.height * dpr;

      // Avoid clearing canvas buffers if dimensions haven't changed!
      [pageElements.patternCanvas, pageElements.annotCanvas, pageElements.scratchCanvas].forEach(c => {
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
          c.style.width = `${layout.width}px`;
          c.style.height = `${layout.height}px`;
        }
      });

      // Render PDF page base
      const rot = store.pageRotations[pageIndex] || 0;
      void pdfEngine.renderPageToCanvas(pageIndex, pageElements.pdfCanvas, store.zoom, rot);

      // Render pattern & annotations
      this.repaintPageAnnotations(pageIndex, pageElements);
    }
  }

  private repaintPageAnnotations(
    pageIndex: number,
    p: { patternCanvas: HTMLCanvasElement; annotCanvas: HTMLCanvasElement; scratchCanvas: HTMLCanvasElement }
  ) {
    const dpr = store.appSettings.retinaRendering === false ? 1 : (window.devicePixelRatio || 1);
    const scale = store.zoom * dpr;

    // 1. Background paper pattern
    const patCtx = p.patternCanvas.getContext('2d');
    if (patCtx) {
      patCtx.clearRect(0, 0, p.patternCanvas.width, p.patternCanvas.height);
      // A notebook already has its paper drawn into the PDF, so the overlay
      // grid is only for imported documents.
      annotationEngine.renderBackgroundPattern(
        patCtx,
        p.patternCanvas.width,
        p.patternCanvas.height,
        notebookController.isNotebook() ? 'none' : store.appSettings.backgroundPattern,
        scale,
        store.appSettings.gridSize
      );
    }

    // 2. Committed Annotations & Selection Box
    const annCtx = p.annotCanvas.getContext('2d');
    if (annCtx) {
      annCtx.clearRect(0, 0, p.annotCanvas.width, p.annotCanvas.height);
      annotationEngine.renderAnnotationsToCanvas(annCtx, pageIndex, scale);

      // Render selection handles if active on this page
      const doc = store.activeDocument;
      if (doc) {
        const pageAnns = doc.annotations[pageIndex] || [];
        const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
        if (selected.length > 0) {
          selectionManager.render(annCtx, selected, scale);
        }
      }
    }
  }

  private gestureCallbacks() {
    return {
      onPinchZoom: (scaleDelta: number, center: { x: number; y: number }) =>
        this.previewZoomBy(scaleDelta, center),
      onPan: (dx: number, dy: number) => {
        this._scrollContainer.scrollLeft -= dx;
        this._scrollContainer.scrollTop -= dy;
      }
    };
  }

  private bindPointerEvents(canvas: HTMLCanvasElement, pageIndex: number) {
    const onRepaint = () => {
      const pageEls = this._renderedPages.get(pageIndex);
      if (pageEls) this.repaintPageAnnotations(pageIndex, pageEls);
    };

    canvas.addEventListener('pointerdown', (e) => {
      // A pending zoom preview leaves the wrapper CSS-scaled, so page
      // coordinates derived from bounding rects would be wrong — flush the
      // real zoom first so draw / pan / marquee all start 1:1.
      if (this._zoomPreviewActive) this.commitZoomPreview();
      // Two-finger touch takes over as pinch-zoom/pan: abort any in-progress
      // single-finger stroke so the gesture zooms the PDF and draws nothing.
      if (e.pointerType === 'touch') {
        const gestureStarted = gestureEngine.handlePointerDown(e);
        if (gestureStarted) {
          pointerHandler.cancelActiveStroke();
          this.endHandPan();
          e.preventDefault();
          return;
        }
        if (gestureEngine.isGestureActive) {
          e.preventDefault();
          return;
        }
      }
      // Hand tool: drag pans the page like a trackpad — never draws.
      if (store.activeTool === 'hand') {
        e.preventDefault();
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (_) {}
        this._handPan = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          scrollL: this._scrollContainer.scrollLeft,
          scrollT: this._scrollContainer.scrollTop,
          canvas
        };
        canvas.style.cursor = 'grabbing';
        return;
      }
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      pointerHandler.handlePointerDown(e, pageIndex, canvas, onRepaint);
    });

    canvas.addEventListener('pointermove', (e) => {
      // While a two-finger gesture is active, moves only zoom/pan — never draw.
      if (e.pointerType === 'touch') {
        const consumed = gestureEngine.handlePointerMove(e, this.gestureCallbacks());
        if (consumed || gestureEngine.isGestureActive) {
          e.preventDefault();
          return;
        }
      }
      if (this._handPan && e.pointerId === this._handPan.pointerId) {
        e.preventDefault();
        this._scrollContainer.scrollLeft = this._handPan.scrollL - (e.clientX - this._handPan.startX);
        this._scrollContainer.scrollTop = this._handPan.scrollT - (e.clientY - this._handPan.startY);
        return;
      }
      e.preventDefault();
      pointerHandler.handlePointerMove(e, pageIndex, canvas, onRepaint);
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        const wasGesture = gestureEngine.isGestureActive;
        gestureEngine.handlePointerUp(e);
        if (wasGesture) {
          // Last finger lifted: let the debounced single commit fire.
          e.preventDefault();
          this.scheduleZoomCommit();
          return;
        }
      }
      if (this._handPan && e.pointerId === this._handPan.pointerId) {
        e.preventDefault();
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch (_) {}
        this.endHandPan();
        return;
      }
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      pointerHandler.handlePointerUp(e, pageIndex, canvas, onRepaint, (pi, r) => this.zoomToRect(pi, r));
      // A notebook grows once the stroke is committed, so there is always
      // blank paper below what you just wrote.
      void notebookController.autoExtend(pageIndex);
    });

    canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') {
        const wasGesture = gestureEngine.isGestureActive;
        gestureEngine.handlePointerUp(e);
        if (wasGesture) {
          e.preventDefault();
          this.scheduleZoomCommit();
          return;
        }
      }
      if (this._handPan && e.pointerId === this._handPan.pointerId) {
        e.preventDefault();
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch (_) {}
        this.endHandPan();
        return;
      }
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      pointerHandler.handlePointerUp(e, pageIndex, canvas, onRepaint);
    });

    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      // Sticky notes own dblclick (collapse/edit); everything else keeps
      // polygon-close, then focal zoom for non-polygon tools.
      if (pointerHandler.handleNoteDoubleClick(e, pageIndex, canvas, onRepaint)) {
        this.repaintAllRenderedAnnotations();
        return;
      }
      const finished = pointerHandler.finishPolygon(pageIndex, 'layer-default', onRepaint);
      if (finished) return;
      if (store.activeTool === 'polygon') return;
      // Toggle: zoomed out → 200% at click; zoomed in → fit width.
      if (store.zoom < 1.5) {
        this.zoomAtPoint(2.0 / Math.max(store.zoom, MIN_ZOOM), { x: e.clientX, y: e.clientY });
      } else {
        viewportManager.fitToWidth();
      }
    });
  }

  private endHandPan(): void {
    if (!this._handPan) return;
    this._handPan = null;
    this.updateCanvasCursors();
  }

  /**
   * Zooms the view to fit a marquee-selected region and enters the zoom lens:
   * the pre-lens zoom is remembered so creation widths can be compensated
   * (tools feel identical on screen) and exiting restores it.
   */
  public zoomToRect(pageIndex: number, rect: { x: number; y: number; width: number; height: number }): void {
    const doc = store.activeDocument;
    if (!doc) return;

    const availW = Math.max(50, this._scrollContainer.clientWidth - 48);
    const availH = Math.max(50, this._scrollContainer.clientHeight - 48);
    const rectW = Math.max(8, rect.width * store.zoom);
    const rectH = Math.max(8, rect.height * store.zoom);
    const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom * Math.min(availW / rectW, availH / rectH)));

    if (!store.zoomLensActive) store.enterZoomLens(store.zoom);
    // Suppress the intermediate pass: layout rebuilds under the guard, then
    // one anchored mount pass runs after the correction below.
    store.beginZoomAdjust();
    try {
      store.setZoom(targetZoom);
    } finally {
      store.endZoomAdjust();
    }

    const layout = viewportManager.getLayout(pageIndex);
    if (layout) {
      const cx = layout.left + (rect.x + rect.width / 2) * targetZoom;
      const cy = layout.top + (rect.y + rect.height / 2) * targetZoom;
      // Instant anchor: smooth would animate through intermediates and walk
      // activePageIndex across pages via handleScroll (lag + wrong page).
      this._scrollContainer.scrollTo({
        left: Math.max(0, cx - this._scrollContainer.clientWidth / 2),
        top: Math.max(0, cy - this._scrollContainer.clientHeight / 2),
        behavior: 'auto'
      });
      store.setActivePageIndex(pageIndex);
      viewportManager.handleScroll(true);
    } else {
      viewportManager.handleScroll(true);
    }
  }

  public updateCanvasCursors(): void {
    const cursor = drawingCursorValue(
      store.activeTool,
      store.toolSettings.drawingCursor || 'pen',
      store.zoom
    );
    for (const [, p] of this._renderedPages) {
      p.scratchCanvas.style.cursor = cursor;
    }
  }

  public repaintAllRenderedAnnotations(): void {
    for (const [pageIndex, p] of this._renderedPages) {
      this.repaintPageAnnotations(pageIndex, p);
    }
  }

  /** Duplicates the current selection offset by 12pt (one undo step per page). */
  public duplicateSelection(): void {
    if (duplicateSelectedAnnotations().length > 0) {
      this.repaintAllRenderedAnnotations();
    }
  }

  private setupGlobalShortcuts() {
    // Hold Space for a temporary hand tool (Figma-style); release restores.
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ' && this._spacePrevTool) {
        const prev = this._spacePrevTool;
        this._spacePrevTool = null;
        // If the user picked another tool mid-hold, don't override it.
        if (store.activeTool === 'hand') store.setActiveTool(prev);
      }
    });

    window.addEventListener('keydown', (e) => {
      // Don't trigger tool shortcuts when typing in inputs
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      // Hold Space to pan (ignored with modifiers and on key repeat).
      if (e.key === ' ' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (store.activeTool !== 'hand' && this._spacePrevTool === null) {
          this._spacePrevTool = store.activeTool;
          store.setActiveTool('hand');
        }
        return;
      }

      if (e.key === 'Enter') {
        const handled = pointerHandler.finishPolygon(store.activePageIndex, 'layer-default', () => {
          this.repaintAllRenderedAnnotations();
        });
        if (handled) {
          e.preventDefault();
          return;
        }
      } else if (e.key === 'Escape') {
        // Mid-drag marquee/lasso first, then an active lens, then polygons.
        if (pointerHandler.cancelZoomMarquee()) return;
        if (pointerHandler.cancelLasso()) { this.repaintAllRenderedAnnotations(); return; }
        if (store.zoomLensActive) {
          store.exitZoomLens();
          return;
        }
        if (store.editingNoteId) {
          store.setEditingNote(null);
          return;
        }
        pointerHandler.cancelPolygon();
        return;
      }

      // Handle Ctrl / Cmd modifier shortcuts
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            history.redo();
          } else {
            history.undo();
          }
          this.repaintAllRenderedAnnotations();
          return;
        } else if (key === 'y') {
          e.preventDefault();
          history.redo();
          this.repaintAllRenderedAnnotations();
          return;
        } else if (key === 'o') {
          e.preventDefault();
          this._fileInput?.click();
          return;
        } else if (key === 's') {
          e.preventDefault();
          if (e.shiftKey) {
            void saveActiveDocumentAs();
          } else {
            void saveActiveDocument();
          }
          return;
        } else if (key === 'd') {
          e.preventDefault();
          this.duplicateSelection();
          return;
        }
        return;
      }

      if (e.altKey) return;

      const key = e.key.toLowerCase();

      // Delete / Backspace removes the current selection (all pages).
      if (key === 'delete' || key === 'backspace') {
        const selectedIds = Array.from(store.selectedAnnotationIds);
        const doc = store.activeDocument;
        if (doc && selectedIds.length > 0) {
          e.preventDefault();
          for (const pageIdx in doc.annotations) {
            const anns = doc.annotations[pageIdx].filter(a => selectedIds.includes(a.id));
            if (anns.length > 0) {
              history.execute(new DeleteAnnotationsCommand(parseInt(pageIdx, 10), anns));
            }
          }
          store.clearSelection();
          this.repaintAllRenderedAnnotations();
        }
        return;
      }

      if (key === 'v') store.setActiveTool('select');
      else if (key === 'p') store.setActiveTool('pen');
      else if (key === 'h') store.setActiveTool('highlighter');
      else if (key === 'e') store.setActiveTool('eraser');
      else if (key === 'r') store.setActiveTool('rectangle');
      else if (key === 'o') store.setActiveTool('ellipse');
      else if (key === 'l') store.setActiveTool('line');
      else if (key === 'a') store.setActiveTool('arrow');
      else if (key === 'g') store.setActiveTool('polygon');
      else if (key === 't') store.setActiveTool('text');
      else if (key === 'm') store.setActiveTool('stamp');
      else if (key === 'c') store.setActiveTool('callout');
      else if (key === 'k') store.setSignatureModalOpen(true);
      else if (key === 'u') store.setActiveTool('sticky-note');
      else if (key === 'n') {
        store.setActiveTool('scratchpad');
        store.setScratchpadOpen(true);
      }
      else if (key === 'x') store.setActiveTool('redaction');
      else if (key === 'z') store.setActiveTool('laser');
      else if (key === 'f') store.toggleFocusMode();
      else if (key === '?') store.setShortcutsModalOpen(true);
      else if (key === '0') viewportManager.fitToWidth();
    });
  }

  private async checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('docId');
    const pdfUrl = params.get('pdfUrl');
    const showShortcuts = params.get('showShortcuts');

    if (showShortcuts) {
      store.setShortcutsModalOpen(true);
    }

    if (docId) {
      const session = await getDocumentSession(docId);
      if (session && session.fileData) {
        await this.loadPDF(session.name, session.fileData, docId, session.notebook, {
          activePageIndex: session.activePageIndex || 0,
          savedScrollTop: session.savedScrollTop,
          savedScrollLeft: session.savedScrollLeft
        });
      }
    } else if (pdfUrl) {
      try {
        showToast(`Fetching ${pdfUrl}…`, 'progress');
        const res = await fetch(pdfUrl);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const filename = pdfUrl.split('/').pop() || 'document.pdf';
        await this.loadPDF(filename, bytes);
      } catch (err: any) {
        showToast(`Failed to load PDF from URL: ${err.message}`, 'error');
      }
    }
  }
}

// Bootstrap application on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  new VeditorApp();
});
