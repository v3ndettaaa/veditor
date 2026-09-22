//! Backend-agnostic PDF interface. The engine depends only on this trait,
//! never on MuPDF specifics, so tests stay hermetic and the backend can
//! evolve without touching callers.
//!
//! `PdfBackend: Send + Sync` is load-bearing: the real MuPDF types are
//! `!Send + !Sync`, so `MupdfBackend` encapsulates its owner thread(s) and
//! exposes only channel senders (see `mupdf_real.rs`).

use veditor_core::{DocHandle, EngineError, RenderedTile, Size, TileSpec};

/// Backend surface for document lifetime + tile rendering.
/// Day-2: open/close/count/size/render. Text/search/thumbs arrive later.
pub trait PdfBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn open_from_bytes(&self, bytes: &[u8]) -> Result<DocHandle, EngineError>;
    fn close(&self, doc: DocHandle);
    fn page_count(&self, doc: DocHandle) -> Result<u32, EngineError>;
    fn page_size(&self, doc: DocHandle, page: u32) -> Result<Size, EngineError>;
    fn render_tile_png(&self, doc: DocHandle, spec: &TileSpec) -> Result<RenderedTile, EngineError>;
}

/// Smallest valid 2x2 RGBA PNG (opaque red/green/blue/white), used by the
/// stub so tile plumbing is testable without native code. Pixel fidelity is
/// validated against the real backend at integration time, not here.
const STUB_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xFD,
    0xD4, 0x9A, 0x73, 0x00, 0x00, 0x00, 0x16, 0x49, 0x44, 0x41, 0x54, 0x78, 0x01, 0x01, 0x0B,
    0x00, 0xF4, 0xFF, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0xFF,
    0xFF, 0xFF, 0x03, 0x00, 0x08, 0x43, 0x02, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// In-memory stub for engine wiring + unit tests (no native code).
/// Single fixed document: N letter pages; every tile returns `STUB_PNG`.
pub struct StubBackend {
    page_count: u32,
    page_size: Size,
}

impl StubBackend {
    pub fn new(page_count: u32, page_size: Size) -> Self {
        Self { page_count, page_size }
    }

    fn check_page(&self, page: u32) -> Result<(), EngineError> {
        if page < self.page_count {
            Ok(())
        } else {
            Err(EngineError::InvalidPage(page))
        }
    }
}

impl PdfBackend for StubBackend {
    fn name(&self) -> &'static str {
        "stub"
    }

    fn open_from_bytes(&self, _bytes: &[u8]) -> Result<DocHandle, EngineError> {
        Ok(DocHandle(1))
    }

    fn close(&self, _doc: DocHandle) {}

    fn page_count(&self, _doc: DocHandle) -> Result<u32, EngineError> {
        Ok(self.page_count)
    }

    fn page_size(&self, _doc: DocHandle, page: u32) -> Result<Size, EngineError> {
        self.check_page(page)?;
        Ok(self.page_size)
    }

    fn render_tile_png(
        &self,
        _doc: DocHandle,
        spec: &TileSpec,
    ) -> Result<RenderedTile, EngineError> {
        self.check_page(spec.tile.page)?;
        Ok(RenderedTile { width: 2, height: 2, png: STUB_PNG.to_vec() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use veditor_core::{DocumentId, TileId};

    fn spec() -> TileSpec {
        TileSpec::new(TileId::new(DocumentId::new("d"), 0, 1.0, 1.0, 0, 0, 0))
    }

    #[test]
    fn stub_serves_lifetime_and_tiles() {
        let b = StubBackend::new(3, Size::new(612.0, 792.0));
        let doc = b.open_from_bytes(b"fake").unwrap();
        assert_eq!(b.page_count(doc).unwrap(), 3);
        assert_eq!(b.page_size(doc, 0).unwrap(), Size::new(612.0, 792.0));
        assert!(matches!(b.page_size(doc, 3), Err(EngineError::InvalidPage(3))));
        let tile = b.render_tile_png(doc, &spec()).unwrap();
        assert_eq!((tile.width, tile.height), (2, 2));
        assert_eq!(tile.cost_bytes(), 16);
        assert!(tile.png.starts_with(&[0x89, b'P', b'N', b'G']));
        b.close(doc);
    }
}
