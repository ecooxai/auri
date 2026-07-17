//! Pure frame rendering for the TUI: app-state snapshot in, ANSI frame plus
//! clickable regions and a plain-text grid out. No terminal I/O here, so the
//! dependency-light Rust test harness can prove layout behaviour. Mirrors
//! the GUI: workspaces (with their folder names) laid out horizontally on
//! top, the subtab bar beneath them, the active panel below.

use super::ansi;
use super::view_model::{SnapshotView, SubtabView, SystemView};

const INVERSE: &str = "\u{1b}[7m";
const DIM: &str = "\u{1b}[2m";
const BOLD: &str = "\u{1b}[1m";
const RESET: &str = "\u{1b}[0m";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Normal,
    Command,
    Search,
}

#[derive(Debug, Clone, Default)]
pub struct UiState {
    pub mode: Mode,
    pub input: String,
    pub status: String,
    pub connected: bool,
    pub standalone: bool,
    /// Live terminal mode: keys go raw to the PTY, `term_lines` holds the
    /// VT-emulated grid (cursor already drawn), Ctrl+B leaves.
    pub term_mode: bool,
    pub term_lines: Vec<String>,
    pub terminal_scroll: usize,
    pub process_scroll: usize,
    pub clipboard_scroll: usize,
    pub selection: Option<Selection>,
}

/// A drag selection between two 0-based (x, y) grid points, in screen order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub start: (usize, usize),
    pub end: (usize, usize),
}

/// What a click at some screen cell should do.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    SelectWorkspace(String),
    SelectSubtab(String),
    SortBy(String),
    FocusTerminal,
    SelectProcess(i64),
    CopyClipboardItem(String),
    SystemArea,
    ClipboardArea,
}

#[derive(Debug, Clone)]
pub struct Region {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    pub action: Action,
}

pub struct Frame {
    pub text: String,
    pub plain: Vec<String>,
    pub regions: Vec<Region>,
}

pub fn hit_test<'a>(regions: &'a [Region], x: usize, y: usize) -> Option<&'a Action> {
    regions
        .iter()
        .find(|region| {
            y >= region.y && y < region.y + region.height && x >= region.x && x < region.x + region.width
        })
        .map(|region| &region.action)
}

/// Text covered by a selection over the plain grid. The end cell is
/// inclusive; rows are trimmed and joined with newlines.
pub fn selection_text(plain: &[String], a: (usize, usize), b: (usize, usize)) -> String {
    let (start, end) = if (a.1, a.0) <= (b.1, b.0) { (a, b) } else { (b, a) };
    let mut lines = Vec::new();
    for y in start.1..=end.1.min(plain.len().saturating_sub(1)) {
        let row: Vec<char> = plain.get(y).map(|row| row.chars().collect()).unwrap_or_default();
        let from = if y == start.1 { start.0.min(row.len()) } else { 0 };
        let to = if y == end.1 { (end.0 + 1).min(row.len()) } else { row.len() };
        let text: String = row[from.min(to)..to].iter().collect();
        lines.push(text.trim_end().to_string());
    }
    lines.join("\n").trim_end().to_string()
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

fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "~" {
        return "~".to_string();
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

/// One row builder that tracks styled text, its visible width, and regions.
struct RowBuilder<'a> {
    styled: String,
    width: usize,
    y: usize,
    regions: &'a mut Vec<Region>,
}

impl<'a> RowBuilder<'a> {
    fn new(y: usize, regions: &'a mut Vec<Region>) -> Self {
        RowBuilder { styled: String::new(), width: 0, y, regions }
    }

    fn push(&mut self, text: &str) {
        self.styled.push_str(text);
        self.width += ansi::visible_width(text);
    }

    fn push_clickable(&mut self, text: &str, action: Action) {
        let width = ansi::visible_width(text);
        self.regions.push(Region { x: self.width, y: self.y, width, height: 1, action });
        self.push(text);
    }

    fn finish(self, width: usize) -> String {
        ansi::fit_visible(&self.styled, width)
    }
}

/// Workspace chip text: a 1-based index on the left, plus the title only when
/// it says something ("Home"/"Space N" defaults collapse to the number — the
/// folder name beside the chip already identifies the workspace).
pub fn workspace_label(index: usize, title: &str) -> String {
    let title = title.trim();
    let is_default = title.is_empty()
        || title == "Home"
        || title
            .strip_prefix("Space ")
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit()));
    if is_default {
        index.to_string()
    } else {
        format!("{index} {title}")
    }
}

