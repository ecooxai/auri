//! Loopback-only cloud-disk file server used by Auri's native file web app.
//!
//! Routes:
//! - `GET /path/to/file`             — raw file bytes (including range requests)
//! - `GET /path/to/file?view=1`      — viewer app for a file
//! - `GET /path/to/file?edit=1`      — editor app for a file
//! - `GET /path/to/folder`           — folder browser app
//! - `GET /api/meta?path=<path>`     — file or folder metadata
//! - `GET /api/list?path=<path>`     — folder entries
//! - `GET /api/blend-preview?file=…` — cached Blender-to-GLB preview
//! - `POST /api/save?file=<path>`    — save UTF-8 text
//! - `POST /api/save-b64?file=<path>`— save base64 binary content
//! - `POST /api/convert?...`         — native ffmpeg conversion and final save

use super::files;
use super::util::{decode_base64, default_file_server_port, file_kind, mime_type};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

static SERVER: Lazy<Mutex<Option<u16>>> = Lazy::new(Default::default);
static BLEND_EXPORT_LOCK: Lazy<Mutex<()>> = Lazy::new(Default::default);

const VIEWER_HTML: &str = include_str!("viewer.html");
const THREE_VIEWER_JS: &str = include_str!("three-viewer.js");
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const PORT: u16 = default_file_server_port(cfg!(debug_assertions));
const PORT_SEARCH_LIMIT: u16 = 100;
const BLEND_EXPORT_TIMEOUT: Duration = Duration::from_secs(180);
const HTML_PERMISSIONS_POLICY: &str = "accelerometer=(self), autoplay=(self), camera=(self), clipboard-read=(self), clipboard-write=(self), display-capture=(self), encrypted-media=(self), fullscreen=(self), geolocation=(self), gyroscope=(self), hid=(self), magnetometer=(self), microphone=(self), midi=(self), payment=(self), picture-in-picture=(self), publickey-credentials-get=(self), screen-wake-lock=(self), serial=(self), usb=(self), web-share=(self), xr-spatial-tracking=(self)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub root: String,
    pub port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListEntry {
    name: String,
    kind: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathMetadata {
    name: String,
    kind: String,
    mime: String,
    size: u64,
    is_directory: bool,
}

fn listener_pids(port: u16) -> Vec<u32> {
    let output = Command::new("lsof")
        .args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

fn process_command(pid: u32) -> String {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn is_dev_listener_command(command: &str) -> bool {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();
    !normalized.contains("/applications/auri.app/")
        && !normalized.contains("/usr/bin/auri")
        && (normalized.contains("/target/debug/")
            || normalized.contains("cargo tauri dev")
            || normalized.contains("native-dev.mjs")
            || normalized.contains("native-watch"))
}

/// Stop only an identifiable development listener. Packaged/release Auri
/// processes and unrelated programs are deliberately left untouched.
fn try_stop_conflicting_dev_listener(port: u16) -> bool {
    let mut stopped = false;
    for pid in listener_pids(port) {
        let command = process_command(pid);
        if !is_dev_listener_command(&command) {
            continue;
        }
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        stopped |= status.map(|value| value.success()).unwrap_or(false);
    }
    stopped
}

fn bind_listener() -> Result<(TcpListener, u16), String> {
    let preferred = format!("127.0.0.1:{PORT}");
    match TcpListener::bind(&preferred) {
        Ok(listener) => return Ok((listener, PORT)),
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            if try_stop_conflicting_dev_listener(PORT) {
                std::thread::sleep(Duration::from_millis(300));
                if let Ok(listener) = TcpListener::bind(&preferred) {
                    return Ok((listener, PORT));
                }
            }
        }
        Err(_) => {}
    }

    for offset in 1..=PORT_SEARCH_LIMIT {
        let port = PORT + offset;
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((listener, port));
        }
    }
    Err(format!(
        "Could not start Auri's file server on localhost ports {PORT}-{}.",
        PORT + PORT_SEARCH_LIMIT
    ))
}

pub fn start() -> Result<ServerInfo, String> {
    let root = Path::new("/")
        .canonicalize()
        .map_err(|error| format!("Could not resolve the filesystem root: {error}"))?;
    let mut server = SERVER
        .lock()
        .map_err(|_| "Server registry is busy.".to_string())?;
    if let Some(port) = *server {
        return Ok(ServerInfo {
            root: root.to_string_lossy().into_owned(),
            port,
        });
    }

    let (listener, port) = bind_listener()?;
    *server = Some(port);
    let thread_root = root.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = thread_root.clone();
            std::thread::spawn(move || {
                let _ = handle_connection(stream, &root, port);
            });
        }
    });
    Ok(ServerInfo {
        root: root.to_string_lossy().into_owned(),
        port,
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    output.push(byte);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| percent_decode(value))
    })
}

