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

/// Configures WebKitGTK on Linux (Arch / Ubuntu / Wayland / X11) for desktop & AppImage builds.
/// - Disables WebKitGTK's broken DMABUF renderer by default (`WEBKIT_DISABLE_DMABUF_RENDERER=1`),
///   which otherwise causes WebKitWebProcess crashes, protocol errors, and extreme canvas lag on
///   Arch Linux (Wayland/Hyprland/KDE/GNOME, Mesa & NVIDIA).
/// - Disables WebKit's bubblewrap sandbox (`WEBKIT_FORCE_SANDBOX=0`) inside FUSE AppImage mounts.
/// - In AppImage mode on Wayland with XWayland available, prefers `GDK_BACKEND=x11,wayland` to
///   avoid GTK3 Wayland protocol crashes (`Error 71`) across rolling-release compositors.
/// - Preloads the host's newer `libstdc++.so.6` for `WebKitWebProcess` when running inside an
///   AppImage on rolling-release distros (Arch Linux) so host Mesa DRI drivers load with full
///   hardware acceleration instead of falling back to slow CPU software rendering.
#[cfg(target_os = "linux")]
fn configure_linux_webview_env() {
    // Safety: called at process startup before spawning threads or child processes.
    unsafe {
        if std::env::var_os("WEBKIT_FORCE_SANDBOX").is_none() {
            std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        let is_appimage =
            std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
        if is_appimage {
            if std::env::var_os("GDK_BACKEND").is_none()
                && std::env::var_os("WAYLAND_DISPLAY").is_some()
                && std::env::var_os("DISPLAY").is_some()
            {
                std::env::set_var("GDK_BACKEND", "x11,wayland");
            }

            let host_stdcpp = Path::new("/usr/lib/libstdc++.so.6");
            if host_stdcpp.is_file() && std::env::var_os("LD_PRELOAD").is_none() {
                std::env::set_var("LD_PRELOAD", "/usr/lib/libstdc++.so.6");
            }
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
