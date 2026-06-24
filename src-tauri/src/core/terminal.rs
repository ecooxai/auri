use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
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

pub fn start(
    app: AppHandle,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut command = CommandBuilder::new(shell);
    command.cwd(super::workspace::expand_path(&cwd)?);
    command.env("TERM", "xterm-256color");

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

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let _ = app.emit(
                        "terminal-data",
                        TerminalData {
                            session_id: session_id.clone(),
                            data: buffer[..count].to_vec(),
                        },
                    );
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
    });

    Ok(())
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
        .map_err(|error| format!("Could not resize terminal: {error}"))
}

pub fn stop(session_id: &str) -> Result<(), String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Terminal session store is unavailable.".to_string())?
        .remove(session_id);
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
