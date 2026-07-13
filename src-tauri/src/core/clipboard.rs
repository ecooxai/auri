use super::workspace::home_dir;
use arboard::{Clipboard, ImageData};
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_HISTORY_ITEMS: usize = 1000;
static PERSISTENT_CLIPBOARD: OnceLock<Mutex<Clipboard>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    pub kind: String,
    pub text: Option<String>,
    pub path: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

enum CurrentClipboard {
    Text {
        text: String,
        fingerprint: String,
    },
    Image {
        width: usize,
        height: usize,
        bytes: Vec<u8>,
        fingerprint: String,
        extension: String,
        encoded: bool,
    },
}

struct CopiedImageFile {
    extension: String,
    bytes: Vec<u8>,
    width: usize,
    height: usize,
}

fn copied_image_file(paths: &[PathBuf]) -> Option<CopiedImageFile> {
    const IMAGE_EXTENSIONS: &[&str] = &[
        "bmp", "gif", "ico", "jpeg", "jpg", "png", "tif", "tiff", "webp",
    ];
    paths.iter().find_map(|path| {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        if !IMAGE_EXTENSIONS.contains(&extension.as_str()) || !path.is_file() {
            return None;
        }
        let (width, height) = image::image_dimensions(path).ok()?;
        let bytes = fs::read(path).ok()?;
        Some(CopiedImageFile {
            extension,
            bytes,
            width: width as usize,
            height: height as usize,
        })
    })
}

fn clipboard_directory() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("auri").join("clipboard"))
}

fn history_path() -> Result<PathBuf, String> {
    Ok(clipboard_directory()?.join("history.json"))
}

fn ignored_fingerprint_path() -> Result<PathBuf, String> {
    Ok(clipboard_directory()?.join("ignored-fingerprint"))
}

fn now_millis() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64)
}

fn finalize_sha256(hasher: Sha256) -> String {
    format!("{:x}", hasher.finalize())
}

fn text_fingerprint(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"text\0");
    hasher.update(text.as_bytes());
    finalize_sha256(hasher)
}

fn image_fingerprint(width: usize, height: usize, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"image\0");
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(bytes);
    finalize_sha256(hasher)
}

fn current_clipboard() -> Option<CurrentClipboard> {
    let mut clipboard = Clipboard::new().ok()?;
    if let Ok(paths) = clipboard.get().file_list() {
        if let Some(image) = copied_image_file(&paths) {
            let fingerprint = image_fingerprint(image.width, image.height, &image.bytes);
            return Some(CurrentClipboard::Image {
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                fingerprint,
                extension: image.extension,
                encoded: true,
            });
        }
    }
    if let Ok(image) = clipboard.get_image() {
        let bytes = image.bytes.into_owned();
        let fingerprint = image_fingerprint(image.width, image.height, &bytes);
        return Some(CurrentClipboard::Image {
            width: image.width,
            height: image.height,
            bytes,
            fingerprint,
            extension: "png".to_string(),
            encoded: false,
        });
    }
    clipboard
        .get_text()
        .ok()
        .filter(|text| !text.is_empty())
        .map(|text| {
            let fingerprint = text_fingerprint(&text);
            CurrentClipboard::Text { text, fingerprint }
        })
}

fn persistent_clipboard() -> Result<&'static Mutex<Clipboard>, String> {
    if let Some(clipboard) = PERSISTENT_CLIPBOARD.get() {
        return Ok(clipboard);
    }
    let clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    let _ = PERSISTENT_CLIPBOARD.set(Mutex::new(clipboard));
    PERSISTENT_CLIPBOARD
        .get()
        .ok_or_else(|| "System clipboard is unavailable.".to_string())
}

fn save_image(path: &Path, width: usize, height: usize, bytes: Vec<u8>) -> Result<(), String> {
    let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, bytes)
        .ok_or_else(|| "Clipboard image data was malformed.".to_string())?;
    image.save(path).map_err(|error| error.to_string())
}

fn load_history(path: &Path) -> Result<Vec<ClipboardEntry>, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| error.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn persist_history(path: &Path, entries: &[ClipboardEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())?;
    fs::write(path, format!("{json}\n")).map_err(|error| error.to_string())
}

