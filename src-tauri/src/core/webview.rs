use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

const PREFIX: &str = "auri-web-";

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    url.parse::<tauri::Url>().map_err(|error| format!("Invalid web URL: {error}"))
}

fn label_for(id: &str) -> String {
    format!("{PREFIX}{id}")
}

pub fn show(app: &AppHandle, id: &str, url: &str, navigate: bool, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
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
            webview.navigate(parsed).map_err(|error| error.to_string())?;
        }
        webview.set_position(position).map_err(|error| error.to_string())?;
        webview.set_size(size).map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or_else(|| "The main window is unavailable.".to_string())?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    window.add_child(builder, position, size).map_err(|error| format!("Could not create webview: {error}"))?;
    Ok(())
}

pub fn hide_all(app: &AppHandle) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with(PREFIX) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn action(app: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    let webview = app.get_webview(&label_for(id)).ok_or_else(|| "The webview is not open.".to_string())?;
    match action {
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "back" => webview.eval("history.back()").map_err(|error| error.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|error| error.to_string()),
        _ => Err(format!("Unsupported webview action: {action}")),
    }
}

pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(id)) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
