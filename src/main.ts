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
import { CommandPaletteComponent } from './ui/components/command-palette';
import { ShortcutsModalComponent } from './ui/components/shortcuts-modal';
import { SettingsModalComponent } from './ui/components/settings-modal';
import { SignatureDialogComponent } from './ui/components/signature-dialog';
import { showToast } from './ui/components/toast';
import { openDocumentSession, getDocumentSession } from './io/storage';
import { selectionManager } from './annotations/selection';
import { mergeBoundingBoxes } from './utils/geometry';
import { t } from './ui/i18n';
import { LandingPageComponent } from './ui/components/landing-page';
import { initAppearanceSync } from './ui/theme';
import { drawingCursorValue } from './ui/cursor';
import { history } from './core/history';
import { DocumentSession, NotebookSpec } from './core/types';
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

  /**
   * Lag-free zoom preview: while pinching (touch or trackpad) the pages
   * wrapper is scaled with a compositor-only CSS transform around the focal
   * point — zero store updates, zero re-layouts, zero PDF re-renders, zero
   * annotation repaints. The real zoom commits once when the gesture ends.
   */
  private _zoomPreviewScale: number = 1;
  private _zoomPreviewActive: boolean = false;
  private _zoomCommitTimer: number | null = null;

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
      () => this._fileInput.click()
    );
    new ToolbarComponent(document.getElementById('app-floating-toolbar') as HTMLElement);
    new SidePanelsComponent(document.getElementById('app-sidebar') as HTMLElement);
    new PropertiesPanelComponent(document.getElementById('app-properties-panel') as HTMLElement);
    new ViewControlsComponent(document.getElementById('app-view-controls') as HTMLElement);

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
          // Carry the notebook spec through so a reopened notebook stays one.
          await this.loadPDF(session.name, session.fileData, docId, session.notebook);
        }
      }
    });
    landing.render();
  }

  private setupFileHandling() {
    this._fileInput.addEventListener('change', async () => {
      if (this._fileInput.files && this._fileInput.files[0]) {
        const file = this._fileInput.files[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.loadPDF(file.name, bytes);
      }
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
    notebook?: NotebookSpec
  ) {
    showToast(`Loading ${name}…`, 'progress');
    try {
      const masterBytes = new Uint8Array(bytes);
      const docId = existingDocId || await openDocumentSession(name, masterBytes.slice(0));
      const { pageCount, pages, bookmarks } = await pdfEngine.loadFromBytes(masterBytes.slice(0), docId);

      const session: DocumentSession = {
        id: docId,
        name,
        fileData: masterBytes,
        pageCount,
        pages,
        bookmarks,
        annotations: {},
        layers: {},
        activePageIndex: 0,
        createdAt: Date.now(),
        lastModifiedAt: Date.now(),
        notebook
      };

      this._lastDocId = docId;
      history.switchDocument(docId);
      store.setActiveDocument(session);
      this.clearRenderedPages();
      this.renderEmptyState();
      viewportManager.updateLayout(true);
      showToast(`${name} loaded (${pageCount} pages)`, 'success');
    } catch (err: any) {
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
      this._lastDocId = store.activeDocument.id;
      this._lastZoom = store.zoom;
      this._lastViewMode = store.viewMode;
      history.switchDocument(store.activeDocument.id);

      // Instant switch: activate cached document proxy in pdfEngine
      if (store.activeDocument.fileData) {
        await pdfEngine.loadFromBytes(store.activeDocument.fileData, store.activeDocument.id);
      }
      this.clearRenderedPages();
      viewportManager.updateLayout(true);
      if (store.activePageIndex > 0) {
        viewportManager.scrollToPage(store.activePageIndex);
      }
      return;
    }

    if (zoomChanged || viewModeChanged) {
      this._lastZoom = store.zoom;
      this._lastViewMode = store.viewMode;
      // The size-indicating cursors are drawn at the on-screen brush size, so
      // they have to be refreshed on zoom as well as on tool changes.
      this.updateCanvasCursors();
      viewportManager.updateLayout(true);
      return;
    }

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

    const unclamped = this._zoomPreviewScale * factor;
    // Clamp the TOTAL zoom (committed x preview) to the store's [0.2, 5] range.
    const clampedTotal = Math.max(0.2, Math.min(5.0, store.zoom * unclamped)) / store.zoom;
    const inc = clampedTotal / this._zoomPreviewScale;
    if (Math.abs(inc - 1) < 0.0005) {
      this.scheduleZoomCommit();
      return;
    }

    const rect = this._scrollContainer.getBoundingClientRect();
    const fx = centerClient.x - rect.left;
    const fy = centerClient.y - rect.top;
    // With transform-origin 0 0, wrapper point p renders at s*p; keeping the
    // focal viewport point stable gives scroll' = (scroll + f) * inc - f.
    this._scrollContainer.scrollLeft = (this._scrollContainer.scrollLeft + fx) * inc - fx;
    this._scrollContainer.scrollTop = (this._scrollContainer.scrollTop + fy) * inc - fy;

    this._zoomPreviewScale = clampedTotal;
    this._zoomPreviewActive = true;
    this._pagesWrapper.style.transformOrigin = '0 0';
    this._pagesWrapper.style.transform = `scale(${this._zoomPreviewScale})`;
    this.scheduleZoomCommit();
  }

  private scheduleZoomCommit(): void {
    if (this._zoomCommitTimer !== null) window.clearTimeout(this._zoomCommitTimer);
    // Commit shortly after the last tick/finger move: one layout + one render
    // pass for the entire gesture instead of dozens per second mid-gesture.
    this._zoomCommitTimer = window.setTimeout(() => this.commitZoomPreview(), 160);
  }

  private commitZoomPreview(): void {
    this._zoomCommitTimer = null;
    if (!this._zoomPreviewActive) return;
    const finalZoom = Math.max(0.2, Math.min(5.0, store.zoom * this._zoomPreviewScale));
    this._zoomPreviewScale = 1;
    this._zoomPreviewActive = false;
    this._pagesWrapper.style.transform = '';
    this._pagesWrapper.style.transformOrigin = '';
    if (Math.abs(finalZoom - store.zoom) > 0.0005) {
      store.setZoom(finalZoom);
      viewportManager.handleScroll(true);
    }
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
    const doc = store.activeDocument;
    if (!doc) return;

    const visibleSet = new Set(visibleIndices);

    // 1. Warm windowing: only evict pages that are more than 4 pages away to prevent scroll blinking
    const maxKeepDistance = 4;
    for (const [pageIndex, p] of this._renderedPages) {
      let minDistance = Infinity;
      for (const v of visibleIndices) {
        const d = Math.abs(pageIndex - v);
        if (d < minDistance) minDistance = d;
      }

      if (minDistance > maxKeepDistance) {
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
      const layout = viewportManager.getLayout(pageIndex);
      if (!layout) continue;

      let pageElements = this._renderedPages.get(pageIndex);

      if (!pageElements) {
        // Create container and 4-layer canvas architecture
        const container = document.createElement('div');
        container.className = 'pdf-page-container';
        container.dataset.pageIndex = String(pageIndex);

        const pdfCanvas = document.createElement('canvas');
        pdfCanvas.className = 'pdf-page-canvas';
        pdfCanvas.dataset.pageIndex = String(pageIndex);
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
      pageElements.container.style.top = `${layout.top}px`;
      pageElements.container.style.left = `${layout.left}px`;
      pageElements.container.style.width = `${layout.width}px`;
      pageElements.container.style.height = `${layout.height}px`;

      pageElements.pdfCanvas.dataset.pageIndex = String(pageIndex);
      pageElements.pdfCanvas.style.width = `${layout.width}px`;
      pageElements.pdfCanvas.style.height = `${layout.height}px`;

      const dpr = window.devicePixelRatio || 1;
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
      pdfEngine.renderPageToCanvas(pageIndex, pageElements.pdfCanvas, store.zoom, rot);

      // Render pattern & annotations
      this.repaintPageAnnotations(pageIndex, pageElements);
    }
  }

  private repaintPageAnnotations(
    pageIndex: number,
    p: { patternCanvas: HTMLCanvasElement; annotCanvas: HTMLCanvasElement; scratchCanvas: HTMLCanvasElement }
  ) {
    const dpr = window.devicePixelRatio || 1;
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
      // Two-finger touch takes over as pinch-zoom/pan: abort any in-progress
      // single-finger stroke so the gesture zooms the PDF and draws nothing.
      if (e.pointerType === 'touch') {
        const gestureStarted = gestureEngine.handlePointerDown(e);
        if (gestureStarted) {
          pointerHandler.cancelActiveStroke();
          e.preventDefault();
          return;
        }
        if (gestureEngine.isGestureActive) {
          e.preventDefault();
          return;
        }
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
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      pointerHandler.handlePointerUp(e, pageIndex, canvas, onRepaint);
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
      e.preventDefault();
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      pointerHandler.handlePointerUp(e, pageIndex, canvas, onRepaint);
    });

    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      pointerHandler.finishPolygon(pageIndex, 'layer-default', onRepaint);
    });
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

  private setupGlobalShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't trigger tool shortcuts when typing in inputs
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if (e.key === 'Enter') {
        const handled = pointerHandler.finishPolygon(store.activePageIndex, 'layer-default', () => {
          this.repaintAllRenderedAnnotations();
        });
        if (handled) {
          e.preventDefault();
          return;
        }
      } else if (e.key === 'Escape') {
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
          document.getElementById('header-export-btn')?.click();
          return;
        }
        return;
      }

      if (e.altKey) return;

      const key = e.key.toLowerCase();

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
        await this.loadPDF(session.name, session.fileData);
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
