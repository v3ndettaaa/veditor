//! Backend-agnostic PDF interface. The engine depends only on this trait,
//! never on MuPDF specifics, so tests stay hermetic and the backend can
//! evolve without touching callers.

use veditor_core::{EngineError, Size};

/// Minimal Day-1 backend surface. Day-2 adds open/render/text/search/thumbs.
pub trait PdfBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn page_count(&self) -> u32;
    fn page_size(&self, page: u32) -> Result<Size, EngineError>;
}

/// In-memory stub for engine wiring + unit tests (no native code).
pub struct StubBackend {
    page_count: u32,
    page_size: Size,
}

impl StubBackend {
    pub fn new(page_count: u32, page_size: Size) -> Self {
        Self { page_count, page_size }
    }
}

impl PdfBackend for StubBackend {
    fn name(&self) -> &'static str {
        "stub"
    }

    fn page_count(&self) -> u32 {
        self.page_count
    }

    fn page_size(&self, page: u32) -> Result<Size, EngineError> {
        if page < self.page_count {
            Ok(self.page_size)
        } else {
            Err(EngineError::InvalidPage(page))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_serves_sizes_and_rejects_oob_pages() {
        let b = StubBackend::new(3, Size::new(612.0, 792.0));
        assert_eq!(b.page_count(), 3);
        assert_eq!(b.page_size(0).unwrap(), Size::new(612.0, 792.0));
        assert!(matches!(b.page_size(3), Err(EngineError::InvalidPage(3))));
    }
}
