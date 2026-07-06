#[cfg(all(not(test), target_os = "linux"))]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(not(test))]
use tauri::Manager;

pub struct DesktopVisibilityState(std::sync::Mutex<bool>);

impl DesktopVisibilityState {
    pub fn new(visible_on_all_workspaces: bool) -> Self {
        Self(std::sync::Mutex::new(visible_on_all_workspaces))
    }
}

#[cfg(not(test))]
fn platform_supports_visible_on_all_workspaces(enabled: bool) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("DISPLAY").is_none() {
            return Err(
                "Showing Auri on every desktop is supported on Linux X11; DISPLAY is not set."
                    .to_string(),
            );
        }
    }
    #[cfg(target_os = "windows")]
    {
        return Err("Showing Auri on every desktop is not supported on Windows.".to_string());
    }
    Ok(())
}

#[cfg(not(test))]
pub fn set_visible_on_all_workspaces(
    window: &tauri::Window,
    state: &DesktopVisibilityState,
    enabled: bool,
) -> Result<(), String> {
    platform_supports_visible_on_all_workspaces(enabled)?;
    window
        .set_visible_on_all_workspaces(enabled)
        .map_err(|error| format!("Could not update Auri desktop visibility: {error}"))?;
    #[cfg(target_os = "linux")]
    apply_x11_desktop_visibility_hint(window, enabled)?;
    *state
        .0
        .lock()
        .map_err(|_| "Desktop visibility state is unavailable.".to_string())? = enabled;
    Ok(())
}

#[cfg(all(not(test), target_os = "linux"))]
fn x11_window_id(window: &tauri::Window) -> Result<Option<u64>, String> {
    if std::env::var_os("DISPLAY").is_none() {
        return Ok(None);
    }

    let handle = window
        .window_handle()
        .map_err(|error| format!("Could not read the X11 window handle: {error}"))?;
    Ok(match handle.as_raw() {
        RawWindowHandle::Xlib(handle) if handle.window != 0 => Some(handle.window),
        RawWindowHandle::Xcb(handle) => Some(handle.window.get() as u64),
        _ => None,
    })
}

#[cfg(all(not(test), target_os = "linux"))]
fn run_xprop(window_id: u64, args: &[&str]) -> Result<(), String> {
    let mut command = std::process::Command::new("xprop");
    command
        .args(["-id", &format!("0x{window_id:x}")])
        .args(args);
    let status = command
        .status()
        .map_err(|error| format!("Could not apply X11 window hint with xprop: {error}"))?;
    if !status.success() {
        return Err("Could not apply X11 window hint with xprop.".to_string());
    }
    Ok(())
}

#[cfg(all(not(test), target_os = "linux"))]
fn current_x11_desktop() -> String {
    let Ok(output) = std::process::Command::new("xprop")
        .args(["-root", "_NET_CURRENT_DESKTOP"])
        .output()
    else {
        return "0".to_string();
    };
    if !output.status.success() {
        return "0".to_string();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.rsplit_once('=')
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "0".to_string())
}

#[cfg(all(not(test), target_os = "linux"))]
fn apply_x11_desktop_visibility_hint(window: &tauri::Window, enabled: bool) -> Result<(), String> {
    let Some(window_id) = x11_window_id(window)? else {
        return Ok(());
    };
    let desktop = if enabled {
        "0xFFFFFFFF".to_string()
    } else {
        current_x11_desktop()
    };
    run_xprop(
        window_id,
        &[
            "-f",
            "_NET_WM_DESKTOP",
            "32c",
            "-set",
            "_NET_WM_DESKTOP",
            desktop.as_str(),
        ],
    )
}

#[cfg(all(not(test), target_os = "linux"))]
fn raise_x11_window(window: &tauri::Window) -> Result<(), String> {
    fn try_xdotool(args: &[&str]) -> Result<bool, String> {
        match std::process::Command::new("xdotool").args(args).status() {
            Ok(status) => Ok(status.success()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("Could not raise the Auri X11 window: {error}")),
        }
    }

    if let Some(window_id) = x11_window_id(window)? {
        let _ = try_xdotool(&["windowraise", &format!("0x{window_id:x}")])?;
    };

    let pid = std::process::id().to_string();
    let _ = try_xdotool(&[
        "search",
        "--pid",
        pid.as_str(),
        "--name",
        "Auri",
        "windowraise",
        "windowactivate",
    ])?;
    Ok(())
}

#[cfg(all(not(test), target_os = "linux"))]
pub fn apply_self_managed_chrome(window: &tauri::Window) -> Result<(), String> {
    window
        .set_decorations(false)
        .map_err(|error| format!("Could not disable system window decorations: {error}"))?;

    let Some(window_id) = x11_window_id(window)? else {
        return Ok(());
    };

    run_xprop(
        window_id,
        &[
            "-f",
            "_MOTIF_WM_HINTS",
            "32c",
            "-set",
            "_MOTIF_WM_HINTS",
            "0x2, 0x0, 0x0, 0x0, 0x0",
        ],
    )
}

#[cfg(all(not(test), not(target_os = "linux")))]
pub fn apply_self_managed_chrome(window: &tauri::Window) -> Result<(), String> {
    window
        .set_decorations(false)
        .map_err(|error| format!("Could not disable system window decorations: {error}"))
}

#[cfg(not(test))]
fn current_visible_on_all_workspaces(app: &tauri::AppHandle) -> bool {
    app.try_state::<DesktopVisibilityState>()
        .and_then(|state| state.0.lock().ok().map(|value| *value))
        .unwrap_or(true)
}

/// Reveal the main Auri window from a background/global-shortcut callback.
/// The workspace flag is reapplied using the current saved preference.
#[cfg(not(test))]
#[allow(dead_code)]
pub fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main Auri window is not available.".to_string())?;

    let visible_on_all_workspaces = current_visible_on_all_workspaces(app);
    window
        .set_visible_on_all_workspaces(visible_on_all_workspaces)
        .map_err(|error| format!("Could not show Auri on every workspace: {error}"))?;

    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("Could not restore the Auri window: {error}"))?;
    }

    window
        .show()
        .map_err(|error| format!("Could not show the Auri window: {error}"))?;
    #[cfg(target_os = "linux")]
    raise_x11_window(&window)?;
    window
        .set_focus()
        .map_err(|error| format!("Could not focus the Auri window: {error}"))?;
    Ok(())
}

#[cfg(test)]
pub fn reveal_main_window<T>(_app: &T) -> Result<(), String> {
    Ok(())
}

/// Returns whether closing a window should terminate the desktop process.
///
/// Auri currently has one primary window. On macOS, allowing that window to
/// close without exiting leaves a background process with no UI, which looks
/// like a crash and prevents a normal relaunch.
pub fn should_exit_on_close(window_label: &str) -> bool {
    window_label == "main"
}
