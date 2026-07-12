use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug)]
pub struct NetworkSample {
    pub at: Instant,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub captured_at: String,
    pub host: HostInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub network: NetworkInfo,
    pub disk: DiskInfo,
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub uptime_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: String,
    pub cores: usize,
    pub usage_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub usage_percent: Option<f64>,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_free_bytes: u64,
    pub swap_usage_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mounts: Vec<DiskMount>,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub usage_percent: Option<f64>,
    pub read_bytes_per_second: Option<f64>,
    pub write_bytes_per_second: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMount {
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub usage_percent: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub interfaces: Vec<NetworkInterface>,
    pub download_bytes_per_second: Option<f64>,
    pub upload_bytes_per_second: Option<f64>,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub ip: String,
    pub status: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
    pub working_directory: String,
    pub command_line: String,
    pub status: String,
    pub cpu_percent: f64,
    pub memory_bytes: u64,
    pub download_bytes: u64,
    pub upload_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    pub ports: Vec<u16>,
    pub port_details: Vec<PortInfo>,
}

// A listening port plus its transport (tcp/udp). The application protocol
// (http/https/ssh/…) is derived on the JS side from the port number so there is
// a single source of truth for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflaredStatus {
    pub available: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflaredTunnel {
    pub port: u16,
    pub url: String,
    pub pid: u32,
    pub path: String,
}

#[derive(Debug)]
pub struct CloudflaredProcess {
    pub info: CloudflaredTunnel,
    pub child: Child,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn local_cloudflared_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".local").join("bin").join("cloudflared"))
}

/// When Auri is launched from Finder/Dock rather than a terminal, the process
/// inherits launchd's minimal PATH (typically just /usr/bin:/bin:/usr/sbin:/sbin)
/// instead of the user's shell PATH. Homebrew, asdf, nvm, etc. all live outside
/// that minimal PATH, so a plain std::env::var_os("PATH") lookup misses tools
/// like cloudflared even though they work fine from a terminal. Ask the user's
/// login shell for its resolved PATH, mirroring the approach shell::run already
/// uses ($SHELL -lc ...) to execute terminal commands with the full environment.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(&shell)
        .arg("-lc")
        .arg("echo $PATH")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Common package-manager install locations checked as a last resort, in case
/// the login shell probe above is unavailable (no SHELL set, shell failed to
/// launch) or the user's shell rc files don't actually export PATH.
fn fallback_search_directories() -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
    ];
    if let Some(home) = home_dir() {
        directories.push(home.join(".homebrew").join("bin"));
        directories.push(home.join(".linuxbrew").join("bin"));
        directories.push(home.join(".local").join("bin"));
    }
    directories
}

fn search_directories() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut directories = Vec::new();

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            if seen.insert(directory.clone()) {
                directories.push(directory);
            }
        }
    }
    if let Some(path) = login_shell_path() {
        for directory in std::env::split_paths(&path) {
            if seen.insert(directory.clone()) {
                directories.push(directory);
            }
        }
    }
    for directory in fallback_search_directories() {
        if seen.insert(directory.clone()) {
            directories.push(directory);
        }
    }
    directories
}

fn path_has_cloudflared() -> Option<PathBuf> {
    search_directories()
        .into_iter()
        .map(|directory| directory.join("cloudflared"))
        .find(|candidate| candidate.is_file())
}

fn cloudflared_path() -> Option<PathBuf> {
    path_has_cloudflared().or_else(|| local_cloudflared_path().filter(|path| path.is_file()))
}

pub fn cloudflared_status() -> CloudflaredStatus {
    match cloudflared_path() {
        Some(path) => CloudflaredStatus {
            available: true,
            path: path.to_string_lossy().into_owned(),
        },
        None => CloudflaredStatus {
            available: false,
            path: String::new(),
        },
    }
}

fn run_download(url: &str, destination: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-L", "--fail", "--show-error", "--output"])
        .arg(destination)
        .arg(url)
        .status()
        .map_err(|error| format!("Could not start curl to download cloudflared: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("cloudflared download failed with status {status}."))
    }
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Could not inspect cloudflared permissions: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Could not mark cloudflared executable: {error}"))?;
    }
    Ok(())
}

fn cloudflared_download() -> Result<(&'static str, bool), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", false)),
        ("linux", "aarch64") => Ok(("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64", false)),
        ("linux", "arm") => Ok(("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm", false)),
        ("macos", "aarch64") => Ok(("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz", true)),
        ("macos", "x86_64") => Ok(("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz", true)),
        (os, arch) => Err(format!("Automatic cloudflared install is not supported on {os}/{arch}. Install cloudflared in PATH or ~/.local/bin.")),
    }
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn install_cloudflared() -> Result<PathBuf, String> {
    let destination = local_cloudflared_path()
        .ok_or_else(|| "Could not resolve ~/.local/bin for cloudflared install.".to_string())?;
    let bin_dir = destination
        .parent()
        .ok_or_else(|| "Could not resolve cloudflared install directory.".to_string())?;
    fs::create_dir_all(bin_dir)
        .map_err(|error| format!("Could not create ~/.local/bin: {error}"))?;

    let (url, archive) = cloudflared_download()?;
    let stamp = format!("{}-{}", std::process::id(), current_millis());
    let temp_root = std::env::temp_dir().join(format!("auri-cloudflared-{stamp}"));
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("Could not create temporary cloudflared directory: {error}"))?;
    let download_path = temp_root.join(if archive {
        "cloudflared.tgz"
    } else {
        "cloudflared"
    });
    run_download(url, &download_path)?;

    if archive {
        let extract_dir = temp_root.join("extract");
        fs::create_dir_all(&extract_dir)
            .map_err(|error| format!("Could not create cloudflared extract directory: {error}"))?;
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(&download_path)
            .arg("-C")
            .arg(&extract_dir)
            .status()
            .map_err(|error| format!("Could not extract cloudflared archive: {error}"))?;
        if !status.success() {
            return Err(format!(
                "cloudflared archive extraction failed with status {status}."
            ));
        }
        let extracted = find_extracted_cloudflared(&extract_dir).ok_or_else(|| {
            "cloudflared archive did not contain a cloudflared binary.".to_string()
        })?;
        fs::copy(&extracted, &destination)
            .map_err(|error| format!("Could not install cloudflared to ~/.local/bin: {error}"))?;
    } else {
        fs::copy(&download_path, &destination)
            .map_err(|error| format!("Could not install cloudflared to ~/.local/bin: {error}"))?;
    }
    set_executable(&destination)?;
    let _ = fs::remove_dir_all(&temp_root);
    Ok(destination)
}