fn query_has(query: &str, name: &str) -> bool {
    query
        .split('&')
        .any(|pair| pair.split_once('=').map(|(key, _)| key).unwrap_or(pair) == name)
}

/// Resolve a relative request path inside the served root, rejecting traversal.
fn resolve(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, String> {
    let cleaned = relative.trim_start_matches('/');
    if cleaned.split('/').any(|part| part == "..") {
        return Err("Path traversal is not allowed.".to_string());
    }
    let joined = root.join(cleaned);
    if must_exist {
        let canonical = joined
            .canonicalize()
            .map_err(|_| "File was not found.".to_string())?;
        if !canonical.starts_with(root) {
            return Err("Path is outside the served folder.".to_string());
        }
        Ok(canonical)
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| "Invalid path.".to_string())?
            .canonicalize()
            .map_err(|_| "Folder was not found.".to_string())?;
        if !parent.starts_with(root) {
            return Err("Path is outside the served folder.".to_string());
        }
        Ok(parent.join(
            joined
                .file_name()
                .ok_or_else(|| "Invalid file name.".to_string())?,
        ))
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    extra_headers: &[String],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        body.len()
    );
    for header in extra_headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_json<T: Serialize>(stream: &mut TcpStream, value: &T) -> std::io::Result<()> {
    match serde_json::to_vec(value) {
        Ok(body) => write_response(stream, "200 OK", "application/json", &[], &body),
        Err(_) => write_error(
            stream,
            "500 Internal Server Error",
            "Could not encode the response.",
        ),
    }
}

fn write_error(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": message }).to_string();
    write_response(stream, status, "application/json", &[], body.as_bytes())
}

fn html_permission_header() -> String {
    format!("Permissions-Policy: {HTML_PERMISSIONS_POLICY}")
}

fn blender_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("AURI_BLENDER") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(output) = Command::new("which").arg("blender").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                candidates.push(PathBuf::from(path));
            }
        }
    }
    candidates.extend([
        PathBuf::from("/Applications/Blender.app/Contents/MacOS/Blender"),
        PathBuf::from("/usr/bin/blender"),
        PathBuf::from("/usr/local/bin/blender"),
        PathBuf::from("/snap/bin/blender"),
    ]);
    let mut unique = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|path| path.is_file() && unique.insert(path.clone()))
        .collect()
}

fn blend_preview_cache_path(source: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("Could not inspect the Blender file: {error}"))?;
    let modified = metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    let directory = std::env::temp_dir().join("auri-blend-previews");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the Blender preview cache: {error}"))?;
    Ok(directory.join(format!("{:016x}.glb", hasher.finish())))
}

fn run_blender_export(source: &Path, output: &Path) -> Result<(), String> {
    let candidates = blender_executable_candidates();
    if candidates.is_empty() {
        return Err(
            "Blender is required to preview .blend files. Install Blender or set AURI_BLENDER to its executable."
                .to_string(),
        );
    }
    let output_literal = serde_json::to_string(&output.to_string_lossy())
        .map_err(|error| format!("Could not prepare the Blender export path: {error}"))?;
    let script = format!(
        "import bpy; bpy.ops.export_scene.gltf(filepath={output_literal}, export_format='GLB', export_apply=True)"
    );
    let executable = &candidates[0];
    let mut child = Command::new(executable)
        .arg("--background")
        .arg("--disable-autoexec")
        .arg(source)
        .arg("--python-expr")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start Blender at {}: {error}",
                executable.display()
            )
        })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "Blender could not export this file (exit status {status})."
                ));
            }
            Ok(None) if started.elapsed() < BLEND_EXPORT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Blender preview conversion timed out after 180 seconds.".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Could not wait for Blender preview conversion: {error}"
                ));
            }
        }
    }
}

