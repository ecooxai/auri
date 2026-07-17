//! Keyboard byte-stream decoding for the raw-mode TUI. Std-only so the
//! dependency-light Rust test harness can cover it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Escape,
    Backspace,
    Tab,
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    CtrlC,
}

/// Decode a chunk of raw stdin bytes into keys. Unrecognised escape
/// sequences and stray control bytes are dropped; a lone ESC byte is the
/// Escape key.
pub fn parse_keys(bytes: &[u8]) -> Vec<Key> {
    let mut keys = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            0x1b => {
                if index + 1 >= bytes.len() {
                    keys.push(Key::Escape);
                    index += 1;
                    continue;
                }
                if bytes[index + 1] == b'[' {
                    let mut end = index + 2;
                    while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                        end += 1;
                    }
                    if end < bytes.len() {
                        match &bytes[index + 2..=end] {
                            b"A" => keys.push(Key::Up),
                            b"B" => keys.push(Key::Down),
                            b"C" => keys.push(Key::Right),
                            b"D" => keys.push(Key::Left),
                            b"5~" => keys.push(Key::PageUp),
                            b"6~" => keys.push(Key::PageDown),
                            _ => {}
                        }
                        index = end + 1;
                    } else {
                        index = bytes.len();
                    }
                    continue;
                }
                keys.push(Key::Escape);
                index += 2;
            }
            b'\r' | b'\n' => {
                keys.push(Key::Enter);
                index += 1;
            }
            0x7f | 0x08 => {
                keys.push(Key::Backspace);
                index += 1;
            }
            b'\t' => {
                keys.push(Key::Tab);
                index += 1;
            }
            0x03 => {
                keys.push(Key::CtrlC);
                index += 1;
            }
            byte if byte < 0x20 => {
                index += 1;
            }
            _ => {
                // Decode one UTF-8 character.
                let width = match byte {
                    byte if byte >= 0xf0 => 4,
                    byte if byte >= 0xe0 => 3,
                    byte if byte >= 0xc0 => 2,
                    _ => 1,
                };
                let end = (index + width).min(bytes.len());
                if let Ok(text) = std::str::from_utf8(&bytes[index..end]) {
                    if let Some(character) = text.chars().next() {
                        keys.push(Key::Char(character));
                    }
                }
                index = end;
            }
        }
    }
    keys
}
