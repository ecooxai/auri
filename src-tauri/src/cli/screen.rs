//! Pure frame rendering for the TUI: app-state snapshot in, ANSI frame out.
//! No terminal I/O here, so the dependency-light Rust test harness can prove
//! layout behaviour. Mirrors the GUI: vertical workspaces on the left,
//! horizontal subtabs on top, the active panel in the centre.

use super::ansi;
use super::view_model::{SnapshotView, SubtabView, SystemView};

const SIDEBAR_WIDTH: usize = 16;
const INVERSE: &str = "\u{1b}[7m";
const DIM: &str = "\u{1b}[2m";
const BOLD: &str = "\u{1b}[1m";
const RESET: &str = "\u{1b}[0m";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Normal,
    Command,
    RunCommand,
    Search,
}

#[derive(Debug, Clone, Default)]
pub struct UiState {
    pub mode: Mode,
    pub input: String,
    pub status: String,
    pub connected: bool,
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = "B";
    for next in UNITS {
        if value < 1024.0 {
            break;
        }
        value /= 1024.0;
        unit = next;
    }
    format!("{value:.1} {unit}")
}

pub fn format_rate(rate: Option<f64>) -> String {
    match rate {
        Some(value) if value.is_finite() && value >= 0.0 => {
            format!("{}/s", format_bytes(value as u64))
        }
        _ => "—".to_string(),
    }
}

fn subtab_label(subtab: &SubtabView) -> String {
    if subtab.active {
        format!("{INVERSE} {} {RESET}", subtab.title)
    } else {
        format!(" {} ", subtab.title)
    }
}

fn title_row(snapshot: &SnapshotView, ui: &UiState, width: usize) -> String {
    let host = snapshot
        .system
        .metrics
        .as_ref()
        .map(|metrics| format!("{} · {}", metrics.hostname, metrics.os))
        .unwrap_or_default();
    let connection = if ui.connected { host } else { "reconnecting…".to_string() };
    let text = format!(" Auri  {DIM}{connection}{RESET}");
    format!("{BOLD}{}{RESET}", ansi::fit_visible(&text, width))
}

