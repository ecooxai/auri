#[allow(dead_code)]
#[path = "../core/util.rs"]
mod util;

#[cfg(unix)]
use std::env;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::{Duration, SystemTime};

#[cfg(unix)]
fn config_directory() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not available.".to_string())?;
    Ok(home.join(".config").join("auri"))
}

#[cfg(unix)]
fn modified_time(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

#[cfg(unix)]
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

#[cfg(unix)]
fn connect_to_running_instance() -> Result<(UnixStream, PathBuf), String> {
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

#[cfg(unix)]
fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        println!(
            "Usage: auri <command> [arguments...]\nExample: auri tab new Research\n\nSet AURI_COMMAND_SOCKET to target a specific running Auri instance."
        );
        return Ok(());
    }
    let command = util::normalize_cli_command(&arguments)?;
    let (mut stream, path) = connect_to_running_instance()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(command.as_bytes())
        .map_err(|error| format!("Could not write to {}: {error}", path.display()))?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let response = response.trim();
    if response == "ok" {
        return Ok(());
    }
    Err(response
        .strip_prefix("error:")
        .unwrap_or(response)
        .to_string())
}

#[cfg(unix)]
fn main() {
    if let Err(error) = run() {
        eprintln!("auri: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("auri: the external command bridge currently supports macOS and Linux.");
    std::process::exit(1);
}
