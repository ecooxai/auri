//! Local session state for `auri cli` when no GUI instance is running: the
//! TUI hosts workspaces, subtabs, and terminals itself, tmux-style. Pure
//! state and command routing only — PTYs, the system monitor, and the
//! clipboard are driven by the host through returned effects. Std-only so
//! the dependency-light Rust test harness can cover it.

#[derive(Debug, Clone)]
pub struct LocalSubtab {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub cwd: String,
}

#[derive(Debug, Clone)]
pub struct LocalWorkspace {
    pub id: String,
    pub title: String,
    pub folder_path: String,
    pub active_subtab_id: String,
    pub subtabs: Vec<LocalSubtab>,
}

impl LocalWorkspace {
    pub fn active_subtab(&self) -> Option<&LocalSubtab> {
        self.subtabs
            .iter()
            .find(|subtab| subtab.id == self.active_subtab_id)
            .or_else(|| self.subtabs.first())
    }

    pub fn first_terminal(&self) -> Option<&LocalSubtab> {
        self.subtabs.iter().find(|subtab| subtab.kind == "terminal")
    }
}

/// Side effects the host must perform after a state transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    None,
    RunTerminal { subtab_id: String, command: String },
    ChangeDirectory { subtab_id: String, path: String },
    CopyText(String),
    CopyClipboardItem(String),
    SetClipboardPinned { id: String, pinned: bool },
    RemoveClipboardItem(String),
    RefreshSystem,
    ClosedSubtabs(Vec<String>),
}

pub struct SessionState {
    pub workspaces: Vec<LocalWorkspace>,
    pub active_tab_id: String,
    pub system_sort_by: String,
    pub system_sort_direction: String,
    pub system_filter: String,
    pub selected_pid: Option<i64>,
    pub info_items: Vec<(String, String, String)>, // (level, title, message)
    next_id: u64,
    home: String,
}

const SUPPORTED_SUBTABS: [&str; 4] = ["terminal", "system", "clipboard", "info"];

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut escaping = false;
    for character in input.trim().chars() {
        if escaping {
            token.push(character);
            started = true;
            escaping = false;
            continue;
        }
        if character == '\\' {
            escaping = true;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            } else {
                token.push(character);
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            started = true;
            continue;
        }
        if character.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut token));
                started = false;
            }
            continue;
        }
        token.push(character);
        started = true;
    }
    if started {
        tokens.push(token);
    }
    tokens
}

/// The raw text after `<domain> <action> ` in the original input, preserving
/// quoting and punctuation (mirrors the GUI's raw-tail rule for shell text).
fn raw_tail<'a>(input: &'a str, domain: &str, action: &str) -> &'a str {
    let trimmed = input.trim();
    let without_prefix = trimmed
        .strip_prefix("auri ")
        .unwrap_or(trimmed)
        .trim_start();
    let Some(after_domain) = without_prefix.strip_prefix(domain) else {
        return "";
    };
    let after_domain = after_domain.trim_start();
    let Some(after_action) = after_domain.strip_prefix(action) else {
        return "";
    };
    after_action.trim_start()
}

