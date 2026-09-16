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
import { FloatingPropsBarComponent, floatingPropsBar } from './ui/components/floating-props';
import { AnnotationContextMenu } from './ui/components/context-menu';
import { showToast } from './ui/components/toast';
import { openDocumentSession, getDocumentSession, createDocumentId, saveDocumentSession } from './io/storage';
import { saveActiveDocument, saveActiveDocumentAs, forgetFileHandle, rememberFileHandle, isDocumentDirty } from './io/save';
import { selectionManager, transformAnnotation } from './annotations/selection';
import { mergeBoundingBoxes } from './utils/geometry';
import { resolveRenderDpr, clampRenderMultiplier } from './utils/dpi';
import { t } from './ui/i18n';
import { LandingPageComponent } from './ui/components/landing-page';
import { initAppearanceSync } from './ui/theme';
import { drawingCursorValue } from './ui/cursor';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, BulkModifyCommand } from './core/history';
import { stampTool } from './annotations/tools/stamp';
import { duplicateSelectedAnnotations } from './annotations/duplicate';
import { DocumentSession, NotebookSpec, ToolType, MIN_ZOOM, MAX_ZOOM } from './core/types';
import { notebookController } from './core/notebook';
import { onPageStructureChanged } from './core/page-ops';
import { gestureEngine } from './input/gestures';
import { shortcutManager } from './input/shortcuts';
import { isDesktop } from './core/platform';
import {
  nativeOpenPdfDialog,
  nativeReadFile,
  onNativeOpenFilePath,
  onWindowCloseRequested,
  takeStartupFilePath,
  nativeConfirm
} from './io/native-fs';
import { getDocumentSessionByPath, flushDocPosition } from './io/storage';

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
    /**
     * Signature of the layout that produced this element's current size
     * (zoom | render dpr | page rotation). A change means every backing store
     * was resized — and therefore blanked — so both the PDF raster and the
     * annotation layers have to be regenerated before the page is shown again.
     */
    geomKey?: string;
    /** PDF raster is stale (geometry changed) and must be re-rendered. */
    needsRaster?: boolean;
    /** Annotation/pattern layers were blanked by a resize and need a repaint. */
    needsRepaint?: boolean;
  }> = new Map();

  private _lastZoom: number = 1.0;
  private _lastDocId: string | null = null;
  private _lastViewMode: string = 'continuous';
  private _lastRotationSig: string = '';
  /**
   * `fileData` reference at the last page-structure apply. Page ops that change
   * the bytes always install a fresh `Uint8Array`, so identity inequality is an
   * exact "the PDF was rewritten" test — a record-only change (page rotation)
   * then skips both the engine reload and the full IndexedDB re-save.
   */
  private _structureBytes: { doc: DocumentSession; bytes: Uint8Array } | null = null;
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
  /** Last hand-tool press, for manual double-press quick-select detection. */
  private _lastHandTap: { time: number; x: number; y: number } | null = null;
  private _annotationMenu = new AnnotationContextMenu();

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
    // 0. Kill the native browser/OS context menu everywhere. Components that
    //    want a right-click menu (canvas pages, thumbnails, tabs, library
    //    items) build their own themed one via openContextMenu() and call
    //    preventDefault() themselves; this is just the fallback for every
    //    other surface (empty chrome, header, body) that doesn't.
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 1. Reflect saved theme, accent, density, direction & focus mode onto the
    //    document, and keep them in sync for the rest of the session.
    initAppearanceSync();

    // 2. Initialize Components
    new HeaderComponent(
      document.getElementById('app-header') as HTMLElement,
      () => void this.requestOpenFile(),
      () => this.openAddTabLanding()
    );
    new ToolbarComponent(document.getElementById('app-floating-toolbar') as HTMLElement);
    new SidePanelsComponent(document.getElementById('app-sidebar') as HTMLElement);
    new PropertiesPanelComponent(document.getElementById('app-properties-panel') as HTMLElement);
    new ViewControlsComponent(document.getElementById('app-view-controls') as HTMLElement);
    new ScratchpadComponent(document.getElementById('app-scratchpad') as HTMLElement);
    new FloatingPropsBarComponent(document.getElementById('app-viewport-container') as HTMLElement);

    const pp = document.getElementById('app-properties-panel');
    if (pp) pp.style.display = 'none';

    if (!store.activeDocument) {
      const tb = document.getElementById('app-floating-toolbar');
      if (tb) tb.style.display = 'none';
      const vc = document.getElementById('app-view-controls');
      if (vc) vc.style.display = 'none';
    }

    const modalContainer = (document.getElementById('modal-container') || document.body) as HTMLElement;
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

    // A page operation rewrites the bytes and renumbers every page, so the
    // cached pdf.js proxy is worthless and every mounted element is stale.
    // This runs for undo/redo as well, since PageOpsCommand restores snapshots
    // through the same path.
    onPageStructureChanged((doc) => {
      void this.reloadPageStructure(doc);
    });

    // 4. Setup Drag & Drop and File Select
    this.setupFileHandling();

    // 5. Setup Zoom, Wheel & Navigation
    this.setupZoomAndNavigation();

    // 6. Setup Keyboard Shortcuts
    this.setupGlobalShortcuts();

    // 6b. Paste images copied outside the editor straight onto the page.
    this.setupClipboardImagePaste();

    // 7. Check URL parameters
    await this.checkUrlParams();

    // 7b. Desktop-only native integration: confirm before the OS actually
    // closes the window, resume a file double-clicked via the registered
    // file association, and open whatever file this process was launched
    // with (or that a second launch forwarded through single-instance).
    if (isDesktop()) {
      void onWindowCloseRequested(() => this.confirmAppClose());
      onNativeOpenFilePath((path) => { void this.openNativeFile(path); });
      void takeStartupFilePath().then((path) => {
        if (path && !store.activeDocument) void this.openNativeFile(path);
      });
    }

    // 8. Clean up cached PDF documents and history when a tab is closed
    store.onTabClosed((tabId, closedDoc) => {
      pdfEngine.unloadDoc(tabId);
      history.removeDocument(tabId);
      forgetFileHandle(tabId);
      if (closedDoc) void flushDocPosition(closedDoc);
      // Nothing left open: the landing page is about to show. Reset the
      // scroll container so it doesn't inherit a bottom-scrolled offset
      // from whatever document was just closed.
      if (store.openDocuments.size === 0) {
        this._scrollContainer.scrollTop = 0;
        this._scrollContainer.scrollLeft = 0;
      }
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
        void this.requestOpenFile();
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
        void this.requestOpenFile();
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

  public async requestOpenFile(): Promise<void> {
    if (isDesktop()) {
      const picked = await nativeOpenPdfDialog();
      if (picked) {
        (document.getElementById('close-add-tab-btn') as HTMLButtonElement | null)?.click();
        await this.openNativeFile(picked.path, picked.bytes);
      }
      return;
    }
    if ('showOpenFilePicker' in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'PDF Documents (*.pdf)',
              accept: { 'application/pdf': ['.pdf'] }
            }
          ],
          multiple: false
        });
        if (handle) {
          const file = await handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          (document.getElementById('close-add-tab-btn') as HTMLButtonElement | null)?.click();
          const docId = await this.loadPDF(file.name, bytes);
          if (docId) {
            rememberFileHandle(docId, handle);
          }
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, falling back to file input:', err);
      }
    }
    this._fileInput.click();
  }

  /**
   * Opens a PDF by its absolute disk path (desktop only): the native file
   * picker, a double-clicked file association, or a second app launch
   * forwarded through the single-instance handler. Reopening a path that
   * already has a session resumes its last page/scroll instead of starting
   * a disconnected duplicate tab.
   */
  private async openNativeFile(path: string, preloadedBytes?: Uint8Array): Promise<void> {
    for (const doc of store.openDocuments.values()) {
      if (doc.nativeFilePath === path) {
        store.switchDocumentTab(doc.id);
        return;
      }
    }
    const bytes = preloadedBytes ?? await nativeReadFile(path);
    if (!bytes) {
      showToast('Could not read that file', 'error');
      return;
    }
    const name = path.split(/[\\/]/).pop() || 'document.pdf';
    const existing = await getDocumentSessionByPath(path);
    await this.loadPDF(
      name,
      bytes,
      existing?.id,
      existing?.notebook,
      existing ? {
        activePageIndex: existing.activePageIndex || 0,
        savedScrollTop: existing.savedScrollTop,
        savedScrollLeft: existing.savedScrollLeft
      } : undefined,
      path
    );
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
      let fileHandle: FileSystemFileHandle | null = null;
      if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
        const item = e.dataTransfer.items[0];
        if (typeof (item as any).getAsFileSystemHandle === 'function') {
          try {
            const entry = await (item as any).getAsFileSystemHandle();
            if (entry && entry.kind === 'file') {
              fileHandle = entry as FileSystemFileHandle;
            }
          } catch {
            // Ignore handle error and fallback to standard File
          }
        }
      }

      if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const docId = await this.loadPDF(file.name, bytes);
          if (docId && fileHandle) {
            rememberFileHandle(docId, fileHandle);
          }
        }
      }
    });
  }

  private showPdfLoading(filename: string, statusText: string = 'Parsing document structure…'): void {
    const overlay = document.getElementById('pdf-loading-overlay');
    const titleEl = document.getElementById('pdf-loading-filename');
    const statusEl = document.getElementById('pdf-loading-status');
    if (titleEl) titleEl.textContent = filename;
    if (statusEl) statusEl.textContent = statusText;
    if (overlay) {
      overlay.classList.remove('is-hidden');
    }
  }

  private hidePdfLoading(): void {
    const overlay = document.getElementById('pdf-loading-overlay');
    if (overlay) {
      overlay.classList.add('is-hidden');
    }
  }

  public async loadPDF(
    name: string,
    bytes: Uint8Array,
    existingDocId?: string,
    notebook?: NotebookSpec,
    initialState?: { activePageIndex?: number; savedScrollTop?: number; savedScrollLeft?: number },
    nativeFilePath?: string
  ): Promise<string | null> {
    this.showPdfLoading(name, 'Opening document…');
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
      this.showPdfLoading(name, 'Parsing PDF structure & pages…');
      const { pageCount, pages, bookmarks } = await pdfEngine.loadFromBytes(masterBytes, docId);

      const existingSession = existingDocId ? store.openDocuments.get(existingDocId) : null;
      const importedAnnotations: DocumentSession['annotations'] = existingSession?.annotations
        ? { ...existingSession.annotations }
        : {};

      for (const { pageIndex, annotation } of await pdfEngine.extractNativeInkStrokes(masterBytes)) {
        const list = (importedAnnotations[pageIndex] ??= []);
        if (!list.some(a => a.id === annotation.id)) {
          list.push(annotation);
        }
      }

      const session: DocumentSession = {
        id: docId,
        name,
        fileData: masterBytes,
        pageCount,
        pages,
        bookmarks,
        annotations: importedAnnotations,
        layers: {},
        activePageIndex: initialState?.activePageIndex ?? 0,
        savedScrollTop: initialState?.savedScrollTop,
        savedScrollLeft: initialState?.savedScrollLeft,
        createdAt: Date.now(),
        lastModifiedAt: Date.now(),
        lastSavedAt: Date.now(),
        notebook,
        nativeFilePath
      };
      if (nativeFilePath) {
        // Cheap metadata-only write so a second open-by-path (or the
        // single-instance handoff) can find this session immediately,
        // without waiting for the first edit/autosave.
        void saveDocumentSession(session, { includeBytes: false }).catch(() => {});
      }

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
      return docId;
    } catch (err: any) {
      store.endDocSwitch();
      console.error('Error opening PDF:', err);
      showToast(`Error opening PDF: ${err.message}`, 'error');
      return null;
    } finally {
      // Smooth fade out of the loading overlay
      window.setTimeout(() => {
        this.hidePdfLoading();
      }, 180);
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

  /**
   * Re-mounts the whole document after a page operation changed its bytes.
   *
   * The pdf.js proxy for this doc id points at the previous file, so it has to
   * be dropped before the new bytes are parsed; every mounted element is then
   * stale by construction (page numbers all shifted), which is why this starts
   * clean rather than trying to patch individual pages.
   */
  private async reloadPageStructure(doc: DocumentSession): Promise<void> {
    if (store.activeDocument?.id !== doc.id) return;

    // Only re-parse and re-persist when the page op actually rewrote the PDF.
    // Rotation lives in the record layer, so it needs a re-layout and a
    // re-raster (the engine keys its bitmap cache by page@scale:rotation) but
    // not a reload of the same bytes.
    const bytes = doc.fileData;
    const previous = this._structureBytes;
    const bytesChanged = !previous || previous.doc !== doc || previous.bytes !== bytes;
    this._structureBytes = bytes ? { doc, bytes } : null;

    this.resetZoomPreviewState();
    if (bytesChanged) {
      pdfEngine.unloadDoc(doc.id);
      try {
        // loadFromBytes copies internally, so passing the live bytes is safe.
        if (bytes) await pdfEngine.loadFromBytes(bytes, doc.id);
      } catch (err) {
        console.error('Could not reload the document after a page operation:', err);
      }
      // The user may have switched tabs while the PDF was parsing.
      if (store.activeDocument?.id !== doc.id) return;
    }

    this.clearRenderedPages();
    viewportManager.clearVisible();
    viewportManager.updateLayout(true);

    const target = Math.max(0, Math.min(doc.pageCount - 1, store.activePageIndex));
    viewportManager.scrollToPage(target, { behavior: 'auto' });

    // Page ops are structural edits, so they are saved immediately rather than
    // waiting for the autosave debounce.
    if (bytesChanged) {
      void saveDocumentSession(doc, { includeBytes: true }).catch(err => {
        console.warn('Could not persist the page operation:', err);
      });
    }

    store.notify();
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
        const previousDoc = store.openDocuments.get(this._lastDocId);
        if (previousDoc) {
          previousDoc.savedScrollTop = this._scrollContainer.scrollTop;
          previousDoc.savedScrollLeft = this._scrollContainer.scrollLeft;
        }
        this._docSwitchSeq++;
        this._lastDocId = null;
        this.resetZoomPreviewState();
        history.switchDocument(null);
        this.clearRenderedPages();
        viewportManager.updateLayout(true);
        this._scrollContainer.scrollTop = 0;
        this.renderEmptyState();
      }
      return;
    }

    if (floatingToolbar) floatingToolbar.style.display = '';
    if (viewControls) viewControls.style.display = '';
    // The inspector never opens on creation because selection does not touch
    // this flag; it appears only for explicit actions such as Properties.
    if (propertiesPanel) {
      propertiesPanel.style.display = store.propertiesPanelOpen ? '' : 'none';
    }

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
      this._previewBaseHeight = null;
      this._previewBaseWidth = null;

      // Robust focal page anchoring to prevent page jumps:
      const anchorPageIndex = store.activePageIndex;
      const viewH = this._scrollContainer.clientHeight;
      const viewW = this._scrollContainer.clientWidth;
      const centerScrollerY = this._scrollContainer.scrollTop + viewH / 2;
      const centerScrollerX = this._scrollContainer.scrollLeft + viewW / 2;
      const oldLayout = viewportManager.getLayout(anchorPageIndex);
      let relY = 0.5;
      let relX = 0.5;
      if (oldLayout && oldLayout.height > 0 && oldLayout.width > 0) {
        relY = Math.max(0, Math.min(1, (centerScrollerY - oldLayout.top) / oldLayout.height));
        relX = Math.max(0, Math.min(1, (centerScrollerX - oldLayout.left) / oldLayout.width));
      }

      store.beginZoomAdjust();
      try {
        store.setZoom(finalZoom);
        const newLayout = viewportManager.getLayout(anchorPageIndex);
        if (newLayout) {
          this._scrollContainer.scrollTop = Math.max(0, newLayout.top + relY * newLayout.height - viewH / 2);
          this._scrollContainer.scrollLeft = Math.max(0, newLayout.left + relX * newLayout.width - viewW / 2);
        }
      } finally {
        store.endZoomAdjust();
      }
      viewportManager.handleScroll(true);
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
          viewportManager.zoomByFactor(1.2);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          viewportManager.zoomByFactor(1 / 1.2);
        } else if (e.key === '0') {
          e.preventDefault();
          viewportManager.fitToWidth();
        }
      }
    });

    // Window & Viewport resize
    window.addEventListener('resize', () => {
      viewportManager.updateLayout(true);
    });

    if (typeof ResizeObserver !== 'undefined' && this._scrollContainer) {
      const resizeObserver = new ResizeObserver(() => {
        viewportManager.updateLayout(true);
      });
      resizeObserver.observe(this._scrollContainer);
    }
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

    // PIPE_4: Cancel in-flight render tasks for pages outside visible window
    pdfEngine.cancelOutdatedRenderTasks(new Set(visibleIndices));

    // PIPE_3: VRAM Pool OOM Guard - Evict pages beyond dist > 1 from viewport
    const maxKeepDistance = 1;
    for (const [pageIndex, p] of this._renderedPages) {
      if (store.activeDocument?.id !== docId || store.isDocSwitching) return;
      let minDistance = Infinity;
      for (const v of visibleIndices) {
        const d = Math.abs(pageIndex - v);
        if (d < minDistance) minDistance = d;
      }

      if (!this._zoomPreviewActive && minDistance > maxKeepDistance) {
        pdfEngine.cancelPageRender(pageIndex);
        // Explicitly collapse backing stores to 1x1 to release VRAM buffers immediately
        p.pdfCanvas.width = 1; p.pdfCanvas.height = 1;
        p.patternCanvas.width = 1; p.patternCanvas.height = 1;
        p.annotCanvas.width = 1; p.annotCanvas.height = 1;
        p.scratchCanvas.width = 1; p.scratchCanvas.height = 1;

        if (p.container.parentNode === this._pagesWrapper) {
          this._pagesWrapper.removeChild(p.container);
        }
        this._renderedPages.delete(pageIndex);
      }
    }

    const docStillCurrent = () => store.activeDocument?.id === docId && !store.isDocSwitching;
    const visibleSet = new Set(visibleIndices);

    // 2. Mount: create the DOM for visible pages that have no element yet.
    // Geometry, rasterising and repaints all happen in later passes so that
    // *every* mounted page — visible or merely retained in the warm window —
    // is reconciled against the same layout.
    for (const pageIndex of visibleIndices) {
      if (!docStillCurrent()) return;
      if (!viewportManager.getLayout(pageIndex)) continue;

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
    }

    // 3. Geometry pass over EVERY mounted page. Retained pages outside the
    // visible set are still positioned and sized here; leaving them at the
    // previous zoom's top/size is what painted stale pages on top of the
    // corrected ones after a zoom ("everything mixes together"). Their raster
    // is dropped rather than re-rendered — they are offscreen by definition
    // and pdfEngine's bitmap cache makes the re-entry render instant.
    for (const [pageIndex, p] of Array.from(this._renderedPages.entries())) {
      if (!docStillCurrent()) return;
      const layout = viewportManager.getLayout(pageIndex);
      if (!layout) {
        // Page no longer exists in the layout (deleted by a page operation).
        pdfEngine.cancelPageRender(pageIndex);
        if (p.container.parentNode === this._pagesWrapper) {
          this._pagesWrapper.removeChild(p.container);
        }
        this._renderedPages.delete(pageIndex);
        continue;
      }
      this.applyPageGeometry(pageIndex, p, layout, docId);
    }

    // 4. Render pass: rasterise and repaint. Visible pages always repaint;
    // pages whose backing stores were just resized repaint exactly once, and
    // the PDF raster is only regenerated for a page that is on screen.
    for (const [pageIndex, p] of Array.from(this._renderedPages.entries())) {
      if (!docStillCurrent()) return;
      const isVisible = visibleSet.has(pageIndex);

      if (isVisible) {
        if (p.needsRaster) {
          p.needsRaster = false;
          const rot = store.pageRotations[pageIndex] || 0;
          void pdfEngine.renderPageToCanvas(pageIndex, p.pdfCanvas, store.zoom, rot);
        }
        // An on-screen page always repaints, so a pending flag for it is
        // redundant — clearing it here keeps the offscreen pages' single
        // deferred repaint from doubling up on the visible ones.
        p.needsRepaint = false;
        this.repaintPageAnnotations(pageIndex, p);
      } else if (p.needsRepaint) {
        // Offscreen but its backing stores were resized: repaint now so the
        // layers are correct the moment it scrolls back in. The PDF raster
        // itself stays deferred until it is actually on screen.
        p.needsRepaint = false;
        this.repaintPageAnnotations(pageIndex, p);
      }
    }
  }

  /**
   * Positions and sizes one mounted page from its viewport layout rect, and
   * flags the layers for regeneration when anything actually changed. Split out
   * of renderVisiblePages so retained (offscreen) pages are reconciled too.
   */
  private applyPageGeometry(
    pageIndex: number,
    p: { container: HTMLElement; pdfCanvas: HTMLCanvasElement; patternCanvas: HTMLCanvasElement; annotCanvas: HTMLCanvasElement; scratchCanvas: HTMLCanvasElement; geomKey?: string; needsRaster?: boolean; needsRepaint?: boolean },
    layout: { top: number; left: number; width: number; height: number },
    docId: string
  ): void {
    const dpr = clampRenderMultiplier(
      layout.width,
      layout.height,
      resolveRenderDpr(store.appSettings.targetDPI)
    );
    const rot = store.pageRotations[pageIndex] || 0;
    const geomKey = `${store.zoom.toFixed(4)}|${dpr.toFixed(4)}|${rot}`;

    p.container.dataset.docId = docId;
    p.container.style.top = `${layout.top}px`;
    p.container.style.left = `${layout.left}px`;
    p.container.style.width = `${layout.width}px`;
    p.container.style.height = `${layout.height}px`;

    p.pdfCanvas.dataset.pageIndex = String(pageIndex);
    p.pdfCanvas.dataset.docId = docId;
    p.pdfCanvas.style.width = `${layout.width}px`;
    p.pdfCanvas.style.height = `${layout.height}px`;

    // Whole-pixel backing stores: fractional canvas sizes are truncated by
    // the browser, leaving a sub-pixel mismatch against the CSS size that
    // slightly resamples (and softens/aliases) every stroke.
    const w = Math.round(layout.width * dpr);
    const h = Math.round(layout.height * dpr);

    // Avoid clearing canvas buffers if dimensions haven't changed!
    let resized = false;
    [p.patternCanvas, p.annotCanvas, p.scratchCanvas].forEach(c => {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        c.style.width = `${layout.width}px`;
        c.style.height = `${layout.height}px`;
        resized = true;
      }
    });

    if (resized) {
      // A resized backing store is blank, so both the raster and the layers
      // are stale regardless of whether the signature changed (e.g. DPI edits
      // round to the same multiplier).
      p.needsRepaint = true;
      if (p.pdfCanvas.width !== w || p.pdfCanvas.height !== h) {
        p.pdfCanvas.width = w;
        p.pdfCanvas.height = h;
      }
      p.needsRaster = true;
    }

    if (p.geomKey !== geomKey) {
      p.geomKey = geomKey;
      if (p.pdfCanvas.width !== w || p.pdfCanvas.height !== h) {
        p.pdfCanvas.width = w;
        p.pdfCanvas.height = h;
      }
      p.needsRaster = true;
    }
  }

  private repaintPageAnnotations(
    pageIndex: number,
    p: { patternCanvas: HTMLCanvasElement; annotCanvas: HTMLCanvasElement; scratchCanvas: HTMLCanvasElement }
  ) {
    const cssW = parseFloat(p.patternCanvas.style.width) || p.patternCanvas.width;
    const cssH = parseFloat(p.patternCanvas.style.height) || p.patternCanvas.height;
    const dpr = clampRenderMultiplier(cssW, cssH, resolveRenderDpr(store.appSettings.targetDPI));
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

    // Suppress the browser's middle-click autoscroll affordance; the app pans.
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });

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
      // Middle-click pans in every tool. Mouse strokes start only on the
      // primary button; alternate buttons are reserved for menus and pans.
      if (e.pointerType === 'mouse' && e.button === 1) {
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
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Transform handles and the selected body take precedence over the hand
      // tool. (The lasso tool handles this itself in PointerHandler.)
      if (
        store.activeTool === 'hand' &&
        pointerHandler.isSelectionControlAt(e, pageIndex, canvas)
      ) {
        store.setActiveTool('select');
      }
      // Hand tool: drag pans the page like a trackpad — never draws.
      if (store.activeTool === 'hand') {
        // Double-press quick-select. Detected manually on pointerdown because
        // `dblclick` is unreliable here: canceled pointerdowns and touch
        // double-taps don't produce it consistently across browsers.
        const now = performance.now();
        const lastTap = this._lastHandTap;
        this._lastHandTap = { time: now, x: e.clientX, y: e.clientY };
        if (
          lastTap &&
          now - lastTap.time < 400 &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 25
        ) {
          const point = pointerHandler.pagePointForEvent(e, canvas);
          const hit = selectionManager.findAnnotationAtPoint(
            point, store.activeDocument?.annotations[pageIndex] || []
          );
          if (hit) {
            this._lastHandTap = null;
            store.setActiveTool('select');
            store.selectAnnotation(hit.id);
            onRepaint();
            return;
          }
        }
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
      if (!pointerHandler.isPointerDown) {
        pointerHandler.handleHover(e, pageIndex, canvas);
        // Polygon vertices are placed on click, so its elastic edge must also
        // receive unpressed moves. `handlePointerMove` returns immediately for
        // every other inactive tool.
        pointerHandler.handlePointerMove(e, pageIndex, canvas, onRepaint);
        return;
      }
      e.preventDefault();
      pointerHandler.handlePointerMove(e, pageIndex, canvas, onRepaint);
    });

    canvas.addEventListener('pointerleave', () => {
      floatingPropsBar?.setHoverState(false);
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
      const finished = pointerHandler.finishPolygon(pageIndex, 'layer-default', onRepaint);
      if (finished) return;
      if (store.activeTool === 'polygon') return;
      // The hand tool remains an efficient navigation mode, but double-click
      // is an intentional editing gesture. Pick the topmost unlocked item
      // directly rather than forwarding a synthetic pointer event (which
      // could begin a pan or lasso drag).
      if (store.activeTool === 'hand') {
        const point = pointerHandler.pagePointForEvent(e, canvas);
        const hit = selectionManager.findAnnotationAtPoint(
          point, store.activeDocument?.annotations[pageIndex] || []
        );
        if (hit) {
          store.setActiveTool('select');
          store.selectAnnotation(hit.id);
          onRepaint();
          return;
        }
      }
      // Toggle: zoomed out → 200% at click; zoomed in → fit width.
      if (store.zoom < 1.5) {
        this.zoomAtPoint(2.0 / Math.max(store.zoom, MIN_ZOOM), { x: e.clientX, y: e.clientY });
      } else {
        viewportManager.fitToWidth();
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      if (!store.activeDocument || pointerHandler.isPointerDown) return;
      // A pending zoom preview must settle first so hit-testing uses layout
      // coordinates rather than CSS-transformed visual coordinates.
      if (this._zoomPreviewActive) this.commitZoomPreview();
      const handled = this._annotationMenu.handleCanvasContextMenu(e, {
        pageIndex,
        point: pointerHandler.pagePointForEvent(e, canvas),
        onRepaint
      });
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
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

  /**
   * System clipboard → page: pasting an image copied anywhere (browser,
   * screenshot tool, image editor) drops it onto the active page as a
   * resizable image annotation, one undo step.
   */
  private setupClipboardImagePaste() {
    window.addEventListener('paste', (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Text fields keep their native paste behavior.
      if (target && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)) return;
      if (!store.activeDocument) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : '';
          if (!dataUrl) return;
          const probe = new Image();
          probe.onload = () => {
            stampTool.primeImage(dataUrl, probe);
            this.insertPastedImage(dataUrl, probe.naturalWidth, probe.naturalHeight);
          };
          probe.onerror = () => showToast('Could not read pasted image', 'error');
          probe.src = dataUrl;
        };
        reader.readAsDataURL(file);
        return; // First image wins; ignore other clipboard flavors.
      }
    });
  }

  /** Places a pasted image centered on the active page, sized to fit. */
  private insertPastedImage(dataUrl: string, pixelWidth: number, pixelHeight: number): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const pageIndex = store.activePageIndex;
    const page = doc.pages?.[pageIndex];
    const pageWidth = page?.width ?? 612;
    const pageHeight = page?.height ?? 792;

    // CSS pixels → PDF points (96dpi → 72dpi), then cap to 60% of the page so
    // large screenshots land as a manageable, still-resizable size.
    let width = pixelWidth * 0.75;
    let height = pixelHeight * 0.75;
    const fit = Math.min(1, (pageWidth * 0.6) / width, (pageHeight * 0.6) / height);
    width *= fit;
    height *= fit;

    const annotation = stampTool.createCustomImageStamp(
      { x: pageWidth / 2, y: pageHeight / 2 },
      pageIndex,
      'layer-default',
      dataUrl,
      width,
      height
    );
    history.execute(new AddAnnotationCommand(pageIndex, annotation));
    store.setActiveTool('select');
    store.selectAnnotation(annotation.id);
    this.repaintAllRenderedAnnotations();
    showToast('Image pasted onto page', 'success');
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
    }, { capture: true });

    window.addEventListener('keydown', (e) => {
      // Don't trigger tool shortcuts when typing in inputs or contenteditable elements
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
        return;
      }

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
        // Mid-drag marquee/lasso first, then an active lens, then polygons/selection.
        if (pointerHandler.cancelZoomMarquee()) return;
        if (pointerHandler.cancelLasso()) { this.repaintAllRenderedAnnotations(); return; }
        if (store.zoomLensActive) {
          store.exitZoomLens();
          return;
        }
        pointerHandler.cancelPolygon();
        store.clearSelection();
        this.repaintAllRenderedAnnotations();
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
          void this.requestOpenFile();
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
        } else if (key === 'w') {
          e.preventDefault();
          const activeDoc = store.activeDocument;
          if (activeDoc) {
            if (isDocumentDirty(activeDoc.id)) {
              nativeConfirm('This document has unsaved changes. Close without saving?').then(ok => {
                if (ok) {
                  forgetFileHandle(activeDoc.id);
                  store.closeDocumentTab(activeDoc.id);
                }
              });
            } else {
              forgetFileHandle(activeDoc.id);
              store.closeDocumentTab(activeDoc.id);
            }
          }
          return;
        }
        return;
      }

      if (e.altKey) return;

      // Tool keys resolve through the user-configurable shortcut registry (shortcutManager)
      const shortcutTool = shortcutManager.actionForEvent(e);
      if (shortcutTool) {
        e.preventDefault();
        store.setActiveTool(shortcutTool);
        return;
      }

      const key = e.key.toLowerCase();

      // Arrow keys always operate on one clear target: current selection or document scroll
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault();
        const selectedIds = store.selectedAnnotationIds;
        const doc = store.activeDocument;
        const distance = e.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -distance : key === 'arrowright' ? distance : 0;
        const dy = key === 'arrowup' ? -distance : key === 'arrowdown' ? distance : 0;
        if (doc && selectedIds.size > 0) {
          for (const [pageKey, annotations] of Object.entries(doc.annotations)) {
            const pairs = annotations
              .filter(annotation => selectedIds.has(annotation.id) && !annotation.locked)
              .map(annotation => ({
                prev: annotation,
                next: transformAnnotation(annotation, {
                  dx, dy, scaleX: 1, scaleY: 1, originX: 0, originY: 0
                })
              }));
            if (pairs.length) history.execute(new BulkModifyCommand(Number(pageKey), pairs));
          }
          this.repaintAllRenderedAnnotations();
        } else {
          this._scrollContainer.scrollBy({ left: dx * 32, top: dy * 32, behavior: 'auto' });
        }
        return;
      }

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

      // Non-tool shortcuts
      if (key === 'k') store.setSignatureModalOpen(true);
      else if (key === 'n') {
        store.setActiveTool('scratchpad');
        store.setScratchpadOpen(true);
      }
      else if (key === 'f') store.toggleFocusMode();
      else if (key === '?') store.setShortcutsModalOpen(true);
      else if (key === '0') viewportManager.fitToWidth();
    }, { capture: true });
  }

  /**
   * Desktop window-close gate: flushes every open document's last-known
   * position, then asks before quitting if anything is unsaved. Returning
   * false cancels the OS close request.
   */
  private async confirmAppClose(): Promise<boolean> {
    for (const doc of store.openDocuments.values()) {
      await flushDocPosition(doc);
    }
    const dirty = [...store.openDocuments.values()].filter(doc => isDocumentDirty(doc.id));
    if (dirty.length === 0) return true;
    const names = dirty.map(d => d.name).join(', ');
    const message = dirty.length > 1
      ? `You have unsaved changes in ${dirty.length} documents (${names}). Quit without saving?`
      : `"${names}" has unsaved changes. Quit without saving?`;
    return nativeConfirm(message, 'Unsaved changes');
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
