//! `veditor-core`: shared frontend-independent domain types and primitives.
//!
//! Mirrors the semantics of `src/core/types.ts` (BoundingBox, rotation about the
//! box center), `src/core/viewport.ts` (focal zoom layouts) and `src/utils/dpi.ts`
//! (`targetDPI / 72`). No PDF, render, or Tauri dependencies.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Opaque document handle. The engine keys every open document by this id so
/// multi-tab sessions stay isolated (mirrors `DocumentSession.id`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DocumentId(pub String);

impl DocumentId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Zero-based page index (mirrors `PageInfo.pageIndex`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PageId(pub u32);

impl PageId {
    pub fn new(index: u32) -> Self {
        Self(index)
    }

    pub fn index(self) -> u32 {
        self.0
    }
}

/// Opaque annotation handle (mirrors `BaseAnnotation.id`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AnnotationId(pub String);

impl AnnotationId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl fmt::Display for AnnotationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Point in PDF page space (points, 72 DPI grid).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y, pressure: 0.5 }
    }

    pub fn with_pressure(x: f64, y: f64, pressure: f64) -> Self {
        Self { x, y, pressure }
    }
}

/// Size in PDF points.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Size {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

/// Axis-aligned rectangle in page space. Rotation (radians about the box center,
/// mirroring `BaseAnnotation.rotation`) is stored separately by owners, never here.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x
            && p.x <= self.x + self.width
            && p.y >= self.y
            && p.y <= self.y + self.height
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

/// Uniform scale + translation (CSS px <-> page points).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub scale: f64,
    pub tx: f64,
    pub ty: f64,
}

impl Transform {
    pub fn identity() -> Self {
        Self { scale: 1.0, tx: 0.0, ty: 0.0 }
    }

    pub fn apply(&self, p: Point) -> Point {
        Point {
            x: p.x * self.scale + self.tx,
            y: p.y * self.scale + self.ty,
            pressure: p.pressure,
        }
    }
}

/// View state for one page (mirrors `store` zoom + `viewport` layout inputs).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub page: PageId,
    pub zoom: f64,
    pub dpr: f64,
    /// User rotation in degrees (0/90/180/270).
    pub rotation_deg: i32,
}

impl Viewport {
    pub fn new(page: PageId, zoom: f64, dpr: f64, rotation_deg: i32) -> Self {
        Self { page, zoom, dpr, rotation_deg }
    }
}

/// PDF point grid density (mirrors `BASE_PDF_DPI` in `src/utils/dpi.ts`).
pub const BASE_PDF_DPI: f64 = 72.0;

/// Backing-store scale for a target DPI (mirrors `resolveRenderDpr`).
pub fn tile_scale_for_dpi(target_dpi: f64, fallback_dpi: f64) -> f64 {
    let dpi = if target_dpi.is_finite() && target_dpi > 0.0 {
        target_dpi
    } else {
        fallback_dpi
    };
    dpi / BASE_PDF_DPI
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("no document open")]
    NotOpen,
    #[error("invalid page index {0}")]
    InvalidPage(u32),
    #[error("backend error: {0}")]
    Backend(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains_and_intersects() {
        let r = Rect::new(0.0, 0.0, 100.0, 50.0);
        assert!(r.contains(Point::new(10.0, 10.0)));
        assert!(!r.contains(Point::new(200.0, 10.0)));
        assert!(r.intersects(&Rect::new(50.0, 25.0, 100.0, 100.0)));
        assert!(!r.intersects(&Rect::new(200.0, 200.0, 10.0, 10.0)));
    }

    #[test]
    fn transform_applies_scale_and_offset() {
        let t = Transform { scale: 2.0, tx: 5.0, ty: -3.0 };
        let p = t.apply(Point::new(10.0, 10.0));
        assert_eq!((p.x, p.y), (25.0, 17.0));
    }

    #[test]
    fn dpi_scale_matches_ts_resolve_render_dpr() {
        assert_eq!(tile_scale_for_dpi(144.0, 72.0), 2.0);
        assert_eq!(tile_scale_for_dpi(0.0, 144.0), 2.0);
    }
}
