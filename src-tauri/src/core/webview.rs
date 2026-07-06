use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewBuilder, WebviewUrl,
};

const PREFIX: &str = "auri-web-";
const OVERLAY_LABEL: &str = "auri-browser-overlay";

#[cfg(target_os = "linux")]
static X11_WEBVIEW_WINDOWS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::OnceLock::new();

#[derive(Clone, Serialize)]
struct WebNavigation {
    id: String,
    url: String,
}

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| format!("Invalid web URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS URLs are supported.".to_string());
    }
    Ok(parsed)
}

fn label_for(id: &str) -> String {
    format!("{PREFIX}{id}")
}

#[cfg(target_os = "linux")]
fn raise_x11_child_window(
    window: &tauri::Window,
    label: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    previous_root_children: Option<Vec<u64>>,
) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::collections::HashSet;
    use std::ptr;
    use x11_dl::xlib::{Window as XWindow, XWindowAttributes, Xlib};

    let parent = match window
        .window_handle()
        .map_err(|error| format!("Could not read the X11 window handle: {error}"))?
        .as_raw()
    {
        RawWindowHandle::Xlib(handle) if handle.window != 0 => handle.window,
        RawWindowHandle::Xcb(handle) => handle.window.get() as u64,
        _ => return Ok(()),
    };
    let xlib = Xlib::open().map_err(|error| format!("Could not open Xlib: {error}"))?;
    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return Ok(());
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let target_x = (x.max(0.0) * scale).round() as i32;
    let target_y = (y.max(0.0) * scale).round() as i32;
    let target_width = (width.max(1.0) * scale).round() as i32;
    let target_height = (height.max(1.0) * scale).round() as i32;
    let root_window = unsafe { (xlib.XDefaultRootWindow)(display) };
    let tracked_child = X11_WEBVIEW_WINDOWS
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|windows| windows.get(label).copied());
    let child = if let Some(child) = tracked_child {
        Some(child)
    } else {
        let before: HashSet<u64> = previous_root_children
            .unwrap_or_default()
            .into_iter()
            .collect();
        let after = query_x11_root_children(display, &xlib, root_window);
        after
            .into_iter()
            .filter(|child| !before.contains(child))
            .filter(|child| {
                let mut attrs = unsafe { std::mem::zeroed::<XWindowAttributes>() };
                let ok = unsafe { (xlib.XGetWindowAttributes)(display, *child, &mut attrs) };
                ok != 0 && attrs.width > 0 && attrs.height > 0
            })
            .last()
            .inspect(|child| {
                if let Ok(mut windows) = X11_WEBVIEW_WINDOWS.get_or_init(Default::default).lock() {
                    windows.insert(label.to_string(), *child);
                }
            })
    };
    if let Some(child) = child {
        let mut origin_x = 0;
        let mut origin_y = 0;
        let mut translated_child: XWindow = 0;
        let translated = unsafe {
            (xlib.XTranslateCoordinates)(
                display,
                parent,
                root_window,
                0,
                0,
                &mut origin_x,
                &mut origin_y,
                &mut translated_child,
            )
        };
        if translated != 0 {
            unsafe {
                (xlib.XMoveResizeWindow)(
                    display,
                    child,
                    origin_x + target_x,
                    origin_y + target_y,
                    target_width as u32,
                    target_height as u32,
                );
                (xlib.XRaiseWindow)(display, child);
                (xlib.XFlush)(display);
            }
        }
    }
    unsafe { (xlib.XCloseDisplay)(display) };
    Ok(())
}

#[cfg(target_os = "linux")]
fn query_x11_root_children(
    display: *mut x11_dl::xlib::_XDisplay,
    xlib: &x11_dl::xlib::Xlib,
    root_window: x11_dl::xlib::Window,
) -> Vec<u64> {
    let mut root: x11_dl::xlib::Window = 0;
    let mut parent_return: x11_dl::xlib::Window = 0;
    let mut children: *mut x11_dl::xlib::Window = std::ptr::null_mut();
    let mut child_count: u32 = 0;
    let queried = unsafe {
        (xlib.XQueryTree)(
            display,
            root_window,
            &mut root,
            &mut parent_return,
            &mut children,
            &mut child_count,
        )
    };
    if queried == 0 || children.is_null() {
        return Vec::new();
    }
    let result = unsafe { std::slice::from_raw_parts(children, child_count as usize) }.to_vec();
    unsafe { (xlib.XFree)(children.cast()) };
    result
}

