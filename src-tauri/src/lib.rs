pub mod core;

use core::{capture, clipboard, files, ipc, lifecycle, shell, terminal, webview, workspace};
use serde_json::Value;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

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
fn create_file(directory: String, name: String) -> Result<files::CreatedItem, String> {
    files::create_file(&directory, &name)
}

#[tauri::command]
fn create_folder(directory: String, name: String) -> Result<files::CreatedItem, String> {
    files::create_folder(&directory, &name)
}

#[tauri::command]
async fn folder_info(path: String) -> Result<files::FolderInfo, String> {
    tauri::async_runtime::spawn_blocking(move || files::folder_info(&path))
        .await
        .map_err(|error| format!("Folder info task failed: {error}"))?
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
fn terminal_cwd(session_id: String) -> Result<String, String> {
    terminal::cwd(&session_id)
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
fn paste_clipboard_entry(id: String) -> Result<(), String> {
    clipboard::prepare_paste(&id)?;
    std::thread::spawn(|| {
        let _ = clipboard::focus_previous_and_paste();
    });
    Ok(())
}

#[tauri::command]
fn set_clipboard_pinned(
    id: String,
    pinned: bool,
) -> Result<Vec<clipboard::ClipboardEntry>, String> {
    clipboard::set_pinned(&id, pinned)
}

#[tauri::command]
fn remove_clipboard_entry(id: String) -> Result<Vec<clipboard::ClipboardEntry>, String> {
    clipboard::remove_entry(&id)
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
fn open_external_url(url: String) -> Result<(), String> {
    files::open_external_url(&url)
}

#[tauri::command]
fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn webview_show(
    app: tauri::AppHandle,
    id: String,
    url: String,
    navigate: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    webview::show(&app, &id, &url, navigate, x, y, width, height)
}

#[tauri::command]
fn webview_hide_all(app: tauri::AppHandle) -> Result<(), String> {
    webview::hide_all(&app)
}

#[tauri::command]
fn webview_overlay_show(
    app: tauri::AppHandle,
    payload: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    webview::show_overlay(&app, &payload, x, y, width, height)
}

#[tauri::command]
fn webview_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    webview::hide_overlay(&app)
}

#[tauri::command]
fn webview_overlay_update_zoom(app: tauri::AppHandle, value: String) -> Result<(), String> {
    webview::update_overlay_zoom(&app, &value)
}

#[tauri::command]
fn webview_action(
    app: tauri::AppHandle,
    id: String,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    webview::action(&app, &id, &action, value)
}

#[tauri::command]
fn webview_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    webview::close(&app, &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let command_server =
                ipc::start_command_server(app.handle().clone()).map_err(std::io::Error::other)?;
            app.manage(command_server);

            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
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

                if let Err(error) = app.global_shortcut().register("alt+space") {
                    eprintln!(
                        "Alt+Space is already owned by another application or Auri instance: {error}"
                    );
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                window.set_visible_on_all_workspaces(true)?;
            }

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
            create_file,
            create_folder,
            folder_info,
            read_text_file,
            read_binary_file,
            run_command,
            terminal_start,
            terminal_write,
            terminal_cwd,
            terminal_resize,
            terminal_stop,
            window_start_dragging,
            capture_screenshot,
            read_clipboard_history,
            paste_clipboard_entry,
            set_clipboard_pinned,
            remove_clipboard_entry,
            save_settings,
            save_media_file,
            open_external,
            open_external_url,
            webview_show,
            webview_hide_all,
            webview_overlay_show,
            webview_overlay_hide,
            webview_overlay_update_zoom,
            webview_action,
            webview_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auri");
}
