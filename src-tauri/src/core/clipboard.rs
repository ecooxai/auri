use super::workspace::home_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    pub kind: String,
    pub text: Option<String>,
    pub path: Option<String>,
    pub created_at: u64,
}

pub fn read_history() -> Result<Vec<ClipboardEntry>, String> {
    let path = home_dir()?
        .join("auri")
        .join("clipboard")
        .join("history.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut entries: Vec<ClipboardEntry> = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    if let Some(text) = current_text().filter(|value| !value.is_empty()) {
        let duplicate =
            entries.first().and_then(|entry| entry.text.as_deref()) == Some(text.as_str());
        if !duplicate {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis() as u64;
            entries.insert(
                0,
                ClipboardEntry {
                    id: format!("clip-{now}"),
                    kind: "text".to_string(),
                    text: Some(text),
                    path: None,
                    created_at: now,
                },
            );
            entries.truncate(200);
            let json = serde_json::to_string_pretty(&entries).map_err(|error| error.to_string())?;
            fs::write(&path, format!("{json}\n")).map_err(|error| error.to_string())?;
        }
    }
    Ok(entries)
}

fn current_text() -> Option<String> {
    let output = if cfg!(target_os = "macos") {
        Command::new("pbpaste").output().ok()?
    } else {
        Command::new("sh")
            .arg("-lc")
            .arg("command -v wl-paste >/dev/null && wl-paste -n || command -v xclip >/dev/null && xclip -selection clipboard -o || command -v xsel >/dev/null && xsel --clipboard --output")
            .output()
            .ok()?
    };
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}
