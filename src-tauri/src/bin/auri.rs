#[allow(dead_code)]
#[path = "../core/util.rs"]
mod util;

#[cfg(unix)]
#[path = "../cli/mod.rs"]
mod cli;

#[cfg(unix)]
use std::env;

#[cfg(unix)]
fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        println!(
            "Usage: auri <command> [arguments...]\n       auri cli\n\nExample: auri tab new Research\n\nauri cli opens an interactive terminal UI that mirrors the running Auri app:\nsame workspaces, subtabs, terminal, and system monitor, live in both directions.\n\nSet AURI_COMMAND_SOCKET to target a specific running Auri instance."
        );
        return Ok(());
    }
    if arguments
        .first()
        .is_some_and(|value| value == "cli" || value == "tui")
    {
        return cli::tui::run();
    }
    let command = util::normalize_cli_command(&arguments)?;
    cli::client::send_command(&command)
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
