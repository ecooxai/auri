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

test("Alt+digit maps to a workspace switch and Ctrl+digit to a subtab switch", async () => {
  const { tabSwitchFromKeyboardEvent } = await import("../src/model/shortcut.js");
  assert.deepEqual(tabSwitchFromKeyboardEvent({ code: "Digit1", altKey: true }), { kind: "workspace", index: 0 });
  assert.deepEqual(tabSwitchFromKeyboardEvent({ code: "Digit9", altKey: true }), { kind: "workspace", index: 8 });
  assert.deepEqual(tabSwitchFromKeyboardEvent({ code: "Digit2", ctrlKey: true }), { kind: "subtab", index: 1 });
});

test("tab switching ignores other digits, modifiers, and combined chords", async () => {
  const { tabSwitchFromKeyboardEvent } = await import("../src/model/shortcut.js");
  assert.equal(tabSwitchFromKeyboardEvent({ code: "Digit0", altKey: true }), null);
  assert.equal(tabSwitchFromKeyboardEvent({ code: "Digit1" }), null);
  assert.equal(tabSwitchFromKeyboardEvent({ code: "Digit1", altKey: true, ctrlKey: true }), null);
  assert.equal(tabSwitchFromKeyboardEvent({ code: "Digit1", altKey: true, metaKey: true }), null);
  assert.equal(tabSwitchFromKeyboardEvent({ code: "Digit1", ctrlKey: true, shiftKey: true }), null);
  assert.equal(tabSwitchFromKeyboardEvent({ code: "KeyA", altKey: true }), null);
});
