use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub root: String,
    pub config_path: String,
    pub mode: &'static str,
    pub configuration: Value,
}

pub fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not available in this environment.".to_string())
}

pub fn expand_path(value: &str) -> Result<PathBuf, String> {
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return Ok(home_dir()?.join(rest));
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path))
    }
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn initialize() -> Result<InitResult, String> {
    let home = home_dir()?;
    let root = home.join("auri");
    let media = root.join("media");
    for path in [
        root.clone(),
        media.join("picture"),
        media.join("audio"),
        media.join("video"),
        root.join("subtabs"),
        root.join("clipboard"),
    ] {
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create {}: {error}", display_path(&path)))?;
    }

    let config_dir = home.join(".config").join("auri");
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config_path = config_dir.join("settings.json");
    if !config_path.exists() {
        fs::write(&config_path, b"{}\n").map_err(|error| error.to_string())?;
    }
    let configuration = fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(InitResult {
        root: display_path(&root),
        config_path: display_path(&config_path),
        mode: "native",
        configuration,
    })
}

pub fn save_configuration(configuration: &Value) -> Result<(), String> {
    let path = home_dir()?
        .join(".config")
        .join("auri")
        .join("settings.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(configuration).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, format!("{json}\n")).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}
