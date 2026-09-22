# VEditor Feature Matrix (Day 1 — inventory, all `not-started`)

Status values Day-1: `not-started` for every migration row. Priority: P0 must-not-regress,
P1 important, P2 nice-to-have. "Target" is the planned owner, not an implemented move.

| Feature | Current implementation | Files involved | Migration target | Status | Priority |
|---|---|---|---|---|---|
| App bootstrap / shell | `VeditorApp` DOM bootstrap, `window.app` | `src/main.ts`, `index.html` | Stay TS (app layer) | not-started | P0 |
| Multi-tab workspace | `_openDocuments` map + tab strip, <1ms cached switch | `src/core/store.ts`, `src/core/pdf-engine.ts:85`, `src/ui/components/header.ts` | Stay TS; engine keyed by `DocumentId` | not-started | P0 |
| PDF load (picker/dnd/URL/IDB/native) | `loadPDF` + `openDocumentSession` | `src/main.ts:372-630`, `src/io/storage.ts`, `src/io/native-fs.ts` | Stay TS; `veditor-pdf` opens bytes/path Day-2 | not-started | P0 |
| PDF.js render + worker | `getDocument`, `page.render`, offline worker/cmaps/fonts | `src/core/pdf-engine.ts`, `vite.config.ts:75-101`, `public/pdf.worker.min.mjs` | `veditor-pdf` (MuPDF) desktop; keep pdf.js for extension | not-started | P0 |
| Page virtualization | `ViewportManager`, buffer 2.0x, rAF scroll | `src/core/viewport.ts`, `src/main.ts:946` | Stay TS; `veditor-render` tile cache Day-2+ | not-started | P0 |
| View modes | continuous/single/two-page layout | `src/core/viewport.ts:91`, `src/core/store.ts` | Stay TS | not-started | P0 |
| Zoom (wheel/pinch/dblclick/keys/typed) | focal zoom, preview+commit, fit modes | `src/core/viewport.ts:316-360`, `src/main.ts:819-930`, `src/ui/components/view-controls.ts` | Stay TS; `veditor-core Viewport` mirrors math | not-started | P0 |
| Render cache | LRU page 60, bitmaps cap 6, geomKey | `src/core/pdf-engine.ts:45-68,408-530` | `veditor-render` | not-started | P0 |
| Double-buffer blit | offscreen render + atomic drawImage + stale placeholder | `src/core/pdf-engine.ts:534` | `veditor-render` | not-started | P1 |
| Rotation (page/all) | record-only rotation, `rotatedPageSize` | `src/core/page-ops.ts`, `src/core/viewport.ts:23`, `src/core/store.ts` | `veditor-core` types + `veditor-pdf` size | not-started | P0 |
| Outline/bookmarks | `getOutline -> formatOutline` | `src/core/pdf-engine.ts:216-300`, `src/ui/components/side-panels.ts:242` | `veditor-pdf` | not-started | P1 |
| Thumbnails | `renderThumbnail/thumbnailFromCache`, IO observer | `src/core/pdf-engine.ts:595-697`, `src/ui/components/side-panels.ts` | `veditor-pdf` | not-started | P0 |
| Search (text find) | loop `getPageText`, snippet list, jump | `src/core/pdf-engine.ts:736`, `src/ui/components/side-panels.ts:257` | `veditor-pdf` text index Day-2+ | not-started | P0 |
| Pen tool | Catmull-Rom ink, pressure, smoothing | `src/annotations/tools/pen.ts`, `src/annotations/spline.ts`, `src/input/pressure.ts` | Stay TS; `veditor-ink` assists Day-2+ | not-started | P0 |
| Highlighter | straight-snap, chisel/round, multiply | `src/annotations/tools/highlighter.ts` | Stay TS | not-started | P0 |
| Eraser (3 modes) | stroke/object/pixel + split, single undo | `src/annotations/tools/eraser.ts` | Stay TS | not-started | P0 |
| Shapes | rect/ellipse/line/arrow/polygon/freeform + snap/connect | `src/annotations/tools/shapes.ts`, `src/utils/geometry.ts` | Stay TS | not-started | P0 |
| Draw-and-hold recognition | `fitStroke` + tween morph | `src/utils/shape-fit.ts`, `src/utils/tween.ts`, `src/input/pointer-handler.ts` | Stay TS | not-started | P1 |
| Text boxes | create + inline editor overlay | `src/annotations/tools/text.ts`, `src/ui/components/inline-editor.ts` | Stay TS | not-started | P0 |
| Stamps | 6 presets + image import | `src/annotations/tools/stamp.ts`, `tests/stamp.test.ts` | Stay TS | not-started | P0 |
| Signatures | capture dialog + local library | `src/annotations/tools/signature.ts`, `src/ui/components/signature-dialog.ts` | Stay TS | not-started | P0 |
| Redaction | mark + burn-in on export | `src/annotations/tools/redaction.ts`, `src/io/export-pdf.ts` | Stay TS | not-started | P0 |
| Measure | distance/angle/area + units | `src/annotations/tools/measure.ts` | Stay TS | not-started | P1 |
| Scratchpad | floating draft overlay, Insert-to-page | `src/ui/components/scratchpad.ts` | Stay TS | not-started | P1 |
| Selection/transform | 8-handle box, move/resize/rotate, align/distribute, z-order | `src/annotations/selection.ts`, `src/input/pointer-handler.ts` | Stay TS; `veditor-annotations` hit-test assists | not-started | P0 |
| Lasso/marquee select | ink-aware loop + rect, Alt+drag | `src/annotations/selection.ts`, `src/input/pointer-handler.ts` | Stay TS | not-started | P0 |
| Duplicate (Ctrl+D) | offset +12px clone | `src/annotations/duplicate.ts` | Stay TS | not-started | P1 |
| Clipboard image paste | PNG -> stamp annotation | `src/main.ts:setupClipboardImagePaste` | Stay TS | not-started | P1 |
| Pointer/stylus pipeline | coalesced events, palm rejection, tail eraser | `src/input/pointer-handler.ts`, `palm-rejection.ts`, `pressure.ts` | Stay TS; `veditor-ink` types mirror | not-started | P0 |
| Gestures | pinch-zoom + 2-finger pan, takeover cancels stroke | `src/input/gestures.ts`, `src/main.ts:1210` | Stay TS | not-started | P0 |
| Cursors | SVG per tool, zoom-scaled | `src/ui/cursor.ts` | Stay TS | not-started | P2 |
| Undo/redo | per-doc stacks, 8 command types | `src/core/history.ts` | Stay TS | not-started | P0 |
| Persistence (IDB) | sessions/recent/signatures/versions, autosave, scroll restore | `src/io/storage.ts` | Stay TS | not-started | P0 |
| Folders/landing/recents | categories, landing page, recent cards | `src/io/storage.ts`, `src/ui/components/landing-page.ts`, `src/ui/components/header.ts` | Stay TS | not-started | P1 |
| Page ops | insert/blank/delete/move/rotate/dup/copy-cut-paste | `src/core/page-ops.ts`, `src/core/page-actions.ts` | Stay TS; bytes8329 ops move to `veditor-pdf` later | not-started | P0 |
| Export PDF | flatten/vector, DPI, redaction, dark, ranges | `src/io/export-pdf.ts`, `src/io/save.ts`, `src/ui/components/save-as-dialog.ts` | Stay TS Day-1; flatten raster from `veditor-render` later | not-started | P0 |
| Export image | PNG/JPEG at DPI | `src/io/export-image.ts` | Stay TS | not-started | P1 |
| Export data | JSON/XFDF | `src/io/export-data.ts` | `veditor-annotations` serde compat | not-started | P1 |
| Native annotations | import/strip/sync FreeText/Highlight/Ink | `src/core/native-annotations.ts`, `src/core/native-ink.ts` | `veditor-pdf` | not-started | P0 |
| Layers | opacity/visibility/order | `src/annotations/layers.ts` (see engine), `src/core/types.ts` | Stay TS | not-started | P2 |
| Paper patterns | grid/dots/lined/isometric bkg | `src/annotations/engine.ts:renderBackgroundPattern` | Stay TS | not-started | P2 |
| Shortcuts + rebind | tool keys + fixed keys, conflict detect | `src/input/shortcuts.ts`, `src/main.ts`, `src/ui/components/settings-modal.ts,shortcuts-modal.ts` | Stay TS | not-started | P0 |
| Command palette (Ctrl+K) | fuzzy tool/command search | `src/ui/components/command-palette.ts` | Stay TS | not-started | P1 |
| Properties/floating panels | selection props editing | `src/ui/components/properties-panel.ts`, `floating-props.ts` | Stay TS | not-started | P1 |
| Settings hub | appearance/paper/pen/viewer/perf/storage/about | `src/ui/components/settings-modal.ts` | Stay TS | not-started | P1 |
| Themes/density/accent | dark/light, compact, brand colors | `src/ui/theme.ts`, `src/ui/styles/*` | Stay TS | not-started | P2 |
| i18n EN/FA RTL | full translation + mirroring | `src/ui/i18n/en.ts,fa.ts,index.ts` | Stay TS | not-started | P1 |
| Toasts/dialogs/menus | feedback + context menus | `src/ui/components/toast.ts,context-menu.ts,fs-context-menu.ts,notebook-dialog.ts` | Stay TS | not-started | P1 |
| Notebooks | generated paper PDFs | `src/core/notebook.ts`, `src/io/notebook.ts` | Stay TS | not-started | P2 |
| Extension service worker | action/context menus/OPEN_VEDITOR | `src/background/service-worker.ts`, manifests | Stay TS | not-started | P0 |
| Extension popup | open app/file/recents | `src/popup/popup.ts`, `popup.html` | Stay TS | not-started | P0 |
| Tauri shell | dialogs/fs/single-instance/startup file | `src-tauri/src/lib.rs`, `src/io/native-fs.ts`, `src/core/platform.ts` | `veditor-tauri` (app crate) + `veditor-engine` API | not-started | P0 |
| Tests (19 files) | spline/pressure/shape/selection/page-ops/history/export/etc. | `tests/*.test.ts` | Keep green; add Rust unit tests per crate | not-started | P0 |
