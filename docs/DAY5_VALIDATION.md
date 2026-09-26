# Day-5 Validation — Production Hardening (MuPDF dogfood readiness)

> Baseline: `427989a day-4-large-document-performance`. Corpus: operator-run
> `f.pdf` (12.8 MB, PDF-1.6, 100+ pages) on desktop `--features mupdf` builds,
> unless noted. Statuses: PASS (verified) / FAIL (broken) / BLOCKED (not run).
> Measured = instrumented numbers; Observed = operator eyeball/console;
> Unverified = claimed nowhere until evidence exists.

## 0. Objective result

MuPDF is dogfood-safe behind the user-facing switch, pdf.js remains default.
No annotation/ink migration, no default flip, no Day-4 mechanism weakened.

## 1. Validation matrix

| # | Case | Result | Evidence / note |
|---|---|---|---|
| 1 | Normal continuous mode (MuPDF) | PASS | Observed, all sessions; Day-4 numbers hold |
| 2 | Single-page mode | BLOCKED | Not run — no parity claimed |
| 3 | Two-page/spread mode | BLOCKED | Not run — no parity claimed |
| 4 | 90° rotation (pdf.js + MuPDF) | PASS | Observed; centering fix verified, no misplaced pages |
| 5 | 270° rotation (pdf.js + MuPDF) | PASS | Observed; same as 90° |
| 6 | Tab switch between documents | PASS | Observed; warm caches survive (no close on switch) |
| 7 | Close/reopen document | PASS | Observed; Rust regression test `close_releases_state_and_reopen_renders_fresh` green |
| 8 | Path-based open | BLOCKED | Not explicitly run |
| 9 | Bytes-based open | PASS | Observed every session (`via=bytes(12838661B) transfer=172ms`) |
| 10 | Switch Legacy → MuPDF | PASS | Observed; instant re-render, annotations intact, no stale paint |
| 11 | Switch MuPDF → Legacy | PASS | Observed; same |
| 12 | High zoom incl. 800% | PASS (renders) / BLOCKED (sharpness verdict) | Observed: zoom-8 10x12 grids resolve; text/vector sharpness eyeball NOT recorded |
| 13 | Fast scroll / fling | PASS | Observed; Day-4 behavior intact |
| 14 | Random page navigation | PASS | Observed (jump field); stale-abort + re-arm converges |
| 15 | Rotation centering (continuous, rotated + neighbors) | PASS | Observed both renderers after two-pass fix |
| 16 | Rapid 90→180→270→0 rotations | PASS (correctness) | Observed: older orientation never paints over newer (coherence guards); see limitation L1 |
| 17 | Right-click page Rotate CW/CCW | PASS | Observed; menu entries work, undoable via existing pipeline |
| 18 | Smoke: open→render→zoom→scroll→switch→switch-back→close→reopen | PASS | Observed across sessions; zero errors/blank pages |

## 2. Measurements

### A. Multi-document RSS — PARTIALLY SUPERSEDED by Day-6 M4
Real-process RSS curve: MEASURED (Day-6, 5 close-states: 66–168 MB with the
engine registry verifiably empty every time — variance is webview/GC noise,
no leak signal extractable; release proven 5/5 live, matching the Rust
regression test). True never-opened baseline + multi-doc cache pressure:
still BLOCKED (single live process; app-level same-file dedup). See
`docs/DAY6_PERFORMANCE.md` M4.

### B. Renderer memory comparison — BLOCKED
Not run. pdf.js stays fully loaded under MuPDF mode (fallback + text/search/
thumbnails), so double-engine memory is expected but unquantified.

### C. 800% visual validation — PASS (Day-6 M7)
MuPDF at 800% on f.pdf (text + vector pages): text sharp, vector high
quality, no tile seams, no 6144-cap upscaling softness observed. Renders
complete at zoom 8 (10x12 grids, firstVis ~81–98 ms Day-4) — now with the
sharpness verdict recorded. See `docs/DAY6_PERFORMANCE.md` M7.

### D. Annotation scaling benchmark — SUPERSEDED by Day-6 M1 (procedure kept)
Temporary harness `src/annotations/bench-day5.ts` (since removed) drove
*annotation* paths on an offscreen canvas with synthetic pen strokes
(40 pts/stroke). CORRECTION (Day-6): the procedure named
`renderCommittedAnnotations`, which is caller-less — the live production
repaint path is the twin `renderAnnotationsToCanvas` (same loop over
`doc.annotations[pageIndex]`, reached via `repaintPageAnnotations`). Day-6
re-ran the methodology against the live path at n = 10/100/1000 with
median+p95 (see `docs/DAY6_PERFORMANCE.md` M1): repaint 0.3/3.6/23.9 ms,
erase-drag ×20 0.2/1.4/14.0 ms (browser), ~linear everywhere, no threshold.
Console command was `await window.__day5bench()` (Day-5) /
`await window.__day6bench()` (Day-6, temp, since removed).

