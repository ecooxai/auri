#[cfg(all(unix, not(test)))]
use super::workspace::home_dir;
#[cfg(all(unix, not(test)))]
use std::fs;
#[cfg(all(unix, not(test)))]
use std::io::{Read, Write};
#[cfg(all(unix, not(test)))]
use std::os::unix::fs::PermissionsExt;
#[cfg(all(unix, not(test)))]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(all(unix, not(test)))]
use std::path::PathBuf;
#[cfg(all(unix, not(test)))]
use std::thread;
#[cfg(all(unix, not(test)))]
use std::time::Duration;
#[cfg(all(unix, not(test)))]
use tauri::Emitter;

#[cfg(not(test))]
const MAX_COMMAND_BYTES: usize = 64 * 1024;
pub const FOCUS_REQUEST: &str = "__auri_focus__";
pub const STATE_REQUEST: &str = "__auri_state__";
pub const WATCH_REQUEST: &str = "__auri_watch__";
pub const QUIET_PREFIX: &str = "__auri_quiet__:";
pub const ATTACH_PREFIX: &str = "__auri_term_attach__:";
pub const COPY_PREFIX: &str = "__auri_copy__:";
pub const SERVE_UI_REQUEST: &str = "__auri_serve_ui__";
pub const QUIT_REQUEST: &str = "__auri_quit__";
pub const APP_INFO_REQUEST: &str = "__auri_appinfo__";

#[derive(Debug, PartialEq, Eq)]
pub enum IncomingRequest<'a> {
    Focus,
    Command(&'a str),
    /// A command from the CLI/TUI that must not steal focus to the GUI window.
    QuietCommand(&'a str),
    /// One-shot read of the latest app-state snapshot JSON.
    StateGet,
    /// Long-lived stream of app-state snapshot JSON lines.
    StateWatch,
    /// Bidirectional raw byte bridge onto a running PTY session.
    TerminalAttach(&'a str),
    /// Copy base64-encoded UTF-8 text to the system clipboard. Base64 keeps
    /// multi-line selections inside the line-framed protocol.
    CopyText(&'a str),
    /// Start (or reuse) the local UI web server and reply with its URL.
    ServeUi,
    /// Quit the app after acknowledging (`auri stop`).
    Quit,
    /// Reply with this instance's pid and executable path (`auri restart`).
    AppInfo,
}

pub fn parse_request(input: &str) -> Result<IncomingRequest<'_>, String> {
    let request = input.trim();
    if request.is_empty() {
        return Err("Command is empty.".to_string());
    }
    if request == FOCUS_REQUEST {
        return Ok(IncomingRequest::Focus);
    }
    if request == STATE_REQUEST {
        return Ok(IncomingRequest::StateGet);
    }
    if request == WATCH_REQUEST {
        return Ok(IncomingRequest::StateWatch);
    }
    if let Some(command) = request.strip_prefix(QUIET_PREFIX) {
        let command = command.trim();
        if command.is_empty() {
            return Err("Command is empty.".to_string());
        }
        return Ok(IncomingRequest::QuietCommand(command));
    }
    if let Some(session) = request.strip_prefix(ATTACH_PREFIX) {
        let session = session.trim();
        if session.is_empty() {
            return Err("Terminal session id is empty.".to_string());
        }
        return Ok(IncomingRequest::TerminalAttach(session));
    }
    if let Some(encoded) = request.strip_prefix(COPY_PREFIX) {
        let encoded = encoded.trim();
        if encoded.is_empty() {
            return Err("Copy payload is empty.".to_string());
        }
        return Ok(IncomingRequest::CopyText(encoded));
    }
    if request == SERVE_UI_REQUEST {
        return Ok(IncomingRequest::ServeUi);
    }
    if request == QUIT_REQUEST {
        return Ok(IncomingRequest::Quit);
    }
    if request == APP_INFO_REQUEST {
        return Ok(IncomingRequest::AppInfo);
    }
    Ok(IncomingRequest::Command(request))
}

pub fn socket_file_name(pid: u32) -> String {
    format!("command-{pid}.sock")
}

#[cfg(all(unix, not(test)))]
pub fn socket_directory() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".config").join("auri").join("instances"))
}

#[cfg(all(unix, not(test)))]
pub fn socket_path() -> Result<PathBuf, String> {
    Ok(socket_directory()?.join(socket_file_name(std::process::id())))
}

#[cfg(all(unix, not(test)))]
pub struct CommandServer {
    path: PathBuf,
}

#[cfg(all(unix, not(test)))]
impl Drop for CommandServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Remove instance sockets left behind by Auri processes that exited without
/// their `Drop` cleanup. A socket nothing listens on refuses the connection
/// immediately, so sweeping the directory stays cheap.
#[cfg(all(unix, not(test)))]
fn sweep_stale_sockets(directory: &std::path::Path, own_path: &std::path::Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == own_path {
            continue;
        }
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if !name.starts_with("command-") || !name.ends_with(".sock") {
            continue;
        }
        if UnixStream::connect(&path).is_err() {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(all(unix, not(test)))]
pub fn start_command_server(app: tauri::AppHandle) -> Result<CommandServer, String> {
    let directory = socket_directory()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let path = socket_path()?;
    sweep_stale_sockets(&directory, &path);
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }

    let listener = UnixListener::bind(&path)
        .map_err(|error| format!("Could not bind Auri command socket: {error}"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;

    thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(stream) = connection else { continue };
            let app = app.clone();
            thread::spawn(move || handle_connection(stream, app));
        }
    });

    Ok(CommandServer { path })
}

