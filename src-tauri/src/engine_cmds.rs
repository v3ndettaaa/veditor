//! Tauri commands exposing the Rust render engine to the Vanilla TS frontend.
//!
//! This module is the ONLY layer the frontend may call. Binary tile payloads
//! travel as `tauri::ipc::Response` (`InvokeResponseBody::Raw`), never as
//! base64/JSON. Backend selection: default builds use `StubBackend` (hermetic,
//! no native toolchain); `--features mupdf` builds use the real `MupdfBackend`
//! (see `docs/DAY2_MUPDF.md`).

use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;
use veditor_engine::{Documents, DocumentId, EngineError, EngineMetrics, Size, TileSpec};
#[cfg(feature = "mupdf")]
use veditor_engine::MupdfBackend;
#[cfg(not(feature = "mupdf"))]
use veditor_engine::StubBackend;

/// Backend selected by the `mupdf` cargo feature (see `docs/DAY2_MUPDF.md`).
#[cfg(feature = "mupdf")]
type DefaultBackend = MupdfBackend;
#[cfg(not(feature = "mupdf"))]
type DefaultBackend = StubBackend;

pub struct EngineState(pub Mutex<Documents<DefaultBackend>>);

impl EngineState {
    pub fn new() -> Self {
        // 150 DPI matches the TS default `targetDPI` (store.ts).
        #[cfg(feature = "mupdf")]
        let backend = MupdfBackend::with_target_dpi(150.0);
        #[cfg(not(feature = "mupdf"))]
        let backend = StubBackend::new(0, Size::new(612.0, 792.0));
        Self(Mutex::new(Documents::new(backend, 150.0)))
    }
}

impl Default for EngineState {
    fn default() -> Self {
        Self::new()
    }
}

fn err(e: EngineError) -> String {
    e.to_string()
}

/// Open a document in the engine. Prefers `path` (file read in Rust, zero IPC
/// bytes) over `bytes` (JSON number array — expensive, small proof files only).
/// Returns the page count.
#[tauri::command]
pub fn engine_open_document(
    state: State<EngineState>,
    doc_id: String,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
    target_dpi: Option<f64>,
) -> Result<u32, String> {
    let data: Vec<u8> = if let Some(p) = path {
        std::fs::read(&p).map_err(|e| format!("engine: cannot read {p}: {e}"))?
    } else {
        bytes.ok_or_else(|| "engine: need path or bytes".to_string())?
    };
    let _ = target_dpi;
    state
        .0
        .lock()
        .map_err(|_| "engine: state lock poisoned".to_string())?
        .open(DocumentId::new(doc_id), data)
        .map_err(err)
}

#[tauri::command]
pub fn engine_close_document(state: State<EngineState>, doc_id: String) {
    if let Ok(mut docs) = state.0.lock() {
        docs.close(&DocumentId::new(doc_id));
    }
}

#[tauri::command]
pub fn engine_page_count(state: State<EngineState>, doc_id: String) -> Result<u32, String> {
    let docs = state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    docs.page_count(&DocumentId::new(doc_id)).map_err(err)
}

#[tauri::command]
pub fn engine_page_size(
    state: State<EngineState>,
    doc_id: String,
    page: u32,
) -> Result<Size, String> {
    let docs = state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    docs.page_size(&DocumentId::new(doc_id), page).map_err(err)
}

/// Render one tile. `spec` is small JSON; the PNG returns as raw IPC bytes.
/// Copy points: (1) pixmap→PNG encode, (2) IPC transport into the webview,
/// (3) browser PNG decode. No base64, no JSON number arrays for pixels.
#[tauri::command]
pub fn engine_render_tile(state: State<EngineState>, spec: TileSpec) -> Result<Response, String> {
    let mut docs =
        state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    let tile = docs.render_tile_cached(&spec.tile.doc, &spec).map_err(err)?;
    Ok(Response::new(tile.png))
}

#[tauri::command]
pub fn engine_metrics(
    state: State<EngineState>,
    doc_id: String,
) -> Result<Option<EngineMetrics>, String> {
    let docs = state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    Ok(docs.metrics(&DocumentId::new(doc_id)))
}
