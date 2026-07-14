use super::{lifecycle, util};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect,
    WebviewBuilder, WebviewUrl,
};

const PREFIX: &str = "auri-web-";
const STANDALONE_PREFIX: &str = "auri-tab-window-";
const POPUP_PREFIX: &str = "auri-popup-";
const OVERLAY_LABEL: &str = "auri-browser-overlay";
/// Internal host intercepted by `on_navigation`; the injected page script
/// navigates here to hand selections, images, and popup requests to Auri.
const INTERNAL_HOST: &str = "auri.internal";
/// Label shared by the main window and the child webview that hosts the UI.
pub const MAIN_LABEL: &str = "main";

/// Page script injected into every browser webview. It renders the AI context
/// menu near the pointer for text selections and image clicks, and routes
/// `window.open` / `target="_blank"` to real popup windows so OAuth-style
/// logins work. `__PROMPTS__` is replaced with a JSON array of menu items.
const PAGE_SCRIPT_TEMPLATE: &str = r#"(() => {
  if (window.__AURI_AI__) return; window.__AURI_AI__ = 1;
  const PROMPTS = __PROMPTS__;
  const INTERNAL = "https://auri.internal/";
  const go = (path, params) => {
    const query = Object.entries(params)
      .map(([key, value]) => key + "=" + encodeURIComponent(value == null ? "" : String(value)))
      .join("&");
    try { window.location.assign(INTERNAL + path + "?" + query); } catch (error) {}
  };
  const nativeOpen = window.open;
  window.open = function (url) {
    if (url) {
      try { go("popup", { url: new URL(url, window.location.href).href }); } catch (error) {}
      return null;
    }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null;
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null;
    if (anchor && anchor.href && /^https?:/.test(anchor.href)) {
      event.preventDefault();
      event.stopPropagation();
      go("popup", { url: anchor.href });
    }
  }, true);
  let menu = null;
  const hideMenu = () => { if (menu) { menu.remove(); menu = null; } };
  const showMenu = (x, y, buildPayload) => {
    hideMenu();
    menu = document.createElement("div");
    menu.setAttribute("style", "position:fixed;z-index:2147483647;display:flex;gap:2px;padding:4px;border-radius:10px;background:rgba(22,24,32,.94);box-shadow:0 10px 30px rgba(0,0,0,.35);font:12px -apple-system,system-ui,sans-serif;");
    for (const item of PROMPTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.setAttribute("style", "all:unset;cursor:pointer;padding:6px 11px;border-radius:7px;color:#fff;white-space:nowrap;");
      button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,.16)"; });
      button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
      button.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = buildPayload();
        hideMenu();
        if (payload) go("ai", Object.assign({ action: item.id }, payload));
      });
      menu.appendChild(button);
    }
    document.documentElement.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(4, x - rect.width / 2), window.innerWidth - rect.width - 4);
    // Sit about 50px below the pointer; flip above when the selection is
    // near the bottom of the viewport.
    const OFFSET = 50;
    const below = y + OFFSET;
    const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height - OFFSET) : below;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  };
  const imagePayload = (image) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      if (!canvas.width || !canvas.height) throw new Error("empty");
      canvas.getContext("2d").drawImage(image, 0, 0);
      const data = canvas.toDataURL("image/png").split(",")[1] || "";
      if (data && data.length < 1500000) return { kind: "image", image: data };
      throw new Error("large");
    } catch (error) {
      return { kind: "image", imageUrl: image.currentSrc || image.src || "" };
    }
  };
  // Text selected inside <input> and <textarea> tags is invisible to
  // window.getSelection() in WebKit, so read the field's own selection range.
  const fieldSelection = () => {
    const element = document.activeElement;
    if (!element) return "";
    const tag = element.tagName;
    const editableInput = tag === "TEXTAREA"
      || (tag === "INPUT" && /^(text|search|url|email|tel|)$/i.test(element.type || "text"));
    if (!editableInput) return "";
    const { selectionStart, selectionEnd, value } = element;
    if (selectionStart == null || selectionEnd == null || selectionEnd <= selectionStart) return "";
    return String(value || "").slice(selectionStart, selectionEnd);
  };
  document.addEventListener("mouseup", (event) => {
    if (menu && menu.contains(event.target)) return;
    window.setTimeout(() => {
      const selection = String(window.getSelection ? window.getSelection() : "").trim() || fieldSelection().trim();
      if (selection) {
        showMenu(event.clientX, event.clientY, () => ({ kind: "text", text: selection.slice(0, 8000) }));
        return;
      }
      const image = event.target && event.target.closest ? event.target.closest("img") : null;
      if (image && event.button === 0) {
        showMenu(event.clientX, event.clientY, () => imagePayload(image));
        return;
      }
      hideMenu();
    }, 0);
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideMenu(); }, true);
  window.addEventListener("scroll", hideMenu, true);
})();"#;

