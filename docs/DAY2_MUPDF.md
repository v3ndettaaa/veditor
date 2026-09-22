# Day-2 MuPDF Integration Record (Path B: native build deferred)

## Backend choice (frozen)
`mupdf` 0.8.0 (`messense/mupdf-rs`, AGPL-3.0), default features. Verified API
against docs.rs 0.8.0: `Document::from_bytes(&[u8], "application/pdf")`,
`::open(path)`, `page_count() -> Result<i32>`, `load_page(i32) -> Page`;
`Page::bounds()`, `::to_pixmap(&Matrix, &Colorspace, alpha, show_extras)`,
`::run(&Device, &Matrix)`; `Matrix::new/new_scale/new_rotate`;
`Colorspace::device_rgb()`; `Pixmap::new_with_w_h/clear_with/write_to PNG`;
`Device::from_pixmap`. Render recipe in `crates/veditor-pdf/src/mupdf_real.rs`
(`--features mupdf` only): tile-sized pixmap + white `clear_with(255)` +
translated explicit CTM + `page.run` + PNG encode.

## Native toolchain findings (this machine, Windows x64)
1. `mupdf-sys` builds MuPDF C via MSBuild `platform/win32/*.vcxproj` pinned to
   toolset **v142** (VS 2019). Machine has VS 18 BuildTools (MSVC 14.51) only
   → `MSB8020`. Fix proven: `MUPDF_MSVC_PLATFORM_TOOLSET=v145` (supported by
   `mupdf-sys-0.8.0/msbuild.rs`) — all C libraries then compile.
2. `bindgen` then panics: `Unable to find libclang` (`LIBCLANG_PATH` unset).
   Solved via user-approved `py -m pip install libclang` (18.1.1, per-user
   site-packages, no admin/registry): DLL at
   `...\Python314\site-packages\clang\native\libclang.dll`.
3. `mupdf` 0.8.0 then fails with E0425 (`max_align_t` not in scope): the pip
   wheel ships no clang builtin headers, so clang resolves `<stddef.h>` to the
   UCRT copy, which lacks `max_align_t`, and the allowlisted binding is never
   emitted. Fix: committed force-include shim
   `src-tauri/build-support/bindgen-shim/max_align_t.h`
   (`typedef double max_align_t`, MSVC-compatible 8/8) via
   `BINDGEN_EXTRA_CLANG_ARGS="-include <abs path>"` (bindgen parsing only;
   full LLVM installs must NOT set this). Verified emitted as
   `pub type max_align_t = u64` (size/align 8 — correct for the assert).
4. Per-OS deps: Windows MSVC + `v145` override + libclang + shim (pip-wheel
   setups only); Linux `gcc/clang + libclang-dev + libfontconfig1-dev`
   (default `system-fonts` feature); macOS Xcode CLT + libclang (ships CLT).

## Proven 2026-09-22 (this machine)
* `cargo check/test --workspace --features mupdf`: green (15 Rust tests).
* Headless pixel proof `crates/veditor-pdf/tests/mupdf_render.rs` against
  operator-supplied `tests/data/f.pdf` (12.8 MB, PDF-1.6): open, page count,
  positive page size, tile (0,0) 512x512 PNG decodes with real non-white
  content pixels, edge tile (2,3) clamped dims exact, 90° rotation tile valid.
* Backend alias flipped: `--features mupdf` builds run `MupdfBackend`.

## Remaining before commit
Visual validation in the running desktop app (needs eyes on screen):
1. `$env:MUPDF_MSVC_PLATFORM_TOOLSET='v145';` +
   `$env:LIBCLANG_PATH='<pip native dir>';` +
   `$env:BINDGEN_EXTRA_CLANG_ARGS='-include <repo>/src-tauri/build-support/bindgen-shim/max_align_t.h'`
2. `npx tauri dev --features mupdf` (verify flag with `npx tauri dev --help`
   if the CLI differs), open `f.pdf`, console:
   `localStorage.setItem("veditor_renderer","mupdf"); location.reload();`
3. Validation matrix + benchmarks per `docs/DAY2_BENCHMARK.md`, then commit
   `day-2-mupdf-tile-renderer`.

## Architecture decisions (Path B, all compiling without native code)
* `PdfBackend: Send + Sync` preserved. MuPDF's `Document/Page/Pixmap/Device`
  are `!Send + !Sync` (verified in docs), so `MupdfBackend` owns one dedicated
  owner thread per open document and exposes only `mpsc::Sender`s. `unsafe
  Send/Sync` impls are sound by construction (no `mupdf::` contact outside the
  owner thread) and documented at the impl site.
* Documents opened once (`Arc<Vec<u8>>` bytes, single `from_bytes`); pages
  loaded per job; `close` drops sender and joins the thread.
* Region rendering via clipped draw-device (`Device::from_pixmap` + translated
  CTM) — never full-page raster at high zoom. Pure geometry (`layout_tile`,
  `rotate_point`) is unit-tested without native code; rotation sign convention
  is validated visually at integration.
* Tile model: `TileId` (doc/page/zoom-milli/dpr-milli/rotation/tx/ty),
  `TILE_PX = 512` (untuned), PNG transfer encoding, cost accounted as
  decoded-RGBA bytes (`w*h*4`).
* Scheduler: single worker by design (MuPDF global locks + `!Send`);
  `RenderQueue` (priorities 1–4, `max 64`, generation-based stale-drop,
  dedup) + byte-budget `TileCache` (256 MiB default, LRU, hit/miss metrics).

## IPC copy table (`engine_render_tile` → `Response::Raw`)
| # | Copy | Where |
|---|---|---|
| 1 | pixmap samples → PNG encode | `mupdf_real.rs` (`write_to`) |
| 2 | PNG bytes → webview transport | Tauri IPC (`InvokeResponseBody::Raw`, no base64/JSON) |
| 3 | PNG decode → `ImageBitmap` | browser (`createImageBitmap`) |
| + | `engine_open_document` with `bytes` sends a JSON number array — expensive; prefer `path` (Rust reads the file, zero IPC bytes). Small proof files only for bytes. |

## Licensing reminder
VEditor is free and open-source; MuPDF is used under its applicable AGPL
terms. Comply with applicable MuPDF licensing/attribution; re-verify the exact
dependency/version/build before release packaging.
