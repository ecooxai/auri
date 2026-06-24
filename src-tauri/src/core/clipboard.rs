use super::workspace::home_dir;
use arboard::{Clipboard, ImageData};
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

enum CurrentClipboard {
    Text { text: String, fingerprint: String },
    Image { width: usize, height: usize, bytes: Vec<u8>, fingerprint: String },
}

fn clipboard_directory() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("auri").join("clipboard"))
}

fn history_path() -> Result<PathBuf, String> {
    Ok(clipboard_directory()?.join("history.json"))
}

fn now_millis() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64)
}

fn hash_value<T: Hash>(value: &T) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn current_clipboard() -> Option<CurrentClipboard> {
    let mut clipboard = Clipboard::new().ok()?;
    if let Ok(image) = clipboard.get_image() {
        let bytes = image.bytes.into_owned();
        let fingerprint = hash_value(&(image.width, image.height, &bytes));
        return Some(CurrentClipboard::Image {
            width: image.width,
            height: image.height,
            bytes,
            fingerprint,
        });
    }
    clipboard.get_text().ok().filter(|text| !text.is_empty()).map(|text| {
        let fingerprint = hash_value(&text);
        CurrentClipboard::Text { text, fingerprint }
    })
}

fn save_image(path: &Path, width: usize, height: usize, bytes: Vec<u8>) -> Result<(), String> {
    let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, bytes)
        .ok_or_else(|| "Clipboard image data was malformed.".to_string())?;
    image.save(path).map_err(|error| error.to_string())
}

fn persist_history(path: &Path, entries: &[ClipboardEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())?;
    fs::write(path, format!("{json}\n")).map_err(|error| error.to_string())
}

pub fn read_history() -> Result<Vec<ClipboardEntry>, String> {
    let directory = clipboard_directory()?;
    let path = history_path()?;
    let images = directory.join("images");
    fs::create_dir_all(&images).map_err(|error| error.to_string())?;
    let mut entries: Vec<ClipboardEntry> = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    if let Some(current) = current_clipboard() {
        let fingerprint = match &current {
            CurrentClipboard::Text { fingerprint, .. } | CurrentClipboard::Image { fingerprint, .. } => fingerprint,
        };
        let duplicate = entries.first().and_then(|entry| entry.fingerprint.as_deref()) == Some(fingerprint.as_str());
        if !duplicate {
            let now = now_millis()?;
            let id = format!("clip-{now}");
            let entry = match current {
                CurrentClipboard::Text { text, fingerprint } => ClipboardEntry {
                    id,
                    kind: "text".to_string(),
                    text: Some(text),
                    path: None,
                    created_at: now,
                    fingerprint: Some(fingerprint),
                },
                CurrentClipboard::Image { width, height, bytes, fingerprint } => {
                    let image_path = images.join(format!("{id}.png"));
                    save_image(&image_path, width, height, bytes)?;
                    ClipboardEntry {
                        id,
                        kind: "image".to_string(),
                        text: None,
                        path: Some(image_path.to_string_lossy().into_owned()),
                        created_at: now,
                        fingerprint: Some(fingerprint),
                    }
                }
            };
            entries.insert(0, entry);
            entries.truncate(200);
            persist_history(&path, &entries)?;
        }
    }
    Ok(entries)
}

fn set_entry_on_clipboard(entry: &ClipboardEntry) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    match entry.kind.as_str() {
        "text" => clipboard
            .set_text(entry.text.clone().unwrap_or_default())
            .map_err(|error| error.to_string()),
        "image" => {
            let path = entry.path.as_deref().ok_or_else(|| "Clipboard image path is missing.".to_string())?;
            let image = image::open(path).map_err(|error| error.to_string())?.into_rgba8();
            let (width, height) = image.dimensions();
            clipboard
                .set_image(ImageData {
                    width: width as usize,
                    height: height as usize,
                    bytes: Cow::Owned(image.into_raw()),
                })
                .map_err(|error| error.to_string())
        }
        _ => Err("Unsupported clipboard entry type.".to_string()),
    }
}

pub fn prepare_paste(id: &str) -> Result<(), String> {
    let entries: Vec<ClipboardEntry> = fs::read_to_string(history_path()?)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))?;
    let entry = entries.iter().find(|entry| entry.id == id).ok_or_else(|| "Clipboard item was not found.".to_string())?;
    set_entry_on_clipboard(entry)
}

pub fn focus_previous_and_paste() -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to key code 48 using command down",
                "-e",
                "delay 0.5",
                "-e",
                "tell application \"System Events\" to keystroke \"v\" using command down",
            ])
            .status()
    } else {
        Command::new("sh")
            .arg("-lc")
            .arg("if command -v xdotool >/dev/null; then xdotool key --clearmodifiers alt+Tab && sleep 0.5 && xdotool key --clearmodifiers ctrl+v; elif command -v ydotool >/dev/null; then ydotool key 56:1 15:1 15:0 56:0; sleep 0.5; ydotool key 29:1 47:1 47:0 29:0; else exit 127; fi")
            .status()
    }
    .map_err(|error| error.to_string())?;
    status.success().then_some(()).ok_or_else(|| "Could not focus the previous application and paste. Accessibility permission or xdotool/ydotool may be required.".to_string())
}
