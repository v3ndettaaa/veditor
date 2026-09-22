//! `veditor-engine`: high-level engine API coordinating the subsystems.
//!
//! Day-1 scope: stub-backed `Engine` facade only (open/page_count/status).
//! Real MuPDF wiring, tile raster, and annotation/ink flows arrive Day-2+.

pub use veditor_annotations::{Annotation, AnnotationKind, AnnotationStore, DirtySet};
pub use veditor_core::{
    AnnotationId, DocumentId, EngineError, PageId, Point, Rect, Size, Transform, Viewport,
};
pub use veditor_ink::{InkOpts, InkPoint, InkStroke};
pub use veditor_pdf::{MupdfBackendStub, PdfBackend, StubBackend};
pub use veditor_render::{RenderCache, TileKey, TileRequest};

/// Engine coordinating PDF + render + annotation + ink subsystems.
pub struct Engine {
    backend: Box<dyn PdfBackend>,
    annotations: AnnotationStore,
}

impl Engine {
    /// Hermetic stub engine for wiring/tests (no native code).
    pub fn new_stub() -> Self {
        Self {
            backend: Box::new(StubBackend::new(0, Size::new(612.0, 792.0))),
            annotations: AnnotationStore::new(),
        }
    }

    /// Stub open path used by Day-1 smoke tests (bytes ignored).
    pub fn open_stub(page_count: u32) -> Self {
        Self {
            backend: Box::new(StubBackend::new(page_count, Size::new(612.0, 792.0))),
            annotations: AnnotationStore::new(),
        }
    }

    pub fn backend_name(&self) -> &'static str {
        self.backend.name()
    }

    pub fn page_count(&self) -> u32 {
        self.backend.page_count()
    }

    pub fn page_size(&self, page: u32) -> Result<Size, EngineError> {
        self.backend.page_size(page)
    }

    pub fn annotations(&self) -> &AnnotationStore {
        &self.annotations
    }

    pub fn status(&self) -> String {
        format!("engine ok; backend={}; pages={}", self.backend_name(), self.page_count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_engine_reports_status() {
        let e = Engine::open_stub(5);
        assert_eq!(e.page_count(), 5);
        assert_eq!(e.page_size(0).unwrap(), Size::new(612.0, 792.0));
        assert!(e.status().contains("backend=stub"));
    }
}
