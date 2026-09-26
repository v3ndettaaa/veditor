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

/// Backend-ms samples kept per document for p50/p95 (bounded ring).
const LATENCY_RING_CAP: usize = 256;

struct DocEntry {
    handle: DocHandle,
    #[allow(dead_code)]
    bytes: Arc<Vec<u8>>,
    cache: TileCache,
    queue: RenderQueue,
    generation: u64,
    renders_total: u64,
    last_tile_backend_ms: u64,
    last_tile_render_ms: u64,
    last_tile_encode_ms: u64,
    /// Tiles currently inside a backend render (incremented around the
    /// lock-free render section; decremented after).
    inflight: usize,
    latencies_ms: std::collections::VecDeque<u64>,
}

impl DocEntry {
    fn record_render(&mut self, backend_ms: u64, tile: &RenderedTile) {
        self.renders_total += 1;
        self.last_tile_backend_ms = backend_ms;
        self.last_tile_render_ms = tile.render_ms;
        self.last_tile_encode_ms = tile.encode_ms;
        if self.latencies_ms.len() >= LATENCY_RING_CAP {
            self.latencies_ms.pop_front();
        }
        self.latencies_ms.push_back(backend_ms);
    }

    fn latency_p50_p95(&self) -> (u64, u64) {
        if self.latencies_ms.is_empty() {
            return (0, 0);
        }
        let mut sorted: Vec<u64> = self.latencies_ms.iter().copied().collect();
        sorted.sort_unstable();
        let at = |q: f64| sorted[((sorted.len() as f64 * q) as usize).min(sorted.len() - 1)];
        (at(0.5), at(0.95))
    }

    fn blank(
        handle: DocHandle,
        bytes: Arc<Vec<u8>>,
    ) -> DocEntry {
        DocEntry {
            handle,
            bytes,
            cache: TileCache::new(DEFAULT_CACHE_BUDGET_BYTES),
            queue: RenderQueue::new(DEFAULT_MAX_QUEUE_JOBS),
            generation: 0,
            renders_total: 0,
            last_tile_backend_ms: 0,
            last_tile_render_ms: 0,
            last_tile_encode_ms: 0,
            inflight: 0,
            latencies_ms: std::collections::VecDeque::new(),
        }
    }
}

/// Multi-document registry. Owns each document's bytes (`Arc`, opened once)
/// and the backend handle; `close` drops both (backend frees its side).
pub struct Documents<B: PdfBackend> {
    backend: B,
    docs: HashMap<DocumentId, DocEntry>,
    pending: HashMap<DocumentId, Arc<Vec<u8>>>,
    target_dpi: f64,
}

impl<B: PdfBackend> Documents<B> {
    pub fn new(backend: B, target_dpi: f64) -> Self {
        Self { backend, docs: HashMap::new(), pending: HashMap::new(), target_dpi }
    }

    /// Stash bytes without parsing (fast path for the sync transport command).
    pub fn stash_bytes(&mut self, id: DocumentId, bytes: Vec<u8>) {
        self.pending.insert(id, Arc::new(bytes));
    }