fn page_script(ai_prompts: Option<&str>) -> String {
    let fallback = r#"[{"id":"ask","label":"Ask"},{"id":"translate","label":"Translate"},{"id":"tts","label":"Speak"}]"#;
    let prompts = ai_prompts
        .filter(|value| serde_json::from_str::<serde_json::Value>(value).is_ok())
        .unwrap_or(fallback);
    PAGE_SCRIPT_TEMPLATE.replace("__PROMPTS__", prompts)
}

const STANDALONE_TAB_SCRIPT: &str = r##"(() => {
  if (window.__AURI_STANDALONE_TAB__) return; window.__AURI_STANDALONE_TAB__ = 1;
  const INTERNAL = "https://auri.internal/";
  const go = (action) => { try { window.location.assign(INTERNAL + action); } catch (error) {} };
  const install = () => {
    if (!document.body || document.getElementById("auri-standalone-tabbar")) return;
    const bar = document.createElement("div");
    bar.id = "auri-standalone-tabbar";
    bar.setAttribute("style", "position:fixed;z-index:2147483647;left:0;right:0;top:0;height:38px;display:flex;align-items:center;padding:4px 8px;background:rgba(238,241,245,.96);border-bottom:1px solid rgba(78,94,119,.14);font:12px -apple-system,system-ui,sans-serif;");
    const icon = document.createElement("button");
    icon.type = "button"; icon.textContent = "◈"; icon.title = "Tab menu";
    icon.setAttribute("style", "width:30px;height:30px;border:0;border-radius:9px;background:rgba(184,212,254,.55);color:#274168;cursor:pointer;");
    const menu = document.createElement("div");
    menu.hidden = true;
    menu.setAttribute("style", "position:absolute;left:8px;top:35px;width:205px;padding:7px;border:1px solid rgba(78,94,119,.14);border-radius:12px;background:#fff;box-shadow:0 16px 45px rgba(24,32,51,.18);");
    const action = (label, handler, danger) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("style", "display:block;width:100%;height:34px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:" + (danger ? "#a84e5b" : "#536178") + ";text-align:left;cursor:pointer;"); button.onclick = handler; menu.appendChild(button); };
    action("Reload tab", () => location.reload(), false);
    action("Go back to main window", () => go("tab-return"), false);
    action("Close tab", () => go("tab-close"), true);
    icon.onclick = () => { menu.hidden = !menu.hidden; };
    bar.append(icon, menu); document.body.appendChild(bar);
    const currentPadding = parseFloat(getComputedStyle(document.documentElement).paddingTop) || 0;
    document.documentElement.style.paddingTop = (currentPadding + 38) + "px";
    document.addEventListener("pointerdown", (event) => { if (!bar.contains(event.target)) menu.hidden = true; }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true }); else install();
})();"##;

fn open_popup(app: &AppHandle, url: &str) {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        return;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return;
    }
    let handle = app.clone();
    let label = format!(
        "{POPUP_PREFIX}{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default()
    );
    let _ = app.run_on_main_thread(move || {
        let _ = tauri::WebviewWindowBuilder::new(
            &handle,
            &label,
            tauri::WebviewUrl::External(parsed),
        )
        .title("Auri")
        .inner_size(520.0, 680.0)
        .focused(true)
        .build();
    });
}

/// Intercept navigations to the internal host. Returns `true` when the
/// navigation was consumed (AI menu action or popup request).
fn handle_internal_navigation(app: &AppHandle, id: &str, url: &tauri::Url) -> bool {
    if url.host_str() != Some(INTERNAL_HOST) {
        return false;
    }
    if url.path() == "/popup" {
        if let Some((_, target)) = url.query_pairs().find(|(key, _)| key == "url") {
            open_popup(app, &target);
        }
        return true;
    }
    if url.path() == "/tab-return" || url.path() == "/tab-close" {
        let event = if url.path() == "/tab-return" { "auri-tab-window-return" } else { "auri-tab-window-close" };
        let _ = app.emit(event, serde_json::json!({ "id": id }));
        if let Some(window) = app.get_webview_window(&standalone_label_for(id)) {
            let _ = window.close();
        }
        if url.path() == "/tab-return" {
            let _ = lifecycle::reveal_main_window(app);
        }
        return true;
    }
    let mut payload = serde_json::Map::new();
    payload.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    for (key, value) in url.query_pairs() {
        payload.insert(
            key.into_owned(),
            serde_json::Value::String(value.into_owned()),
        );
    }
    let _ = app.emit("auri-web-ai", serde_json::Value::Object(payload));
    true
}

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

fn standalone_label_for(id: &str) -> String {
    format!("{STANDALONE_PREFIX}{id}")
}

