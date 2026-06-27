use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPermissions {
    pub microphone: String,
    pub screen_recording: String,
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
        MediaPermissions {
            microphone: microphone_status().to_string(),
            screen_recording: screen_recording_status().to_string(),
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

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::MediaPermissions;

    pub fn status() -> MediaPermissions {
        MediaPermissions {
            microphone: "unavailable".to_string(),
            screen_recording: "unavailable".to_string(),
        }
    }

    pub fn request(permission: &str) -> Result<MediaPermissions, String> {
        Err(format!(
            "The {permission} permission flow is currently available only on macOS."
        ))
    }
}

pub fn status() -> MediaPermissions {
    platform::status()
}

pub fn request(permission: &str) -> Result<MediaPermissions, String> {
    platform::request(permission)
}
