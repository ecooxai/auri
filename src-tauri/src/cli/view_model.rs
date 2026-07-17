//! Plain structs mirroring the app-state snapshot JSON the GUI publishes.
//! Std-only (parsing lives in the serde-backed `model` module) so the
//! dependency-light Rust test harness can drive the screen renderer.

use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct SnapshotView {
    pub seq: u64,
    pub active_tab_id: String,
    pub active_subtab_id: String,
    pub workspaces: Vec<WorkspaceView>,
    pub terminals: HashMap<String, TerminalBufferView>,
    pub system: SystemView,
    pub info: InfoView,
    pub clipboard_count: usize,
    pub clipboard_items: Vec<ClipboardItemView>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceView {
    pub id: String,
    pub title: String,
    pub active: bool,
    pub active_subtab_id: String,
    pub folder_path: String,
    pub terminal_cwd: String,
    pub terminal_running: bool,
    pub subtabs: Vec<SubtabView>,
}

#[derive(Debug, Clone, Default)]
pub struct SubtabView {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub active: bool,
    pub cwd: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TerminalBufferView {
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct SystemView {
    pub status: String,
    pub sort_by: String,
    pub sort_direction: String,
    pub filter: String,
    pub selected_pid: Option<i64>,
    pub process_count: usize,
    pub metrics: Option<MetricsView>,
    pub processes: Vec<ProcessView>,
}

#[derive(Debug, Clone, Default)]
pub struct MetricsView {
    pub hostname: String,
    pub os: String,
    pub cpu_brand: String,
    pub cpu_cores: u32,
    pub cpu_usage_percent: Option<f64>,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub download_bytes_per_second: Option<f64>,
    pub upload_bytes_per_second: Option<f64>,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    pub disk_read_bytes_per_second: Option<f64>,
    pub disk_write_bytes_per_second: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct ProcessView {
    pub pid: i64,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_bytes: u64,
    pub download_bytes_per_second: f64,
    pub upload_bytes_per_second: f64,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
    pub ports: Vec<u16>,
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClipboardItemView {
    pub id: String,
    pub kind: String,
    pub pinned: bool,
    pub preview: String,
}

#[derive(Debug, Clone, Default)]
pub struct InfoView {
    pub unread: u32,
    pub items: Vec<InfoItemView>,
}

#[derive(Debug, Clone, Default)]
pub struct InfoItemView {
    pub at: String,
    pub title: String,
    pub message: String,
    pub level: String,
}

impl SnapshotView {
    pub fn active_workspace(&self) -> Option<&WorkspaceView> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.id == self.active_tab_id)
            .or_else(|| self.workspaces.first())
    }

    pub fn active_subtab(&self) -> Option<&SubtabView> {
        let workspace = self.active_workspace()?;
        workspace
            .subtabs
            .iter()
            .find(|subtab| subtab.id == workspace.active_subtab_id)
            .or_else(|| workspace.subtabs.first())
    }
}
