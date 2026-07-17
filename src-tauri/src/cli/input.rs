//! Keyboard and mouse byte-stream decoding for the raw-mode TUI. Mouse
//! events use SGR reporting (`\x1b[<b;x;yM`). Std-only so the
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Press,
    Release,
    Drag,
    WheelUp,
    WheelDown,
}

/// One mouse event with 0-based screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mouse {
    pub kind: MouseKind,
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Key(Key),
    Mouse(Mouse),
}

fn parse_mouse(sequence: &[u8]) -> Option<Mouse> {
    // sequence looks like b"<0;5;3M" — SGR mouse report parameters.
    let body = sequence.strip_prefix(b"<")?;
    let final_byte = *body.last()?;
    let text = std::str::from_utf8(&body[..body.len() - 1]).ok()?;
    let mut parts = text.split(';');
    let button: u16 = parts.next()?.parse().ok()?;
    let x: u16 = parts.next()?.parse().ok()?;
    let y: u16 = parts.next()?.parse().ok()?;
    let kind = match (button, final_byte) {
        (64, _) => MouseKind::WheelUp,
        (65, _) => MouseKind::WheelDown,
        (_, b'm') => MouseKind::Release,
        (button, b'M') if button & 32 != 0 => MouseKind::Drag,
        (button, b'M') if button & 3 != 3 => MouseKind::Press,
        _ => return None,
    };
    Some(Mouse {
        kind,
        x: x.saturating_sub(1),
        y: y.saturating_sub(1),
    })
}

/// Decode a chunk of raw stdin bytes into key and mouse events.
/// Unrecognised escape sequences and stray control bytes are dropped; a lone
/// ESC byte is the Escape key.
pub fn parse_events(bytes: &[u8]) -> Vec<Event> {
    let mut events = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            0x1b => {
                if index + 1 >= bytes.len() {
                    events.push(Event::Key(Key::Escape));
                    index += 1;
                    continue;
                }
                if bytes[index + 1] == b'[' {
                    let mut end = index + 2;
                    while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                        end += 1;
                    }
                    if end < bytes.len() {
                        let sequence = &bytes[index + 2..=end];
                        match sequence {
                            b"A" => events.push(Event::Key(Key::Up)),
                            b"B" => events.push(Event::Key(Key::Down)),
                            b"C" => events.push(Event::Key(Key::Right)),
                            b"D" => events.push(Event::Key(Key::Left)),
                            b"5~" => events.push(Event::Key(Key::PageUp)),
                            b"6~" => events.push(Event::Key(Key::PageDown)),
                            sequence if sequence.starts_with(b"<") => {
                                if let Some(mouse) = parse_mouse(sequence) {
                                    events.push(Event::Mouse(mouse));
                                }
                            }
                            _ => {}
                        }
                        index = end + 1;
                    } else {
                        index = bytes.len();
                    }
                    continue;
                }
                events.push(Event::Key(Key::Escape));
                index += 2;
            }
            b'\r' | b'\n' => {
                events.push(Event::Key(Key::Enter));
                index += 1;
            }
            0x7f | 0x08 => {
                events.push(Event::Key(Key::Backspace));
                index += 1;
            }
            b'\t' => {
                events.push(Event::Key(Key::Tab));
                index += 1;
            }
            0x03 => {
                events.push(Event::Key(Key::CtrlC));
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
                        events.push(Event::Key(Key::Char(character)));
                    }
                }
                index = end;
            }
        }
    }
    events
}

/// Split raw stdin bytes for terminal passthrough mode: SGR mouse reports
/// are extracted as events for the TUI (tabs, wheel), every other byte —
/// arrows, function keys, control characters — passes through untouched so
/// the PTY sees exactly what the user typed.
pub fn split_terminal_input(bytes: &[u8]) -> (Vec<Mouse>, Vec<u8>) {
    let mut mice = Vec::new();
    let mut raw = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'[') && bytes.get(index + 2) == Some(&b'<') {
            let mut end = index + 3;
            while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                end += 1;
            }
            if end < bytes.len() {
                if let Some(mouse) = parse_mouse(&bytes[index + 2..=end]) {
                    mice.push(mouse);
                }
                index = end + 1;
                continue;
            }
            // Incomplete report at the chunk edge: drop it rather than leak
            // half a control sequence into the shell.
            break;
        }
        raw.push(bytes[index]);
        index += 1;
    }
    (mice, raw)
}

pub fn parse_keys(bytes: &[u8]) -> Vec<Key> {
    parse_events(bytes)
        .into_iter()
        .filter_map(|event| match event {
            Event::Key(key) => Some(key),
            Event::Mouse(_) => None,
        })
        .collect()
}
