//! `veditor-render`: tile/chunk rendering, scheduling, and caching.
//!
//! - `visible_tiles`: pure viewport culling (page + viewport + zoom + DPR).
//! - `RenderQueue`: bounded priority queue with generation-based cancellation.
//! - `TileCache`: byte-budget LRU with hit/miss metrics (replaces the Day-1
//!   fixed-count `RenderCache`, kept for compatibility).
//! - Execution model: a single worker thread renders (MuPDF holds global locks
//!   and its types are `!Send`), so scheduler concurrency is 1 by design.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use veditor_core::{DocumentId, PageId, Rect, RenderedTile, TileId};

/// Cache key: page + quantized zoom/dpr + rotation (mirrors `bitmapKey`).
/// Superseded by `TileId` (which adds document + tile indices); kept so
/// existing callers keep compiling during the migration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileKey {
    pub page: u32,
    pub zoom_milli: u32,
    pub dpr_milli: u32,
    pub rotation_deg: i32,
}

impl TileKey {
    pub fn new(page: PageId, zoom: f64, dpr: f64, rotation_deg: i32) -> Self {
        Self {
            page: page.index(),
            zoom_milli: (zoom * 1000.0).round().clamp(0.0, u32::MAX as f64) as u32,
            dpr_milli: (dpr * 1000.0).round().clamp(0.0, u32::MAX as f64) as u32,
            rotation_deg,
        }
    }
}

/// A tile request: which cached bitmap region to serve or render.
/// Superseded by `TileId` + `RenderQueue::Job`; kept for compatibility.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TileRequest {
    pub key: TileKey,
    pub region: Rect,
}

/// Day-1 fixed-count cache. Superseded by byte-budget `TileCache`; kept so
/// existing callers keep compiling during the migration.
pub struct RenderCache {
    capacity: usize,
    order: Vec<TileKey>,
    entries: HashMap<TileKey, Vec<u8>>,
}

impl RenderCache {
    pub fn new(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), order: Vec::new(), entries: HashMap::new() }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &TileKey) -> Option<&[u8]> {
        self.entries.get(key).map(Vec::as_slice)
    }

    pub fn insert(&mut self, key: TileKey, bytes: Vec<u8>) {
        if !self.entries.contains_key(&key) {
            self.order.push(key);
        }
        self.entries.insert(key, bytes);
        while self.order.len() > self.capacity {
            let oldest = self.order.remove(0);
            self.entries.remove(&oldest);
        }
    }

    pub fn invalidate_page(&mut self, page: PageId) {
        self.order.retain(|k| k.page != page.index());
        self.entries.retain(|k, _| k.page != page.index());
    }
}

/// Viewport in CSS pixels relative to the page's top-left at the given zoom.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewportRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Compute visible tile indices for a page.
///
/// Inputs: page size in PDF points, viewport rect in CSS px (page-relative),
/// zoom, DPR, rotation (0/90/180/270), and prefetch ring (0 = visible only).
/// Output: `(tx, ty)` grid indices clamped to the page; never covers more
/// than the intersecting tiles, so huge pages at high zoom stay cheap.
pub fn visible_tiles(
    page_pts: (f64, f64),
    viewport_css: ViewportRect,
    zoom: f64,
    dpr: f64,
    rotation_deg: i32,
    prefetch_ring: u32,
    tile_px: u32,
) -> Vec<(u32, u32)> {
    if !(zoom.is_finite() && zoom > 0.0 && dpr.is_finite() && dpr > 0.0) || tile_px == 0 {
        return Vec::new();
    }
    let dev = zoom * dpr;
    let (pw, ph) = page_pts;
    let (page_w, page_h) = match ((rotation_deg % 360) + 360) % 360 {
        90 | 270 => (ph * dev, pw * dev),
        _ => (pw * dev, ph * dev),
    };
    // Viewport from CSS px to device px, clamped to the page.
    let vx0 = (viewport_css.x * dev).clamp(0.0, page_w);
    let vy0 = (viewport_css.y * dev).clamp(0.0, page_h);
    let vx1 = ((viewport_css.x + viewport_css.width) * dev).clamp(0.0, page_w);
    let vy1 = ((viewport_css.y + viewport_css.height) * dev).clamp(0.0, page_h);
    if vx1 <= vx0 || vy1 <= vy0 {
        return Vec::new();
    }
    let t = tile_px as f64;
    let cols = (page_w / t).ceil() as u32;
    let rows = (page_h / t).ceil() as u32;
    let (mut x0, mut y0) = ((vx0 / t).floor() as u32, (vy0 / t).floor() as u32);
    let (mut x1, mut y1) = (
        ((vx1 - 1.0).max(0.0) / t).floor() as u32,
        ((vy1 - 1.0).max(0.0) / t).floor() as u32,
    );
    x0 = x0.saturating_sub(prefetch_ring);
    y0 = y0.saturating_sub(prefetch_ring);
    x1 = (x1 + prefetch_ring).min(cols.saturating_sub(1));
    y1 = (y1 + prefetch_ring).min(rows.saturating_sub(1));
    let mut out = Vec::new();
    for ty in y0..=y1 {
        for tx in x0..=x1 {
            out.push((tx, ty));
        }
    }
    out
}

