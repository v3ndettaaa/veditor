/**
 * Core Type Definitions for veditor
 */

export type ToolType =
  | 'select'
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
  | 'laser'
  | 'callout'
  | 'signature'
  | 'redaction';

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
  taper?: boolean;
  pressureEnabled?: boolean;
  pressureCurve?: 'linear' | 'soft' | 'firm' | 'exponential';
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
  strokeStyle: 'solid' | 'dashed' | 'dotted';
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

export interface CalloutAnnotation extends BaseAnnotation {
  type: 'callout';
  arrowPoint: Point;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  fillColor: string;
  strokeColor: string;
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
  | CalloutAnnotation
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
  createdAt: number;
  lastModifiedAt: number;
  /** Present only for generated notebooks; see NotebookSpec. */
  notebook?: NotebookSpec;
}

export type DrawingCursorType = 'pen' | 'dot' | 'circle' | 'crosshair';

export type SidebarTab = 'thumbnails' | 'outline' | 'layers' | 'search' | 'history';

export interface ToolSettings {
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  highlighterBlendMode: 'multiply' | 'source-over';
  highlighterStraightLine: boolean;
  highlighterTipShape: 'chisel' | 'round';
  eraserMode: EraserMode;
  eraserWidth: number;
  shapeColor: string;
  shapeFillColor: string;
  shapeWidth: number;
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
  retinaRendering: boolean;
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
