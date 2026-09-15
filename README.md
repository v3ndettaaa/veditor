<div align="center">

<img src="public/icons/icon-128.png" width="96" height="96" alt="veditor logo" style="border-radius: 20px; box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);" />

# veditor

### **Ultra-Fast, World-Class Offline PDF Editor & Annotation Suite**
*Engineered for Chrome (Manifest V3) & Firefox (WebExtensions)*

[![Tests](https://img.shields.io/badge/tests-39%20passed-brightgreen.svg)](#-automated-testing)
[![Target](https://img.shields.io/badge/target-Chrome%20MV3%20%7C%20Firefox-blue.svg)](#-installation)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)
[![Offline](https://img.shields.io/badge/offline-100%25%20Private%20(Zero%20Telemetry)-emerald.svg)](#-privacy--offline-guarantee)
[![Language](https://img.shields.io/badge/i18n-English%20%7C%20فارسی%20(RTL)-orange.svg)](#-multilingual--full-rtl-support)

[**Quickstart**](#-installation) • [**Key Features**](#-key-features) • [**Settings & Customization**](#-settings--preferences-hub) • [**Keyboard Shortcuts**](#-keyboard-shortcuts) • [**Architecture**](#-project-architecture)

---

</div>

**veditor** is a professional-grade, high-performance browser extension for reading, editing, and annotating PDFs. Crafted with a modern design system inspired by Linear, Arc, and Figma, it delivers sub-millisecond drawing latency, full hardware stylus pressure sensitivity, continuous viewport virtualization for massive 500+ page books, and 100% offline privacy with zero telemetry.

---

## ✨ Key Features

### 📐 Custom Multi-Point Polygon & Shapes
- **Interactive Multi-Point Polygon (`G`)**: Click consecutive points on the page to build complex custom vector shapes with live rubber-band preview line and interactive vertex indicators.
- **Auto-Closing Detection**: Hovering within 14px of the start point illuminates a green target ring; clicking or double-clicking snaps the polygon closed.
- **Geometric Vector Library**: Rectangles (`R`), Ellipses (`O`), Lines (`L`), Arrows (`A`), and Polygons (`G`) with customizable stroke width, fill color, and styles (Solid, Dashed, Dotted).

### 🖍️ Advanced Highlighter with Straight-Line Auto-Snap
- **Straight-Line Snapping**: Hold the **`Shift`** key while dragging or toggle "Straight Snap" in the highlighter popover to draw crisp, level horizontal or vertical highlights over lines of text.
- **Chisel Tip vs. Round Tip**: Choose between classic stationery flat chisel marker tips or rounded brush caps.
- **True Translucency**: Any picked color is rendered as translucent alpha-blended ink, so highlights never paint opaque blocks over your text.

### ✌️ Lag-Free Touch Gestures
- **Two-Finger Pinch-to-Zoom**: Zooms the PDF around your fingers with a buttery compositor preview — no re-layouts, re-renders, or stray marks mid-gesture. A second finger safely aborts any in-progress stroke.
- **Two-Finger Pan**: Glide around large pages with two fingers, on any device.
- **Trackpad Pinch**: The same single-commit zoom path powers `Ctrl` + scroll, so fast pinches never stutter.

### ⌨️ Precise Typed Input — No Sliders, No Guesswork
- **Type Any Number**: Pen / highlighter / eraser / shape widths, font sizes, opacity, page numbers, and zoom % all accept exact typed values (`Enter` commits, `Esc` reverts).
- **Type Any Color**: Every color swatch row takes hand-typed hex (`#4f46e5`, short `#f43` and `#`-less forms work too).
- **Quick Presets Stay**: One-click pills and swatches remain for the common values.

### 🎯 Configurable Drawing Cursors
- **Tailored Pointer Styles**: Switch between **Pen** (sleek vector fountain pen nib with hotspot at tip), **Dot** (minimalist 4px precision center dot), **Circle** (dynamic stroke width target ring), and **Crosshair** (classic drafting reticle).
- Easily toggle cursors directly from the Settings modal or from the Pen & Highlighter hover card.

### 🖼️ Zero-Blank Frame Rendering & Anti-Scramble Stability
- **Zero-Blank Frame Double-Buffering**: Eliminates white canvas flashing during fast scrolling or zooming by maintaining warm bitmap cache placeholders scaled to fit while high-res renders compute.
- **Multi-Size PDF Geometry Synchronization**: Automatically inspects viewports for varied page sizes/rotations and dynamically updates layouts so pages never scramble or distort.
- **Stale Render Collision Prevention**: Verifies canvas page bindings before blitting offscreen bitmaps, ensuring high-speed scrolling never renders mismatched page contents.

### 📁 Distraction-Free Landing Page & Folder Categories
- **Clean Focus State**: The floating drawing toolbar, view control pill, and sidebar remain cleanly hidden on the landing page, appearing only when a document is opened.
- **Custom Category Folders**: Organize opened PDFs into custom folders with personalized color swatches (Indigo, Emerald, Rose, Amber, Purple, Cyan, Blue, Crimson) and vector icons (📁 Folder, 📖 Book, 💼 Work, ⭐ Star, 🏷️ Tag, 💻 Code).
- **One-Click Re-categorization**: Move PDFs into any folder directly from recent document cards via an instant dropdown, with document count badges on folder filter pills.
- **Safe Folder Management**: Deleting a folder unassigns its files back to Uncategorized so no document history is ever lost.

### 📑 Multi-Tab Workspace
- **Simultaneous Document Tabs**: Open multiple PDFs concurrently in the upper tab strip with dedicated tabs for each file.
- **Instant Tab Switching**: Switch between open PDFs in `<1ms` via in-memory document caching without re-parsing binary data or re-downloading fonts.
- **Isolated Undo/Redo Stacks**: Every document preserves its own history stack, ensuring `Ctrl+Z` and `Ctrl+Y` actions remain strictly scoped to the active document.
- **Interactive Add Tab (`+`) Button**: Effortlessly load additional files directly from the tab strip.

### ⚡ Interactive Page Navigation
- **Direct Page Jump Field**: Click the page counter (`X / Total`) in the bottom pill, type any page number, and press **Enter** to jump immediately with automatic boundary validation and smooth scrolling — works in Continuous, Single, and Book Spread modes alike.
- **Typed Zoom**: The zoom readout (`100%`) next to it is also a field — type any percentage from 20 to 500.
- **Keyboard Stepping**: Use **Arrow Up** / **Arrow Down** while focused in the page box to step through pages sequentially.

### 🖊️ Natural Drawing & Ink Dynamics
- **Freehand Pen**: Organic ink strokes powered by Centripetal Catmull-Rom splines for natural curves without corner artifacts.
- **Dynamic Pressure Sensitivity**: Master toggle to turn pressure sensitivity **ON or OFF**. When disabled, strokes render at a consistent uniform width with zero jitter.
- **Mouse & Trackpad Speed Pressure Simulation**: Dynamically mimics natural pen pressure variations based on cursor drawing speed.
- **Pressure Calibration Curves**: Choose between **Linear (1:1)**, **Soft (Light Touch)**, **Firm (Calligraphy/Hard Press)**, and **Exponential (High Dynamic Range)** curves.
- **Thickness Dynamic Range**: Configurable stroke expansion presets: **Subtle** (0.6x - 1.4x), **Balanced** (0.3x - 1.8x), and **Dramatic** (0.1x - 2.4x).
- **Stroke Smoothing**: Multi-stage stabilization from raw input up to cinematic streamline smoothing.
- **Intelligent Palm Rejection**: Filters out wrist and palm contact when drawing with an active stylus.
- **Inverted Tip Auto-Eraser**: Stylus hardware eraser tail automatically switches tools when brought near the screen.

### 🛠️ Complete Annotation Toolset
| Tool | Shortcut | Description |
| :--- | :---: | :--- |
| **Selection & Transform** | `V` | 8-point bounding box resize, drag reposition, multi-select, and alignment |
| **Lasso Select** | `Q` | Freehand loop around ink to select everything it encloses (Alt+drag from any tool) |
| **Freehand Pen** | `P` | Dynamic ink with custom colors, opacity, stroke widths, and pressure dynamics |
| **Highlighter** | `H` | Non-destructive highlighting with chisel/round tips, straight snap & multiply blend |
| **Eraser** | `E` | 3 modes: Stroke Eraser, Object Eraser, and Pixel/Mask Eraser — each drag is a single undo step, so long erasing sessions never lag |
| **Polygon Shape** | `G` | Multi-point custom polygon shape with click-to-place vertices, an elastic segment that follows the cursor, and close detection |
| **Geometric Shapes** | `R`, `O`, `L`, `A` | Rectangles, Ellipses, Lines, and Arrows with solid/dashed/dotted borders and fills |
| **Rich Text Boxes** | `T` | Multi-line text boxes with font sizing, colors, borders, and background fills |
| **Vector Stamps** | `M` | High-res vector presets (`APPROVED`, `CONFIDENTIAL`, `DRAFT`, etc.) & image imports |
| **Digital Signatures** | `K` | Vector ink signature capture dialog with persistent local signature library |
| **True Redaction** | `X` | Content censoring that strips underlying text and graphics upon export |

---

## ⚙️ Settings & Preferences Hub

Access the comprehensive Settings Modal from the gear icon in the header:
- **Appearance**: Dark mode, Light mode, UI density (Comfortable vs. Compact), and custom Accent Brand Colors (swatches + hex color picker).
- **Paper Patterns**: Blank canvas, Square Grid, Dot Grid, Lined Paper, and Isometric 3D Drafting Grid.
- **Pen & Input**: Pressure sensitivity toggle, mouse speed simulation, calibration response curves, dynamic thickness range, and stroke stabilization.
- **Viewer & Reading**: Default view mode (Continuous Vertical, Single Page, Two-Page Book Spread), default zoom presets (Fit Width, Fit Page, 100%, 125%, 150%), and realistic drop shadows.
- **Performance**: Custom canvas render DPI (72–600, with preset chips and a live effective-scale readout), off-screen page buffer distance, and force VRAM reclaim button.
- **Storage & Backup**: Configurable auto-save frequency, IndexedDB database reset, and complete settings restore.
- **About**: Version information, keyboard shortcuts dialog, and direct GitHub links.

---

## 🌐 Multilingual & Full RTL Support

veditor is built from the ground up for seamless bidirectional localization:
- **English**: Modern typography utilizing self-hosted **Inter / Google Sans**.
- **Persian (فارسی)**: Complete Right-to-Left (RTL) layout mirroring and native **Vazirmatn** typography.
- Switch instantly at any time via the language toggle (`EN` / `فا`) in the top navigation bar.

---

## 🚀 Installation

### Chrome / Brave / Edge (Manifest V3)
1. Build the extension or download the latest release:
   ```bash
   npm run build:chrome
   ```
2. Open your browser and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the upper-right corner.
4. Click **Load unpacked** and choose the `dist/chrome` folder.
5. Pin **veditor** to your browser toolbar for one-click access!

### Firefox (WebExtensions)
1. Build the Firefox target:
   ```bash
   npm run build:firefox
   ```
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `dist/firefox/manifest.json`.
5. **veditor** is immediately ready to annotate!

---

## 🛠️ Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Run local development server
npm run dev

# 3. Run automated unit test suite (Vitest)
npm run test

# 4. Compile production bundles
npm run build:chrome    # Chrome MV3 -> dist/chrome
npm run build:firefox   # Firefox WebExtensions -> dist/firefox

# 5. Build and generate distribution ZIP archives
npm run package         # Creates dist/veditor-chrome.zip and dist/veditor-firefox.zip
```

### 🧪 Automated Testing
All core mathematical algorithms, spline generation, pressure mappings, multi-tab switching, and undo/redo stacks are covered by automated unit tests:
```
✓ tests/eraser.test.ts (4 tests)
✓ tests/export.test.ts (3 tests)
✓ tests/folders.test.ts (4 tests)
✓ tests/geometry.test.ts (8 tests)
✓ tests/history.test.ts (4 tests)
✓ tests/polygon-highlighter.test.ts (10 tests)
✓ tests/spline.test.ts (6 tests)

Test Files  7 passed (7)
     Tests  39 passed (39)
```

---

## 🔒 Privacy & Offline Guarantee

- **100% Offline**: All font files, PDF.js web workers, and icons are bundled locally.
- **Zero Telemetry**: No tracking, no external API requests, no third-party cookies, and no telemetry pings.
- **Complete Data Ownership**: All annotations, drawings, and loaded documents reside solely in your browser's private `IndexedDB` storage.

---

## 📁 Project Architecture

```
veditor/
├── manifest.chrome.json            # Chrome MV3 manifest
├── manifest.firefox.json           # Firefox WebExtension manifest
├── vite.config.ts                  # Multi-target Vite bundling pipeline
├── index.html                      # Standalone full-screen editor app
├── popup.html                      # Browser toolbar popup interface
├── public/
│   ├── icons/                      # Extension vector icons (16, 32, 48, 128px)
│   └── pdf.worker.min.mjs          # Offline Mozilla PDF.js worker
├── src/
│   ├── background/
│   │   └── service-worker.ts       # Service worker & tab management
│   ├── core/
│   │   ├── types.ts                # Strict TypeScript domain models
│   │   ├── store.ts                # Reactive multi-document state store
│   │   ├── history.ts              # Command-pattern Undo/Redo stack
│   │   ├── pdf-engine.ts           # PDF.js document loader & page cache
│   │   └── viewport.ts             # Virtualized scroll & viewport coordinator
│   ├── annotations/
│   │   ├── engine.ts               # Multi-layer canvas coordinator
│   │   ├── spline.ts               # Catmull-Rom smoothing & pressure ink
│   │   ├── selection.ts            # 8-handle transform box & alignment
│   │   ├── layers.ts               # Layer manager (opacity, visibility, reordering)
│   │   └── tools/                  # 12 specialized annotation tools
│   ├── input/
│   │   ├── pointer-handler.ts      # Coalesced 120/240Hz pointer pipeline
│   │   ├── pressure.ts             # Pressure calibration curves & mouse simulation
│   │   ├── palm-rejection.ts       # Stylus palm rejection heuristics
│   │   └── gestures.ts             # Pinch-to-zoom & two-finger pan
│   ├── io/
│   │   ├── storage.ts              # IndexedDB persistence & session management
│   │   ├── export-pdf.ts           # pdf-lib vector & flattened PDF export
│   │   ├── export-image.ts         # High-DPI PNG/JPEG image export
│   │   └── export-data.ts          # JSON & XFDF annotation data export
│   ├── ui/
│   │   ├── styles/                 # Theme tokens, dark/light CSS, Persian RTL
│   │   ├── components/             # Toolbar, header, tabs, modals, dialogs
│   │   └── i18n/                   # English & Persian (فارسی) translations
│   └── main.ts                     # Application lifecycle bootstrap
└── tests/                          # Automated Vitest test suite
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
| :---: | :--- |
| `V` | Select / Transform Tool |
| `Q` | Lasso Select Tool |
| `P` | Freehand Pen Tool |
| `H` | Highlighter Tool |
| `E` | Eraser Tool |
| `T` | Text Tool |
| `R` | Rectangle Shape |
| `O` | Ellipse Shape |
| `L` | Line Tool |
| `A` | Arrow Tool |
| `G` | Multi-Point Polygon Shape |
| `M` | Vector Stamp Tool |
| `N` | Scratchpad |
| `K` | Digital Signature Pad |
| `X` | Redaction Tool |
| `Ctrl + Z` | Undo (Scoped to active PDF tab) |
| `Ctrl + Y` | Redo (Scoped to active PDF tab) |
| `Ctrl + +` / `Ctrl + -` | Zoom In / Zoom Out |
| `Ctrl + 0` | Fit Page to Width |
| `Ctrl + K` | Open Command Palette |
| `?` | View Keyboard Shortcuts Modal |

See [SHORTCUTS.md](SHORTCUTS.md) for the complete reference.

---

## 📄 License

MIT License. Designed and developed with ❤️ for high-performance offline document annotation.
For issues or feature requests, visit the [official GitHub repository](https://github.com/v3ndettaaa/veditor).
