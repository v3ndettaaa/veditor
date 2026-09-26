# MuPDF Distribution Note (factual record, not legal advice)

## 1. Building with MuPDF (development capability)
- The default build needs no native toolchain: `veditor-pdf` compiles against
  a backend-agnostic trait plus `StubBackend`, and the app default renderer
  stays `pdfjs` (Legacy). Nothing in this document changes that default.
- `--features mupdf` compiles the real `MupdfBackend` via the `mupdf` 0.8
  crate (`mupdf-sys` builds vendored MuPDF C sources; `bindgen` needs
  libclang). Per-platform setup is documented in
  `src-tauri/crates/veditor-pdf/src/lib.rs` and wired into
  `.github/workflows/release.yml`.

## 2. Distributing MuPDF-enabled binaries
- MuPDF is licensed AGPL-3.0 (or commercial — see §3). The `mupdf` 0.8
  default feature set additionally pulls in components under their own
  licenses (e.g. Tesseract OCR is Apache-2.0).
- Publishing or otherwise distributing a Veditor binary built with
  `--features mupdf` therefore distributes AGPL-3.0-covered code as part of
  the combined work. Sustained distribution requires complying with the
  AGPL-3.0 terms as written (including the source-availability obligations
  for the covered work) or holding a commercial license (§3).
- This repository currently contains no `LICENSE` file; adding one and
  recording the distribution terms is a separate decision, not made here.

## 3. Commercial alternative
- Artifex offers commercial MuPDF licenses, which is the documented
  alternative to AGPL-3.0 compliance for closed distribution. Evaluating or
  purchasing such a license is a project-owner decision, not made here.

## 4. What is unchanged
- In-app renderer default (`pdfjs`), renderer architecture, scheduler,
  cache, transport, annotation system: all untouched by MuPDF CI support.
- Release `v2.0.0` artifacts predate `--features mupdf` and contain no
  MuPDF code (verified: zero `MuPDF` string literals in the Stub binary vs
  present in the MuPDF binary). MuPDF-enabled distribution starts with
  `v2.0.1`.
