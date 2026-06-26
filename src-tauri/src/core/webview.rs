use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

const PREFIX: &str = "auri-web-";
const OVERLAY_LABEL: &str = "auri-browser-overlay";

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
    for (existing_label, webview) in app.webviews() {
        if existing_label.starts_with(PREFIX) && existing_label != label {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    let parsed = parse_url(url)?;
    if let Some(webview) = app.get_webview(&label) {
        if navigate {
            webview
                .navigate(parsed)
                .map_err(|error| error.to_string())?;
        }
        webview
            .set_position(position)
            .map_err(|error| error.to_string())?;
        webview.set_size(size).map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
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
    window
        .add_child(builder, position, size)
        .map_err(|error| format!("Could not create webview: {error}"))?;
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
    for (label, webview) in app.webviews() {
        if label.starts_with(PREFIX) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn action(app: &AppHandle, id: &str, action: &str, value: Option<f64>) -> Result<(), String> {
    let webview = app
        .get_webview(&label_for(id))
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
    if let Some(webview) = app.get_webview(&label_for(id)) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
