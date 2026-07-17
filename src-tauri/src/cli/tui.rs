//! The `auri cli` event loop: watches the app-state stream, renders frames,
//! and turns keys into Auri commands sent back over the socket. The terminal
//! subtab additionally offers a raw attach onto the shared PTY session.

use super::input::{parse_keys, Key};
use super::screen::{self, Mode, UiState};
use super::view_model::SnapshotView;
use super::{ansi, client, model, term};
use std::io::{BufRead, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

const DETACH_BYTE: u8 = 0x1d; // Ctrl+]
const ATTACH_TAIL_LINES: usize = 24;

enum Event {
    Snapshot(Box<SnapshotView>),
    WatchDown(String),
    Input(Vec<u8>),
    StdinClosed,
    AttachEnded,
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
                            match model::parse_snapshot(trimmed) {
                                Ok(snapshot) => {
                                    if sender.send(Event::Snapshot(Box::new(snapshot))).is_err() {
                                        return;
                                    }
                                }
                                Err(error) => {
                                    let _ = sender.send(Event::WatchDown(error));
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

struct Attach {
    stream: UnixStream,
}

struct App {
    snapshot: SnapshotView,
    ui: UiState,
    attach: Option<Attach>,
    size: (u16, u16),
    dirty: bool,
    quit: bool,
}

impl App {
    fn active_panel_kind(&self) -> String {
        self.snapshot
            .active_subtab()
            .map(|subtab| subtab.kind.clone())
            .unwrap_or_default()
    }

    fn send(&mut self, command: &str) {
        match client::send_quiet_command(command) {
            Ok(()) => {
                self.ui.status = format!("✓ {command}");
            }
            Err(error) => {
                self.ui.status = format!("✗ {error}");
            }
        }
        self.dirty = true;
    }

    fn start_attach(&mut self, sender: &Sender<Event>) {
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
        let session_id = self
            .snapshot
            .terminals
            .get(&subtab.id)
            .map(|buffer| buffer.session_id.clone())
            .unwrap_or_default();
        if session_id.is_empty() {
            self.ui.status =
                "Terminal has not started yet — press r to run a command first.".to_string();
            self.dirty = true;
            return;
        }
        let stream = match client::open_terminal_attach(&session_id) {
            Ok(stream) => stream,
            Err(error) => {
                self.ui.status = format!("✗ attach: {error}");
                self.dirty = true;
                return;
            }
        };

        term::leave_ui_screen();
        let mut stdout = std::io::stdout();
        let tail = self
            .snapshot
            .terminals
            .get(&subtab.id)
            .map(|buffer| ansi::sanitize_terminal_text(&buffer.text))
            .unwrap_or_default();
        let start = tail.len().saturating_sub(ATTACH_TAIL_LINES);
        for line in &tail[start..] {
            let _ = stdout.write_all(line.as_bytes());
            let _ = stdout.write_all(b"\r\n");
        }
        let _ = stdout.write_all(
            b"\x1b[7m attached to the shared Auri terminal \xe2\x80\x94 Ctrl+] detaches; size follows the GUI window \x1b[0m\r\n",
        );
        let _ = stdout.flush();

        if let Ok(mut reader) = stream.try_clone() {
            let done = sender.clone();
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
        self.attach = Some(Attach { stream });
    }

    fn end_attach(&mut self, reason: &str) {
        if let Some(attach) = self.attach.take() {
            let _ = attach.stream.shutdown(Shutdown::Both);
        }
        term::enter_ui_screen();
        self.ui.status = reason.to_string();
        self.dirty = true;
    }

    fn handle_attached_input(&mut self, bytes: &[u8]) {
        let Some(attach) = self.attach.as_mut() else {
            return;
        };
        if let Some(position) = bytes.iter().position(|byte| *byte == DETACH_BYTE) {
            let _ = attach.stream.write_all(&bytes[..position]);
            self.end_attach("detached");
        } else {
            let _ = attach.stream.write_all(bytes);
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
                            self.send(&format!("terminal run {input}"));
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

    fn handle_normal_key(&mut self, key: Key, sender: &Sender<Event>) {
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
                    self.send(&format!("subtab select {id}"));
                }
            }
            Key::Right | Key::Char('l') | Key::Tab => {
                if let Some(id) = subtab_neighbor(&self.snapshot, 1) {
                    self.send(&format!("subtab select {id}"));
                }
            }
            Key::Char(':') => {
                self.ui.mode = Mode::Command;
                self.ui.input.clear();
                self.dirty = true;
            }
            Key::Char('g') => {
                self.ui.status = match client::focus_gui() {
                    Ok(()) => "GUI focused".to_string(),
                    Err(error) => format!("✗ {error}"),
                };
                self.dirty = true;
            }
            Key::Char('r') | Key::Enter if panel == "terminal" => {
                self.ui.mode = Mode::RunCommand;
                self.ui.input.clear();
                self.dirty = true;
            }
            Key::Char('a') if panel == "terminal" => self.start_attach(sender),
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
                self.ui.status.clear();
                self.dirty = true;
            }
            _ => {}
        }
    }

    fn handle_input(&mut self, bytes: Vec<u8>, sender: &Sender<Event>) {
        if self.attach.is_some() {
            self.handle_attached_input(&bytes);
            return;
        }
        for key in parse_keys(&bytes) {
            if self.quit {
                break;
            }
            match self.ui.mode {
                Mode::Normal => self.handle_normal_key(key, sender),
                _ => self.handle_text_mode_key(key),
            }
        }
    }

    fn handle_event(&mut self, event: Event, sender: &Sender<Event>) {
        match event {
            Event::Snapshot(snapshot) => {
                if self.ui.connected {
                    // A fresh snapshot supersedes the last action note.
                    if self.ui.status.starts_with('✓') {
                        self.ui.status.clear();
                    }
                } else {
                    self.ui.connected = true;
                    self.ui.status.clear();
                }
                self.snapshot = *snapshot;
                self.dirty = true;
            }
            Event::WatchDown(reason) => {
                self.ui.connected = false;
                self.ui.status = reason;
                self.dirty = true;
            }
            Event::Input(bytes) => self.handle_input(bytes, sender),
            Event::StdinClosed => self.quit = true,
            Event::AttachEnded => {
                if self.attach.is_some() {
                    self.end_attach("terminal session ended");
                }
            }
        }
    }
}

fn event_loop(receiver: &Receiver<Event>, sender: &Sender<Event>) {
    let mut app = App {
        snapshot: SnapshotView::default(),
        ui: UiState {
            connected: false,
            status: "waiting for the Auri app state…".to_string(),
            ..UiState::default()
        },
        attach: None,
        size: term::terminal_size(),
        dirty: true,
        quit: false,
    };

    if let Ok(json) = client::fetch_state() {
        if let Ok(snapshot) = model::parse_snapshot(&json) {
            app.snapshot = snapshot;
            app.ui.connected = true;
            app.ui.status.clear();
        }
    }

    while !app.quit {
        match receiver.recv_timeout(Duration::from_millis(150)) {
            Ok(event) => {
                app.handle_event(event, sender);
                // Coalesce bursts (fast terminal output, key repeats) into one draw.
                while let Ok(event) = receiver.try_recv() {
                    app.handle_event(event, sender);
                    if app.quit {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let size = term::terminal_size();
        if size != app.size {
            app.size = size;
            app.dirty = true;
        }
        if app.dirty && app.attach.is_none() && !app.quit {
            term::draw_frame(&screen::render_frame(&app.snapshot, &app.ui, app.size));
            app.dirty = false;
        }
    }
    if app.attach.is_some() {
        app.end_attach("");
    }
}

pub fn run() -> Result<(), String> {
    client::connect_to_running_instance().map_err(|error| {
        format!("{error}\nauri cli mirrors the running Auri app — start the desktop app first.")
    })?;

    let (sender, receiver) = channel::<Event>();
    spawn_watch_thread(sender.clone());
    spawn_stdin_thread(sender.clone());

    let raw = term::RawMode::enable()?;
    term::enter_ui_screen();
    event_loop(&receiver, &sender);
    term::leave_ui_screen();
    drop(raw);
    Ok(())
}
