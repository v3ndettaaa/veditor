/**
 * Central Reactive State Management Store for veditor
 * Ultra-fast event-driven store with zero framework overhead.
 */

import {
  ToolType,
  ViewMode,
  ThemeMode,
  LanguageMode,
  BackgroundPattern,
  DocumentSession,
  ToolSettings,
  AppSettings,
  Annotation,
  Layer,
  SidebarTab,
  ToolOptionKey,
  SEGMENT_TOOLS,
  PageClipboard,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_TOOLBAR_ORDER
} from './types';
import { getSystemDpi } from '../utils/dpi';
import { pruneUnsupportedAnnotations } from '../annotations/migrate';

export interface ToolbarLayoutItem {
  id: ToolType;
  visible: boolean;
}

const TOOLBAR_LAYOUT_KEY = 'veditor_toolbar_layout';

export type StoreListener = () => void;

class StateStore {
  // Document State
  private _activeDocument: DocumentSession | null = null;
  private _documentTabs: Array<{ id: string; name: string }> = [];
  private _openDocuments: Map<string, DocumentSession> = new Map();
  private _closeTabListeners: Set<(tabId: string, closedDoc?: DocumentSession) => void> = new Set();

  // Navigation & Viewport State
  private _zoom: number = 1.0;
  private _viewMode: ViewMode = 'continuous';
  private _activePageIndex: number = 0;
  /** Per-document user rotations: docId -> (pageIndex -> degrees). */
  private _pageRotationsByDoc: Map<string, Record<number, number>> = new Map();
  /**
   * True while main.ts is rebuilding layout for a tab switch. Viewport scroll
   * tracking must not overwrite the restored page in this window.
   */
  private _docSwitching: boolean = false;
  /**
   * True while a focal-anchored zoom step (double-click, marquee) is applying
   * its scroll correction. Suppresses the intermediate scroll pass so one
   * layout + mount pass happens instead of two.
   */
  private _zoomAdjusting: boolean = false;

  // Tool State
  private _activeTool: ToolType = 'pen';
  private _toolSettings: ToolSettings = {
    penColor: '#4f46e5',
    penWidth: 3,
    highlighterColor: 'rgba(250, 204, 21, 0.3)',
    highlighterWidth: 20,
    highlighterBlendMode: 'source-over',
    highlighterStraightLine: false,
    highlighterTipShape: 'round',
    highlighterOpacity: 0.3,
    highlighterCursor: 'rectangle',
    eraserMode: 'stroke',
    eraserWidth: 24,
    shapeColor: '#ef4444',
    shapeFillColor: 'transparent',
    shapeWidth: 2,
    shapeOutline: true,
    shapeStyle: 'solid',
    textColor: '#111827',
    textBgColor: 'transparent',
    fontSize: 16,
    fontFamily: 'Inter',
    textAlign: 'left',
    measureUnit: 'mm',
    measureScale: 1.0,
    pressureSensitivityEnabled: true,
    mousePressureSimulation: false,
    pressureCurve: 'linear',
    pressureStrength: 'balanced',
    strokeSmoothing: 'medium',
    palmRejectionEnabled: true,
    stylusInvertedEraserEnabled: true,
    drawingCursor: 'pen',
    stampPreset: 'APPROVED',
    redactionColor: '#000000',
    snapAngle15: {},
    connectLines: {}
  };

  // App Settings
  private _appSettings: AppSettings = {
    theme: 'dark',
    accentColor: '#6366f1',
    language: 'en',
    backgroundPattern: 'none',
    autoSaveIntervalMs: 15000,
    snapToGrid: false,
    gridSize: 20,
    hardwareAcceleration: true,
    maxRenderBufferPages: 3,
    showRuler: false,
    showPageShadows: true,
    defaultZoomMode: 'fitWidth',
    defaultViewMode: 'continuous',
    uiDensity: 'comfortable',
    smoothScroll: true,
    invertDocumentOled: false,
    targetDPI: 150,
    toolbarDock: 'top',
    customPalette: [],
    removedDefaultColors: []
  };

