#[allow(dead_code)]
#[path = "../core/util.rs"]
mod util;

// Standalone mode reuses the same tauri-free native core modules as the app:
// real sessions, monitor, and clipboard — never reimplemented behaviour.
#[cfg(unix)]
#[allow(dead_code)]
#[path = "../core/workspace.rs"]
mod workspace;

#[cfg(unix)]
#[allow(dead_code)]
#[path = "../core/clipboard.rs"]
mod clipboard;

#[cfg(unix)]
#[allow(dead_code)]
#[path = "../core/system.rs"]
mod system;

#[cfg(unix)]
#[allow(dead_code)]
#[path = "../core/term_bridge.rs"]
mod term_bridge;

#[cfg(unix)]
#[path = "../cli/mod.rs"]
mod cli;

#[cfg(unix)]
use std::env;

#[cfg(unix)]
fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the browser ({opener}): {error}"))
}

/// `auri browser`: the running app hosts the UI on 127.0.0.1:8899 and the
/// default browser opens it. The page keeps working for later visits too.
#[cfg(unix)]
fn open_browser_ui() -> Result<(), String> {
    let url = cli::client::send_serve_ui()
        .map_err(|error| format!("{error} (the Auri app must be running for the browser UI)"))?;
    println!("Auri UI: {url}");
    open_in_browser(&url)
}

#[cfg(unix)]
fn stop_app() -> Result<(), String> {
    cli::client::send_quit()?;
    println!("Auri app stopped.");
    Ok(())
}

/// `auri restart`: relaunch the running app backend, wait for its command
/// socket to come back, then enter the terminal UI against the new instance.
#[cfg(unix)]
fn restart_app() -> Result<(), String> {
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    let info = cli::client::fetch_app_info()
        .map_err(|error| format!("{error} (start the Auri app before `auri restart`)"))?;
    if info.exe.is_empty() {
        return Err("The running app did not report its executable path.".to_string());
    }
    cli::client::send_quit()?;

    let gone_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < gone_deadline && UnixStream::connect(&info.socket).is_ok() {
        std::thread::sleep(Duration::from_millis(150));
    }

    std::process::Command::new(&info.exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not restart {}: {error}", info.exe))?;

    let back_deadline = Instant::now() + Duration::from_secs(20);
    while cli::client::connect_to_running_instance().is_err() {
        if Instant::now() >= back_deadline {
            return Err("The restarted Auri app did not come back within 20 seconds.".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    println!("Auri restarted — opening the terminal UI…");
    cli::tui::run()
}

#[cfg(unix)]
fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("--help") | Some("-h") => {
            println!(
                "Usage: auri <command> [arguments...]\n       auri            open the terminal UI (mirrors the app, or hosts sessions itself)\n       auri cli        same as bare auri\n       auri browser    serve the app UI at http://127.0.0.1:8899 and open it in the browser\n       auri restart    restart the app backend, then open the terminal UI\n       auri stop       stop the running app\n\nExample: auri tab new Research\n\nauri cli opens an interactive terminal UI that mirrors the running Auri app:\nsame workspaces, subtabs, terminal, and system monitor, live in both directions.\nWithout a running app it hosts terminals itself, tmux-style.\n\nSet AURI_COMMAND_SOCKET to target a specific running Auri instance."
            );
            Ok(())
        }
        None | Some("cli") | Some("tui") => cli::tui::run(),
        Some("browser") if arguments.len() == 1 => open_browser_ui(),
        Some("stop") if arguments.len() == 1 => stop_app(),
        Some("restart") if arguments.len() == 1 => restart_app(),
        _ => {
            let command = util::normalize_cli_command(&arguments)?;
            cli::client::send_command(&command)
        }
    }
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
