//! Real MuPDF backend (`mupdf` 0.8, default features).
//!
//! Compiled only with `--features mupdf` (needs a C/C++ toolchain + libclang;
//! Linux additionally needs libfontconfig1-dev). Default builds use
//! `MupdfBackendStub` so the workspace stays green without native deps.
//!
//! Design notes (verified against mupdf 0.8 docs):
//! - `mupdf::{Document, Page, Pixmap, Device}` are `!Send + !Sync`, so each
//!   open document lives on its own dedicated owner thread. This struct only
//!   holds `mpsc::Sender`s (which are `Send`), keeping `PdfBackend: Send + Sync`.
//! - The worker owns both the source bytes (`Vec<u8>`) and the `Document`,
//!   so no lifetime can outlive its owner. Documents are opened once per
//!   `open_from_bytes` (never reopened per tile) and pages are loaded per job
//!   (cheap handles, never all at once).
//! - Region rendering uses `Device::from_pixmap` over a tile-sized pixmap with
//!   a translated CTM, so huge pages at high zoom never rasterize fully.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;

use mupdf::{Colorspace, Device, Document, ImageFormat, Matrix};
use veditor_core::{DocHandle, EngineError, RenderedTile, Size, TileSpec};

/// Pure tile geometry: device-space page size + clamped tile rect.
/// No MuPDF types — fully unit-testable without native code.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileLayout {
    /// Tile origin/size clamped to the page, in device pixels.
    pub tile_x0: u32,
    pub tile_y0: u32,
    pub tile_w: u32,
    pub tile_h: u32,
    /// Uniform device scale that produced the layout.
    pub scale: f64,
}

/// Compute the layout for a tile on a page of `page_pts` PDF points.
/// Rotation is one of 0/90/180/270 (normalized by `TileId::new`).
/// Returns `TileOutOfBounds` when the tile misses the page.
///
/// Scale contract (see `TileId`): `dpr` MUST already include the target-DPI
/// factor (it is the geometry backing-store multiplier, i.e. device px per
/// CSS px), so device scale is exactly `zoom * dpr` with no further DPI term.
/// Double-counting DPI here silently renders every tile at the wrong scale.
#[allow(clippy::too_many_arguments)]
pub fn layout_tile(
    page_pts: (f64, f64),
    zoom: f64,
    dpr: f64,
    rotation_deg: i32,
    tx: u32,
    ty: u32,
    tile_px: u32,
) -> Result<TileLayout, EngineError> {
    let scale = zoom * dpr;
    if !(scale.is_finite() && scale > 0.0) {
        return Err(EngineError::Backend("non-positive render scale".into()));
    }
    let (pw, ph) = page_pts;
    let (rw, rh) = match ((rotation_deg % 360) + 360) % 360 {
        90 | 270 => (ph * scale, pw * scale),
        _ => (pw * scale, ph * scale),
    };
    let page_w = rw.round().clamp(1.0, u32::MAX as f64) as u32;
    let page_h = rh.round().clamp(1.0, u32::MAX as f64) as u32;
    let x0 = tx.saturating_mul(tile_px);
    let y0 = ty.saturating_mul(tile_px);
    if x0 >= page_w || y0 >= page_h {
        return Err(EngineError::TileOutOfBounds);
    }
    Ok(TileLayout {
        tile_x0: x0,
        tile_y0: y0,
        tile_w: tile_px.min(page_w - x0),
        tile_h: tile_px.min(page_h - y0),
        scale,
    })
}

/// Rotate a point (in scaled page space, y-down) by a quarter-turn rotation
/// about the page origin. Sign convention is validated visually at integration
/// (pdf.js comparison); the pure math is pinned by unit tests below.
pub fn rotate_point(x: f32, y: f32, page_w: f32, page_h: f32, rotation_deg: i32) -> (f32, f32) {
    match ((rotation_deg % 360) + 360) % 360 {
        90 => (page_h - y, x),
        180 => (page_w - x, page_h - y),
        270 => (y, page_w - x),
        _ => (x, y),
    }
}

/// One-shot reply channel payload (plain `mpsc`, no async runtime).
type Reply<T> = mpsc::Sender<Result<T, EngineError>>;

enum WorkerJob {
    PageCount { reply: Reply<u32> },
    PageSize { page: u32, reply: Reply<Size> },
    Render { page: u32, spec: TileSpec, reply: Reply<RenderedTile> },
}

struct DocWorker {
    tx: mpsc::Sender<WorkerJob>,
    join: Option<JoinHandle<()>>,
}

