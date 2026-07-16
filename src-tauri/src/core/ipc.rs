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
const MAX_COMMAND_BYTES: u64 = 64 * 1024;
pub const FOCUS_REQUEST: &str = "__auri_focus__";

#[derive(Debug, PartialEq, Eq)]
pub enum IncomingRequest<'a> {
    Focus,
    Command(&'a str),
}

pub fn parse_request(input: &str) -> Result<IncomingRequest<'_>, String> {
    let request = input.trim();
    if request.is_empty() {
        return Err("Command is empty.".to_string());
    }
    if request == FOCUS_REQUEST {
        return Ok(IncomingRequest::Focus);
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

#[cfg(all(unix, not(test)))]
fn handle_connection(mut stream: UnixStream, app: tauri::AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut command = String::new();
    let result = std::io::Read::by_ref(&mut stream)
        .take(MAX_COMMAND_BYTES + 1)
        .read_to_string(&mut command)
        .map_err(|error| error.to_string())
        .and_then(|_| {
            if command.len() as u64 > MAX_COMMAND_BYTES {
                return Err("Command exceeds the 64 KB limit.".to_string());
            }
            match parse_request(&command)? {
                IncomingRequest::Focus => super::lifecycle::reveal_main_window(&app),
                IncomingRequest::Command(command) => {
                    super::lifecycle::reveal_main_window(&app)?;
                    app.emit("auri-command", command.to_string())
                        .map_err(|error| error.to_string())
                }
            }
        });

    let response = match result {
        Ok(()) => "ok\n".to_string(),
        Err(error) => format!("error:{error}\n"),
    };
    let _ = stream.write_all(response.as_bytes());
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
