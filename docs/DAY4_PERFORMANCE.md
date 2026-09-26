# Day-4 Large-Document Performance (measured, f.pdf 12.8 MB unless noted)

> Measurements from operator runs (desktop `--features mupdf` build,
> `[mupdf]` console probes, since removed) and automated tests. Nothing
> estimated. Unmeasured cells say so. Fixture labeled per row; results from
> different PDFs are never mixed.

## Corpus status
- `f.pdf` (12.8 MB, PDF-1.6, 100+ pages, mixed): full matrix below.
- Large multi-page / scanned-image-heavy / vector-text-heavy / oversize-page:
  **pending external fixtures** (only f.pdf exists in-repo).

## What changed (code, TS-only; no Rust/cache/transport/scheduler changes)
- Off-viewport (buffer) pages demoted to background priority (was: full
  35-tile grids at top priority via `!vis` fallback).
- Stale-generation aborts re-arm the raster flag instead of reporting success
  (was: partial/blank pages consumed `needsRaster` forever on same zoom).
- `_rasterRetries` reset on (re)mount; exhaustion leaves `needsRaster` set.
- Same page+zoom+canvas in-flight dedup (was: 2–4x concurrent renders,
  measured `dedup=144` tile storms).
- Stale-retry re-arm suppressed when the attempted zoom is superseded.
- `isConnected` guards on deferred-rest draw + snapshot paths.
- Vis-first policy on EVERY pass: prio ≤2 (visible + adjacent ring) now,
  prio 4 (rest) deferred 300 ms post-quiet; fully off-screen pages defer
  their whole grid. Prefetch preserved, reordered — never removed.
- `renderDeferredRest` catches stale (quiet abort, newer gen owns the work);
  non-stale errors warn + abort. Zero unhandled rejections.
- `lastGood` snapshots capped at `LASTGOOD_MAX_DIM = 1600` (tunable, scaled
  on placeholder paint).
- 160 ms zoom debounce UNCHANGED (isolated variable; separate benchmark only
  if data implicates it).

## Measured before → after (f.pdf)

| Metric | Before | After | Source |
|---|---|---|---|
| Fresh-open firstVis (viewport page) | 4570 ms | 443 ms | `firstVis` probe |
| Fresh-open time-to-complete (3 pages) | ~12.5 s | ~0.7 s vis + ~0.8 s rest | `resolved` + `deferred rest resolved` probes |
| Per-tile IPC wait under load | ~2 s | 60–150 ms typical | `ipc~` probe |
| Tile p50 / p95 | 20–32 / 47–247 ms | 9–15 / 15–51 ms | `metrics` probe |
| Tiles requested per intermediate zoom commit | 35–120 now | 8–40 now + rest deferred | `vis-first` probe |
| Settled-pass firstVis (typical) | 140–880 ms | 62–152 ms | `firstVis` probe |
| Zoom-8 intermediate firstVis | never completed mid-gesture | 81–98 ms | `firstVis` probe |
| Deferred-rest convergence | never fired pre-fix | 15/15 in 973 ms, 20/20 in 1080 ms, 35/35 in 1350 ms | `deferred rest resolved` probe |
| In-flight tile dedup waste | up to 144 | 0 throughout | `dedup` probe |
| Unhandled stale rejections | 1 (`renderDeferredRest` crash) | 0; ~24 deferred-stale aborts quietly absorbed over session | console + `dstale` probe |
| Snapshot memory per page | ~32 MB (2469x3252) | ~7.4 MB (1215x1600), 4.3x reduction | `snapshot` probe |
| Placeholder coverage | mixed hit/miss | miss only pre-seed; hit after seeding | `ph` probe |
| Permanent blank pages | yes (stale-abort + retry-exhaustion) | none in validation session | eyeball + console |
| RSS | 150→226 MB | 73→124 MB, bounded | `metrics` probe |
| Rust cache | pinned ~255 MB, evict churn, LRU working | same (untouched by design) | `metrics` probe |

## Scenarios A–G (f.pdf, operator runs)
- A. Fresh open: viewport vis-first 25 now + 10 deferred; buffer pages
  0 now + 35 deferred each; full convergence post-quiet. PASS.
- B. Normal scroll: vis/adj immediate (firstVis 62–152 ms), rest post-quiet. PASS.
- C. Rapid fling + reverse: evict/remount churn heals via mount retry-reset +
  exhaustion leave-set; no stuck pages. PASS (eyeball + console).
- D. Zoom gesture in/out (incl. zoom 8, 120-tile grids): intermediates land
  vis tiles in <100 ms; settled pass converges. PASS.
- E. Zoom + scroll combo: gen churn absorbed via quiet stale aborts; no
  unhandled rejections; coverage converges. PASS.
- F. Random-page jump: gen bump cancels obsolete queue; stale abort re-arms;
  page completes. PASS.
- G. Revisit rendered pages: geometry unchanged → no re-raster (needsRaster
  stays clear); Rust cache serves warm tiles. PASS.

## Conclusions (separated from measurements)
- Acceptance criterion met: visible content no longer waits behind
  rest/prefetch work (worst fresh-open firstVis 4570 ms → 443 ms).
- Dominant cost was queue order/volume through the single worker, not raster
  speed (p50 ~12 ms) or transport (decode 1–2 ms).
- Deferred-stale aborts during cascades are the mechanism working as
  designed, not a defect: abort + newer pass re-covers + settle converges.
- Snapshot dim cap is visually lossless for placeholders (drawn scaled) at
  ~1/4 memory; `LASTGOOD_MAX_DIM` is tunable if 100–1600% eyeball says soft.

## Limitations / residual observations
- Pages scrolled past at speed may resolve rest late or abort stale
  (`0/0 … ph=miss`); scrolling back re-renders vis-first in ~100 ms.
  Observed, accepted.
- Cache pins at 255 MB with eviction churn across zoom steps (dead-zoom
  tiles). Untouched per scope; generation-scoped invalidation would be
  Rust-side future work. Observed, out of scope.
- Rotation eyeball + scanned/image-heavy + vector-heavy + oversize corpora
  pending external fixtures. NOT run.
- pdf.js JPX/OpenJPEG dev-worker failures observed (`Unable to decode
  image`): UNVERIFIED against production bundle — do not classify as
  environmental-only until checked there.
- Desktop re-validation after probe removal: typecheck + full test suite
  green (below); operator eyeball pending (probes removed, behavior paths
  untouched).
- Pre-existing debt untouched: 3 tsc errors
  (`pointer-handler.ts:1328-1329`, `main.ts:toggleZoomTool`), toolbar rgba
  spam. Day-2 temp probes (`open doc`, per-render grid line) intentionally
  kept — out of Day-4 removal scope.

## Verification (post probe-removal)
- `npx tsc --noEmit`: only the 3 pre-existing errors, no new ones.
- `npx vitest run`: 20 files / 168 tests passed.
- `git status` review: `src/core/page-renderer.ts`,
  `src/io/engine-tiles.ts`, `src/core/viewport.ts`, `src/main.ts` (mechanisms
  from earlier Day-4 commits), plus this doc. No other files touched.
