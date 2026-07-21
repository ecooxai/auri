// Pure helpers for the HTML terminal renderer. The backend hosts the real VT
// emulator (src-tauri/src/core/vt.rs); the frontend only encodes keyboard
// input for the PTY and turns styled frame runs into DOM span specs. No DOM
// or platform globals here so the node test harness can prove the mapping.

const ESC = "\u{1b}";

const ARROW_LETTERS = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D" };
const HOME_END_LETTERS = { Home: "H", End: "F" };
const TILDE_KEYS = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };
const FUNCTION_TILDE = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const FUNCTION_SS3 = { F1: "P", F2: "Q", F3: "R", F4: "S" };

function modifierParam(event) {
  return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
}

function csiWithModifier(letter, event, { applicationCursorKeys = false } = {}) {
  const modifier = modifierParam(event);
  if (modifier > 1) return `${ESC}[1;${modifier}${letter}`;
  return applicationCursorKeys ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

function tildeSequence(code, event) {
  const modifier = modifierParam(event);
  return modifier > 1 ? `${ESC}[${code};${modifier}~` : `${ESC}[${code}~`;
}

function controlByte(rawKey) {
  const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
  if (key >= "a" && key <= "z") return String.fromCharCode(key.charCodeAt(0) - 96);
  const specials = { " ": "\u{0}", "@": "\u{0}", "[": ESC, "\\": "\u{1c}", "]": "\u{1d}", "^": "\u{1e}", "_": "\u{1f}", "?": "\u{7f}" };
  return specials[key] ?? null;
}

export function isTerminalPasteShortcut(event) {
  if (!event) return false;
  const key = String(event.key || "");
  const lowerKey = key.toLowerCase();
  return Boolean(
    (event.ctrlKey && event.shiftKey && lowerKey === "v")
    || (event.metaKey && lowerKey === "v")
    || (event.shiftKey && key === "Insert")
  );
}

/// Byte sequence a key press sends to the PTY, or null when the key is not
/// terminal input (app shortcuts, bare modifiers, browser-handled keys).
export function encodeKeyEvent(event, modes = {}) {
  if (!event) return null;
  const key = String(event.key || "");
  // Desktop terminal paste shortcuts must reach the browser's paste event so
  // TerminalSession can forward the clipboard payload. Plain Ctrl+V is not a
  // paste shortcut here: terminals use it as the literal-next C0 byte.
  if (isTerminalPasteShortcut(event)) return null;
  if (event.metaKey) return null;

  const arrow = ARROW_LETTERS[key];
  if (arrow) return csiWithModifier(arrow, event, modes);
  const homeEnd = HOME_END_LETTERS[key];
  if (homeEnd) return csiWithModifier(homeEnd, event, modes);
  if (key in TILDE_KEYS) return tildeSequence(TILDE_KEYS[key], event);
  if (key in FUNCTION_TILDE) return tildeSequence(FUNCTION_TILDE[key], event);
  if (key in FUNCTION_SS3) {
    const modifier = modifierParam(event);
    return modifier > 1 ? `${ESC}[1;${modifier}${FUNCTION_SS3[key]}` : `${ESC}O${FUNCTION_SS3[key]}`;
  }

  switch (key) {
    case "Enter":
      return event.altKey ? `${ESC}\r` : "\r";
    case "Backspace": {
      const byte = event.ctrlKey ? "\u{8}" : "\u{7f}";
      return event.altKey ? ESC + byte : byte;
    }
    case "Tab":
      return event.shiftKey ? `${ESC}[Z` : "\t";
    case "Escape":
      return ESC;
    default:
      break;
  }

  if (event.ctrlKey) {
    const byte = key.length === 1 ? controlByte(key) : null;
    return byte === null ? null : (event.altKey ? ESC + byte : byte);
  }
  if (key.length === 1) return event.altKey ? ESC + key : key;
  return null;
}

/// Pasted text as PTY input: newlines become carriage returns, and the whole
/// paste is wrapped when the application enabled bracketed paste.
export function encodePasteText(text, bracketedPaste = false) {
  const normalized = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\n", "\r");
  if (!normalized) return "";
  return bracketedPaste ? `${ESC}[200~${normalized}${ESC}[201~` : normalized;
}

function mouseModifierBits(event) {
  return (event?.shiftKey ? 4 : 0)
    + (event?.altKey || event?.metaKey ? 8 : 0)
    + (event?.ctrlKey ? 16 : 0);
}

/// Byte sequence a wheel event sends to a terminal-controlled TUI. Ordinary
/// shell history returns null so the browser keeps its native scroll. Mouse-
/// aware apps receive xterm wheel reports; alternate-screen apps that did not
/// request mouse capture receive cursor keys, matching xterm alternate scroll.
export function encodeWheelEvent(event, modes = {}, position = {}) {
  const deltaY = Number(event?.deltaY) || 0;
  if (!deltaY) return null;
  const up = deltaY < 0;

  if (modes.mouseTracking) {
    const button = (up ? 64 : 65) + mouseModifierBits(event);
    const column = Math.max(0, Math.floor(Number(position.column) || 0));
    const row = Math.max(0, Math.floor(Number(position.row) || 0));
    if (modes.mouseSgr) return `${ESC}[<${button};${column + 1};${row + 1}M`;

    // Original X10 encoding stores button and 1-based coordinates as bytes
    // offset by 32. Coordinates above 223 cannot be represented.
    const x = Math.min(223, column + 1);
    const y = Math.min(223, row + 1);
    return `${ESC}[M${String.fromCharCode(button + 32, x + 32, y + 32)}`;
  }

  if (!modes.alternateScreen) return null;
  const letter = up ? "A" : "B";
  return modes.applicationCursorKeys ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

export const RUN_BOLD = 1;
export const RUN_DIM = 2;
export const RUN_ITALIC = 4;
export const RUN_UNDERLINE = 8;
export const RUN_INVERSE = 16;

/// Hex color for xterm-256 palette entries 16..255 (0..15 use theme classes).
export function xterm256Color(index) {
  const value = Number(index) || 0;
  if (value >= 232) {
    const gray = 8 + (value - 232) * 10;
    const hex = gray.toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }
  const cube = [0, 95, 135, 175, 215, 255];
  const base = Math.max(0, value - 16);
  const parts = [cube[Math.floor(base / 36) % 6], cube[Math.floor(base / 6) % 6], cube[base % 6]];
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function colorToken(color) {
  if (color === null || color === undefined) return { className: null, value: null, indexed: null };
  if (typeof color === "number") {
    if (color < 16) return { className: String(color), value: null, indexed: color };
    return { className: null, value: xterm256Color(color), indexed: null };
  }
  return { className: null, value: String(color), indexed: null };
}

/// A frame run — `{ text, fg, bg, flags }` from the backend emulator — as a
/// span spec: theme classes for the 16 ANSI colors and attributes, inline CSS
/// colors for 256/RGB values. Inverse swaps foreground and background, using
/// the `def` theme tokens when either side is the default color.
export function runSpanSpec(run) {
  const flags = Number(run?.flags) || 0;
  const inverse = Boolean(flags & RUN_INVERSE);
  let fg = colorToken(run?.fg ?? null);
  let bg = colorToken(run?.bg ?? null);
  if (inverse) {
    [fg, bg] = [bg, fg];
    if (fg.className === null && fg.value === null) fg = { className: "def", value: null, indexed: null };
    if (bg.className === null && bg.value === null) bg = { className: "def", value: null, indexed: null };
  }
  const classes = [];
  if (flags & RUN_BOLD) classes.push("term-b");
  if (flags & RUN_DIM) classes.push("term-d");
  if (flags & RUN_ITALIC) classes.push("term-i");
  if (flags & RUN_UNDERLINE) classes.push("term-u");
  if (fg.className !== null) classes.push(`term-fg-${fg.className}`);
  if (bg.className !== null) classes.push(`term-bg-${bg.className}`);
  return {
    text: String(run?.text ?? ""),
    className: classes.join(" "),
    color: fg.value,
    background: bg.value
  };
}

/// Plain text of a frame row, used for link hit-testing and copying.
export function rowText(runs) {
  if (!Array.isArray(runs)) return "";
  let text = "";
  for (const run of runs) text += String(run?.text ?? "");
  return text;
}
