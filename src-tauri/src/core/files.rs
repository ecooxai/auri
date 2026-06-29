use super::util::{encode_base64, file_kind, mime_type};
use super::workspace::{display_path, expand_path};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedItem {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub read: bool,
    pub write: bool,
    pub execute: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub total_size: u64,
    pub disk_total: Option<u64>,
    pub disk_used: Option<u64>,
    pub disk_available: Option<u64>,
    pub owner: String,
    pub mode: String,
    pub permissions: PermissionInfo,
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
    pub sample_rate: Option<u64>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileWrite {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedMedia {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub pending: bool,
    pub original_name: Option<String>,
}

pub fn list_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let resolved = expand_path(path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&resolved)
        .map_err(|error| format!("Could not read {}: {error}", display_path(&resolved)))?
    {
        let item = item.map_err(|error| error.to_string())?;
        let metadata = item.metadata().map_err(|error| error.to_string())?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
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
            modified,
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

fn direct_child_path(directory: &str, name: &str) -> Result<(PathBuf, String), String> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("The new item needs a name.".to_string());
    }
    if clean_name == "."
        || clean_name == ".."
        || clean_name.contains('/')
        || clean_name.contains('\\')
        || Path::new(clean_name).components().count() != 1
    {
        return Err(
            "Create items directly in the current folder; path separators are not allowed."
                .to_string(),
        );
    }
    let parent = expand_path(directory)?;
    let metadata = fs::metadata(&parent).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("The current path is not a folder.".to_string());
    }
    Ok((parent.join(clean_name), clean_name.to_string()))
}

pub fn create_file(directory: &str, name: &str) -> Result<CreatedItem, String> {
    let (destination, clean_name) = direct_child_path(directory, name)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| format!("Could not create {clean_name}: {error}"))?;
    Ok(CreatedItem {
        name: clean_name,
        path: display_path(&destination),
        kind: "file",
    })
}

pub fn create_folder(directory: &str, name: &str) -> Result<CreatedItem, String> {
    let (destination, clean_name) = direct_child_path(directory, name)?;
    fs::create_dir(&destination)
        .map_err(|error| format!("Could not create {clean_name}: {error}"))?;
    Ok(CreatedItem {
        name: clean_name,
        path: display_path(&destination),
        kind: "directory",
    })
}

fn recursive_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| recursive_size(&entry.path()))
        .fold(0_u64, u64::saturating_add)
}

