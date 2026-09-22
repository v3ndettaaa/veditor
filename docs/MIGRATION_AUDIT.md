# VEditor Migration Audit (Day 1)

Date: 2026-09-22. Source: direct code trace (not filenames alone).
Frontend: Vanilla TypeScript (no React). Build: Vite 8 multi-target. Native: Tauri v2 (minimal).

## 1. Current architecture

```
Vanilla TS UI (src/ui/components/*, 19 components: header/toolbar/side-panels/
properties-panel/view-controls/scratchpad/command-palette/modals/signature/save-as/
context-menu/toast/landing-page/inline-editor/floating-props)
  -> StateStore (src/core/store.ts:37-767, subscribe/notify singleton, multi-tab)
  -> HistoryManager (src/core/history.ts:18-418, per-doc undo/redo stacks, max 150)
  -> PDFEngine (src/core/pdf-engine.ts, pdf.js) + ViewportManager (src/core/viewport.ts)
  -> AnnotationEngine (src/annotations/engine.ts) + SelectionManager + PointerHandler
     + Pressure/Palm/Gestures (src/input/*)
  -> IO (src/io/storage.ts idb veditor-db v1, export-pdf/image/data, save.ts,
     native-fs.ts, notebook.ts, page-ops via core/page-ops.ts + page-actions.ts)
  -> Shells: MV3 extension (service-worker.ts + popup/popup.ts + browser-compat.ts)
     | Tauri desktop (dialog/fs/single-instance, take_startup_file only)
```

State flow: `VeditorApp.loadPDF(name, bytes)` (`src/main.ts:513`) -> `storage.openDocumentSession`
-> `PDFEngine.loadFromBytes` -> `extractNativeAnnotations` (native-annotations.ts + native-ink.ts)
-> `store.setActiveDocument` -> `viewportManager.updateLayout(true)` -> `handleScroll`
-> `renderVisiblePages` -> pointer/select/history edits -> `triggerAutoSave` (1500ms)
-> `persistDocPosition` (800ms) -> export/save.

Build modes (`vite.config.ts`, `package.json`): `build:chrome/firefox/desktop` ->
`dist/chrome|firefox|desktop`, `base './'`, externals `^@tauri-apps/.*` for extensions,
offline copy of `pdf.worker.min.mjs + cmaps/ + standard_fonts/`.

## 2. Current rendering pipeline

Entry `index.html#document-scroll-container > #document-pages-wrapper` ->
`VeditorApp.init` (`src/main.ts:186`, `viewportManager.init` + `onVisiblePagesChange=renderVisiblePages`).

1. Open paths converge on `loadPDF`: file picker (`showOpenFilePicker`/native dialog/hidden
   input), drag&drop, `?pdfUrl=` fetch, `?docId=` IDB resume, recents/landing, Tauri path dedup.
2. `PDFEngine.loadFromBytes` (`pdf-engine.ts:85`): fast path swaps cached
   `CachedDocSession{doc, pageCache, renderedBitmaps, meta}` (<1ms tab switch); slow path
   `data.slice(0)` -> `stripNativeInkAnnotationsFromBytes` -> `pdf-lib` preload/strip ->
   `pdfjsLib.getDocument({data, cMapUrl, standardFontDataUrl})`. First-page sync for fast
   paint; `fillMetadataBackground` heals sizes/outline in batches + `emitDimensionsUpdated`.
3. `renderVisiblePages` (`main.ts:946`): bail if switching/zooming; `cancelOutdatedRenderTasks`;
   evict `minDistance>1` (collapse canvas to 1x1 to free VRAM); mount missing visibles with
   4-layer DOM (`pdf + pattern + annot + scratch` canvas); `applyPageGeometry` (dpr from
   `utils/dpi.ts resolveRenderDpr=targetDPI/72`, `clampRenderMultiplier`, `MAX_RENDER_DIMENSION=6144`,
   `geomKey=zoom|dpr|rot`); visible raster via `renderPageToCanvas` (offscreen double-buffer,
   white fill, atomic blit, stale-cache placeholder) + always `repaintPageAnnotations`.
4. Virtualization (`viewport.ts`): `updateLayout` computes `ViewportPageRect` per
   `zoom/viewMode (continuous|single|two-page)` + user rotation; `handleScroll` rAF-coalesced,
   `buffer=2.0*viewH`, center-page -> `store.setActivePageIndex` + persist.
