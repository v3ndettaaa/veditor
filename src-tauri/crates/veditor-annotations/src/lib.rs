//! `veditor-annotations`: annotation models, spatial indexing, hit testing,
//! and dirty regions.
//!
//! Day-1 scope: kind/model/store/rect-query/hit-test/dirty-set only, kept
//! serde-compatible with TS `BaseAnnotation` (`id/pageIndex/box`). The linear
//! scan is intentional for the sprint; an r-tree upgrade is Day-3+ at earliest.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use veditor_core::{AnnotationId, PageId, Point, Rect};

/// Annotation family (mirrors the TS `Annotation` union discriminator).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationKind {
    Pen,
    Highlighter,
    Shape,
    Text,
    Stamp,
    Measure,
    Signature,
    Redaction,
}

/// Minimal annotation record. Full style payloads (colors, widths, points)
/// stay in TS Day-1; the engine only needs identity + page + bounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: AnnotationId,
    pub page: PageId,
    pub kind: AnnotationKind,
    #[serde(rename = "box")]
    pub bbox: Rect,
}

impl Annotation {
    pub fn new(id: AnnotationId, page: PageId, kind: AnnotationKind, bbox: Rect) -> Self {
        Self { id, page, kind, bbox }
    }
}

/// Ordered store (insertion order = paint order; last = topmost).
#[derive(Clone, Debug, Default)]
pub struct AnnotationStore {
    items: Vec<Annotation>,
}

impl AnnotationStore {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn insert(&mut self, ann: Annotation) {
        self.items.push(ann);
    }

    /// All annotations on `page` whose bbox intersects `rect`.
    pub fn query_rect(&self, page: PageId, rect: &Rect) -> Vec<&Annotation> {
        self.items
            .iter()
            .filter(|a| a.page == page && a.bbox.intersects(rect))
            .collect()
    }

    /// Topmost annotation containing `point` (last paint order wins).
    pub fn hit_test(&self, page: PageId, point: Point) -> Option<&Annotation> {
        self.items
            .iter()
            .rev()
            .find(|a| a.page == page && a.bbox.contains(point))
    }
}

/// Pages needing repaint after annotation edits.
#[derive(Clone, Debug, Default)]
pub struct DirtySet {
    pages: HashSet<u32>,
}

impl DirtySet {
    pub fn new() -> Self {
        Self { pages: HashSet::new() }
    }

    pub fn mark(&mut self, page: PageId) {
        self.pages.insert(page.index());
    }

    pub fn take(&mut self) -> HashSet<u32> {
        std::mem::take(&mut self.pages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(id: &str, page: u32, x: f64) -> Annotation {
        Annotation::new(
            AnnotationId::new(id),
            PageId::new(page),
            AnnotationKind::Pen,
            Rect::new(x, 0.0, 10.0, 10.0),
        )
    }

    #[test]
    fn query_and_hit_test_respect_page_and_paint_order() {
        let mut s = AnnotationStore::new();
        s.insert(ann("a", 0, 0.0));
        s.insert(ann("b", 0, 5.0));
        s.insert(ann("c", 1, 0.0));
        assert_eq!(s.query_rect(PageId::new(0), &Rect::new(0.0, 0.0, 6.0, 6.0)).len(), 2);
        assert_eq!(s.query_rect(PageId::new(1), &Rect::new(0.0, 0.0, 6.0, 6.0)).len(), 1);
        assert_eq!(s.hit_test(PageId::new(0), Point::new(6.0, 5.0)).unwrap().id.0, "b");
        let mut dirty = DirtySet::new();
        dirty.mark(PageId::new(2));
        assert!(dirty.take().contains(&2));
    }
}