fn find_extracted_cloudflared(directory: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "cloudflared")
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_extracted_cloudflared(&path) {
                return Some(found);
            }
        }
    }
    None
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    line.split(|character: char| {
        character.is_whitespace() || character == '|' || character == ',' || character == ';'
    })
    .map(|token| {
        let t = token.trim_matches(|character: char| {
            matches!(character, '<' | '>' | '"' | '\'' | ')' | '(' | '[' | ']')
        });
        let t = t.trim_end_matches('.');
        t.trim_matches(|character: char| {
            matches!(character, '<' | '>' | '"' | '\'' | ')' | '(' | '[' | ']')
        })
    })
    .find(|token| token.starts_with("https://") && token.contains(".trycloudflare.com"))
    .map(|token| token.to_string())
}

// Drains cloudflared's stdout/stderr for the full lifetime of the process.
// Earlier this stopped reading (`break`) as soon as the public URL was
// found. cloudflared keeps writing connection/heartbeat logs after that,
// and once nothing reads from a pipe its OS buffer fills up; the child then
// blocks on write() and appears to get "killed after a short time" (it's
// actually stuck, not killed, but the effect for the user is the same: the
// tunnel goes dead). Keep consuming lines for as long as the pipe is open
// so the process can run indefinitely.
fn watch_cloudflared_output<R>(reader: R, sender: mpsc::Sender<String>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut url_sent = false;
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if !url_sent {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    let _ = sender.send(url);
                    url_sent = true;
                }
            }
            // Keep looping (discarding further lines) instead of breaking,
            // so the pipe never backs up and blocks the child process.
        }
    });
}

pub fn start_cloudflared_tunnel(
    port: u16,
    install_if_missing: bool,
) -> Result<CloudflaredProcess, String> {
    if port == 0 {
        return Err("Choose a valid local port.".to_string());
    }
    let executable = match cloudflared_path() {
        Some(path) => path,
        None if install_if_missing => install_cloudflared()?,
        None => return Err("cloudflared is not installed in PATH or ~/.local/bin. Confirm install from the System monitor, or install it manually.".to_string()),
    };
    let local_url = format!("http://127.0.0.1:{port}");
    let mut child = Command::new(&executable)
        .args(["tunnel", "--url", &local_url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start cloudflared: {error}"))?;

    let (sender, receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        watch_cloudflared_output(stdout, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        watch_cloudflared_output(stderr, sender);
    }

    let started_at = Instant::now();
    let timeout = Duration::from_secs(25);
    loop {
        if let Ok(url) = receiver.try_recv() {
            let info = CloudflaredTunnel {
                port,
                url,
                pid: child.id(),
                path: executable.to_string_lossy().into_owned(),
            };
            return Ok(CloudflaredProcess { info, child });
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect cloudflared process: {error}"))?
        {
            return Err(format!(
                "cloudflared exited before creating a public URL with status {status}."
            ));
        }
        if started_at.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Timed out waiting for cloudflared to return a public HTTPS URL.".to_string(),
            );
        }
    }
}

pub fn parse_port_from_service_url(service: &str) -> Option<u16> {
    let service = service.trim();
    if service.starts_with("http://")
        || service.starts_with("https://")
        || service.starts_with("tcp://")
    {
        if let Some(idx) = service.rfind(':') {
            if idx > 6 {
                let port_str: String = service[idx + 1..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(port) = port_str.parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    None
}

pub fn parse_port_from_cmdline(cmd: &str) -> Option<u16> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..parts.len() {
        if parts[i] == "--url" && i + 1 < parts.len() {
            if let Some(port) = parse_port_from_service_url(parts[i + 1]) {
                return Some(port);
            }
        } else if parts[i].starts_with("--url=") {
            if let Some(port) = parse_port_from_service_url(&parts[i][6..]) {
                return Some(port);
            }
        }
    }
    None
}

pub fn parse_config_path_from_cmdline(cmd: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..parts.len() {
        if (parts[i] == "--config" || parts[i] == "-config") && i + 1 < parts.len() {
            return Some(PathBuf::from(parts[i + 1]));
        } else if parts[i].starts_with("--config=") {
            return Some(PathBuf::from(&parts[i][9..]));
        }
    }
    None
}

pub fn parse_logfile_path_from_cmdline(cmd: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..parts.len() {
        if (parts[i] == "--logfile" || parts[i] == "-logfile") && i + 1 < parts.len() {
            return Some(PathBuf::from(parts[i + 1]));
        } else if parts[i].starts_with("--logfile=") {
            return Some(PathBuf::from(&parts[i][10..]));
        }
    }
    None
}

pub fn scan_config_file_for_mappings(path: &Path, mappings: &mut HashMap<u16, String>) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut current_hostname = String::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("url:") {
            let val = line[4..].trim();
            if let Some(port) = parse_port_from_service_url(val) {
                mappings.insert(port, String::new());
            }
        } else if line.starts_with("- hostname:") || line.starts_with("hostname:") {
            let val = if line.starts_with("- hostname:") {
                line[11..].trim()
            } else {
                line[9..].trim()
            };
            current_hostname = val
                .trim_matches(|c| c == '"' || c == '\'' || c == ' ')
                .to_string();
        } else if line.starts_with("- service:") || line.starts_with("service:") {
            let val = if line.starts_with("- service:") {
                line[10..].trim()
            } else {
                line[8..].trim()
            };
            let val = val.trim_matches(|c| c == '"' || c == '\'' || c == ' ');
            if let Some(port) = parse_port_from_service_url(val) {
                if !current_hostname.is_empty() {
                    let url = if current_hostname.starts_with("http://")
                        || current_hostname.starts_with("https://")
                    {
                        current_hostname.clone()
                    } else {
                        format!("https://{current_hostname}")
                    };
                    mappings.insert(port, url);
                }
            }
        }
    }
}

pub fn scan_log_file_for_mappings(path: &Path, mappings: &mut HashMap<u16, String>) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return,
    };

    let reader = BufReader::new(file);
    let lines: Vec<String> = if metadata.len() > 2_000_000 {
        reader
            .lines()
            .flatten()
            .collect::<Vec<String>>()
            .into_iter()
            .rev()
            .take(5000)
            .collect::<Vec<String>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        reader.lines().flatten().collect()
    };

    for line in lines {
        if let Some(idx) = line.find("Updated to new configuration config=\"") {
            let start = idx + "Updated to new configuration config=\"".len();
            if let Some(end) = line[start..].find('"') {
                let json_str = &line[start..start + end];
                let unescaped = json_str.replace("\\\"", "\"");
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&unescaped) {
                    if let Some(ingress) = json.get("ingress").and_then(|v| v.as_array()) {
                        for rule in ingress {
                            if let (Some(hostname), Some(service)) = (
                                rule.get("hostname").and_then(|v| v.as_str()),
                                rule.get("service").and_then(|v| v.as_str()),
                            ) {
                                if let Some(port) = parse_port_from_service_url(service) {
                                    let url = if hostname.starts_with("http://")
                                        || hostname.starts_with("https://")
                                    {
                                        hostname.to_string()
                                    } else {
                                        format!("https://{hostname}")
                                    };
                                    mappings.insert(port, url);
                                }
                            }
                        }
                    }
                }
            }
        }
        if let (Some(dest_idx), Some(origin_idx)) =
            (line.find("dest="), line.find("originService="))
        {
            let dest_part = &line[dest_idx + 5..];
            let dest_val = dest_part
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c| c == '"' || c == '\'');

            let origin_part = &line[origin_idx + 14..];
            let origin_val = origin_part
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c| c == '"' || c == '\'');

            if let Some(port) = parse_port_from_service_url(origin_val) {
                if let Some(url_idx) = dest_val.find("://") {
                    let host_part = &dest_val[url_idx + 3..];
                    let host = host_part.split('/').next().unwrap_or(host_part);
                    let protocol = &dest_val[..url_idx];
                    let url = format!("{protocol}://{host}");
                    mappings.insert(port, url);
                }
            }
        }
    }
}

