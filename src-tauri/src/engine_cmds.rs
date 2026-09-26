//! Tauri commands exposing the Rust render engine to the Vanilla TS frontend.
//!
//! This module is the ONLY layer the frontend may call. Binary tile payloads
//! travel as `tauri::ipc::Response` (`InvokeResponseBody::Raw`), never as
//! base64/JSON. Backend selection: default builds use `StubBackend` (hermetic,
//! no native toolchain); `--features mupdf` builds use the real `MupdfBackend`
//! (see `docs/DAY2_MUPDF.md`).

use std::sync::Mutex;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Manager, State};
use veditor_engine::{Documents, DocumentId, EngineError, TileSpec};
#[cfg(not(feature = "mupdf"))]
use veditor_engine::Size;
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

/// Open a document in the engine from a filesystem path (read in Rust, zero
/// IPC bytes). Returns the page count. For in-memory bytes use
/// `engine_open_bytes` (raw binary transport) — JSON number arrays are
/// banned (see the `engine-transport` regression test).
/// Async (threadpool): document open parses + spawns the owner thread, which
/// takes seconds on large PDFs — it must never run on the main thread.
#[tauri::command]
pub async fn engine_open_document(
    app: AppHandle,
    doc_id: String,
    path: String,
) -> Result<u32, String> {
    let data: Vec<u8> =
        std::fs::read(&path).map_err(|e| format!("engine: cannot read {path}: {e}"))?;
    app.state::<EngineState>()
        .0
        .lock()
        .map_err(|_| "engine: state lock poisoned".to_string())?
        .open(DocumentId::new(doc_id), data)
        .map_err(err)
}

/// Stash raw binary IPC bytes for a document. The frontend passes the
/// `Uint8Array` directly as the invoke payload (no JSON/base64); metadata
/// travels in headers (`x-doc-id` required). SYNC and fast by design: it only
/// moves bytes into registry storage (ms) — the seconds-long MuPDF parse
/// happens in `engine_open_finalize` (async threadpool). Split because
/// `Request<'a>` borrows, which async futures cannot hold.
#[tauri::command]
pub fn engine_open_bytes(request: Request, state: State<EngineState>) -> Result<(), String> {
    let headers = request.headers();
    let doc_id = headers
        .get("x-doc-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "engine: missing x-doc-id header".to_string())?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("engine: expected raw binary body (Uint8Array)".to_string());
    };
    state
        .0
        .lock()
        .map_err(|_| "engine: state lock poisoned".to_string())?
        .stash_bytes(DocumentId::new(doc_id), bytes.clone());
    Ok(())
}

/// Finish opening a stashed document (MuPDF parse + owner thread + page
/// count). Async (threadpool): this is the seconds-long step on large PDFs —
/// it must never run on the main thread. Ownership model unchanged: only
/// `Mutex<Documents>` (all `Send`) is touched; the MuPDF `Document` never
/// leaves its owner thread. (`AppHandle` is owned, avoiding borrowed-`State`
/// in async commands; state resolves via `Manager`.)
#[tauri::command]
pub async fn engine_open_finalize(app: AppHandle, doc_id: String) -> Result<u32, String> {
    let count = {
        let state = app.state::<EngineState>();
        let mut docs =
            state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
        docs.finalize_open(&DocumentId::new(doc_id)).map_err(err)?
    };
    Ok(count)
}

#[tauri::command]
pub fn engine_close_document(state: State<EngineState>, doc_id: String) {
    if let Ok(mut docs) = state.0.lock() {
        docs.close(&DocumentId::new(doc_id));
    }
}

/// Bump the navigation generation for a document, invalidating queued work
/// from older navigations. The viewer calls this on page jumps and
/// zoom/rotation commits, BEFORE requesting the new generation's tiles.
/// Cheap + sync (counter increment only). Returns the new generation.
#[tauri::command]
pub fn engine_begin_navigation(state: State<EngineState>, doc_id: String) -> Result<u64, String> {
    let mut docs = state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    let id = DocumentId::new(&doc_id);
    docs.next_generation(&id)
        .ok_or_else(|| EngineError::UnknownDocument(doc_id).to_string())
}

/// Render one tile through the shared priority queue (see
/// `Documents::render_tile_queued`). `priority`: 1 visible … 4 background;
/// `generation`: from `engine_begin_navigation`. Stale-generation callers get
/// `Err("stale…")`, which the viewer treats as a quiet abort (no fallback).
/// The PNG returns as raw IPC bytes. Copy points: (1) pixmap→PNG encode,
/// (2) IPC transport into the webview, (3) browser PNG decode.
/// Async (threadpool): a cold tile costs ~100-200 ms of MuPDF raster + PNG
/// encode; on the main thread every tile would jank the window.
#[tauri::command]
pub async fn engine_render_tile(
    app: AppHandle,
    spec: TileSpec,
    priority: u8,
    generation: u64,
) -> Result<Response, String> {
    let state = app.state::<EngineState>();
    let mut docs =
        state.0.lock().map_err(|_| "engine: state lock poisoned".to_string())?;
    let tile = docs
        .render_tile_queued(&spec.tile.doc, &spec, veditor_engine::Priority(priority), generation)
        .map_err(err)?;
    Ok(Response::new(tile.png))
}