5. Zoom: `store._zoom` clamped `MIN_ZOOM=0.2/MAX_ZOOM=8` (`types.ts:219`); `zoomByFactor`
   focal-anchored; `Ctrl/Meta+wheel exp(-deltaY*0.0035)` preview Raf + 160ms commit;
   pinch (`input/gestures.ts`) shares the path; dblclick `zoomAtPoint`; `fitToWidth/fitToPage`.
6. Cache: `_pageCache` LRU 60, `_renderedBitmaps` cap 6 keyed `page@scale:rot`,
   `_activeRenderTasks` cancellable, `_renderedPages geomKey/needsRaster/needsRepaint`.
7. Text/search: NO selectable text layer (zero `renderTextLayer`). Only extraction
   `getPageText -> getTextContent`; search UI (`side-panels.ts:257`) loops all pages with
   `indexOf`, snippet display, click -> `scrollToPage`. No highlight quads/regex/worker index.
   Outline via `getOutline -> formatOutline`; thumbnails via `renderThumbnail/thumbnailFromCache`
   + IntersectionObserver.

## 3. Current annotation pipeline

Types (`core/types.ts`): 8-way `Annotation` union (Pen/Highlighter/Shape/Text/Stamp/
Measurement/Signature/Redaction), 20 `ToolType`, `rotation` radians about box center.
Drift: `SHORTCUTS.md` lists Callout/Sticky/Laser but `annotations/migrate.ts:
pruneUnsupportedAnnotations` drops `laser/callout/sticky-note` on every `setActiveDocument`.

Tools (`annotations/tools/*`): pen (Catmull-Rom), highlighter (straight-snap, chisel/round,
multiply), eraser (stroke|object|pixel, split, single-undo), shapes (rect/ellipse/line/arrow/
polygon/freeform, Shift-constrain, 15-degree snap, magnetic vertex snap), text (+inline-editor),
stamp (6 presets + image import), signature (+library dialog), redaction (burn-in on export),
measure (distance/angle/area, unit+scaleRatio), duplicate (+12px, Ctrl+D).

Coordinator `annotations/engine.ts: renderAnnotationsToCanvas/renderSingleAnnotation`
(rotation-aware dispatch) reused by live scratch preview, committed annot canvas, and export.
`selection.ts`: 8-handle+rotate transform, ink-aware lasso/marquee hit-test, align/distribute,
z-order. `spline.ts` pressure->width + smoothing; `utils/shape-fit.ts` draw-and-hold
recognition (320ms/8px, morph 220ms); `utils/geometry.ts` bbox/ribbon helpers.

Input (`input/pointer-handler.ts`, 1472 lines): per-page scratch-canvas binding,
palm gate, inverted-tail eraser, tool dispatch, `getCoalescedEvents` batching, single
clearRect per frame, hold-timer shape morph, pointerUp commits exactly one history command.
`pressure.ts` curves (linear/soft/firm/exponential) + strengths; `palm-rejection.ts`
(<650ms since pen or >22px touch rejected); `gestures.ts` 2-finger pinch/pan aborts stroke.
Cursors (`ui/cursor.ts`) SVG per tool, zoom-scaled. Hand pan: Space-hold, middle-drag, 2-finger.

History (`core/history.ts`): `Add/Delete/Replace/BulkModify/BulkAdd/Reorder/Modify/PageOpsCommand`;
live drag mutates `doc.annotations[page]` per frame, single `pushCommitted` on pointerUp.

Persistence (`io/storage.ts`): `idb` `veditor-db v1` (documents/recent/signatures/versions),
`openDocumentSession/saveDocumentSession(includeBytes)/triggerAutoSave/persistDocPosition`,
folders + settings in `localStorage` (`veditor_tool_settings/app_settings/shortcuts_v1/
toolbar_layout/scratchpad_*/pdf_folders`).

Export (`io/*`, `pdf-lib`): `export-pdf.ts` (flatten vector/drawRectangle vs raster embedPng,
dpi 72|150|300|600, redaction burn-in, dark-mode bake, page ranges), `save.ts`
(rewrite fileData + IDB + native path/handle), `export-image.ts` (PNG/JPEG),
`export-data.ts` (JSON/XFDF), `native-annotations.ts/native-ink.ts` (import/sync/strip).
Page ops (`core/page-ops.ts` DOM-free + `page-actions.ts`): bytes copy/insert/blank/delete/move,
index remap, snapshots, `PageOpsCommand`, `_busy` guard; UI in thumbnails/context menus.