/// Render one tile on the owner thread. Pure geometry first (`layout_tile`),
/// then MuPDF contact only.
fn render_on_owner(
    doc: &Document,
    page_no: u32,
    spec: &TileSpec,
    target_dpi: f64,
) -> Result<RenderedTile, EngineError> {
    let err = |e: mupdf::Error| EngineError::Backend(format!("mupdf: {e}"));
    let page = doc.load_page(page_no as i32).map_err(err)?;
    let bounds = page.bounds().map_err(err)?;
    let page_pts = (bounds.x1 as f64 - bounds.x0 as f64, bounds.y1 as f64 - bounds.y0 as f64);
    let zoom = spec.tile.zoom_milli as f64 / 1000.0;
    let dpr = spec.tile.dpr_milli as f64 / 1000.0;
    // `target_dpi` is informational only: the TileId contract guarantees
    // zoom*dpr is already the full device scale (geometry multiplier).
    let _ = target_dpi;
    let layout = layout_tile(
        page_pts,
        zoom,
        dpr,
        spec.tile.rotation_deg,
        spec.tile.tx,
        spec.tile.ty,
        spec.tile_px,
    )?;
    let s = layout.scale as f32;
    // Explicit page→tile CTM (no reliance on concat-order semantics):
    // scale, rotate about the translated page origin, shift tile to (0,0).
    let ctm = {
        let (ox, oy) = rotate_point(
            -bounds.x0 * s,
            -bounds.y0 * s,
            (page_pts.0 * layout.scale) as f32,
            (page_pts.1 * layout.scale) as f32,
            spec.tile.rotation_deg,
        );
        let ex = rotate_point(s, 0.0, 0.0, 0.0, spec.tile.rotation_deg);
        let ey = rotate_point(0.0, s, 0.0, 0.0, spec.tile.rotation_deg);
        Matrix::new(
            ex.0,
            ex.1,
            ey.0,
            ey.1,
            ox - layout.tile_x0 as f32,
            oy - layout.tile_y0 as f32,
        )
    };
    let mut pixmap = mupdf::Pixmap::new_with_w_h(
        &Colorspace::device_rgb(),
        layout.tile_w as i32,
        layout.tile_h as i32,
        false,
    )
    .map_err(err)?;
    // Opaque white background, matching the pdf.js `alpha:false` canvas.
    pixmap.clear_with(255).map_err(err)?;
    {
        let device = Device::from_pixmap(&pixmap).map_err(err)?;
        page.run(&device, &ctm).map_err(err)?;
    }
    let mut png = Vec::new();
    pixmap.write_to(&mut png, ImageFormat::PNG).map_err(err)?;
    Ok(RenderedTile { width: layout.tile_w, height: layout.tile_h, png })
}

/// Real MuPDF backend. All `mupdf::` contact happens on per-document owner
/// threads; this struct is `Send + Sync` by construction (see impls below).
pub struct MupdfBackend {
    next_id: AtomicU64,
    workers: Mutex<HashMap<u64, DocWorker>>,
    target_dpi: f64,
}

impl MupdfBackend {
    pub fn new() -> Self {
        Self { next_id: AtomicU64::new(1), workers: Mutex::new(HashMap::new()), target_dpi: 150.0 }
    }

    pub fn with_target_dpi(target_dpi: f64) -> Self {
        Self { next_id: AtomicU64::new(1), workers: Mutex::new(HashMap::new()), target_dpi }
    }

    fn call<T>(&self, doc: DocHandle, f: impl FnOnce(&mpsc::Sender<WorkerJob>) -> mpsc::Receiver<Result<T, EngineError>>) -> Result<T, EngineError> {
        let workers = self.workers.lock().map_err(|_| EngineError::Backend("backend lock poisoned".into()))?;
        let w = workers.get(&doc.0).ok_or_else(|| EngineError::UnknownDocument(doc.0.to_string()))?;
        let rx = f(&w.tx);
        drop(workers);
        rx.recv().map_err(|_| EngineError::Backend("render worker gone".into()))?
    }
}

impl Default for MupdfBackend {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: `MupdfBackend` never touches `mupdf::` types itself; every Document,
// Page, Pixmap and Device lives and dies on its owner thread. Only `Sender`s
// (which are `Send`) cross threads, so these impls are sound.
unsafe impl Send for MupdfBackend {}
unsafe impl Sync for MupdfBackend {}

impl super::backend::PdfBackend for MupdfBackend {
    fn name(&self) -> &'static str {
        "mupdf"
    }

