//! Per-session VT emulators for GUI terminals. The PTY reader thread feeds
//! every session's `VtScreen` here, and the frontends (desktop window and
//! hosted browser session) render the resulting styled frames as plain HTML
//! instead of running their own emulator.

use super::vt::{Color, Run, Style, VtScreen};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

static EMULATORS: Lazy<Mutex<HashMap<String, VtScreen>>> = Lazy::new(|| Mutex::new(HashMap::new()));

const RUN_BOLD: u8 = 1;
const RUN_DIM: u8 = 2;
const RUN_ITALIC: u8 = 4;
const RUN_UNDERLINE: u8 = 8;
const RUN_INVERSE: u8 = 16;

#[derive(Serialize)]
pub struct FrameRun {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<Value>,
    #[serde(skip_serializing_if = "flags_are_empty")]
    pub flags: u8,
}

fn flags_are_empty(flags: &u8) -> bool {
    *flags == 0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub cursor_visible: bool,
    pub application_cursor_keys: bool,
    pub bracketed_paste: bool,
    pub scrollback_len: usize,
    pub scrollback_start: usize,
    pub lines: Vec<Vec<FrameRun>>,
}

fn color_value(color: Color) -> Option<Value> {
    match color {
        Color::Default => None,
        Color::Indexed(index) => Some(Value::from(index)),
        Color::Rgb(r, g, b) => Some(Value::from(format!("#{r:02x}{g:02x}{b:02x}"))),
    }
}

fn style_flags(style: &Style) -> u8 {
    let mut flags = 0;
    if style.bold {
        flags |= RUN_BOLD;
    }
    if style.dim {
        flags |= RUN_DIM;
    }
    if style.italic {
        flags |= RUN_ITALIC;
    }
    if style.underline {
        flags |= RUN_UNDERLINE;
    }
    if style.inverse {
        flags |= RUN_INVERSE;
    }
    flags
}

fn frame_runs(rows: Vec<Vec<Run>>) -> Vec<Vec<FrameRun>> {
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|run| FrameRun {
                    fg: color_value(run.style.fg),
                    bg: color_value(run.style.bg),
                    flags: style_flags(&run.style),
                    text: run.text,
                })
                .collect()
        })
        .collect()
}

fn store() -> Result<std::sync::MutexGuard<'static, HashMap<String, VtScreen>>, String> {
    EMULATORS
        .lock()
        .map_err(|_| "Terminal emulator store is unavailable.".to_string())
}

pub fn create(session_id: &str, cols: usize, rows: usize, scrollback: Option<usize>) {
    let mut screen = VtScreen::new(cols.max(2), rows.max(2));
    if let Some(limit) = scrollback {
        screen.set_scrollback_limit(limit.clamp(100, 100_000));
    }
    if let Ok(mut emulators) = store() {
        emulators.insert(session_id.to_string(), screen);
    }
}

pub fn remove(session_id: &str) {
    if let Ok(mut emulators) = store() {
        emulators.remove(session_id);
    }
}

pub fn feed(session_id: &str, bytes: &[u8]) {
    if let Ok(mut emulators) = store() {
        if let Some(screen) = emulators.get_mut(session_id) {
            screen.feed(bytes);
        }
    }
}

pub fn resize(session_id: &str, cols: usize, rows: usize) {
    if let Ok(mut emulators) = store() {
        if let Some(screen) = emulators.get_mut(session_id) {
            screen.resize(cols.max(2), rows.max(2));
        }
    }
}

/// Absolute line index of the cursor: scrolled-off rows plus the cursor row.
/// Media cards printed from the GUI anchor to this line.
pub fn cursor_line(session_id: &str) -> Result<usize, String> {
    let emulators = store()?;
    let screen = emulators
        .get(session_id)
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    Ok(screen.scrollback_len() + screen.cursor().1)
}

pub fn frame(session_id: &str) -> Result<Frame, String> {
    let emulators = store()?;
    let screen = emulators
        .get(session_id)
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    let (cols, rows) = screen.size();
    let (cursor_x, cursor_y) = screen.cursor();
    Ok(Frame {
        cols,
        rows,
        cursor_x,
        cursor_y,
        cursor_visible: screen.cursor_visible,
        application_cursor_keys: screen.application_cursor_keys,
        bracketed_paste: screen.bracketed_paste,
        scrollback_len: screen.scrollback_len(),
        scrollback_start: screen.scrollback_start(),
        lines: frame_runs(screen.styled_runs()),
    })
}

pub fn scrollback(session_id: &str, start: usize, count: usize) -> Result<Vec<Vec<FrameRun>>, String> {
    let emulators = store()?;
    let screen = emulators
        .get(session_id)
        .ok_or_else(|| "Terminal session is not running.".to_string())?;
    Ok(frame_runs(screen.scrollback_runs(start, count)))
}