## 3. What Day-5 changed (files)

- `src/core/page-renderer.ts`: `closeDocument()` purge, `releaseEngineDocument()`
  export, closed-doc fallback suppression, renderer epoch in coherence +
  deferred guards, rotation axis in coherence + layout-wait + deferred guards,
  rotated ±90° placeholder paint, snapshot rotation tracking.
- `src/main.ts`: `releaseEngineDocument` on tab close + page-op byte rewrite;
  `setRenderer()` live switch.
- `src/core/store.ts` + `src/core/types.ts`: `AppSettings.renderer`
  (`'pdfjs'` default), legacy flag one-time import.
- `src/core/config.ts`: settings-backed `getRendererKind()` + desktop gate;
  centralized boundary unchanged (single caller).
- `src/ui/components/settings-modal.ts`: Viewer → Renderer select
  (disabled off-desktop with reason), change handler.
- `src/core/viewport.ts`: two-pass continuous centering (byte-identical when
  no page exceeds viewport; single/two-page untouched).
- `src/core/pdf-engine.ts`: rotated cached-bitmap blit on ±90° mismatch.
- `src/ui/components/context-menu.ts`: page right-click Rotate CW/CCW
  (existing action + i18n, busy-guard + toast).
- `src/input/pointer-handler.ts`, `src/main.ts`: 3 dead zoom-tool references
  removed → `tsc` zero errors.
- `src-tauri/src/lib.rs` + `src-tauri/src/engine_cmds.rs`: removed dead
  commands `engine_status`, `engine_page_count`, `engine_page_size`,
  `engine_metrics`; kept `PdfBackend` trait methods, `EngineMetrics` struct,
  compat stubs internal. Handler list now 1:1 with TS callers.
- `src-tauri/crates/veditor-engine/src/lib.rs`: lifecycle regression test.

## 4. Accepted limitations (non-blocking)

- **L1. Cold-orientation refill sweep**: after any rotation, the new
  orientation re-renders fully (empty orientation cache, single worker):
  ~0.5 s at 35 tiles, 1 s+ at 120-tile high zoom, visibly top-to-bottom.
  Fast double rotations each settle in turn; coherence guards verified —
  older orientation never paints over newer. Accepted as designed progressive
  behavior. Future: orientation-aware tile reuse / worker parallelism (Day-6+,
  explicitly out of Day-5 scope).
- **L2. Rotation placeholder**: correctly oriented since the ±90° polish, but
  soft until tiles land. Future transition-polish item retained on roadmap.
- **L3. pdf.js JPX/OpenJPEG dev-worker failures** (`Unable to decode image`,
  `Dependent image isn't ready yet`): pre-existing, still UNVERIFIED against
  production bundle. MuPDF path unaffected (own raster), pdf.js fallback on
  JPX pages may show gaps — same as Day-4.
- **L4. Per-doc 256 MB Rust cache + no generation-scoped invalidation**:
  unchanged by design; multi-tab large-doc memory unmeasured (see A).
- **L5. External corpora** (scanned/JPX-heavy/annotation-heavy/vector-heavy/
  1000-page): no evidence — no parity claims beyond f.pdf.

## 5. Gates (post bench-removal, pre-commit)

- `cargo check`: clean, default + `--features mupdf`, zero warnings.
- `cargo test --workspace`: green (veditor-engine 5/5 incl. new lifecycle
  test, render 4/4, core 3/3, annotations/ink/pdf 1/1 each).
- `cargo test --features mupdf --workspace`: green incl. `mupdf_render`
  integration (`mupdf_renders_real_pixels_from_fixture`,
  `mupdf_rotation_renders_valid_tiles`).
- `npx vitest run`: 20 files / 168 tests green.
- `npx tsc --noEmit`: zero errors (3 pre-existing dead refs removed).
- `build:chrome`, `build:firefox`, `build:desktop`: all pass.
- Temp benchmark + hook removed; `grep __day5bench/bench-day5`: clean.

## 6. Day-6 implications (evidence only, no proposal)

- Annotation migration still unjustified: benchmark D never ran — run it
  before any Day-6 annotation decision.
- `engine_metrics` command removed; `EngineMetrics` struct retained — Day-6
  diagnostics need an IPC re-exposure decision if wanted.
- Default-flip needs: A + B + C measured, plus external corpora.