    fn open_from_bytes(&self, bytes: &[u8]) -> Result<DocHandle, EngineError> {
        let owned: Vec<u8> = bytes.to_vec();
        let (open_tx, open_rx) = mpsc::channel::<Result<(), EngineError>>();
        let (job_tx, job_rx) = mpsc::channel::<WorkerJob>();
        let target_dpi = self.target_dpi;
        let join = std::thread::spawn(move || {
            let doc = match Document::from_bytes(&owned, "application/pdf") {
                Ok(d) => d,
                Err(e) => {
                    let _ = open_tx.send(Err(EngineError::Backend(format!("mupdf open: {e}"))));
                    return;
                }
            };
            // `_keep_alive` is defensive: the binding copies bytes into its own
            // buffer, but holding them costs nothing and rules out any borrow.
            let _keep_alive = owned;
            let _ = open_tx.send(Ok(()));
            for job in job_rx {
                match job {
                    WorkerJob::PageCount { reply } => {
                        let r = doc.page_count().map(|n| n as u32).map_err(|e| EngineError::Backend(format!("mupdf: {e}")));
                        let _ = reply.send(r);
                    }
                    WorkerJob::PageSize { page, reply } => {
                        let r = (|| -> Result<Size, EngineError> {
                            let err = |e: mupdf::Error| EngineError::Backend(format!("mupdf: {e}"));
                            let p = doc.load_page(page as i32).map_err(err)?;
                            let b = p.bounds().map_err(err)?;
                            Ok(Size::new((b.x1 - b.x0) as f64, (b.y1 - b.y0) as f64))
                        })();
                        let _ = reply.send(r);
                    }
                    WorkerJob::Render { page, spec, reply } => {
                        let _ = reply.send(render_on_owner(&doc, page, &spec, target_dpi));
                    }
                }
            }
        });
        open_rx
            .recv()
            .map_err(|_| EngineError::Backend("render worker failed to start".into()))??;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.workers
            .lock()
            .map_err(|_| EngineError::Backend("backend lock poisoned".into()))?
            .insert(id, DocWorker { tx: job_tx, join: Some(join) });
        Ok(DocHandle(id))
    }

    fn close(&self, doc: DocHandle) {
        if let Ok(mut workers) = self.workers.lock() {
            if let Some(mut w) = workers.remove(&doc.0) {
                drop(w.tx);
                if let Some(join) = w.join.take() {
                    let _ = join.join();
                }
            }
        }
    }

    fn page_count(&self, doc: DocHandle) -> Result<u32, EngineError> {
        self.call(doc, |tx| {
            let (reply_tx, reply_rx) = mpsc::channel();
            let _ = tx.send(WorkerJob::PageCount { reply: reply_tx });
            reply_rx
        })
    }

    fn page_size(&self, doc: DocHandle, page: u32) -> Result<Size, EngineError> {
        self.call(doc, |tx| {
            let (reply_tx, reply_rx) = mpsc::channel();
            let _ = tx.send(WorkerJob::PageSize { page, reply: reply_tx });
            reply_rx
        })
    }

    fn render_tile_png(&self, doc: DocHandle, spec: &TileSpec) -> Result<RenderedTile, EngineError> {
        // `page` is carried on the TileId; the spec's own page field is the
        // single source of truth (no separate page argument to drift).
        let page = spec.tile.page;
        self.call(doc, |tx| {
            let (reply_tx, reply_rx) = mpsc::channel();
            let _ = tx.send(WorkerJob::Render { page, spec: spec.clone(), reply: reply_tx });
            reply_rx
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_clamps_partial_edge_tiles() {
        // 612x792pt @ zoom1/dpr1 => 612x792 device px (dpr is final).
        let l = layout_tile((612.0, 792.0), 1.0, 1.0, 0, 1, 1, 512).unwrap();
        assert_eq!((l.tile_w, l.tile_h), (100, 280));
        assert_eq!((l.tile_x0, l.tile_y0), (512, 512));
        assert_eq!(l.scale, 1.0);
    }

    #[test]
    fn layout_rejects_off_page_tiles_and_swaps_on_rotation() {
        assert!(matches!(
            layout_tile((612.0, 792.0), 1.0, 1.0, 0, 5, 0, 512),
            Err(EngineError::TileOutOfBounds)
        ));
        // 90° rotation swaps device extents: 792 wide, 612 tall.
        let l = layout_tile((612.0, 792.0), 1.0, 1.0, 90, 1, 1, 512).unwrap();
        assert_eq!((l.tile_w, l.tile_h), (280, 100));
    }

    #[test]
    fn layout_scale_is_zoom_times_dpr_with_no_extra_dpi_term() {
        // Geometry multiplier 2.0 at zoom 3 => device scale exactly 6.0.
        let l = layout_tile((100.0, 100.0), 3.0, 2.0, 0, 0, 0, 512).unwrap();
        assert_eq!(l.scale, 6.0);
    }

    #[test]
    fn rotate_point_cycles_back_to_identity() {
        let (w, h) = (100.0, 50.0);
        let (x, y) = (10.0, 20.0);
        let r90 = rotate_point(x, y, w, h, 90);
        let r180 = rotate_point(r90.0, r90.1, h, w, 90);
        let r270 = rotate_point(r180.0, r180.1, w, h, 90);
        let back = rotate_point(r270.0, r270.1, h, w, 90);
        assert!((back.0 - x).abs() < 1e-4 && (back.1 - y).abs() < 1e-4);
    }
}
