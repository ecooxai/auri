pub mod core;

use core::{
    capture, clipboard, files, fileserver, ipc, lifecycle, permissions, shell, system, terminal,
    webview, workspace,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(desktop)]
const DEFAULT_WAKE_SHORTCUT: &str = "Alt+Space";

#[cfg(desktop)]
#[derive(Default)]
struct WakeShortcutState(Mutex<Option<String>>);

#[derive(Default)]
struct SystemMonitorState(Mutex<Option<system::NetworkSample>>);

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

#[cfg(target_os = "macos")]
fn queue_opened_files(app: &tauri::AppHandle, urls: Vec<url::Url>) {
    let paths = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return;
    }

    if let Some(state) = app.try_state::<PendingOpenFiles>() {
        match state.0.lock() {
            Ok(mut pending) => pending.extend(paths.iter().cloned()),
            Err(_) => eprintln!("Could not queue files opened from Finder."),
        }
    }
    let _ = app.emit("auri-open-files", &paths);
    let _ = lifecycle::reveal_main_window(app);
}

struct ManagedCloudflaredTunnel {
    info: system::CloudflaredTunnel,
    child: std::process::Child,
}

#[derive(Default)]
struct CloudflaredTunnelState(Mutex<HashMap<u16, ManagedCloudflaredTunnel>>);

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
fn write_text_file(path: String, content: String) -> Result<files::TextFileWrite, String> {
    files::write_text_file(&path, &content)
}

#[tauri::command]
async fn convert_media_file(
    path: String,
    format: String,
    bitrate_kbps: Option<u32>,
    sample_rate: Option<u32>,
    resolution: Option<String>,
) -> Result<files::ConvertedMedia, String> {
    tauri::async_runtime::spawn_blocking(move || {
        files::convert_media_file(
            &path,
            &format,
            bitrate_kbps,
            sample_rate,
            resolution.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Conversion task failed: {error}"))?
}

#[tauri::command]
async fn save_converted_media_file(
    source_path: String,
    temp_path: String,
    name: String,
) -> Result<files::ConvertedMedia, String> {
    tauri::async_runtime::spawn_blocking(move || {
        files::save_converted_media_file(&source_path, &temp_path, &name)
    })
    .await
    .map_err(|error| format!("Save converted media task failed: {error}"))?
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
fn terminal_busy(session_id: String) -> Result<bool, String> {
    terminal::busy(&session_id)
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
fn media_permission_status() -> permissions::MediaPermissions {
    permissions::status()
}

#[tauri::command]
async fn request_media_permission(
    permission: String,
) -> Result<permissions::MediaPermissions, String> {
    tauri::async_runtime::spawn_blocking(move || permissions::request(&permission))
        .await
        .map_err(|error| format!("Permission request task failed: {error}"))?
}

#[tauri::command]
async fn read_clipboard_history() -> Result<Vec<clipboard::ClipboardEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| clipboard::read_history())
        .await
        .map_err(|error| format!("Clipboard history task failed: {error}"))?
}

#[tauri::command]
async fn set_clipboard_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clipboard::set_text(&text))
        .await
        .map_err(|error| format!("Clipboard write task failed: {error}"))?
}

#[tauri::command]
async fn paste_clipboard_entry(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        clipboard::prepare_paste(&id)?;
        clipboard::focus_previous_and_paste()
    })
    .await
    .map_err(|error| format!("Clipboard paste task failed: {error}"))?
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
fn update_clipboard_entry(
    id: String,
    text: String,
) -> Result<Vec<clipboard::ClipboardEntry>, String> {
    clipboard::update_entry_text(&id, &text)
}

#[tauri::command]
fn copy_clipboard_entry(id: String) -> Result<(), String> {
    clipboard::prepare_paste(&id)
}

#[tauri::command]
fn fileserver_start() -> Result<fileserver::ServerInfo, String> {
    fileserver::start()
}