pub fn discover_active_tunnels() -> Vec<CloudflaredTunnel> {
    let mut discovered = Vec::new();
    let cloudflared_procs = get_running_cloudflared_processes();
    if cloudflared_procs.is_empty() {
        return discovered;
    }

    let mut port_to_url: HashMap<u16, String> = HashMap::new();
    let mut port_to_pid: HashMap<u16, u32> = HashMap::new();
    let mut quick_ports = Vec::new();

    for (pid, cmd) in &cloudflared_procs {
        if let Some(port) = parse_port_from_cmdline(cmd) {
            port_to_pid.insert(port, *pid);
            quick_ports.push(port);
        }
    }

    let mut log_paths = vec![
        PathBuf::from("/Library/Logs/com.cloudflare.cloudflared.err.log"),
        PathBuf::from("/Library/Logs/com.cloudflare.cloudflared.out.log"),
    ];
    if let Some(home) = home_dir() {
        log_paths.push(home.join(".cloudflared").join("tunnel.log"));
    }

    for (_pid, cmd) in &cloudflared_procs {
        if let Some(log_path) = parse_logfile_path_from_cmdline(cmd) {
            if !log_paths.contains(&log_path) {
                log_paths.push(log_path);
            }
        }
        if let Some(config_path) = parse_config_path_from_cmdline(cmd) {
            scan_config_file_for_mappings(&config_path, &mut port_to_url);
        }
    }

    for path in log_paths {
        scan_log_file_for_mappings(&path, &mut port_to_url);
    }

    let mut last_try_url = String::new();
    for path in &[
        PathBuf::from("/Library/Logs/com.cloudflare.cloudflared.err.log"),
        PathBuf::from("/Library/Logs/com.cloudflare.cloudflared.out.log"),
    ] {
        if let Ok(file) = fs::File::open(path) {
            let reader = BufReader::new(file);
            for line in reader.lines().flatten() {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    last_try_url = url;
                }
            }
        }
    }

    for port in quick_ports {
        if !port_to_url.contains_key(&port) && !last_try_url.is_empty() {
            port_to_url.insert(port, last_try_url.clone());
        }
    }

    let default_pid = cloudflared_procs.first().map(|(pid, _)| *pid).unwrap_or(0);

    for (port, url) in port_to_url {
        let pid = port_to_pid.get(&port).copied().unwrap_or(default_pid);
        discovered.push(CloudflaredTunnel {
            port,
            url,
            pid,
            path: String::new(),
        });
    }

    discovered
}

