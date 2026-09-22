# VEditor Rust Architecture (Day 1 — foundation)

## 0. Decisions (frozen)

* Frontend stays Vanilla TypeScript. No React.
* Rust powers the native PDF/rendering engine. MuPDF is the chosen PDF backend.
* Extend `src-tauri` with a workspace; crates live in `src-tauri/crates/`. No root
  `Cargo.toml` workspace. No stuffing everything into `veditor_lib`.
* Day-1: real MuPDF dependency stays optional/stubbed so a clean build does not require
  the native MuPDF toolchain. No real MuPDF rendering Day-1. Day-2 integrates it.
  No tile rendering, annotation migration, or ink engine logic Day-1.

## 1. Licensing note (accurate, no unverified claims)

* VEditor is a free and open-source project.
* MuPDF is being considered/used under its applicable AGPL terms.
* We will comply with the applicable MuPDF licensing and attribution requirements.
* Final licensing obligations depend on the exact dependency, version, build/linkage, and
  distribution path actually used; verify those against the dependency and license
  documentation before release packaging. Day-2 (real integration) must re-verify and record
  the outcome here.

## 2. Layer boundaries

```
Vanilla TS application layer (src/*, unchanged Day-1)
  |  invokes only Tauri commands over IPC; never touches Rust internals directly
  v
Tauri application crate (src-tauri/src/lib.rs, `veditor_lib`)
  - native entry point, window/file-assoc/single-instance wiring
  - exposes the ONLY TS-visible API: `take_startup_file` (existing) + `engine_status` (Day-1 stub)
  v
veditor-engine (high-level facade, coordinates subsystems)
  - owns Engine::new_stub/open_stub/page_count/status
  - re-exports veditor-core; holds Box<dyn PdfBackend> + AnnotationStore
  v
+-- veditor-core      shared frontend-independent domain types + errors (no PDF/Tauri deps)
+-- veditor-pdf       PDF backend integration; owns PdfBackend trait + MuPDF target
+-- veditor-render    tile/chunk keys, scheduling types, render cache (opaque bytes Day-1)
+-- veditor-annotations  annotation models, store, rect query, hit-test, dirty pages
+-- veditor-ink       stylus/ink pipeline types (points/strokes/opts)
```

Dependency rules: `core` has no intra-workspace deps. `pdf/render/annotations/ink` depend
only on `core`. `engine` depends on all five. The Tauri app crate depends on `engine`.
TS depends on nothing but Tauri `invoke`/events.

## 3. PDF backend target: MuPDF

* `veditor-pdf` owns the integration. The `PdfBackend` trait (`name/page_count/page_size`)
  stays backend-agnostic so tests and the engine do not depend on MuPDF specifics.
* Day-1 ships `StubBackend` (tests) + `MupdfBackendStub` (explicit MuPDF target placeholder).
  The real `mupdf` crate is referenced as an optional, commented dependency so Day-1
  `cargo check/test` passes without clang/static-link setup.
* Day-2 integration tasks (not started): enable optional `mupdf` dep, open real documents
  from bytes/path, implement `page_count/page_size`, then tile raster, text extraction,
  search, thumbs/outline. Extension targets keep the pdf.js path (native code unavailable).

## 4. Crate responsibilities (Day-1 scope in parentheses)

* `veditor-core`: (`DocumentId/PageId/AnnotationId`, `Point/Size/Rect/Transform/Viewport`,
  `EngineError`, `BASE_PDF_DPI=72`, `tile_scale(dpi)=dpi/72` port of `utils/dpi.ts`.)
* `veditor-pdf`: (`PdfBackend` trait, `StubBackend`, `MupdfBackendStub`.) Day-2: real open/render/text.
* `veditor-render`: (`TileKey{page,zoom_milli,dpr_milli,rotation}`, `TileRequest`, `RenderCache`
  cap 6 mirroring `pdf-engine.ts`.) Day-2+: scheduling + bitmap bytes.
* `veditor-annotations`: (`AnnotationKind`, `Annotation{id,page,kind,bbox}`, `AnnotationStore`
  linear `query_rect` + topmost `hit_test`, `DirtySet`.) serde-compatible with TS
  `BaseAnnotation`; spatial index upgrade (r-tree) is Day-3+ at the earliest.
* `veditor-ink`: (`InkPoint/InkStroke/InkOpts`, `push_point`, `polyline_len`.) No smoothing port.
* `veditor-engine`: (`Engine` facade + `status()`.) Coordination logic Day-2+.

## 5. TS <-> Rust contract (Day-1)

* Only Tauri commands: `take_startup_file -> Option<String>`, `engine_status -> String`.
* No TS call sites added Day-1; `engine_status` exists so IPC wiring can be smoke-tested
  Day-2 without changing the engine boundary.
* Future tile/annot/ink calls must go through new `#[tauri::command]`s in `veditor_lib`,
  never by importing engine crates from TS.

## 6. What Day-1 does NOT do

Real MuPDF rendering, toolchain setup, tile raster bytes, annotation JSON migration,
ink smoothing/Catmull-Rom port, any `src/*.ts` behavior change, React, root workspace.