/// Job priority: 1 visible, 2 entering viewport, 3 scroll-direction prefetch,
/// 4 nearby-ring prefetch. Lower number renders first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Priority(pub u8);

impl Priority {
    pub const VISIBLE: Self = Self(1);
    pub const ENTERING: Self = Self(2);
    pub const SCROLL_PREFETCH: Self = Self(3);
    pub const NEARBY: Self = Self(4);
}

/// One queued render job. `generation` is bumped on zoom/scroll commit; jobs
/// from older generations are dropped before rendering (cheap cancellation —
/// MuPDF renders themselves are not abortable, but stale jobs never start).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub tile: TileId,
    pub priority: Priority,
    pub generation: u64,
}

/// Bounded priority queue. Overflow drops the lowest-priority (highest number)
/// job and counts it as cancelled.
pub struct RenderQueue {
    max_jobs: usize,
    jobs: VecDeque<Job>,
    pub cancelled: u64,
}

impl RenderQueue {
    pub fn new(max_jobs: usize) -> Self {
        Self { max_jobs: max_jobs.max(1), jobs: VecDeque::new(), cancelled: 0 }
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Insert unless an identical tile is already queued (dedup).
    pub fn push(&mut self, job: Job) {
        if self.jobs.iter().any(|j| j.tile == job.tile) {
            return;
        }
        // Stable insertion by priority (lower first).
        let pos = self.jobs.iter().position(|j| j.priority > job.priority).unwrap_or(self.jobs.len());
        self.jobs.insert(pos, job);
        while self.jobs.len() > self.max_jobs {
            self.jobs.pop_back();
            self.cancelled += 1;
        }
    }

    /// Pop the next job for `generation`, discarding stale ones first.
    pub fn pop_for(&mut self, generation: u64) -> Option<Job> {
        while let Some(front) = self.jobs.front() {
            if front.generation != generation {
                self.jobs.pop_front();
                self.cancelled += 1;
            } else {
                break;
            }
        }
        self.jobs.pop_front()
    }

    /// Drop everything (e.g. document switch).
    pub fn clear(&mut self) {
        self.cancelled += self.jobs.len() as u64;
        self.jobs.clear();
    }
}

/// Cached tile with accounted cost (decoded-RGBA-equivalent bytes).
struct Entry {
    tile: RenderedTile,
    cost: usize,
}

/// Byte-budget LRU tile cache with hit/miss metrics.
pub struct TileCache {
    budget_bytes: usize,
    used_bytes: usize,
    order: Vec<TileId>,
    entries: HashMap<TileId, Entry>,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

impl TileCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes: budget_bytes.max(1),
            used_bytes: 0,
            order: Vec::new(),
            entries: HashMap::new(),
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&mut self, key: &TileId) -> Option<&RenderedTile> {
        if self.entries.contains_key(key) {
            self.hits += 1;
            // Move to back (most-recently-used).
            if let Some(pos) = self.order.iter().position(|k| k == key) {
                let k = self.order.remove(pos);
                self.order.push(k);
            }
            self.entries.get(key).map(|e| &e.tile)
        } else {
            self.misses += 1;
            None
        }
    }

    pub fn insert(&mut self, key: TileId, tile: RenderedTile) {
        let cost = tile.cost_bytes();
        self.remove(&key);
        // Single tiles larger than the whole budget are still stored (they are
        // the visible page); evict everything else first.
        while self.used_bytes + cost > self.budget_bytes {
            if self.order.is_empty() {
                break;
            }
            let oldest = self.order.remove(0);
            self.remove(&oldest);
            self.evictions += 1;
        }
        self.used_bytes += cost;
        self.order.push(key.clone());
        self.entries.insert(key, Entry { tile, cost });
    }

    fn remove(&mut self, key: &TileId) {
        if let Some(e) = self.entries.remove(key) {
            self.used_bytes = self.used_bytes.saturating_sub(e.cost);
            self.order.retain(|k| k != key);
        }
    }

    pub fn invalidate_doc(&mut self, doc: &DocumentId) {
        let keys: Vec<TileId> = self.order.iter().filter(|k| &k.doc == doc).cloned().collect();
        for k in keys {
            self.remove(&k);
        }
    }

