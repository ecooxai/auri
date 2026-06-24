#[allow(dead_code)]
#[path = "../core/util.rs"]
mod util;

#[cfg(unix)]
use std::env;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
fn command_socket() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not available.".to_string())?;
    Ok(home.join(".config").join("auri").join("command.sock"))
}

#[cfg(unix)]
fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        println!("Usage: auri <command> [arguments...]\nExample: auri tab new Research");
        return Ok(());
    }
    let command = util::normalize_cli_command(&arguments)?;
    let path = command_socket()?;
    let mut stream = UnixStream::connect(&path).map_err(|error| {
        format!(
            "Could not connect to the running Auri app at {}: {error}",
            path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(command.as_bytes())
        .map_err(|error| error.to_string())?;
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