fn workspace_row(snapshot: &SnapshotView, y: usize, width: usize, regions: &mut Vec<Region>) -> String {
    let mut row = RowBuilder::new(y, regions);
    row.push(" ");
    for (index, workspace) in snapshot.workspaces.iter().enumerate() {
        if row.width >= width {
            break;
        }
        let folder = folder_name(&workspace.folder_path);
        let name = workspace_label(index + 1, &workspace.title);
        let label = if workspace.active {
            format!("{INVERSE}{BOLD} ▸ {name} {DIM}{folder}{RESET}{INVERSE} {RESET}")
        } else {
            format!(" {name} {DIM}{folder}{RESET} ")
        };
        row.push_clickable(&label, Action::SelectWorkspace(workspace.id.clone()));
        row.push(" ");
    }
    row.finish(width)
}

fn subtab_row(snapshot: &SnapshotView, y: usize, width: usize, regions: &mut Vec<Region>) -> String {
    let mut row = RowBuilder::new(y, regions);
    row.push("   ");
    if let Some(workspace) = snapshot.active_workspace() {
        for subtab in &workspace.subtabs {
            if row.width >= width {
                break;
            }
            let label = if subtab.active {
                format!("{INVERSE} {} {RESET}", subtab.title)
            } else {
                format!("{DIM} {} {RESET}", subtab.title)
            };
            row.push_clickable(&label, Action::SelectSubtab(subtab.id.clone()));
            row.push(" ");
        }
    }
    row.finish(width)
}

fn title_row(snapshot: &SnapshotView, ui: &UiState, width: usize) -> String {
    let mode = if ui.standalone { "standalone" } else { "GUI mirror" };
    let host = snapshot
        .system
        .metrics
        .as_ref()
        .map(|metrics| format!(" · {} {}", metrics.hostname, metrics.os))
        .unwrap_or_default();
    let connection = if ui.connected { format!("{mode}{host}") } else { "reconnecting…".to_string() };
    let text = format!(" {BOLD}Auri{RESET}  {DIM}{connection}{RESET}");
    ansi::fit_visible(&text, width)
}

