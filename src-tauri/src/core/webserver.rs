//! Local web host for the Auri UI. `auri browser` (or the `auri browser`
//! registry command) starts one bounded HTTP server on 127.0.0.1:8899 that
//! serves the same frontend the desktop window runs, bridges its native
//! `invoke` calls, and streams terminal events over SSE. The browser session
//! is a second frontend sharing the same native core — it never publishes the
//! mirrored app state (the desktop window owns that) and desktop-window-only
//! commands report clearly that they are unavailable.
//!
//! Security: the listener binds loopback only and every request must carry a
//! local `Host` header, which blocks DNS-rebinding pages from reaching the
//! bridge. Heads and bodies are size-bounded.

pub const UI_PORT: u16 = 8899;

/// The parsed first line and the two headers the server routes on.
pub struct HttpHead {
    pub method: String,
    pub path: String,
    pub host: String,
    pub content_length: usize,
}

pub fn parse_http_head(head: &str) -> Result<HttpHead, String> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").trim();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("");
    if method.is_empty() || !path.starts_with('/') || !version.starts_with("HTTP/") {
        return Err("Malformed HTTP request line.".to_string());
    }

    let mut host = String::new();
    let mut content_length = 0_usize;
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "host" {
            host = value.to_string();
        } else if name == "content-length" {
            content_length = value.parse().unwrap_or(0);
        }
    }
    Ok(HttpHead { method, path, host, content_length })
}

/// Only loopback hosts may talk to the bridge: a malicious web page that
/// rebinds its DNS name to 127.0.0.1 still sends its own name as `Host`.
pub fn host_is_local(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let bare = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(bare, "127.0.0.1" | "localhost" | "::1")
}

pub fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let high = (hex[0] as char).to_digit(16)?;
            let low = (hex[1] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Map a request path to a UI-root-relative asset path. Rejects traversal and
/// dotfiles after percent-decoding; `/` becomes `index.html`.
pub fn sanitize_asset_path(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or("");
    if !path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let mut clean: Vec<&str> = Vec::new();
    for segment in decoded.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment.starts_with('.') {
            return None;
        }
        clean.push(segment);
    }
    if clean.is_empty() {
        return Some("index.html".to_string());
    }
    Some(clean.join("/"))
}

/// The invoke command name from `/__auri__/invoke/<name>`; names use the
/// tauri command charset only.
pub fn parse_invoke_command(path: &str) -> Option<&str> {
    let name = path.strip_prefix("/__auri__/invoke/")?;
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return None;
    }
    Some(name)
}

pub fn content_type_for(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(all(unix, not(test)))]
mod server {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;
    use tauri::Listener;

    const MAX_HEAD_BYTES: usize = 32 * 1024;
    const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
    /// Events forwarded to browser sessions. External `auri-command` events
    /// stay with the desktop window so a CLI command never runs twice.
    const FORWARDED_EVENTS: [&str; 2] = ["terminal-data", "terminal-exit"];

    static SERVER_URL: Mutex<Option<String>> = Mutex::new(None);
    static EVENT_CLIENTS: Mutex<Vec<Sender<String>>> = Mutex::new(Vec::new());

    fn broadcast(name: &str, payload: &str) {
        // SSE data must be line-framed; snapshots and terminal payloads are
        // single-line JSON, but never trust that blindly.
        let data = payload.replace('\n', "\ndata: ");
        let frame = format!("event: {name}\ndata: {data}\n\n");
        if let Ok(mut clients) = EVENT_CLIENTS.lock() {
            clients.retain(|client| client.send(frame.clone()).is_ok());
        }
    }