  // Selection & Clipboard State
  private _selectedAnnotationIds: Set<string> = new Set();
  private _clipboardAnnotations: Annotation[] = [];
  /** Pages highlighted in the thumbnail list; cleared on document switch. */
  private _selectedPageIndices: Set<number> = new Set();
  private _pageClipboard: PageClipboard | null = null;
  /**
   * When true, programmatic selection (annotation creation/recognition) must
   * not surface contextual panels (floating props bar / inspector). Set while
   * the app selects a freshly created annotation so creation stays
   * non-intrusive; cleared immediately after.
   */
  private _suppressAutoPanels: boolean = false;

  // Toolbar customization (order + visibility persisted; arranged in Settings)
  private _toolbarOrder: ToolType[] = [...DEFAULT_TOOLBAR_ORDER];
  private _toolbarHidden: ToolType[] = [];

  // UI Panels State
  private _sidebarOpen: boolean = false;
  private _activeSidebarTab: SidebarTab = 'thumbnails';
  private _propertiesPanelOpen: boolean = false;
  private _focusMode: boolean = false;
  private _viewControlsCollapsed: boolean = false;
  private _commandPaletteOpen: boolean = false;
  private _shortcutsModalOpen: boolean = false;
  private _settingsModalOpen: boolean = false;
  private _signatureModalOpen: boolean = false;
  private _scratchpadOpen: boolean = false;
  private _scratchpadMinimized: boolean = false;

  // Listeners
  private _listeners: Set<StoreListener> = new Set();

  constructor() {
    // Detect system dark mode preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this._appSettings.theme = prefersDark ? 'dark' : 'light';
    }