fn terminal_panel(
    snapshot: &SnapshotView,
    ui: &UiState,
    top: usize,
    width: usize,
    height: usize,
    regions: &mut Vec<Region>,
) -> Vec<String> {
    let workspace = snapshot.active_workspace();
    let subtab = snapshot.active_subtab();
    let body_height = height.saturating_sub(1);
    regions.push(Region { x: 0, y: top, width, height: body_height.max(1), action: Action::FocusTerminal });

    let cwd = workspace.map(|workspace| workspace.terminal_cwd.clone()).unwrap_or_default();
    let mut lines: Vec<String>;
    let hint;
    if ui.term_mode && ui.terminal_scroll == 0 {
        // Live VT grid: the emulator rows are already styled and sized.
        lines = ui.term_lines.iter().take(body_height).cloned().collect();
        while lines.len() < body_height {
            lines.push(String::new());
        }
        hint = format!("{BOLD}{cwd}{RESET} {DIM}terminal — Ctrl+B normal mode · wheel scrolls history{RESET}");
    } else {
        let buffer = subtab.and_then(|subtab| snapshot.terminals.get(&subtab.id));
        let all_lines: Vec<String> = buffer
            .map(|buffer| ansi::sanitize_terminal_text(&buffer.text))
            .unwrap_or_default();
        let end = all_lines.len().saturating_sub(ui.terminal_scroll.min(all_lines.len()));
        let start = end.saturating_sub(body_height);
        lines = all_lines[start..end].to_vec();
        while lines.len() < body_height {
            lines.push(String::new());
        }
        hint = if ui.terminal_scroll > 0 {
            format!(
                "{BOLD}{cwd}{RESET} {DIM}↑{} history · wheel down returns to live{RESET}",
                ui.terminal_scroll
            )
        } else {
            format!("{BOLD}{cwd} ❯{RESET} {DIM}click or Enter to use the terminal · scroll wheel{RESET}")
        };
    }
    lines.push(hint);
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

const PROCESS_COLUMNS: [(&str, &str, usize); 7] = [
    ("PID", "pid", 6),
    ("NAME", "name", 0), // flexible
    ("CPU%", "cpu", 6),
    ("RAM", "ram", 9),
    ("NET", "net", 11),
    ("DISK", "disk", 11),
    ("PORT", "port", 9),
];

fn system_panel(
    snapshot: &SnapshotView,
    ui: &UiState,
    top: usize,
    width: usize,
    height: usize,
    regions: &mut Vec<Region>,
) -> Vec<String> {
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
            _ => " · click a column to sort · [/] search · [R] refresh".to_string(),
        }
    );
    lines.push(ansi::fit_visible(&sort_line, width));

    let fixed: usize = PROCESS_COLUMNS.iter().map(|(_, _, w)| *w).sum::<usize>() + PROCESS_COLUMNS.len() - 1;
    let name_width = width.saturating_sub(fixed).max(8);
    let header_y = top + lines.len();
    let mut header = RowBuilder::new(header_y, regions);
    for (index, (label, sort_key, column_width)) in PROCESS_COLUMNS.iter().enumerate() {
        let cell_width = if *column_width == 0 { name_width } else { *column_width };
        let cell = if *column_width == 0 {
            format!("{INVERSE}{label:<cell_width$}{RESET}")
        } else {
            format!("{INVERSE}{label:>cell_width$}{RESET}")
        };
        header.push_clickable(&cell, Action::SortBy(sort_key.to_string()));
        if index + 1 < PROCESS_COLUMNS.len() {
            header.push(&format!("{INVERSE} {RESET}"));
        }
    }
    lines.push(header.finish(width));

    let visible = snapshot
        .system
        .processes
        .iter()
        .skip(ui.process_scroll)
        .take(height.saturating_sub(lines.len()));
    for process in visible {
        let y = top + lines.len();
        let net = process.download_bytes_per_second + process.upload_bytes_per_second;
        let disk = process.read_bytes_per_second + process.write_bytes_per_second;
        let ports = process
            .ports
            .iter()
            .map(|port| port.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let selected = snapshot.system.processes.is_empty() == false
            && Some(process.pid) == snapshot_selected_pid(snapshot);
        let style = if selected { INVERSE } else { "" };
        let row_text = format!(
            "{style}{:>6} {} {:>6.1} {:>9} {:>11} {:>11} {:>9}{RESET}",
            process.pid,
            ansi::fit_visible(&process.name, name_width),
            process.cpu_percent,
            format_bytes(process.memory_bytes),
            format_rate(Some(net)),
            format_rate(Some(disk)),
            ansi::clip_visible(&ports, 9)
        );
        regions.push(Region { x: 0, y, width, height: 1, action: Action::SelectProcess(process.pid) });
        lines.push(ansi::fit_visible(&row_text, width));
        if lines.len() >= height {
            break;
        }
    }
    regions.push(Region { x: 0, y: top, width, height: height.max(1), action: Action::SystemArea });
    lines.truncate(height);
    lines
}

fn snapshot_selected_pid(snapshot: &SnapshotView) -> Option<i64> {
    snapshot.system.selected_pid
}

fn clipboard_panel(
    snapshot: &SnapshotView,
    ui: &UiState,
    top: usize,
    width: usize,
    height: usize,
    regions: &mut Vec<Region>,
) -> Vec<String> {
    let mut lines = vec![ansi::fit_visible(
        &format!(
            "{BOLD}Clipboard{RESET}  {DIM}{} item{} · click an item to copy it{RESET}",
            snapshot.clipboard_count,
            if snapshot.clipboard_count == 1 { "" } else { "s" }
        ),
        width,
    )];
    if snapshot.clipboard_items.is_empty() {
        lines.push(ansi::fit_visible(&format!("{DIM}Clipboard history is empty.{RESET}"), width));
    }
    for item in snapshot.clipboard_items.iter().skip(ui.clipboard_scroll) {
        if lines.len() >= height {
            break;
        }
        let y = top + lines.len();
        let pin = if item.pinned { "★" } else { " " };
        let kind = if item.kind == "image" { "▣" } else { "≡" };
        let preview = item.preview.split(['\n', '\r']).next().unwrap_or("");
        let row = format!("{pin} {DIM}{kind}{RESET} {preview}");
        regions.push(Region { x: 0, y, width, height: 1, action: Action::CopyClipboardItem(item.id.clone()) });
        lines.push(ansi::fit_visible(&row, width));
    }
    regions.push(Region { x: 0, y: top, width, height: height.max(1), action: Action::ClipboardArea });
    lines.truncate(height);
    lines
}

