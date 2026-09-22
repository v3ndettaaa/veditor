//! `veditor-pdf`: PDF backend integration. MuPDF is the chosen backend.
//!
//! - Default build: backend-agnostic `PdfBackend` trait + `StubBackend`
//!   (tests/wiring) + `MupdfBackendStub` placeholder. No native toolchain needed.
//! - `--features mupdf`: real `MupdfBackend` (`mupdf` 0.8, default features).
//!   Needs a C/C++ toolchain + libclang (`LIBCLANG_PATH`); on Linux also
//!   libfontconfig1-dev. Windows MSBuild requires
//!   `MUPDF_MSVC_PLATFORM_TOOLSET=v145` with VS 18 BuildTools.

mod backend;
mod mupdf;
#[cfg(feature = "mupdf")]
mod mupdf_real;

pub use backend::{PdfBackend, StubBackend};
pub use mupdf::MupdfBackendStub;
#[cfg(feature = "mupdf")]
pub use mupdf_real::{layout_tile, rotate_point, MupdfBackend, TileLayout};
