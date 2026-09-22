//! MuPDF backend target (Day-1 placeholder).
//!
//! MuPDF is the chosen PDF backend for VEditor. The real `mupdf` crate wiring
//! (open/render/text) lands Day-2 so Day-1 needs no native MuPDF toolchain.
//! This stub pins the architecture to MuPDF and fails loudly if used early.

use veditor_core::{EngineError, Size};

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

impl PdfBackend for MupdfBackendStub {
    fn name(&self) -> &'static str {
        "mupdf"
    }

    fn page_count(&self) -> u32 {
        0
    }

    fn page_size(&self, page: u32) -> Result<Size, EngineError> {
        Err(EngineError::Backend(format!(
            "MuPDF backend not integrated yet (page {page} requested Day-1)"
        )))
    }
}