fn get_running_cloudflared_processes() -> Vec<(u32, String)> {
    let mut results = Vec::new();
    if let Some(output) = command_output("ps", &["-axo", "pid=,command="]) {
        for line in output.lines() {
            let line = line.trim_start();
            let mut parts = line.splitn(2, char::is_whitespace);
            if let (Some(pid_str), Some(cmd)) = (parts.next(), parts.next()) {
                if cmd.contains("cloudflared") {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        results.push((pid, cmd.to_string()));
                    }
                }
            }
        }
    }
    results
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn now_isoish() -> String {
    command_output("date", &["-u", "+%Y-%m-%dT%H:%M:%S.000Z"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

fn hostname() -> String {
    command_output("hostname", &[])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

fn parse_macos_top_cpu(text: &str) -> Option<f64> {
    let line = text.lines().find(|line| line.contains("CPU usage:"))?;
    let idle_fragment = line.split(" idle").next()?;
    let idle = idle_fragment
        .rsplit_once(' ')?
        .1
        .trim_end_matches('%')
        .parse::<f64>()
        .ok()?;
    Some((100.0 - idle).clamp(0.0, 100.0))
}

fn cpu_brand() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Some(value) = command_output("sysctl", &["-n", "machdep.cpu.brand_string"]) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
            for line in text.lines() {
                if let Some(value) = line.strip_prefix("model name") {
                    if let Some(value) = value.split(':').nth(1) {
                        let value = value.trim();
                        if !value.is_empty() {
                            return value.to_string();
                        }
                    }
                }
            }
        }
    }
    format!("{} CPU", std::env::consts::ARCH)
}

#[cfg(target_os = "macos")]
fn cpu_usage_percent() -> Option<f64> {
    let text = command_output("top", &["-l", "1", "-n", "0"])?;
    parse_macos_top_cpu(&text)
}

#[cfg(target_os = "linux")]
fn cpu_usage_percent() -> Option<f64> {
    fn read_cpu() -> Option<(u64, u64)> {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        let line = text.lines().find(|line| line.starts_with("cpu "))?;
        let values: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .filter_map(|item| item.parse().ok())
            .collect();
        if values.len() < 4 {
            return None;
        }
        let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
        let total = values.iter().sum();
        Some((idle, total))
    }
    let first = read_cpu()?;
    std::thread::sleep(std::time::Duration::from_millis(120));
    let second = read_cpu()?;
    let idle = second.0.saturating_sub(first.0) as f64;
    let total = second.1.saturating_sub(first.1) as f64;
    if total <= 0.0 {
        None
    } else {
        Some(((total - idle) / total * 100.0).clamp(0.0, 100.0))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn cpu_usage_percent() -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
fn parse_macos_swapusage_bytes(text: &str) -> (u64, u64, u64) {
    fn parse_value(token: &str) -> Option<u64> {
        let token = token.trim().trim_end_matches(',');
        let unit = token.chars().last()?;
        let number = token[..token.len().saturating_sub(1)].parse::<f64>().ok()?;
        let multiplier = match unit {
            'G' | 'g' => 1_000_000_000_f64,
            'M' | 'm' => 1_000_000_f64,
            'K' | 'k' => 1_000_f64,
            _ => return None,
        };
        Some((number * multiplier).round() as u64)
    }
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut total = 0;
    let mut used = 0;
    let mut free = 0;
    for pair in tokens.windows(3) {
        if pair[1] != "=" {
            continue;
        }
        match pair[0] {
            "total" => total = parse_value(pair[2]).unwrap_or(0),
            "used" => used = parse_value(pair[2]).unwrap_or(0),
            "free" => free = parse_value(pair[2]).unwrap_or(0),
            _ => {}
        }
    }
    (total, used, free)
}

#[cfg(target_os = "macos")]
fn memory_info() -> MemoryInfo {
    let total = command_output("sysctl", &["-n", "hw.memsize"])
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let vm = command_output("vm_stat", &[]).unwrap_or_default();
    let mut page_size = 4096_u64;
    let mut pages: HashMap<String, u64> = HashMap::new();
    for line in vm.lines() {
        if line.starts_with("Mach Virtual Memory Statistics") {
            if let Some(size) = line
                .split("page size of ")
                .nth(1)
                .and_then(|tail| tail.split_whitespace().next())
            {
                page_size = size.parse().unwrap_or(page_size);
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            let count = value.trim().trim_end_matches('.').replace('.', "");
            if let Ok(count) = count.parse::<u64>() {
                pages.insert(name.trim().to_string(), count);
            }
        }
    }
    let free_pages = pages.get("Pages free").copied().unwrap_or(0)
        + pages.get("Pages inactive").copied().unwrap_or(0)
        + pages.get("Pages speculative").copied().unwrap_or(0);
    let free = free_pages.saturating_mul(page_size).min(total);
    let used = total.saturating_sub(free);
    let usage_percent = if total > 0 {
        Some(used as f64 / total as f64 * 100.0)
    } else {
        None
    };
    let (swap_total, swap_used, swap_free) = command_output("sysctl", &["-n", "vm.swapusage"])
        .map(|value| parse_macos_swapusage_bytes(&value))
        .unwrap_or((0, 0, 0));
    let swap_usage_percent = if swap_total > 0 {
        Some(swap_used as f64 / swap_total as f64 * 100.0)
    } else {
        None
    };
    MemoryInfo {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        usage_percent,
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        swap_free_bytes: swap_free,
        swap_usage_percent,
    }
}

#[cfg(target_os = "linux")]
fn memory_info() -> MemoryInfo {
    let text = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mut values = HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let kb = value
                .split_whitespace()
                .next()
                .and_then(|item| item.parse::<u64>().ok())
                .unwrap_or(0);
            values.insert(key.to_string(), kb.saturating_mul(1024));
        }
    }
    let total = values.get("MemTotal").copied().unwrap_or(0);
    let available = values
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| values.get("MemFree").copied().unwrap_or(0));
    let used = total.saturating_sub(available);
    let usage_percent = if total > 0 {
        Some(used as f64 / total as f64 * 100.0)
    } else {
        None
    };
    let swap_total = values.get("SwapTotal").copied().unwrap_or(0);
    let swap_free = values.get("SwapFree").copied().unwrap_or(0);
    let swap_used = swap_total.saturating_sub(swap_free);
    let swap_usage_percent = if swap_total > 0 {
        Some(swap_used as f64 / swap_total as f64 * 100.0)
    } else {
        None
    };
    MemoryInfo {
        total_bytes: total,
        used_bytes: used,
        free_bytes: available,
        usage_percent,
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        swap_free_bytes: swap_free,
        swap_usage_percent,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory_info() -> MemoryInfo {
    MemoryInfo {
        total_bytes: 0,
        used_bytes: 0,
        free_bytes: 0,
        usage_percent: None,
        swap_total_bytes: 0,
        swap_used_bytes: 0,
        swap_free_bytes: 0,
        swap_usage_percent: None,
    }
}

fn app_name_from_text(text: &str) -> Option<String> {
    let segments: Vec<&str> = text.split('/').collect();
    for segment in segments {
        let trimmed = segment.trim();
        if let Some(name) = trimmed.strip_suffix(".app") {
            let name = name.trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn basename_from_text(text: &str) -> Option<String> {
    let first = text.split_whitespace().next().unwrap_or(text).trim();
    let name = first.rsplit('/').next().unwrap_or(first).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn display_process_name(command_line: &str, path: &str, fallback: &str, pid: u32) -> String {
    app_name_from_text(command_line)
        .or_else(|| app_name_from_text(path))
        .or_else(|| basename_from_text(command_line))
        .or_else(|| basename_from_text(path))
        .or_else(|| {
            let fallback = fallback.trim();
            if fallback.is_empty() {
                None
            } else {
                Some(fallback.to_string())
            }
        })
        .unwrap_or_else(|| format!("pid {pid}"))
}

fn parse_process_line(line: &str) -> Option<ProcessInfo> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let pid = parts.first()?.parse::<u32>().ok()?;
    let rss_kb = parts.last()?.parse::<u64>().ok()?;
    let cpu_percent = parts
        .get(parts.len().saturating_sub(2))?
        .parse::<f64>()
        .ok()?;
    let state_index = parts.len().saturating_sub(3);
    let has_state_column = parts.get(state_index).is_some_and(|value| {
        value.chars().all(|char| {
            char.is_ascii_alphabetic()
                || char == '+'
                || char == '<'
                || char == '>'
                || char == 'N'
                || char == 's'
        })
    });
    let status = if has_state_column {
        parts.get(state_index).copied().unwrap_or("").to_string()
    } else {
        String::new()
    };
    let name_end = if has_state_column {
        state_index
    } else {
        parts.len().saturating_sub(2)
    };
    let raw_path = parts[1..name_end].join(" ");
    let name = raw_path
        .rsplit('/')
        .next()
        .unwrap_or(&raw_path)
        .trim()
        .to_string();
    Some(ProcessInfo {
        pid,
        name: if name.is_empty() {
            format!("pid {pid}")
        } else {
            name
        },
        path: raw_path.clone(),
        working_directory: String::new(),
        command_line: raw_path,
        status,
        cpu_percent,
        memory_bytes: rss_kb.saturating_mul(1024),
        download_bytes: 0,
        upload_bytes: 0,
        disk_read_bytes: 0,
        disk_write_bytes: 0,
        ports: Vec::new(),
        port_details: Vec::new(),
    })
}

fn parse_process_command_line(line: &str) -> Option<(u32, String)> {
    let trimmed = line.trim_start();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let pid = parts.next()?.parse::<u32>().ok()?;
    let command = parts.next().unwrap_or("").trim().to_string();
    if command.is_empty() {
        return None;
    }
    Some((pid, command))
}

fn process_command_lines_by_pid() -> HashMap<u32, String> {
    command_output("ps", &["-axo", "pid=,command="])
        .unwrap_or_default()
        .lines()
        .filter_map(parse_process_command_line)
        .collect()
}

#[cfg(target_os = "linux")]
fn working_directories_by_pid() -> HashMap<u32, String> {
    let mut directories = HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return directories;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(pid_text) = file_name.to_str() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let Ok(path) = std::fs::read_link(entry.path().join("cwd")) else {
            continue;
        };
        if path == std::path::Path::new("/") || !path.is_dir() {
            continue;
        }
        directories.insert(pid, path.to_string_lossy().into_owned());
    }
    directories
}

#[cfg(target_os = "macos")]
fn working_directories_by_pid() -> HashMap<u32, String> {
    let mut directories = HashMap::new();
    let mut current_pid: Option<u32> = None;
    for line in command_output("lsof", &["-d", "cwd", "-Fn"])
        .unwrap_or_default()
        .lines()
    {
        if let Some(pid) = line
            .strip_prefix('p')
            .and_then(|value| value.parse::<u32>().ok())
        {
            current_pid = Some(pid);
            continue;
        }
        let Some(path) = line.strip_prefix('n') else {
            continue;
        };
        if path == "/" || !std::path::Path::new(path).is_dir() {
            continue;
        }
        if let Some(pid) = current_pid {
            directories.insert(pid, path.to_string());
        }
    }
    directories
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn working_directories_by_pid() -> HashMap<u32, String> {
    HashMap::new()
}

fn parse_lsof_port(line: &str) -> Option<(u32, u16)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 2 || parts.first().copied() == Some("COMMAND") {
        return None;
    }
    let pid = parts.get(1)?.parse::<u32>().ok()?;
    for part in parts.iter().rev() {
        if let Some(index) = part.rfind(':') {
            let digits: String = part[index + 1..]
                .chars()
                .take_while(|char| char.is_ascii_digit())
                .collect();
            if let Ok(port) = digits.parse::<u16>() {
                return Some((pid, port));
            }
        }
    }
    None
}

fn insert_process_port(map: &mut HashMap<u32, Vec<u16>>, pid: u32, port: u16) {
    let ports = map.entry(pid).or_default();
    if !ports.contains(&port) {
        ports.push(port);
    }
}

fn parse_port_from_local_address(value: &str) -> Option<u16> {
    let index = value.rfind(':')?;
    let digits: String = value[index + 1..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits.parse::<u16>().ok()
}

#[cfg(target_os = "linux")]
fn parse_ss_listening_port(line: &str) -> Option<(u32, u16)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.first().copied() != Some("LISTEN") || parts.len() < 4 {
        return None;
    }
    let port = parse_port_from_local_address(parts.get(3)?)?;
    let pid_index = line.find("pid=")? + 4;
    let pid_text: String = line[pid_index..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    let pid = pid_text.parse::<u32>().ok()?;
    Some((pid, port))
}

#[cfg(target_os = "linux")]
fn linux_ss_listening_ports_by_pid() -> HashMap<u32, Vec<u16>> {
    let text = command_output("ss", &["-ltnp"]).unwrap_or_default();
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some((pid, port)) = parse_ss_listening_port(line) {
            insert_process_port(&mut map, pid, port);
        }
    }
    map
}

#[cfg(target_os = "linux")]
fn parse_proc_net_tcp_listener(line: &str) -> Option<(u64, u16)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 10 || parts.get(3).copied() != Some("0A") {
        return None;
    }
    let local = parts.get(1)?;
    let port_hex = local.rsplit_once(':')?.1;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    let inode = parts.get(9)?.parse::<u64>().ok()?;
    Some((inode, port))
}

#[cfg(target_os = "linux")]
fn linux_tcp_listener_ports_by_inode() -> HashMap<u64, u16> {
    let mut map = HashMap::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for line in text.lines().skip(1) {
            if let Some((inode, port)) = parse_proc_net_tcp_listener(line) {
                map.insert(inode, port);
            }
        }
    }
    map
}

#[cfg(target_os = "linux")]
fn parse_socket_inode_link(value: &str) -> Option<u64> {
    value
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse::<u64>()
        .ok()
}

#[cfg(target_os = "linux")]
fn linux_proc_listening_ports_by_pid() -> HashMap<u32, Vec<u16>> {
    let ports_by_inode = linux_tcp_listener_ports_by_inode();
    if ports_by_inode.is_empty() {
        return HashMap::new();
    }
    let mut map = HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return map;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let Some(inode) = parse_socket_inode_link(&target.to_string_lossy()) else {
                continue;
            };
            if let Some(port) = ports_by_inode.get(&inode).copied() {
                insert_process_port(&mut map, pid, port);
            }
        }
    }
    map
}

fn sort_process_port_map(map: &mut HashMap<u32, Vec<u16>>) {
    for ports in map.values_mut() {
        ports.sort_unstable();
    }
}

fn listening_ports_by_pid() -> HashMap<u32, Vec<u16>> {
    let text = command_output("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).unwrap_or_default();
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for line in text.lines() {
        if let Some((pid, port)) = parse_lsof_port(line) {
            insert_process_port(&mut map, pid, port);
        }
    }
    #[cfg(target_os = "linux")]
    {
        for (pid, ports) in linux_ss_listening_ports_by_pid() {
            for port in ports {
                insert_process_port(&mut map, pid, port);
            }
        }
        for (pid, ports) in linux_proc_listening_ports_by_pid() {
            for port in ports {
                insert_process_port(&mut map, pid, port);
            }
        }
    }
    sort_process_port_map(&mut map);
    map
}

fn insert_port_detail(map: &mut HashMap<u32, Vec<PortInfo>>, pid: u32, port: u16, transport: &str) {
    let details = map.entry(pid).or_default();
    if !details
        .iter()
        .any(|detail| detail.port == port && detail.transport == transport)
    {
        details.push(PortInfo {
            port,
            transport: transport.to_string(),
        });
    }
}

#[cfg(target_os = "linux")]
fn parse_ss_udp_port(line: &str) -> Option<(u32, u16)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.first().copied() != Some("UNCONN") || parts.len() < 4 {
        return None;
    }
    let port = parse_port_from_local_address(parts.get(3)?)?;
    let pid_index = line.find("pid=")? + 4;
    let pid_text: String = line[pid_index..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    let pid = pid_text.parse::<u32>().ok()?;
    Some((pid, port))
}

// Builds structured per-process ports carrying transport. TCP listeners are
// reused from `listening_ports_by_pid`; UDP is gathered from lsof (both
// platforms) and `ss -lunp` on Linux. Deduplicated by (port, transport).
fn build_port_details(tcp_ports: &HashMap<u32, Vec<u16>>) -> HashMap<u32, Vec<PortInfo>> {
    let mut map: HashMap<u32, Vec<PortInfo>> = HashMap::new();
    for (pid, ports) in tcp_ports {
        for &port in ports {
            insert_port_detail(&mut map, *pid, port, "tcp");
        }
    }
    for line in command_output("lsof", &["-nP", "-iUDP"])
        .unwrap_or_default()
        .lines()
    {
        if let Some((pid, port)) = parse_lsof_port(line) {
            insert_port_detail(&mut map, pid, port, "udp");
        }
    }
    #[cfg(target_os = "linux")]
    {
        for line in command_output("ss", &["-lunp"]).unwrap_or_default().lines() {
            if let Some((pid, port)) = parse_ss_udp_port(line) {
                insert_port_detail(&mut map, pid, port, "udp");
            }
        }
    }
    for details in map.values_mut() {
        details.sort_by(|left, right| {
            left.port
                .cmp(&right.port)
                .then_with(|| left.transport.cmp(&right.transport))
        });
    }
    map
}

#[cfg(target_os = "macos")]
fn parse_nettop_process_line(line: &str) -> Option<(u32, u64, u64)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 || parts.first().copied() == Some("time") {
        return None;
    }
    let mut pid_index = None;
    for i in 1..parts.len() {
        let token = parts[i];
        if let Some(pos) = token.rfind('.') {
            let suffix = &token[pos + 1..];
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                pid_index = Some(i);
                break;
            }
        }
    }
    let pid_idx = pid_index?;
    let pid_token = parts[pid_idx];
    let pid_pos = pid_token.rfind('.')?;
    let pid = pid_token[pid_pos + 1..].parse::<u32>().ok()?;
    let rx = parts.get(pid_idx + 1)?.parse::<u64>().ok()?;
    let tx = parts.get(pid_idx + 2)?.parse::<u64>().ok()?;
    Some((pid, rx, tx))
}

