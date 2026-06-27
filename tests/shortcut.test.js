import test from "node:test";
import assert from "node:assert/strict";
import {
  shortcutFromKeyboardEvent,
  shortcutMatchesKeyboardEvent,
  shortcutKeyMatchesKeyboardEvent
} from "../src/model/shortcut.js";

test("shortcut capture converts pressed modifiers and physical key into a native accelerator", () => {
  assert.equal(shortcutFromKeyboardEvent({ code: "KeyK", key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), "Command+Shift+K");
  assert.equal(shortcutFromKeyboardEvent({ code: "Space", key: " ", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }), "Alt+Space");
  assert.equal(shortcutFromKeyboardEvent({ code: "Digit7", key: "&", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }), "Control+Shift+7");
});

test("shortcut capture waits for a non-modifier key", () => {
  assert.equal(shortcutFromKeyboardEvent({ code: "AltLeft", key: "Alt", altKey: true }), null);
  assert.equal(shortcutFromKeyboardEvent({ code: "ShiftRight", key: "Shift", shiftKey: true }), null);
});

test("configured shortcut matching is exact and key release can ignore released modifiers", () => {
  const custom = { code: "KeyJ", key: "j", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false };
  assert.equal(shortcutMatchesKeyboardEvent(custom, "Control+Alt+J"), true);
  assert.equal(shortcutMatchesKeyboardEvent({ ...custom, code: "Space", key: " " }, "Control+Alt+J"), false);
  assert.equal(shortcutMatchesKeyboardEvent({ code: "Space", key: " ", altKey: true }, "Control+Alt+J"), false);
  assert.equal(shortcutKeyMatchesKeyboardEvent({ code: "KeyJ", key: "j" }, "Control+Alt+J"), true);
});