fn info_panel(snapshot: &SnapshotView, width: usize, height: usize) -> Vec<String> {
    let mut lines = Vec::new();
    if snapshot.info.items.is_empty() {
        lines.push(ansi::fit_visible(&format!("{DIM}No notifications. [c] clears.{RESET}"), width));
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

fn panel_lines(
    snapshot: &SnapshotView,
    ui: &UiState,
    top: usize,
    width: usize,
    height: usize,
    regions: &mut Vec<Region>,
) -> Vec<String> {
    let kind = snapshot.active_subtab().map(|subtab| subtab.kind.clone()).unwrap_or_default();
    let mut lines = match kind.as_str() {
        "terminal" => terminal_panel(snapshot, ui, top, width, height, regions),
        "system" | "disk" | "net" => system_panel(snapshot, ui, top, width, height, regions),
        "clipboard" => clipboard_panel(snapshot, ui, top, width, height, regions),
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
        Mode::Normal if ui.term_mode => format!(
            " {}{INVERSE} TERMINAL {RESET}{DIM} keys go to the shell · Ctrl+B for normal mode{RESET}",
            if ui.status.is_empty() { String::new() } else { format!("{} · ", ui.status) }
        ),
        Mode::Normal => format!(
            " {}{DIM}click tabs · drag selects (auto-copies) · ↑↓ space · ←→ subtab · : cmd · q quit{RESET}",
            if ui.status.is_empty() { String::new() } else { format!("{} · ", ui.status) }
        ),
    };
    ansi::fit_visible(&text, width)
}

/// Overlay the selection highlight by re-rendering the affected rows from
/// their plain text with an inverse span (colors on those rows give way to
/// the highlight).
fn apply_selection(rows: &mut [String], plain: &[String], selection: &Selection, width: usize) {
    let (start, end) = if (selection.start.1, selection.start.0) <= (selection.end.1, selection.end.0) {
        (selection.start, selection.end)
    } else {
        (selection.end, selection.start)
    };
    for y in start.1..=end.1.min(rows.len().saturating_sub(1)) {
        let row: Vec<char> = plain.get(y).map(|row| row.chars().collect()).unwrap_or_default();
        let from = if y == start.1 { start.0.min(row.len()) } else { 0 };
        let to = if y == end.1 { (end.0 + 1).min(row.len()) } else { row.len() };
        if from >= to {
            continue;
        }
        let before: String = row[..from].iter().collect();
        let selected: String = row[from..to].iter().collect();
        let after: String = row[to..].iter().collect();
        rows[y] = ansi::fit_visible(&format!("{before}{INVERSE}{selected}{RESET}{after}"), width);
    }
}

/// Render the whole frame: styled rows, a plain grid for selection, and
/// clickable regions. The caller homes the cursor and writes `text`.
pub fn render_frame(snapshot: &SnapshotView, ui: &UiState, size: (u16, u16)) -> Frame {
    let width = (size.0 as usize).max(20);
    let height = (size.1 as usize).max(6);
    let panel_top = 4;
    let body_height = height.saturating_sub(panel_top + 1);

    let mut regions = Vec::new();
    let mut rows = Vec::with_capacity(height);
    rows.push(title_row(snapshot, ui, width));
    rows.push(workspace_row(snapshot, 1, width, &mut regions));
    rows.push(subtab_row(snapshot, 2, width, &mut regions));
    rows.push(ansi::fit_visible(&format!("{DIM}{}{RESET}", "─".repeat(width)), width));
    rows.extend(panel_lines(snapshot, ui, panel_top, width, body_height, &mut regions));
    rows.push(status_row(ui, width));

    let plain: Vec<String> = rows
        .iter()
        .map(|row| {
            let mut text = String::new();
            let mut rest = row.as_str();
            while let Some(position) = rest.find('\u{1b}') {
                text.push_str(&rest[..position]);
                let (_, remaining) = split_escape(&rest[position..]);
                rest = remaining;
            }
            text.push_str(rest);
            text
        })
        .collect();

    let mut styled = rows;
    if let Some(selection) = ui.selection.as_ref() {
        apply_selection(&mut styled, &plain, selection, width);
    }
    Frame { text: styled.join("\r\n"), plain, regions }
}

fn split_escape(text: &str) -> (&str, &str) {
    debug_assert!(text.starts_with('\u{1b}'));
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b'[' {
        for (index, byte) in bytes.iter().enumerate().skip(2) {
            if (0x40..=0x7e).contains(byte) {
                return text.split_at(index + 1);
            }
        }
    }
    text.split_at(2.min(text.len()))
}