fn subtab_row(snapshot: &SnapshotView, width: usize) -> String {
    let labels = snapshot
        .active_workspace()
        .map(|workspace| {
            workspace
                .subtabs
                .iter()
                .map(subtab_label)
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let indent = " ".repeat(SIDEBAR_WIDTH + 1);
    ansi::fit_visible(&format!("{indent}{labels}"), width)
}

fn sidebar_line(snapshot: &SnapshotView, row: usize) -> String {
    if let Some(workspace) = snapshot.workspaces.get(row) {
        let marker = if workspace.active { "▸" } else { " " };
        let style = if workspace.active { BOLD } else { DIM };
        return format!("{style}{marker} {}{RESET}", workspace.title);
    }
    let below = row.saturating_sub(snapshot.workspaces.len());
    match below {
        1 => format!("{DIM}Info  {}{RESET}", snapshot.info.unread),
        2 => format!("{DIM}Clip  {}{RESET}", snapshot.clipboard_count),
        _ => String::new(),
    }
}

fn terminal_panel(snapshot: &SnapshotView, ui: &UiState, width: usize, height: usize) -> Vec<String> {
    let workspace = snapshot.active_workspace();
    let subtab = snapshot.active_subtab();
    let buffer = subtab.and_then(|subtab| snapshot.terminals.get(&subtab.id));
    let mut lines: Vec<String> = buffer
        .map(|buffer| ansi::sanitize_terminal_text(&buffer.text))
        .unwrap_or_default();
    let body_height = height.saturating_sub(1);
    if lines.len() > body_height {
        lines = lines.split_off(lines.len() - body_height);
    }
    while lines.len() < body_height {
        lines.push(String::new());
    }
    let cwd = workspace.map(|workspace| workspace.terminal_cwd.clone()).unwrap_or_default();
    let running = workspace.is_some_and(|workspace| workspace.terminal_running);
    let prompt = match ui.mode {
        Mode::RunCommand => format!("{BOLD}{cwd} ❯{RESET} {}▌", ui.input),
        _ => format!(
            "{BOLD}{cwd} ❯{RESET} {DIM}{}[r] run · [a] attach full terminal · [:] command{RESET}",
            if running { "(running…) " } else { "" }
        ),
    };
    lines.push(prompt);
    lines
        .into_iter()
        .map(|line| ansi::fit_visible(&line, width))
        .collect()
}

fn system_metric_lines(system: &SystemView, width: usize) -> Vec<String> {
    let Some(metrics) = system.metrics.as_ref() else {
        return vec![ansi::fit_visible(&format!("{DIM}Collecting system statistics…{RESET}"), width)];
    };
    let cpu = format!(
        "{BOLD}CPU{RESET}  {}  {} cores  {}",
        metrics.cpu_brand,
        metrics.cpu_cores,
        metrics
            .cpu_usage_percent
            .map(|value| format!("{value:.1}%"))
            .unwrap_or_else(|| "—".to_string())
    );
    let ram = format!(
        "{BOLD}RAM{RESET}  {} / {}",
        format_bytes(metrics.memory_used_bytes),
        format_bytes(metrics.memory_total_bytes)
    );
    let net = format!(
        "{BOLD}NET{RESET}  ↓ {}  ↑ {}",
        format_rate(metrics.download_bytes_per_second),
        format_rate(metrics.upload_bytes_per_second)
    );
    let disk = format!(
        "{BOLD}DISK{RESET} {} / {}  r {}  w {}",
        format_bytes(metrics.disk_used_bytes),
        format_bytes(metrics.disk_total_bytes),
        format_rate(metrics.disk_read_bytes_per_second),
        format_rate(metrics.disk_write_bytes_per_second)
    );
    [cpu, ram, net, disk]
        .into_iter()
        .map(|line| ansi::fit_visible(&line, width))
        .collect()
}

fn system_panel(snapshot: &SnapshotView, ui: &UiState, width: usize, height: usize) -> Vec<String> {
    let system = &snapshot.system;
    let mut lines = system_metric_lines(system, width);
    let sort_line = format!(
        "{DIM}{} processes · sort {} {} · filter {}{}{RESET}",
        system.process_count,
        system.sort_by,
        if system.sort_direction == "asc" { "↑" } else { "↓" },
        if system.filter.is_empty() { "—" } else { &system.filter },
        match ui.mode {
            Mode::Search => format!(" · search: {}▌", ui.input),
            _ => " · [s] sort · [/] search · [R] refresh".to_string(),
        }
    );
    lines.push(ansi::fit_visible(&sort_line, width));
    let name_width = width.saturating_sub(6 + 7 + 10 + 12 + 12 + 10 + 6).max(8);
    lines.push(ansi::fit_visible(
        &format!(
            "{INVERSE}{:>6} {:<name_width$} {:>6} {:>9} {:>11} {:>11} {:>9}{RESET}",
            "PID", "NAME", "CPU%", "RAM", "NET", "DISK", "PORT"
        ),
        width,
    ));
    for process in &system.processes {
        if lines.len() >= height {
            break;
        }
        let net = process.download_bytes_per_second + process.upload_bytes_per_second;
        let disk = process.read_bytes_per_second + process.write_bytes_per_second;
        let ports = process
            .ports
            .iter()
            .map(|port| port.to_string())
            .collect::<Vec<_>>()
            .join(",");
        lines.push(ansi::fit_visible(
            &format!(
                "{:>6} {} {:>6.1} {:>9} {:>11} {:>11} {:>9}",
                process.pid,
                ansi::fit_visible(&process.name, name_width),
                process.cpu_percent,
                format_bytes(process.memory_bytes),
                format_rate(Some(net)),
                format_rate(Some(disk)),
                ansi::clip_visible(&ports, 9)
            ),
            width,
        ));
    }
    lines.truncate(height);
    while lines.len() < height {
        lines.push(" ".repeat(width));
    }
    lines
}

fn info_panel(snapshot: &SnapshotView, width: usize, height: usize) -> Vec<String> {
    let mut lines = Vec::new();
    if snapshot.info.items.is_empty() {
        lines.push(ansi::fit_visible(&format!("{DIM}No notifications.{RESET}"), width));
    }
    for item in &snapshot.info.items {
        if lines.len() >= height {
            break;
        }
        let level = match item.level.as_str() {
            "error" => format!("\u{1b}[31m{}{RESET}", item.level),
            "warning" => format!("\u{1b}[33m{}{RESET}", item.level),
            _ => format!("{DIM}{}{RESET}", item.level),
        };
        lines.push(ansi::fit_visible(
            &format!("{level}  {BOLD}{}{RESET}  {}", item.title, item.message),
            width,
        ));
    }
    lines
}

fn placeholder_panel(subtab: Option<&SubtabView>, width: usize) -> Vec<String> {
    let (title, detail) = match subtab {
        Some(subtab) if subtab.kind == "webview" => (
            subtab.url.clone().unwrap_or_default(),
            "Websites render in the GUI window; this tab stays selected and in sync.".to_string(),
        ),
        Some(subtab) => (
            subtab.title.clone(),
            format!("The {} panel renders in the GUI window.", subtab.title),
        ),
        None => (String::new(), "No subtab is selected.".to_string()),
    };
    vec![
        ansi::fit_visible(&format!("{BOLD}{title}{RESET}"), width),
        ansi::fit_visible(&format!("{DIM}{detail}{RESET}"), width),
    ]
}

fn panel_lines(snapshot: &SnapshotView, ui: &UiState, width: usize, height: usize) -> Vec<String> {
    let kind = snapshot.active_subtab().map(|subtab| subtab.kind.clone()).unwrap_or_default();
    let mut lines = match kind.as_str() {
        "terminal" => terminal_panel(snapshot, ui, width, height),
        "system" | "disk" | "net" => system_panel(snapshot, ui, width, height),
        "info" => info_panel(snapshot, width, height),
        _ => placeholder_panel(snapshot.active_subtab(), width),
    };
    lines.truncate(height);
    while lines.len() < height {
        lines.push(" ".repeat(width));
    }
    lines
}

fn status_row(ui: &UiState, width: usize) -> String {
    let text = match ui.mode {
        Mode::Command => format!(" :{}▌", ui.input),
        Mode::Search => format!(" /{}▌", ui.input),
        Mode::RunCommand => format!(" run ❯ {}▌", ui.input),
        Mode::Normal => format!(
            " {}{DIM}↑↓ workspace · ←→/⇥ subtab · q quit{RESET}",
            if ui.status.is_empty() { String::new() } else { format!("{} · ", ui.status) }
        ),
    };
    ansi::fit_visible(&text, width)
}

/// Render the whole frame as `\r\n`-joined rows of exactly the terminal
/// width. The caller homes the cursor and writes the result.
pub fn render_frame(snapshot: &SnapshotView, ui: &UiState, size: (u16, u16)) -> String {
    let width = (size.0 as usize).max(20);
    let height = (size.1 as usize).max(6);
    let panel_width = width.saturating_sub(SIDEBAR_WIDTH + 3);
    let body_height = height.saturating_sub(4);

    let mut rows = Vec::with_capacity(height);
    rows.push(title_row(snapshot, ui, width));
    rows.push(subtab_row(snapshot, width));
    rows.push(ansi::fit_visible(&format!("{DIM}{}{RESET}", "─".repeat(width)), width));
    let panel = panel_lines(snapshot, ui, panel_width, body_height);
    for row in 0..body_height {
        let sidebar = ansi::fit_visible(&sidebar_line(snapshot, row), SIDEBAR_WIDTH);
        let content = panel.get(row).cloned().unwrap_or_default();
        rows.push(ansi::fit_visible(&format!("{sidebar} {DIM}│{RESET} {content}"), width));
    }
    rows.push(status_row(ui, width));
    rows.join("\r\n")
}
