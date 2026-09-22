//! `veditor-engine`: high-level engine API coordinating the subsystems.
//!
//! - `Engine`: single-document facade (kept from Day-1, now backed by the
//!   extended `PdfBackend` trait with explicit document handles).
//! - `Documents`: multi-document registry owning open bytes (`Arc`, opened
//!   once — never reopened per tile), per-doc tile cache + render queue,
//!   and metrics. This is what the Tauri commands drive.

use std::collections::HashMap;
use std::sync::Arc;

pub use veditor_annotations::{Annotation, AnnotationKind, AnnotationStore, DirtySet};
pub use veditor_core::{
    AnnotationId, DocHandle, DocumentId, EngineError, PageId, Point, Rect, RenderedTile, Size,
    TileId, TileSpec, Transform, Viewport, TILE_PX,
};
pub use veditor_ink::{InkOpts, InkPoint, InkStroke};
pub use veditor_pdf::{MupdfBackendStub, PdfBackend, StubBackend};
#[cfg(feature = "mupdf")]
pub use veditor_pdf::MupdfBackend;
pub use veditor_render::{
    CacheMetrics, EngineMetrics, Job, Priority, RenderCache, RenderQueue, TileCache, TileKey,
    TileRequest, ViewportRect,
};

/// Default tile cache budget: 256 MiB of decoded-equivalent bytes.
pub const DEFAULT_CACHE_BUDGET_BYTES: usize = 256 * 1024 * 1024;
/// Default render queue bound (single worker drains it).
pub const DEFAULT_MAX_QUEUE_JOBS: usize = 64;

/// Engine coordinating PDF + render + annotation + ink subsystems.
pub struct Engine {
    backend: Box<dyn PdfBackend>,
    handle: Option<DocHandle>,
    annotations: AnnotationStore,
}

impl Engine {
    /// Hermetic stub engine for wiring/tests (no native code).
    pub fn new_stub() -> Self {
        Self {
            backend: Box::new(StubBackend::new(0, Size::new(612.0, 792.0))),
            handle: None,
            annotations: AnnotationStore::new(),
        }
    }

    /// Stub open path used by smoke tests (bytes ignored).
    pub fn open_stub(page_count: u32) -> Self {
        let backend = StubBackend::new(page_count, Size::new(612.0, 792.0));
        let handle = backend.open_from_bytes(&[]).ok();
        Self { backend: Box::new(backend), handle, annotations: AnnotationStore::new() }
    }

    pub fn backend_name(&self) -> &'static str {
        self.backend.name()
    }

    pub fn page_count(&self) -> u32 {
        self.handle.and_then(|h| self.backend.page_count(h).ok()).unwrap_or(0)
    }

    pub fn page_size(&self, page: u32) -> Result<Size, EngineError> {
        let h = self.handle.ok_or(EngineError::NotOpen)?;
        self.backend.page_size(h, page)
    }

    pub fn annotations(&self) -> &AnnotationStore {
        &self.annotations
    }

    pub fn status(&self) -> String {
        format!("engine ok; backend={}; pages={}", self.backend_name(), self.page_count())
    }
}

struct DocEntry {
    handle: DocHandle,
    #[allow(dead_code)]
    bytes: Arc<Vec<u8>>,
    cache: TileCache,
    queue: RenderQueue,
    generation: u64,
}

/// Multi-document registry. Owns each document's bytes (`Arc`, opened once)
/// and the backend handle; `close` drops both (backend frees its side).
pub struct Documents<B: PdfBackend> {
    backend: B,
    docs: HashMap<DocumentId, DocEntry>,
    target_dpi: f64,
}

impl<B: PdfBackend> Documents<B> {
    pub fn new(backend: B, target_dpi: f64) -> Self {
        Self { backend, docs: HashMap::new(), target_dpi }
    }