impl SessionState {
    pub fn new(home: &str) -> Self {
        let mut state = SessionState {
            workspaces: Vec::new(),
            active_tab_id: String::new(),
            system_sort_by: "cpu".to_string(),
            system_sort_direction: "desc".to_string(),
            system_filter: String::new(),
            selected_pid: None,
            info_items: Vec::new(),
            next_id: 0,
            home: home.to_string(),
        };
        let workspace = state.create_workspace("Home", home, true);
        state.active_tab_id = workspace.id.clone();
        state.workspaces.push(workspace);
        state
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    fn create_subtab(&mut self, kind: &str, cwd: &str) -> LocalSubtab {
        let title = match kind {
            "terminal" => "Terminal",
            "system" => "System",
            "clipboard" => "Clipboard",
            "info" => "Info",
            other => other,
        };
        LocalSubtab {
            id: self.id("subtab"),
            kind: kind.to_string(),
            title: title.to_string(),
            cwd: cwd.to_string(),
        }
    }

    fn create_workspace(&mut self, title: &str, path: &str, include_system: bool) -> LocalWorkspace {
        let terminal = self.create_subtab("terminal", path);
        let terminal_id = terminal.id.clone();
        let mut subtabs = vec![terminal];
        if include_system {
            subtabs.push(self.create_subtab("system", path));
        }
        subtabs.push(self.create_subtab("clipboard", path));
        subtabs.push(self.create_subtab("info", path));
        LocalWorkspace {
            id: self.id("tab"),
            title: title.to_string(),
            folder_path: path.to_string(),
            active_subtab_id: terminal_id,
            subtabs,
        }
    }

    /// Restore workspaces from the saved GUI session (title + path pairs).
    pub fn restore_workspaces(&mut self, items: &[(String, String)]) {
        if items.is_empty() {
            return;
        }
        let mut workspaces = Vec::new();
        for (index, (title, path)) in items.iter().take(50).enumerate() {
            let fallback = if index == 0 { "Home".to_string() } else { format!("Space {}", index + 1) };
            let title = if title.trim().is_empty() { fallback } else { title.trim().to_string() };
            let path = if path.trim().is_empty() { self.home.clone() } else { path.trim().to_string() };
            workspaces.push(self.create_workspace(&title, &path, index == 0));
        }
        self.active_tab_id = workspaces[0].id.clone();
        self.workspaces = workspaces;
    }

    pub fn active_workspace(&self) -> Option<&LocalWorkspace> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.id == self.active_tab_id)
            .or_else(|| self.workspaces.first())
    }

    fn active_workspace_mut(&mut self) -> Option<&mut LocalWorkspace> {
        let id = self.active_tab_id.clone();
        if let Some(position) = self.workspaces.iter().position(|workspace| workspace.id == id) {
            return self.workspaces.get_mut(position);
        }
        self.workspaces.first_mut()
    }

    /// The terminal a `terminal run` targets: the active subtab when it is a
    /// terminal, otherwise the first terminal of the active workspace.
    pub fn target_terminal(&self) -> Option<&LocalSubtab> {
        let workspace = self.active_workspace()?;
        match workspace.active_subtab() {
            Some(subtab) if subtab.kind == "terminal" => Some(subtab),
            _ => workspace.first_terminal(),
        }
    }

    pub fn add_info(&mut self, level: &str, title: &str, message: &str) {
        self.info_items.insert(0, (level.to_string(), title.to_string(), message.to_string()));
        self.info_items.truncate(50);
    }

    fn select_or_create_subtab(&mut self, kind: &str) {
        let existing = self
            .active_workspace()
            .and_then(|workspace| workspace.subtabs.iter().find(|subtab| subtab.kind == kind))
            .map(|subtab| subtab.id.clone());
        match existing {
            Some(id) => {
                if let Some(workspace) = self.active_workspace_mut() {
                    workspace.active_subtab_id = id;
                }
            }
            None => {
                let cwd = self
                    .active_workspace()
                    .map(|workspace| workspace.folder_path.clone())
                    .unwrap_or_else(|| self.home.clone());
                let subtab = self.create_subtab(kind, &cwd);
                let id = subtab.id.clone();
                if let Some(workspace) = self.active_workspace_mut() {
                    workspace.subtabs.push(subtab);
                    workspace.active_subtab_id = id;
                }
            }
        }
    }

    pub fn apply(&mut self, input: &str) -> Result<Effect, String> {
        let tokens = tokenize(input);
        let mut tokens = tokens.as_slice();
        if tokens.first().is_some_and(|token| token.eq_ignore_ascii_case("auri")) {
            tokens = &tokens[1..];
        }
        let [domain, rest @ ..] = tokens else {
            return Err("Enter a command.".to_string());
        };
        let action = rest.first().map(String::as_str).unwrap_or("");
        let args = if rest.is_empty() { &[] as &[String] } else { &rest[1..] };

        match (domain.as_str(), action) {
            ("tab", "new") => {
                let title = if args.is_empty() {
                    format!("Space {}", self.workspaces.len() + 1)
                } else {
                    args.join(" ")
                };
                let path = self.home.clone();
                let workspace = self.create_workspace(&title, &path, false);
                self.active_tab_id = workspace.id.clone();
                self.workspaces.push(workspace);
                Ok(Effect::None)
            }
            ("tab", "select") => {
                let id = args.first().ok_or("Choose a tab id.")?;
                if !self.workspaces.iter().any(|workspace| &workspace.id == id) {
                    return Err(format!("Tab {id} was not found."));
                }
                self.active_tab_id = id.clone();
                Ok(Effect::None)
            }
            ("tab", "close") => {
                if self.workspaces.len() == 1 {
                    return Err("The last workspace stays open.".to_string());
                }
                let id = args.first().cloned().unwrap_or_else(|| self.active_tab_id.clone());
                let Some(position) = self.workspaces.iter().position(|workspace| workspace.id == id) else {
                    return Err(format!("Tab {id} was not found."));
                };
                let removed = self.workspaces.remove(position);
                if self.active_tab_id == id {
                    let fallback = position.saturating_sub(1);
                    self.active_tab_id = self.workspaces[fallback.min(self.workspaces.len() - 1)].id.clone();
                }
                Ok(Effect::ClosedSubtabs(removed.subtabs.into_iter().map(|subtab| subtab.id).collect()))
            }
            ("subtab", "new") => {
                let kind = args.first().map(String::as_str).unwrap_or("terminal");
                if !SUPPORTED_SUBTABS.contains(&kind) {
                    return Err(format!("The {kind} subtab needs the GUI — start the Auri app."));
                }
                let cwd = self
                    .active_workspace()
                    .map(|workspace| workspace.folder_path.clone())
                    .unwrap_or_else(|| self.home.clone());
                let subtab = self.create_subtab(kind, &cwd);
                let id = subtab.id.clone();
                if let Some(workspace) = self.active_workspace_mut() {
                    workspace.subtabs.push(subtab);
                    workspace.active_subtab_id = id;
                }
                Ok(Effect::None)
            }
            ("subtab", "select") => {
                let id = args.first().ok_or("Choose a subtab id.")?.clone();
                let workspace = self.active_workspace_mut().ok_or("No workspace is open.")?;
                if !workspace.subtabs.iter().any(|subtab| subtab.id == id) {
                    return Err(format!("Subtab {id} was not found."));
                }
                workspace.active_subtab_id = id;
                Ok(Effect::None)
            }
            ("subtab", "close") => {
                let workspace = self.active_workspace_mut().ok_or("No workspace is open.")?;
                if workspace.subtabs.len() == 1 {
                    return Err("The last subtab stays open.".to_string());
                }
                let id = args
                    .first()
                    .cloned()
                    .unwrap_or_else(|| workspace.active_subtab_id.clone());
                let Some(position) = workspace.subtabs.iter().position(|subtab| subtab.id == id) else {
                    return Err(format!("Subtab {id} was not found."));
                };
                workspace.subtabs.remove(position);
                if workspace.active_subtab_id == id {
                    let fallback = position.saturating_sub(1);
                    workspace.active_subtab_id = workspace.subtabs[fallback.min(workspace.subtabs.len() - 1)].id.clone();
                }
                Ok(Effect::ClosedSubtabs(vec![id]))
            }
            ("terminal", "run") => {
                let command = raw_tail(input, "terminal", "run");
                if command.is_empty() {
                    return Err("Enter a command to run.".to_string());
                }
                let subtab = self.target_terminal().ok_or("No terminal tab is available.")?;
                Ok(Effect::RunTerminal { subtab_id: subtab.id.clone(), command: command.to_string() })
            }
            ("folder", "cd") => {
                let path = args.first().ok_or("Choose a directory.")?.clone();
                let subtab_id = self.target_terminal().map(|subtab| subtab.id.clone());
                if let Some(workspace) = self.active_workspace_mut() {
                    workspace.folder_path = path.clone();
                    for subtab in workspace.subtabs.iter_mut() {
                        if Some(&subtab.id) == subtab_id.as_ref() {
                            subtab.cwd = path.clone();
                        }
                    }
                }
                match subtab_id {
                    Some(subtab_id) => Ok(Effect::ChangeDirectory { subtab_id, path }),
                    None => Ok(Effect::None),
                }
            }
            ("system", "open") => {
                self.select_or_create_subtab("system");
                Ok(Effect::RefreshSystem)
            }
            ("system", "sort") => {
                let sort = args.first().ok_or("Choose a sort key.")?;
                const VALID: [&str; 8] = ["cpu", "port", "name", "pid", "priority", "ram", "net", "disk"];
                if !VALID.contains(&sort.as_str()) {
                    return Err(format!("Sort by one of: {}.", VALID.join(", ")));
                }
                self.system_sort_by = sort.clone();
                self.system_sort_direction = "desc".to_string();
                Ok(Effect::None)
            }
            ("system", "search") => {
                self.system_filter = raw_tail(input, "system", "search").trim().to_string();
                Ok(Effect::None)
            }
            ("system", "refresh") => Ok(Effect::RefreshSystem),
            ("system", "select") => {
                let pid = args.first().and_then(|value| value.parse::<i64>().ok());
                self.selected_pid = if pid == self.selected_pid { None } else { pid };
                Ok(Effect::None)
            }
            ("clipboard", "list") => {
                self.select_or_create_subtab("clipboard");
                Ok(Effect::None)
            }
            ("clipboard", "copy") => {
                let text = raw_tail(input, "clipboard", "copy");
                if text.is_empty() {
                    return Err("Enter text to copy.".to_string());
                }
                let unquoted = tokenize(text).join(" ");
                Ok(Effect::CopyText(if unquoted.is_empty() { text.to_string() } else { unquoted }))
            }
            ("clipboard", "copy-item") => {
                let id = args.first().ok_or("Choose a clipboard item.")?;
                Ok(Effect::CopyClipboardItem(id.clone()))
            }
            ("clipboard", "pin") | ("clipboard", "unpin") => {
                let id = args.first().ok_or("Choose a clipboard item.")?;
                Ok(Effect::SetClipboardPinned { id: id.clone(), pinned: action == "pin" })
            }
            ("clipboard", "remove") => {
                let id = args.first().ok_or("Choose a clipboard item.")?;
                Ok(Effect::RemoveClipboardItem(id.clone()))
            }
            ("info", "show") => {
                self.select_or_create_subtab("info");
                Ok(Effect::None)
            }
            ("info", "clear") => {
                self.info_items.clear();
                Ok(Effect::None)
            }
            _ => Err(format!(
                "`{domain}` needs the GUI. Without it auri cli supports: tab, subtab (terminal/system/clipboard/info), terminal run, folder cd, system, clipboard, info."
            )),
        }
    }
}