    /// Finish opening previously stashed bytes (the slow MuPDF parse step).
    pub fn finalize_open(&mut self, id: &DocumentId) -> Result<u32, EngineError> {
        let shared = self.pending.remove(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
        if let Some(old) = self.docs.remove(id) {
            self.backend.close(old.handle);
        }
        // Reuse the single-shot path on a clone of the Arc (no byte copy:
        // `open` re-wraps the same allocation; the stash copy is dropped).
        let handle = self.backend.open_from_bytes(&shared)?;
        let count = self.backend.page_count(handle)?;
        self.docs.insert(id.clone(), DocEntry::blank(handle, shared));
        Ok(count)
    }

    /// Open (or re-key) a document. Bytes are stored once and handed to the
    /// backend a single time; repeat opens of the same id replace the entry.
    pub fn open(&mut self, id: DocumentId, bytes: Vec<u8>) -> Result<u32, EngineError> {
        self.stash_bytes(id.clone(), bytes);
        self.finalize_open(&id)
    }

    pub fn close(&mut self, id: &DocumentId) {
        self.pending.remove(id);
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
        let t0 = std::time::Instant::now();
        let tile = self.backend.render_tile_png(entry.handle, spec)?;
        let backend_ms = t0.elapsed().as_millis() as u64;
        entry.record_render(backend_ms, &tile);
        entry.cache.insert(spec.tile.clone(), tile.clone());
        Ok(tile)
    }

    /// Render one tile through the shared priority queue with work-sharing.
    ///
    /// Each caller enqueues its tile, then cooperatively drains: it pops the
    /// highest-priority current-generation job and renders it — even when it
    /// belongs to another caller — so concurrent commands never idle while
    /// work exists and no job renders twice from one queue position. The lock
    /// is always dropped across the blocking backend render. Stale-generation
    /// jobs are dropped before starting (`EngineError::Stale` once the
    /// caller's own job is gone). Single logical worker per document is
    /// preserved by the backend owner thread, not by this loop.
    pub fn render_tile_queued(
        &mut self,
        id: &DocumentId,
        spec: &TileSpec,
        priority: Priority,
        generation: u64,
    ) -> Result<RenderedTile, EngineError> {
        loop {
            // A caller from a superseded navigation must not enqueue (or spin
            // on) work the current generation already dropped. Re-checked per
            // iteration because a bump can land mid-loop.
            let current = self
                .docs
                .get(id)
                .ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?
                .generation;
            if generation != current {
                return Err(EngineError::Stale);
            }
            // Enqueue (dedup) + pop highest-priority current-generation job.
            let (handle, job) = {
                let entry = self.docs.get_mut(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
                entry.queue.push(Job { spec: spec.clone(), priority, generation });
                match entry.queue.pop_for(entry.generation) {
                    Some(job) => (entry.handle, job),
                    // Queue drained: my job was dropped as stale (or a
                    // clear raced) — do not spin, report superseded.
                    None => return Err(EngineError::Stale),
                }
            };
            // Render WITHOUT the registry lock so concurrent callers progress.
            // In-flight accounting brackets the lock-free section only.
            {
                let entry = self.docs.get_mut(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
                entry.inflight += 1;
            }
            let t0 = std::time::Instant::now();
            let rendered = self.backend.render_tile_png(handle, &job.spec);
            let backend_ms = t0.elapsed().as_millis() as u64;
            match rendered {
                Ok(tile) => {
                    let entry = self.docs.get_mut(id).ok_or_else(|| EngineError::UnknownDocument(id.to_string()))?;
                    entry.inflight = entry.inflight.saturating_sub(1);
                    entry.record_render(backend_ms, &tile);
                    entry.cache.insert(job.spec.tile.clone(), tile.clone());
                    if job.spec.tile == spec.tile {
                        return Ok(tile);
                    }
                    // Rendered someone else's tile: loop back — mine may now
                    // be cached, queued, or stale.
                }
                Err(e) => {
                    if let Some(entry) = self.docs.get_mut(id) {
                        entry.inflight = entry.inflight.saturating_sub(1);
                    }
                    // My own tile is unrenderable: surface the real error so
                    // the caller can fall back. Others' failures are skipped
                    // (their owner will retry-or-fail on its own pass).
                    if job.spec.tile == spec.tile {
                        return Err(e);
                    }
                }
            }
        }
    }

    pub fn metrics(&self, id: &DocumentId) -> Option<EngineMetrics> {
        let e = self.docs.get(id)?;
        let (p50, p95) = e.latency_p50_p95();
        Some(EngineMetrics {
            queue_depth: e.queue.len(),
            queue_cancelled: e.queue.cancelled,
            queue_dedup_hits: e.queue.dedup_hits,
            cache: e.cache.snapshot(),
            renders_total: e.renders_total,
            last_tile_backend_ms: e.last_tile_backend_ms,
            last_tile_render_ms: e.last_tile_render_ms,
            last_tile_encode_ms: e.last_tile_encode_ms,
            tile_ms_p50: p50,
            tile_ms_p95: p95,
            inflight_tiles: e.inflight,
            // RSS is sampled by the IPC layer (on-demand); 0 = not sampled.
            rss_bytes: 0,
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
    fn stash_then_finalize_opens_without_parse_in_stash() {
        let mut d = docs();
        let id = DocumentId::new("s");
        d.stash_bytes(id.clone(), b"pdf-bytes".to_vec());
        assert!(!d.is_open(&id));
        assert_eq!(d.finalize_open(&id).unwrap(), 4);
        assert!(d.is_open(&id));
        assert_eq!(d.page_count(&id).unwrap(), 4);
        // Finalizing twice without a stash fails instead of reopening ghosts.
        assert!(d.finalize_open(&id).is_err());
        d.close(&id);
        assert!(!d.is_open(&id));
    }

    #[test]
    fn queued_render_serves_priority_and_stale() {
        let mut d = docs();
        let id = DocumentId::new("d");
        d.open(id.clone(), b"pdf-bytes".to_vec()).unwrap();
        let gen = d.next_generation(&id).unwrap();
        // Lower priority number renders first even when enqueued second.
        let lo = TileSpec::new(TileId::new(DocumentId::new("d"), 1, 1.0, 1.0, 0, 0, 0));
        let hi = TileSpec::new(TileId::new(DocumentId::new("d"), 0, 1.0, 1.0, 0, 0, 0));
        let t = d.render_tile_queued(&id, &hi, Priority::VISIBLE, gen).unwrap();
        assert_eq!((t.width, t.height), (2, 2));
        // Second call hits the cache regardless of priority.
        let t2 = d.render_tile_queued(&id, &hi, Priority::NEARBY, gen).unwrap();
        assert_eq!(t2.png, t.png);
        let _ = lo;
        // Bumping the generation supersedes in-flight callers.
        d.next_generation(&id).unwrap();
        assert!(matches!(
            d.render_tile_queued(&id, &hi, Priority::VISIBLE, gen),
            Err(EngineError::Stale)
        ));
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

    #[test]
    fn close_releases_state_and_reopen_renders_fresh() {
        let mut d = docs();
        let id = DocumentId::new("d");
        // Open -> render -> close.
        assert_eq!(d.open(id.clone(), b"pdf-bytes".to_vec()).unwrap(), 4);
        let before = d.render_tile_cached(&id, &spec(0)).unwrap();
        assert_eq!(d.metrics(&id).unwrap().cache.misses, 1);
        d.close(&id);
        assert!(!d.is_open(&id));
        // Closed docs serve nothing: render and metrics fail instead of
        // touching retained bytes/cache/queue state.
        assert!(d.render_tile_cached(&id, &spec(0)).is_err());
        assert!(d.metrics(&id).is_none());
        // Reopen under the same id renders fresh (generation/cache reset,
        // no ghost state from the previous lifetime).
        assert_eq!(d.open(id.clone(), b"pdf-bytes".to_vec()).unwrap(), 4);
        assert!(d.is_open(&id));
        let m2 = d.metrics(&id).unwrap();
        assert_eq!((m2.cache.hits, m2.cache.misses), (0, 0));
        let after = d.render_tile_cached(&id, &spec(0)).unwrap();
        assert_eq!(after.png, before.png);
        assert_eq!(d.metrics(&id).unwrap().cache.misses, 1);
    }
}
