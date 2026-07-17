//! Latest-app-state store. The frontend mirrors its full state (workspaces,
//! terminal buffers, system monitor) here as one JSON line; the external CLI
//! and TUI read it once or watch it over the command socket. Std-only so the
//! dependency-light Rust test harness can cover it.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Store {
    seq: u64,
    json: Option<String>,
}

fn store() -> &'static (Mutex<Store>, Condvar) {
    static STORE: OnceLock<(Mutex<Store>, Condvar)> = OnceLock::new();
    STORE.get_or_init(|| (Mutex::new(Store::default()), Condvar::new()))
}

pub fn publish(json: String) {
    let (lock, signal) = store();
    if let Ok(mut state) = lock.lock() {
        state.seq += 1;
        state.json = Some(json);
        signal.notify_all();
    }
}

pub fn latest() -> Option<String> {
    let (lock, _) = store();
    lock.lock().ok()?.json.clone()
}

/// Block until a snapshot newer than `last_seq` exists or the timeout passes.
pub fn wait_for_newer(last_seq: u64, timeout: Duration) -> Option<(u64, String)> {
    let (lock, signal) = store();
    let deadline = Instant::now() + timeout;
    let mut state = lock.lock().ok()?;
    loop {
        if state.seq > last_seq {
            if let Some(json) = state.json.clone() {
                return Some((state.seq, json));
            }
        }
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let (next, waited) = signal.wait_timeout(state, remaining).ok()?;
        state = next;
        if waited.timed_out() && state.seq <= last_seq {
            return None;
        }
    }
}
