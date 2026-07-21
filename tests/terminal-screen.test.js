import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeKeyEvent,
  encodePasteText,
  encodeWheelEvent,
  isTerminalPasteShortcut,
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
  assert.equal(encodeKeyEvent(key({ key: "v", ctrlKey: true })), "\x16", "Ctrl+V remains literal-next PTY input");
  assert.equal(encodeKeyEvent(key({ key: "V", ctrlKey: true, shiftKey: true })), null, "Ctrl+Shift+V is left to the clipboard paste event");
  assert.equal(encodeKeyEvent(key({ key: " ", ctrlKey: true })), "\0");
  assert.equal(encodeKeyEvent(key({ key: "[", ctrlKey: true })), "\x1b");
  assert.equal(encodeKeyEvent(key({ key: "d", ctrlKey: true })), "\x04");
});

test("terminal paste shortcuts are distinct from literal Ctrl+V input", () => {
  assert.equal(isTerminalPasteShortcut(key({ key: "V", ctrlKey: true, shiftKey: true })), true);
  assert.equal(isTerminalPasteShortcut(key({ key: "Insert", shiftKey: true })), true);
  assert.equal(isTerminalPasteShortcut(key({ key: "v", metaKey: true })), true);
  assert.equal(isTerminalPasteShortcut(key({ key: "v", ctrlKey: true })), false);
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

test("TerminalSession sends clipboard paste and multiline runs through the live PTY", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const writes = [];
  const session = new TerminalSession({
    isNative: true,
    writeTerminal: async (_sessionId, bytes) => writes.push(new TextDecoder().decode(bytes)),
    getTerminalCwd: async () => "~"
  });
  session.started = true;
  session.modes.bracketedPaste = true;

  await session.paste("echo one\necho two");
  await session.run("printf one\nprintf two");

  assert.deepEqual(writes, [
    "\x1b[200~echo one\recho two\x1b[201~",
    "\x1b[200~printf one\rprintf two\x1b[201~\r"
  ]);
});

test("TerminalSession explicitly reads the native clipboard for a paste shortcut", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const writes = [];
  let prevented = 0;
  const session = new TerminalSession({
    isNative: true,
    writeTerminal: async (_sessionId, bytes) => writes.push(new TextDecoder().decode(bytes))
  }, {
    readClipboardText: async () => "printf pasted"
  });
  session.started = true;

  const result = await session.handlePasteShortcut({
    key: "V",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault() { prevented += 1; }
  });

  assert.equal(result, true);
  assert.equal(prevented, 1);
  assert.deepEqual(writes, ["printf pasted"]);
});

test("wheel input uses SGR mouse reports only when the terminal app requested them", () => {
  const wheel = (overrides = {}) => ({
    deltaY: -80,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides
  });

  assert.equal(
    encodeWheelEvent(wheel(), { mouseTracking: true, mouseSgr: true }, { column: 4, row: 2 }),
    "\x1b[<64;5;3M"
  );
  assert.equal(
    encodeWheelEvent(
      wheel({ deltaY: 80, shiftKey: true, ctrlKey: true }),
      { mouseTracking: true, mouseSgr: true },
      { column: 0, row: 0 }
    ),
    "\x1b[<85;1;1M",
    "wheel-down and keyboard modifiers use xterm mouse button bits"
  );
  assert.equal(
    encodeWheelEvent(wheel(), { alternateScreen: true, applicationCursorKeys: true }, { column: 0, row: 0 }),
    "\x1bOA",
    "alternate-screen apps without mouse capture receive cursor input like xterm alternate scroll"
  );
  assert.equal(
    encodeWheelEvent(wheel({ deltaY: 80 }), { alternateScreen: true }, { column: 0, row: 0 }),
    "\x1b[B"
  );
  assert.equal(
    encodeWheelEvent(wheel(), {}, { column: 0, row: 0 }),
    null,
    "ordinary shell history remains browser-scrollable"
  );
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
