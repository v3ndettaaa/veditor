# Day-2 Tile Renderer Benchmark (measured 2026-09-22/23, f.pdf 12.8 MB)

> This implementation is NOT fully optimized. Numbers below are measured from
> operator runs (desktop feature build, `[mupdf]` console probes) and the
> headless pixel-proof test — nothing is estimated or fabricated. Unmeasured
> cells are marked as such rather than filled.

## Corpus actually used
- Operator-supplied `f.pdf` (12.8 MB, PDF-1.6, 100+ pages, mixed content).
- Headless fixture: same `f.pdf` via `crates/veditor-pdf/tests/mupdf_render.rs`.
- Small/large/scanned/vector/oversize isolation, rotation eyeball, and RSS
  profiling were NOT run — see Limitations.

## Measured results

| Case | Result | Source |
|---|---|---|
| Engine open, 12.8 MB via bytes IPC | 3,785 ms one-time | `[mupdf] open` probe |
| Cold tile render (heavy content) | ≈100–200 ms/tile | 35-tile page in 3–7 s ÷ 6 lanes |
| Cold 35-tile page (zoom ~2) | 3–7 s (first touch) | `resolved` probe |
| Cold 99–120-tile page (high zoom) | 2–6.7 s | `resolved` probe |
| Warm cache, 35–48 tiles | 57–141 ms | `resolved` probe (repeat views) |
| 70-page fan-out tail (all mounted pages re-render) | ~27 s worst case | `resolved` probe |
| Headless pixel proof (open+3 tiles+rotation) | 0.16–0.17 s | `cargo test --features mupdf` |
| Zoom/scroll correctness | no white flash, no OOB storms, no mixing | operator eyeball + console |
| pdf.js framing parity | confirmed | operator eyeball |
| 800% right-side annotations/tools | fixed (both renderers) | operator eyeball |
| Rotation 90° tile validity | valid PNG, correct extents | headless test only |
| p50/p95 per-tile, hit-rate %, RSS, queue depth | NOT measured | needs `engine_metrics` runs (Day-3) |

## Observed (qualitative, operator validation)
- Stale-soft placeholder resolves progressively; no blank flashes on zoom.
- Repeat scrolls are instant (Rust tile cache survives across passes).
- First open of a big doc freezes the viewer for seconds (the 3.8 s open).
- Toolbar rgba console spam + toolbar blur are pre-existing, unrelated.

## Limitations (Day-3 input, in priority order)
P0:
1. Document bytes travel as a ~50 MB JSON number array for a 12.8 MB PDF
   (3.8 s open). Needs chunked transfer or temp-file handoff when no native
   path is available.
2. TS requests full-page tile grids (up to 120 tiles incl. far off-screen).
   Needs visible-only requests.
3. Rust priority queue/cancellation exists but TS drives one full grid per
   page with no cross-page coordination — 70-page fan-outs take ~27 s.
P1:
4. Worker concurrency is 1 (correct by design today: MuPDF locks + `!Send`);
   evaluate parallel workers only with measurements.
5. PNG encode → IPC → browser decode stays in the transport path (accepted
   for validation; benchmark before switching to raw RGB/RGBA).
6. Rotation eyeball + broader scanned/image-heavy corpus validation pending.
P2:
7. Pre-existing UI debt: toolbar rgba console spam, toolbar blur.
