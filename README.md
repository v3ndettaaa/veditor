# veditor 🖋️
> **A World-Class, Production-Ready PDF Annotation & Editing Browser Extension for Chrome & Firefox**

[![Tests](https://img.shields.io/badge/tests-16%20passed-brightgreen.svg)](#testing)
[![Target](https://img.shields.io/badge/target-Chrome%20MV3%20%7C%20Firefox-blue.svg)](#installation)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)
[![Offline](https://img.shields.io/badge/offline-100%25%20private-emerald.svg)](#privacy--offline-guarantee)

**veditor** is an ultra-fast, professional-grade PDF editor and annotator browser extension. Engineered with a lightweight core, modern minimalist design system inspired by Linear, Arc, and Figma, full stylus and pressure sensitivity support, multi-layer canvas virtualization, and lossless PDF export.

---

## ✨ Key Features

### 1. Document Handling & Performance
- **Large Document Support**: Smooth 60fps scrolling and instant navigation across 500+ page PDFs with smart viewport virtualization.
- **Multiple Documents**: Open multiple PDFs simultaneously in internal tab strips.
- **Auto-Save & Version History**: Continuous background persistence to IndexedDB; never lose an annotation stroke.
- **Import Options**: Drag and drop anywhere, file picker, or direct URL loading.

### 2. Professional Drawing & Annotation Suite
- **Freehand Pen**: Organic ink strokes powered by Centripetal Catmull-Rom splines, dynamic stroke width calculation, and configurable pressure curves (Linear, Soft, Firm, Exponential).
- **Highlighter**: Non-destructive highlighting with Multiply blend mode.
- **Eraser**: 3 smart modes:
  - *Stroke Eraser*: Deletes entire strokes upon touch.
  - *Object Eraser*: Deletes entire shapes, stamps, or text boxes upon hit.
  - *Pixel Eraser*: Masks and scrubs pixels with circular indicator.
- **Shapes & Vector Tools**: Rectangle, Ellipse, Line, Arrow, Polygon, and Freeform shapes with customizable stroke styles (solid, dashed, dotted) and fills.
- **Rich Text Boxes**: Multi-line typography with custom fonts, colors, borders, and alignment.
- **Preset Vector Stamps**: APPROVED, CONFIDENTIAL, DRAFT, REVISED, SIGN HERE, FINAL, VOID, URGENT, PAID, plus custom image insertion.
- **Technical Measurement**: Calibrated distance, angle, and polygon area calculation with real-world units (`mm`, `cm`, `m`, `in`, `ft`, `pt`, `px`).
- **Presentation Laser Pointer**: Ephemeral glow pointer with a 1-second decaying trail.
- **Speech Bubble / Callout**: Directional callout arrows with text containers.
- **Digital Signatures**: Vector ink signature drawing pad with persistent signature library.
- **True Redaction**: Permanent black/white content scrubbing that strips underlying text and graphics on export.

### 3. Stylus & Touch Excellence
- **Coalesced Pointer Events**: Full 120Hz/240Hz polling support on Apple Pencil, Surface Pen, and Wacom styluses.
- **Palm Rejection Engine**: Automatically detects and rejects palm/wrist resting contact.
- **Stylus Button Mapping**: Inverted eraser tip auto-activates the Eraser; barrel button triggers selection.
- **Multi-Touch Gestures**: Seamless two-finger pinch-to-zoom and two-finger panning.

### 4. UI/UX Design System & Persian Support
- **Typography**: Persian with variable **Vazirmatn** font; English with **Inter / Google Sans** (100% self-hosted & offline).
- **Dynamic RTL**: Instant switching between English (LTR) and Persian (RTL) with mirrored layouts.
- **Appearance**: Dark mode, Light mode, and customizable accent colors.
- **Command Palette (`Cmd + K`)**: Instant fuzzy search over all actions, tools, navigation, and settings.
- **Collapsible Panels**: Page Thumbnails (with annotation badges), Bookmarks/Outline, Layers, Search, and Action History.
- **Paper Background Patterns**: Clean blank, grid paper, dot grid, lined legal notebook, and isometric grid.

### 5. PDF Export & Interoperability
- **Flattened PDF**: High-resolution canvas rendering (72, 150, 300, 600 DPI) onto the PDF content stream via `pdf-lib`.
- **Vector PDF Annotations**: Preserves native PDF annotations for Adobe Acrobat and Apple Preview.
- **Image Export**: Export current page or page ranges to PNG / JPEG with custom DPI.
- **Data Export & Import**: JSON and standard XFDF (XML Forms Data Format) export and import.

---

## 🚀 Installation

### Chrome / Brave / Edge (Manifest V3)
1. Download or build the extension: `dist/veditor-chrome.zip` or the unpacked `dist/chrome` folder.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `dist/chrome` folder (or unzip `dist/veditor-chrome.zip` first).
5. Pin `veditor` to your toolbar!

### Firefox (WebExtensions)
1. Download or build the extension: `dist/veditor-firefox.zip` or the unpacked `dist/firefox` folder.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `dist/firefox/manifest.json` (or `dist/veditor-firefox.zip`).
5. `veditor` is immediately active!

---

## 🛠️ Development & Building

### Prerequisites
- Node.js v18+ (tested on v26)
- npm v9+

### Commands
```bash
# Install dependencies
npm install

# Run local development server
npm run dev

# Run automated tests (Vitest)
npm run test

# Build Chrome extension (dist/chrome)
npm run build:chrome

# Build Firefox extension (dist/firefox)
npm run build:firefox

# Build both extensions and create zip packages (dist/veditor-chrome.zip & dist/veditor-firefox.zip)
npm run package
```

---

## 📁 Architecture Overview

```
veditor/
├── manifest.chrome.json            # Chrome MV3 manifest
├── manifest.firefox.json           # Firefox WebExtension manifest
├── vite.config.ts                  # Multi-target Vite build configuration
├── index.html                      # Standalone full-screen editor app
├── popup.html                      # Browser toolbar action popup
├── public/
│   ├── icons/                      # Extension icons (16, 32, 48, 128px)
│   └── pdf.worker.min.mjs          # Offline Mozilla PDF.js worker
├── src/
│   ├── background/
│   │   └── service-worker.ts       # Context menus & tab manager
│   ├── core/
│   │   ├── types.ts                # Strict TypeScript models
│   │   ├── store.ts                # Reactive state store
│   │   ├── history.ts              # Command-pattern Undo/Redo stack
│   │   ├── pdf-engine.ts           # PDF.js document loader & page renderer
│   │   └── viewport.ts             # Virtualized scroll & viewport coordinator
│   ├── annotations/
│   │   ├── engine.ts               # Master multi-layer canvas coordinator
│   │   ├── spline.ts               # Catmull-Rom smoothing & pressure ink
│   │   ├── selection.ts            # 8-handle transform box & alignment
│   │   ├── layers.ts               # Unlimited layers manager
│   │   └── tools/                  # Complete suite of 12 annotation tools
│   ├── input/
│   │   ├── pointer-handler.ts      # 120/240Hz coalesced pointer pipeline
│   │   ├── pressure.ts             # Pressure calibration curves
│   │   ├── palm-rejection.ts       # Palm detection heuristics
│   │   └── gestures.ts             # Pinch-to-zoom & two-finger pan
│   ├── io/
│   │   ├── storage.ts              # IndexedDB auto-save & versioning
│   │   ├── export-pdf.ts           # pdf-lib vector & flattened PDF export
│   │   ├── export-image.ts         # High-DPI PNG/JPEG image export
│   │   └── export-data.ts          # JSON & XFDF annotation data export
│   ├── ui/
│   │   ├── styles/                 # Tokens, modern dark/light CSS, Persian RTL
│   │   ├── components/             # Toolbar, panels, modals, palette, dialogs
│   │   └── i18n/                   # English & Persian (فارسی) translations
│   └── main.ts                     # Application bootstrap
└── tests/                          # Automated Vitest test suite
```

---

## 🔒 Privacy & Offline Guarantee
- **100% Offline**: All font files, PDF.js workers, and dependencies are self-hosted and bundled locally.
- **Zero Telemetry**: No tracking, no external API requests, no third-party cookies.
- **Data Ownership**: All annotations and documents remain solely on your device in your local IndexedDB storage.

---

## ⌨️ Keyboard Shortcuts
See [SHORTCUTS.md](SHORTCUTS.md) for the complete reference table.

---

## 📄 License
MIT License. Created with ❤️ for high-performance PDF annotation.
