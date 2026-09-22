//! MuPDF backend placeholder for default builds (no native toolchain).
//!
//! MuPDF is the chosen PDF backend for VEditor. The real implementation is
//! `MupdfBackend` in `mupdf_real.rs` (`--features mupdf`, pending libclang).
//! This stub keeps the default build green and fails loudly if used.

use veditor_core::{DocHandle, EngineError, RenderedTile, Size, TileSpec};

use super::backend::PdfBackend;

/// Placeholder for the MuPDF-backed implementation.
pub struct MupdfBackendStub;

impl MupdfBackendStub {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MupdfBackendStub {
    fn default() -> Self {
        Self::new()
    }
}

fn not_integrated(what: &str) -> EngineError {
    EngineError::Backend(format!(
        "MuPDF backend not integrated yet (libclang pending, {what}); \
         rebuild with --features mupdf"
    ))
}

impl PdfBackend for MupdfBackendStub {
    fn name(&self) -> &'static str {
        "mupdf-stub"
    }

    fn open_from_bytes(&self, _bytes: &[u8]) -> Result<DocHandle, EngineError> {
        Err(not_integrated("open"))
    }

    fn close(&self, _doc: DocHandle) {}

    fn page_count(&self, _doc: DocHandle) -> Result<u32, EngineError> {
        Err(not_integrated("page_count"))
    }

    fn page_size(&self, _doc: DocHandle, page: u32) -> Result<Size, EngineError> {
        let _ = page;
        Err(not_integrated("page_size"))
    }

    fn render_tile_png(&self, _doc: DocHandle, _spec: &TileSpec) -> Result<RenderedTile, EngineError> {
        Err(not_integrated("render"))
    }
}
