use std::path::Path;

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (a << 16) | (b << 8) | c;
        output.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn file_kind(path: &str) -> &'static str {
    match extension(path).as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" => "image",
        "wav" | "m4a" | "mp3" | "ogg" | "flac" | "aac" => "audio",
        "mp4" | "mov" | "webm" | "mkv" | "avi" => "video",
        "txt" | "md" | "json" | "js" | "mjs" | "ts" | "tsx" | "rs" | "toml" | "yaml" | "yml"
        | "html" | "css" | "sh" | "py" => "text",
        _ => "file",
    }
}

pub fn mime_type(path: &str) -> &'static str {
    match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "json" => "application/json",
        "html" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "txt" | "md" | "rs" | "toml" | "yaml" | "yml" | "sh" | "py" => "text/plain",
        _ => "application/octet-stream",
    }
}

pub fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() % 4 != 0 {
        return Err("Invalid base64 length.".to_string());
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for (chunk_index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = chunk_index == bytes.len() / 4 - 1;
        let pad2 = chunk[2] == b'=';
        let pad3 = chunk[3] == b'=';
        if (pad2 && !pad3) || ((!last) && (pad2 || pad3)) {
            return Err("Invalid base64 padding.".to_string());
        }
        let a = decode_base64_char(chunk[0])? as u32;
        let b = decode_base64_char(chunk[1])? as u32;
        let c = if pad2 {
            0
        } else {
            decode_base64_char(chunk[2])? as u32
        };
        let d = if pad3 {
            0
        } else {
            decode_base64_char(chunk[3])? as u32
        };
        let packed = (a << 18) | (b << 12) | (c << 6) | d;
        output.push(((packed >> 16) & 0xff) as u8);
        if !pad2 {
            output.push(((packed >> 8) & 0xff) as u8);
        }
        if !pad3 {
            output.push((packed & 0xff) as u8);
        }
    }
    Ok(output)
}

fn decode_base64_char(value: u8) -> Result<u8, String> {
    match value {
        b'A'..=b'Z' => Ok(value - b'A'),
        b'a'..=b'z' => Ok(value - b'a' + 26),
        b'0'..=b'9' => Ok(value - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("Invalid base64 character.".to_string()),
    }
}

pub fn safe_file_name(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("auri-media.bin")
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

pub fn normalize_cli_command(arguments: &[String]) -> Result<String, String> {
    if arguments.is_empty() {
        return Err("Enter an Auri command, for example: auri tab new".to_string());
    }
    if arguments
        .iter()
        .any(|value| value.contains(['\n', '\r', '\0']))
    {
        return Err("Command arguments cannot contain line breaks or NUL bytes.".to_string());
    }
    let start = usize::from(
        arguments
            .first()
            .is_some_and(|value| value.eq_ignore_ascii_case("auri")),
    );
    if start >= arguments.len() {
        return Err("Enter a command after auri.".to_string());
    }
    Ok(arguments[start..]
        .iter()
        .map(|value| quote_command_argument(value))
        .collect::<Vec<_>>()
        .join(" "))
}

fn quote_command_argument(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|character| !character.is_whitespace() && character != '\\' && character != '"')
    {
        return value.to_string();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub fn shell_history_command(line: &str) -> Option<String> {
    let value = line.trim();
    if value.is_empty() {
        return None;
    }
    if value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let command = if value.starts_with(": ") {
        value
            .split_once(';')
            .map(|(_, command)| command)
            .unwrap_or(value)
    } else {
        value
    };
    let command = command.trim();
    (!command.is_empty()).then(|| command.to_string())
}

pub fn recent_shell_history_commands(histories: &[String], limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut commands = Vec::new();
    for history in histories {
        for line in history.lines().rev() {
            let Some(command) = shell_history_command(line) else {
                continue;
            };
            if seen.insert(command.clone()) {
                commands.push(command);
                if commands.len() >= limit {
                    return commands;
                }
            }
        }
    }
    commands
}