fn ensure_blend_preview(source: &Path) -> Result<PathBuf, String> {
    if source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("blend".to_string())
    {
        return Err("Choose a .blend file.".to_string());
    }
    let output = blend_preview_cache_path(source)?;
    if fs::metadata(&output)
        .map(|value| value.len() > 20)
        .unwrap_or(false)
    {
        return Ok(output);
    }
    let _guard = BLEND_EXPORT_LOCK
        .lock()
        .map_err(|_| "Blender preview conversion is busy.".to_string())?;
    if fs::metadata(&output)
        .map(|value| value.len() > 20)
        .unwrap_or(false)
    {
        return Ok(output);
    }
    let _ = fs::remove_file(&output);
    run_blender_export(source, &output)?;
    if !fs::metadata(&output)
        .map(|value| value.len() > 20)
        .unwrap_or(false)
    {
        return Err("Blender finished without creating a usable GLB preview.".to_string());
    }
    Ok(output)
}

fn handle_blend_preview(
    stream: &mut TcpStream,
    root: &Path,
    query: &str,
    range: Option<&str>,
) -> std::io::Result<()> {
    let Some(relative) = query_param(query, "file") else {
        return write_error(stream, "400 Bad Request", "Choose a .blend file.");
    };
    let source = match resolve(root, &relative, true) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return write_error(stream, "400 Bad Request", "Not a file."),
        Err(message) => return write_error(stream, "404 Not Found", &message),
    };
    match ensure_blend_preview(&source) {
        Ok(preview) => serve_file(stream, &preview, range),
        Err(message) => write_error(stream, "503 Service Unavailable", &message),
    }
}

fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (start_text, end_text) = spec.split_once('-')?;
    if start_text.is_empty() {
        let suffix: u64 = end_text.parse().ok()?;
        if suffix == 0 || size == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = start_text.parse().ok()?;
    let end = if end_text.is_empty() {
        size.saturating_sub(1)
    } else {
        end_text.parse().ok()?
    };
    (start <= end && start < size).then(|| (start, end.min(size.saturating_sub(1))))
}