#[cfg(target_os = "macos")]
fn process_network_totals_by_pid() -> HashMap<u32, (u64, u64)> {
    let text = command_output("nettop", &["-P", "-x", "-l", "1"]).unwrap_or_default();
    let mut map: HashMap<u32, (u64, u64)> = HashMap::new();
    for line in text.lines() {
        if let Some((pid, rx, tx)) = parse_nettop_process_line(line) {
            let entry = map.entry(pid).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(rx);
            entry.1 = entry.1.saturating_add(tx);
        }
    }
    map
}

#[cfg(not(target_os = "macos"))]
fn process_network_totals_by_pid() -> HashMap<u32, (u64, u64)> {
    HashMap::new()
}

#[cfg(target_os = "linux")]
fn process_disk_totals_by_pid() -> HashMap<u32, (u64, u64)> {
    let mut map = HashMap::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let io_path = entry.path().join("io");
            let Ok(text) = std::fs::read_to_string(io_path) else {
                continue;
            };
            let mut read_bytes = 0_u64;
            let mut write_bytes = 0_u64;
            for line in text.lines() {
                if let Some(value) = line.strip_prefix("read_bytes:") {
                    read_bytes = value.trim().parse().unwrap_or(0);
                } else if let Some(value) = line.strip_prefix("write_bytes:") {
                    write_bytes = value.trim().parse().unwrap_or(0);
                }
            }
            map.insert(pid, (read_bytes, write_bytes));
        }
    }
    map
}