    pub fn ensure_started(app: tauri::AppHandle) -> Result<String, String> {
        let mut guard = SERVER_URL
            .lock()
            .map_err(|_| "The UI web server state is unavailable.".to_string())?;
        if let Some(url) = guard.as_ref() {
            return Ok(url.clone());
        }
        let listener = TcpListener::bind(("127.0.0.1", UI_PORT)).map_err(|error| {
            format!("Could not serve the Auri UI on 127.0.0.1:{UI_PORT}: {error}")
        })?;

        for name in FORWARDED_EVENTS {
            app.listen(name, move |event| broadcast(name, event.payload()));
        }

        let accept_app = app.clone();
        thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else { continue };
                let app = accept_app.clone();
                thread::spawn(move || handle_client(stream, app));
            }
        });

        let url = format!("http://127.0.0.1:{UI_PORT}");
        *guard = Some(url.clone());
        Ok(url)
    }

    pub fn current_url() -> Option<String> {
        SERVER_URL.lock().ok().and_then(|guard| guard.clone())
    }

    fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
    }

    fn read_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
        let mut buffer = Vec::new();
        let mut byte = [0_u8; 1];
        loop {
            match stream.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    buffer.push(byte[0]);
                    if buffer.ends_with(b"\r\n\r\n") {
                        break;
                    }
                    if buffer.len() > MAX_HEAD_BYTES {
                        return Err("Request head exceeds the 32 KB limit.".to_string());
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        String::from_utf8(buffer.clone())
            .map(|head| (head, Vec::new()))
            .map_err(|error| error.to_string())
    }

    fn read_body(stream: &mut TcpStream, length: usize) -> Result<Vec<u8>, String> {
        if length > MAX_BODY_BYTES {
            return Err("Request body exceeds the 64 MB limit.".to_string());
        }
        let mut body = vec![0_u8; length];
        stream
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
        Ok(body)
    }

    fn handle_client(mut stream: TcpStream, app: tauri::AppHandle) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let head_text = match read_head(&mut stream) {
            Ok((head, _)) => head,
            Err(error) => {
                write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", error.as_bytes());
                return;
            }
        };
        let head = match parse_http_head(&head_text) {
            Ok(head) => head,
            Err(error) => {
                write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", error.as_bytes());
                return;
            }
        };
        if !host_is_local(&head.host) {
            write_response(
                &mut stream,
                "403 Forbidden",
                "text/plain; charset=utf-8",
                b"The Auri UI server only accepts local requests.",
            );
            return;
        }

        match (head.method.as_str(), head.path.as_str()) {
            ("GET", "/__auri__/ping") => {
                write_response(&mut stream, "200 OK", "application/json", b"{\"app\":\"auri\"}");
            }
            ("GET", "/__auri__/events") => serve_events(stream),
            ("POST", path) if path.starts_with("/__auri__/invoke/") => {
                let Some(command) = parse_invoke_command(path).map(str::to_string) else {
                    write_response(
                        &mut stream,
                        "404 Not Found",
                        "text/plain; charset=utf-8",
                        b"Unknown bridge command name.",
                    );
                    return;
                };
                let body = match read_body(&mut stream, head.content_length) {
                    Ok(body) => body,
                    Err(error) => {
                        write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", error.as_bytes());
                        return;
                    }
                };
                let args: Value = if body.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice(&body) {
                        Ok(value) => value,
                        Err(error) => {
                            let reply = json!({ "ok": false, "error": format!("Invalid JSON body: {error}") });
                            write_response(&mut stream, "200 OK", "application/json", reply.to_string().as_bytes());
                            return;
                        }
                    }
                };
                let reply = match dispatch(&app, &command, &args) {
                    Ok(result) => json!({ "ok": true, "result": result }),
                    Err(error) => json!({ "ok": false, "error": error }),
                };
                write_response(&mut stream, "200 OK", "application/json", reply.to_string().as_bytes());
            }
            ("GET", path) => serve_static(&mut stream, &app, path),
            _ => {
                write_response(
                    &mut stream,
                    "405 Method Not Allowed",
                    "text/plain; charset=utf-8",
                    b"Unsupported method.",
                );
            }
        }
    }

    /// Long-lived server-sent-events stream. Idle periods send a comment ping
    /// so a vanished browser turns into a write error, not a leaked thread.
    fn serve_events(mut stream: TcpStream) {
        let (sender, receiver) = channel::<String>();
        if let Ok(mut clients) = EVENT_CLIENTS.lock() {
            clients.push(sender);
        }
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        if stream.write_all(head.as_bytes()).is_err() {
            return;
        }
        let _ = stream.set_read_timeout(None);
        loop {
            match receiver.recv_timeout(Duration::from_secs(15)) {
                Ok(frame) => {
                    if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() {
                        return;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn dist_candidates() -> Vec<std::path::PathBuf> {
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("AURI_UI_DIST") {
            candidates.push(std::path::PathBuf::from(path));
        }
        if let Ok(current) = std::env::current_dir() {
            candidates.push(current.join("dist"));
            candidates.push(current.join("../dist"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(directory) = exe.parent() {
                candidates.push(directory.join("dist"));
                candidates.push(directory.join("../dist"));
            }
        }
        candidates
    }

    fn asset_bytes(app: &tauri::AppHandle, relative: &str) -> Option<Vec<u8>> {
        let resolver = app.asset_resolver();
        for key in [format!("/{relative}"), relative.to_string()] {
            if let Some(asset) = resolver.get(key) {
                return Some(asset.bytes);
            }
        }
        for base in dist_candidates() {
            let path = base.join(relative);
            if path.is_file() {
                if let Ok(bytes) = std::fs::read(&path) {
                    return Some(bytes);
                }
            }
        }
        None
    }

    /// Development fallback: relay a GET to the configured dev server so
    /// `auri browser` also works under `tauri dev`, where assets are not
    /// embedded. Loopback dev URLs only.
    fn proxy_dev_server(app: &tauri::AppHandle, path: &str) -> Option<Vec<u8>> {
        let dev_url = app.config().build.dev_url.clone()?;
        let host = dev_url.host_str()?.to_string();
        if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1") {
            return None;
        }
        let port = dev_url.port_or_known_default()?;
        let mut upstream = TcpStream::connect((host.as_str(), port)).ok()?;
        upstream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .ok()?;
        let request = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
        upstream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::new();
        upstream.read_to_end(&mut response).ok()?;
        if response.is_empty() {
            return None;
        }
        Some(response)
    }

    fn serve_static(stream: &mut TcpStream, app: &tauri::AppHandle, path: &str) {
        let Some(relative) = sanitize_asset_path(path) else {
            write_response(stream, "404 Not Found", "text/plain; charset=utf-8", b"Not found.");
            return;
        };
        if let Some(bytes) = asset_bytes(app, &relative) {
            write_response(stream, "200 OK", content_type_for(&relative), &bytes);
            return;
        }
        if let Some(raw) = proxy_dev_server(app, path) {
            // The dev server response is already a complete HTTP response.
            let _ = stream.write_all(&raw);
            return;
        }
        let message = format!(
            "The Auri UI asset `{relative}` is not available. Build the frontend (npm run build:web) or set AURI_UI_DIST to the dist directory."
        );
        write_response(stream, "404 Not Found", "text/plain; charset=utf-8", message.as_bytes());
    }

    fn string_arg(args: &Value, key: &str) -> Result<String, String> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("The {key} argument is missing."))
    }

    fn opt_string_arg(args: &Value, key: &str) -> Option<String> {
        args.get(key).and_then(Value::as_str).map(str::to_string)
    }

    fn u64_arg(args: &Value, key: &str) -> Result<u64, String> {
        args.get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("The {key} argument is missing."))
    }

    fn u16_arg(args: &Value, key: &str) -> Result<u16, String> {
        u64_arg(args, key)?
            .try_into()
            .map_err(|_| format!("The {key} argument is out of range."))
    }

    fn u32_arg(args: &Value, key: &str) -> Result<u32, String> {
        u64_arg(args, key)?
            .try_into()
            .map_err(|_| format!("The {key} argument is out of range."))
    }

    fn i32_arg(args: &Value, key: &str) -> Result<i32, String> {
        args.get(key)
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| format!("The {key} argument is missing."))
    }

    fn bool_arg(args: &Value, key: &str) -> bool {
        args.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    fn to_json<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
        result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
    }

    fn plain_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|error| error.to_string())
    }

    /// Route a bridged invoke to the same command functions the desktop
    /// window calls. Desktop-window-only commands stay honestly unsupported.
    fn dispatch(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, String> {
        use tauri::async_runtime::block_on;
        match command {
            "initialize_workspace" => to_json(crate::initialize_workspace()),
            "list_directory" => to_json(crate::list_directory(string_arg(args, "path")?)),
            "inspect_file" => to_json(crate::inspect_file(string_arg(args, "path")?)),
            "create_file" => to_json(crate::create_file(
                string_arg(args, "directory")?,
                string_arg(args, "name")?,
            )),
            "create_folder" => to_json(crate::create_folder(
                string_arg(args, "directory")?,
                string_arg(args, "name")?,
            )),
            "folder_info" => to_json(block_on(crate::folder_info(string_arg(args, "path")?))),
            "read_text_file" => to_json(crate::read_text_file(string_arg(args, "path")?)),
            "read_binary_file" => to_json(crate::read_binary_file(string_arg(args, "path")?)),
            "write_text_file" => to_json(crate::write_text_file(
                string_arg(args, "path")?,
                string_arg(args, "content")?,
            )),
            "convert_media_file" => to_json(block_on(crate::convert_media_file(
                string_arg(args, "path")?,
                string_arg(args, "format")?,
                args.get("bitrateKbps").and_then(Value::as_u64).map(|value| value as u32),
                args.get("sampleRate").and_then(Value::as_u64).map(|value| value as u32),
                opt_string_arg(args, "resolution"),
            ))),
            "save_converted_media_file" => to_json(block_on(crate::save_converted_media_file(
                string_arg(args, "sourcePath")?,
                string_arg(args, "tempPath")?,
                string_arg(args, "name")?,
            ))),
            "run_command" => to_json(block_on(crate::run_command(
                string_arg(args, "command")?,
                string_arg(args, "cwd")?,
            ))),
            "terminal_start" => to_json(crate::terminal_start(
                app.clone(),
                string_arg(args, "sessionId")?,
                string_arg(args, "cwd")?,
                u16_arg(args, "cols")?,
                u16_arg(args, "rows")?,
            )),
            "terminal_write" => {
                let data: Vec<u8> = args
                    .get("data")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| format!("The data argument is invalid: {error}"))?
                    .ok_or("The data argument is missing.")?;
                to_json(crate::terminal_write(string_arg(args, "sessionId")?, data))
            }
            "terminal_cwd" => to_json(crate::terminal_cwd(string_arg(args, "sessionId")?)),
            "terminal_busy" => to_json(crate::terminal_busy(string_arg(args, "sessionId")?)),
            "terminal_resize" => to_json(crate::terminal_resize(
                string_arg(args, "sessionId")?,
                u16_arg(args, "cols")?,
                u16_arg(args, "rows")?,
            )),
            "terminal_stop" => to_json(crate::terminal_stop(string_arg(args, "sessionId")?)),
            "capture_screenshot" => to_json(crate::capture_screenshot()),
            "media_permission_status" => plain_json(crate::media_permission_status()),
            "request_media_permission" => to_json(block_on(crate::request_media_permission(
                string_arg(args, "permission")?,
            ))),
            "read_clipboard_history" => to_json(block_on(crate::read_clipboard_history())),
            "set_clipboard_text" => to_json(block_on(crate::set_clipboard_text(string_arg(args, "text")?))),
            "paste_clipboard_entry" => to_json(block_on(crate::paste_clipboard_entry(string_arg(args, "id")?))),
            "set_clipboard_pinned" => to_json(crate::set_clipboard_pinned(
                string_arg(args, "id")?,
                bool_arg(args, "pinned"),
            )),
            "remove_clipboard_entry" => to_json(crate::remove_clipboard_entry(string_arg(args, "id")?)),
            "update_clipboard_entry" => to_json(crate::update_clipboard_entry(
                string_arg(args, "id")?,
                string_arg(args, "text")?,
            )),
            "copy_clipboard_entry" => to_json(crate::copy_clipboard_entry(string_arg(args, "id")?)),
            "fileserver_start" => to_json(crate::fileserver_start()),
            "read_shell_history" => to_json(crate::read_shell_history()),
            "system_snapshot" => to_json(block_on(crate::system_snapshot(
                tauri::Manager::state(app),
                args.get("includeGpus").and_then(Value::as_bool),
            ))),
            "search_path_commands" => plain_json(crate::search_path_commands(string_arg(args, "query")?)),
            "kill_process" => to_json(block_on(crate::kill_process(u32_arg(args, "pid")?))),
            "set_process_priority" => to_json(block_on(crate::set_process_priority(
                u32_arg(args, "pid")?,
                i32_arg(args, "nice")?,
            ))),
            "set_process_priority_privileged" => to_json(block_on(crate::set_process_priority_privileged(
                u32_arg(args, "pid")?,
                i32_arg(args, "nice")?,
                string_arg(args, "password")?,
                string_arg(args, "method")?,
            ))),
            "cloudflared_status" => to_json(block_on(crate::cloudflared_status())),
            "cloudflared_start_tunnel" => to_json(block_on(crate::cloudflared_start_tunnel(
                tauri::Manager::state(app),
                u16_arg(args, "port")?,
                bool_arg(args, "installIfMissing"),
            ))),
            "cloudflared_active_tunnels" => {
                to_json(block_on(crate::cloudflared_active_tunnels(tauri::Manager::state(app))))
            }
            "cloudflared_stop_tunnel" => to_json(block_on(crate::cloudflared_stop_tunnel(
                tauri::Manager::state(app),
                u16_arg(args, "port")?,
            ))),
            "save_settings" => to_json(crate::save_settings(
                args.get("settings").cloned().ok_or("The settings argument is missing.")?,
            )),
            "save_media_file" => to_json(crate::save_media_file(
                string_arg(args, "name")?,
                string_arg(args, "kind")?,
                string_arg(args, "base64")?,
            )),
            "open_external" => to_json(crate::open_external(string_arg(args, "path")?)),
            "open_external_url" => to_json(crate::open_external_url(string_arg(args, "url")?)),
            "serve_ui" => Ok(json!({
                "url": current_url().unwrap_or_else(|| format!("http://127.0.0.1:{UI_PORT}")),
                "port": UI_PORT,
            })),
            // The desktop window owns Finder-opened files and the mirrored
            // app-state snapshot; the browser session must not take either.
            "take_pending_open_files" => Ok(json!([])),
            "sync_app_state" => Err(
                "The desktop app window owns the published app state; the browser session does not overwrite it."
                    .to_string(),
            ),
            "app_exit" => Err("Quit Auri from the desktop app or with `auri stop`.".to_string()),
            _ => Err(format!(
                "`{command}` controls the desktop window and is unavailable in the browser session."
            )),
        }
    }
}

#[cfg(all(unix, not(test)))]
pub use server::ensure_started;

#[cfg(all(not(unix), not(test)))]
pub fn ensure_started<T>(_app: T) -> Result<String, String> {
    Err("The Auri UI web server currently supports macOS and Linux.".to_string())
}

#[cfg(test)]
pub fn ensure_started<T>(_app: T) -> Result<String, String> {
    Ok(format!("http://127.0.0.1:{UI_PORT}"))
}