fn serve_file(stream: &mut TcpStream, path: &Path, range: Option<&str>) -> std::io::Result<()> {
    let display = path.to_string_lossy();
    let mime = mime_type(&display);
    let Ok(mut file) = fs::File::open(path) else {
        return write_error(stream, "404 Not Found", "File was not found.");
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if let Some((start, end)) = range.and_then(|header| parse_range(header, size)) {
        let length = end - start + 1;
        let mut body = vec![0_u8; length as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
            return write_error(
                stream,
                "500 Internal Server Error",
                "Could not read the file.",
            );
        }
        let mut headers = vec![
            format!("Content-Range: bytes {start}-{end}/{size}"),
            "Accept-Ranges: bytes".to_string(),
        ];
        if mime == "text/html" {
            headers.push(html_permission_header());
        }
        return write_response(stream, "206 Partial Content", mime, &headers, &body);
    }
    let mut body = Vec::new();
    if file.read_to_end(&mut body).is_err() {
        return write_error(
            stream,
            "500 Internal Server Error",
            "Could not read the file.",
        );
    }
    let mut headers = vec!["Accept-Ranges: bytes".to_string()];
    if mime == "text/html" {
        headers.push(html_permission_header());
    }
    write_response(stream, "200 OK", mime, &headers, &body)
}

fn list_directory(stream: &mut TcpStream, path: &Path) -> std::io::Result<()> {
    let Ok(reader) = fs::read_dir(path) else {
        return write_error(stream, "404 Not Found", "Folder was not found.");
    };
    let mut entries: Vec<ListEntry> = reader
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry.metadata().ok()?;
            Some(ListEntry {
                kind: if metadata.is_dir() {
                    "directory".to_string()
                } else {
                    file_kind(&name).to_string()
                },
                size: metadata.len(),
                name,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "directory";
        let b_dir = b.kind == "directory";
        b_dir
            .cmp(&a_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    write_json(stream, &entries)
}

fn path_metadata(stream: &mut TcpStream, path: &Path) -> std::io::Result<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return write_error(stream, "404 Not Found", "Path was not found.");
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Files")
        .to_string();
    let is_directory = metadata.is_dir();
    let display = path.to_string_lossy();
    write_json(
        stream,
        &PathMetadata {
            name,
            kind: if is_directory {
                "directory".to_string()
            } else {
                file_kind(&display).to_string()
            },
            mime: if is_directory {
                "inode/directory".to_string()
            } else {
                mime_type(&display).to_string()
            },
            size: metadata.len(),
            is_directory,
        },
    )
}

fn valid_origin(origin: Option<&str>, port: u16) -> bool {
    matches!(
        origin,
        Some(value)
            if value == format!("http://localhost:{port}")
                || value == format!("http://127.0.0.1:{port}")
    )
}

fn handle_conversion(stream: &mut TcpStream, root: &Path, query: &str) -> std::io::Result<()> {
    let Some(relative) = query_param(query, "file") else {
        return write_error(stream, "400 Bad Request", "Choose a media file.");
    };
    let Some(format) = query_param(query, "format") else {
        return write_error(stream, "400 Bad Request", "Choose a conversion format.");
    };
    let source = match resolve(root, &relative, true) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return write_error(stream, "400 Bad Request", "Not a file."),
        Err(message) => return write_error(stream, "404 Not Found", &message),
    };
    let bitrate = query_param(query, "bitrateKbps").and_then(|value| value.parse::<u32>().ok());
    let sample_rate = query_param(query, "sampleRate").and_then(|value| value.parse::<u32>().ok());
    let resolution = query_param(query, "resolution");
    let source_text = source.to_string_lossy().into_owned();
    let converted = match files::convert_media_file(
        &source_text,
        &format,
        bitrate,
        sample_rate,
        resolution.as_deref(),
    ) {
        Ok(value) => value,
        Err(message) => return write_error(stream, "400 Bad Request", &message),
    };
    let requested_name = query_param(query, "name").unwrap_or_else(|| converted.name.clone());
    match files::save_converted_media_file(&source_text, &converted.path, &requested_name) {
        Ok(value) => write_json(stream, &value),
        Err(message) => write_error(stream, "400 Bad Request", &message),
    }
}

fn handle_connection(mut stream: TcpStream, root: &Path, port: u16) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut content_length = 0_usize;
    let mut range_header: Option<String> = None;
    let mut origin_header: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            match name.to_ascii_lowercase().as_str() {
                "content-length" => content_length = value.trim().parse().unwrap_or(0),
                "range" => range_header = Some(value.trim().to_string()),
                "origin" => origin_header = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }

    let (path_part, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let decoded_path = percent_decode(path_part);

    if method == "GET" {
        if decoded_path == "/three-viewer.js" {
            return write_response(
                &mut stream,
                "200 OK",
                "text/javascript; charset=utf-8",
                &[],
                THREE_VIEWER_JS.as_bytes(),
            );
        }
        if decoded_path == "/api/blend-preview" {
            return handle_blend_preview(&mut stream, root, query, range_header.as_deref());
        }
        if decoded_path == "/api/list" || decoded_path == "/api/meta" {
            let relative = query_param(query, "path").unwrap_or_default();
            return match resolve(root, &relative, true) {
                Ok(path) if decoded_path == "/api/list" && path.is_dir() => {
                    list_directory(&mut stream, &path)
                }
                Ok(path) if decoded_path == "/api/meta" => path_metadata(&mut stream, &path),
                Ok(_) => write_error(&mut stream, "400 Bad Request", "Not a folder."),
                Err(message) => write_error(&mut stream, "404 Not Found", &message),
            };
        }
        if let Some(relative) = decoded_path.strip_prefix("/raw/") {
            return match resolve(root, relative, true) {
                Ok(path) if path.is_file() => {
                    serve_file(&mut stream, &path, range_header.as_deref())
                }
                Ok(_) => write_error(&mut stream, "400 Bad Request", "Not a file."),
                Err(message) => write_error(&mut stream, "404 Not Found", &message),
            };
        }

        // Legacy links remain valid while all newly generated links use pathname
        // routing (`/file?view=1`).
        let legacy_file = (decoded_path == "/view")
            .then(|| query_param(query, "file"))
            .flatten()
            .unwrap_or_default();
        let requested = if decoded_path == "/view" {
            legacy_file.as_str()
        } else {
            decoded_path.as_str()
        };
        return match resolve(root, requested, true) {
            Ok(path)
                if path.is_dir()
                    || decoded_path == "/view"
                    || query_has(query, "view")
                    || query_has(query, "edit") =>
            {
                write_response(
                    &mut stream,
                    "200 OK",
                    "text/html; charset=utf-8",
                    &[html_permission_header()],
                    VIEWER_HTML.as_bytes(),
                )
            }
            Ok(path) if path.is_file() => serve_file(&mut stream, &path, range_header.as_deref()),
            Ok(_) => write_error(&mut stream, "400 Bad Request", "Unsupported path."),
            Err(message) => write_error(&mut stream, "404 Not Found", &message),
        };
    }

    if method == "POST" {
        if !valid_origin(origin_header.as_deref(), port) {
            return write_error(
                &mut stream,
                "403 Forbidden",
                "File changes require Auri's local viewer origin.",
            );
        }
        if decoded_path == "/api/convert" {
            return handle_conversion(&mut stream, root, query);
        }
        if content_length > MAX_BODY_BYTES {
            return write_error(
                &mut stream,
                "413 Payload Too Large",
                "The upload is too large.",
            );
        }
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body)?;
        let Some(relative) = query_param(query, "file") else {
            return write_error(&mut stream, "400 Bad Request", "Choose a file.");
        };
        let save = |bytes: &[u8]| -> Result<(), String> {
            let path = resolve(root, &relative, false)?;
            fs::write(&path, bytes).map_err(|error| error.to_string())
        };
        let result = match decoded_path.as_str() {
            "/api/save" => save(&body),
            "/api/save-b64" => {
                let text = String::from_utf8_lossy(&body);
                decode_base64(text.trim()).and_then(|bytes| save(&bytes))
            }
            _ => Err("Unknown route.".to_string()),
        };
        return match result {
            Ok(()) => write_response(
                &mut stream,
                "200 OK",
                "application/json",
                &[],
                b"{\"ok\":true}",
            ),
            Err(message) => write_error(&mut stream, "400 Bad Request", &message),
        };
    }

    write_error(&mut stream, "405 Method Not Allowed", "Unsupported method.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing_supports_open_closed_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=200-", 1000), Some((200, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=999-", 1000), Some((999, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("nonsense", 1000), None);
    }

    #[test]
    fn resolve_rejects_traversal_outside_the_root() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        assert!(resolve(&root, "../etc/passwd", false).is_err());
        assert!(resolve(&root, "a/../../etc/passwd", false).is_err());
    }

    #[test]
    fn percent_decoding_handles_utf8_and_plus() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
        assert_eq!(percent_decode("%E4%BD%A0%E5%A5%BD"), "你好");
    }

    #[test]
    fn query_flags_support_bare_and_assigned_forms() {
        assert!(query_has("view", "view"));
        assert!(query_has("view=1&x=y", "view"));
        assert!(query_has("edit=1", "edit"));
        assert!(!query_has("preview=1", "view"));
    }

    #[test]
    fn release_commands_are_never_classified_as_dev_listeners() {
        assert!(!is_dev_listener_command(
            "/Applications/Auri.app/Contents/MacOS/auri-desktop"
        ));
        assert!(is_dev_listener_command(
            "/workspace/src-tauri/target/debug/auri-desktop"
        ));
    }

    #[test]
    fn listener_binding_uses_the_preferred_or_a_bounded_fallback_port() {
        let (listener, port) = bind_listener().expect("bind loopback file server");
        assert!((PORT..=PORT + PORT_SEARCH_LIMIT).contains(&port));
        drop(listener);
    }
}
