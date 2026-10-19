/**
 * veditor - World-Class PDF Editor & Annotator
 * Main Application Bootstrap
 */

import { store } from './core/store';
import { pdfEngine } from './core/pdf-engine';
import { viewportManager, rotatedPageSize } from './core/viewport';
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
import { resolveAdaptiveCanvasDpr } from './utils/dpi';
import { t } from './ui/i18n';
import { LandingPageComponent } from './ui/components/landing-page';
import { initAppearanceSync } from './ui/theme';
import { drawingCursorValue } from './ui/cursor';
import { history, AddAnnotationCommand, DeleteAnnotationsCommand, ModifyAnnotationCommand, BulkModifyCommand } from './core/history';
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


declare global {
  interface Window {
    app?: VeditorApp;
  }
}
class VeditorApp {
  private _scrollContainer: HTMLElement;
  private _pagesWrapper: HTMLElement;
  private _emptyStateView: HTMLElement;
  private _fileInput: HTMLInputElement;
  private _renderedPages: Map<number, {
    container: HTMLElement;
    pdfCanvas: HTMLCanvasElement;
    chunkCanvas?: HTMLCanvasElement;
    annotCanvas: HTMLCanvasElement;
    annotChunkCanvas?: HTMLCanvasElement;
    scratchCanvas: HTMLCanvasElement;
    scratchChunkCanvas?: HTMLCanvasElement;
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

  private _zoomCommitTimer: number | null = null;
  private _chunkUpdateTimer: number | null = null;
  private _fastScrollTimer: number | null = null;
  private _isFastScrolling: boolean = false;
  private _lastScrollTop: number = 0;
  private _lastScrollLeft: number = 0;
  private _lastScrollTime: number = 0;
  private _previewRafId: number | null = null;
  private _previewPendingFactor: number = 1;
  private _previewPendingCenter: { x: number; y: number } | null = null;
  private _isZoomGestureActive: boolean = false;

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
    this._scrollContainer.style.overflowAnchor = 'none';
    this._scrollContainer.style.scrollBehavior = 'auto';
    this._emptyStateView = document.getElementById('empty-state-view') as HTMLElement;

    // Create hidden file input for opening PDFs
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'application/pdf';
    this._fileInput.style.display = 'none';
    document.body.appendChild(this._fileInput);
    window.app = this;

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
    new ToolbarComponent(
      document.getElementById('app-floating-toolbar') as HTMLElement
    );
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
      if (store.isDocSwitching) return;
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
            savedScrollLeft: session.savedScrollLeft,
            annotations: session.annotations
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
            savedScrollLeft: session.savedScrollLeft,
            annotations: session.annotations
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
        savedScrollLeft: existing.savedScrollLeft,
        annotations: existing.annotations
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
    initialState?: {
      activePageIndex?: number;
      savedScrollTop?: number;
      savedScrollLeft?: number;
      annotations?: DocumentSession['annotations'];
    },
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
      const baseAnnotations = existingSession?.annotations || initialState?.annotations;
      const importedAnnotations: DocumentSession['annotations'] = baseAnnotations
        ? { ...baseAnnotations }
        : {};

      // Only parse native annotations on brand-new document opens, never when
      // restoring an existing session whose annotations are already persisted.
      if (!baseAnnotations) {
        for (const { pageIndex, annotation } of await pdfEngine.extractNativeAnnotations(masterBytes)) {
          const list = (importedAnnotations[pageIndex] ??= []);
          if (!list.some(a => a.id === annotation.id)) {
            list.push(annotation);
          }
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
        // Apply the user's default zoom (defaults to fitWidth).
        this.applyDefaultZoomMode();
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
    for (const [pageIndex, p] of this._renderedPages) {
      pdfEngine.cancelPageRender(pageIndex);
      p.pdfCanvas.width = 0; p.pdfCanvas.height = 0;
      if (p.chunkCanvas) {
        p.chunkCanvas.width = 0; p.chunkCanvas.height = 0;
      }
      p.annotCanvas.width = 0; p.annotCanvas.height = 0;
      if (p.annotChunkCanvas) {
        p.annotChunkCanvas.width = 0; p.annotChunkCanvas.height = 0;
      }
      p.scratchCanvas.width = 0; p.scratchCanvas.height = 0;
      if (p.scratchChunkCanvas) {
        p.scratchChunkCanvas.width = 0; p.scratchChunkCanvas.height = 0;
      }
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

  private previewZoomBy(factor: number, centerClient: { x: number; y: number }): void {
    if (!store.activeDocument) return;
    if (!Number.isFinite(factor) || factor <= 0) return;

    this._previewPendingFactor *= factor;
    this._previewPendingCenter = { x: centerClient.x, y: centerClient.y };
    if (this._previewRafId === null) {
      this._previewRafId = window.requestAnimationFrame(() => this.flushPreviewZoom());
    }
    this.scheduleZoomCommit();
  }

  /**
   * Phase 1 of Two-Phase Live Zoom: updates page container CSS sizes and
   * focal-anchored scroll offsets once per animation frame while keeping
   * existing canvas bitmaps stretched via CSS (`_isZoomGestureActive = true`).
   * Zero canvas buffer reallocations, zero blanking of annotations/PDF, and
   * zero oversized wrapper texture layers.
   */
  private flushPreviewZoom(): void {
    this._previewRafId = null;
    const factor = this._previewPendingFactor;
    const center = this._previewPendingCenter;
    this._previewPendingFactor = 1;
    this._previewPendingCenter = null;
    if (!store.activeDocument || !center || pointerHandler.isPointerDown || this._handPan) return;

    this._isZoomGestureActive = true;
    const rect = this._scrollContainer.getBoundingClientRect();
    const cx = center.x - rect.left;
    const cy = center.y - rect.top;
    viewportManager.zoomByFactor(factor, { x: cx, y: cy });
  }

  private scheduleZoomCommit(): void {
    if (this._zoomCommitTimer !== null) window.clearTimeout(this._zoomCommitTimer);
    // Commit shortly after the last tick/finger move: resizes backing stores
    // once and renders crisp PDF + High-DPI Viewport Chunk.
    this._zoomCommitTimer = window.setTimeout(() => this.commitZoomPreview(), 150);
  }

  /** Drops any in-flight pinch/trackpad preview so a tab switch starts 1:1. */
  private resetZoomPreviewState(): void {
    if (this._zoomCommitTimer !== null) {
      window.clearTimeout(this._zoomCommitTimer);
      this._zoomCommitTimer = null;
    }
    if (this._chunkUpdateTimer !== null) {
      window.clearTimeout(this._chunkUpdateTimer);
      this._chunkUpdateTimer = null;
    }
    if (this._fastScrollTimer !== null) {
      window.clearTimeout(this._fastScrollTimer);
      this._fastScrollTimer = null;
    }
    this._isFastScrolling = false;
    if (this._previewRafId !== null) {
      window.cancelAnimationFrame(this._previewRafId);
      this._previewRafId = null;
    }
    this._previewPendingFactor = 1;
    this._previewPendingCenter = null;
    this._isZoomGestureActive = false;
    if (this._pagesWrapper) {
      this._pagesWrapper.style.transform = '';
      this._pagesWrapper.style.transformOrigin = '';
    }
    viewportManager.setPreviewScale(1);
  }

  /**
   * Phase 2 of Two-Phase Live Zoom: exits gesture-stretch mode and executes a
   * single crisp backing-store resize + synchronous annotation repaint +
   * double-buffered PDF & High-DPI Viewport Chunk render.
   */
  private commitZoomPreview(): void {
    if (this._zoomCommitTimer !== null) {
      window.clearTimeout(this._zoomCommitTimer);
      this._zoomCommitTimer = null;
    }
    if (this._previewRafId !== null) {
      window.cancelAnimationFrame(this._previewRafId);
      this._previewRafId = null;
      this.flushPreviewZoom();
    }
    if (!this._isZoomGestureActive) {
      return;
    }
    this._isZoomGestureActive = false;
    viewportManager.handleScroll(true);
  }

  private scheduleChunkUpdate(delayMs: number = 85): void {
    if (this._chunkUpdateTimer !== null) {
      window.clearTimeout(this._chunkUpdateTimer);
    }
    this._chunkUpdateTimer = window.setTimeout(() => {
      this._chunkUpdateTimer = null;
      this.updateVisiblePageChunks(true, false);
    }, delayMs);
  }

  /**
   * Returns true if the given chunk canvas already covers the currently visible
   * viewport portion of `container` with at least `marginPx` safety margin.
   * Prevents redundant chunk shifts and repaints on small scroll increments.
   */
  private doesChunkCoverViewport(
    chunk: HTMLCanvasElement | undefined,
    container: HTMLElement,
    layout: { width: number; height: number },
    marginPx: number = 48
  ): boolean {
    if (!chunk || chunk.style.display !== 'block' || chunk.width <= 1 || chunk.height <= 1) return false;
    if (!this._scrollContainer) return false;
    const baseZoom = parseFloat(chunk.dataset.baseZoom || '0');
    if (Math.abs(baseZoom - store.zoom) > 0.0005) return false;

    const cx = parseFloat(chunk.dataset.baseLeft || '0');
    const cy = parseFloat(chunk.dataset.baseTop || '0');
    const cw = parseFloat(chunk.dataset.baseWidth || '0');
    const ch = parseFloat(chunk.dataset.baseHeight || '0');
    if (cw <= 8 || ch <= 8) return false;

    const scrollRect = this._scrollContainer.getBoundingClientRect();
    const pageRect = container.getBoundingClientRect();
    if (scrollRect.width <= 0 || scrollRect.height <= 0 || pageRect.width <= 0 || pageRect.height <= 0) {
      return false;
    }

    const visX0 = Math.max(0, scrollRect.left - pageRect.left);
    const visY0 = Math.max(0, scrollRect.top - pageRect.top);
    const visX1 = Math.min(layout.width, scrollRect.right - pageRect.left);
    const visY1 = Math.min(layout.height, scrollRect.bottom - pageRect.top);
    if (visX1 <= visX0 || visY1 <= visY0) return false;

    const reqX0 = Math.max(0, visX0 - marginPx);
    const reqY0 = Math.max(0, visY0 - marginPx);
    const reqX1 = Math.min(layout.width, visX1 + marginPx);
    const reqY1 = Math.min(layout.height, visY1 + marginPx);

    return (
      cx <= reqX0 + 2 &&
      cy <= reqY0 + 2 &&
      cx + cw >= reqX1 - 2 &&
      cy + ch >= reqY1 - 2
    );
  }

  /**
   * Computes a CONSTANT-SIZE viewport chunk rectangle (padded by 192 CSS px)
   * for a visible page container. Keeping `width` and `height` constant across
   * the entire page while scrolling ensures the canvas backing store (`width`,
   * `height`) is allocated ONCE and never reallocated as the user scrolls near
   * the top or bottom edge of a page.
   */
  private computePageViewportChunkRect(
    container: HTMLElement,
    layout: { top: number; left: number; width: number; height: number }
  ): { x: number; y: number; width: number; height: number } | null {
    if (!this._scrollContainer) return null;
    const pad = 192;
    const pageW = Math.max(1, Math.ceil(layout.width));
    const pageH = Math.max(1, Math.ceil(layout.height));
    const scrollRect = this._scrollContainer.getBoundingClientRect();
    const pageRect = container.getBoundingClientRect();

    let viewW: number;
    let viewH: number;
    let relLeft: number;
    let relTop: number;

    if (scrollRect.width > 0 && scrollRect.height > 0 && pageRect.width > 0 && pageRect.height > 0) {
      viewW = scrollRect.width;
      viewH = scrollRect.height;
      relLeft = scrollRect.left - pageRect.left;
      relTop = scrollRect.top - pageRect.top;
    } else {
      viewW = this._scrollContainer.clientWidth;
      viewH = this._scrollContainer.clientHeight;
      if (viewW <= 0 || viewH <= 0) return null;
      relLeft = this._scrollContainer.scrollLeft - layout.left;
      relTop = this._scrollContainer.scrollTop - layout.top;
    }

    // First verify the page actually intersects the visible viewport
    const visX0 = Math.max(0, relLeft);
    const visY0 = Math.max(0, relTop);
    const visX1 = Math.min(pageW, relLeft + viewW);
    const visY1 = Math.min(pageH, relTop + viewH);
    if (visX1 - visX0 <= 4 || visY1 - visY0 <= 4) {
      return null;
    }

    // Constant window dimensions independent of scroll offset
    const cw = Math.min(pageW, Math.ceil(viewW + pad * 2));
    const ch = Math.min(pageH, Math.ceil(viewH + pad * 2));
    if (cw <= 8 || ch <= 8) return null;

    const maxX = Math.max(0, pageW - cw);
    const maxY = Math.max(0, pageH - ch);
    const rawX = Math.round((relLeft - pad) / 16) * 16;
    const rawY = Math.round((relTop - pad) / 16) * 16;
    const ix0 = Math.max(0, Math.min(maxX, rawX));
    const iy0 = Math.max(0, Math.min(maxY, rawY));

    return { x: ix0, y: iy0, width: cw, height: ch };
  }

  /**
   * High-DPI Viewport Chunk coordinator: for any visible page at high zoom
   * (where the full-page base canvas hits the VRAM budget cap), computes the
   * exact intersection of the page with the scroll container's viewport and
   * renders ONLY that visible rectangle at 100% native DPI.
   */
  private updateVisiblePageChunks(renderPdfRaster: boolean = true, forceUpdate: boolean = false): void {
    if (this._isZoomGestureActive || store.isDocSwitching || store.isZoomAdjusting) return;
    const doc = store.activeDocument;
    if (!doc || !this._scrollContainer) return;

    for (const [pageIndex, p] of this._renderedPages) {
      // Never shift or resize the active page's chunk while a stroke is in flight
      if (pointerHandler.isPointerDown && pageIndex === pointerHandler.activePageIndex) {
        continue;
      }

      const chunkCanvas = p.chunkCanvas;
      if (!chunkCanvas) continue;
      const layout = viewportManager.getLayout(pageIndex);
      const rot = store.pageRotations[pageIndex] || 0;
      if (!layout || !pdfEngine.needsViewportChunk(pageIndex, store.zoom, rot)) {
        pdfEngine.cancelPageChunkRender(pageIndex);
        if (chunkCanvas.style.display !== 'none') {
          chunkCanvas.style.display = 'none';
          chunkCanvas.width = 0;
          chunkCanvas.height = 0;
          delete chunkCanvas.dataset.chunkKey;
        }
        if (p.annotChunkCanvas && p.annotChunkCanvas.style.display !== 'none') {
          p.annotChunkCanvas.style.display = 'none';
          p.annotChunkCanvas.width = 0;
          p.annotChunkCanvas.height = 0;
          delete p.annotChunkCanvas.dataset.annotKey;
        }
        if (p.scratchChunkCanvas && p.scratchChunkCanvas.style.display !== 'none') {
          p.scratchChunkCanvas.style.display = 'none';
          p.scratchChunkCanvas.width = 0;
          p.scratchChunkCanvas.height = 0;
        }
        if (layout && !this._isFastScrolling) {
          const dpr = resolveAdaptiveCanvasDpr(layout.width, layout.height, store.appSettings.targetDPI);
          const w = Math.max(1, Math.round(layout.width * dpr));
          const h = Math.max(1, Math.round(layout.height * dpr));
          if (p.annotCanvas.width !== w || p.annotCanvas.height !== h || p.annotCanvas.style.opacity !== '') {
            if (p.annotCanvas.width !== w || p.annotCanvas.height !== h) {
              p.annotCanvas.width = w;
              p.annotCanvas.height = h;
            }
            p.annotCanvas.style.opacity = '';
            this.repaintPageAnnotations(pageIndex, p);
          }
        } else if (p.annotCanvas.style.opacity !== '') {
          p.annotCanvas.style.opacity = '';
        }
        continue;
      }

      const chunkRect = this.computePageViewportChunkRect(p.container, layout);
      if (!chunkRect) {
        pdfEngine.cancelPageChunkRender(pageIndex);
        if (chunkCanvas.style.display !== 'none') {
          chunkCanvas.style.display = 'none';
          chunkCanvas.width = 0;
          chunkCanvas.height = 0;
          delete chunkCanvas.dataset.chunkKey;
        }
        if (p.annotChunkCanvas && p.annotChunkCanvas.style.display !== 'none') {
          p.annotChunkCanvas.style.display = 'none';
          p.annotChunkCanvas.width = 0;
          p.annotChunkCanvas.height = 0;
          delete p.annotChunkCanvas.dataset.annotKey;
        }
        if (p.scratchChunkCanvas && p.scratchChunkCanvas.style.display !== 'none') {
          p.scratchChunkCanvas.style.display = 'none';
          p.scratchChunkCanvas.width = 0;
          p.scratchChunkCanvas.height = 0;
        }
        continue;
      }

      if (this._isFastScrolling && !forceUpdate) {
        continue;
      }

      const annotCovered = !forceUpdate && this.doesChunkCoverViewport(p.annotChunkCanvas, p.container, layout, 48);
      if (!annotCovered) {
        this.updateAnnotationChunkGeometry(pageIndex, p, chunkRect, false);
      }

      if (renderPdfRaster) {
        const pdfCovered = !forceUpdate && this.doesChunkCoverViewport(chunkCanvas, p.container, layout, 48);
        if (!pdfCovered) {
          void pdfEngine.renderPageChunkToCanvas(pageIndex, chunkCanvas, store.zoom, rot, chunkRect);
        }
      }
    }
  }

  /**
   * High-DPI Vector Annotation & Scratchpad Chunk: positions and sizes the
   * viewport-clipped annotation and scratchpad canvases at 100% native display
   * DPI so handwriting, shapes, and text remain razor-sharp at up to 800% zoom.
   */
  private updateAnnotationChunkGeometry(
    pageIndex: number,
    p: {
      annotCanvas: HTMLCanvasElement;
      annotChunkCanvas?: HTMLCanvasElement;
      scratchCanvas: HTMLCanvasElement;
      scratchChunkCanvas?: HTMLCanvasElement;
    },
    chunkRect: { x: number; y: number; width: number; height: number },
    allocateScratch: boolean = false
  ): void {
    const annotChunk = p.annotChunkCanvas;
    const scratchChunk = p.scratchChunkCanvas;
    if (!annotChunk || !scratchChunk) return;

    const nativeDpr = resolveAdaptiveCanvasDpr(
      chunkRect.width,
      chunkRect.height,
      Math.max(store.appSettings.targetDPI || 200, 200)
    );
    const pw = Math.max(1, Math.round(chunkRect.width * nativeDpr));
    const ph = Math.max(1, Math.round(chunkRect.height * nativeDpr));

    const isStrokeOnPage = pointerHandler.isPointerDown && pageIndex === pointerHandler.activePageIndex;
    const targets = isStrokeOnPage ? [annotChunk] : [annotChunk, scratchChunk];

    for (const c of targets) {
      c.style.left = `${chunkRect.x}px`;
      c.style.top = `${chunkRect.y}px`;
      c.style.width = `${chunkRect.width}px`;
      c.style.height = `${chunkRect.height}px`;
      c.style.display = 'block';
      c.dataset.baseZoom = String(store.zoom);
      c.dataset.baseLeft = String(chunkRect.x);
      c.dataset.baseTop = String(chunkRect.y);
      c.dataset.baseWidth = String(chunkRect.width);
      c.dataset.baseHeight = String(chunkRect.height);
      c.dataset.offsetX = String(chunkRect.x);
      c.dataset.offsetY = String(chunkRect.y);
    }

    if (!isStrokeOnPage) {
      const needScratch = allocateScratch || pointerHandler.isPolygonActiveOnPage(pageIndex);
      if (needScratch) {
        if (scratchChunk.width !== pw || scratchChunk.height !== ph) {
          scratchChunk.width = pw;
          scratchChunk.height = ph;
        }
      } else if (scratchChunk.width > 1 || scratchChunk.height > 1) {
        scratchChunk.width = 0;
        scratchChunk.height = 0;
      }
      if (p.scratchCanvas.width > 1 || p.scratchCanvas.height > 1) {
        p.scratchCanvas.width = 0;
        p.scratchCanvas.height = 0;
      }
    }

    // Collapse the hidden full-page annotation canvas underneath so it uses 0 VRAM
    // at high zoom and never double-composites translucent highlighters.
    p.annotCanvas.style.opacity = '0';
    if (p.annotCanvas.width > 1 || p.annotCanvas.height > 1) {
      p.annotCanvas.width = 0;
      p.annotCanvas.height = 0;
    }

    const annotKey = `${store.zoom.toFixed(4)}|${chunkRect.x},${chunkRect.y},${pw},${ph}`;
    const sizeChanged = annotChunk.width !== pw || annotChunk.height !== ph;
    if (sizeChanged) {
      annotChunk.width = pw;
      annotChunk.height = ph;
    }
    if (sizeChanged || annotChunk.dataset.annotKey !== annotKey) {
      annotChunk.dataset.annotKey = annotKey;
      this.repaintAnnotationChunk(pageIndex, p);
    }
  }

  /**
   * Synchronously prepares the active page's scratchpad backing store and
   * High-DPI Viewport Chunk right on `pointerdown` before `pointerHandler`
   * starts a stroke. Guarantees 0ms chunk lag and 100% coordinate lock.
   */
  private preparePageForPointerDown(pageIndex: number): void {
    if (this._chunkUpdateTimer !== null) {
      window.clearTimeout(this._chunkUpdateTimer);
      this._chunkUpdateTimer = null;
    }
    const p = this._renderedPages.get(pageIndex);
    const layout = viewportManager.getLayout(pageIndex);
    if (!p || !layout) return;

    const rot = store.pageRotations[pageIndex] || 0;
    if (pdfEngine.needsViewportChunk(pageIndex, store.zoom, rot)) {
      const chunkRect = this.computePageViewportChunkRect(p.container, layout);
      if (chunkRect) {
        this.updateAnnotationChunkGeometry(pageIndex, p, chunkRect, true);
        if (p.chunkCanvas) {
          void pdfEngine.renderPageChunkToCanvas(pageIndex, p.chunkCanvas, store.zoom, rot, chunkRect);
        }
        return;
      }
    }

    if (p.scratchChunkCanvas && p.scratchChunkCanvas.style.display !== 'none') {
      p.scratchChunkCanvas.style.display = 'none';
      p.scratchChunkCanvas.width = 1;
      p.scratchChunkCanvas.height = 1;
    }
    const dpr = resolveAdaptiveCanvasDpr(layout.width, layout.height, store.appSettings.targetDPI);
    const w = Math.max(1, Math.round(layout.width * dpr));
    const h = Math.max(1, Math.round(layout.height * dpr));
    if (p.scratchCanvas.width !== w || p.scratchCanvas.height !== h) {
      p.scratchCanvas.width = w;
      p.scratchCanvas.height = h;
    }
    delete p.scratchCanvas.dataset.offsetX;
    delete p.scratchCanvas.dataset.offsetY;
  }

  /**
   * Releases the temporary scratchpad backing store back to 1x1 once a stroke
   * finishes so idle pages consume 0 bytes of scratchpad VRAM.
   */
  private releasePageScratchpad(pageIndex: number): void {
    if (pointerHandler.isPolygonActiveOnPage(pageIndex)) return;
    const p = this._renderedPages.get(pageIndex);
    if (!p) return;
    if (p.scratchCanvas.width !== 1 || p.scratchCanvas.height !== 1) {
      p.scratchCanvas.width = 1;
      p.scratchCanvas.height = 1;
    }
    if (p.scratchChunkCanvas && (p.scratchChunkCanvas.width !== 1 || p.scratchChunkCanvas.height !== 1)) {
      p.scratchChunkCanvas.width = 1;
      p.scratchChunkCanvas.height = 1;
    }
  }

  private repaintAnnotationChunk(
    pageIndex: number,
    p: { annotCanvas: HTMLCanvasElement; annotChunkCanvas?: HTMLCanvasElement }
  ): void {
    const chunk = p.annotChunkCanvas;
    if (!chunk || chunk.style.display !== 'block' || chunk.width <= 1 || chunk.height <= 1) return;
    const baseW = parseFloat(chunk.dataset.baseWidth || '') || parseFloat(chunk.style.width) || chunk.width;
    const baseZoom = parseFloat(chunk.dataset.baseZoom || '') || store.zoom;
    const dpr = baseW > 0 ? chunk.width / baseW : 1;
    const scale = baseZoom * dpr;
    const ox = parseFloat(chunk.dataset.offsetX || '0');
    const oy = parseFloat(chunk.dataset.offsetY || '0');

    const ctx = chunk.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, chunk.width, chunk.height);

    ctx.save();
    ctx.translate(-ox * dpr, -oy * dpr);

    const layout = viewportManager.getLayout(pageIndex);
    const fullW = layout ? Math.round((layout.width / Math.max(store.zoom, 0.0001)) * scale) : chunk.width;
    const fullH = layout ? Math.round((layout.height / Math.max(store.zoom, 0.0001)) * scale) : chunk.height;

    annotationEngine.renderBackgroundPattern(
      ctx,
      fullW,
      fullH,
      notebookController.isNotebook() ? 'none' : store.appSettings.backgroundPattern,
      scale,
      store.appSettings.gridSize
    );

    annotationEngine.renderAnnotationsToCanvas(ctx, pageIndex, scale);

    const doc = store.activeDocument;
    if (doc) {
      const pageAnns = doc.annotations[pageIndex] || [];
      const selected = pageAnns.filter(a => store.selectedAnnotationIds.has(a.id));
      if (selected.length > 0) {
        selectionManager.render(ctx, selected, scale);
      }
    }

    ctx.restore();
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
    this.commitZoomPreview();
    if (pointerHandler.isPointerDown || this._handPan) return;
    const rect = this._scrollContainer.getBoundingClientRect();
    viewportManager.zoomByFactor(factor, { x: client.x - rect.left, y: client.y - rect.top });
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

    // Refresh High-DPI Viewport Chunk when panning/scrolling at high zoom:
    // deadzone hysteresis avoids reallocating or repainting chunks while the
    // visible screen stays inside the padded chunk window, and fast-scroll
    // detection pauses heavy rasterization for intermediate pages flying by.
    this._scrollContainer.addEventListener('scroll', () => {
      if (!this._isZoomGestureActive && store.activeDocument) {
        const now = performance.now();
        const st = this._scrollContainer.scrollTop;
        const sl = this._scrollContainer.scrollLeft;
        const dt = Math.max(1, now - this._lastScrollTime);
        const dist = Math.abs(st - this._lastScrollTop) + Math.abs(sl - this._lastScrollLeft);
        this._lastScrollTop = st;
        this._lastScrollLeft = sl;
        this._lastScrollTime = now;

        if (dist > 110 || (dt < 80 && dist / dt > 2.2)) {
          this._isFastScrolling = true;
          if (this._fastScrollTimer !== null) {
            window.clearTimeout(this._fastScrollTimer);
          }
          this._fastScrollTimer = window.setTimeout(() => {
            this._fastScrollTimer = null;
            this._isFastScrolling = false;
            if (store.activeDocument && !store.isDocSwitching) {
              viewportManager.handleScroll(true);
              this.updateVisiblePageChunks(true, false);
            }
          }, 110);
        } else if (!this._isFastScrolling) {
          this.updateVisiblePageChunks(false, false);
          this.scheduleChunkUpdate(85);
        }
      }
    }, { passive: true });

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

    // PIPE_3: VRAM Pool OOM Guard - Evict pages outside the visible window
    // At high zoom (> 1.8x), evict immediately (maxKeepDistance = 0) to protect VRAM.
    const maxKeepDistance = store.zoom > 1.8 ? 0 : 1;
    for (const [pageIndex, p] of this._renderedPages) {
      if (store.activeDocument?.id !== docId || store.isDocSwitching) return;
      let minDistance = Infinity;
      for (const v of visibleIndices) {
        const d = Math.abs(pageIndex - v);
        if (d < minDistance) minDistance = d;
      }

      if (minDistance > maxKeepDistance && p.scratchCanvas !== this._handPan?.canvas &&
          !(pointerHandler.isPointerDown && pageIndex === store.activePageIndex)) {
        pdfEngine.cancelPageRender(pageIndex);
        // Explicitly collapse backing stores to 0x0 to release VRAM buffers immediately
        p.pdfCanvas.width = 0; p.pdfCanvas.height = 0;
        if (p.chunkCanvas) {
          p.chunkCanvas.width = 0; p.chunkCanvas.height = 0;
        }
        p.annotCanvas.width = 0; p.annotCanvas.height = 0;
        if (p.annotChunkCanvas) {
          p.annotChunkCanvas.width = 0; p.annotChunkCanvas.height = 0;
        }
        p.scratchCanvas.width = 0; p.scratchCanvas.height = 0;
        if (p.scratchChunkCanvas) {
          p.scratchChunkCanvas.width = 0; p.scratchChunkCanvas.height = 0;
        }

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
        const container = document.createElement('div');
        container.className = 'pdf-page-container';
        container.dataset.pageIndex = String(pageIndex);
        container.dataset.docId = docId;

        const pdfCanvas = document.createElement('canvas');
        pdfCanvas.className = 'pdf-page-canvas';
        pdfCanvas.dataset.pageIndex = String(pageIndex);
        pdfCanvas.dataset.docId = docId;

        const chunkCanvas = document.createElement('canvas');
        chunkCanvas.className = 'pdf-page-canvas pdf-chunk-canvas';
        chunkCanvas.dataset.pageIndex = String(pageIndex);
        chunkCanvas.dataset.docId = docId;

        const annotCanvas = document.createElement('canvas');
        annotCanvas.className = 'annotation-canvas';

        const annotChunkCanvas = document.createElement('canvas');
        annotChunkCanvas.className = 'annotation-canvas annot-chunk-canvas';

        const scratchCanvas = document.createElement('canvas');
        scratchCanvas.className = 'scratchpad-canvas';
        scratchCanvas.style.cursor = drawingCursorValue(
          store.activeTool,
          store.toolSettings.drawingCursor || 'pen',
          store.zoom
        );

        const scratchChunkCanvas = document.createElement('canvas');
        scratchChunkCanvas.className = 'scratch-chunk-canvas';
        (scratchCanvas as HTMLCanvasElement & { _chunkCanvas?: HTMLCanvasElement })._chunkCanvas = scratchChunkCanvas;

        container.appendChild(pdfCanvas);
        container.appendChild(chunkCanvas);
        container.appendChild(annotCanvas);
        container.appendChild(annotChunkCanvas);
        container.appendChild(scratchCanvas);
        container.appendChild(scratchChunkCanvas);

        this._pagesWrapper.appendChild(container);

        pageElements = {
          container,
          pdfCanvas,
          chunkCanvas,
          annotCanvas,
          annotChunkCanvas,
          scratchCanvas,
          scratchChunkCanvas
        };
        this._renderedPages.set(pageIndex, pageElements);

        // Bind Pointer Events to scratchpad canvas
        this.bindPointerEvents(scratchCanvas, pageIndex);
      }
    }

    // 3. Geometry pass over EVERY mounted page. Retained pages outside the
    // visible set are still positioned and sized here; leaving them at the
    // previous zoom's top/size is what painted stale pages on top of the
    // corrected ones after a zoom ("everything mixes together").
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

    // While an interactive wheel/pinch zoom gesture is in flight, existing
    // canvas bitmaps are stretched via CSS width/height with zero re-raster
    // or canvas clearing; commitZoomPreview() runs the crisp pass once settled.
    if (this._isZoomGestureActive) {
      for (const [pageIndex, p] of Array.from(this._renderedPages.entries())) {
        if (!docStillCurrent()) return;
        // Only paint newly mounted pages that had no prior bitmap at all
        if (p.needsRepaint) {
          p.needsRepaint = false;
          this.repaintPageAnnotations(pageIndex, p);
        }
        if (p.needsRaster && p.pdfCanvas.width <= 300) {
          p.needsRaster = false;
          const rot = store.pageRotations[pageIndex] || 0;
          void pdfEngine.renderPageToCanvas(pageIndex, p.pdfCanvas, store.zoom, rot);
        }
      }
      return;
    }

    // Update High-DPI Viewport Chunks synchronously right in the layout/render pass
    // (unless fast-scrolling across pages, which settles after 110ms).
    if (!this._isFastScrolling) {
      this.updateVisiblePageChunks(true, false);
    }

    // 4. Render pass: rasterise and repaint. Visible pages always repaint;
    // pages whose backing stores were just resized repaint exactly once, and
    // the PDF raster is only regenerated for a page that is on screen.
    for (const [pageIndex, p] of Array.from(this._renderedPages.entries())) {
      if (!docStillCurrent()) return;
      const isVisible = visibleSet.has(pageIndex);

      if (isVisible) {
        // During rapid flick-scrolling, skip starting brand-new PDF.js renders
        // for intermediate pages that aren't already cached; the 110ms settle
        // timer will render the destination pages as soon as scroll decelerates.
        if (p.needsRaster && (!this._isFastScrolling || pdfEngine.hasCachedBitmap(pageIndex))) {
          p.needsRaster = false;
          const rot = store.pageRotations[pageIndex] || 0;
          void pdfEngine.renderPageToCanvas(pageIndex, p.pdfCanvas, store.zoom, rot);
        }
        if (!this._isFastScrolling) {
          p.needsRepaint = false;
          this.repaintPageAnnotations(pageIndex, p);
        }
      } else if (p.needsRepaint && !this._isFastScrolling) {
        p.needsRepaint = false;
        this.repaintPageAnnotations(pageIndex, p);
      }
    }
  }

  /**
   * Positions and sizes one mounted page from its viewport layout rect, and
   * flags the layers for regeneration when anything actually changed.
   */
  private applyPageGeometry(
    pageIndex: number,
    p: {
      container: HTMLElement;
      pdfCanvas: HTMLCanvasElement;
      chunkCanvas?: HTMLCanvasElement;
      annotCanvas: HTMLCanvasElement;
      annotChunkCanvas?: HTMLCanvasElement;
      scratchCanvas: HTMLCanvasElement;
      scratchChunkCanvas?: HTMLCanvasElement;
      geomKey?: string;
      needsRaster?: boolean;
      needsRepaint?: boolean;
    },
    layout: { top: number; left: number; width: number; height: number },
    docId: string
  ): void {
    const dpr = resolveAdaptiveCanvasDpr(
      layout.width,
      layout.height,
      store.appSettings.targetDPI
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

    // Scale any active High-DPI Viewport Chunks proportionally with the page
    // so they stay locked to their page region while zooming before the new chunk renders.
    for (const chunk of [p.chunkCanvas, p.annotChunkCanvas, p.scratchChunkCanvas]) {
      if (chunk && chunk.style.display === 'block') {
        const baseZoom = parseFloat(chunk.dataset.baseZoom || '0');
        if (baseZoom > 0) {
          const ratio = store.zoom / baseZoom;
          const bl = parseFloat(chunk.dataset.baseLeft || '0');
          const bt = parseFloat(chunk.dataset.baseTop || '0');
          const bw = parseFloat(chunk.dataset.baseWidth || '0');
          const bh = parseFloat(chunk.dataset.baseHeight || '0');
          chunk.style.left = `${bl * ratio}px`;
          chunk.style.top = `${bt * ratio}px`;
          chunk.style.width = `${bw * ratio}px`;
          chunk.style.height = `${bh * ratio}px`;
        }
      }
    }

    // ALWAYS update CSS width/height on annotation and scratchpad canvases so
    // they cover 100% of the page even when the pixel backing store hits the
    // adaptive VRAM ceiling!
    p.annotCanvas.style.width = `${layout.width}px`;
    p.annotCanvas.style.height = `${layout.height}px`;
    p.scratchCanvas.style.width = `${layout.width}px`;
    p.scratchCanvas.style.height = `${layout.height}px`;

    // During an active wheel/pinch zoom gesture, keep the existing canvas
    // backing stores intact (CSS stretches them smoothly with zero flicker)
    // unless this is a brand-new uninitialized page.
    if (this._isZoomGestureActive && p.geomKey !== undefined) {
      return;
    }

    const useChunk = pdfEngine.needsViewportChunk(pageIndex, store.zoom, rot);
    const w = Math.max(1, Math.round(layout.width * dpr));
    const h = Math.max(1, Math.round(layout.height * dpr));

    if (!useChunk && !this._isFastScrolling) {
      if (p.annotCanvas.width !== w || p.annotCanvas.height !== h) {
        p.annotCanvas.width = w;
        p.annotCanvas.height = h;
        p.needsRepaint = true;
      }
      if (p.annotCanvas.style.opacity !== '') {
        p.annotCanvas.style.opacity = '';
      }
    }

    // Keep idle scratchpad backing stores at 0x0 to save VRAM; allocated on-demand on pointerdown.
    const isStrokeOnPage = pointerHandler.isPointerDown && pageIndex === pointerHandler.activePageIndex;
    if (!isStrokeOnPage && !pointerHandler.isPolygonActiveOnPage(pageIndex)) {
      if (p.scratchCanvas.width > 1 || p.scratchCanvas.height > 1) {
        p.scratchCanvas.width = 0;
        p.scratchCanvas.height = 0;
      }
    }

    if (p.geomKey !== geomKey) {
      p.geomKey = geomKey;
      p.needsRaster = true;
      p.needsRepaint = true;
    }
  }

  private repaintPageAnnotations(
    pageIndex: number,
    p: {
      annotCanvas: HTMLCanvasElement;
      annotChunkCanvas?: HTMLCanvasElement;
      scratchCanvas: HTMLCanvasElement;
    }
  ) {
    // When the High-DPI Viewport Annotation Chunk is active, skip rendering onto
    // the hidden full-page annotCanvas underneath (saves 50% CPU and 100% full-page annotCanvas VRAM).
    if (p.annotChunkCanvas && p.annotChunkCanvas.style.display === 'block' && p.annotChunkCanvas.width > 1) {
      this.repaintAnnotationChunk(pageIndex, p);
      return;
    }

    const layout = viewportManager.getLayout(pageIndex);
    const cssW = layout ? layout.width : (parseFloat(p.annotCanvas.style.width) || p.annotCanvas.width);
    const baseW = cssW / Math.max(store.zoom, 0.0001);
    const scale = baseW > 0 && p.annotCanvas.width > 1
      ? p.annotCanvas.width / baseW
      : store.zoom * resolveAdaptiveCanvasDpr(cssW, layout ? layout.height : p.annotCanvas.height, store.appSettings.targetDPI);

    const annCtx = p.annotCanvas.getContext('2d');
    if (annCtx && p.annotCanvas.width > 1 && p.annotCanvas.height > 1) {
      annCtx.clearRect(0, 0, p.annotCanvas.width, p.annotCanvas.height);

      // 1. Background paper pattern (consolidated onto the single overlay canvas)
      annotationEngine.renderBackgroundPattern(
        annCtx,
        p.annotCanvas.width,
        p.annotCanvas.height,
        notebookController.isNotebook() ? 'none' : store.appSettings.backgroundPattern,
        scale,
        store.appSettings.gridSize
      );

      // 2. Committed Annotations & Selection Box
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
      this.commitZoomPreview();
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
      // Synchronously align the High-DPI Viewport Chunk and allocate the
      // scratchpad backing store BEFORE pointerHandler starts the stroke.
      this.preparePageForPointerDown(pageIndex);
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
        if (store.activeTool === 'polygon' && pointerHandler.isPolygonActiveOnPage(pageIndex)) {
          this.preparePageForPointerDown(pageIndex);
        }
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
      pointerHandler.handlePointerUp(e, pageIndex, canvas, onRepaint);
      this.releasePageScratchpad(pageIndex);
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
      this.releasePageScratchpad(pageIndex);
    });

    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const finished = pointerHandler.finishPolygon(pageIndex, 'layer-default', onRepaint);
      if (finished) {
        this.releasePageScratchpad(pageIndex);
        return;
      }

      // Double-clicking a TextAnnotation or StickyNoteAnnotation in Select, Hand, Text, or Sticky Note mode
      if (store.activeTool === 'select' || store.activeTool === 'hand' || store.activeTool === 'text' || store.activeTool === 'sticky-note') {
        const point = pointerHandler.pagePointForEvent(e, canvas);
        const hit = selectionManager.findAnnotationAtPoint(
          point, store.activeDocument?.annotations[pageIndex] || []
        );
        if (hit && hit.type === 'text') {
          store.setActiveTool('select');
          store.selectAnnotation(hit.id);
          pointerHandler.editExistingTextAnnotation(hit, pageIndex, canvas, onRepaint);
          return;
        }
        if (hit && hit.type === 'sticky-note') {
          store.setActiveTool('select');
          store.selectAnnotation(hit.id);
          if (hit.collapsed) {
            history.execute(new ModifyAnnotationCommand(pageIndex, hit, {
              ...hit,
              collapsed: false,
              updatedAt: Date.now()
            }));
            onRepaint();
          } else {
            const localY = point.y - hit.box.y;
            if (localY <= 40 || localY >= hit.box.height - 34) {
              pointerHandler.setStickyInkMode(null);
              history.execute(new ModifyAnnotationCommand(pageIndex, hit, {
                ...hit,
                collapsed: true,
                updatedAt: Date.now()
              }));
              onRepaint();
            } else {
              pointerHandler.editExistingStickyNote(hit, pageIndex, canvas, onRepaint);
            }
          }
          return;
        }
        if (hit && store.activeTool === 'hand') {
          store.setActiveTool('select');
          store.selectAnnotation(hit.id);
          onRepaint();
          return;
        }
      }

      if (store.activeTool !== 'hand') return;
      // Toggle: zoomed out → 200% at click; zoomed in → fit width.
      this.commitZoomPreview();
      if (pointerHandler.isPointerDown || this._handPan) return;
      // Toggle: zoomed out (at or below fit width) → zoom in; zoomed in → fit width.
      const doc = store.activeDocument;
      const activePage = doc?.pages[pageIndex] || doc?.pages[0];
      const baseW = activePage ? rotatedPageSize(activePage, store.pageRotations[pageIndex] || 0).width : 595;
      const containerW = this._scrollContainer.clientWidth - 64;
      const fitWidthZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerW / baseW));
      if (store.zoom <= fitWidthZoom + 0.05) {
        const targetZoom = Math.max(2.0, fitWidthZoom * 1.5);
        this.zoomAtPoint(targetZoom / Math.max(store.zoom, MIN_ZOOM), { x: e.clientX, y: e.clientY });
      } else {
        const rect = this._scrollContainer.getBoundingClientRect();
        viewportManager.fitToWidth({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      if (!store.activeDocument || pointerHandler.isPointerDown) return;
      // A pending zoom preview must settle first so hit-testing uses layout
      // coordinates rather than CSS-transformed visual coordinates.
      this.commitZoomPreview();
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
   * Zooms the view to fit a marquee-selected region.
   */
  public zoomToRect(pageIndex: number, rect: { x: number; y: number; width: number; height: number }): void {
    const doc = store.activeDocument;
    if (!doc) return;

    const availW = Math.max(50, this._scrollContainer.clientWidth - 48);
    const availH = Math.max(50, this._scrollContainer.clientHeight - 48);
    const rectW = Math.max(8, rect.width * store.zoom);
    const rectH = Math.max(8, rect.height * store.zoom);
    const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom * Math.min(availW / rectW, availH / rectH)));

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
        // Mid-drag marquee/lasso first, then polygons/selection.
        if (pointerHandler.cancelLasso()) { this.repaintAllRenderedAnnotations(); return; }
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

    let savedSessionId: string | null = null;
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        savedSessionId = sessionStorage.getItem('veditor:active-doc-id');
      }
    } catch (_) {}

    const targetDocId = docId || savedSessionId;
    if (targetDocId) {
      const session = await getDocumentSession(targetDocId);
      if (session && session.fileData) {
        await this.loadPDF(session.name, session.fileData, targetDocId, session.notebook, {
          activePageIndex: session.activePageIndex || 0,
          savedScrollTop: session.savedScrollTop,
          savedScrollLeft: session.savedScrollLeft,
          annotations: session.annotations
        });
        return;
      }
    }

    if (pdfUrl) {
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

// Bootstrap application when ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try {
      window.app = new VeditorApp();
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('FAILED TO INIT VEDITOR APP:', err);
      Object.assign(window, { __appError: err.message + '\n' + err.stack });
    }
  });
} else {
  try {
    window.app = new VeditorApp();
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('FAILED TO INIT VEDITOR APP:', err);
    Object.assign(window, { __appError: err.message + '\n' + err.stack });
  }
}
