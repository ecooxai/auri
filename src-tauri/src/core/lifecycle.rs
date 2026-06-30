#[cfg(not(test))]
use tauri::Manager;

/// Reveal the main Auri window from a background/global-shortcut callback.
///
/// The workspace flag is applied every time so a window created or restored by
/// the OS remains reachable from the currently active virtual desktop.
#[cfg(not(test))]
#[allow(dead_code)]
pub fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main Auri window is not available.".to_string())?;

    window
        .set_visible_on_all_workspaces(true)
        .map_err(|error| format!("Could not show Auri on every workspace: {error}"))?;

    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("Could not restore the Auri window: {error}"))?;
    }

    window
        .show()
        .map_err(|error| format!("Could not show the Auri window: {error}"))?;
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
