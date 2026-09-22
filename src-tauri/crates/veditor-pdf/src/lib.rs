//! `veditor-pdf`: PDF backend integration. MuPDF is the chosen backend.
//!
//! Day-1 scope: backend-agnostic `PdfBackend` trait + `StubBackend` (tests) +
//! `MupdfBackendStub` (explicit MuPDF target placeholder). No real MuPDF rendering;
//! Day-2 integrates the real backend (see `docs/RUST_ARCHITECTURE.md`).

mod backend;
mod mupdf;

pub use backend::{PdfBackend, StubBackend};
pub use mupdf::MupdfBackendStub;
