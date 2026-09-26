# Day-6 Evidence & Bottleneck Validation

> Baseline: `a06c271 day-5-production-hardening`. Corpus: operator-run `f.pdf`
> (12.8 MB, PDF-1.6, 100+ pages) on desktop `--features mupdf` builds, unless
> noted. Statuses: MEASURED (instrumented numbers) / OBSERVED (operator
> eyeball/console) / BLOCKED (not run, with cause). Nothing estimated.
> Goal: **measure first, decide second** — no optimization was implemented on
> the basis of these numbers except the one correctness fix in §7.

## M1. Annotation scaling (MEASURED, two engines)

Live production paths, synthetic pen strokes (40 pts/stroke), n = 10/100/1000,
median + p95. Browser harness `__day6bench` (temp, since removed) drove
`renderAnnotationsToCanvas` (**live** repaint path — correcting DAY5 §2.D,
which named the caller-less `renderCommittedAnnotations` twin),
`findAnnotationAtPoint` (mid-stroke hit + miss), `eraserTool.testErase`
(single + scripted 20-pt drag mirroring `applyEraserDirect`'s per-point loop),
`findAnnotationsInPolygon`/`findAnnotationsInRect`, isolated
`renderSmoothStroke`. Headless vitest run (temp, since removed) covered the
canvas-free ops on the same shapes in Node/V8.

| op (median) | browser 10 / 100 / 1000 | headless 10 / 100 / 1000 | scaling |
|---|---|---|---|
| repaint (live path) | 0.3 / 3.6 / **23.9 ms** | — (needs canvas) | ~linear (12×, 6.6×) |
| hit (mid, ~N/2 scan) | 0 / 0 / 0 ms | 0.002 / 0.003 / 0.005 ms | sublinear, negligible |
| miss (full N scan) | 0 / 0 / 0 ms | 0.002 / 0.006 / 0.009 ms | sublinear, negligible |
| erase-single | 0 / 0.1 / 0.9 ms | 0.03 / 0.11 / 0.90 ms | ~linear, near-perfect engine agreement |
| erase-drag ×20 pts | 0.2 / 1.4 / **14.0 ms** | 0.23 / 1.65 / 23.0 ms | ~linear, same order both engines |
| lasso (pointer-up only) | 0.3 / 0.9 / 2.1 ms | 0.44 / 0.55 / 1.13 ms | sublinear-ish, fine |
| rect | 0 ms | ~0.01 ms | negligible |
| spline-1-stroke | ~0–0.1 ms | — | negligible → repaint cost is canvas fill, not smoothing |

Findings (reported only — no optimization, no migration per the Day-6 rule):
- **Repaint ~24 ms (p95 31 ms) and erase-drag ~14–23 ms at n=1000** are the
  only interaction costs near/over a 16.7 ms frame. Mechanism: repaint is
  canvas fill over N strokes (spline isolated negligible); erase-drag is
  O(C×N×P) ≈ 20 pointer points × 1000 strokes × 40 segment-distance evals
  per pointermove (`pointer-handler.ts:1369-1385` → `testErase` per point).
- **No threshold/nonlinear jump anywhere** — all ops scale ~linear-or-better
  (10→100→1000 costs grow ≤~12× per 10× n, mostly far less). Hit/miss/lasso/
  rect are negligible at all n.
- Caveats: synthetic overlapping strokes; Node/V8 vs browser engine (agreement
  is nevertheless excellent); offscreen canvas, not live pointer-event rates
  (M-drag covers the rate multiplier).

## M2/M3. Eraser-drag + spline isolation (MEASURED, in M1 table)
See `eraseDrag` and `spline` rows above. Single-call erase timings understate
the interaction cost by ~15–25×; the drag batch is the representative metric.

## M4. Multi-document memory lifecycle (MEASURED, engine side; OBSERVED, OS side)

`engine_metrics` re-exposed as a read-only command for Day-6 diagnostics
(minimal: existing `EngineMetrics` struct, handler entry, no polling, no
behavior change) + temp `__day6metrics()` reader (since removed). Operator
pasted OS RSS (`Get-Process`) + metrics JSON per step.

| step | OS RSS | engine registry |
|---|---|---|
| open f.pdf + settled | 82.54 MB | 1 doc: 175 tiles, used 160.6/256 MB, renders 234, p50/p95 27/112 ms, queue 0, evictions 0 |
| close + 30 s | 101.70 MB | empty |
| repeat 1 close + settle | 67.58 MB | empty |
| repeat 2 close + settle | 66.21 MB | empty |
| repeat 3 close + settle | 130.74 MB | empty |
| close-all + 30 s (proxy baseline) | 168.03 MB | empty |

Verdicts:
- **Lifecycle release proven 5/5**: registry empty after every close
  (matches the Day-5 Rust regression test). `rss_bytes` in the metrics reads 0
  by design (Rust never samples process RSS) — OS RSS is authoritative there.
- **No leak signal extractable from OS RSS**: 66–168 MB across five identical
  empty-registry states. Variance is webview/GC noise, not engine state.
- Open-state headroom: 160.6/256 MB, 0 evictions, single doc.
- `hits: 0 / misses: 0` with 234 renders OBSERVED: counters likely increment
  only on the `render_tile_cached` path while the viewer drives
  `render_tile_queued`. Uninvestigated (does not affect the lifecycle verdict);
  recorded so a future diagnostics pass knows the counters' exact semantics.
- BLOCKED with cause: true never-opened baseline (single live process) and
  multi-doc cache pressure (app-level same-file dedup — only one tab of f.pdf
  can be open; read-only duplicate-open parked on the future roadmap per
  operator request, explicitly not Day-6).

## M5. Rust cache correlation (MEASURED where possible)
Covered by the M4 metrics column. `engine_metrics` IPC verified functional
live (not just compiling). Cache semantics above; queue/dedup/inflight all 0
at settle; tile p50/p95 27/112 ms consistent with Day-4.

## M6. Renderer comparison (OBSERVED, paired, no winner)

| | Legacy/pdf.js | MuPDF |
|---|---|---|
| open/load f.pdf | <1 s | <1 s (`via=bytes(12838661B)` transfer 168–209 ms, took 202–261 ms) |
| first-visible/settled | rendered | rendered; zoom/scroll grids resolve |
| OS RSS (not settle-matched) | 116.2 MB | 188.2 MB |

No winner declared (per scope). RSS pair is not settle-matched and OS RSS is
proven noisy — recorded only.

**Measured Legacy/JPX observation** (upgrades Day-5 L3 from "pre-existing
dev-worker failure" to confirmed-broad): Legacy pdf.js fails OpenJPEG init on
images across pages 31–59+ (`img_p31_7`, `img_p34_2`, `img_p38_1` …
`img_p59_2`, plus `Dependent image isn't ready yet`) — a large run of JPX
images rendering as gaps under Legacy in the dev build. MuPDF unaffected (own
raster). Production-bundle check still open.

## M7. 800% rendering quality (OBSERVED → PASS)
MuPDF at 800%, text page + vector page: text PASS (sharp), vector PASS (high
quality), tile seams PASS (none), 6144-cap upscaling softness PASS (none
observed). Closes Day-5 measurement C as PASS on f.pdf.

## M8. Validation gaps (OBSERVED / BLOCKED)
- Random-page jump + neighbors: initial FAIL (white buffer neighbors, §7),
  re-validated PASS after the fix (pages 60→114 all render hands-off, no
  warnings, no stale noise; rotated page 61 geometry correct among unrotated
  neighbors).
- Rotation correctness (Day-5 items 4/5/15/16) stands: no rotation code was
  touched by the re-arm fix (rotation axis untouched), and this session's log
  directly shows a rotated page (61, 7x5 grid) rendering correctly among
  unrotated neighbors. Rapid-rotation re-run: not explicitly performed this
  session — Day-5 PASS carries (mechanism unchanged), flagged as not re-run.
- Tab switch / close-reopen / renderer switch both directions: PASS
  (OBSERVED — exercised throughout the Day-6 session: 5 close/release
  cycles, Legacy↔MuPDF comparison runs).
- Single-page mode, two-page/spread mode, path-based open: BLOCKED (not
  explicitly run this session; no claim).

## M9. Corpus inventory (MEASURED — by inspection)
`src-tauri/crates/veditor-pdf/tests/data/` contains **only f.pdf**. Missing
with no acquisition (per scope): scanned, JPX-heavy (f.pdf itself exercises
JPX only via the Legacy path), vector-heavy, large-page-count fixtures. All
numbers in this doc are f.pdf-only; no generalization claimed.

## 7. Stranded-rest correctness fix (M8 FAIL → fixed, not optimized)

Operator FAIL: after an across-document jump, the target rendered but
neighbor buffer pages stayed pure white until the next scroll/zoom.
Root cause (traced, then confirmed by all 5 operator facts): fully
off-viewport pages defer their whole tile grid; the deferred batch fired
with the pre-jump generation, aborted stale, and left no flag behind — no
pass would ever request those tiles (MuPDF-only; Legacy has no generations).
Fix (2 files, ~35 lines, no scheduler/queue/cache/debounce/worker/Rust
change): `renderDeferredRest`'s stale-abort branch invokes a new
`onDeferredRestStale(pageIndex)` seam; `main.ts` registers once on the MuPDF
singleton and re-arms the page's existing `needsRaster` flag (idempotent) +
one normal `handleScroll(true)` pass. No recursive retry, no generation
refresh — the next pass re-derives everything through normal vis-first
scheduling. Bounded: one abort → one flag-set per timer; newer passes cancel
pending timers; genuinely obsolete work still aborts quietly.
Regression test `tests/deferred-rest-rearm.test.ts` (3 tests): stale abort →
callback exactly once; non-stale failure → no callback; no owner → quiet.
Operator re-validation: PASS (pages 60→114 hands-off, no warning storm).

## Bottleneck matrix

| candidate | classification | evidence |
|---|---|---|
| annotation repaint @1000 | measured issue (not yet bottleneck) | 23.9 ms med / 31.1 p95, ~linear, canvas-fill-bound |
| eraser drag @1000 | measured issue (not yet bottleneck) | 14–23 ms per pointermove batch, O(C×N×P) |
| hit-test / lasso / rect / spline | not currently significant | ≤2.1 ms at n=1000, sublinear-or-trivial |
| Rust tile rendering | not currently significant | p50/p95 27/112 ms live; Day-4 p50 ~12 ms |
| single-worker scheduling | observed (by design) | Day-4: dominant cost was queue order/volume; L1 refill sweep accepted |
| cache/memory behavior | observed, bounded | 160.6/256 MB, 0 evictions; RSS noise, no leak signal |
| pdf.js fallback/JPX | measured issue (Legacy path) | broad OpenJPEG failures pp. 31–59+ in dev build |
| document lifecycle | not significant (fixed) | release proven 5/5 live + Rust test |
| zoom/rotation rendering | observed, accepted | L1 sweep; rotation correctness PASS |
| deferred-rest stranding | measured bottleneck → FIXED (§7) | white neighbors, healed by re-arm |

## Next-scope recommendation (evidence-only)
1. **No annotation/ink migration.** The numbers show ~linear scaling with no
   threshold; the two frame-budget-adjacent costs have identified,
   TS-side-local mechanisms (canvas fill volume; per-point erase loop) that
   must be profiled/attacked in place before any port is justifiable.
2. **Smallest next experiment (proposed, not started):** profile a 1000-stroke
   repaint to split canvas-fill vs layout/JS overhead, and measure
   erase-drag with bbox pre-filtering sketched (no implementation) — each as
   its own measured step.
3. **Default-flip still needs:** production-bundle JPX check, external corpora
   (M9), settle-matched memory comparison. Not recommended now.
4. **Forbidden regardless of outcome (unchanged):** worker-count increase,
   cache-budget redesign, scheduler/debounce/transport redesign, broad
   refactors, UI changes.

## What Day-6 changed (files)
- `src-tauri/src/engine_cmds.rs` + `src-tauri/src/lib.rs`: read-only
  `engine_metrics` command re-exposed (Day-6 diagnostics; permanent API).
- `src/io/engine-tiles.ts`: `fetchEngineMetrics` comment corrected
  (was "TEMPORARY Day-3 probe").
- `src/core/page-renderer.ts` + `src/main.ts`: stranded-rest re-arm fix (§7).
- `tests/deferred-rest-rearm.test.ts`: 3 regression tests.
- Temp-only, removed before commit: `src/annotations/bench-day6.ts`
  (`__day6bench`, `__day6metrics`), `tests/bench-day6-tmp.test.ts`.

## Gates (pre-commit)
- `cargo check`: clean, default + `--features mupdf`, zero warnings.
- `cargo test --workspace` + `--features mupdf`: green (incl. mupdf pixel +
  rotation proofs and the 5/5 engine lifecycle test).
- `npx vitest run`: 21 files / 171 tests green (168 Day-5 + 3 new).
- `npx tsc --noEmit`: zero errors.
- `build:chrome`, `build:firefox`, `build:desktop`: pass.
- `grep __day6bench/__day6metrics/bench-day6`: clean.
