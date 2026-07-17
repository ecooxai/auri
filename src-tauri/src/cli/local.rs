//! Standalone session host for `auri cli` when no GUI instance is running.
//! The TUI owns the workspaces and PTYs itself, tmux-style, reusing the same
//! native core modules as the app: `workspace` for the saved session,
//! `system` for the real monitor, and `clipboard` for the shared history.
//! Sessions live as long as the TUI process (no detached daemon yet).

use super::session_state::{filter_processes, sort_processes, Effect, LocalProcess, SessionState};
use super::tui::Event;
use super::view_model::{
    ClipboardItemView, InfoItemView, InfoView, MetricsView, ProcessView, SnapshotView, SubtabView,
    SystemView, TerminalBufferView, WorkspaceView,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const BUFFER_MAX_CHARS: usize = 262144;

struct LocalPty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct SharedMonitor {
    pub metrics: Option<MetricsView>,
    pub processes: Vec<LocalProcess>,
    pub captured_at: String,
}

pub struct LocalHost {
    pub state: SessionState,
    ptys: HashMap<String, LocalPty>,
    buffers: Arc<Mutex<HashMap<String, String>>>,
    monitor: Arc<Mutex<SharedMonitor>>,
    clipboard_items: Vec<crate::clipboard::ClipboardEntry>,
    events: Sender<Event>,
    refresh_system: Sender<()>,
    panel_size: (u16, u16),
    seq: u64,
}

/// Append raw PTY bytes as UTF-8, holding back an incomplete trailing
/// character until its remaining bytes arrive.
fn append_utf8(pending: &mut Vec<u8>, chunk: &[u8], out: &mut String) {
    pending.extend_from_slice(chunk);
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid_up_to]).expect("validated prefix"));
                match error.error_len() {
                    Some(invalid) => {
                        out.push('\u{fffd}');
                        pending.drain(..valid_up_to + invalid);
                    }
                    None => {
                        let tail: Vec<u8> = pending[valid_up_to..].to_vec();
                        pending.clear();
                        pending.extend(tail);
                        return;
                    }
                }
            }
        }
    }
}

fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn process_rates(
    process: &crate::system::ProcessInfo,
    previous: Option<&(u64, u64, u64, u64)>,
    elapsed: f64,
) -> (f64, f64, f64, f64) {
    let Some((download, upload, read, write)) = previous else {
        return (0.0, 0.0, 0.0, 0.0);
    };
    let rate = |now: u64, before: u64| now.saturating_sub(before) as f64 / elapsed;
    (
        rate(process.download_bytes, *download),
        rate(process.upload_bytes, *upload),
        rate(process.disk_read_bytes, *read),
        rate(process.disk_write_bytes, *write),
    )
}