/// A process row for the standalone system monitor, with rates already
/// derived by the host from consecutive snapshots.
#[derive(Debug, Clone, Default)]
pub struct LocalProcess {
    pub pid: i64,
    pub name: String,
    pub path: String,
    pub command_line: String,
    pub cpu_percent: f64,
    pub memory_bytes: u64,
    pub priority: i64,
    pub download_bytes_per_second: f64,
    pub upload_bytes_per_second: f64,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
    pub ports: Vec<u16>,
}

pub fn filter_processes(processes: &[LocalProcess], query: &str) -> Vec<LocalProcess> {
    let keywords: Vec<String> = query
        .split_whitespace()
        .map(|keyword| keyword.to_lowercase())
        .collect();
    if keywords.is_empty() {
        return processes.to_vec();
    }
    processes
        .iter()
        .filter(|process| {
            let haystack = format!(
                "{} {} {} {} {}",
                process.name.to_lowercase(),
                process.command_line.to_lowercase(),
                process.path.to_lowercase(),
                process.pid,
                process.ports.iter().map(|port| port.to_string()).collect::<Vec<_>>().join(" ")
            );
            keywords.iter().any(|keyword| haystack.contains(keyword))
        })
        .cloned()
        .collect()
}

fn primary_port(process: &LocalProcess) -> Option<u16> {
    process.ports.iter().copied().min()
}

