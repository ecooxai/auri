#[cfg(unix)]
use super::workspace::home_dir;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tauri::Emitter;

const MAX_COMMAND_BYTES: u64 = 64 * 1024;

#[cfg(unix)]
pub fn socket_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".config")
        .join("auri")
        .join("command.sock"))
}

#[cfg(unix)]
pub fn start_command_server(app: tauri::AppHandle) -> Result<(), String> {
    let path = socket_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            return Err("Another Auri command server is already running.".to_string());
        }
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
    Ok(())
}

#[cfg(unix)]
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
            let command = command.trim();
            if command.is_empty() {
                return Err("Command is empty.".to_string());
            }
            let _ = super::lifecycle::reveal_main_window(&app);
            app.emit("auri-command", command.to_string())
                .map_err(|error| error.to_string())
        });

    let response = match result {
        Ok(()) => "ok\n".to_string(),
        Err(error) => format!("error:{error}\n"),
    };
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(not(unix))]
pub fn start_command_server(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The external Auri command bridge currently supports macOS and Linux.".to_string())
}
