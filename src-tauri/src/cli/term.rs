//! Raw-mode and screen control for the TUI, via termios/ioctl. Restores the
//! original terminal attributes on drop so a panic or quit never leaves the
//! user's shell in raw mode.

use std::io::Write;
use std::mem::MaybeUninit;
use std::os::unix::io::RawFd;

const STDIN: RawFd = 0;
const STDOUT: RawFd = 1;

pub struct RawMode {
    original: libc::termios,
}

impl RawMode {
    pub fn enable() -> Result<Self, String> {
        unsafe {
            let mut original = MaybeUninit::<libc::termios>::uninit();
            if libc::tcgetattr(STDIN, original.as_mut_ptr()) != 0 {
                return Err("auri cli needs an interactive terminal (stdin is not a TTY).".to_string());
            }
            let original = original.assume_init();
            let mut raw = original;
            libc::cfmakeraw(&mut raw);
            // Keep reads blocking: dedicated threads own stdin.
            raw.c_cc[libc::VMIN] = 1;
            raw.c_cc[libc::VTIME] = 0;
            if libc::tcsetattr(STDIN, libc::TCSANOW, &raw) != 0 {
                return Err("Could not switch the terminal to raw mode.".to_string());
            }
            Ok(RawMode { original })
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        unsafe {
            let _ = libc::tcsetattr(STDIN, libc::TCSANOW, &self.original);
        }
    }
}

pub fn terminal_size() -> (u16, u16) {
    unsafe {
        let mut size: libc::winsize = std::mem::zeroed();
        if libc::ioctl(STDOUT, libc::TIOCGWINSZ, &mut size) == 0 && size.ws_col > 0 && size.ws_row > 0 {
            return (size.ws_col, size.ws_row);
        }
    }
    (80, 24)
}

pub fn enter_ui_screen() {
    let mut stdout = std::io::stdout();
    // Alternate screen, hidden cursor, home.
    let _ = stdout.write_all(b"\x1b[?1049h\x1b[?25l\x1b[H");
    let _ = stdout.flush();
}

pub fn leave_ui_screen() {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(b"\x1b[0m\x1b[?25h\x1b[?1049l");
    let _ = stdout.flush();
}

pub fn draw_frame(frame: &str) {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(b"\x1b[H");
    let _ = stdout.write_all(frame.as_bytes());
    let _ = stdout.write_all(b"\x1b[0J");
    let _ = stdout.flush();
}
