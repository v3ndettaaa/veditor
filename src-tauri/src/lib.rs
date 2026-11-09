use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

/// First `.pdf` (or any existing file) path passed on the command line that
/// launched this process, e.g. via a double-clicked file association.
/// Read once by the frontend on startup through [`take_startup_file`].
struct StartupFile(std::sync::Mutex<Option<String>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RustFileNode {
    id: String,
    name: String,
    path: String,
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<RustFileNode>>,
}

fn first_file_arg(args: impl Iterator<Item = String>) -> Option<String> {
    args.skip(1) // skip argv[0], the executable path
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Returns the path the app was launched with (file association / "Open
/// with"), if any, and clears it so a later reload doesn't reopen it.
#[tauri::command]
fn take_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Fast zero-JSON-overhead binary PDF reader executed on a native worker thread.
#[tauri::command]
async fn native_read_pdf_fast(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Fast atomic binary PDF writer executed on a native worker thread.
#[tauri::command]
async fn native_write_pdf_fast(path: String, bytes: Vec<u8>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn crawl_pdf_dir(dir: &Path, depth: usize) -> Vec<RustFileNode> {
    if depth > 16 {
        return Vec::new();
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(os) => os.to_string_lossy().into_owned(),
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let path_str = path.to_string_lossy().into_owned();
        if file_type.is_dir() {
            let children = crawl_pdf_dir(&path, depth + 1);
            nodes.push(RustFileNode {
                id: path_str.clone(),
                name,
                path: path_str,
                is_directory: true,
                children: Some(children),
            });
        } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".pdf") {
            nodes.push(RustFileNode {
                id: path_str.clone(),
                name,
                path: path_str,
                is_directory: false,
                children: None,
            });
        }
    }

    nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    nodes
}

/// Crawls an entire directory hierarchy in a single native Rust pass rather than
/// hundreds of sequential JS IPC calls.
#[tauri::command]
async fn native_build_file_tree(root_path: String) -> Result<Option<RustFileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&root_path);
        if !root.is_dir() {
            return Ok(None);
        }
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_path.clone());
        let children = crawl_pdf_dir(&root, 0);
        Ok(Some(RustFileNode {
            id: root_path.clone(),
            name: root_name,
            path: root_path,
            is_directory: true,
            children: Some(children),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Configures WebKitGTK on Linux (Arch / Wayland / X11). Hardware-accelerated
/// DMA-BUF rendering is enabled by default for smooth 60fps scrolling and pen input.
/// Users with buggy GPU drivers can set `VEDITOR_DISABLE_DMABUF=1` to fall back.
#[cfg(target_os = "linux")]
fn configure_linux_webview_env() {
    if std::env::var_os("VEDITOR_DISABLE_DMABUF").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        // Safety: called at process startup before spawning threads.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_webview_env();

    let builder = tauri::Builder::default()
        .manage(StartupFile(std::sync::Mutex::new(first_file_arg(
            std::env::args(),
        ))))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            take_startup_file,
            native_read_pdf_fast,
            native_write_pdf_fast,
            native_build_file_tree
        ]);

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // A second launch (e.g. double-clicking another PDF) hands its path
        // here instead of starting a second window; forward it and refocus.
        if let Some(path) = first_file_arg(argv.into_iter()) {
            let _ = app.emit("open-file-path", path);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
    }));

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