    // Load persisted toolbar layout (unknown ids dropped, new tools appended).
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const savedLayout = localStorage.getItem(TOOLBAR_LAYOUT_KEY);
        if (savedLayout) {
          const parsed = JSON.parse(savedLayout) as { order?: string[]; hidden?: string[] };
          const known = new Set<string>(DEFAULT_TOOLBAR_ORDER);
          if (Array.isArray(parsed.order)) {
            const ordered = [...new Set(parsed.order.filter(id => known.has(id)) as ToolType[])];
            for (const id of DEFAULT_TOOLBAR_ORDER) {
              if (!ordered.includes(id)) ordered.push(id);
            }
            this._toolbarOrder = ordered;
          }
          if (Array.isArray(parsed.hidden)) {
            this._toolbarHidden = (parsed.hidden.filter(id => known.has(id)) as ToolType[]);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load toolbar layout from localStorage:', e);
    }

    // Load persisted settings from localStorage if available
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const savedTools = localStorage.getItem('veditor_tool_settings');
        if (savedTools) {
          this._toolSettings = { ...this._toolSettings, ...JSON.parse(savedTools) };
        }
        const savedApp = localStorage.getItem('veditor_app_settings');
        if (savedApp) {
          const parsed = JSON.parse(savedApp) as Record<string, unknown>;
          // Migrate the retired `retinaRendering` boolean to `targetDPI`.
          if (parsed.targetDPI === undefined && parsed.retinaRendering !== undefined) {
            parsed.targetDPI = parsed.retinaRendering === false ? 72 : getSystemDpi();
          }
          delete parsed.retinaRendering;
          // Migrate the retired global snap/connect flags to per-tool options.
          if (parsed.snapAngle15 !== undefined || parsed.connectLines !== undefined) {
            const legacySnap = parsed.snapAngle15 === true;
            const legacyConnect = parsed.connectLines === true;
            const snap = { ...this._toolSettings.snapAngle15 };
            const connect = { ...this._toolSettings.connectLines };
            for (const tool of SEGMENT_TOOLS) {
              if (snap[tool] === undefined) snap[tool] = legacySnap;
              if (connect[tool] === undefined) connect[tool] = legacyConnect;
            }
            this._toolSettings = { ...this._toolSettings, snapAngle15: snap, connectLines: connect };
            delete parsed.snapAngle15;
            delete parsed.connectLines;
          }
          this._appSettings = { ...this._appSettings, ...parsed } as AppSettings;
        }
      }
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
    }
  }

  public subscribe(listener: StoreListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Broadcast to subscribers. Public because `HistoryManager` mutates
   * document state through its own undo stack and then has to announce it;
   * every mutator on this class calls it too.
   *
   * Callers reached from inside a listener must make sure their own work is
   * idempotent, or the notification loops back on itself.
   */
  public notify() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in store listener:', err);
      }
    }
  }

  // Getters
  get activeDocument() { return this._activeDocument; }
  get documentTabs() { return this._documentTabs; }
  get openDocuments() { return this._openDocuments; }
  get zoom() { return this._zoom; }
  get viewMode() { return this._viewMode; }
  get activePageIndex() { return this._activePageIndex; }
  /** Rotations for the currently active document (empty when none). */
  get pageRotations(): Record<number, number> {
    if (!this._activeDocument) return {};
    let rec = this._pageRotationsByDoc.get(this._activeDocument.id);
    if (!rec) {
      rec = {};
      this._pageRotationsByDoc.set(this._activeDocument.id, rec);
    }
    return rec;
  }
  get isDocSwitching() { return this._docSwitching; }
  public beginDocSwitch() { this._docSwitching = true; }
  public endDocSwitch() { this._docSwitching = false; }
  get isZoomAdjusting() { return this._zoomAdjusting; }
  public beginZoomAdjust() { this._zoomAdjusting = true; }
  public endZoomAdjust() { this._zoomAdjusting = false; }
  get activeTool() { return this._activeTool; }
  get toolSettings() { return this._toolSettings; }
  get appSettings() { return this._appSettings; }
  get selectedAnnotationIds() { return this._selectedAnnotationIds; }
  get clipboardAnnotations() { return this._clipboardAnnotations; }
  /**
   * Per-tool drawing option (`snapAngle15` / `connectLines`). Defaults to off
   * for any tool the user has not toggled.
   */
  public toolOption(tool: ToolType, key: ToolOptionKey): boolean {
    return this._toolSettings[key]?.[tool] === true;
  }
  /** Persists a per-tool drawing option through the normal settings save path. */
  public setToolOption(tool: ToolType, key: ToolOptionKey, value: boolean): void {
    const next = { ...(this._toolSettings[key] || {}), [tool]: value };
    this.updateToolSettings({ [key]: next } as Partial<ToolSettings>);
  }
  get suppressAutoPanels() { return this._suppressAutoPanels; }
  public setSuppressAutoPanels(value: boolean) { this._suppressAutoPanels = value; }
  get sidebarOpen() { return this._sidebarOpen; }
  get activeSidebarTab() { return this._activeSidebarTab; }
  get propertiesPanelOpen() { return this._propertiesPanelOpen; }
  get focusMode() { return this._focusMode; }
  get viewControlsCollapsed() { return this._viewControlsCollapsed; }
  get commandPaletteOpen() { return this._commandPaletteOpen; }
  get shortcutsModalOpen() { return this._shortcutsModalOpen; }
  get settingsModalOpen() { return this._settingsModalOpen; }
  get signatureModalOpen() { return this._signatureModalOpen; }
  get scratchpadOpen() { return this._scratchpadOpen; }
  get scratchpadMinimized() { return this._scratchpadMinimized; }

  // Setters & Actions
  public onTabClosed(listener: (tabId: string, closedDoc?: DocumentSession) => void) {
    this._closeTabListeners.add(listener);
    return () => this._closeTabListeners.delete(listener);
  }

  public setActiveDocument(doc: DocumentSession | null) {
    if (this._activeDocument && this._activeDocument.id) {
      this._activeDocument.activePageIndex = this._activePageIndex;
      this._openDocuments.set(this._activeDocument.id, this._activeDocument);
    }

    this._activeDocument = doc;
    if (doc) {
      pruneUnsupportedAnnotations(doc);
      this._openDocuments.set(doc.id, doc);
      if (!this._documentTabs.some(t => t.id === doc.id)) {
        this._documentTabs.push({ id: doc.id, name: doc.name });
      }
      this._activePageIndex = doc.activePageIndex || 0;
    }
    this._selectedAnnotationIds.clear();
    // Page indices are document-scoped; keeping them across a switch would
    // highlight unrelated pages in the next document.
    this._selectedPageIndices.clear();
    this.notify();
  }

  public switchDocumentTab(tabId: string) {
    if (this._activeDocument?.id === tabId) return;

    if (this._activeDocument) {
      this._activeDocument.activePageIndex = this._activePageIndex;
      this._openDocuments.set(this._activeDocument.id, this._activeDocument);
    }

    const targetDoc = this._openDocuments.get(tabId);
    if (targetDoc) {
      this._activeDocument = targetDoc;
      this._activePageIndex = targetDoc.activePageIndex || 0;
      this._selectedAnnotationIds.clear();
      this.notify();
    }
  }

  public closeDocumentTab(tabId: string) {
    const closedDoc = this._openDocuments.get(tabId);
    this._documentTabs = this._documentTabs.filter(t => t.id !== tabId);
    this._openDocuments.delete(tabId);
    this._pageRotationsByDoc.delete(tabId);

    // Notify listeners (e.g. pdfEngine and history to clean up cache)
    for (const listener of this._closeTabListeners) {
      try {
        listener(tabId, closedDoc);
      } catch (e) {
        console.error('Error in closeTab listener:', e);
      }
    }

    if (this._activeDocument?.id === tabId) {
      if (this._documentTabs.length > 0) {
        const nextTab = this._documentTabs[this._documentTabs.length - 1];
        const nextDoc = this._openDocuments.get(nextTab.id) || null;
        this._activeDocument = nextDoc;
        this._activePageIndex = nextDoc?.activePageIndex || 0;
      } else {
        this._activeDocument = null;
        this._activePageIndex = 0;
      }
    }
    this._selectedAnnotationIds.clear();
    this._selectedPageIndices.clear();
    this.notify();
  }

  public closeAllDocumentTabs() {
    this._documentTabs = [];
    this._openDocuments.clear();
    this._pageRotationsByDoc.clear();
    this._activeDocument = null;
    this._activePageIndex = 0;
    this._selectedAnnotationIds.clear();
    this._selectedPageIndices.clear();
    this.notify();
  }

  public setZoom(zoom: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (this._zoom !== clamped) {
      this._zoom = clamped;
      this.notify();
    }
  }

  public setViewMode(mode: ViewMode) {
    if (this._viewMode !== mode) {
      this._viewMode = mode;
      this.notify();
    }
  }

  public setActivePageIndex(index: number) {
    if (this._activePageIndex !== index) {
      this._activePageIndex = index;
      if (this._activeDocument) {
        this._activeDocument.activePageIndex = index;
      }
      // During a tab-switch layout rebuild, scroll tracking must stay silent
      // or the stale scrollTop clobbers the just-restored page.
      if (!this._docSwitching && !this._zoomAdjusting) {
        this.notify();
      }
    }
  }

  public rotatePage(pageIndex: number, deltaDeg = 90) {
    const rotations = this.pageRotations;
    const current = rotations[pageIndex] || 0;
    // Normalize to [0,360) so -90 becomes 270 (consistent badge + geometry).
    rotations[pageIndex] = ((current + deltaDeg) % 360 + 360) % 360;
    this.notify();
  }

  /** Rotates every page of the active document in a single update (one layout). */
  public rotateAllPages(deltaDeg = 90) {
    const doc = this._activeDocument;
    if (!doc) return;
    const rotations = this.pageRotations;
    for (let i = 0; i < doc.pageCount; i++) {
      const current = rotations[i] || 0;
      rotations[i] = ((current + deltaDeg) % 360 + 360) % 360;
    }
    this.notify();
  }

  public setActiveTool(tool: ToolType) {
    if (this._activeTool !== tool) {
      this._activeTool = tool;
      if (tool !== 'select') {
        this._selectedAnnotationIds.clear();
      }
      this.notify();
    }
  }

  public updateToolSettings(partial: Partial<ToolSettings>) {
    this._toolSettings = { ...this._toolSettings, ...partial };
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('veditor_tool_settings', JSON.stringify(this._toolSettings));
      }
    } catch (e) {
      console.warn('Failed to persist tool settings:', e);
    }
    this.notify();
  }

  public updateAppSettings(partial: Partial<AppSettings>) {
    this._appSettings = { ...this._appSettings, ...partial };
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('veditor_app_settings', JSON.stringify(this._appSettings));
      }
    } catch (e) {
      console.warn('Failed to persist app settings:', e);
    }
    this.notify();
  }

  public resetSettingsToDefault() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem('veditor_tool_settings');
        localStorage.removeItem('veditor_app_settings');
      }
    } catch (e) {
      console.warn('Failed to clear settings from localStorage:', e);
    }
    this._toolSettings = {
      penColor: '#4f46e5',
      penWidth: 3,
      highlighterColor: 'rgba(250, 204, 21, 0.3)',
      highlighterWidth: 20,
      highlighterBlendMode: 'source-over',
      eraserMode: 'stroke',
      eraserWidth: 24,
      shapeColor: '#ef4444',
      shapeFillColor: 'transparent',
      shapeWidth: 2,
      shapeOutline: true,
      shapeStyle: 'solid',
      textColor: '#111827',
      textBgColor: 'transparent',
      fontSize: 16,
      fontFamily: 'Inter',
      textAlign: 'left',
      measureUnit: 'mm',
      measureScale: 1.0,
      pressureSensitivityEnabled: true,
      mousePressureSimulation: false,
      pressureCurve: 'linear',
      pressureStrength: 'balanced',
      strokeSmoothing: 'medium',
      palmRejectionEnabled: true,
      stylusInvertedEraserEnabled: true,
      drawingCursor: 'pen',
      highlighterStraightLine: false,
      highlighterTipShape: 'round',
      highlighterOpacity: 0.3,
      highlighterCursor: 'rectangle',
      stampPreset: 'APPROVED',
      redactionColor: '#000000',
      snapAngle15: {},
      connectLines: {}
    };
    this._appSettings = {
      theme: 'dark',
      accentColor: '#6366f1',
      language: 'en',
      backgroundPattern: 'none',
      autoSaveIntervalMs: 15000,
      snapToGrid: false,
      gridSize: 20,
      hardwareAcceleration: true,
      maxRenderBufferPages: 3,
      showRuler: false,
      showPageShadows: true,
      defaultZoomMode: 'fitWidth',
      defaultViewMode: 'continuous',
      uiDensity: 'comfortable',
      smoothScroll: true,
      invertDocumentOled: false,
      targetDPI: 150,
      toolbarDock: 'top',
      customPalette: [],
      removedDefaultColors: []
    };
    this.notify();
  }

  // Selection
  public setSelectedAnnotationIds(ids: string[]) {
    this._selectedAnnotationIds = new Set(ids);
    this.notify();
  }

  public selectAnnotation(id: string, multiSelect = false) {
    if (multiSelect) {
      if (this._selectedAnnotationIds.has(id)) {
        this._selectedAnnotationIds.delete(id);
      } else {
        this._selectedAnnotationIds.add(id);
      }
    } else {
      this._selectedAnnotationIds = new Set([id]);
    }
    this.notify();
  }

  public clearSelection() {
    if (this._selectedAnnotationIds.size > 0) {
      this._selectedAnnotationIds.clear();
      this.notify();
    }
  }

  public setClipboard(annotations: Annotation[]) {
    this._clipboardAnnotations = [...annotations];
  }

  // Page selection & clipboard (thumbnail list)

  get selectedPageIndices() { return this._selectedPageIndices; }

  get pageClipboard() { return this._pageClipboard; }

  public setPageClipboard(clipboard: PageClipboard | null) {
    this._pageClipboard = clipboard;
    this.notify();
  }

  /** Replaces the page selection; a missing set clears it. */
  public setSelectedPageIndices(indices: Iterable<number>) {
    this._selectedPageIndices = new Set(indices);
    this.notify();
  }

  /**
   * Ctrl-style toggling for thumbnail clicks. Anchoring is left to the caller:
   * shift-range needs the previous anchor, which only the click handler knows.
   */
  public togglePageIndex(index: number) {
    if (this._selectedPageIndices.has(index)) this._selectedPageIndices.delete(index);
    else this._selectedPageIndices.add(index);
    this.notify();
  }

  /**
   * Selection used by the page menu and keyboard shortcuts: an explicit
   * selection wins, otherwise the page under the cursor, otherwise the page
   * currently on screen.
   */
  public effectivePageSelection(preferred?: number): number[] {
    if (this._selectedPageIndices.size > 0) {
      return [...this._selectedPageIndices].sort((a, b) => a - b);
    }
    const doc = this._activeDocument;
    if (!doc) return [];
    const fallback = preferred ?? this._activePageIndex;
    return fallback >= 0 && fallback < doc.pageCount ? [fallback] : [];
  }

  // Toolbar customization

  /** Ordered toolbar tools with visibility, merged against known tools. */
  get toolbarLayout(): ToolbarLayoutItem[] {
    const hidden = new Set(this._toolbarHidden);
    return this._toolbarOrder.map(id => ({ id, visible: !hidden.has(id) }));
  }

  private persistToolbarLayout() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(TOOLBAR_LAYOUT_KEY, JSON.stringify({
          order: this._toolbarOrder,
          hidden: this._toolbarHidden
        }));
      }
    } catch (e) {
      console.warn('Failed to persist toolbar layout:', e);
    }
  }

  public setToolbarOrder(ids: ToolType[]) {
    const known = new Set<string>(DEFAULT_TOOLBAR_ORDER);
    // Dedupe defensively: a duplicated id would render the tool twice and
    // could no longer be reasoned about by position.
    const ordered = [...new Set(ids.filter(id => known.has(id)) as ToolType[])];
    for (const id of DEFAULT_TOOLBAR_ORDER) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    this._toolbarOrder = ordered;
    this.persistToolbarLayout();
    this.notify();
  }

  public setToolbarHidden(ids: ToolType[]) {
    const known = new Set<string>(DEFAULT_TOOLBAR_ORDER);
    this._toolbarHidden = ids.filter(id => known.has(id));
    this.persistToolbarLayout();
    this.notify();
  }

  public resetToolbarLayout() {
    this._toolbarOrder = [...DEFAULT_TOOLBAR_ORDER];
    this._toolbarHidden = [];
    this.persistToolbarLayout();
    this.notify();
  }

  // UI Panels

  /**
   * No `tab`: plain open/close toggle, for the header button and the panel's
   * own close button.
   * With a `tab`: opens that tab, or closes the sidebar when that tab is
   * already the one showing.
   */
  public toggleSidebar(tab?: SidebarTab) {
    if (!tab) {
      this._sidebarOpen = !this._sidebarOpen;
    } else if (this._sidebarOpen && this._activeSidebarTab === tab) {
      this._sidebarOpen = false;
    } else {
      this._sidebarOpen = true;
      this._activeSidebarTab = tab;
    }
    this.notify();
  }

  public setSidebarTab(tab: SidebarTab) {
    this._activeSidebarTab = tab;
    this._sidebarOpen = true;
    this.notify();
  }

  public togglePropertiesPanel() {
    this._propertiesPanelOpen = !this._propertiesPanelOpen;
    this.notify();
  }

  public setPropertiesPanelOpen(open: boolean) {
    if (this._propertiesPanelOpen !== open) {
      this._propertiesPanelOpen = open;
      this.notify();
    }
  }

  public toggleFocusMode() {
    this._focusMode = !this._focusMode;
    this.notify();
  }

  public toggleViewControlsCollapsed() {
    this._viewControlsCollapsed = !this._viewControlsCollapsed;
    this.notify();
  }

  public setViewControlsCollapsed(collapsed: boolean) {
    if (this._viewControlsCollapsed !== collapsed) {
      this._viewControlsCollapsed = collapsed;
      this.notify();
    }
  }

  public setCommandPaletteOpen(open: boolean) {
    this._commandPaletteOpen = open;
    this.notify();
  }

  public setShortcutsModalOpen(open: boolean) {
    this._shortcutsModalOpen = open;
    this.notify();
  }

  public setSettingsModalOpen(open: boolean) {
    this._settingsModalOpen = open;
    this.notify();
  }

  /**
   * One-shot request for the settings modal to open a specific tab
   * (e.g. the command palette jumping straight to Toolbar). Consumed
   * (cleared) by the modal on render; plain field on purpose — no notify,
   * the accompanying setSettingsModalOpen(true) already notifies.
   */
  public settingsTabRequest: string | null = null;

  public setSignatureModalOpen(open: boolean) {
    this._signatureModalOpen = open;
    this.notify();
  }

  public setScratchpadOpen(open: boolean) {
    if (this._scratchpadOpen !== open) {
      this._scratchpadOpen = open;
      if (open) this._scratchpadMinimized = false;
      this.notify();
    } else if (open && this._scratchpadMinimized) {
      this._scratchpadMinimized = false;
      this.notify();
    }
  }

  public setScratchpadMinimized(minimized: boolean) {
    if (this._scratchpadMinimized !== minimized) {
      this._scratchpadMinimized = minimized;
      this.notify();
    }
  }
}

export const store = new StateStore();
