//! Headless real-pixel proof for the MuPDF backend.
//!
//! Requires `--features mupdf` (native toolchain). Uses the operator-supplied
//! `tests/data/f.pdf` fixture: opens it, renders tiles, decodes the PNGs and
//! asserts real content pixels — no stubs anywhere in this path.

#![cfg(feature = "mupdf")]

use image::GenericImageView;
use veditor_core::{DocumentId, TileId, TileSpec};
use veditor_pdf::{MupdfBackend, PdfBackend};

const FIXTURE: &[u8] = include_bytes!("data/f.pdf");

/// Build a spec the way the viewer does: `dpr` is the final geometry
/// backing multiplier (target-DPI factor included), so device scale is
/// exactly zoom*dpr per the TileId contract.
fn spec(page: u32, zoom: f64, dpr: f64, rotation: i32, tx: u32, ty: u32) -> TileSpec {
    TileSpec::new(TileId::new(DocumentId::new("f"), page, zoom, dpr, rotation, tx, ty))
}

/// Geometry multiplier the viewer would compute for 150 DPI target.
const DPR_150: f64 = 150.0 / 72.0;

/// Decode a rendered tile and count non-white pixels.
fn decode(tile: &veditor_core::RenderedTile) -> (u32, u32, u64) {
    assert!(
        tile.png.starts_with(&[0x89, b'P', b'N', b'G']),
        "tile is not a PNG"
    );
    let img = image::load_from_memory(&tile.png).expect("tile PNG must decode");
    let (w, h) = img.dimensions();
    assert_eq!((w, h), (tile.width, tile.height), "dims must match header");
    let rgb = img.to_rgb8();
    let non_white = rgb.pixels().filter(|p| p[0] < 250 || p[1] < 250 || p[2] < 250).count() as u64;
    (w, h, non_white)
}

#[test]
fn mupdf_renders_real_pixels_from_fixture() {
    assert!(FIXTURE.starts_with(b"%PDF-"), "fixture must be a real PDF");
    let backend = MupdfBackend::with_target_dpi(150.0);
    assert_eq!(backend.name(), "mupdf");
    let doc = backend.open_from_bytes(FIXTURE).expect("open f.pdf");
    let count = backend.page_count(doc).expect("page count");
    assert!(count >= 1, "fixture must have at least one page, got {count}");

    let size = backend.page_size(doc, 0).expect("page 0 size");
    assert!(size.width > 0.0 && size.height > 0.0, "positive page size: {size:?}");

    // Tile (0,0) at zoom 1: full 512x512 unless the page is smaller.
    let scale = 1.0 * DPR_150;
    let exp_w = (512.0f64).min(size.width * scale) as u32;
    let exp_h = (512.0f64).min(size.height * scale) as u32;
    let tile = backend.render_tile_png(doc, &spec(0, 1.0, DPR_150, 0, 0, 0)).expect("render tile");
    let (w, h, non_white) = decode(&tile);
    assert_eq!((w, h), (exp_w, exp_h));

    // Edge tile (2,3): clamped partial dimensions prove region clipping.
    let edge = backend.render_tile_png(doc, &spec(0, 1.0, DPR_150, 0, 2, 3)).expect("render edge");
    let page_w = (size.width * scale).round() as u32;
    let page_h = (size.height * scale).round() as u32;
    let (ew, eh, _) = decode(&edge);
    // ±1px tolerance: MuPDF derives pixmap rects via float CTM + irect
    // floor/ceil, which can differ by a pixel from the naive .round estimate.
    let (xw, xh) = (512.min(page_w - 1024), 512.min(page_h - 1536));
    assert!((ew as i32 - xw as i32).abs() <= 1 && (eh as i32 - xh as i32).abs() <= 1,
        "edge tile dims {ew}x{eh} vs estimated {xw}x{xh}");

    // At least one of the first pages must carry real (non-white) content.
    let mut found = non_white;
    for page in 1..count.min(3) {
        if found > 100 {
            break;
        }
        let t = backend.render_tile_png(doc, &spec(page, 1.0, DPR_150, 0, 0, 0)).expect("render");
        found = found.max(decode(&t).2);
    }
    assert!(found > 100, "no content pixels found on first pages (blank render?)");

    backend.close(doc);
}

#[test]
fn mupdf_rotation_renders_valid_tiles() {
    let backend = MupdfBackend::with_target_dpi(150.0);
    let doc = backend.open_from_bytes(FIXTURE).expect("open f.pdf");
    // 90° rotation must produce a valid tile (dims follow the swapped extents).
    let tile = backend.render_tile_png(doc, &spec(0, 1.0, DPR_150, 90, 0, 0)).expect("rot90 tile");
    let (w, h, _) = decode(&tile);
    assert!(w > 0 && h > 0);
    assert!(w <= 512 && h <= 512);
    backend.close(doc);
}