/// Read the request line: bytes up to the first newline or EOF. Commands are
/// newline-free by construction, and streaming requests (watch/attach) send
/// their request as a terminated first line before any other traffic.
#[cfg(all(unix, not(test)))]
fn read_request_line(stream: &mut UnixStream) -> Result<String, String> {
    let mut request = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                request.push(byte[0]);
                if request.len() > MAX_COMMAND_BYTES {
                    return Err("Command exceeds the 64 KB limit.".to_string());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    String::from_utf8(request).map_err(|error| error.to_string())
}

#[cfg(all(unix, not(test)))]
fn respond_simple(mut stream: UnixStream, result: Result<(), String>) {
    let response = match result {
        Ok(()) => "ok\n".to_string(),
        Err(error) => format!("error:{error}\n"),
    };
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(all(unix, not(test)))]
fn emit_command(app: &tauri::AppHandle, command: &str) -> Result<(), String> {
    app.emit("auri-command", command.to_string())
        .map_err(|error| error.to_string())
}

/// Stream every new app-state snapshot as one JSON line. Idle seconds emit an
/// empty heartbeat line so a vanished client turns into a write error instead
/// of a leaked thread.
#[cfg(all(unix, not(test)))]
fn stream_state(mut stream: UnixStream) {
    let mut last_seq = 0_u64;
    loop {
        match super::state_sync::wait_for_newer(last_seq, Duration::from_secs(1)) {
            Some((seq, json)) => {
                last_seq = seq;
                if stream.write_all(json.as_bytes()).is_err() || stream.write_all(b"\n").is_err() {
                    return;
                }
            }
            None => {
                if stream.write_all(b"\n").is_err() {
                    return;
                }
            }
        }
    }
}

/// Raw byte bridge between an attach client and a running PTY session. Output
/// is mirrored to the GUI emulator and every attached client alike.
#[cfg(all(unix, not(test)))]
fn attach_terminal(mut stream: UnixStream, session_id: &str) {
    use std::net::Shutdown;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    if !super::terminal::exists(session_id) {
        let _ = stream.write_all(b"error:Terminal session is not running.\n");
        return;
    }
    let receiver = super::term_bridge::attach(session_id);
    if stream.write_all(b"ok\n").is_err() {
        return;
    }
    let _ = stream.set_read_timeout(None);
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };

    let detached = Arc::new(AtomicBool::new(false));
    let forward_detached = detached.clone();
    let forward = thread::spawn(move || {
        loop {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if forward_detached.load(Ordering::Relaxed) {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = writer.shutdown(Shutdown::Both);
    });

    let mut buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if super::terminal::write(session_id, &buffer[..count]).is_err() {
                    break;
                }
            }
        }
    }
    detached.store(true, Ordering::Relaxed);
    let _ = stream.shutdown(Shutdown::Both);
    let _ = forward.join();
}

#[cfg(all(unix, not(test)))]
fn handle_connection(mut stream: UnixStream, app: tauri::AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = match read_request_line(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = stream.write_all(format!("error:{error}\n").as_bytes());
            return;
        }
    };
    match parse_request(&request) {
        Ok(IncomingRequest::Focus) => {
            respond_simple(stream, super::lifecycle::reveal_main_window(&app));
        }
        Ok(IncomingRequest::Command(command)) => {
            let result =
                super::lifecycle::reveal_main_window(&app).and_then(|_| emit_command(&app, command));
            respond_simple(stream, result);
        }
        Ok(IncomingRequest::QuietCommand(command)) => {
            respond_simple(stream, emit_command(&app, command));
        }
        Ok(IncomingRequest::StateGet) => match super::state_sync::latest() {
            Some(json) => {
                let _ = stream.write_all(json.as_bytes());
                let _ = stream.write_all(b"\n");
            }
            None => {
                let _ = stream.write_all(b"error:No app state has been published yet.\n");
            }
        },
        Ok(IncomingRequest::StateWatch) => stream_state(stream),
        Ok(IncomingRequest::TerminalAttach(session_id)) => attach_terminal(stream, session_id),
        Ok(IncomingRequest::CopyText(encoded)) => {
            let result = super::util::decode_base64(encoded)
                .and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
                .and_then(|text| super::clipboard::set_text(&text));
            respond_simple(stream, result);
        }
        Ok(IncomingRequest::ServeUi) => match super::webserver::ensure_started(app.clone()) {
            Ok(url) => {
                let _ = stream.write_all(format!("ok:{url}\n").as_bytes());
            }
            Err(error) => {
                let _ = stream.write_all(format!("error:{error}\n").as_bytes());
            }
        },
        Ok(IncomingRequest::Quit) => {
            let _ = stream.write_all(b"ok\n");
            let _ = stream.flush();
            drop(stream);
            // app.exit ends the process before CommandServer::drop runs, so
            // remove the socket now instead of leaving a stale file.
            if let Ok(path) = socket_path() {
                let _ = fs::remove_file(path);
            }
            app.exit(0);
        }
        Ok(IncomingRequest::AppInfo) => {
            let executable = std::env::current_exe()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let reply = format!(
                "{{\"pid\":{},\"exe\":{}}}\n",
                std::process::id(),
                serde_json::Value::String(executable)
            );
            let _ = stream.write_all(reply.as_bytes());
        }
        Err(error) => {
            let _ = stream.write_all(format!("error:{error}\n").as_bytes());
        }
    }
}

#[cfg(all(not(unix), not(test)))]
pub struct CommandServer;

#[cfg(all(not(unix), not(test)))]
pub fn start_command_server(_app: tauri::AppHandle) -> Result<CommandServer, String> {
    Err("The external Auri command bridge currently supports macOS and Linux.".to_string())
}

#[cfg(test)]
pub struct CommandServer;

#[cfg(test)]
pub fn start_command_server<T>(_app: T) -> Result<CommandServer, String> {
    Ok(CommandServer)
}
