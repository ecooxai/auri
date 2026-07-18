import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeKeyEvent,
  encodePasteText,
  runSpanSpec,
  rowText,
  xterm256Color
} from "../src/services/terminal-screen.js";

const key = (overrides) => ({ key: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...overrides });

test("printable keys encode as themselves with alt as ESC prefix", () => {
  assert.equal(encodeKeyEvent(key({ key: "a" })), "a");
  assert.equal(encodeKeyEvent(key({ key: "Z", shiftKey: true })), "Z");
  assert.equal(encodeKeyEvent(key({ key: "é" })), "é");
  assert.equal(encodeKeyEvent(key({ key: " " })), " ");
  assert.equal(encodeKeyEvent(key({ key: "b", altKey: true })), "\x1bb");
  assert.equal(encodeKeyEvent(key({ key: "c", metaKey: true })), null, "Cmd shortcuts stay with the app");
});

test("control combinations map to C0 bytes", () => {
  assert.equal(encodeKeyEvent(key({ key: "c", ctrlKey: true })), "\x03");
  assert.equal(encodeKeyEvent(key({ key: "C", ctrlKey: true, shiftKey: true })), "\x03");
  assert.equal(encodeKeyEvent(key({ key: " ", ctrlKey: true })), "\0");
  assert.equal(encodeKeyEvent(key({ key: "[", ctrlKey: true })), "\x1b");
  assert.equal(encodeKeyEvent(key({ key: "d", ctrlKey: true })), "\x04");
});

test("editing and navigation keys use xterm sequences", () => {
  assert.equal(encodeKeyEvent(key({ key: "Enter" })), "\r");
  assert.equal(encodeKeyEvent(key({ key: "Backspace" })), "\x7f");
  assert.equal(encodeKeyEvent(key({ key: "Backspace", altKey: true })), "\x1b\x7f");
  assert.equal(encodeKeyEvent(key({ key: "Tab" })), "\t");
  assert.equal(encodeKeyEvent(key({ key: "Tab", shiftKey: true })), "\x1b[Z");
  assert.equal(encodeKeyEvent(key({ key: "Escape" })), "\x1b");
  assert.equal(encodeKeyEvent(key({ key: "Delete" })), "\x1b[3~");
  assert.equal(encodeKeyEvent(key({ key: "PageUp" })), "\x1b[5~");
  assert.equal(encodeKeyEvent(key({ key: "Home" })), "\x1b[H");
  assert.equal(encodeKeyEvent(key({ key: "F1" })), "\x1bOP");
  assert.equal(encodeKeyEvent(key({ key: "F5" })), "\x1b[15~");
  assert.equal(encodeKeyEvent(key({ key: "Shift" })), null, "bare modifiers send nothing");
});

test("arrow keys honor application cursor mode and modifiers", () => {
  assert.equal(encodeKeyEvent(key({ key: "ArrowUp" })), "\x1b[A");
  assert.equal(encodeKeyEvent(key({ key: "ArrowLeft" })), "\x1b[D");
  assert.equal(encodeKeyEvent(key({ key: "ArrowUp" }), { applicationCursorKeys: true }), "\x1bOA");
  assert.equal(encodeKeyEvent(key({ key: "ArrowRight", ctrlKey: true })), "\x1b[1;5C");
  assert.equal(encodeKeyEvent(key({ key: "ArrowDown", shiftKey: true })), "\x1b[1;2B");
});

test("paste text normalizes newlines and honors bracketed paste", () => {
  assert.equal(encodePasteText("echo hi\nls\r\npwd"), "echo hi\rls\rpwd");
  assert.equal(encodePasteText("hello", true), "\x1b[200~hello\x1b[201~");
});

test("frame runs map to theme classes, palette colors, and inverse swaps", () => {
  const plain = runSpanSpec({ text: "hello", fg: null, bg: null, flags: 0 });
  assert.equal(plain.text, "hello");
  assert.equal(plain.className, "");
  assert.equal(plain.color, null);
  assert.equal(plain.background, null);

  const styled = runSpanSpec({ text: "err", fg: 1, bg: null, flags: 1 });
  assert.ok(styled.className.includes("term-b"), "bold class present");
  assert.ok(styled.className.includes("term-fg-1"), "indexed color becomes a theme class");

  const cube = runSpanSpec({ text: "x", fg: 196, bg: 238, flags: 0 });
  assert.equal(cube.color, xterm256Color(196));
  assert.equal(cube.background, xterm256Color(238));

  const rgb = runSpanSpec({ text: "x", fg: "#12ab34", bg: null, flags: 0 });
  assert.equal(rgb.color, "#12ab34");

  const inverse = runSpanSpec({ text: "sel", fg: 2, bg: 15, flags: 16 });
  assert.ok(inverse.className.includes("term-fg-15"), "inverse swaps fg and bg");
  assert.ok(inverse.className.includes("term-bg-2"));

  const inverseDefault = runSpanSpec({ text: "cur", fg: null, bg: null, flags: 16 });
  assert.ok(inverseDefault.className.includes("term-fg-def"), "default colors swap to theme vars");
  assert.ok(inverseDefault.className.includes("term-bg-def"));
});

test("the 256-color palette matches the xterm cube and grayscale ramp", () => {
  assert.equal(xterm256Color(16), "#000000");
  assert.equal(xterm256Color(196), "#ff0000");
  assert.equal(xterm256Color(231), "#ffffff");
  assert.equal(xterm256Color(232), "#080808");
  assert.equal(xterm256Color(255), "#eeeeee");
});

test("row text joins run text for link hit-testing", () => {
  assert.equal(rowText([{ text: "cat " }, { text: "src/main.js" }]), "cat src/main.js");
  assert.equal(rowText([]), "");
  assert.equal(rowText(null), "");
});
