use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPermissions {
    pub platform: String,
    pub microphone: String,
    pub screen_recording: String,
    pub system_audio: String,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::MediaPermissions;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    fn microphone_status() -> &'static str {
        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            return "unavailable";
        };
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) } {
            AVAuthorizationStatus::Authorized => "authorized",
            AVAuthorizationStatus::Denied => "denied",
            AVAuthorizationStatus::Restricted => "restricted",
            AVAuthorizationStatus::NotDetermined => "notDetermined",
            _ => "unknown",
        }
    }

    fn screen_recording_status() -> &'static str {
        if CGPreflightScreenCaptureAccess() {
            "authorized"
        } else {
            "denied"
        }
    }

    pub fn status() -> MediaPermissions {
        let screen_recording = screen_recording_status().to_string();
        MediaPermissions {
            platform: "macos".to_string(),
            microphone: microphone_status().to_string(),
            system_audio: screen_recording.clone(),
            screen_recording,
        }
    }

    fn settings_url(permission: &str) -> &'static str {
        match permission {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        }
    }

    fn open_settings(permission: &str) -> Result<(), String> {
        Command::new("open")
            .arg(settings_url(permission))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open System Settings: {error}"))
    }

    fn request_microphone() -> Result<(), String> {
        match microphone_status() {
            "authorized" => return Ok(()),
            "denied" | "restricted" => return open_settings("microphone"),
            "notDetermined" => {}
            _ => return Err("Microphone permission is unavailable.".to_string()),
        }

        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            return Err("Microphone permission is unavailable.".to_string());
        };
        let (sender, receiver) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = sender.send(granted.as_bool());
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler)
        };
        let granted = receiver
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "Timed out waiting for the microphone permission response.".to_string())?;
        if !granted {
            open_settings("microphone")?;
        }
        Ok(())
    }

    fn request_screen_recording() -> Result<(), String> {
        if CGPreflightScreenCaptureAccess() {
            return Ok(());
        }
        if !CGRequestScreenCaptureAccess() {
            open_settings("screenRecording")?;
        }
        Ok(())
    }

    pub fn request(permission: &str) -> Result<MediaPermissions, String> {
        match permission {
            "microphone" => request_microphone()?,
            "screenRecording" => request_screen_recording()?,
            _ => return Err(format!("Unknown media permission: {permission}")),
        }
        Ok(status())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::MediaPermissions;
    use std::process::Command;
    use std::ptr;

    fn source_name(line: &str) -> &str {
        line.split_whitespace().nth(1).unwrap_or("")
    }

    pub fn from_capabilities(
        audio_server_available: bool,
        sources: &str,
        screen_capture_available: bool,
    ) -> MediaPermissions {
        let names: Vec<&str> = sources
            .lines()
            .map(source_name)
            .filter(|name| !name.is_empty())
            .collect();
        let microphone_available = audio_server_available
            && names
                .iter()
                .any(|name| !name.to_ascii_lowercase().ends_with(".monitor"));
        let system_audio_available = audio_server_available
            && names
                .iter()
                .any(|name| name.to_ascii_lowercase().ends_with(".monitor"));
        MediaPermissions {
            platform: "linux".to_string(),
            microphone: if microphone_available {
                "authorized"
            } else {
                "unavailable"
            }
            .to_string(),
            screen_recording: if screen_capture_available {
                "authorized"
            } else {
                "unavailable"
            }
            .to_string(),
            system_audio: if system_audio_available {
                "authorized"
            } else {
                "unavailable"
            }
            .to_string(),
        }
    }

    fn pulse_sources() -> (bool, String) {
        match Command::new("pactl")
            .args(["list", "short", "sources"])
            .output()
        {
            Ok(output) if output.status.success() => {
                (true, String::from_utf8_lossy(&output.stdout).into_owned())
            }
            _ => {
                let server_available = std::env::var_os("XDG_RUNTIME_DIR")
                    .map(std::path::PathBuf::from)
                    .map(|path| path.join("pulse").join("native").exists())
                    .unwrap_or(false);
                (server_available, String::new())
            }
        }
    }

    fn x11_capture_available() -> bool {
        if std::env::var_os("DISPLAY").is_none() {
            return false;
        }
        let Ok(xlib) = x11_dl::xlib::Xlib::open() else {
            return false;
        };
        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            return false;
        }
        unsafe { (xlib.XCloseDisplay)(display) };
        true
    }

    fn desktop_portal_available() -> bool {
        if std::env::var_os("WAYLAND_DISPLAY").is_none()
            && std::env::var("XDG_SESSION_TYPE").ok().as_deref() != Some("wayland")
        {
            return false;
        }
        Command::new("busctl")
            .args([
                "--user",
                "--no-pager",
                "status",
                "org.freedesktop.portal.Desktop",
            ])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub fn status() -> MediaPermissions {
        let (audio_server_available, sources) = pulse_sources();
        from_capabilities(
            audio_server_available,
            &sources,
            x11_capture_available() || desktop_portal_available(),
        )
    }

    pub fn request(permission: &str) -> Result<MediaPermissions, String> {
        let permissions = status();
        let available = match permission {
            "microphone" => permissions.microphone == "authorized",
            "screenRecording" => permissions.screen_recording == "authorized",
            _ => return Err(format!("Unknown media permission: {permission}")),
        };
        if available {
            Ok(permissions)
        } else {
            Err(match permission {
                "microphone" => {
                    "No PulseAudio or PipeWire microphone input is available.".to_string()
                }
                _ => {
                    "No accessible X11 display or Wayland desktop portal is available.".to_string()
                }
            })
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::MediaPermissions;

    pub fn status() -> MediaPermissions {
        MediaPermissions {
            platform: std::env::consts::OS.to_string(),
            microphone: "unavailable".to_string(),
            screen_recording: "unavailable".to_string(),
            system_audio: "unavailable".to_string(),
        }
    }

    pub fn request(permission: &str) -> Result<MediaPermissions, String> {
        Err(format!(
            "The {permission} permission flow is unavailable on this platform."
        ))
    }
}

#[cfg(target_os = "linux")]
pub fn linux_permissions_from_capabilities(
    audio_server_available: bool,
    sources: &str,
    screen_capture_available: bool,
) -> MediaPermissions {
    platform::from_capabilities(audio_server_available, sources, screen_capture_available)
}

pub fn status() -> MediaPermissions {
    platform::status()
}

pub fn request(permission: &str) -> Result<MediaPermissions, String> {
    platform::request(permission)
}
