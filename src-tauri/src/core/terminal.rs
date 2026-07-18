use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<Session>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalData {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

/// App-managed shell bootstrap: source the user's own rc files, then force a
/// bare `%`/`$` prompt and emit the OSC 777 cwd marker the frontend already
/// parses, so directory sync is event-driven instead of lsof polling.
fn shell_bootstrap_dir(shell_name: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("auri-shell-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    match shell_name {
        "zsh" => {
            let marker = "precmd() { print -Pn '\\e]777;auri-cwd=%d\\a' }\nchpwd() { print -Pn '\\e]777;auri-cwd=%d\\a' }";
            std::fs::write(
                dir.join(".zshenv"),
                "[ -f \"$HOME/.zshenv\" ] && source \"$HOME/.zshenv\"\n",
            )
            .ok()?;
            std::fs::write(
                dir.join(".zshrc"),
                format!(
                    "[ -f \"$HOME/.zshrc\" ] && source \"$HOME/.zshrc\"\nPROMPT='%# '\nRPROMPT=''\n{marker}\n"
                ),
            )
            .ok()?;
            Some(dir)
        }
        "bash" => {
            std::fs::write(
                dir.join("bashrc"),
                "[ -f \"$HOME/.bashrc\" ] && source \"$HOME/.bashrc\"\nPS1='\\$ '\nPROMPT_COMMAND='printf \"\\033]777;auri-cwd=%s\\007\" \"$PWD\"'\n",
            )
            .ok()?;
            Some(dir)
        }
        _ => None,
    }
}

pub fn start(
    app: AppHandle,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    scrollback: Option<usize>,
    shell_command: Option<String>,
) -> Result<(), String> {
    stop(&session_id).ok();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not create terminal: {error}"))?;

    let environment_shell = std::env::var("SHELL").ok();
    let shell = super::util::terminal_shell_command(
        shell_command.as_deref(),
        environment_shell.as_deref(),
    );
    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    let mut command = CommandBuilder::new(&shell);
    command.cwd(super::workspace::expand_path(&cwd)?);
    command.env("TERM", "xterm-256color");
    match (shell_name.as_str(), shell_bootstrap_dir(&shell_name)) {
        ("zsh", Some(dir)) => command.env("ZDOTDIR", dir),
        ("bash", Some(dir)) => {
            command.arg("--rcfile");
            command.arg(dir.join("bashrc"));
        }
        _ => {}
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start terminal shell: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not open terminal input: {error}"))?;

    let session = Arc::new(Mutex::new(Session {
        master: pair.master,
        writer,
        child,
    }));
    SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .insert(session_id.clone(), session.clone());
    super::term_emulator::create(&session_id, cols.max(2) as usize, rows.max(2) as usize, scrollback);

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    super::term_emulator::feed(&session_id, &buffer[..count]);
                    let _ = app.emit(
                        "terminal-data",
                        TerminalData {
                            session_id: session_id.clone(),
                            data: buffer[..count].to_vec(),
                        },
                    );
                    super::term_bridge::forward(&session_id, &buffer[..count]);
                }
            }
        }
        let _ = app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: session_id.clone(),
            },
        );
        if let Ok(mut sessions) = SESSIONS.lock() {
            sessions.remove(&session_id);
        }
        super::term_emulator::remove(&session_id);
        super::term_bridge::clear(&session_id);
    });

    Ok(())
}

/// Render GUI-side message blocks (user prompts, assistant replies) into the
/// session's emulator and broadcast them to every mirror without ever
/// touching the PTY's stdin.
pub fn print(app: &AppHandle, session_id: &str, text: &str) -> Result<usize, String> {
    if !exists(session_id) {
        return Err("Terminal session is not running.".to_string());
    }
    let bytes = text.as_bytes();
    super::term_emulator::feed(session_id, bytes);
    let line = super::term_emulator::cursor_line(session_id)?;
    let _ = app.emit(
        "terminal-data",
        TerminalData {
            session_id: session_id.to_string(),
            data: bytes.to_vec(),
        },
    );
    super::term_bridge::forward(session_id, bytes);
    Ok(line)
}

pub fn exists(session_id: &str) -> bool {
    SESSIONS
        .lock()
        .map(|sessions| sessions.contains_key(session_id))
        .unwrap_or(false)
}

pub fn write(session_id: &str, data: &[u8]) -> Result<(), String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    let mut session = session
        .lock()
        .map_err(|_| "Terminal session is unavailable.".to_string())?;
    session
        .writer
        .write_all(data)
        .map_err(|error| format!("Could not write to terminal: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Could not flush terminal input: {error}"))
}

fn displayed_cwd(reported: &Path, logical_cwd: Option<&str>) -> String {
    if let Some(logical_cwd) = logical_cwd.filter(|value| !value.is_empty()) {
        if let Ok(logical_path) = super::workspace::expand_path(logical_cwd) {
            if super::util::paths_refer_to_same_location(&logical_path, reported) {
                return logical_cwd.to_string();
            }
        }
    }
    super::workspace::display_path(reported)
}

pub fn cwd(session_id: &str, logical_cwd: Option<&str>) -> Result<String, String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    let pid = session
        .lock()
        .map_err(|_| "Terminal session is unavailable.".to_string())?
        .child
        .process_id()
        .ok_or_else(|| "Terminal process id is unavailable.".to_string())?;

    #[cfg(target_os = "linux")]
    {
        let path = std::fs::read_link(format!("/proc/{pid}/cwd"))
            .map_err(|error| format!("Could not read terminal directory: {error}"))?;
        return Ok(displayed_cwd(&path, logical_cwd));
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .map_err(|error| format!("Could not inspect terminal directory: {error}"))?;
        if !output.status.success() {
            return Err("Could not inspect terminal directory.".to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let value = stdout
            .lines()
            .find_map(|line| line.strip_prefix('n'))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Terminal directory was not reported.".to_string())?;
        return Ok(displayed_cwd(&PathBuf::from(value), logical_cwd));
    }

    #[allow(unreachable_code)]
    Err("Terminal directory lookup is unsupported on this platform.".to_string())
}

pub fn busy(session_id: &str) -> Result<bool, String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    let pid = session
        .lock()
        .map_err(|_| "Terminal session is unavailable.".to_string())?
        .child
        .process_id()
        .ok_or_else(|| "Terminal process id is unavailable.".to_string())?;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let output = Command::new("pgrep")
            .args(["-P", &pid.to_string()])
            .output()
            .map_err(|error| format!("Could not inspect terminal activity: {error}"))?;
        return Ok(output.status.success() && !output.stdout.is_empty());
    }

    #[allow(unreachable_code)]
    Ok(false)
}

pub fn resize(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    let session = session
        .lock()
        .map_err(|_| "Terminal session is unavailable.".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not resize terminal: {error}"))?;
    super::term_emulator::resize(session_id, cols.max(2) as usize, rows.max(2) as usize);
    Ok(())
}

pub fn stop(session_id: &str) -> Result<(), String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .remove(session_id);
    super::term_emulator::remove(session_id);
    if let Some(session) = session {
        let mut session = session
            .lock()
            .map_err(|_| "Terminal session is unavailable.".to_string())?;
        session
            .child
            .kill()
            .map_err(|error| format!("Could not stop terminal: {error}"))?;
    }
    Ok(())
}
