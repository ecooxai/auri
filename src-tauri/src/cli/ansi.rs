//! ANSI text utilities for the TUI. Terminal buffers arrive as raw PTY
//! output; the TUI panel keeps SGR color runs but must drop cursor
//! addressing, screen clears, and OSC titles that would corrupt its own
//! layout. Std-only so the dependency-light Rust test harness can cover it.

const ESC: char = '\u{1b}';
const TAB_WIDTH: usize = 8;

fn is_sgr(sequence: &str) -> bool {
    sequence.starts_with("\u{1b}[") && sequence.ends_with('m')
}

/// Split off one complete escape sequence from the head of `text`, returning
/// (sequence, rest). Incomplete sequences are treated as complete at the end
/// of input so a truncated buffer cannot loop forever.
fn take_escape(text: &str) -> (&str, &str) {
    let bytes = text.as_bytes();
    debug_assert!(bytes.first() == Some(&0x1b));
    if bytes.len() < 2 {
        return (text, "");
    }
    match bytes[1] {
        b'[' => {
            // CSI: parameters 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
            for (index, byte) in bytes.iter().enumerate().skip(2) {
                if (0x40..=0x7e).contains(byte) {
                    return text.split_at(index + 1);
                }
            }
            (text, "")
        }
        b']' => {
            // OSC: terminated by BEL or ESC \.
            let mut previous = 0_u8;
            for (index, byte) in bytes.iter().enumerate().skip(2) {
                if *byte == 0x07 {
                    return text.split_at(index + 1);
                }
                if previous == 0x1b && *byte == b'\\' {
                    return text.split_at(index + 1);
                }
                previous = *byte;
            }
            (text, "")
        }
        _ => text.split_at(2.min(text.len())),
    }
}

/// Reduce raw PTY output to display lines: keep printable text and SGR
/// colors, expand tabs, honour \n and lone \r (line rewind), and drop every
/// other control or escape sequence.
pub fn sanitize_terminal_text(raw: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut rest = raw;
    while !rest.is_empty() {
        let character = rest.chars().next().unwrap();
        if character == ESC {
            let (sequence, remaining) = take_escape(rest);
            if is_sgr(sequence) {
                current.push_str(sequence);
            }
            rest = remaining;
            continue;
        }
        rest = &rest[character.len_utf8()..];
        match character {
            '\n' => {
                lines.push(std::mem::take(&mut current));
            }
            '\r' => {
                // A carriage return alone rewinds the line (progress bars);
                // \r\n is the ordinary PTY line break.
                if rest.starts_with('\n') {
                    rest = &rest[1..];
                    lines.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
            '\t' => {
                let width = visible_width(&current);
                let pad = TAB_WIDTH - (width % TAB_WIDTH);
                current.push_str(&" ".repeat(pad));
            }
            character if character.is_control() => {}
            character => current.push(character),
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// Character width of the text once escape sequences are removed. The TUI
/// deliberately treats every printable char as one cell; wide glyphs may
/// overflow a clipped cell but never break framing because rows end in a
/// clear-to-end-of-line.
pub fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut rest = text;
    while !rest.is_empty() {
        let character = rest.chars().next().unwrap();
        if character == ESC {
            let (_, remaining) = take_escape(rest);
            rest = remaining;
            continue;
        }
        rest = &rest[character.len_utf8()..];
        width += 1;
    }
    width
}

/// Clip to a visible width, preserving SGR sequences and always resetting
/// styles at the end so a clipped color run cannot bleed into the next cell.
pub fn clip_visible(text: &str, max_width: usize) -> String {
    let mut result = String::new();
    let mut width = 0;
    let mut rest = text;
    let mut saw_escape = false;
    while !rest.is_empty() {
        let character = rest.chars().next().unwrap();
        if character == ESC {
            let (sequence, remaining) = take_escape(rest);
            if is_sgr(sequence) {
                result.push_str(sequence);
                saw_escape = true;
            }
            rest = remaining;
            continue;
        }
        if width >= max_width {
            break;
        }
        rest = &rest[character.len_utf8()..];
        result.push(character);
        width += 1;
    }
    if saw_escape {
        result.push_str("\u{1b}[0m");
    }
    result
}

/// Pad or clip to exactly `width` visible cells.
pub fn fit_visible(text: &str, width: usize) -> String {
    let clipped = clip_visible(text, width);
    let padding = width.saturating_sub(visible_width(&clipped));
    format!("{clipped}{}", " ".repeat(padding))
}