#[tauri::command]
fn take_pending_open_files(
    state: tauri::State<'_, PendingOpenFiles>,
) -> Result<Vec<String>, String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Finder open-file queue is unavailable.".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
async fn system_snapshot(
    state: tauri::State<'_, SystemMonitorState>,
    include_gpus: Option<bool>,
) -> Result<system::SystemSnapshot, String> {
    let previous = state
        .0
        .lock()
        .map_err(|_| "System monitor state is unavailable.".to_string())?
        .clone();
    let (snapshot, sample) = tauri::async_runtime::spawn_blocking(move || {
        system::snapshot(previous, include_gpus.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("System monitor task failed: {error}"))??;
    *state
        .0
        .lock()
        .map_err(|_| "System monitor state is unavailable.".to_string())? = Some(sample);
    Ok(snapshot)
}

#[tauri::command]
fn search_path_commands(query: String) -> Vec<system::PathCommandInfo> {
    system::search_path_commands(&query, 30)
}

#[tauri::command]
fn read_shell_history() -> Result<Vec<String>, String> {
    workspace::read_shell_history()
}

#[tauri::command]
async fn kill_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::kill_process(pid))
        .await
        .map_err(|error| format!("Process kill task failed: {error}"))?
}

#[tauri::command]
async fn set_process_priority(pid: u32, nice: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_process_priority(pid, nice))
        .await
        .map_err(|error| format!("Process priority task failed: {error}"))?
}

#[tauri::command]
async fn set_process_priority_privileged(
    pid: u32,
    nice: i32,
    password: String,
    method: String,
) -> Result<system::ProcessPriorityAuthorization, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system::set_process_priority_privileged(pid, nice, password, &method)
    })
    .await
    .map_err(|error| format!("Process priority authorization task failed: {error}"))?
}

#[tauri::command]
async fn cloudflared_status() -> Result<system::CloudflaredStatus, String> {
    tauri::async_runtime::spawn_blocking(system::cloudflared_status)
        .await
        .map_err(|error| format!("cloudflared status task failed: {error}"))
}

#[tauri::command]
async fn cloudflared_start_tunnel(
    state: tauri::State<'_, CloudflaredTunnelState>,
    port: u16,
    install_if_missing: bool,
) -> Result<system::CloudflaredTunnel, String> {
    if port == 0 {
        return Err("Choose a valid local port.".to_string());
    }
    if let Some(existing) = state
        .0
        .lock()
        .map_err(|_| "Cloudflare tunnel state is unavailable.".to_string())?
        .get(&port)
    {
        return Ok(existing.info.clone());
    }

    let process = tauri::async_runtime::spawn_blocking(move || {
        system::start_cloudflared_tunnel(port, install_if_missing)
    })
    .await
    .map_err(|error| format!("cloudflared tunnel task failed: {error}"))??;
    let info = process.info.clone();
    state
        .0
        .lock()
        .map_err(|_| "Cloudflare tunnel state is unavailable.".to_string())?
        .insert(
            port,
            ManagedCloudflaredTunnel {
                info: process.info,
                child: process.child,
            },
        );
    Ok(info)
}

#[tauri::command]
async fn cloudflared_active_tunnels(
    state: tauri::State<'_, CloudflaredTunnelState>,
) -> Result<Vec<system::CloudflaredTunnel>, String> {
    let tunnels = state
        .0
        .lock()
        .map_err(|_| "Cloudflare tunnel state is unavailable.".to_string())?;
    let mut active: Vec<system::CloudflaredTunnel> =
        tunnels.values().map(|t| t.info.clone()).collect();

    let discovered = system::discover_active_tunnels();
    for disc in discovered {
        if !active.iter().any(|t| t.port == disc.port) {
            active.push(disc);
        }
    }
    Ok(active)
}

