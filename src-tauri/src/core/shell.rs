use super::workspace::{display_path, expand_path, home_dir};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub cwd: String,
}

pub fn run(command: &str, cwd: &str) -> Result<CommandResult, String> {
    let current = expand_path(cwd)?;
    if let Some(destination) = parse_cd(command) {
        let next = resolve_destination(&current, &destination)?;
        if !next.is_dir() {
            return Err(format!("Not a directory: {}", display_path(&next)));
        }
        let canonical = next.canonicalize().unwrap_or(next);
        return Ok(CommandResult {
            stdout: String::new(),
            stderr: String::new(),
            code: 0,
            cwd: display_path(&canonical),
        });
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut child = Command::new(shell)
        .arg("-lc")
        .arg(command)
        .current_dir(&current)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the shell: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Could not capture command output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not capture command errors.")?;
    let stdout_reader = thread::spawn(move || read_stream(stdout));
    let stderr_reader = thread::spawn(move || read_stream(stderr));

    let started = Instant::now();
    let (status, timed_out) = loop {
        match child
            .try_wait()
            .map_err(|error| format!("Could not read command status: {error}"))?
        {
            Some(status) => break (status, false),
            None if started.elapsed() >= COMMAND_TIMEOUT => {
                child
                    .kill()
                    .map_err(|error| format!("Could not stop timed-out command: {error}"))?;
                let status = child
                    .wait()
                    .map_err(|error| format!("Could not finish timed-out command: {error}"))?;
                break (status, true);
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "Could not read command output.".to_string())?;
    let mut stderr = stderr_reader
        .join()
        .map_err(|_| "Could not read command errors.".to_string())?;
    if timed_out {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str("Command stopped after 15 seconds. Interactive programs such as top need a real terminal; use a batch form such as `top -l 1` on macOS or `top -b -n 1` on Linux.\n");
    }

    Ok(CommandResult {
        stdout,
        stderr,
        code: if timed_out {
            124
        } else {
            status.code().unwrap_or(-1)
        },
        cwd: display_path(&current),
    })
}

fn read_stream(mut stream: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_cd(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed == "cd" {
        return Some("~".to_string());
    }
    let rest = trimmed.strip_prefix("cd ")?.trim();
    if rest.contains("&&") || rest.contains(';') || rest.contains('|') {
        return None;
    }
    Some(
        rest.trim_matches(|value| value == '\'' || value == '"')
            .to_string(),
    )
}

fn resolve_destination(current: &Path, destination: &str) -> Result<PathBuf, String> {
    if destination == "~" || destination.starts_with("~/") {
        return expand_path(destination);
    }
    let path = PathBuf::from(destination);
    if path.is_absolute() {
        Ok(path)
    } else if destination.is_empty() {
        home_dir()
    } else {
        Ok(current.join(path))
    }
}
