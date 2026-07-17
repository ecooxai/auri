//! Socket client for the running Auri instance. Every interaction — one-shot
//! commands, quiet TUI commands, state reads, state watching, and terminal
//! attach — goes through the app's command socket; the CLI never reproduces
//! command behaviour locally.

use std::env;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FOCUS_REQUEST: &str = "__auri_focus__";
const QUIET_PREFIX: &str = "__auri_quiet__:";
const STATE_REQUEST: &str = "__auri_state__";
const WATCH_REQUEST: &str = "__auri_watch__";
const ATTACH_PREFIX: &str = "__auri_term_attach__:";

fn config_directory() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not available.".to_string())?;
    Ok(home.join(".config").join("auri"))
}

fn modified_time(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn command_socket_candidates() -> Result<Vec<PathBuf>, String> {
    if let Some(path) = env::var_os("AURI_COMMAND_SOCKET").filter(|value| !value.is_empty()) {
        return Ok(vec![PathBuf::from(path)]);
    }

    let config = config_directory()?;
    let instances = config.join("instances");
    let mut candidates = Vec::new();
    if let Ok(entries) = fs::read_dir(&instances) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if name.starts_with("command-") && name.ends_with(".sock") {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by_key(|path| std::cmp::Reverse(modified_time(path)));

    let legacy = config.join("command.sock");
    if legacy.exists() {
        candidates.push(legacy);
    }
    Ok(candidates)
}

pub fn connect_to_running_instance() -> Result<(UnixStream, PathBuf), String> {
    let candidates = command_socket_candidates()?;
    if candidates.is_empty() {
        return Err("No running Auri instances were found.".to_string());
    }

    let mut failures = Vec::new();
    for path in candidates {
        match UnixStream::connect(&path) {
            Ok(stream) => return Ok((stream, path)),
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }

    Err(format!(
        "Could not connect to any running Auri instance: {}",
        failures.join("; ")
    ))
}

/// Send one request line and read the whole response (the app closes the
/// connection after simple requests).
fn round_trip(request: &str, timeout: Duration) -> Result<String, String> {
    let (mut stream, path) = connect_to_running_instance()?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not write to {}: {error}", path.display()))?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(response.trim().to_string())
}

fn expect_ok(response: String) -> Result<(), String> {
    if response == "ok" {
        return Ok(());
    }
    Err(response
        .strip_prefix("error:")
        .unwrap_or(&response)
        .to_string())
}

/// Public one-shot command: reveals the GUI window, exactly like typing the
/// command in the app.
pub fn send_command(command: &str) -> Result<(), String> {
    expect_ok(round_trip(command, Duration::from_secs(5))?)
}

/// TUI command: executed by the app without stealing focus to the GUI.
pub fn send_quiet_command(command: &str) -> Result<(), String> {
    expect_ok(round_trip(&format!("{QUIET_PREFIX}{command}"), Duration::from_secs(5))?)
}

/// Bring the GUI window to the front without running a command.
pub fn focus_gui() -> Result<(), String> {
    expect_ok(round_trip(FOCUS_REQUEST, Duration::from_secs(5))?)
}

pub fn fetch_state() -> Result<String, String> {
    let response = round_trip(STATE_REQUEST, Duration::from_secs(5))?;
    if let Some(error) = response.strip_prefix("error:") {
        return Err(error.to_string());
    }
    Ok(response)
}

/// Open the state watch stream; each line is a snapshot (empty lines are
/// heartbeats).
pub fn open_state_watch() -> Result<BufReader<UnixStream>, String> {
    let (mut stream, _) = connect_to_running_instance()?;
    stream
        .write_all(format!("{WATCH_REQUEST}\n").as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(BufReader::new(stream))
}

/// Attach to a running PTY session. Returns the raw bidirectional stream
/// after the app has confirmed the attach.
pub fn open_terminal_attach(session_id: &str) -> Result<UnixStream, String> {
    let (mut stream, _) = connect_to_running_instance()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(format!("{ATTACH_PREFIX}{session_id}\n").as_bytes())
        .map_err(|error| error.to_string())?;

    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
                if line.len() > 4096 {
                    return Err("Unexpected attach response.".to_string());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let response = String::from_utf8_lossy(&line);
    if response.trim() != "ok" {
        return Err(response
            .trim()
            .strip_prefix("error:")
            .unwrap_or(response.trim())
            .to_string());
    }
    stream
        .set_read_timeout(None)
        .map_err(|error| error.to_string())?;
    Ok(stream)
}