pub fn show_standalone(app: &AppHandle, id: &str, url: &str, title: &str) -> Result<(), String> {
    let label = standalone_label_for(id);
    let parsed = parse_url(url)?;
    if let Some(window) = app.get_webview_window(&label) {
        if let Some(webview) = app.get_webview(&label) {
            webview.navigate(parsed).map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let event_app = app.clone();
    let event_id = id.to_string();
    let navigation_app = app.clone();
    let navigation_id = id.to_string();
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(920.0, 720.0)
        .initialization_script(format!("{}\n{}", page_script(None), STANDALONE_TAB_SCRIPT))
        .on_navigation(move |target| {
            if handle_internal_navigation(&navigation_app, &navigation_id, target) {
                return false;
            }
            let _ = event_app.emit("auri-web-navigation", WebNavigation { id: event_id.clone(), url: target.to_string() });
            true
        })
        .focused(true)
        .build()
        .map_err(|error| format!("Could not create the standalone tab window: {error}"))?;
    Ok(())
}

pub fn reload_standalone(app: &AppHandle, id: &str) -> Result<(), String> {
    app.get_webview(&standalone_label_for(id))
        .ok_or_else(|| "The standalone tab window is not open.".to_string())?
        .reload()
        .map_err(|error| error.to_string())
}

pub fn close_standalone(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&standalone_label_for(id)) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Resize the main webview so it matches the window's inner size.
///
/// The main webview is attached with `add_child`, which keeps whatever size it
/// was given at creation time. Without re-fitting it on every window resize the
/// UI stops matching the window — for example it stays small after the window
/// is enlarged. This runs for both the macOS (WKWebView) and Linux (WebKitGTK)
/// child webviews.
pub fn fit_main_webview(window: &tauri::Window) -> Result<(), String> {
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let (x, y, width, height) = util::main_fill_bounds(size.width, size.height);
    if let Some(webview) = window.app_handle().get_webview(MAIN_LABEL) {
        webview
            .set_bounds(Rect {
                position: PhysicalPosition::new(x, y).into(),
                size: PhysicalSize::new(width, height).into(),
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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

/// Embedded child webviews are unreliable on Linux (WebKitGTK renders in a
/// separate X11 child window and Wayland offers no way to reposition it), so
/// Linux defaults to a dedicated browser window. Set `AURI_EMBEDDED_WEBVIEW=1`
/// to force the embedded child webview instead.
#[cfg(target_os = "linux")]
fn use_window_webview() -> bool {
    std::env::var("AURI_EMBEDDED_WEBVIEW").ok().as_deref() != Some("1")
}

#[cfg(not(target_os = "linux"))]
fn use_window_webview() -> bool {
    false
}

fn show_window_webview(
    app: &AppHandle,
    id: &str,
    label: &str,
    parsed: tauri::Url,
    navigate: bool,
    width: f64,
    height: f64,
    ai_prompts: Option<&str>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        if navigate {
            if let Some(webview) = app.get_webview(label) {
                webview
                    .navigate(parsed)
                    .map_err(|error| error.to_string())?;
            }
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let event_app = app.clone();
    let event_id = id.to_string();
    let nav_app = app.clone();
    tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title("Auri Browser")
        .inner_size(width.max(760.0), height.max(560.0))
        .initialization_script(page_script(ai_prompts))
        .on_navigation(move |target| {
            if handle_internal_navigation(&nav_app, &event_id, target) {
                return false;
            }
            let _ = event_app.emit(
                "auri-web-navigation",
                WebNavigation {
                    id: event_id.clone(),
                    url: target.to_string(),
                },
            );
            true
        })
        .focused(true)
        .build()
        .map_err(|error| format!("Could not create the browser window: {error}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn show(
    app: &AppHandle,
    id: &str,
    url: &str,
    navigate: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    ai_prompts: Option<&str>,
) -> Result<(), String> {
    let label = label_for(id);
    let parsed = parse_url(url)?;
    for (existing_label, webview) in app.webviews() {
        if existing_label.starts_with(PREFIX) && existing_label != label {
            // Window-hosted webviews (Linux fallback) must be hidden through
            // their window; Webview::hide only supports embedded children.
            if let Some(window) = app.get_webview_window(&existing_label) {
                window.hide().map_err(|error| error.to_string())?;
            } else {
                webview.hide().map_err(|error| error.to_string())?;
            }
        }
    }
    if use_window_webview() {
        return show_window_webview(app, id, &label, parsed, navigate, width, height, ai_prompts);
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
    let nav_app = app.clone();
    let nav_id = id.to_string();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(page_script(ai_prompts))
        .on_navigation(move |target| {
            if handle_internal_navigation(&nav_app, &nav_id, target) {
                return false;
            }
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
    let mut hidden = std::collections::HashSet::new();
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            window.hide().map_err(|error| error.to_string())?;
            hidden.insert(label);
        }
    }
    for (label, webview) in app.webviews() {
        if label.starts_with(PREFIX) && !hidden.contains(&label) {
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
