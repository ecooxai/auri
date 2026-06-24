use super::util::{encode_base64, file_kind, mime_type};
use super::workspace::{display_path, expand_path};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub file_type: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codec: Option<String>,
    pub bitrate: Option<u64>,
    pub modified: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFile {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub base64: String,
}

pub fn list_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let resolved = expand_path(path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&resolved)
        .map_err(|error| format!("Could not read {}: {error}", display_path(&resolved)))?
    {
        let item = item.map_err(|error| error.to_string())?;
        let metadata = item.metadata().map_err(|error| error.to_string())?;
        entries.push(FileEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: display_path(&item.path()),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                file_kind(&display_path(&item.path()))
            },
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn inspect_file(path: &str) -> Result<FileInfo, String> {
    let resolved = expand_path(path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    let path_string = display_path(&resolved);
    let kind = file_kind(&path_string).to_string();
    let (mut width, mut height) = image_dimensions(&resolved).unwrap_or((0, 0));
    let mut codec = None;
    let mut bitrate = None;

    if kind == "audio" || kind == "video" {
        if let Some(probe) = ffprobe(&resolved) {
            codec = probe.codec;
            bitrate = probe.bitrate;
            if width == 0 {
                width = probe.width.unwrap_or(0);
            }
            if height == 0 {
                height = probe.height.unwrap_or(0);
            }
        }
    }

    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(FileInfo {
        path: path_string.clone(),
        name: resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string(),
        kind,
        file_type: resolved
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_ascii_uppercase(),
        size: metadata.len(),
        width: (width > 0).then_some(width),
        height: (height > 0).then_some(height),
        codec,
        bitrate,
        modified,
    })
}

pub fn read_text_file(path: &str) -> Result<String, String> {
    let resolved = expand_path(path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("Text preview is limited to 2 MB for responsiveness.".to_string());
    }
    fs::read_to_string(&resolved)
        .map_err(|error| format!("Could not decode this file as UTF-8 text: {error}"))
}

pub fn read_binary_file(path: &str) -> Result<BinaryFile, String> {
    let resolved = expand_path(path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if metadata.len() > 32 * 1024 * 1024 {
        return Err("Attachments are limited to 32 MB.".to_string());
    }
    let bytes = fs::read(&resolved).map_err(|error| error.to_string())?;
    let path_string = display_path(&resolved);
    Ok(BinaryFile {
        path: path_string.clone(),
        name: resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .to_string(),
        mime: mime_type(&path_string).to_string(),
        base64: encode_base64(&bytes),
    })
}

pub fn open_external(path: &str) -> Result<(), String> {
    let resolved = expand_path(path)?;
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(&resolved).status()
    } else {
        Command::new("xdg-open").arg(&resolved).status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The operating system could not open this file.".to_string())
    }
}

struct ProbeResult {
    codec: Option<String>,
    bitrate: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
}

fn ffprobe(path: &Path) -> Option<ProbeResult> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    let streams = value.get("streams")?.as_array()?;
    let primary = streams
        .iter()
        .find(|item| item.get("codec_type").and_then(Value::as_str) == Some("video"))
        .or_else(|| streams.first());
    let codec = primary
        .and_then(|item| item.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let width = primary
        .and_then(|item| item.get("width"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let height = primary
        .and_then(|item| item.get("height"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let bitrate = primary
        .and_then(|item| item.get("bit_rate"))
        .and_then(value_as_u64)
        .or_else(|| {
            value
                .get("format")
                .and_then(|item| item.get("bit_rate"))
                .and_then(value_as_u64)
        });
    Some(ProbeResult {
        codec,
        bitrate,
        width,
        height,
    })
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(512 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        return Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        ));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut index = 2;
        while index + 9 < bytes.len() {
            if bytes[index] != 0xff {
                index += 1;
                continue;
            }
            let marker = bytes[index + 1];
            index += 2;
            if marker == 0xd8 || marker == 0xd9 {
                continue;
            }
            if index + 2 > bytes.len() {
                break;
            }
            let length = u16::from_be_bytes([bytes[index], bytes[index + 1]]) as usize;
            if length < 2 || index + length > bytes.len() {
                break;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                && length >= 7
            {
                let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]) as u32;
                let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
                return Some((width, height));
            }
            index += length;
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMedia {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

pub fn save_media_file(name: &str, kind: &str, base64: &str) -> Result<SavedMedia, String> {
    use super::util::{decode_base64, safe_file_name};
    use super::workspace::home_dir;

    let directory_name = match kind {
        "audio" => "audio",
        "video" => "video",
        "image" | "picture" => "picture",
        _ => return Err("Media kind must be audio, video, or image.".to_string()),
    };
    let bytes = decode_base64(base64)?;
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("Recorded media is limited to 256 MB per file.".to_string());
    }
    let directory = home_dir()?.join("auri").join("media").join(directory_name);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let safe_name = safe_file_name(name);
    let destination = directory.join(&safe_name);
    let temporary = directory.join(format!(".{safe_name}.tmp"));
    fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
    let path = display_path(&destination);
    Ok(SavedMedia {
        path: path.clone(),
        name: safe_name,
        mime: mime_type(&path).to_string(),
        size: bytes.len() as u64,
    })
}
