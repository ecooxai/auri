//! `auri cli` — a terminal UI that mirrors the running Auri app. It renders
//! the same JSON app-state snapshot the GUI publishes and drives the app
//! through the same command socket, so both frontends stay in sync.

// The view modules are shared with the dependency-light test harness; items
// only exercised there must not warn in the binary build.
#[allow(dead_code)]
pub mod ansi;
pub mod client;
#[allow(dead_code)]
pub mod input;
pub mod local;
pub mod model;
#[allow(dead_code)]
pub mod session_state;
#[allow(dead_code)]
pub mod screen;
pub mod term;
pub mod tui;
#[allow(dead_code)]
pub mod vt;
#[allow(dead_code)]
pub mod view_model;