#[tauri::command]
async fn cloudflared_stop_tunnel(
    state: tauri::State<'_, CloudflaredTunnelState>,
    port: u16,
) -> Result<system::CloudflaredTunnel, String> {
    let managed = state
        .0
        .lock()
        .map_err(|_| "Cloudflare tunnel state is unavailable.".to_string())?
        .remove(&port);

    // The tunnel for this port may not be in our in-memory map even though
    // it's running: it can be a tunnel that was started in an earlier Auri
    // session (cloudflared survives if Auri quits without explicitly
    // stopping it, by design, so it keeps serving in the background), or
    // one discovered on disk/in the process list rather than spawned by
    // this app instance. Fall back to discovery + a plain kill-by-pid so
    // "stop tunnel" still works for those.
    let info = match managed {
        Some(mut tunnel) => {
            let info = tunnel.info.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = tunnel.child.kill();
                tunnel
                    .child
                    .wait()
                    .map_err(|error| format!("Could not wait for cloudflared to stop: {error}"))?;
                Ok::<(), String>(())
            })
            .await
            .map_err(|error| format!("cloudflared stop task failed: {error}"))??;
            info
        }
        None => {
            let discovered = system::discover_active_tunnels();
            let found = discovered
                .into_iter()
                .find(|tunnel| tunnel.port == port)
                .ok_or_else(|| format!("No Cloudflare tunnel is running for port {port}."))?;
            let pid = found.pid;
            tauri::async_runtime::spawn_blocking(move || system::kill_process(pid))
                .await
                .map_err(|error| format!("cloudflared stop task failed: {error}"))??;
            found
        }
    };
    Ok(info)
}

#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    workspace::save_configuration(&settings)
}

