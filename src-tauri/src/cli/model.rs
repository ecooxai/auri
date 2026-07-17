//! Parse the app-state snapshot JSON published by the GUI into the plain
//! view structs the renderer consumes. Tolerant of missing fields so a newer
//! or older GUI never crashes the TUI.

use super::view_model::{
    ClipboardItemView, InfoItemView, InfoView, MetricsView, ProcessView, SnapshotView, SubtabView,
    SystemView, TerminalBufferView, WorkspaceView,
};
use serde_json::Value;
use std::collections::HashMap;

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn optional_number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn items<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn parse_subtab(value: &Value) -> SubtabView {
    SubtabView {
        id: text(value, "id"),
        kind: text(value, "type"),
        title: text(value, "title"),
        active: boolean(value, "active"),
        cwd: value.get("cwd").and_then(Value::as_str).map(str::to_string),
        url: value.get("url").and_then(Value::as_str).map(str::to_string),
    }
}

fn parse_workspace(value: &Value) -> WorkspaceView {
    let terminal = value.get("terminal").cloned().unwrap_or(Value::Null);
    WorkspaceView {
        id: text(value, "id"),
        title: text(value, "title"),
        active: boolean(value, "active"),
        active_subtab_id: text(value, "activeSubtabId"),
        folder_path: text(value, "folderPath"),
        terminal_cwd: text(&terminal, "cwd"),
        terminal_running: boolean(&terminal, "running"),
        subtabs: items(value, "subtabs").into_iter().map(parse_subtab).collect(),
    }
}

fn parse_metrics(value: &Value) -> Option<MetricsView> {
    let metrics = value.get("metrics")?;
    if metrics.is_null() {
        return None;
    }
    Some(MetricsView {
        hostname: text(metrics, "hostname"),
        os: text(metrics, "os"),
        cpu_brand: text(metrics, "cpuBrand"),
        cpu_cores: number(metrics, "cpuCores") as u32,
        cpu_usage_percent: optional_number(metrics, "cpuUsagePercent"),
        memory_used_bytes: number(metrics, "memoryUsedBytes") as u64,
        memory_total_bytes: number(metrics, "memoryTotalBytes") as u64,
        download_bytes_per_second: optional_number(metrics, "downloadBytesPerSecond"),
        upload_bytes_per_second: optional_number(metrics, "uploadBytesPerSecond"),
        disk_used_bytes: number(metrics, "diskUsedBytes") as u64,
        disk_total_bytes: number(metrics, "diskTotalBytes") as u64,
        disk_read_bytes_per_second: optional_number(metrics, "diskReadBytesPerSecond"),
        disk_write_bytes_per_second: optional_number(metrics, "diskWriteBytesPerSecond"),
    })
}

fn parse_process(value: &Value) -> ProcessView {
    ProcessView {
        pid: number(value, "pid") as i64,
        name: text(value, "name"),
        cpu_percent: number(value, "cpuPercent"),
        memory_bytes: number(value, "memoryBytes") as u64,
        download_bytes_per_second: number(value, "downloadBytesPerSecond"),
        upload_bytes_per_second: number(value, "uploadBytesPerSecond"),
        read_bytes_per_second: number(value, "readBytesPerSecond"),
        write_bytes_per_second: number(value, "writeBytesPerSecond"),
        ports: items(value, "ports")
            .into_iter()
            .filter_map(Value::as_u64)
            .filter_map(|port| u16::try_from(port).ok())
            .collect(),
        priority: value.get("priority").and_then(Value::as_i64),
    }
}

fn parse_system(value: &Value) -> SystemView {
    let system = value.get("system").cloned().unwrap_or(Value::Null);
    SystemView {
        status: text(&system, "status"),
        sort_by: text(&system, "sortBy"),
        sort_direction: text(&system, "sortDirection"),
        filter: text(&system, "filter"),
        selected_pid: system.get("selectedPid").and_then(Value::as_i64),
        process_count: number(&system, "processCount") as usize,
        metrics: parse_metrics(&system),
        processes: items(&system, "processes").into_iter().map(parse_process).collect(),
    }
}

fn parse_info(value: &Value) -> InfoView {
    let info = value.get("info").cloned().unwrap_or(Value::Null);
    InfoView {
        unread: number(&info, "unread") as u32,
        items: items(&info, "items")
            .into_iter()
            .map(|item| InfoItemView {
                at: text(item, "at"),
                title: text(item, "title"),
                message: text(item, "message"),
                level: text(item, "level"),
            })
            .collect(),
    }
}

fn parse_terminals(value: &Value) -> HashMap<String, TerminalBufferView> {
    let mut terminals = HashMap::new();
    if let Some(map) = value.get("terminals").and_then(Value::as_object) {
        for (subtab_id, buffer) in map {
            terminals.insert(
                subtab_id.clone(),
                TerminalBufferView {
                    session_id: text(buffer, "sessionId"),
                    text: text(buffer, "text"),
                },
            );
        }
    }
    terminals
}

pub fn parse_snapshot(json: &str) -> Result<SnapshotView, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|error| format!("Invalid app state: {error}"))?;
    Ok(SnapshotView {
        seq: number(&value, "seq") as u64,
        active_tab_id: text(&value, "activeTabId"),
        active_subtab_id: text(&value, "activeSubtabId"),
        workspaces: items(&value, "workspaces").into_iter().map(parse_workspace).collect(),
        terminals: parse_terminals(&value),
        system: parse_system(&value),
        info: parse_info(&value),
        clipboard_count: value
            .get("clipboard")
            .map(|clipboard| number(clipboard, "count") as usize)
            .unwrap_or(0),
        clipboard_items: value
            .get("clipboard")
            .map(|clipboard| {
                items(clipboard, "items")
                    .into_iter()
                    .map(|item| ClipboardItemView {
                        id: text(item, "id"),
                        kind: text(item, "kind"),
                        pinned: boolean(item, "pinned"),
                        preview: text(item, "preview"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}
