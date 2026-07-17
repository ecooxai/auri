//! Byte taps on running PTY sessions. The TUI's attach mode registers a tap
//! to receive the same raw output the GUI emulator renders, giving an honest
//! full terminal in the CLI without a second shell. Std-only so the
//! dependency-light Rust test harness can cover it.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

fn taps() -> &'static Mutex<HashMap<String, Vec<Sender<Vec<u8>>>>> {
    static TAPS: OnceLock<Mutex<HashMap<String, Vec<Sender<Vec<u8>>>>>> = OnceLock::new();
    TAPS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn attach(session_id: &str) -> Receiver<Vec<u8>> {
    let (sender, receiver) = channel();
    if let Ok(mut map) = taps().lock() {
        map.entry(session_id.to_string()).or_default().push(sender);
    }
    receiver
}

/// Forward PTY output to every attached watcher, pruning closed ones.
pub fn forward(session_id: &str, bytes: &[u8]) {
    let Ok(mut map) = taps().lock() else {
        return;
    };
    let Some(senders) = map.get_mut(session_id) else {
        return;
    };
    senders.retain(|sender| sender.send(bytes.to_vec()).is_ok());
    if senders.is_empty() {
        map.remove(session_id);
    }
}

/// Disconnect all watchers of a session (used when the PTY exits).
pub fn clear(session_id: &str) {
    if let Ok(mut map) = taps().lock() {
        map.remove(session_id);
    }
}

pub fn tap_count(session_id: &str) -> usize {
    taps()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).map(Vec::len))
        .unwrap_or(0)
}
