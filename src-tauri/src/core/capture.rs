use super::files::BinaryFile;
use super::util::{encode_base64, mime_type};
use super::workspace::{display_path, home_dir};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn screenshot() -> Result<BinaryFile, String> {
    let directory = home_dir()?.join("auri").join("media").join("picture");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let jpg = directory.join(format!("screenshot-{timestamp}.jpg"));

    if cfg!(target_os = "macos") {
        let status = Command::new("screencapture")
            .args(["-x", "-t", "jpg"])
            .arg(&jpg)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("macOS screenshot capture failed.".to_string());
        }
        return binary_result(&jpg);
    }

    let png = directory.join(format!("screenshot-{timestamp}.png"));
    let captured = Command::new("gnome-screenshot")
        .arg("-f")
        .arg(&png)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
        || Command::new("grim")
            .arg(&png)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    if !captured {
        return Err("Install gnome-screenshot or grim to capture the Linux desktop.".to_string());
    }

    let converted = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&png)
        .args(["-q:v", "5"])
        .arg(&jpg)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if converted {
        let _ = fs::remove_file(&png);
        binary_result(&jpg)
    } else {
        binary_result(&png)
    }
}

fn binary_result(path: &Path) -> Result<BinaryFile, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let path_string = display_path(path);
    Ok(BinaryFile {
        path: path_string.clone(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("screenshot")
            .to_string(),
        mime: mime_type(&path_string).to_string(),
        base64: encode_base64(&bytes),
    })
}