#[cfg(not(target_os = "linux"))]
fn process_disk_totals_by_pid() -> HashMap<u32, (u64, u64)> {
    HashMap::new()
}

fn disk_info() -> DiskInfo {
    let text = command_output("df", &["-kP"]).unwrap_or_default();
    let mut mounts = Vec::new();
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }
        let total = parts
            .get(1)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1024);
        let used = parts
            .get(2)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1024);
        let free = parts
            .get(3)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1024);
        let mount_point = parts.get(5).copied().unwrap_or("").to_string();
        if mount_point.is_empty()
            || mount_point.starts_with("/System/Volumes") && mount_point != "/System/Volumes/Data"
        {
            continue;
        }
        let usage_percent = if total > 0 {
            Some(used as f64 / total as f64 * 100.0)
        } else {
            None
        };
        mounts.push(DiskMount {
            name: parts.first().copied().unwrap_or("disk").to_string(),
            mount_point,
            total_bytes: total,
            used_bytes: used,
            free_bytes: free,
            usage_percent,
        });
    }
    mounts.sort_by(|left, right| left.mount_point.cmp(&right.mount_point));
    let total = mounts.iter().map(|mount| mount.total_bytes).sum::<u64>();
    let used = mounts.iter().map(|mount| mount.used_bytes).sum::<u64>();
    let free = mounts.iter().map(|mount| mount.free_bytes).sum::<u64>();
    DiskInfo {
        mounts,
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        usage_percent: if total > 0 {
            Some(used as f64 / total as f64 * 100.0)
        } else {
            None
        },
        read_bytes_per_second: None,
        write_bytes_per_second: None,
    }
}

fn process_info() -> Vec<ProcessInfo> {
    let text = command_output("ps", &["-axo", "pid=,comm=,state=,%cpu=,rss="]).unwrap_or_default();
    let ports_by_pid = listening_ports_by_pid();
    let port_details_by_pid = build_port_details(&ports_by_pid);
    let command_lines_by_pid = process_command_lines_by_pid();
    let working_directories_by_pid = working_directories_by_pid();
    let network_by_pid = process_network_totals_by_pid();
    let disk_by_pid = process_disk_totals_by_pid();
    let mut processes: Vec<ProcessInfo> = text
        .lines()
        .filter_map(parse_process_line)
        .map(|mut process| {
            process.ports = ports_by_pid.get(&process.pid).cloned().unwrap_or_default();
            process.port_details = port_details_by_pid
                .get(&process.pid)
                .cloned()
                .unwrap_or_default();
            if let Some(command_line) = command_lines_by_pid.get(&process.pid) {
                process.command_line = command_line.clone();
            }
            process.name = display_process_name(
                &process.command_line,
                &process.path,
                &process.name,
                process.pid,
            );
            if let Some(working_directory) = working_directories_by_pid.get(&process.pid) {
                process.working_directory = working_directory.clone();
            }
            if let Some((download, upload)) = network_by_pid.get(&process.pid) {
                process.download_bytes = *download;
                process.upload_bytes = *upload;
            }
            if let Some((read, write)) = disk_by_pid.get(&process.pid) {
                process.disk_read_bytes = *read;
                process.disk_write_bytes = *write;
            }
            process
        })
        .collect();
    processes.sort_by(|left, right| {
        right
            .cpu_percent
            .partial_cmp(&left.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.memory_bytes.cmp(&left.memory_bytes))
    });
    // Keep effectively all processes (a busy Mac running VMs can exceed 500) so
    // idle background/VM processes are not silently dropped before they reach the
    // UI, where search can then surface them.
    processes.truncate(2000);
    processes
}

