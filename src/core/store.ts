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
  Layer
} from './types';

export type StoreListener = () => void;

class StateStore {
  // Document State
  private _activeDocument: DocumentSession | null = null;
  private _documentTabs: Array<{ id: string; name: string }> = [];

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
    highlighterBlendMode: 'multiply',
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
    pressureCurve: 'linear',
    palmRejectionEnabled: true
  };

  // App Settings
  private _appSettings: AppSettings = {
    theme: 'dark',
    accentColor: '#6366f1',
    language: 'en',
    backgroundPattern: 'none',
    autoSaveIntervalMs: 3000,
    snapToGrid: false,
    gridSize: 20,
    hardwareAcceleration: true,
    maxRenderBufferPages: 3,
    showRuler: false
  };

  // Selection & Clipboard State
  private _selectedAnnotationIds: Set<string> = new Set();
  private _clipboardAnnotations: Annotation[] = [];

  // UI Panels State
  private _sidebarOpen: boolean = false;
  private _activeSidebarTab: 'thumbnails' | 'outline' | 'layers' | 'search' | 'history' = 'thumbnails';
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
  }

  public subscribe(listener: StoreListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
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
  public setActiveDocument(doc: DocumentSession | null) {
    this._activeDocument = doc;
    if (doc) {
      if (!this._documentTabs.some(t => t.id === doc.id)) {
        this._documentTabs.push({ id: doc.id, name: doc.name });
      }
      this._activePageIndex = doc.activePageIndex || 0;
    }
    this._selectedAnnotationIds.clear();
    this.notify();
  }

  public closeDocumentTab(tabId: string) {
    this._documentTabs = this._documentTabs.filter(t => t.id !== tabId);
    if (this._activeDocument?.id === tabId) {
      this._activeDocument = null;
    }
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
    this.notify();
  }

  public updateAppSettings(partial: Partial<AppSettings>) {
    this._appSettings = { ...this._appSettings, ...partial };
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
  public toggleSidebar(tab?: 'thumbnails' | 'outline' | 'layers' | 'search' | 'history') {
    if (tab && this._sidebarOpen && this._activeSidebarTab === tab) {
      this._sidebarOpen = false;
    } else {
      this._sidebarOpen = true;
      if (tab) this._activeSidebarTab = tab;
    }
    this.notify();
  }

  public setSidebarTab(tab: 'thumbnails' | 'outline' | 'layers' | 'search' | 'history') {
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
