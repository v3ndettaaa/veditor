/**
 * Core Type Definitions for veditor
 */

export type ToolType =
  | 'select'
  | 'lasso'
  | 'hand'
  | 'zoom-lens'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'freeform-shape'
  | 'text'
  | 'stamp'
  | 'measure-distance'
  | 'measure-angle'
  | 'measure-area'
  | 'signature'
  | 'redaction'
  | 'scratchpad';

export type EraserMode = 'stroke' | 'object' | 'pixel';

export type ViewMode = 'continuous' | 'single' | 'two-page';

export type ThemeMode = 'dark' | 'light' | 'system';

export type LanguageMode = 'en' | 'fa';

export type BackgroundPattern = 'none' | 'grid' | 'dots' | 'isometric' | 'lined';

export interface Point {
  x: number;
  y: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  time?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number; // radians
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  order: number;
}

export interface BaseAnnotation {
  id: string;
  pageIndex: number;
  layerId: string;
  type: ToolType;
  box: BoundingBox;
  createdAt: number;
  updatedAt: number;
  opacity: number;
  blendMode?: GlobalCompositeOperation;
  locked?: boolean;
  /**
   * Rotation in radians about the BOX CENTER. The stored box stays unrotated;
   * renderers rotate at paint time, so move/resize math keeps working in the
   * unrotated frame. Undefined/0 = unrotated.
   */
  rotation?: number;
}

export interface StrokePoint extends Point {
  pressure: number;
  tiltX?: number;
  tiltY?: number;
}

export interface PenAnnotation extends BaseAnnotation {
  type: 'pen';
  points: StrokePoint[];
  color: string;
  strokeWidth: number;
  smoothing?: boolean;
  strokeSmoothing?: 'none' | 'subtle' | 'medium' | 'high';
  taper?: boolean;
  pressureEnabled?: boolean;
  pressureCurve?: 'linear' | 'soft' | 'firm' | 'exponential';
  pressureStrength?: 'light' | 'balanced' | 'strong';
}

export interface HighlighterAnnotation extends BaseAnnotation {
  type: 'highlighter';
  points: StrokePoint[];
  color: string;
  strokeWidth: number;
  blendMode: 'multiply' | 'source-over';
  straightLine?: boolean;
  tipShape?: 'chisel' | 'round';
}

