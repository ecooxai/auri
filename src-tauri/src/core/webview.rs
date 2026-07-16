use super::{lifecycle, util};
use serde::Serialize;
use std::path::PathBuf;
#[cfg(not(target_os = "linux"))]
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    Rect, WebviewBuilder, WebviewUrl,
};

const PREFIX: &str = "auri-web-";
const STANDALONE_PREFIX: &str = "auri-tab-window-";
const OVERLAY_LABEL: &str = "auri-browser-overlay";
#[cfg(not(target_os = "linux"))]
const POPUP_PREFIX: &str = "auri-web-popup-";
const POPUP_ERROR_EVENT: &str = "auri-web-popup-error";
#[cfg(not(target_os = "linux"))]
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "linux")]
const LINUX_WEBVIEW_LAYER: &str = "auri-native-webview-layer";
#[cfg(target_os = "linux")]
const LINUX_WEBVIEW_BOUNDS_KEY: &str = "auri-native-webview-bounds";

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct LinuxWebviewBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
/// Internal host intercepted by `on_navigation`; the injected page script
/// navigates here to hand selections and images to Auri.
const INTERNAL_HOST: &str = "auri.internal";
/// Label shared by the main window and the child webview that hosts the UI.
pub const MAIN_LABEL: &str = "main";

/// Page script injected into every browser webview. It renders the AI context
/// menu near the pointer for text selections and image clicks. Browser popup
/// requests stay native so OAuth retains its opener and postMessage channel.
/// `__PROMPTS__` is replaced with a JSON array of menu items.
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
  // WebKitGTK reports no URI when a site calls window.open() first and assigns
  // the returned popup location later. Wry rejects that empty create request.
  // about:blank is the browser-defined default, so make it explicit while
  // preserving the real WindowProxy, opener, target name, and feature string.
  const nativeOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    const targetUrl = url == null || String(url).trim() === "" ? "about:blank" : url;
    return nativeOpen(targetUrl, target, features);
  };
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