#[cfg(target_os = "linux")]
fn capture_x11_root_children() -> Vec<u64> {
    use std::ptr;
    let Ok(xlib) = x11_dl::xlib::Xlib::open() else {
        return Vec::new();
    };
    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return Vec::new();
    }
    let root_window = unsafe { (xlib.XDefaultRootWindow)(display) };
    let children = query_x11_root_children(display, &xlib, root_window);
    unsafe { (xlib.XCloseDisplay)(display) };
    children
}

#[cfg(not(target_os = "linux"))]
fn capture_x11_root_children() -> Vec<u64> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
fn raise_x11_child_window(
    _window: &tauri::Window,
    _label: &str,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _previous_root_children: Option<Vec<u64>>,
) -> Result<(), String> {
    Ok(())
}

pub fn show(
    app: &AppHandle,
    id: &str,
    url: &str,
    navigate: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = label_for(id);
    let parsed = parse_url(url)?;
    for (existing_label, webview) in app.webviews() {
        if existing_label.starts_with(PREFIX) && existing_label != label {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    if let Some(webview) = app.get_webview(&label) {
        if navigate {
            webview
                .navigate(parsed)
                .map_err(|error| error.to_string())?;
        }
        webview
            .set_bounds(Rect {
                position: position.into(),
                size: size.into(),
            })
            .map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        raise_x11_child_window(&window, &label, x, y, width, height, None)?;
        return Ok(());
    }
    let previous_root_children = capture_x11_root_children();
    let event_app = app.clone();
    let event_id = id.to_string();
    let builder =
        WebviewBuilder::new(&label, WebviewUrl::External(parsed)).on_navigation(move |target| {
            let _ = event_app.emit(
                "auri-web-navigation",
                WebNavigation {
                    id: event_id.clone(),
                    url: target.to_string(),
                },
            );
            true
        });
    let webview = window
        .add_child(builder, position, size)
        .map_err(|error| format!("Could not create webview: {error}"))?;
    webview
        .set_bounds(Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|error| error.to_string())?;
    webview.show().map_err(|error| error.to_string())?;
    raise_x11_child_window(
        &window,
        &label,
        x,
        y,
        width,
        height,
        Some(previous_root_children),
    )?;
    Ok(())
}

pub fn show_overlay(
    app: &AppHandle,
    payload: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid browser overlay data: {error}"))?;
    let serialized = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    if let Some(existing) = app.get_webview(OVERLAY_LABEL) {
        existing.close().map_err(|error| error.to_string())?;
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    let initialization = format!("window.__AURI_BROWSER_OVERLAY__ = {serialized};");
    let builder = WebviewBuilder::new(
        OVERLAY_LABEL,
        WebviewUrl::App("browser-overlay.html".into()),
    )
    .initialization_script(initialization)
    .transparent(true)
    .focused(true);
    window
        .add_child(
            builder,
            LogicalPosition::new(x.max(0.0), y.max(0.0)),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|error| format!("Could not create browser overlay: {error}"))?;
    Ok(())
}

pub fn hide_overlay(app: &AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(OVERLAY_LABEL) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn update_overlay_zoom(app: &AppHandle, value: &str) -> Result<(), String> {
    let webview = app
        .get_webview(OVERLAY_LABEL)
        .ok_or_else(|| "The browser overlay is not open.".to_string())?;
    let serialized = serde_json::to_string(value).map_err(|error| error.to_string())?;
    webview
        .eval(format!("window.__AURI_UPDATE_ZOOM__?.({serialized});"))
        .map_err(|error| error.to_string())
}

pub fn hide_all(app: &AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
    for (label, webview) in app.webviews() {
        if label.starts_with(PREFIX) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn action(app: &AppHandle, id: &str, action: &str, value: Option<f64>) -> Result<(), String> {
    let label = label_for(id);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "The webview is not open.".to_string())?;
    match action {
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "back" => webview
            .eval("history.back()")
            .map_err(|error| error.to_string()),
        "forward" => webview
            .eval("history.forward()")
            .map_err(|error| error.to_string()),
        "zoom" => webview
            .set_zoom(value.unwrap_or(1.0).clamp(0.25, 5.0))
            .map_err(|error| error.to_string()),
        "download" => webview
            .eval(
                r#"(() => {
                    const link = document.createElement('a');
                    link.href = window.location.href;
                    link.download = `${document.title || location.hostname || 'download'}.html`;
                    link.rel = 'noopener';
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                })();"#,
            )
            .map_err(|error| error.to_string()),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        _ => Err(format!("Unsupported webview action: {action}")),
    }
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let label = label_for(id);
    if let Some(webview_window) = app.get_webview_window(&label) {
        webview_window.close().map_err(|error| error.to_string())?;
    }
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
