use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
    let has_state_column = parts
        .get(state_index)
        .is_some_and(|value| value.chars().all(|char| char.is_ascii_alphabetic() || char == '+' || char == '<' || char == '>' || char == 'N' || char == 's'));
    let status = if has_state_column {
        parts.get(state_index).copied().unwrap_or("").to_string()
    } else {
        String::new()
    };
    let name_end = if has_state_column { state_index } else { parts.len().saturating_sub(2) };
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
        if let Some(pid) = line.strip_prefix('p').and_then(|value| value.parse::<u32>().ok()) {
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

fn listening_ports_by_pid() -> HashMap<u32, Vec<u16>> {
    let text = command_output("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).unwrap_or_default();
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for line in text.lines() {
        if let Some((pid, port)) = parse_lsof_port(line) {
            let ports = map.entry(pid).or_default();
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    for ports in map.values_mut() {
        ports.sort_unstable();
    }
    map
}

#[cfg(target_os = "macos")]
fn parse_nettop_process_line(line: &str) -> Option<(u32, u64, u64)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 || parts.first().copied() == Some("time") {
        return None;
    }
    let rx = parts
        .get(parts.len().saturating_sub(8))?
        .parse::<u64>()
        .ok()?;
    let tx = parts
        .get(parts.len().saturating_sub(7))?
        .parse::<u64>()
        .ok()?;
    let identity = parts[..parts.len().saturating_sub(8)].join(" ");
    let pid_fragment = identity.rsplit('.').next()?.trim();
    let pid = pid_fragment.parse::<u32>().ok()?;
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
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
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
        let total = parts.get(1).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0).saturating_mul(1024);
        let used = parts.get(2).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0).saturating_mul(1024);
        let free = parts.get(3).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0).saturating_mul(1024);
        let mount_point = parts.get(5).copied().unwrap_or("").to_string();
        if mount_point.is_empty() || mount_point.starts_with("/System/Volumes") && mount_point != "/System/Volumes/Data" {
            continue;
        }
        let usage_percent = if total > 0 { Some(used as f64 / total as f64 * 100.0) } else { None };
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
        usage_percent: if total > 0 { Some(used as f64 / total as f64 * 100.0) } else { None },
        read_bytes_per_second: None,
        write_bytes_per_second: None,
    }
}

fn process_info() -> Vec<ProcessInfo> {
    let text = command_output("ps", &["-axo", "pid=,comm=,state=,%cpu=,rss="]).unwrap_or_default();
    let ports_by_pid = listening_ports_by_pid();
    let command_lines_by_pid = process_command_lines_by_pid();
    let working_directories_by_pid = working_directories_by_pid();
    let network_by_pid = process_network_totals_by_pid();
    let disk_by_pid = process_disk_totals_by_pid();
    let mut processes: Vec<ProcessInfo> = text
        .lines()
        .filter_map(parse_process_line)
        .map(|mut process| {
            process.ports = ports_by_pid.get(&process.pid).cloned().unwrap_or_default();
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
    processes.truncate(500);
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
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/T"]).status()
    } else {
        Command::new("kill").args(["-TERM", &pid.to_string()]).status()
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
        display_process_name, parse_lsof_port, parse_macos_top_cpu, parse_nettop_process_line,
        parse_process_command_line, parse_process_line,
    };

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
}
