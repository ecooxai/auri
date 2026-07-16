//! Disk persistence for slept web tabs. A background tab's webview is
//! destroyed to release its WebKit content process, and this record is all
//! that remains until the tab is reopened; cookies and site storage stay in
//! the shared browser profile. Std-only so the dependency-light Rust test
//! harness can cover it.

use std::path::{Path, PathBuf};

const FORMAT_VERSION: &str = "auri-web-sleep-1";

#[derive(Clone, Debug, PartialEq)]
pub struct SleepRecord {
    pub id: String,
    pub url: String,
    pub slept_at_ms: u64,
}

fn file_stem(id: &str) -> String {
    let stem: String = id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    if stem.is_empty() {
        "webview".to_string()
    } else {
        stem
    }
}

fn record_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("{}.sleep", file_stem(id)))
}

pub fn write_record(directory: &Path, record: &SleepRecord) -> Result<(), String> {
    if record.id.contains(['\n', '\r']) || record.url.contains(['\n', '\r']) {
        return Err("Webview sleep states cannot contain line breaks.".to_string());
    }
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the webview sleep directory: {error}"))?;
    let contents = format!(
        "{FORMAT_VERSION}\n{}\n{}\n{}\n",
        record.id, record.url, record.slept_at_ms
    );
    let temporary = directory.join(format!(".{}.tmp", file_stem(&record.id)));
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("Could not save the webview sleep state: {error}"))?;
    std::fs::rename(&temporary, record_path(directory, &record.id))
        .map_err(|error| format!("Could not save the webview sleep state: {error}"))
}

/// Read and delete the sleep record for a tab. Unreadable or stale-format
/// records are discarded and reported as absent so the tab falls back to its
/// last known URL instead of failing to open.
pub fn take_record(directory: &Path, id: &str) -> Option<SleepRecord> {
    let path = record_path(directory, id);
    let contents = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let mut lines = contents.lines();
    if lines.next() != Some(FORMAT_VERSION) {
        return None;
    }
    let saved_id = lines.next()?.to_string();
    let url = lines.next()?.to_string();
    let slept_at_ms = lines.next()?.parse::<u64>().ok()?;
    if saved_id != id || !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    Some(SleepRecord {
        id: saved_id,
        url,
        slept_at_ms,
    })
}

pub fn remove_record(directory: &Path, id: &str) {
    let _ = std::fs::remove_file(record_path(directory, id));
}
