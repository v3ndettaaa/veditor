//! `veditor-ink`: stylus/ink pipeline types.
//!
//! Day-1 scope: point/stroke/options + push + length only. Smoothing
//! (Catmull-Rom port of `src/annotations/spline.ts`) is explicitly deferred.

use serde::{Deserialize, Serialize};
use veditor_core::Point;

/// One captured stylus/mouse sample.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct InkPoint {
    pub point: Point,
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub time_ms: u64,
}

impl InkPoint {
    pub fn new(x: f64, y: f64, pressure: f64, time_ms: u64) -> Self {
        Self {
            point: Point::with_pressure(x, y, pressure),
            tilt_x: 0.0,
            tilt_y: 0.0,
            time_ms,
        }
    }
}

/// A single stroke: ordered samples in page space.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InkStroke {
    pub points: Vec<InkPoint>,
}

impl InkStroke {
    pub fn new() -> Self {
        Self { points: Vec::new() }
    }

    pub fn push(&mut self, p: InkPoint) {
        self.points.push(p);
    }
}

/// Capture options mirrored from TS tool settings (subset needed by Day-2).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct InkOpts {
    pub pressure_enabled: bool,
    pub smoothing: u8,
}

impl Default for InkOpts {
    fn default() -> Self {
        Self { pressure_enabled: true, smoothing: 2 }
    }
}

pub fn push_point(stroke: &mut InkStroke, p: InkPoint) {
    stroke.push(p);
}

/// Raw polyline length in page points (no smoothing).
pub fn polyline_len(stroke: &InkStroke) -> f64 {
    stroke
        .points
        .windows(2)
        .map(|w| {
            let dx = w[1].point.x - w[0].point.x;
            let dy = w[1].point.y - w[0].point.y;
            dx.hypot(dy)
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stroke_length_sums_segments() {
        let mut s = InkStroke::new();
        push_point(&mut s, InkPoint::new(0.0, 0.0, 0.5, 0));
        push_point(&mut s, InkPoint::new(3.0, 4.0, 0.5, 8));
        assert_eq!(polyline_len(&s), 5.0);
        assert_eq!(InkOpts::default().smoothing, 2);
    }
}