#[cfg(target_os = "macos")]
fn interface_statuses() -> HashMap<String, (String, String)> {
    let text = command_output("ifconfig", &[]).unwrap_or_default();
    let mut map = HashMap::new();
    let mut current = String::new();
    let mut ip = String::new();
    let mut status = String::from("unknown");
    for line in text.lines() {
        if !line.starts_with('\t') && line.contains(':') {
            if !current.is_empty() {
                map.insert(current.clone(), (ip.clone(), status.clone()));
            }
            current = line
                .split(':')
                .next()
                .unwrap_or("")
                .trim_end_matches('*')
                .to_string();
            ip.clear();
            status = if line.contains("<UP") {
                "up".to_string()
            } else {
                "down".to_string()
            };
        } else {
            let trimmed = line.trim();
            if trimmed.starts_with("inet ") && ip.is_empty() {
                ip = trimmed.split_whitespace().nth(1).unwrap_or("").to_string();
            }
            if let Some(value) = trimmed.strip_prefix("status:") {
                status = value.trim().to_string();
            }
        }
    }
    if !current.is_empty() {
        map.insert(current, (ip, status));
    }
    map
}

#[cfg(target_os = "macos")]
fn network_interfaces() -> Vec<NetworkInterface> {
    let text = command_output("netstat", &["-ibn"]).unwrap_or_default();
    let statuses = interface_statuses();
    let mut by_name: HashMap<String, NetworkInterface> = HashMap::new();
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 || !parts.get(2).is_some_and(|value| value.starts_with("<Link")) {
            continue;
        }
        let name = parts[0].trim_end_matches('*').to_string();
        if name == "lo0" {
            continue;
        }
        let rx = parts
            .get(6)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let tx = parts
            .get(9)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let (ip, status) = statuses
            .get(&name)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::from("unknown")));
        by_name.insert(
            name.clone(),
            NetworkInterface {
                name,
                ip,
                status,
                rx_bytes: rx,
                tx_bytes: tx,
            },
        );
    }
    let mut interfaces: Vec<_> = by_name.into_values().collect();
    interfaces.sort_by(|left, right| left.name.cmp(&right.name));
    interfaces
}

#[cfg(target_os = "linux")]
fn network_interfaces() -> Vec<NetworkInterface> {
    let text = std::fs::read_to_string("/proc/net/dev").unwrap_or_default();
    let ip_text = command_output("ip", &["-o", "-4", "addr", "show"]).unwrap_or_default();
    let mut ips = HashMap::new();
    for line in ip_text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 4 {
            ips.insert(
                parts[1].trim_end_matches(':').to_string(),
                parts[3].split('/').next().unwrap_or("").to_string(),
            );
        }
    }
    let mut interfaces = Vec::new();
    for line in text.lines().skip(2) {
        let Some((name, values)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        if name == "lo" {
            continue;
        }
        let numbers: Vec<u64> = values
            .split_whitespace()
            .filter_map(|item| item.parse().ok())
            .collect();
        if numbers.len() < 16 {
            continue;
        }
        interfaces.push(NetworkInterface {
            status: if ips.contains_key(&name) {
                "up".to_string()
            } else {
                "unknown".to_string()
            },
            ip: ips.get(&name).cloned().unwrap_or_default(),
            name,
            rx_bytes: numbers[0],
            tx_bytes: numbers[8],
        });
    }
    interfaces.sort_by(|left, right| left.name.cmp(&right.name));
    interfaces
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn network_interfaces() -> Vec<NetworkInterface> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn uptime_seconds() -> Option<f64> {
    let text = command_output("sysctl", &["-n", "kern.boottime"])?;
    let sec = text
        .split("sec = ")
        .nth(1)?
        .split(|char: char| !char.is_ascii_digit())
        .next()?
        .parse::<u64>()
        .ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(sec) as f64)
}

#[cfg(target_os = "linux")]
fn uptime_seconds() -> Option<f64> {
    let text = std::fs::read_to_string("/proc/uptime").ok()?;
    text.split_whitespace().next()?.parse::<f64>().ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uptime_seconds() -> Option<f64> {
    None
}

fn network_info(previous: Option<NetworkSample>) -> (NetworkInfo, NetworkSample) {
    let interfaces = network_interfaces();
    let total_rx = interfaces.iter().map(|iface| iface.rx_bytes).sum::<u64>();
    let total_tx = interfaces.iter().map(|iface| iface.tx_bytes).sum::<u64>();
    let sample = NetworkSample {
        at: Instant::now(),
        rx_bytes: total_rx,
        tx_bytes: total_tx,
    };
    let (download_rate, upload_rate) = previous
        .and_then(|previous| {
            let elapsed = sample.at.duration_since(previous.at).as_secs_f64();
            if elapsed <= 0.0 {
                None
            } else {
                Some((
                    sample.rx_bytes.saturating_sub(previous.rx_bytes) as f64 / elapsed,
                    sample.tx_bytes.saturating_sub(previous.tx_bytes) as f64 / elapsed,
                ))
            }
        })
        .map_or((None, None), |(down, up)| (Some(down), Some(up)));

    (
        NetworkInfo {
            interfaces,
            download_bytes_per_second: download_rate,
            upload_bytes_per_second: upload_rate,
            total_rx_bytes: total_rx,
            total_tx_bytes: total_tx,
        },
        sample,
    )
}

pub fn kill_process(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("Choose a process PID to kill.".to_string());
    }
    let status = if cfg!(target_os = "windows") {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .status()
    } else {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not kill process {pid}."))
    }
}

pub fn snapshot(
    previous: Option<NetworkSample>,
) -> Result<(SystemSnapshot, NetworkSample), String> {
    let (network, sample) = network_info(previous);
    let snapshot = SystemSnapshot {
        captured_at: now_isoish(),
        host: HostInfo {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: hostname(),
            uptime_seconds: uptime_seconds(),
        },
        cpu: CpuInfo {
            brand: cpu_brand(),
            cores: std::thread::available_parallelism()
                .map(|value| value.get())
                .unwrap_or(0),
            usage_percent: cpu_usage_percent(),
        },
        memory: memory_info(),
        network,
        disk: disk_info(),
        processes: process_info(),
    };
    Ok((snapshot, sample))
}

#[cfg(test)]
mod tests {
    use super::{
        display_process_name, extract_trycloudflare_url, fallback_search_directories,
        parse_lsof_port, parse_macos_top_cpu, parse_process_command_line, parse_process_line,
    };

    #[cfg(target_os = "macos")]
    use super::parse_nettop_process_line;
    #[cfg(target_os = "linux")]
    use super::{parse_proc_net_tcp_listener, parse_socket_inode_link, parse_ss_listening_port};