/// Mirrors the GUI ordering rules: port ascending with portless processes
/// last, name and pid ascending, cpu/ram/net/disk descending; direction only
/// flips the priority sort.
pub fn sort_processes(processes: &mut [LocalProcess], sort_by: &str, sort_direction: &str) {
    processes.sort_by(|left, right| {
        let ordering = match sort_by {
            "port" => match (primary_port(left), primary_port(right)) {
                (None, None) => left.name.cmp(&right.name).then(left.pid.cmp(&right.pid)),
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => a.cmp(&b).then(left.name.cmp(&right.name)),
            },
            "name" => left.name.to_lowercase().cmp(&right.name.to_lowercase()).then(left.pid.cmp(&right.pid)),
            "pid" => left.pid.cmp(&right.pid),
            "priority" => {
                let order = left.priority.cmp(&right.priority);
                let order = if sort_direction == "asc" { order } else { order.reverse() };
                order.then(left.name.cmp(&right.name))
            }
            "ram" => right
                .memory_bytes
                .cmp(&left.memory_bytes)
                .then(right.cpu_percent.total_cmp(&left.cpu_percent)),
            "net" => (right.download_bytes_per_second + right.upload_bytes_per_second)
                .total_cmp(&(left.download_bytes_per_second + left.upload_bytes_per_second))
                .then(right.cpu_percent.total_cmp(&left.cpu_percent)),
            "disk" => (right.read_bytes_per_second + right.write_bytes_per_second)
                .total_cmp(&(left.read_bytes_per_second + left.write_bytes_per_second))
                .then(right.cpu_percent.total_cmp(&left.cpu_percent)),
            _ => right
                .cpu_percent
                .total_cmp(&left.cpu_percent)
                .then(right.memory_bytes.cmp(&left.memory_bytes)),
        };
        ordering
    });
}
