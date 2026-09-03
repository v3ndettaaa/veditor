# Chrome Web Store & Firefox Add-on Listing Documentation

**Extension Name**: veditor – World-Class PDF Editor & Annotator  
**Version**: 1.0.0  
**Category**: Productivity / Tools  
**Default Language**: English  
**Supported Languages**: English, Persian (فارسی)  

---

## Short Description (Under 132 Characters)
World-class, high-performance offline PDF annotator and editor with stylus pressure support, modern UI, and real PDF export.

---

## Detailed Description
veditor is a complete, stunning, high-performance PDF editor and annotator browser extension designed for students, researchers, architects, engineers, and professionals.

Whether you are annotating lecture slides, reviewing contracts, signing documents, or analyzing architectural blueprints, veditor delivers the buttery smooth responsiveness and rich feature set of premier desktop applications right in your browser.

### Key Features:
- 🖋️ **Professional Drawing & Ink Engine**: Ultra-smooth freehand pen with Catmull-Rom spline interpolation, pressure sensitivity curves (linear, soft, firm, exponential), tilt support, and stroke tapering.
- 🖍️ **Highlighter**: Non-destructive highlighter with Multiply blend mode so underlying text remains razor-sharp.
- 🧹 **Smart Eraser**: Stroke Eraser (delete whole stroke on touch), Object Eraser, and Pixel Eraser modes.
- 📐 **Technical Measurement Tools**: Calibrated distance, angle, and polygon area measurement with real-world units (mm, cm, m, in, ft, pt, px).
- 🔲 **Shapes & Callouts**: Rectangles, ellipses, straight lines, arrows, polygons, and directional callout speech bubbles.
- ✍️ **Digital Signatures**: Hand-draw or upload signatures with persistent signature library storage.
- 🏷️ **Built-in Vector Stamps**: APPROVED, CONFIDENTIAL, DRAFT, REVISED, SIGN HERE, FINAL, VOID, URGENT, PAID.
- 🔒 **True Redaction**: Safely redact sensitive and confidential information permanently before sharing.
- 🎯 **Stylus & Input Excellence**: 120/240Hz coalesced pointer events polling, intelligent palm rejection heuristics, stylus eraser button auto-switching, and multi-touch pinch-to-zoom.
- 🚀 **Extreme Virtualization Performance**: Fluid 60fps scrolling and memory management even on 500+ page heavy documents.
- 📄 **Perfect PDF Export**: Embedded vector PDF annotations (compatible with Adobe Acrobat) or lossless high-resolution page flattening (72, 150, 300, 600 DPI). Also supports JSON and XFDF data export/import.
- 🌐 **Persian & English Support**: Native Persian (فارسی) interface with embedded Vazirmatn variable font, full RTL layout, and English (Inter) font.
- 🛡️ **100% Offline & Private**: Zero external network requests, zero telemetry, zero analytics. All documents stay strictly inside your browser.

---

## Permissions Justification

| Permission | Plain-English Justification |
|---|---|
| `storage` | Required to persist your annotations, recent document sessions, and user settings locally using IndexedDB so work is never lost. |
| `tabs` | Required to open the full-screen editor workspace in a dedicated browser tab when clicking extension actions or opening PDF links. |
| `contextMenus` | Allows you to right-click any PDF link on the web or page and select "Open PDF in veditor". |

---

## Privacy Policy & Disclosures
- **Data Collection**: None. veditor does not collect, transmit, or monetize any user data, browsing history, or documents.
- **Network Usage**: 100% offline. All PDF rendering, annotation processing, and export routines execute locally on your machine.
- **Third-Party Services**: None. No trackers, no telemetry, no analytics.
