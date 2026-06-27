const MODIFIER_CODES = new Set([
  "AltLeft", "AltRight", "ControlLeft", "ControlRight",
  "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"
]);

const KEY_ALIASES = Object.freeze({
  " ": "Space",
  Esc: "Escape",
  Spacebar: "Space"
});

function keyTokenFromEvent(event) {
  const code = String(event?.code || "");
  if (!code || code === "Unidentified" || MODIFIER_CODES.has(code)) return null;
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  const digit = code.match(/^Digit([0-9])$/);
  if (digit) return digit[1];
  return code;
}

function normalizeKeyToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const alias = KEY_ALIASES[raw] || raw;
  const upper = alias.toUpperCase();
  const letter = upper.match(/^KEY([A-Z])$/) || upper.match(/^([A-Z])$/);
  if (letter) return letter[1];
  const digit = upper.match(/^DIGIT([0-9])$/) || upper.match(/^([0-9])$/);
  if (digit) return digit[1];
  const canonical = {
    SPACE: "Space", ESCAPE: "Escape", ENTER: "Enter", TAB: "Tab", BACKSPACE: "Backspace", DELETE: "Delete",
    ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight",
    HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown", INSERT: "Insert",
    BACKQUOTE: "Backquote", BACKSLASH: "Backslash", BRACKETLEFT: "BracketLeft", BRACKETRIGHT: "BracketRight",
    COMMA: "Comma", EQUAL: "Equal", MINUS: "Minus", PERIOD: "Period", QUOTE: "Quote",
    SEMICOLON: "Semicolon", SLASH: "Slash"
  }[upper];
  if (canonical) return canonical;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper;
  if (/^NUMPAD[A-Z0-9]+$/.test(upper)) return alias;
  return alias;
}

function parseShortcut(value) {
  const tokens = String(value || "").split("+").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const key = normalizeKeyToken(tokens.pop());
  if (!key) return null;
  const parsed = { command: false, commandOrControl: false, control: false, alt: false, shift: false, key };
  for (const token of tokens) {
    switch (token.toLowerCase().replaceAll(" ", "")) {
      case "command":
      case "cmd":
      case "meta":
      case "super":
        parsed.command = true;
        break;
      case "commandorcontrol":
      case "commandorctrl":
      case "cmdorcontrol":
      case "cmdorctrl":
        parsed.commandOrControl = true;
        break;
      case "control":
      case "ctrl":
        parsed.control = true;
        break;
      case "option":
      case "alt":
        parsed.alt = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      default:
        return null;
    }
  }
  if (parsed.commandOrControl && (parsed.command || parsed.control)) return null;
  return parsed;
}

export function normalizeShortcut(value) {
  const parsed = parseShortcut(value);
  if (!parsed) return null;
  const modifiers = [];
  if (parsed.commandOrControl) modifiers.push("CommandOrControl");
  else {
    if (parsed.command) modifiers.push("Command");
    if (parsed.control) modifiers.push("Control");
  }
  if (parsed.alt) modifiers.push("Alt");
  if (parsed.shift) modifiers.push("Shift");
  return [...modifiers, parsed.key].join("+");
}

export function shortcutFromKeyboardEvent(event) {
  if (event?.isComposing) return null;
  const key = keyTokenFromEvent(event);
  if (!key) return null;
  const modifiers = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}

export function shortcutKeyMatchesKeyboardEvent(event, shortcut) {
  const parsed = parseShortcut(shortcut);
  return Boolean(parsed && keyTokenFromEvent(event) === parsed.key);
}

export function shortcutMatchesKeyboardEvent(event, shortcut) {
  const parsed = parseShortcut(shortcut);
  if (!parsed || keyTokenFromEvent(event) !== parsed.key) return false;
  if (Boolean(event.altKey) !== parsed.alt || Boolean(event.shiftKey) !== parsed.shift) return false;
  if (parsed.commandOrControl) {
    if (!event.metaKey && !event.ctrlKey) return false;
    return !(event.metaKey && event.ctrlKey);
  }
  return Boolean(event.metaKey) === parsed.command && Boolean(event.ctrlKey) === parsed.control;
}