    /// Open (or re-key) a document. Bytes are stored once and handed to the
    /// backend a single time; repeat opens of the same id replace the entry.
    pub fn open(&mut self, id: DocumentId, bytes: Vec<u8>) -> Result<u32, EngineError> {
        if let Some(old) = self.docs.remove(&id) {
            self.backend.close(old.handle);
        }
        let shared = Arc::new(bytes);
        let handle = self.backend.open_from_bytes(&shared)?;
        let count = self.backend.page_count(handle)?;
        self.docs.insert(
            id,
            DocEntry {
                handle,
                bytes: shared,
                cache: TileCache::new(DEFAULT_CACHE_BUDGET_BYTES),
                queue: RenderQueue::new(DEFAULT_MAX_QUEUE_JOBS),
                generation: 0,
            },
        );
        Ok(count)
    }

    pub fn close(&mut self, id: &DocumentId) {
        if let Some(old) = self.docs.remove(id) {
            self.backend.close(old.handle);
        }
    }

    pub fn is_open(&self, id: &DocumentId) -> bool {
        self.docs.contains_key(id)
    }

    /// DPI the backend was configured with (drives tile device scale).
    pub fn target_dpi(&self) -> f64 {
        self.target_dpi
    }

    pub fn page_count(&self, id: &DocumentId) -> Result<u32, EngineError> {
        let e = self.docs.get(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
        self.backend.page_count(e.handle)
    }

    pub fn page_size(&self, id: &DocumentId, page: u32) -> Result<Size, EngineError> {
        let e = self.docs.get(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
        self.backend.page_size(e.handle, page)
    }

    /// Bump the render generation (zoom/scroll commit); stale queued jobs die.
    pub fn next_generation(&mut self, id: &DocumentId) -> Option<u64> {
        let e = self.docs.get_mut(id)?;
        e.generation += 1;
        Some(e.generation)
    }

    /// Render one tile with cache lookup. Inserts on hit-path completion only
    /// for the entry's current data (no separate stale check needed: the tile
    /// key itself carries zoom/dpr/rotation/tx/ty).
    pub fn render_tile_cached(
        &mut self,
        id: &DocumentId,
        spec: &TileSpec,
    ) -> Result<RenderedTile, EngineError> {
        let entry = self.docs.get_mut(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
        if let Some(hit) = entry.cache.get(&spec.tile) {
            return Ok(hit.clone());
        }
        let tile = self.backend.render_tile_png(entry.handle, spec)?;
        entry.cache.insert(spec.tile.clone(), tile.clone());
        Ok(tile)
    }

    pub fn metrics(&self, id: &DocumentId) -> Option<EngineMetrics> {
        let e = self.docs.get(id)?;
        Some(EngineMetrics {
            queue_depth: e.queue.len(),
            queue_cancelled: e.queue.cancelled,
            cache: e.cache.snapshot(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use veditor_core::Size;

    fn docs() -> Documents<StubBackend> {
        Documents::new(StubBackend::new(4, Size::new(612.0, 792.0)), 150.0)
    }

    fn spec(page: u32) -> TileSpec {
        TileSpec::new(TileId::new(DocumentId::new("d"), page, 1.0, 1.0, 0, 0, 0))
    }

    #[test]
    fn stub_engine_reports_status() {
        let e = Engine::open_stub(5);
        assert_eq!(e.page_count(), 5);
        assert_eq!(e.page_size(0).unwrap(), Size::new(612.0, 792.0));
        assert!(e.status().contains("backend=stub"));
    }

    #[test]
    fn registry_opens_once_and_caches_tiles() {
        let mut d = docs();
        let id = DocumentId::new("d");
        assert_eq!(d.open(id.clone(), b"pdf-bytes".to_vec()).unwrap(), 4);
        assert!(d.is_open(&id));
        let t1 = d.render_tile_cached(&id, &spec(0)).unwrap();
        let t2 = d.render_tile_cached(&id, &spec(0)).unwrap();
        assert_eq!(t1.png, t2.png);
        let m = d.metrics(&id).unwrap();
        assert_eq!((m.cache.hits, m.cache.misses), (1, 1));
        assert!(d.next_generation(&id).is_some());
        d.close(&id);
        assert!(!d.is_open(&id));
    }
}
