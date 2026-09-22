//! `veditor-render`: tile/chunk rendering, scheduling, and caching.
//!
//! Day-1 scope: key/request/cache types only (opaque bytes, no raster).
//! Mirrors `bitmapKey` + bitmap cap 6 in `src/core/pdf-engine.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use veditor_core::{PageId, Rect};

/// Cache key: page + quantized zoom/dpr + rotation (mirrors `bitmapKey`).
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
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TileRequest {
    pub key: TileKey,
    pub region: Rect,
}

/// Small LRU-ish cache keyed by `TileKey`. Bytes stay opaque Day-1
/// (real raster pixels arrive with the MuPDF integration, Day-2).
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
            // Only evict if no newer insert re-added it (keys are unique here).
            self.entries.remove(&oldest);
        }
    }

    pub fn invalidate_page(&mut self, page: PageId) {
        self.order.retain(|k| k.page != page.index());
        self.entries.retain(|k, _| k.page != page.index());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use veditor_core::Point;

    #[test]
    fn cache_evicts_oldest_beyond_capacity() {
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
}