export interface ShapeAnnotation extends BaseAnnotation {
  type: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'freeform-shape';
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
  /** False = fill-only shape with no outline stroke (ignored by line/arrow). */
  outline?: boolean;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  /** Optional radius in page points. Zero preserves legacy square corners. */
  cornerRadius?: number;
  points?: Point[]; // for polygon, line, arrow, freeform
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

export interface TextAnnotation extends BaseAnnotation {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: string | number;
  fontStyle?: 'normal' | 'italic';
  color: string;
  backgroundColor?: string;
  borderColor?: string;
  textAlign: 'left' | 'center' | 'right';
  padding?: number;
}

export interface StampAnnotation extends BaseAnnotation {
  type: 'stamp';
  stampType: 'preset' | 'custom';
  presetKey?: string; // e.g., 'APPROVED', 'CONFIDENTIAL'
  imageUrl?: string;
  svgData?: string;
  color?: string;
}

export interface MeasurementAnnotation extends BaseAnnotation {
  type: 'measure-distance' | 'measure-angle' | 'measure-area';
  points: Point[];
  unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px';
  scaleRatio: number; // e.g., 1 px = 0.5 mm
  color: string;
  strokeWidth: number;
  measuredValue: number; // formatted value
  label: string;
}

export interface SignatureAnnotation extends BaseAnnotation {
  type: 'signature';
  points?: StrokePoint[][];
  svgData?: string;
  pngDataUrl?: string;
  color: string;
}

export interface RedactionAnnotation extends BaseAnnotation {
  type: 'redaction';
  color: string; // usually #000000 or #FFFFFF
  overlayText?: string;
  applied?: boolean; // false = pending redaction mark, true = applied/scrubbed
}

export type Annotation =
  | PenAnnotation
  | HighlighterAnnotation
  | ShapeAnnotation
  | TextAnnotation
  | StampAnnotation
  | MeasurementAnnotation
  | SignatureAnnotation
  | RedactionAnnotation;

export interface PageInfo {
  pageIndex: number;
  pageNumber: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  rotation: number; // 0, 90, 180, 270
}

export interface PDFBookmarkItem {
  title: string;
  dest?: any;
  pageIndex?: number;
  items?: PDFBookmarkItem[];
}

export type PaperPattern = 'blank' | 'lined' | 'grid' | 'dots' | 'isometric';

/** How a notebook's paper looks. Drawn into the PDF, so it exports as seen. */
export interface PaperStyle {
  pattern: PaperPattern;
  /** Gap between rules, dots or grid lines, in points. */
  spacing: number;
  /** Colour of the rules/dots. */
  lineColor: string;
  /** Colour of the sheet itself. */
  paperColor: string;
  /** Draw a vertical margin rule near the binding edge. */
  margin: boolean;
}

/** Global zoom bounds (raised so marquee-lens zooms can stack repeatedly). */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

/** Default toolbar button order (undo/redo stay pinned separately). */
export const DEFAULT_TOOLBAR_ORDER: ToolType[] = [
  'select', 'lasso', 'hand', 'zoom-lens',
  'pen', 'highlighter', 'eraser',
  'rectangle', 'ellipse', 'line', 'arrow', 'polygon',
  'text', 'stamp', 'measure-distance', 'signature', 'redaction', 'scratchpad'
];

/** Visual family per toolbar tool; separators render between families. */
export function toolbarFamily(id: ToolType): string {
  if (id === 'select' || id === 'lasso' || id === 'hand' || id === 'zoom-lens') return 'nav';
  if (id === 'pen' || id === 'highlighter' || id === 'eraser') return 'ink';
  if (id === 'rectangle' || id === 'ellipse' || id === 'line' || id === 'arrow' || id === 'polygon') return 'shapes';
  return 'annotate';
}

/**
 * Tools that draw multi-segment geometry and therefore honour the Snap-15° and
 * Connect-lines options. Single-box shapes (rectangle/ellipse) are axis-aligned
 * and have nothing to constrain or chain.
 */
export const SEGMENT_TOOLS: ToolType[] = ['line', 'arrow', 'polygon', 'freeform-shape'];

/** Per-tool toggles surfaced in the shape hover cards rather than Settings. */
export type ToolOptionKey = 'snapAngle15' | 'connectLines';

export const PAGE_SIZES = {
  letter: { label: 'Letter', width: 612, height: 792 },
  a4: { label: 'A4', width: 595, height: 842 },
  a5: { label: 'A5', width: 420, height: 595 },
  square: { label: 'Square', width: 720, height: 720 },
  wide: { label: 'Wide', width: 1024, height: 640 }
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/**
 * Marks a document as an app-generated notebook rather than an imported file.
 * Its bytes are fully derived from this spec plus its page count, so it can be
 * re-styled or extended by rebuilding them.
 */
export interface NotebookSpec {
  paper: PaperStyle;
  pageSize: PageSizeName;
}

export interface DocumentSession {
  id: string;
  name: string;
  fileData?: Uint8Array;
  pageCount: number;
  pages: PageInfo[];
  bookmarks: PDFBookmarkItem[];
  annotations: Record<number, Annotation[]>; // pageIndex -> annotations
  layers: Record<number, Layer[]>;           // pageIndex -> layers
  activePageIndex: number;
  /** Exact pixel scroll offsets for per-tab restore (layout space, CSS px). */
  savedScrollTop?: number;
  savedScrollLeft?: number;
  createdAt: number;
  lastModifiedAt: number;
  /** Last time Save wrote bytes to IDB/disk. Absent = never saved (dirty). */
  lastSavedAt?: number;
  /** Present only for generated notebooks; see NotebookSpec. */
  notebook?: NotebookSpec;
  /**
   * Absolute on-disk path this session was opened from (desktop only).
   * Lets re-opening the same file — via the file picker, a double-click
   * file association, or the second-instance handoff — resume the same
   * session (last page, scroll position, unsaved annotations) instead of
   * starting a second, disconnected tab, and lets Save write straight back
   * to this path without a dialog.
   */
  nativeFilePath?: string;
}

/**
 * Pages copied or cut from the thumbnail list, kept as a standalone PDF so they
 * can be pasted into a different document (or the same one, repeatedly).
 */
export interface PageClipboard {
  bytes: Uint8Array;
  pageCount: number;
  /** Point size of the first copied page, used for blank-page insertion too. */
  width: number;
  height: number;
  sourceName: string;
}

export type DrawingCursorType = 'pen' | 'dot' | 'circle' | 'crosshair';

export type ToolbarDock = 'top' | 'bottom' | 'left' | 'right';

/**
 * Returns the window edge nearest a toolbar drag release, so a dropped bar
 * docks to the flank the user was aiming at.
 */
export function classifyToolbarDock(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number
): ToolbarDock {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  const distances = {
    left: clientX,
    right: w - clientX,
    top: clientY,
    bottom: h - clientY
  };
  let best: ToolbarDock = 'top';
  let bestDistance = distances.top;
  (Object.keys(distances) as ToolbarDock[]).forEach(edge => {
    if (distances[edge] < bestDistance) {
      best = edge;
      bestDistance = distances[edge];
    }
  });
  return best;
}

export type SidebarTab = 'thumbnails' | 'outline' | 'search' | 'history';

export interface ToolSettings {
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  highlighterBlendMode: 'multiply' | 'source-over';
  highlighterStraightLine: boolean;
  highlighterTipShape: 'chisel' | 'round';
  highlighterOpacity: number;
  highlighterCursor: 'rectangle' | 'chisel' | 'circle' | 'crosshair' | 'dot';
  eraserMode: EraserMode;
  eraserWidth: number;
  shapeColor: string;
  shapeFillColor: string;
  shapeWidth: number;
  shapeOutline: boolean;
  shapeStyle: 'solid' | 'dashed' | 'dotted';
  textColor: string;
  textBgColor: string;
  fontSize: number;
  fontFamily: string;
  textAlign: 'left' | 'center' | 'right';
  measureUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px';
  measureScale: number; // calibrated scale
  pressureSensitivityEnabled: boolean; // toggle pressure sensitivity on/off
  mousePressureSimulation: boolean;    // simulate pressure with mouse velocity
  pressureCurve: 'linear' | 'soft' | 'firm' | 'exponential';
  pressureStrength: 'light' | 'balanced' | 'strong';
  strokeSmoothing: 'none' | 'subtle' | 'medium' | 'high';
  palmRejectionEnabled: boolean;
  stylusInvertedEraserEnabled: boolean;
  drawingCursor: DrawingCursorType;
  stampPreset: string;
  redactionColor: string;
  /**
   * Per-tool: constrain the tool's segments to 15° increments. Lives here (and
   * not in AppSettings) because it is a drawing option of the shape tools, so
   * it is surfaced in their hover cards and is only meaningful for SEGMENT_TOOLS.
   */
  snapAngle15: Partial<Record<ToolType, boolean>>;
  /** Per-tool: merge coincident line endpoints into a continuous path. */
  connectLines: Partial<Record<ToolType, boolean>>;
}

export interface AppSettings {
  theme: ThemeMode;
  accentColor: string;
  language: LanguageMode;
  backgroundPattern: BackgroundPattern;
  autoSaveIntervalMs: number;
  snapToGrid: boolean;
  gridSize: number;
  hardwareAcceleration: boolean;
  maxRenderBufferPages: number;
  showRuler: boolean;
  showPageShadows: boolean;
  defaultZoomMode: 'fitWidth' | 'fitPage' | '100%' | '125%' | '150%' | 'lastUsed';
  defaultViewMode: 'continuous' | 'single' | 'two-page';
  uiDensity: 'comfortable' | 'compact';
  smoothScroll: boolean;
  invertDocumentOled: boolean;
  /**
   * Canvas render resolution in DPI (PDF point grid is 72). Replaces the
   * legacy boolean `retinaRendering`: 72 = 1x, 144 = 2x, etc. When unset the
   * system DPI (72 * devicePixelRatio) is used.
   */
  targetDPI: number;
  /** Which window edge the floating toolbar is docked to. */
  toolbarDock: ToolbarDock;
  /**
   * User-added colors, offered as extra swatches after the built-in set on
   * every pen/highlighter/shape/text color picker so a personal palette
   * carries across tools and sessions instead of being re-typed each time.
   */
  customPalette: string[];
  /**
   * Built-in swatches the user removed, as `"${group}:${color}"` entries
   * (e.g. `"pen:#000000"`) — the group keeps removal scoped to the picker it
   * was removed from instead of hiding that color everywhere it happens to
   * also appear as a default.
   */
  removedDefaultColors: string[];
}

export interface PDFFolder {
  id: string;
  name: string;
  color: string;
  icon: string;
  createdAt: number;
}

export interface RecentDocItem {
  id: string;
  name: string;
  pageCount: number;
  lastOpenedAt: number;
  folderId?: string | null;
}
