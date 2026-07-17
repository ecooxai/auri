//! The `auri cli` event loop. Two backends share one UI: with a running GUI
//! it mirrors the app over the command socket; without one it hosts local
//! sessions itself (tmux-style, see `local`). Mouse: click tabs to focus,
//! click monitor columns to sort, wheel to scroll, drag to select — a
//! selection longer than three characters is copied after two seconds.

use super::input::{parse_events, Event as InputEvent, Key, Mouse, MouseKind};
use super::screen::{self, Action, Frame, Mode, Selection, UiState};
use super::view_model::SnapshotView;
use super::{ansi, client, local, model, term};
use std::io::{BufRead, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const DETACH_BYTE: u8 = 0x1d; // Ctrl+]
const ATTACH_TAIL_LINES: usize = 24;
const COPY_DELAY: Duration = Duration::from_secs(2);
const COPY_MIN_CHARS: usize = 4;

pub enum Event {
    Snapshot(Box<SnapshotView>),
    WatchDown(String),
    Input(Vec<u8>),
    StdinClosed,
    AttachEnded,
    Refresh,
}

enum Backend {
    Remote,
    Local(local::LocalHost),
}

enum AttachState {
    Remote(UnixStream),
    Local {
        subtab_id: String,
        done: Arc<AtomicBool>,
    },
}

fn spawn_watch_thread(sender: Sender<Event>) {
    thread::spawn(move || loop {
        match client::open_state_watch() {
            Ok(mut reader) => {
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue; // heartbeat
                            }
                            if let Ok(snapshot) = model::parse_snapshot(trimmed) {
                                if sender.send(Event::Snapshot(Box::new(snapshot))).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                if sender
                    .send(Event::WatchDown("Auri app disconnected.".to_string()))
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => {
                if sender.send(Event::WatchDown(error)).is_err() {
                    return;
                }
            }
        }
        thread::sleep(Duration::from_secs(1));
    });
}

fn spawn_stdin_thread(sender: Sender<Event>) {
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut handle = stdin.lock();
        let mut buffer = [0_u8; 1024];
        loop {
            match handle.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    let _ = sender.send(Event::StdinClosed);
                    return;
                }
                Ok(count) => {
                    if sender.send(Event::Input(buffer[..count].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

fn workspace_neighbor(snapshot: &SnapshotView, delta: i64) -> Option<String> {
    let index = snapshot
        .workspaces
        .iter()
        .position(|workspace| workspace.id == snapshot.active_tab_id)? as i64;
    let count = snapshot.workspaces.len() as i64;
    let next = (index + delta).rem_euclid(count.max(1));
    Some(snapshot.workspaces.get(next as usize)?.id.clone())
}

fn subtab_neighbor(snapshot: &SnapshotView, delta: i64) -> Option<String> {
    let workspace = snapshot.active_workspace()?;
    let index = workspace
        .subtabs
        .iter()
        .position(|subtab| subtab.id == workspace.active_subtab_id)? as i64;
    let count = workspace.subtabs.len() as i64;
    let next = (index + delta).rem_euclid(count.max(1));
    Some(workspace.subtabs.get(next as usize)?.id.clone())
}

fn cycle_sort(current: &str) -> &'static str {
    const ORDER: [&str; 7] = ["cpu", "ram", "net", "disk", "pid", "name", "port"];
    let index = ORDER.iter().position(|sort| *sort == current).unwrap_or(0);
    ORDER[(index + 1) % ORDER.len()]
}

struct App {
    backend: Backend,
    snapshot: SnapshotView,
    ui: UiState,
    frame_plain: Vec<String>,
    frame_regions: Vec<screen::Region>,
    attach: Option<AttachState>,
    size: (u16, u16),
    dirty: bool,
    quit: bool,
    press: Option<(usize, usize)>,
    dragging: bool,
    pending_copy: Option<(String, Instant)>,
    sender: Sender<Event>,
}

impl App {
    fn active_panel_kind(&self) -> String {
        self.snapshot
            .active_subtab()
            .map(|subtab| subtab.kind.clone())
            .unwrap_or_default()
    }

    fn rebuild_local_snapshot(&mut self) {
        if let Backend::Local(host) = &mut self.backend {
            self.snapshot = host.to_snapshot();
            self.dirty = true;
        }
    }

    fn send(&mut self, command: &str) {
        let result = match &mut self.backend {
            Backend::Remote => client::send_quiet_command(command).map(|_| String::new()),
            Backend::Local(host) => host.execute(command),
        };
        match result {
            Ok(note) => {
                self.ui.status = if note.is_empty() { format!("✓ {command}") } else { format!("✓ {note}") };
            }
            Err(error) => {
                self.ui.status = format!("✗ {error}");
            }
        }
        self.rebuild_local_snapshot();
        self.dirty = true;
    }

    fn copy_text(&mut self, text: &str) {
        let encoded = crate::util::encode_base64(text.as_bytes());
        let result = match &mut self.backend {
            Backend::Remote => client::send_copy_base64(&encoded),
            Backend::Local(_) => crate::clipboard::set_text(text),
        };
        match result {
            Ok(()) => {
                self.ui.status = "Copied selection".to_string();
            }
            Err(_) => {
                // Last resort: ask the hosting terminal to copy (OSC 52).
                term::osc52_copy(&encoded);
                self.ui.status = "Copied via terminal".to_string();
            }
        }
        self.dirty = true;
    }

    fn panel_area(&self) -> (u16, u16) {
        let width = self.size.0.max(20);
        let height = self.size.1.max(6);
        (width, height.saturating_sub(5).max(4))
    }

    fn start_attach(&mut self) {
        let Some(subtab) = self
            .snapshot
            .active_subtab()
            .filter(|subtab| subtab.kind == "terminal")
            .cloned()
        else {
            self.ui.status = "Select a terminal subtab to attach.".to_string();
            self.dirty = true;
            return;
        };
        let tail = self
            .snapshot
            .terminals
            .get(&subtab.id)
            .map(|buffer| ansi::sanitize_terminal_text(&buffer.text))
            .unwrap_or_default();

        let attach = match &mut self.backend {
            Backend::Remote => {
                let session_id = self
                    .snapshot
                    .terminals
                    .get(&subtab.id)
                    .map(|buffer| buffer.session_id.clone())
                    .unwrap_or_default();
                if session_id.is_empty() {
                    self.ui.status =
                        "Terminal has not started yet — run a command first.".to_string();
                    self.dirty = true;
                    return;
                }
                match client::open_terminal_attach(&session_id) {
                    Ok(stream) => {
                        if let Ok(mut reader) = stream.try_clone() {
                            let done = self.sender.clone();
                            thread::spawn(move || {
                                let mut stdout = std::io::stdout();
                                let mut buffer = [0_u8; 8192];
                                loop {
                                    match reader.read(&mut buffer) {
                                        Ok(0) | Err(_) => break,
                                        Ok(count) => {
                                            if stdout.write_all(&buffer[..count]).is_err() {
                                                break;
                                            }
                                            let _ = stdout.flush();
                                        }
                                    }
                                }
                                let _ = done.send(Event::AttachEnded);
                            });
                        }
                        AttachState::Remote(stream)
                    }
                    Err(error) => {
                        self.ui.status = format!("✗ attach: {error}");
                        self.dirty = true;
                        return;
                    }
                }
            }
            Backend::Local(host) => {
                let receiver = match host.attach(&subtab.id) {
                    Ok(receiver) => receiver,
                    Err(error) => {
                        self.ui.status = format!("✗ attach: {error}");
                        self.dirty = true;
                        return;
                    }
                };
                // The local PTY gets the whole real terminal while attached.
                host.resize_pty(&subtab.id, self.size.0, self.size.1);
                let done = Arc::new(AtomicBool::new(false));
                let thread_done = done.clone();
                let notify = self.sender.clone();
                thread::spawn(move || {
                    let mut stdout = std::io::stdout();
                    loop {
                        match receiver.recv_timeout(Duration::from_millis(500)) {
                            Ok(bytes) => {
                                if stdout.write_all(&bytes).is_err() {
                                    break;
                                }
                                let _ = stdout.flush();
                            }
                            Err(RecvTimeoutError::Timeout) => {
                                if thread_done.load(Ordering::Relaxed) {
                                    break;
                                }
                            }
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    let _ = notify.send(Event::AttachEnded);
                });
                AttachState::Local { subtab_id: subtab.id.clone(), done }
            }
        };

        term::leave_ui_screen();
        let mut stdout = std::io::stdout();
        let start = tail.len().saturating_sub(ATTACH_TAIL_LINES);
        for line in &tail[start..] {
            let _ = stdout.write_all(line.as_bytes());
            let _ = stdout.write_all(b"\r\n");
        }
        let _ = stdout.write_all(
            b"\x1b[7m attached \xe2\x80\x94 Ctrl+] detaches \x1b[0m\r\n",
        );
        let _ = stdout.flush();
        self.attach = Some(attach);
    }

    fn end_attach(&mut self, reason: &str) {
        match self.attach.take() {
            Some(AttachState::Remote(stream)) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            Some(AttachState::Local { subtab_id, done }) => {
                done.store(true, Ordering::Relaxed);
                let (cols, rows) = self.panel_area();
                if let Backend::Local(host) = &mut self.backend {
                    host.set_panel_size(cols, rows);
                    host.resize_pty(&subtab_id, cols, rows.saturating_sub(1));
                }
            }
            None => {}
        }
        term::enter_ui_screen();
        self.ui.status = reason.to_string();
        self.rebuild_local_snapshot();
        self.dirty = true;
    }

    fn handle_attached_input(&mut self, bytes: &[u8]) {
        let detach_at = bytes.iter().position(|byte| *byte == DETACH_BYTE);
        let payload = &bytes[..detach_at.unwrap_or(bytes.len())];
        match self.attach.as_mut() {
            Some(AttachState::Remote(stream)) => {
                let _ = stream.write_all(payload);
            }
            Some(AttachState::Local { subtab_id, .. }) => {
                let subtab_id = subtab_id.clone();
                if let Backend::Local(host) = &mut self.backend {
                    let _ = host.write_pty(&subtab_id, payload);
                }
            }
            None => {}
        }
        if detach_at.is_some() {
            self.end_attach("detached");
        }
    }

    fn clear_selection(&mut self) {
        if self.ui.selection.is_some() || self.pending_copy.is_some() {
            self.ui.selection = None;
            self.pending_copy = None;
            self.dirty = true;
        }
    }

    fn run_click_action(&mut self, action: Action) {
        match action {
            Action::SelectWorkspace(id) => self.send(&format!("tab select {id}")),
            Action::SelectSubtab(id) => {
                self.ui.terminal_scroll = 0;
                self.ui.process_scroll = 0;
                self.ui.clipboard_scroll = 0;
                self.send(&format!("subtab select {id}"));
                if let Backend::Local(host) = &mut self.backend {
                    host.reload_clipboard();
                    self.rebuild_local_snapshot();
                }
            }
            Action::SortBy(key) => self.send(&format!("system sort {key}")),
            Action::FocusTerminal => {
                self.ui.mode = Mode::RunCommand;
                self.ui.input.clear();
                self.dirty = true;
            }
            Action::SelectProcess(pid) => self.send(&format!("system select {pid}")),
            Action::CopyClipboardItem(id) => self.send(&format!("clipboard copy-item {id}")),
            Action::SystemArea | Action::ClipboardArea => {}
        }
    }

    fn scroll_area_at(&self, x: usize, y: usize) -> Option<Action> {
        self.frame_regions
            .iter()
            .filter(|region| {
                y >= region.y && y < region.y + region.height && x >= region.x && x < region.x + region.width
            })
            .map(|region| region.action.clone())
            .find(|action| {
                matches!(action, Action::FocusTerminal | Action::SystemArea | Action::ClipboardArea)
            })
    }

    fn handle_wheel(&mut self, mouse: Mouse, up: bool) {
        let step = 3_usize;
        match self.scroll_area_at(mouse.x as usize, mouse.y as usize) {
            Some(Action::FocusTerminal) => {
                let lines = self
                    .snapshot
                    .active_subtab()
                    .and_then(|subtab| self.snapshot.terminals.get(&subtab.id))
                    .map(|buffer| buffer.text.matches('\n').count() + 1)
                    .unwrap_or(0);
                if up {
                    self.ui.terminal_scroll = (self.ui.terminal_scroll + step).min(lines.saturating_sub(1));
                } else {
                    self.ui.terminal_scroll = self.ui.terminal_scroll.saturating_sub(step);
                }
            }
            Some(Action::SystemArea) => {
                let count = self.snapshot.system.processes.len();
                if up {
                    self.ui.process_scroll = self.ui.process_scroll.saturating_sub(step);
                } else {
                    self.ui.process_scroll = (self.ui.process_scroll + step).min(count.saturating_sub(1));
                }
            }
            Some(Action::ClipboardArea) => {
                let count = self.snapshot.clipboard_items.len();
                if up {
                    self.ui.clipboard_scroll = self.ui.clipboard_scroll.saturating_sub(1);
                } else {
                    self.ui.clipboard_scroll = (self.ui.clipboard_scroll + 1).min(count.saturating_sub(1));
                }
            }
            _ => return,
        }
        self.dirty = true;
    }

    fn handle_mouse(&mut self, mouse: Mouse) {
        let point = (mouse.x as usize, mouse.y as usize);
        match mouse.kind {
            MouseKind::WheelUp => self.handle_wheel(mouse, true),
            MouseKind::WheelDown => self.handle_wheel(mouse, false),
            MouseKind::Press => {
                self.clear_selection();
                self.press = Some(point);
                self.dragging = false;
            }
            MouseKind::Drag => {
                if let Some(anchor) = self.press {
                    if anchor != point || self.dragging {
                        self.dragging = true;
                        self.ui.selection = Some(Selection { start: anchor, end: point });
                        self.dirty = true;
                    }
                }
            }
            MouseKind::Release => {
                let Some(anchor) = self.press.take() else {
                    return;
                };
                if self.dragging {
                    self.dragging = false;
                    let text = screen::selection_text(&self.frame_plain, anchor, point);
                    if text.chars().count() >= COPY_MIN_CHARS {
                        self.pending_copy = Some((text, Instant::now() + COPY_DELAY));
                        self.ui.status = "Selection copies in 2 s — click to cancel".to_string();
                    } else {
                        self.ui.selection = None;
                    }
                    self.dirty = true;
                } else {
                    let action = screen::hit_test(&self.frame_regions, point.0, point.1).cloned();
                    if let Some(action) = action {
                        self.run_click_action(action);
                    }
                }
            }
        }
    }

    fn handle_text_mode_key(&mut self, key: Key) {
        match key {
            Key::Escape => {
                self.ui.mode = Mode::Normal;
                self.ui.input.clear();
            }
            Key::Backspace => {
                self.ui.input.pop();
            }
            Key::Enter => {
                let input = std::mem::take(&mut self.ui.input);
                let mode = self.ui.mode;
                self.ui.mode = Mode::Normal;
                match mode {
                    Mode::Command => {
                        if !input.trim().is_empty() {
                            self.send(input.trim());
                        }
                    }
                    Mode::RunCommand => {
                        if !input.trim().is_empty() {
                            self.ui.terminal_scroll = 0;
                            self.send(&format!("terminal run {input}"));
                            // Stay ready for the next command, like a prompt.
                            self.ui.mode = Mode::RunCommand;
                        }
                    }
                    Mode::Search => {
                        self.send(&format!("system search {input}"));
                    }
                    Mode::Normal => {}
                }
            }
            Key::Char(character) => self.ui.input.push(character),
            Key::Tab => self.ui.input.push(' '),
            _ => {}
        }
        self.dirty = true;
    }

    fn handle_normal_key(&mut self, key: Key) {
        let panel = self.active_panel_kind();
        match key {
            Key::Char('q') | Key::CtrlC => self.quit = true,
            Key::Up | Key::Char('k') => {
                if let Some(id) = workspace_neighbor(&self.snapshot, -1) {
                    self.send(&format!("tab select {id}"));
                }
            }
            Key::Down | Key::Char('j') => {
                if let Some(id) = workspace_neighbor(&self.snapshot, 1) {
                    self.send(&format!("tab select {id}"));
                }
            }
            Key::Left | Key::Char('h') => {
                if let Some(id) = subtab_neighbor(&self.snapshot, -1) {
                    self.run_click_action(Action::SelectSubtab(id));
                }
            }
            Key::Right | Key::Char('l') | Key::Tab => {
                if let Some(id) = subtab_neighbor(&self.snapshot, 1) {
                    self.run_click_action(Action::SelectSubtab(id));
                }
            }
            Key::Char(':') => {
                self.ui.mode = Mode::Command;
                self.ui.input.clear();
                self.dirty = true;
            }
            Key::Char('g') => {
                if matches!(self.backend, Backend::Remote) {
                    self.ui.status = match client::focus_gui() {
                        Ok(()) => "GUI focused".to_string(),
                        Err(error) => format!("✗ {error}"),
                    };
                } else {
                    self.ui.status = "No GUI is running.".to_string();
                }
                self.dirty = true;
            }
            Key::Char('r') | Key::Enter if panel == "terminal" => {
                self.ui.mode = Mode::RunCommand;
                self.ui.input.clear();
                self.dirty = true;
            }
            Key::Char('a') if panel == "terminal" => self.start_attach(),
            Key::PageUp if panel == "terminal" => {
                self.handle_wheel(Mouse { kind: MouseKind::WheelUp, x: 0, y: 6 }, true);
            }
            Key::PageDown if panel == "terminal" => {
                self.handle_wheel(Mouse { kind: MouseKind::WheelDown, x: 0, y: 6 }, false);
            }
            Key::Char('s') if matches!(panel.as_str(), "system" | "disk" | "net") => {
                let next = cycle_sort(&self.snapshot.system.sort_by);
                self.send(&format!("system sort {next}"));
            }
            Key::Char('/') if matches!(panel.as_str(), "system" | "disk" | "net") => {
                self.ui.mode = Mode::Search;
                self.ui.input = self.snapshot.system.filter.clone();
                self.dirty = true;
            }
            Key::Char('R') if matches!(panel.as_str(), "system" | "disk" | "net") => {
                self.send("system refresh");
            }
            Key::Char('c') if panel == "info" => self.send("info clear"),
            Key::Escape => {
                self.clear_selection();
                self.ui.status.clear();
                self.dirty = true;
            }
            _ => {}
        }
    }

    fn handle_input(&mut self, bytes: Vec<u8>) {
        if self.attach.is_some() {
            self.handle_attached_input(&bytes);
            return;
        }
        for event in parse_events(&bytes) {
            if self.quit {
                break;
            }
            match event {
                InputEvent::Mouse(mouse) => self.handle_mouse(mouse),
                InputEvent::Key(key) => match self.ui.mode {
                    Mode::Normal => self.handle_normal_key(key),
                    _ => self.handle_text_mode_key(key),
                },
            }
        }
    }

    fn handle_event(&mut self, event: Event) {
        match event {
            Event::Snapshot(snapshot) => {
                if self.ui.connected && self.ui.status.starts_with('✓') {
                    self.ui.status.clear();
                }
                self.ui.connected = true;
                self.snapshot = *snapshot;
                self.dirty = true;
            }
            Event::WatchDown(reason) => {
                self.ui.connected = false;
                self.ui.status = reason;
                self.dirty = true;
            }
            Event::Refresh => {
                self.rebuild_local_snapshot();
            }
            Event::Input(bytes) => self.handle_input(bytes),
            Event::StdinClosed => self.quit = true,
            Event::AttachEnded => {
                if self.attach.is_some() {
                    self.end_attach("terminal session ended");
                }
            }
        }
    }

    fn tick(&mut self) {
        if let Some((text, deadline)) = self.pending_copy.clone() {
            if Instant::now() >= deadline {
                self.pending_copy = None;
                self.ui.selection = None;
                self.copy_text(&text);
            }
        }
        let size = term::terminal_size();
        if size != self.size {
            self.size = size;
            let (cols, rows) = self.panel_area();
            if self.attach.is_none() {
                if let Backend::Local(host) = &mut self.backend {
                    host.set_panel_size(cols, rows.saturating_sub(1));
                }
            }
            self.dirty = true;
        }
    }

    fn draw(&mut self) {
        if !self.dirty || self.attach.is_some() || self.quit {
            return;
        }
        let Frame { text, plain, regions } = screen::render_frame(&self.snapshot, &self.ui, self.size);
        term::draw_frame(&text);
        self.frame_plain = plain;
        self.frame_regions = regions;
        self.dirty = false;
    }
}

fn event_loop(receiver: &Receiver<Event>, mut app: App) {
    while !app.quit {
        match receiver.recv_timeout(Duration::from_millis(120)) {
            Ok(event) => {
                app.handle_event(event);
                // Coalesce bursts (fast terminal output, drags) into one draw.
                while let Ok(event) = receiver.try_recv() {
                    app.handle_event(event);
                    if app.quit {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        app.tick();
        app.draw();
    }
    if app.attach.is_some() {
        app.end_attach("");
    }
}

pub fn run() -> Result<(), String> {
    let (sender, receiver) = channel::<Event>();

    let backend = match client::connect_to_running_instance() {
        Ok(_) => {
            spawn_watch_thread(sender.clone());
            Backend::Remote
        }
        Err(_) => Backend::Local(local::LocalHost::start(sender.clone())?),
    };
    spawn_stdin_thread(sender.clone());

    let mut app = App {
        backend,
        snapshot: SnapshotView::default(),
        ui: UiState {
            connected: true,
            standalone: false,
            status: String::new(),
            ..UiState::default()
        },
        frame_plain: Vec::new(),
        frame_regions: Vec::new(),
        attach: None,
        size: term::terminal_size(),
        dirty: true,
        quit: false,
        press: None,
        dragging: false,
        pending_copy: None,
        sender,
    };

    match &mut app.backend {
        Backend::Remote => {
            if let Ok(json) = client::fetch_state() {
                if let Ok(snapshot) = model::parse_snapshot(&json) {
                    app.snapshot = snapshot;
                }
            } else {
                app.ui.status = "waiting for the Auri app state…".to_string();
            }
        }
        Backend::Local(host) => {
            app.ui.standalone = true;
            let size = term::terminal_size();
            host.set_panel_size(size.0, size.1.saturating_sub(6));
            app.snapshot = host.to_snapshot();
        }
    }

    let raw = term::RawMode::enable()?;
    term::enter_ui_screen();
    event_loop(&receiver, app);
    term::leave_ui_screen();
    drop(raw);
    Ok(())
}