fn remove_entry_image(entry: &ClipboardEntry, images: &Path) -> Result<(), String> {
    if entry.kind != "image" {
        return Ok(());
    }
    let Some(path) = entry.path.as_deref() else {
        return Ok(());
    };
    let image_path = Path::new(path);
    if !image_path.starts_with(images) {
        return Ok(());
    }
    match fs::remove_file(image_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn enforce_history_limit(entries: &mut Vec<ClipboardEntry>, images: &Path) -> Result<bool, String> {
    let mut changed = false;
    while entries.len() > MAX_HISTORY_ITEMS {
        let Some(index) = entries.iter().rposition(|entry| !entry.pinned) else {
            break;
        };
        let removed = entries.remove(index);
        remove_entry_image(&removed, images)?;
        changed = true;
    }
    Ok(changed)
}

// Older history entries (and any written before image metadata was tracked)
// lack dimensions and size. Backfill them cheaply from the saved PNG so the
// clipboard panel can show type, resolution, and size for every image.
fn backfill_image_metadata(entries: &mut [ClipboardEntry]) -> bool {
    let mut changed = false;
    for entry in entries.iter_mut() {
        if entry.kind != "image" {
            continue;
        }
        let Some(path) = entry.path.clone() else {
            continue;
        };
        if entry.width.is_none() || entry.height.is_none() {
            if let Ok((width, height)) = image::image_dimensions(&path) {
                entry.width = Some(width);
                entry.height = Some(height);
                changed = true;
            }
        }
        if entry.byte_size.is_none() {
            if let Ok(meta) = fs::metadata(&path) {
                entry.byte_size = Some(meta.len());
                changed = true;
            }
        }
        if entry.format.is_none() {
            if let Some(extension) = Path::new(&path).extension().and_then(|value| value.to_str()) {
                entry.format = Some(extension.to_lowercase());
                changed = true;
            }
        }
    }
    changed
}

fn read_ignored_fingerprint(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clear_ignored_fingerprint(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn read_history() -> Result<Vec<ClipboardEntry>, String> {
    let directory = clipboard_directory()?;
    let path = history_path()?;
    let images = directory.join("images");
    let ignored_path = ignored_fingerprint_path()?;
    fs::create_dir_all(&images).map_err(|error| error.to_string())?;
    let mut entries = load_history(&path).unwrap_or_default();
    let mut changed = enforce_history_limit(&mut entries, &images)?;
    if backfill_image_metadata(&mut entries) {
        changed = true;
    }

    if let Some(current) = current_clipboard() {
        let fingerprint = match &current {
            CurrentClipboard::Text { fingerprint, .. }
            | CurrentClipboard::Image { fingerprint, .. } => fingerprint,
        };
        let ignored = read_ignored_fingerprint(&ignored_path);
        if ignored.as_deref() != Some(fingerprint.as_str()) {
            if ignored.is_some() {
                clear_ignored_fingerprint(&ignored_path)?;
            }
            let now = now_millis()?;
            if let Some(duplicate_index) = entries
                .iter()
                .position(|entry| entry.fingerprint.as_deref() == Some(fingerprint.as_str()))
            {
                if duplicate_index != 0 {
                    let mut existing = entries.remove(duplicate_index);
                    existing.created_at = now;
                    entries.insert(0, existing);
                    changed = true;
                }
            } else {
                let id = format!("clip-{now}");
                let entry = match current {
                    CurrentClipboard::Text { text, fingerprint } => ClipboardEntry {
                        id,
                        kind: "text".to_string(),
                        text: Some(text),
                        path: None,
                        created_at: now,
                        pinned: false,
                        fingerprint: Some(fingerprint),
                        width: None,
                        height: None,
                        byte_size: None,
                        format: None,
                    },
                    CurrentClipboard::Image {
                        width,
                        height,
                        bytes,
                        fingerprint,
                        extension,
                        encoded,
                    } => {
                        let image_path = images.join(format!("{id}.{extension}"));
                        if encoded {
                            fs::write(&image_path, bytes).map_err(|error| error.to_string())?;
                        } else {
                            save_image(&image_path, width, height, bytes)?;
                        }
                        let byte_size = fs::metadata(&image_path).map(|meta| meta.len()).ok();
                        ClipboardEntry {
                            id,
                            kind: "image".to_string(),
                            text: None,
                            path: Some(image_path.to_string_lossy().into_owned()),
                            created_at: now,
                            pinned: false,
                            fingerprint: Some(fingerprint),
                            width: Some(width as u32),
                            height: Some(height as u32),
                            byte_size,
                            format: Some(extension),
                        }
                    }
                };
                entries.insert(0, entry);
                changed = true;
            }
        }
    }

    if enforce_history_limit(&mut entries, &images)? {
        changed = true;
    }
    if changed {
        persist_history(&path, &entries)?;
    }
    Ok(entries)
}

pub fn set_text(text: &str) -> Result<(), String> {
    let mut clipboard = persistent_clipboard()?
        .lock()
        .map_err(|_| "System clipboard is unavailable.".to_string())?;
    clipboard
        .set_text(text.to_string())
        .map_err(|error| error.to_string())
}

pub fn set_pinned(id: &str, pinned: bool) -> Result<Vec<ClipboardEntry>, String> {
    let path = history_path()?;
    let mut entries = load_history(&path)?;
    let entry = entries
        .iter_mut()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "Clipboard item was not found.".to_string())?;
    entry.pinned = pinned;
    persist_history(&path, &entries)?;
    Ok(entries)
}

pub fn update_entry_text(id: &str, text: &str) -> Result<Vec<ClipboardEntry>, String> {
    let path = history_path()?;
    let mut entries = load_history(&path)?;
    let entry = entries
        .iter_mut()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "Clipboard item was not found.".to_string())?;
    if entry.kind != "text" {
        return Err("Only text clipboard items can be edited.".to_string());
    }
    entry.text = Some(text.to_string());
    entry.fingerprint = Some(text_fingerprint(text));
    persist_history(&path, &entries)?;
    Ok(entries)
}

pub fn remove_entry(id: &str) -> Result<Vec<ClipboardEntry>, String> {
    let directory = clipboard_directory()?;
    let path = history_path()?;
    let images = directory.join("images");
    let ignored_path = ignored_fingerprint_path()?;
    let mut entries = load_history(&path)?;
    let index = entries
        .iter()
        .position(|entry| entry.id == id)
        .ok_or_else(|| "Clipboard item was not found.".to_string())?;
    let removed = entries.remove(index);
    remove_entry_image(&removed, &images)?;
    persist_history(&path, &entries)?;
    if let Some(fingerprint) = removed.fingerprint {
        fs::write(ignored_path, format!("{fingerprint}\n")).map_err(|error| error.to_string())?;
    }
    Ok(entries)
}

fn set_entry_on_clipboard(entry: &ClipboardEntry) -> Result<(), String> {
    let mut clipboard = persistent_clipboard()?
        .lock()
        .map_err(|_| "System clipboard is unavailable.".to_string())?;
    match entry.kind.as_str() {
        "text" => clipboard
            .set_text(entry.text.clone().unwrap_or_default())
            .map_err(|error| error.to_string()),
        "image" => {
            let path = entry
                .path
                .as_deref()
                .ok_or_else(|| "Clipboard image path is missing.".to_string())?;
            let image = image::open(path)
                .map_err(|error| error.to_string())?
                .into_rgba8();
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
    let entries = load_history(&history_path()?)?;
    let entry = entries
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "Clipboard item was not found.".to_string())?;
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
        // Wayland sessions need wtype (or the ydotool daemon); X11 uses xdotool.
        Command::new("sh")
            .arg("-lc")
            .arg(concat!(
                "if [ -n \"$WAYLAND_DISPLAY\" ] && command -v wtype >/dev/null; then ",
                "wtype -M alt -P Tab -p Tab -m alt && sleep 0.5 && wtype -M ctrl -P v -p v -m ctrl; ",
                "elif [ -n \"$DISPLAY\" ] && command -v xdotool >/dev/null; then ",
                "xdotool key --clearmodifiers alt+Tab && sleep 0.5 && xdotool key --clearmodifiers ctrl+v; ",
                "elif command -v ydotool >/dev/null; then ",
                "ydotool key 56:1 15:1 15:0 56:0; sleep 0.5; ydotool key 29:1 47:1 47:0 29:0; ",
                "else exit 127; fi"
            ))
            .status()
    }
    .map_err(|error| error.to_string())?;
    status.success().then_some(()).ok_or_else(|| "Could not focus the previous application and paste. The item stays on the clipboard — paste it with Ctrl+V. (macOS needs Accessibility permission; Linux needs wtype on Wayland or xdotool on X11.)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, pinned: bool, path: Option<String>) -> ClipboardEntry {
        ClipboardEntry {
            id: id.to_string(),
            kind: if path.is_some() { "image" } else { "text" }.to_string(),
            text: path.is_none().then(|| id.to_string()),
            path,
            created_at: 1,
            pinned,
            fingerprint: Some(id.to_string()),
            width: None,
            height: None,
            byte_size: None,
            format: None,
        }
    }

    #[test]
    fn retention_preserves_all_pinned_entries_even_above_the_soft_limit() {
        let root =
            std::env::temp_dir().join(format!("auri-clipboard-pinned-test-{}", std::process::id()));
        let images = root.join("images");
        fs::create_dir_all(&images).unwrap();
        let mut entries = (0..=MAX_HISTORY_ITEMS)
            .map(|index| entry(&format!("pinned-{index}"), true, None))
            .collect::<Vec<_>>();

        assert!(!enforce_history_limit(&mut entries, &images).unwrap());
        assert_eq!(entries.len(), MAX_HISTORY_ITEMS + 1);
        assert!(entries.iter().all(|item| item.pinned));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backfill_fills_dimensions_size_and_format_for_image_entries() {
        let root =
            std::env::temp_dir().join(format!("auri-clipboard-meta-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let image_path = root.join("shot.png");
        save_image(&image_path, 4, 2, vec![0u8; 4 * 2 * 4]).unwrap();

        let mut entries = vec![
            entry(
                "img",
                false,
                Some(image_path.to_string_lossy().into_owned()),
            ),
            entry("text", false, None),
        ];

        assert!(backfill_image_metadata(&mut entries));
        assert_eq!(entries[0].width, Some(4));
        assert_eq!(entries[0].height, Some(2));
        assert_eq!(entries[0].format.as_deref(), Some("png"));
        assert!(entries[0].byte_size.unwrap() > 0);
        // Text entries are left untouched.
        assert_eq!(entries[1].width, None);
        assert_eq!(entries[1].format, None);

        // A second pass has nothing to do once metadata is present.
        assert!(!backfill_image_metadata(&mut entries));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copied_image_file_keeps_its_original_bytes_and_extension() {
        let root = std::env::temp_dir().join(format!(
            "auri-clipboard-original-image-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let jpeg_path = root.join("photo.JPEG");
        let pixels = [255u8, 0, 0];
        image::save_buffer_with_format(
            &jpeg_path,
            &pixels,
            1,
            1,
            image::ColorType::Rgb8,
            image::ImageFormat::Jpeg,
        )
        .unwrap();
        let original = fs::read(&jpeg_path).unwrap();

        let image = copied_image_file(&[root.join("notes.txt"), jpeg_path.clone()]).unwrap();

        assert_eq!(image.extension, "jpeg");
        assert_eq!(image.bytes, original);
        assert_eq!((image.width, image.height), (1, 1));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copied_non_image_files_are_not_treated_as_clipboard_images() {
        let root = std::env::temp_dir().join(format!(
            "auri-clipboard-non-image-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let text_path = root.join("photo.txt");
        fs::write(&text_path, b"not an image").unwrap();

        assert!(copied_image_file(&[text_path]).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retention_prefers_evicting_old_unpinned_entries_and_deletes_images() {
        let root = std::env::temp_dir().join(format!("auri-clipboard-test-{}", std::process::id()));
        let images = root.join("images");
        fs::create_dir_all(&images).unwrap();
        let old_image = images.join("old.png");
        fs::write(&old_image, b"image").unwrap();

        let mut entries = (0..MAX_HISTORY_ITEMS)
            .map(|index| {
                entry(
                    &format!("clip-{index}"),
                    index == MAX_HISTORY_ITEMS - 1,
                    None,
                )
            })
            .collect::<Vec<_>>();
        entries.push(entry(
            "old-unpinned-image",
            false,
            Some(old_image.to_string_lossy().into_owned()),
        ));

        assert!(enforce_history_limit(&mut entries, &images).unwrap());
        assert_eq!(entries.len(), MAX_HISTORY_ITEMS);
        assert!(entries
            .iter()
            .any(|item| item.id == format!("clip-{}", MAX_HISTORY_ITEMS - 1)));
        assert!(!old_image.exists());
        let _ = fs::remove_dir_all(root);
    }
}