    pub fn snapshot(&self) -> CacheMetrics {
        let total = self.hits + self.misses;
        CacheMetrics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            used_bytes: self.used_bytes,
            budget_bytes: self.budget_bytes,
            tile_count: self.entries.len(),
            hit_rate: if total == 0 { 0.0 } else { self.hits as f64 / total as f64 },
        }
    }
}

/// Serializable cache metrics for the `engine_metrics` command / benchmarks.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CacheMetrics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub used_bytes: usize,
    pub budget_bytes: usize,
    pub tile_count: usize,
    pub hit_rate: f64,
}

/// Full engine metrics snapshot (queue + cache).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineMetrics {
    pub queue_depth: usize,
    pub queue_cancelled: u64,
    pub cache: CacheMetrics,
}

#[cfg(test)]
mod tests {
    use super::*;
    use veditor_core::Point;

    #[test]
    fn legacy_cache_still_evicts_oldest() {
        let mut c = RenderCache::new(2);
        let page = PageId::new(0);
        let region = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(region.contains(Point::new(1.0, 1.0)));
        let a = TileKey::new(page, 1.0, 1.0, 0);
        let b = TileKey::new(page, 2.0, 1.0, 0);
        let d = TileKey::new(page, 3.0, 1.0, 0);
        c.insert(a, vec![1]);
        c.insert(b, vec![2]);
        c.insert(d, vec![3]);
        assert_eq!(c.len(), 2);
        assert!(c.get(&a).is_none());
        c.invalidate_page(page);
        assert!(c.is_empty());
    }

    fn vp(x: f64, y: f64, w: f64, h: f64) -> ViewportRect {
        ViewportRect { x, y, width: w, height: h }
    }

    #[test]
    fn culling_covers_only_intersecting_tiles() {
        // 612x792pt page @ zoom1/dpr1 => 612x792 device px, 512 grid => 2x2.
        let all = visible_tiles((612.0, 792.0), vp(0.0, 0.0, 612.0, 792.0), 1.0, 1.0, 0, 0, 512);
        assert_eq!(all.len(), 4);
        // Top-left 100x100 CSS px => only tile (0,0).
        let one = visible_tiles((612.0, 792.0), vp(0.0, 0.0, 100.0, 100.0), 1.0, 1.0, 0, 0, 512);
        assert_eq!(one, vec![(0, 0)]);
        // High zoom: small viewport still yields few tiles, never the full page.
        let z8 = visible_tiles((612.0, 792.0), vp(0.0, 0.0, 100.0, 100.0), 8.0, 1.0, 0, 0, 512);
        assert!(z8.len() <= 4);
        // Prefetch ring adds neighbors, clamped to the page.
        let pre = visible_tiles((612.0, 792.0), vp(0.0, 0.0, 100.0, 100.0), 1.0, 1.0, 0, 1, 512);
        assert_eq!(pre.len(), 4);
    }

    #[test]
    fn queue_orders_by_priority_and_drops_stale_generations() {
        let mut q = RenderQueue::new(64);
        let doc = DocumentId::new("d");
        let tile = |tx| TileId::new(doc.clone(), 0, 1.0, 1.0, 0, tx, 0);
        q.push(Job { tile: tile(1), priority: Priority::NEARBY, generation: 1 });
        q.push(Job { tile: tile(0), priority: Priority::VISIBLE, generation: 1 });
        // Dedup: same tile twice.
        q.push(Job { tile: tile(0), priority: Priority::VISIBLE, generation: 1 });
        assert_eq!(q.len(), 2);
        // Current generation serves highest priority first.
        let first = q.pop_for(1).unwrap();
        assert_eq!(first.tile, tile(0));
        assert_eq!(q.cancelled, 0);
        // New generation drops the stale remainder without rendering it.
        assert!(q.pop_for(2).is_none());
        assert_eq!(q.cancelled, 1);
    }

    #[test]
    fn cache_enforces_byte_budget_lru() {
        let mut c = TileCache::new(100);
        let doc = DocumentId::new("d");
        let key = |tx| TileId::new(doc.clone(), 0, 1.0, 1.0, 0, tx, 0);
        // 4x4 RGBA-equivalent = 64 bytes each; two exceed the 100 budget.
        let tile = |v| RenderedTile { width: 4, height: 4, png: vec![v; 10] };
        c.insert(key(0), tile(0));
        c.insert(key(1), tile(1)); // evicts key(0): 64+64 > 100
        assert!(c.get(&key(0)).is_none());
        assert!(c.get(&key(1)).is_some());
        assert_eq!(c.evictions, 1);
        let m = c.snapshot();
        assert_eq!((m.hits, m.misses), (1, 1));
        assert!((m.hit_rate - 0.5).abs() < 1e-9);
        c.invalidate_doc(&doc);
        assert!(c.is_empty());
    }
}