#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(desktop)]
#[tauri::command]
fn set_wake_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, WakeShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Err("Wake shortcut cannot be empty.".into());
    }

    let mut current = state
        .0
        .lock()
        .map_err(|_| "Wake shortcut state is unavailable.".to_string())?;
    if current
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(shortcut))
    {
        return Ok(());
    }

    let manager = app.global_shortcut();
    manager
        .register(shortcut)
        .map_err(|error| format!("Could not register wake shortcut {shortcut}: {error}"))?;

    if let Some(previous) = current.as_deref() {
        if let Err(error) = manager.unregister(previous) {
            let _ = manager.unregister(shortcut);
            return Err(format!(
                "Could not replace the previous wake shortcut {previous}: {error}"
            ));
        }
    }

    *current = Some(shortcut.to_string());
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_wake_shortcut(_shortcut: String) -> Result<(), String> {
    Err("Global wake shortcuts are available only in the desktop build.".into())
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

#[cfg(desktop)]
#[tauri::command]
fn window_set_visible_on_all_workspaces(
    window: tauri::Window,
    state: tauri::State<'_, lifecycle::DesktopVisibilityState>,
    enabled: bool,
) -> Result<(), String> {
    lifecycle::set_visible_on_all_workspaces(&window, &state, enabled)
}

#[cfg(not(desktop))]
#[tauri::command]
fn window_set_visible_on_all_workspaces(_enabled: bool) -> Result<(), String> {
    Err("Desktop workspace visibility is available only in the desktop build.".into())
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
    ai_prompts: Option<String>,
) -> Result<(), String> {
    webview::show(
        &app,
        &id,
        &url,
        navigate,
        x,
        y,
        width,
        height,
        ai_prompts.as_deref(),
    )
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

#[tauri::command]
fn tab_window_show(
    app: tauri::AppHandle,
    id: String,
    url: String,
    title: String,
) -> Result<(), String> {
    webview::show_standalone(&app, &id, &url, &title)
}

#[tauri::command]
fn tab_window_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
    webview::reload_standalone(&app, &id)
}

#[tauri::command]
fn tab_window_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    webview::close_standalone(&app, &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        let existing = std::env::var("GST_PLUGIN_FEATURE_RANK").ok();
        std::env::set_var(
            "GST_PLUGIN_FEATURE_RANK",
            core::util::webkit_gstreamer_feature_rank(existing.as_deref()),
        );
        // WebKitGTK 2.52 can crash in Mesa's Skia GPU worker while a related
        // OAuth view is created. Keep browser rendering on the stable software
        // path; per-view settings below enforce the same policy after creation.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }
    let app = tauri::Builder::default()
        .setup(|app| {
            fileserver::start().map_err(std::io::Error::other)?;
            let command_server =
                ipc::start_command_server(app.handle().clone()).map_err(std::io::Error::other)?;
            app.manage(command_server);
            app.manage(SystemMonitorState::default());
            app.manage(PendingOpenFiles::default());
            app.manage(CloudflaredTunnelState::default());
            app.manage(lifecycle::DesktopVisibilityState::new(true));
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| std::io::Error::other("The main window config is missing."))?
                .clone();
            let main_window =
                tauri::window::WindowBuilder::from_config(app, &main_config)?.build()?;
            // Keep Auri's application shell on its normal WebKit context. Only
            // website/standalone views use the persistent browser profile; a
            // browser data directory on the app shell can prevent the bundled
            // UI from loading after a native development restart.
            let main_webview = tauri::webview::WebviewBuilder::from_config(&main_config);
            let main_webview = main_window.add_child(
                main_webview,
                tauri::LogicalPosition::new(0, 0),
                main_window.inner_size()?,
            )?;
            webview::install_linux_webview_layer(&main_webview)
                .map_err(std::io::Error::other)?;

            #[cfg(desktop)]
            {
                app.manage(WakeShortcutState::default());
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
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

                if let Err(error) = app.global_shortcut().register(DEFAULT_WAKE_SHORTCUT) {
                    eprintln!(
                        "{DEFAULT_WAKE_SHORTCUT} is already owned by another application or Auri instance: {error}"
                    );
                } else if let Ok(mut current) = app.state::<WakeShortcutState>().0.lock() {
                    *current = Some(DEFAULT_WAKE_SHORTCUT.to_string());
                }
            }

            if let Some(window) = app.get_window("main") {
                lifecycle::apply_self_managed_chrome(&window).map_err(std::io::Error::other)?;
                let state = app.state::<lifecycle::DesktopVisibilityState>();
                lifecycle::set_visible_on_all_workspaces(&window, &state, true)
                    .map_err(std::io::Error::other)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                if let Some(id) = window.label().strip_prefix("auri-tab-window-") {
                    let _ = window.app_handle().emit("auri-tab-window-return", serde_json::json!({ "id": id }));
                }
                if lifecycle::should_exit_on_close(window.label()) {
                    window.app_handle().exit(0);
                }
            }
            // The main webview is added as a child sized once at startup, so it
            // must be re-fitted whenever the window resizes or changes DPI;
            // otherwise the UI stops matching the window (e.g. after enlarging).
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == webview::MAIN_LABEL {
                    if let Err(error) = webview::fit_main_webview(window) {
                        eprintln!("Could not resize the main webview: {error}");
                    }
                }
            }
            _ => {}
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
            write_text_file,
            convert_media_file,
            save_converted_media_file,
            run_command,
            terminal_start,
            terminal_write,
            terminal_cwd,
            terminal_busy,
            terminal_resize,
            terminal_stop,
            window_start_dragging,
            window_set_visible_on_all_workspaces,
            capture_screenshot,
            media_permission_status,
                request_media_permission,
                read_clipboard_history,
                set_clipboard_text,
                paste_clipboard_entry,
            set_clipboard_pinned,
            remove_clipboard_entry,
            update_clipboard_entry,
            copy_clipboard_entry,
            fileserver_start,
            take_pending_open_files,
            read_shell_history,
            system_snapshot,
            search_path_commands,
            kill_process,
            set_process_priority,
            set_process_priority_privileged,
            cloudflared_status,
            cloudflared_start_tunnel,
            cloudflared_active_tunnels,
            cloudflared_stop_tunnel,
            save_settings,
            app_exit,
            set_wake_shortcut,
            save_media_file,
            open_external,
            open_external_url,
            webview_show,
            webview_hide_all,
            webview_overlay_show,
            webview_overlay_hide,
            webview_overlay_update_zoom,
            webview_action,
            webview_close,
            tab_window_show,
            tab_window_reload,
            tab_window_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building Auri");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            queue_opened_files(app_handle, urls);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}