    #[test]
    fn port_details_dedupe_by_port_and_transport() {
        use super::{insert_port_detail, PortInfo};
        let mut map = std::collections::HashMap::new();
        insert_port_detail(&mut map, 42, 8080, "tcp");
        insert_port_detail(&mut map, 42, 8080, "tcp");
        insert_port_detail(&mut map, 42, 8080, "udp");
        insert_port_detail(&mut map, 42, 53, "udp");
        let details = map.get(&42).unwrap();
        assert_eq!(details.len(), 3);
        assert!(details
            .iter()
            .any(|detail: &PortInfo| detail.port == 8080 && detail.transport == "tcp"));
        assert!(details
            .iter()
            .any(|detail: &PortInfo| detail.port == 8080 && detail.transport == "udp"));
        assert!(details
            .iter()
            .any(|detail: &PortInfo| detail.port == 53 && detail.transport == "udp"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_ss_udp_listening_ports() {
        use super::parse_ss_udp_port;
        assert_eq!(
            parse_ss_udp_port("UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:((\"dhclient\",pid=987,fd=6))"),
            Some((987, 68))
        );
        assert_eq!(parse_ss_udp_port("LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"), None);
    }

    #[test]
    fn derives_readable_app_names_from_bundle_paths() {
        assert_eq!(
            display_process_name(
                "/Applications/Blender.app/Contents/MacOS/Blender --background",
                "Bl",
                "Bl",
                90453,
            ),
            "Blender"
        );
        assert_eq!(
            display_process_name(
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper",
                "Go",
                "Go",
                87652,
            ),
            "Google Chrome"
        );
        assert_eq!(
            display_process_name(
                "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper",
                "An",
                "An",
                87391,
            ),
            "Antigravity"
        );
    }

    #[test]
    fn parses_process_rows_from_the_right() {
        let process = parse_process_line("  12019 /usr/local/bin/python3.11 S 14.5 20480").unwrap();
        assert_eq!(process.pid, 12019);
        assert_eq!(process.name, "python3.11");
        assert_eq!(process.path, "/usr/local/bin/python3.11");
        assert_eq!(process.command_line, "/usr/local/bin/python3.11");
        assert_eq!(process.working_directory, "");
        assert_eq!(process.status, "S");
        assert_eq!(process.memory_bytes, 20_971_520);
        assert_eq!(process.cpu_percent, 14.5);
    }

    #[test]
    fn parses_process_command_lines_with_arguments() {
        let parsed = parse_process_command_line(
            "  4242 /Applications/Auri.app/Contents/MacOS/auri --flag /tmp/demo folder",
        )
        .unwrap();
        assert_eq!(parsed.0, 4242);
        assert_eq!(
            parsed.1,
            "/Applications/Auri.app/Contents/MacOS/auri --flag /tmp/demo folder"
        );
    }

    #[test]
    fn parses_lsof_listening_ports() {
        let parsed =
            parse_lsof_port("node      42 ecoo   10u  IPv4 0x0 0t0 TCP 127.0.0.1:5173 (LISTEN)")
                .unwrap();
        assert_eq!(parsed, (42, 5173));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_ss_listening_ports() {
        let parsed = parse_ss_listening_port(
            r#"LISTEN 0 511 0.0.0.0:3333 0.0.0.0:* users:(("node",pid=694,fd=21))"#,
        )
        .unwrap();
        assert_eq!(parsed, (694, 3333));

        let parsed = parse_ss_listening_port(
            r#"LISTEN 0 5 [::1]:9876 [::]:* users:(("python3",pid=48792,fd=3))"#,
        )
        .unwrap();
        assert_eq!(parsed, (48792, 9876));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_proc_tcp_listener_rows() {
        let parsed = parse_proc_net_tcp_listener(
            "   0: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 159940 1 0000000000000000 100 0 0 10 0",
        )
        .unwrap();
        assert_eq!(parsed, (159940, 8000));
        assert_eq!(parse_socket_inode_link("socket:[159940]"), Some(159940));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_nettop_process_rows() {
        let parsed =
            parse_nettop_process_line("08:39:39.961770 python3.12.12019 2736 16640 0 0 0").unwrap();
        assert_eq!(parsed, (12019, 2736, 16640));
        let parsed = parse_nettop_process_line(
            "08:39:39.961778 Antigravity Hel.86938 115424455 7475302 16363 0 0",
        )
        .unwrap();
        assert_eq!(parsed, (86938, 115424455, 7475302));
    }

    #[test]
    fn parses_macos_cpu_idle_usage() {
        let usage = parse_macos_top_cpu("CPU usage: 7.10% user, 8.20% sys, 84.70% idle").unwrap();
        assert!((usage - 15.3).abs() < 0.01);
    }

    #[test]
    fn extracts_trycloudflare_url_from_cloudflared_log_lines() {
        let line = "2026-06-29T12:00:00Z INF |  https://auri-preview.trycloudflare.com  |";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://auri-preview.trycloudflare.com")
        );
        assert_eq!(extract_trycloudflare_url("no url on this line"), None);
        assert_eq!(
            extract_trycloudflare_url("Visit it at: <https://auri-preview.trycloudflare.com>."),
            Some("https://auri-preview.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn fallback_search_directories_include_common_homebrew_locations() {
        let directories = fallback_search_directories();
        let joined: Vec<String> = directories
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        assert!(joined.iter().any(|path| path == "/opt/homebrew/bin"));
        assert!(joined.iter().any(|path| path == "/usr/local/bin"));
    }

    #[test]
    fn parses_cloudflared_tunnels_and_configs() {
        use super::{
            parse_config_path_from_cmdline, parse_logfile_path_from_cmdline,
            parse_port_from_cmdline, parse_port_from_service_url,
        };
        use std::path::PathBuf;

        assert_eq!(
            parse_port_from_service_url("http://localhost:8009"),
            Some(8009)
        );
        assert_eq!(parse_port_from_service_url("tcp://127.0.0.1:22"), Some(22));
        assert_eq!(parse_port_from_service_url("invalid"), None);

        assert_eq!(
            parse_port_from_cmdline("cloudflared tunnel --url http://localhost:8009"),
            Some(8009)
        );
        assert_eq!(
            parse_port_from_cmdline("cloudflared tunnel --url=http://127.0.0.1:3000"),
            Some(3000)
        );
        assert_eq!(parse_port_from_cmdline("cloudflared tunnel run"), None);

        assert_eq!(
            parse_config_path_from_cmdline("cloudflared tunnel run --config /etc/cloudflared.yml"),
            Some(PathBuf::from("/etc/cloudflared.yml"))
        );
        assert_eq!(
            parse_logfile_path_from_cmdline("cloudflared --logfile /var/log/cf.log"),
            Some(PathBuf::from("/var/log/cf.log"))
        );
    }
}
