use tauri::{Emitter, Manager};

mod engine_cmds;

/// First `.pdf` (or any existing file) path passed on the command line that
/// launched this process, e.g. via a double-clicked file association.
/// Read once by the frontend on startup through [`take_startup_file`].
struct StartupFile(std::sync::Mutex<Option<String>>);

fn first_file_arg(args: impl Iterator<Item = String>) -> Option<String> {
    args.skip(1) // skip argv[0], the executable path
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
}

/// Returns the path the app was launched with (file association / "Open
/// with"), if any, and clears it so a later reload doesn't reopen it.
#[tauri::command]
fn take_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Day-1 engine smoke signal. Proves the `veditor-engine` facade is wired
/// behind the Tauri boundary (the only layer the TS frontend may call).
/// No TS call sites Day-1; real document/tile commands arrive Day-2+.
#[tauri::command]
fn engine_status() -> String {
    veditor_engine::Engine::new_stub().status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(StartupFile(std::sync::Mutex::new(first_file_arg(
            std::env::args(),
        ))))
        .manage(engine_cmds::EngineState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            take_startup_file,
            engine_status,
            engine_cmds::engine_open_document,
            engine_cmds::engine_close_document,
            engine_cmds::engine_page_count,
            engine_cmds::engine_page_size,
            engine_cmds::engine_render_tile,
            engine_cmds::engine_metrics
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