fn spawn_monitor_thread(
    shared: Arc<Mutex<SharedMonitor>>,
    events: Sender<Event>,
    refresh: Receiver<()>,
) {
    thread::spawn(move || {
        let mut previous_sample = None;
        let mut previous_counters: HashMap<i64, (u64, u64, u64, u64)> = HashMap::new();
        let mut previous_at: Option<Instant> = None;
        loop {
            if let Ok((snapshot, sample)) = crate::system::snapshot(previous_sample.take(), false) {
                previous_sample = Some(sample);
                let elapsed = previous_at
                    .map(|at| at.elapsed().as_secs_f64().max(0.2))
                    .unwrap_or(f64::MAX);
                previous_at = Some(Instant::now());
                let mut counters = HashMap::new();
                let processes = snapshot
                    .processes
                    .iter()
                    .map(|process| {
                        let pid = process.pid as i64;
                        let (download, upload, read, write) =
                            process_rates(process, previous_counters.get(&pid), elapsed);
                        counters.insert(
                            pid,
                            (
                                process.download_bytes,
                                process.upload_bytes,
                                process.disk_read_bytes,
                                process.disk_write_bytes,
                            ),
                        );
                        LocalProcess {
                            pid,
                            name: process.name.clone(),
                            path: process.path.clone(),
                            command_line: process.command_line.clone(),
                            cpu_percent: process.cpu_percent,
                            memory_bytes: process.memory_bytes,
                            priority: process.priority as i64,
                            download_bytes_per_second: download,
                            upload_bytes_per_second: upload,
                            read_bytes_per_second: read,
                            write_bytes_per_second: write,
                            ports: process.ports.clone(),
                        }
                    })
                    .collect();
                previous_counters = counters;
                let metrics = MetricsView {
                    hostname: snapshot.host.hostname.clone(),
                    os: snapshot.host.os.clone(),
                    cpu_brand: snapshot.cpu.brand.clone(),
                    cpu_cores: snapshot.cpu.cores as u32,
                    cpu_usage_percent: snapshot.cpu.usage_percent,
                    memory_used_bytes: snapshot.memory.used_bytes,
                    memory_total_bytes: snapshot.memory.total_bytes,
                    download_bytes_per_second: snapshot.network.download_bytes_per_second,
                    upload_bytes_per_second: snapshot.network.upload_bytes_per_second,
                    disk_used_bytes: snapshot.disk.used_bytes,
                    disk_total_bytes: snapshot.disk.total_bytes,
                    disk_read_bytes_per_second: snapshot.disk.read_bytes_per_second,
                    disk_write_bytes_per_second: snapshot.disk.write_bytes_per_second,
                };
                if let Ok(mut monitor) = shared.lock() {
                    monitor.metrics = Some(metrics);
                    monitor.processes = processes;
                    monitor.captured_at = snapshot.captured_at.clone();
                }
                if events.send(Event::Refresh).is_err() {
                    return;
                }
            }
            match refresh.recv_timeout(Duration::from_secs(5)) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn preview_text(text: &str) -> String {
    let value: Vec<char> = text.chars().collect();
    if value.len() <= 150 {
        return text.to_string();
    }
    let head: String = value[..100].iter().collect();
    let tail: String = value[value.len() - 50..].iter().collect();
    format!("{head}…\n…{tail}")
}

fn clipboard_preview(entry: &crate::clipboard::ClipboardEntry) -> String {
    if entry.kind == "image" {
        let mut parts = Vec::new();
        if let (Some(width), Some(height)) = (entry.width, entry.height) {
            parts.push(format!("{width}×{height}"));
        }
        if parts.is_empty() {
            "Image".to_string()
        } else {
            format!("Image · {}", parts.join(" · "))
        }
    } else {
        preview_text(entry.text.as_deref().unwrap_or(""))
    }
}

impl LocalHost {
    pub fn start(events: Sender<Event>) -> Result<LocalHost, String> {
        let mut state = SessionState::new("~");
        if let Ok(init) = crate::workspace::initialize() {
            let items: Vec<(String, String)> = init
                .configuration
                .get("workspaceSession")
                .and_then(|session| session.get("items"))
                .and_then(|items| items.as_array())
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            (
                                item.get("title").and_then(|value| value.as_str()).unwrap_or("").to_string(),
                                item.get("path").and_then(|value| value.as_str()).unwrap_or("").to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            state.restore_workspaces(&items);
        }
        state.add_info(
            "info",
            "Standalone session",
            "No Auri app is running: terminals live inside this CLI and end with it.",
        );

        let monitor = Arc::new(Mutex::new(SharedMonitor::default()));
        let (refresh_system, refresh_receiver) = channel();
        spawn_monitor_thread(monitor.clone(), events.clone(), refresh_receiver);
        let clipboard_items = crate::clipboard::read_history().unwrap_or_default();

        Ok(LocalHost {
            state,
            ptys: HashMap::new(),
            buffers: Arc::new(Mutex::new(HashMap::new())),
            monitor,
            clipboard_items,
            events,
            refresh_system,
            panel_size: (80, 24),
            seq: 0,
        })
    }

    pub fn set_panel_size(&mut self, cols: u16, rows: u16) {
        let size = (cols.max(20), rows.max(4));
        if size == self.panel_size {
            return;
        }
        self.panel_size = size;
        for pty in self.ptys.values() {
            let _ = pty.master.resize(PtySize {
                rows: size.1,
                cols: size.0,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn resize_pty(&mut self, subtab_id: &str, cols: u16, rows: u16) {
        if let Some(pty) = self.ptys.get(subtab_id) {
            let _ = pty.master.resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    fn subtab_cwd(&self, subtab_id: &str) -> String {
        self.state
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.subtabs.iter())
            .find(|subtab| subtab.id == subtab_id)
            .map(|subtab| subtab.cwd.clone())
            .unwrap_or_else(|| "~".to_string())
    }

    pub fn ensure_pty(&mut self, subtab_id: &str) -> Result<(), String> {
        if let Some(pty) = self.ptys.get_mut(subtab_id) {
            match pty.child.try_wait() {
                Ok(None) => return Ok(()),
                _ => {
                    self.ptys.remove(subtab_id);
                }
            }
        }
        let cwd = self.subtab_cwd(subtab_id);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: self.panel_size.1,
                cols: self.panel_size.0,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not create terminal: {error}"))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut command = CommandBuilder::new(shell);
        command.cwd(crate::workspace::expand_path(&cwd)?);
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

        let buffers = self.buffers.clone();
        let events = self.events.clone();
        let id = subtab_id.to_string();
        thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if let Ok(mut buffers) = buffers.lock() {
                            let buffer = buffers.entry(id.clone()).or_default();
                            append_utf8(&mut pending, &chunk[..count], buffer);
                            if buffer.len() > BUFFER_MAX_CHARS {
                                let cut = buffer.len() - BUFFER_MAX_CHARS;
                                let boundary = (cut..buffer.len().min(cut + 4))
                                    .find(|index| buffer.is_char_boundary(*index))
                                    .unwrap_or(buffer.len());
                                buffer.drain(..boundary);
                            }
                        }
                        crate::term_bridge::forward(&id, &chunk[..count]);
                        if events.send(Event::Refresh).is_err() {
                            break;
                        }
                    }
                }
            }
            crate::term_bridge::clear(&id);
            if let Ok(mut buffers) = buffers.lock() {
                buffers
                    .entry(id.clone())
                    .or_default()
                    .push_str("\r\n[terminal session ended]\r\n");
            }
            let _ = events.send(Event::Refresh);
        });

        self.ptys.insert(
            subtab_id.to_string(),
            LocalPty { writer, master: pair.master, child },
        );
        Ok(())
    }

    pub fn write_pty(&mut self, subtab_id: &str, bytes: &[u8]) -> Result<(), String> {
        let pty = self
            .ptys
            .get_mut(subtab_id)
            .ok_or("Terminal session is not running.")?;
        pty.writer
            .write_all(bytes)
            .and_then(|_| pty.writer.flush())
            .map_err(|error| format!("Could not write to terminal: {error}"))
    }

    pub fn attach(&mut self, subtab_id: &str) -> Result<Receiver<Vec<u8>>, String> {
        self.ensure_pty(subtab_id)?;
        Ok(crate::term_bridge::attach(subtab_id))
    }

    pub fn reload_clipboard(&mut self) {
        if let Ok(items) = crate::clipboard::read_history() {
            self.clipboard_items = items;
        }
    }

    /// Execute a registry-style command locally. Returns a short status note.
    pub fn execute(&mut self, input: &str) -> Result<String, String> {
        let effect = self.state.apply(input)?;
        match effect {
            Effect::None => Ok(String::new()),
            Effect::RunTerminal { subtab_id, command } => {
                self.ensure_pty(&subtab_id)?;
                self.write_pty(&subtab_id, format!("{command}\r").as_bytes())?;
                Ok(String::new())
            }
            Effect::ChangeDirectory { subtab_id, path } => {
                self.ensure_pty(&subtab_id)?;
                self.write_pty(&subtab_id, format!("cd {}\r", shell_quote(&path)).as_bytes())?;
                Ok(String::new())
            }
            Effect::CopyText(text) => {
                crate::clipboard::set_text(&text)?;
                Ok("copied".to_string())
            }
            Effect::CopyClipboardItem(id) => {
                crate::clipboard::prepare_paste(&id)?;
                self.reload_clipboard();
                Ok("copied item".to_string())
            }
            Effect::SetClipboardPinned { id, pinned } => {
                self.clipboard_items = crate::clipboard::set_pinned(&id, pinned)?;
                Ok(String::new())
            }
            Effect::RemoveClipboardItem(id) => {
                self.clipboard_items = crate::clipboard::remove_entry(&id)?;
                Ok(String::new())
            }
            Effect::RefreshSystem => {
                let _ = self.refresh_system.send(());
                Ok(String::new())
            }
            Effect::ClosedSubtabs(ids) => {
                for id in ids {
                    if let Some(mut pty) = self.ptys.remove(&id) {
                        let _ = pty.child.kill();
                    }
                    crate::term_bridge::clear(&id);
                    if let Ok(mut buffers) = self.buffers.lock() {
                        buffers.remove(&id);
                    }
                }
                Ok(String::new())
            }
        }
    }

    pub fn to_snapshot(&mut self) -> SnapshotView {
        self.seq += 1;
        let buffers = self.buffers.lock().ok();
        let mut terminals = HashMap::new();
        let workspaces: Vec<WorkspaceView> = self
            .state
            .workspaces
            .iter()
            .map(|workspace| {
                let active = workspace.id == self.state.active_tab_id;
                let subtabs: Vec<SubtabView> = workspace
                    .subtabs
                    .iter()
                    .map(|subtab| {
                        if subtab.kind == "terminal" {
                            if let Some(text) = buffers.as_ref().and_then(|buffers| buffers.get(&subtab.id)) {
                                terminals.insert(
                                    subtab.id.clone(),
                                    TerminalBufferView {
                                        // Local attach targets the subtab id directly.
                                        session_id: subtab.id.clone(),
                                        text: text.clone(),
                                    },
                                );
                            }
                        }
                        SubtabView {
                            id: subtab.id.clone(),
                            kind: subtab.kind.clone(),
                            title: subtab.title.clone(),
                            active: subtab.id == workspace.active_subtab_id,
                            cwd: Some(subtab.cwd.clone()),
                            url: None,
                        }
                    })
                    .collect();
                WorkspaceView {
                    id: workspace.id.clone(),
                    title: workspace.title.clone(),
                    active,
                    active_subtab_id: workspace.active_subtab_id.clone(),
                    folder_path: workspace.folder_path.clone(),
                    terminal_cwd: workspace
                        .active_subtab()
                        .filter(|subtab| subtab.kind == "terminal")
                        .or_else(|| workspace.first_terminal())
                        .map(|subtab| subtab.cwd.clone())
                        .unwrap_or_else(|| workspace.folder_path.clone()),
                    terminal_running: false,
                    subtabs,
                }
            })
            .collect();

        let monitor = self.monitor.lock().ok();
        let (metrics, processes, process_count) = match monitor.as_ref() {
            Some(monitor) => {
                let filtered = filter_processes(&monitor.processes, &self.state.system_filter);
                let count = filtered.len();
                let mut sorted = filtered;
                sort_processes(&mut sorted, &self.state.system_sort_by, &self.state.system_sort_direction);
                sorted.truncate(500);
                (monitor.metrics.clone(), sorted, count)
            }
            None => (None, Vec::new(), 0),
        };

        let active_workspace = workspaces.iter().find(|workspace| workspace.active);
        SnapshotView {
            seq: self.seq,
            active_tab_id: self.state.active_tab_id.clone(),
            active_subtab_id: active_workspace
                .map(|workspace| workspace.active_subtab_id.clone())
                .unwrap_or_default(),
            workspaces,
            terminals,
            system: SystemView {
                status: if metrics.is_some() { "ready" } else { "loading" }.to_string(),
                sort_by: self.state.system_sort_by.clone(),
                sort_direction: self.state.system_sort_direction.clone(),
                filter: self.state.system_filter.clone(),
                selected_pid: self.state.selected_pid,
                process_count,
                metrics,
                processes: processes
                    .into_iter()
                    .map(|process| ProcessView {
                        pid: process.pid,
                        name: process.name,
                        cpu_percent: process.cpu_percent,
                        memory_bytes: process.memory_bytes,
                        download_bytes_per_second: process.download_bytes_per_second,
                        upload_bytes_per_second: process.upload_bytes_per_second,
                        read_bytes_per_second: process.read_bytes_per_second,
                        write_bytes_per_second: process.write_bytes_per_second,
                        ports: process.ports,
                        priority: Some(process.priority),
                    })
                    .collect(),
            },
            info: InfoView {
                unread: self.state.info_items.len() as u32,
                items: self
                    .state
                    .info_items
                    .iter()
                    .map(|(level, title, message)| InfoItemView {
                        at: String::new(),
                        title: title.clone(),
                        message: message.clone(),
                        level: level.clone(),
                    })
                    .collect(),
            },
            clipboard_count: self.clipboard_items.len(),
            clipboard_items: self
                .clipboard_items
                .iter()
                .map(|entry| ClipboardItemView {
                    id: entry.id.clone(),
                    kind: entry.kind.clone(),
                    pinned: entry.pinned,
                    preview: clipboard_preview(entry),
                })
                .collect(),
        }
    }
}
