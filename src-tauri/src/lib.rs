pub mod core;

use core::{capture, clipboard, files, ipc, lifecycle, shell, terminal, webview, workspace};
use serde_json::Value;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

#[tauri::command]
fn initialize_workspace() -> Result<workspace::InitResult, String> {
    workspace::initialize()
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<files::FileEntry>, String> {
    files::list_directory(&path)
}

#[tauri::command]
fn inspect_file(path: String) -> Result<files::FileInfo, String> {
    files::inspect_file(&path)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    files::read_text_file(&path)
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<files::BinaryFile, String> {
    files::read_binary_file(&path)
}

#[tauri::command]
async fn run_command(command: String, cwd: String) -> Result<shell::CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || shell::run(&command, &cwd))
        .await
        .map_err(|error| format!("Command task failed: {error}"))?
}

#[tauri::command]
fn terminal_start(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::start(app, session_id, cwd, cols, rows)
}

#[tauri::command]
fn terminal_write(session_id: String, data: Vec<u8>) -> Result<(), String> {
    terminal::write(&session_id, &data)
}

#[tauri::command]
fn terminal_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize(&session_id, cols, rows)
}

#[tauri::command]
fn terminal_stop(session_id: String) -> Result<(), String> {
    terminal::stop(&session_id)
}

#[tauri::command]
fn capture_screenshot() -> Result<files::BinaryFile, String> {
    capture::screenshot()
}

#[tauri::command]
fn read_clipboard_history() -> Result<Vec<clipboard::ClipboardEntry>, String> {
    clipboard::read_history()
}

#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    workspace::save_configuration(&settings)
}

#[tauri::command]
fn save_media_file(
    name: String,
    kind: String,
    base64: String,
) -> Result<files::SavedMedia, String> {
    files::save_media_file(&name, &kind, &base64)
}

#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    files::open_external(&path)
}

#[tauri::command]
fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn webview_show(app: tauri::AppHandle, id: String, url: String, navigate: bool, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    webview::show(&app, &id, &url, navigate, x, y, width, height)
}

#[tauri::command]
fn webview_hide_all(app: tauri::AppHandle) -> Result<(), String> {
    webview::hide_all(&app)
}

#[tauri::command]
fn webview_action(app: tauri::AppHandle, id: String, action: String) -> Result<(), String> {
    webview::action(&app, &id, &action)
}

#[tauri::command]
fn webview_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    webview::close(&app, &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["alt+space"])?
                    .with_handler(|app, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && shortcut.matches(Modifiers::ALT, Code::Space)
                        {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let screenshot = capture::screenshot().ok();
                                let _ = app.emit("auri-wake", &screenshot);
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                let _ = lifecycle::reveal_main_window(&app);
                            });
                        }
                    })
                    .build(),
            )?;

            if let Some(window) = app.get_webview_window("main") {
                window.set_visible_on_all_workspaces(true)?;
            }

            ipc::start_command_server(app.handle().clone()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && lifecycle::should_exit_on_close(window.label())
            {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            initialize_workspace,
            list_directory,
            inspect_file,
            read_text_file,
            read_binary_file,
            run_command,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            window_start_dragging,
            capture_screenshot,
            read_clipboard_history,
            save_settings,
            save_media_file,
            open_external,
            webview_show,
            webview_hide_all,
            webview_action,
            webview_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auri");
}
