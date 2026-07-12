//! Minimal local HTTP server that exposes a folder to the built-in web file
//! viewer. One read-mostly server is started with Auri, bound only to the
//! loopback interface on a fixed port. Its URL path maps from the filesystem
//! root so HTML documents can resolve sibling assets naturally. `localhost`
//! is a potentially trustworthy origin under the Secure Contexts standard.
//! Routes:
//!
//! - `GET /` or `GET /view?file=<rel>` — the embedded viewer web app
//! - `GET /<absolute-path>`            — file bytes for direct HTML/resource navigation
//! - `GET /raw/<rel>`                  — file bytes (single-range requests supported)
//! - `GET /api/list?path=<rel>`        — JSON folder listing
//! - `POST /api/save?file=<rel>`       — replace a text file with the request body
//! - `POST /api/save-b64?file=<rel>`   — write binary content from a base64 body

use super::util::{decode_base64, file_kind, mime_type};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static SERVER: Lazy<Mutex<Option<u16>>> = Lazy::new(Default::default);

const VIEWER_HTML: &str = include_str!("viewer.html");
const THREE_VIEWER_JS: &str = include_str!("three-viewer.js");
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const PORT: u16 = 8890;

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
    let listener = TcpListener::bind("127.0.0.1:8890").map_err(|error| {
        format!("Could not start Auri's file server on localhost:{PORT}: {error}")
    })?;
    *server = Some(PORT);
    let thread_root = root.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = thread_root.clone();
            std::thread::spawn(move || {
                let _ = handle_connection(stream, &root);
            });
        }
    });
    Ok(ServerInfo {
        root: root.to_string_lossy().into_owned(),
        port: PORT,
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
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

/// Resolve a relative request path inside the served root, rejecting
/// traversal outside it. `must_exist` controls canonicalization of the leaf.
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

fn write_error(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": message }).to_string();
    write_response(stream, status, "application/json", &[], body.as_bytes())
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
        return write_response(
            stream,
            "206 Partial Content",
            mime,
            &[
                format!("Content-Range: bytes {start}-{end}/{size}"),
                "Accept-Ranges: bytes".to_string(),
            ],
            &body,
        );
    }
    let mut body = Vec::new();
    if file.read_to_end(&mut body).is_err() {
        return write_error(
            stream,
            "500 Internal Server Error",
            "Could not read the file.",
        );
    }
    write_response(
        stream,
        "200 OK",
        mime,
        &["Accept-Ranges: bytes".to_string()],
        &body,
    )
}

fn list_directory(stream: &mut TcpStream, path: &Path) -> std::io::Result<()> {
    let Ok(reader) = fs::read_dir(path) else {
        return write_error(stream, "404 Not Found", "Folder was not found.");
    };
    let mut entries: Vec<ListEntry> = reader
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
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
    let body = serde_json::to_vec(&entries).unwrap_or_else(|_| b"[]".to_vec());
    write_response(stream, "200 OK", "application/json", &[], &body)
}

fn handle_connection(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
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
        if decoded_path == "/" || decoded_path == "/view" {
            return write_response(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                &[],
                VIEWER_HTML.as_bytes(),
            );
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
        if decoded_path == "/api/list" {
            let relative = query_param(query, "path").unwrap_or_default();
            return match resolve(root, &relative, true) {
                Ok(path) if path.is_dir() => list_directory(&mut stream, &path),
                Ok(_) => write_error(&mut stream, "400 Bad Request", "Not a folder."),
                Err(message) => write_error(&mut stream, "404 Not Found", &message),
            };
        }
        if decoded_path != "/view" {
            return match resolve(root, &decoded_path, true) {
                Ok(path) if path.is_file() => {
                    serve_file(&mut stream, &path, range_header.as_deref())
                }
                Ok(path) if path.is_dir() && path.join("index.html").is_file() => serve_file(
                    &mut stream,
                    &path.join("index.html"),
                    range_header.as_deref(),
                ),
                Ok(_) => write_error(&mut stream, "400 Bad Request", "Not a file."),
                Err(message) => write_error(&mut stream, "404 Not Found", &message),
            };
        }
        return write_error(&mut stream, "404 Not Found", "Unknown route.");
    }

    if method == "POST" {
        if origin_header.as_deref() != Some("http://localhost:8890") {
            return write_error(
                &mut stream,
                "403 Forbidden",
                "File changes require Auri's local viewer origin.",
            );
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
}