Shortcuts (`input/shortcuts.ts` + `main.ts:setupGlobalShortcuts`): rebindable tool keys
(`localStorage veditor_shortcuts_v1`), fixed keys for measure/signature/scratchpad/hand,
Ctrl+Z/Y/O/S/D/W, arrows nudge vs scroll, Del, K/N/F/?/0, Space-hand, Enter/Esc polygon/lasso.

## 4. PDF dependencies

* `pdfjs-dist ^6.3.289`: render (`page.render` display+ENABLE), text (`getTextContent`),
  outline (`getOutline`), thumbs, `/Ink` extract. Worker `GlobalWorkerOptions.workerSrc`
  via `runtime.getURL`, fallback relative. cMaps + standard fonts bundled offline.
* `pdf-lib ^1.17.1` + `@pdf-lib/fontkit`: preload/strip native annots, page-ops byte
  surgery (`copyPages/insert/remove`), export doc assembly, save rewrite.
* `idb ^8.0.3`: persistence. `lucide`: icons. `@fontsource/inter+vazirmatn`: typography.
  `@tauri-apps/api + plugin-dialog + plugin-fs`: desktop file IO only.

## 5. Performance risks

* `store.notify()` fan-out repaints all mounted annot canvases; no per-page diff.
* `pointer-handler.ts` 1472 lines + string `innerHTML` component rendering on the hot path.
* Bitmap cap 6 thrashes during flings; LRU 60 `PDFPageProxy` retains workers/fonts.
* `data.slice(0)` duplicates large PDFs in memory; `dist/` checked into tree adds weight.
* Search is O(pages) `getTextContent` with no index; outline/thumb healing via `setTimeout(0)`
  batches janks on 500+ page books.
* Zoom preview uses CSS transform but still triggers full layout+render on commit; rapid
  Ctrl+wheel bursts coalesced only by 160ms timer.

## 6. Memory risks

* Per-page 4 canvases at `dpr up to max(2, devicePixelRatio, targetDPI/72)`; VRAM reclaimed
  only by distance eviction + manual "force VRAM reclaim" button.
* `fileData: Uint8Array` retained per open tab in memory + IDB bytes on save; multi-tab
  large PDFs multiply resident size.
* `_renderedBitmaps` collapse-to-1x1 frees GPU but JS-side `HTMLCanvasElement` objects linger.
* Autosave omits bytes (good) but `saveDocumentSession(includeBytes:true)` on Save holds
  two full copies transiently (old + new fileData).

## 7. Migration risks

* pdf.js behavior parity (font rendering, CJK cMaps, forms, rotation) must be re-proven on MuPDF.
* Native annotation import/export round-trip (FreeText/Highlight/Ink) covered by
  `tests/native-integration.test.ts` — must stay green against the new backend.
* Extension targets (MV3/Firefox) cannot load native code; pdf.js path must remain working.
* MuPDF native toolchain (clang/static link/binary size) is a Day-2 cost, not Day-1.
* IPC bitmap throughput design (tile protocol, avoid base64 for large pages) is still open.
* Rust `Annotation` mirror must stay serde-compatible with `src/core/types.ts`.

## 8. Features that must not regress (P0)

Multi-tab instant switch + isolated undo; continuous/single/two-page + rotation;
focal zoom + pinch + fit-width/page; pen/pressure/palm/tail-eraser; highlighter chisel +
straight-snap + multiply; eraser 3 modes single-undo; polygon elastic + draw-hold morph;
text/stamp/signature/redaction/measure; lasso/marquee/8-handle/align/distribute;
undo/redo per-doc; search/outline/thumbnails; page insert/blank/delete/move/rotate/
duplicate/copy-cut-paste; save/save-as/dark/flatten/DPI/range; PNG/JPEG + JSON/XFDF;
folders/landing/recents; shortcut rebind + Ctrl+K/?; EN/FA RTL; 100% offline;
popup/context-menu open flows; Tauri file-assoc/single-instance/dialogs; 19 vitest files green.
