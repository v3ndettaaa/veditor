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
  SidebarTab
} from './types';

export type StoreListener = () => void;

class StateStore {
  // Document State
  private _activeDocument: DocumentSession | null = null;
  private _documentTabs: Array<{ id: string; name: string }> = [];
  private _openDocuments: Map<string, DocumentSession> = new Map();
  private _closeTabListeners: Set<(tabId: string) => void> = new Set();

  // Navigation & Viewport State
  private _zoom: number = 1.0;
  private _viewMode: ViewMode = 'continuous';
  private _activePageIndex: number = 0;
  private _pageRotations: Record<number, number> = {}; // pageIndex -> rotation

  // Tool State
  private _activeTool: ToolType = 'pen';
  private _toolSettings: ToolSettings = {
    penColor: '#4f46e5',
    penWidth: 3,
    highlighterColor: 'rgba(250, 204, 21, 0.45)',
    highlighterWidth: 20,
    highlighterBlendMode: 'source-over',
    highlighterStraightLine: false,
    highlighterTipShape: 'round',
    eraserMode: 'stroke',
    eraserWidth: 24,
    shapeColor: '#ef4444',
    shapeFillColor: 'transparent',
    shapeWidth: 2,
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
    redactionColor: '#000000'
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
    retinaRendering: true
  };

  // Selection & Clipboard State
  private _selectedAnnotationIds: Set<string> = new Set();
  private _clipboardAnnotations: Annotation[] = [];

  // UI Panels State
  private _sidebarOpen: boolean = false;
  private _activeSidebarTab: SidebarTab = 'thumbnails';
  private _propertiesPanelOpen: boolean = false;
  private _focusMode: boolean = false;
  private _commandPaletteOpen: boolean = false;
  private _shortcutsModalOpen: boolean = false;
  private _settingsModalOpen: boolean = false;
  private _signatureModalOpen: boolean = false;

  // Listeners
  private _listeners: Set<StoreListener> = new Set();

  constructor() {
    // Detect system dark mode preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this._appSettings.theme = prefersDark ? 'dark' : 'light';
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
          this._appSettings = { ...this._appSettings, ...JSON.parse(savedApp) };
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
  get pageRotations() { return this._pageRotations; }
  get activeTool() { return this._activeTool; }
  get toolSettings() { return this._toolSettings; }
  get appSettings() { return this._appSettings; }
  get selectedAnnotationIds() { return this._selectedAnnotationIds; }
  get clipboardAnnotations() { return this._clipboardAnnotations; }
  get sidebarOpen() { return this._sidebarOpen; }
  get activeSidebarTab() { return this._activeSidebarTab; }
  get propertiesPanelOpen() { return this._propertiesPanelOpen; }
  get focusMode() { return this._focusMode; }
  get commandPaletteOpen() { return this._commandPaletteOpen; }
  get shortcutsModalOpen() { return this._shortcutsModalOpen; }
  get settingsModalOpen() { return this._settingsModalOpen; }
  get signatureModalOpen() { return this._signatureModalOpen; }

  // Setters & Actions
  public onTabClosed(listener: (tabId: string) => void) {
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
      this._openDocuments.set(doc.id, doc);
      if (!this._documentTabs.some(t => t.id === doc.id)) {
        this._documentTabs.push({ id: doc.id, name: doc.name });
      }
      this._activePageIndex = doc.activePageIndex || 0;
    }
    this._selectedAnnotationIds.clear();
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
    this._documentTabs = this._documentTabs.filter(t => t.id !== tabId);
    this._openDocuments.delete(tabId);

    // Notify listeners (e.g. pdfEngine and history to clean up cache)
    for (const listener of this._closeTabListeners) {
      try {
        listener(tabId);
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
    this.notify();
  }

  public closeAllDocumentTabs() {
    this._documentTabs = [];
    this._openDocuments.clear();
    this._activeDocument = null;
    this._activePageIndex = 0;
    this._selectedAnnotationIds.clear();
    this.notify();
  }

  public setZoom(zoom: number) {
    const clamped = Math.max(0.2, Math.min(5.0, zoom));
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
      this.notify();
    }
  }

  public rotatePage(pageIndex: number, deltaDeg = 90) {
    const current = this._pageRotations[pageIndex] || 0;
    this._pageRotations[pageIndex] = (current + deltaDeg) % 360;
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
      highlighterColor: 'rgba(250, 204, 21, 0.45)',
      highlighterWidth: 20,
      highlighterBlendMode: 'source-over',
      eraserMode: 'stroke',
      eraserWidth: 24,
      shapeColor: '#ef4444',
      shapeFillColor: 'transparent',
      shapeWidth: 2,
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
      stampPreset: 'APPROVED',
      redactionColor: '#000000'
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
      retinaRendering: true
    };
    this.notify();
  }

  // Selection
  public setSelectedAnnotationIds(ids: string[]) {
    this._selectedAnnotationIds = new Set(ids);
    this._propertiesPanelOpen = ids.length > 0;
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
    this._propertiesPanelOpen = this._selectedAnnotationIds.size > 0;
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

  public toggleFocusMode() {
    this._focusMode = !this._focusMode;
    this.notify();
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

  public setSignatureModalOpen(open: boolean) {
    this._signatureModalOpen = open;
    this.notify();
  }
}

export const store = new StateStore();