/// Intercept navigations to the internal host. Returns `true` when the
/// navigation was consumed by an Auri action.
fn handle_internal_navigation(app: &AppHandle, id: &str, url: &tauri::Url) -> bool {
    if url.host_str() != Some(INTERNAL_HOST) {
        return false;
    }
    if url.path() == "/tab-return" || url.path() == "/tab-close" {
        let event = if url.path() == "/tab-return" {
            "auri-tab-window-return"
        } else {
            "auri-tab-window-close"
        };
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

pub fn browser_profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the browser profile directory: {error}"))?
        .join("browser-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|error| format!("Could not create the browser profile directory: {error}"))?;
    Ok(profile)
}

#[cfg(not(target_os = "linux"))]
fn managed_popup_handler(
    app: AppHandle,
) -> impl Fn(
    tauri::Url,
    tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry>
       + Send
       + 'static {
    move |url, features| {
        let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let label = format!("{POPUP_PREFIX}{popup_id}");
        let profile = match browser_profile_dir(&app) {
            Ok(profile) => profile,
            Err(message) => {
                let _ = app.emit(POPUP_ERROR_EVENT, &message);
                return tauri::webview::NewWindowResponse::Deny;
            }
        };
        let builder =
            tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
                .title(url.as_str())
                .inner_size(720.0, 720.0)
                .data_directory(profile)
                .initialization_script(page_script(None))
                .on_new_window(managed_popup_handler(app.clone()))
                // This is not cosmetic: it creates a related browser view, preserving
                // the opener, target name, cookies, and postMessage channel used by
                // Google Identity and other OAuth popups.
                .window_features(features)
                .focused(true);

        match builder.build() {
            Ok(window) => {
                if let Err(error) = install_linux_browser_support(&app, &label, window.as_ref()) {
                    let _ = window.close();
                    let message = format!("Could not configure the browser popup: {error}");
                    let _ = app.emit(POPUP_ERROR_EVENT, &message);
                    return tauri::webview::NewWindowResponse::Deny;
                }
                tauri::webview::NewWindowResponse::Create { window }
            }
            Err(error) => {
                let message = format!("Could not open the browser popup: {error}");
                let _ = app.emit(POPUP_ERROR_EVENT, &message);
                tauri::webview::NewWindowResponse::Deny
            }
        }
    }
}

pub fn show_standalone(app: &AppHandle, id: &str, url: &str, title: &str) -> Result<(), String> {
    let label = standalone_label_for(id);
    let parsed = parse_url(url)?;
    if let Some(window) = app.get_webview_window(&label) {
        if let Some(webview) = app.get_webview(&label) {
            webview
                .navigate(parsed)
                .map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let load_app = app.clone();
    let load_id = id.to_string();
    let navigation_app = app.clone();
    let navigation_id = id.to_string();
    let builder = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(920.0, 720.0)
        .data_directory(browser_profile_dir(app)?)
        .initialization_script(format!("{}\n{}", page_script(None), STANDALONE_TAB_SCRIPT));
    #[cfg(not(target_os = "linux"))]
    let builder = builder.on_new_window(managed_popup_handler(app.clone()));
    builder
        .on_navigation(move |target| {
            if handle_internal_navigation(&navigation_app, &navigation_id, target) {
                return false;
            }
            true
        })
        .on_page_load(move |_, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished
                || payload.url().host_str() == Some(INTERNAL_HOST)
            {
                return;
            }
            let _ = load_app.emit(
                "auri-web-navigation",
                WebNavigation {
                    id: load_id.clone(),
                    url: payload.url().to_string(),
                },
            );
        })
        .focused(true)
        .build()
        .map_err(|error| format!("Could not create the standalone tab window: {error}"))?;
    if let Some(webview) = app.get_webview(&label) {
        install_linux_browser_support(app, id, &webview)?;
    }
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
fn with_linux_webview<T, F>(webview: &tauri::Webview, action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(webkit2gtk::WebView) -> Result<T, String> + Send + 'static,
{
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let _ = send.send(action(platform.inner()));
        })
        .map_err(|error| error.to_string())?;
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Timed out while arranging the Linux webview layer.".to_string())?
}

#[cfg(target_os = "linux")]
fn linux_related_view(
    app: &AppHandle,
    window: &tauri::Window,
    builder: WebviewBuilder<tauri::Wry>,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<tauri::Webview, String> {
    let main = app
        .get_webview(MAIN_LABEL)
        .ok_or_else(|| "The Linux main webview is unavailable.".to_string())?;
    let window = window.clone();
    with_linux_webview(&main, move |related| {
        window
            .add_child(builder.with_related_view(related), position, size)
            .map_err(|error| error.to_string())
    })
}

#[cfg(target_os = "linux")]
fn find_linux_webview_layer(widget: &gtk::Widget) -> Option<gtk::Overlay> {
    use gtk::prelude::*;
    if widget.widget_name().as_str() == LINUX_WEBVIEW_LAYER {
        if let Ok(layer) = widget.clone().downcast::<gtk::Overlay>() {
            return Some(layer);
        }
    }
    let container = widget.clone().downcast::<gtk::Container>().ok()?;
    container
        .children()
        .into_iter()
        .find_map(|child| find_linux_webview_layer(&child))
}

#[cfg(target_os = "linux")]
fn connect_linux_media_permission_prompt(webview: &webkit2gtk::WebView) {
    use gtk::prelude::*;
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
    };

    webview.connect_permission_request(|webview, request| {
        let Some(media) = request.dynamic_cast_ref::<UserMediaPermissionRequest>() else {
            return false;
        };
        let audio = media.is_for_audio_device();
        let video = media.is_for_video_device();
        let capability = match (audio, video) {
            (true, true) => "camera and microphone",
            (true, false) => "microphone",
            (false, true) => "camera",
            (false, false) => "screen capture",
        };
        let origin = webview
            .uri()
            .and_then(|uri| uri.parse::<url::Url>().ok())
            .and_then(|uri| uri.host_str().map(str::to_string))
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| "This page".to_string());
        let parent = webview
            .toplevel()
            .and_then(|widget| widget.downcast::<gtk::Window>().ok());
        let dialog = gtk::MessageDialog::new(
            parent.as_ref(),
            gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
            gtk::MessageType::Question,
            gtk::ButtonsType::None,
            &format!("Allow {origin} to use your {capability}?"),
        );
        dialog.set_title("Website permission");
        dialog.set_secondary_text(Some(
            "Auri will pass your choice to WebKit. Linux capture services, device availability, and any system consent still apply.",
        ));
        dialog.add_buttons(&[
            ("Don’t Allow", gtk::ResponseType::Cancel),
            ("Allow", gtk::ResponseType::Accept),
        ]);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let pending = request.clone();
        dialog.connect_response(move |dialog, response| {
            if response == gtk::ResponseType::Accept {
                PermissionRequestExt::allow(&pending);
            } else {
                PermissionRequestExt::deny(&pending);
            }
            dialog.close();
        });
        dialog.show_all();
        true
    });
}

#[cfg(target_os = "linux")]
fn connect_linux_process_recovery(app: &AppHandle, id: &str, webview: &webkit2gtk::WebView) {
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::{SettingsExt, WebProcessTerminationReason, WebViewExt};

    let app = app.clone();
    let id = id.to_string();
    let recovered = Rc::new(Cell::new(false));
    webview.connect_web_process_terminated(move |webview, reason| {
        if reason != WebProcessTerminationReason::Crashed {
            return;
        }
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(false);
        }
        let can_reload = !recovered.replace(true);
        let url = webview.uri().unwrap_or_default().to_string();
        let message = if can_reload {
            "The website process crashed. Auri switched the tab to its safe Linux webview settings and reloaded it."
        } else {
            "The website process crashed after its automatic recovery was already used. Reload the tab to try again."
        };
        let _ = app.emit(
            "auri-web-process-recovered",
            serde_json::json!({ "id": id, "url": url, "message": message }),
        );
        if can_reload {
            let _ = webview.reload();
        }
    });
}

#[cfg(target_os = "linux")]
fn configure_linux_browser_context(webview: &webkit2gtk::WebView) -> Result<(), String> {
    use webkit2gtk::{
        CookieAcceptPolicy, CookieManagerExt, HardwareAccelerationPolicy, SettingsExt,
        WebContextExt, WebViewExt, WebsiteDataManagerExt,
    };

    if let Some(settings) = webview.settings() {
        settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
    }

    let context = webview
        .context()
        .ok_or_else(|| "The Linux browser context is unavailable.".to_string())?;
    // Embedded OAuth depends on state crossing a top-level provider popup and
    // its opener. WebKitGTK's tracking prevention can latch that redirect as
    // third-party and discard the state cookie even after it returns to the
    // first-party site. Auri is a general browser surface, so use the same
    // compatibility policy expected by mainstream Linux browsers.
    if let Some(manager) = context.website_data_manager() {
        manager.set_itp_enabled(false);
    }
    let cookies = context
        .cookie_manager()
        .ok_or_else(|| "The Linux browser cookie manager is unavailable.".to_string())?;
    cookies.set_accept_policy(CookieAcceptPolicy::Always);
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_linux_external_view(webview: &webkit2gtk::WebView) {
    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};

    if let Some(settings) = webview.settings() {
        settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
        // WebKitGTK 2.52 currently crashes in the installed PipeWire device
        // provider when X and Google Identity probe capture devices. Disable
        // capture only for external website views; Auri's own recorder remains
        // on the application webview and keeps its native permission flow.
        settings.set_enable_media_stream(false);
    }
}

#[cfg(target_os = "linux")]
fn connect_linux_popup_handler(app: &AppHandle, id: &str, webview: &webkit2gtk::WebView) {
    use gtk::prelude::*;
    use webkit2gtk::{WebView, WebViewExt};

    let app = app.clone();
    let id = id.to_string();
    webview.connect_create(move |opener, _| {
        let popup = WebView::with_related_view(opener);
        if let Err(error) = configure_linux_browser_context(&popup) {
            let _ = app.emit(POPUP_ERROR_EVENT, &error);
            return None;
        }
        configure_linux_external_view(&popup);
        connect_linux_media_permission_prompt(&popup);
        connect_linux_process_recovery(&app, &id, &popup);
        connect_linux_popup_handler(&app, &id, &popup);

        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title("Auri sign in");
        window.set_default_size(720, 720);
        window.add(&popup);
        let popup_window = window.clone();
        popup.connect_close(move |_| popup_window.close());
        window.show_all();
        Some(popup.upcast::<gtk::Widget>())
    });
}

#[cfg(target_os = "linux")]
fn install_linux_media_permission_prompt(webview: &tauri::Webview) -> Result<(), String> {
    with_linux_webview(webview, |inner| {
        connect_linux_media_permission_prompt(&inner);
        Ok(())
    })
}

#[cfg(not(target_os = "linux"))]
fn install_linux_media_permission_prompt(_webview: &tauri::Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux_browser_support(
    app: &AppHandle,
    id: &str,
    webview: &tauri::Webview,
) -> Result<(), String> {
    let app = app.clone();
    let id = id.to_string();
    with_linux_webview(webview, move |inner| {
        configure_linux_browser_context(&inner)?;
        configure_linux_external_view(&inner);
        connect_linux_media_permission_prompt(&inner);
        connect_linux_process_recovery(&app, &id, &inner);
        connect_linux_popup_handler(&app, &id, &inner);
        Ok(())
    })
}

#[cfg(not(target_os = "linux"))]
fn install_linux_browser_support(
    _app: &AppHandle,
    _id: &str,
    _webview: &tauri::Webview,
) -> Result<(), String> {
    Ok(())
}

/// Put the main WebKitGTK view at the base of one native overlay and every
/// browser child above it. Tauri otherwise packs Linux children into a vertical
/// box, which makes a website consume a second window-sized row instead of the
/// active tab.
#[cfg(target_os = "linux")]
pub fn install_linux_webview_layer(main_webview: &tauri::Webview) -> Result<(), String> {
    with_linux_webview(main_webview, |inner| {
        use gtk::prelude::*;
        configure_linux_browser_context(&inner)?;
        if inner
            .toplevel()
            .and_then(|root| find_linux_webview_layer(&root))
            .is_some()
        {
            return Ok(());
        }
        let parent = inner
            .parent()
            .and_then(|widget| widget.downcast::<gtk::Box>().ok())
            .ok_or_else(|| "The Linux main webview container is unavailable.".to_string())?;
        let layer = gtk::Overlay::new();
        layer.set_widget_name(LINUX_WEBVIEW_LAYER);
        layer.set_hexpand(true);
        layer.set_vexpand(true);
        layer.set_halign(gtk::Align::Fill);
        layer.set_valign(gtk::Align::Fill);
        layer.connect_get_child_position(|_, child| {
            // This key is owned exclusively by this module, and the copied
            // value is read synchronously before another bounds update can
            // replace the object data.
            let bounds = unsafe {
                child
                    .data::<LinuxWebviewBounds>(LINUX_WEBVIEW_BOUNDS_KEY)
                    .map(|bounds| *bounds.as_ref())
            }?;
            Some(gtk::Rectangle::new(
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
            ))
        });
        parent.remove(&inner);
        layer.add(&inner);
        parent.pack_start(&layer, true, true, 0);
        layer.show_all();
        Ok(())
    })?;
    install_linux_media_permission_prompt(main_webview)
}

#[cfg(not(target_os = "linux"))]
pub fn install_linux_webview_layer(_main_webview: &tauri::Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn embed_linux_webview(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    with_linux_webview(webview, move |inner| {
        use gtk::prelude::*;
        let root = inner
            .toplevel()
            .ok_or_else(|| "The Linux webview window is unavailable.".to_string())?;
        let layer = find_linux_webview_layer(&root)
            .ok_or_else(|| "The Linux webview layer is unavailable.".to_string())?;
        let already_embedded = inner
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
            .is_some_and(|parent| parent.widget_name().as_str() == LINUX_WEBVIEW_LAYER);
        if !already_embedded {
            if let Some(parent) = inner
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Container>().ok())
            {
                parent.remove(&inner);
            }
            layer.add_overlay(&inner);
        }
        // A local file viewer can finish painting after a later browser
        // overlay is attached. Reassert the GTK overlay order whenever a
        // child is embedded so menus remain above either websites or files.
        layer.reorder_overlay(&inner, -1);
        let bounds = LinuxWebviewBounds {
            x: x.max(0.0).round() as i32,
            y: y.max(0.0).round() as i32,
            width: width.max(1.0).round() as i32,
            height: height.max(1.0).round() as i32,
        };
        // The module-owned key above guarantees the matching read type in the
        // overlay allocation callback.
        unsafe { inner.set_data(LINUX_WEBVIEW_BOUNDS_KEY, bounds) };
        inner.set_halign(gtk::Align::Start);
        inner.set_valign(gtk::Align::Start);
        inner.set_margin_start(0);
        inner.set_margin_top(0);
        inner.set_margin_end(0);
        inner.set_margin_bottom(0);
        inner.set_size_request(bounds.width, bounds.height);
        inner.show_all();
        layer.queue_resize();
        Ok(())
    })
}

#[cfg(not(target_os = "linux"))]
fn embed_linux_webview(
    _webview: &tauri::Webview,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Ok(())
}

fn set_embedded_webview_bounds(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(x.max(0.0), y.max(0.0)).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|error| error.to_string())?;
    embed_linux_webview(webview, x, y, width, height)
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
        set_embedded_webview_bounds(&webview, x, y, width, height)?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let load_app = app.clone();
    let load_id = id.to_string();
    let nav_app = app.clone();
    let nav_id = id.to_string();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .data_directory(browser_profile_dir(app)?)
        .initialization_script(page_script(ai_prompts));
    #[cfg(not(target_os = "linux"))]
    let builder = builder.on_new_window(managed_popup_handler(app.clone()));
    let builder = builder.on_navigation(move |target| {
        if handle_internal_navigation(&nav_app, &nav_id, target) {
            return false;
        }
        true
    });
    let builder = builder.on_page_load(move |_, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished
            || payload.url().host_str() == Some(INTERNAL_HOST)
        {
            return;
        }
        let _ = load_app.emit(
            "auri-web-navigation",
            WebNavigation {
                id: load_id.clone(),
                url: payload.url().to_string(),
            },
        );
    });
    #[cfg(target_os = "linux")]
    let webview = linux_related_view(app, &window, builder, position, size)
        .map_err(|error| format!("Could not create webview: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let webview = window
        .add_child(builder, position, size)
        .map_err(|error| format!("Could not create webview: {error}"))?;
    install_linux_browser_support(app, id, &webview)?;
    set_embedded_webview_bounds(&webview, x, y, width, height)?;
    webview.show().map_err(|error| error.to_string())?;
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
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    #[cfg(target_os = "linux")]
    let webview = linux_related_view(app, &window, builder, position, size)
        .map_err(|error| format!("Could not create browser overlay: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let webview = window
        .add_child(builder, position, size)
        .map_err(|error| format!("Could not create browser overlay: {error}"))?;
    set_embedded_webview_bounds(&webview, x, y, width, height)?;
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