fn disk_usage(path: &Path) -> (Option<u64>, Option<u64>, Option<u64>) {
    let Ok(output) = Command::new("df").arg("-Pk").arg(path).output() else {
        return (None, None, None);
    };
    if !output.status.success() {
        return (None, None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(line) = text.lines().filter(|line| !line.trim().is_empty()).last() else {
        return (None, None, None);
    };
    let values: Vec<u64> = line
        .split_whitespace()
        .filter_map(|value| value.parse::<u64>().ok())
        .take(3)
        .collect();
    if values.len() < 3 {
        return (None, None, None);
    }
    (
        Some(values[0].saturating_mul(1024)),
        Some(values[1].saturating_mul(1024)),
        Some(values[2].saturating_mul(1024)),
    )
}

#[cfg(unix)]
fn owner_and_permissions(metadata: &fs::Metadata) -> (String, String, PermissionInfo) {
    let uid = metadata.uid();
    let owner = Command::new("id")
        .args(["-nu", &uid.to_string()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uid.to_string());
    let mode = metadata.permissions().mode() & 0o7777;
    (
        owner,
        format!("{mode:04o}"),
        PermissionInfo {
            read: mode & 0o400 != 0,
            write: mode & 0o200 != 0,
            execute: mode & 0o100 != 0,
        },
    )
}

#[cfg(not(unix))]
fn owner_and_permissions(metadata: &fs::Metadata) -> (String, String, PermissionInfo) {
    let writable = !metadata.permissions().readonly();
    (
        std::env::var("USERNAME").unwrap_or_else(|_| "Unknown".to_string()),
        if writable { "writable" } else { "read-only" }.to_string(),
        PermissionInfo {
            read: true,
            write: writable,
            execute: false,
        },
    )
}

pub fn folder_info(path: &str) -> Result<FolderInfo, String> {
    let resolved = expand_path(path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }
    let (disk_total, disk_used, disk_available) = disk_usage(&resolved);
    let (owner, mode, permissions) = owner_and_permissions(&metadata);
    Ok(FolderInfo {
        path: display_path(&resolved),
        name: resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("/")
            .to_string(),
        total_size: recursive_size(&resolved),
        disk_total,
        disk_used,
        disk_available,
        owner,
        mode,
        permissions,
    })
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
    let mut sample_rate = None;

    if kind == "audio" || kind == "video" {
        if let Some(probe) = ffprobe(&resolved) {
            codec = probe.codec;
            bitrate = probe.bitrate;
            sample_rate = probe.sample_rate;
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
        sample_rate,
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

pub fn write_text_file(path: &str, content: &str) -> Result<TextFileWrite, String> {
    let resolved = expand_path(path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if content.len() > 4 * 1024 * 1024 {
        return Err("Text editing is limited to 4 MB for responsiveness.".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&resolved)
        .map_err(|error| format!("Could not open this text file for writing: {error}"))?;
    std::io::Write::write_all(&mut file, content.as_bytes())
        .map_err(|error| format!("Could not save this text file: {error}"))?;
    Ok(TextFileWrite {
        path: display_path(&resolved),
        size: content.len() as u64,
    })
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

pub fn open_external_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("Invalid web URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS URLs can be opened externally.".to_string());
    }
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The operating system could not open this URL.".to_string())
    }
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
    sample_rate: Option<u64>,
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
    let video_stream = streams
        .iter()
        .find(|item| item.get("codec_type").and_then(Value::as_str) == Some("video"));
    let audio_stream = streams
        .iter()
        .find(|item| item.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let primary = video_stream.or(audio_stream).or_else(|| streams.first());
    let codec = primary
        .and_then(|item| item.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let width = video_stream
        .and_then(|item| item.get("width"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let height = video_stream
        .and_then(|item| item.get("height"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let sample_rate = audio_stream
        .and_then(|item| item.get("sample_rate"))
        .and_then(value_as_u64);
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
        sample_rate,
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

fn converted_extension(format: &str) -> Option<&'static str> {
    match format {
        "mp3" => Some("mp3"),
        "wav" => Some("wav"),
        "m4a" => Some("m4a"),
        "mp4_h264" | "mp4_h265" => Some("mp4"),
        _ => None,
    }
}

fn default_converted_name(source: &Path, format: &str) -> Result<String, String> {
    let extension =
        converted_extension(format).ok_or_else(|| "Unsupported conversion format.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("media");
    Ok(format!("converted_{stem}.{extension}"))
}

fn temporary_converted_path(source: &Path, format: &str) -> Result<PathBuf, String> {
    let extension =
        converted_extension(format).ok_or_else(|| "Unsupported conversion format.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("media");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let directory = std::env::temp_dir().join("auri-conversions");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{stem}-{}-{nonce}.{extension}", std::process::id())))
}

fn unique_final_converted_path(source: &Path, requested_name: &str) -> Result<PathBuf, String> {
    use super::util::safe_file_name;
    let parent = source
        .parent()
        .ok_or_else(|| "Could not determine the source folder.".to_string())?;
    let safe_name = safe_file_name(requested_name);
    let requested = Path::new(&safe_name);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("converted_media");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("bin");
    for index in 0..1000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose a destination name for the converted file.".to_string())
}

fn normalized_sample_rate(sample_rate: Option<u32>) -> Option<String> {
    match sample_rate {
        Some(16_000) => Some("16000".to_string()),
        Some(24_000) => Some("24000".to_string()),
        Some(48_000) => Some("48000".to_string()),
        _ => None,
    }
}

fn normalized_resolution(resolution: Option<&str>) -> Option<&'static str> {
    match resolution.unwrap_or("native") {
        "480" | "480p" => Some("480"),
        "720" | "720p" => Some("720"),
        "1080" | "1080p" => Some("1080"),
        "1440" | "2k" | "2K" => Some("1440"),
        _ => None,
    }
}

fn waveform_size_for_resolution(resolution: Option<&str>) -> &'static str {
    match normalized_resolution(resolution) {
        Some("480") => "854x480",
        Some("1080") => "1920x1080",
        Some("1440") => "2560x1440",
        _ => "1280x720",
    }
}

pub fn convert_media_file(
    path: &str,
    format: &str,
    bitrate_kbps: Option<u32>,
    sample_rate: Option<u32>,
    resolution: Option<&str>,
) -> Result<ConvertedMedia, String> {
    let source = expand_path(path)?;
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    let path_string = display_path(&source);
    let kind = file_kind(&path_string);
    if kind != "audio" && kind != "video" {
        return Err("Only audio and video files can be converted.".to_string());
    }
    let destination = temporary_converted_path(&source, format)?;
    let default_name = default_converted_name(&source, format)?;
    let audio_bitrate = bitrate_kbps.unwrap_or(128).clamp(32, 512).to_string();
    let video_bitrate = bitrate_kbps.unwrap_or(1000).clamp(250, 20_000).to_string();
    let sample_rate_value = normalized_sample_rate(sample_rate);
    let video_codec = match format {
        "mp4_h264" => Some("libx264"),
        "mp4_h265" => Some("libx265"),
        _ => None,
    };

    let mut command = Command::new("ffmpeg");
    command.arg("-y").arg("-i").arg(&source);
    match format {
        "mp3" => {
            command.args(["-vn", "-b:a", &format!("{audio_bitrate}k")]);
            if let Some(rate) = sample_rate_value.as_deref() {
                command.args(["-ar", rate]);
            }
        }
        "wav" => {
            command.arg("-vn");
            if let Some(rate) = sample_rate_value.as_deref() {
                command.args(["-ar", rate]);
            }
        }
        "m4a" => {
            command.args(["-vn", "-c:a", "aac", "-b:a", &format!("{audio_bitrate}k")]);
            if let Some(rate) = sample_rate_value.as_deref() {
                command.args(["-ar", rate]);
            }
        }
        "mp4_h264" | "mp4_h265" => {
            let codec = video_codec.unwrap();
            if kind == "audio" {
                command.args([
                    "-filter_complex",
                    &format!(
                        "[0:a]showwaves=s={}:mode=cline:colors=white,format=yuv420p[v]",
                        waveform_size_for_resolution(resolution)
                    ),
                ]);
                command.args(["-map", "[v]", "-map", "0:a:0"]);
                command.args(["-c:v", codec, "-b:v", &format!("{video_bitrate}k")]);
                command.args(["-c:a", "aac", "-b:a", "128k", "-shortest"]);
            } else {
                if let Some(height) = normalized_resolution(resolution) {
                    command.args(["-vf", &format!("scale=-2:{height}")]);
                }
                command.args(["-c:v", codec, "-b:v", &format!("{video_bitrate}k")]);
                command.args(["-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p"]);
                if format == "mp4_h265" {
                    command.args(["-tag:v", "hvc1"]);
                }
            }
        }
        _ => return Err("Unsupported conversion format.".to_string()),
    }
    command.arg(&destination);
    let output = command
        .output()
        .map_err(|error| format!("Could not run ffmpeg. Install ffmpeg and try again: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("ffmpeg could not convert this file.");
        return Err(message.to_string());
    }
    let size = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    let display = display_path(&destination);
    Ok(ConvertedMedia {
        name: default_name,
        mime: mime_type(&display).to_string(),
        path: display,
        size,
        pending: true,
        original_name: source
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
    })
}

pub fn save_converted_media_file(
    source_path: &str,
    temp_path: &str,
    name: &str,
) -> Result<ConvertedMedia, String> {
    let source = expand_path(source_path)?;
    let temporary = expand_path(temp_path)?;
    let metadata = fs::metadata(&temporary).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The converted artifact is not a file.".to_string());
    }
    let destination = unique_final_converted_path(&source, name)?;
    fs::rename(&temporary, &destination)
        .or_else(|_| {
            fs::copy(&temporary, &destination)
                .and_then(|_| fs::remove_file(&temporary))
                .map(|_| ())
        })
        .map_err(|error| error.to_string())?;
    let size = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    let display = display_path(&destination);
    Ok(ConvertedMedia {
        name: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("converted")
            .to_string(),
        mime: mime_type(&display).to_string(),
        path: display,
        size,
        pending: false,
        original_name: None,
    })
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

#[cfg(test)]
mod folder_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("auri-folder-test-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn creates_direct_children_without_overwriting() {
        let directory = test_directory();
        let directory_text = directory.to_string_lossy();
        let file = create_file(&directory_text, "note.txt").unwrap();
        let folder = create_folder(&directory_text, "Work").unwrap();
        assert_eq!(file.kind, "file");
        assert_eq!(folder.kind, "directory");
        assert!(create_file(&directory_text, "note.txt").is_err());
        assert!(create_folder(&directory_text, "nested/path").is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn folder_info_reports_size_and_access() {
        let directory = test_directory();
        fs::write(directory.join("data.bin"), [1_u8, 2, 3, 4]).unwrap();
        let info = folder_info(&directory.to_string_lossy()).unwrap();
        assert_eq!(info.total_size, 4);
        assert!(info.permissions.read);
        assert!(!info.owner.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
