# Day-3 Performance Benchmark (measured, f.pdf 12.8 MB unless noted)

> Measurements from operator runs (desktop `--features mupdf` build,
> `[mupdf]` console probes) and automated tests. Nothing estimated.
> Unmeasured cells say so. Fixture labeled per row; results from different
> PDFs are never mixed.

## Corpus status
- `f.pdf` (12.8 MB, PDF-1.6, 100+ pages, mixed): full matrix below.
- Large multi-page / scanned-image-heavy / vector-text-heavy / oversize-page:
  **pending external fixtures** (only f.pdf exists in-repo).

## Measured results (f.pdf)

| Case | Result | Source |
|---|---|---|
| Document transfer (raw binary IPC) | 176 ms | `via=bytes` probe (was ~3,785 ms JSON) |
| Engine open total (transfer+parse) | ~200–230 ms typical; 9–14 s seen pre-dedup | `took=` probe |
| Cold tile MuPDF raster | 3–35 ms | `lastTile(rs=)` |
| PNG encode per tile | 0–14 ms | `lastTile(enc=)` |
| Browser PNG decode per tile | 1–2 ms | `decode~` probe |
| Per-tile IPC wait (queue+transport) | 40–360 ms under fan-out | `ipc~` probe |
| Cold 35-tile page | 3–7 s first touch; ~0.5–1.5 s typical later | `resolved` probe |
| Warm cache (35–48 tiles) | 57–141 ms | `resolved` probe |
| 70-page fan-out tail | ~27 s worst case (pre queue wiring) | `resolved` probe |
| Cache at 256 MiB budget | fills to ~200–256 MB, evictions work, hit 0% during zoom churn (expected: keys change) | `metrics` probe |
| Zoom/scroll correctness | stale-soft placeholder, no white flash, no OOB storms, no mixing | eyeball + console |
| Fresh open paints page 1 | fixed via bounded layout-wait (rAF ≤10 frames/500 ms) + fallback | code + eyeball pending |
| Random-page self-render | fixed via same layout-wait (was: `needsRaster` consumed by doomed render) | code + eyeball pending |
| pdf.js parity / 800% right-side | confirmed | eyeball |
| Headless pixel proof | 0.16–0.17 s | `cargo test --features mupdf` |
| p50/p95 per-tile, hit-rate %, RSS | NOT measured | needs scripted runs (Day-4) |
| Rotation eyeball, scanned corpus | NOT run | pending fixtures |

## Conclusions (separated from measurements)
- The ~50 MB JSON expansion is eliminated (176 ms binary transfer).
- PNG chain (encode 0–14 ms + decode 1–2 ms) is ~5–10% of tile latency:
  transport stays PNG; no raw-RGBA work without new evidence.
- Bottleneck is queue depth/fan-out under multi-page renders, not raster
  speed (3–35 ms) and not worker count (concurrency stays 1).
- Single biggest remaining cost: full-page grids per visible page (up to 120
  tiles) instead of strict visible-only + on-demand rest.

## Limitations
- Rotation eyeball + scanned/image-heavy + vector-heavy + oversize corpora
  pending external fixtures.
- pdf.js JPX/OpenJPEG dev-worker failures observed (`Unable to decode
  image`): UNVERIFIED against production bundle — do not classify as
  environmental-only until checked there.
- Pre-existing debt untouched: 3 tsc errors, toolbar rgba spam/blur.
