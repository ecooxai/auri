import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppView } from "../src/views/app-view.js";

function terminalHost(workspaceId) {
  return {
    dataset: { workspaceId },
    removed: false,
    remove() { this.removed = true; }
  };
}

test("AppView preserves the same terminal emulator host for each workspace", () => {
  const first = terminalHost("workspace-1");
  let current = first;
  let replacement = null;
  const placeholder = {
    replaceWith(value) { replacement = value; }
  };
  const root = {
    querySelector(selector) {
      if (selector === "#terminal-emulator") return current;
      return null;
    }
  };
  const view = new AppView(root);

  view.stashTerminalHost();
  assert.equal(first.removed, true);

  current = placeholder;
  const restored = view.restoreTerminalHost("workspace-1");
  assert.equal(restored, first);
  assert.equal(replacement, first);
});

test("AppView drops background terminal hosts so slept terminals leave the DOM", async () => {
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  const firstTerminalId = state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal").id;
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "terminal" } });
  const secondTerminalId = state.tabs[0].activeSubtabId;

  const view = new AppView({ querySelector: () => null });
  view.terminalHosts.set(firstTerminalId, terminalHost(firstTerminalId));
  view.terminalHosts.set(secondTerminalId, terminalHost(secondTerminalId));
  view.pruneTerminalHosts(state);

  assert.equal(view.terminalHosts.has(firstTerminalId), false);
  assert.equal(view.terminalHosts.has(secondTerminalId), true);

  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "system" } });
  view.pruneTerminalHosts(state);
  assert.equal(view.terminalHosts.size, 0);
});

test("TerminalSession.sleep disposes the emulator but keeps recorded output growing for replay", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const encoder = new TextEncoder();
  const session = new TerminalSession({ isNative: false }, {});
  session.remember({ type: "bytes", bytes: encoder.encode("hello ") });

  let disposed = 0;
  session.term = { dispose() { disposed += 1; } };
  session.fitAddon = {};
  session.mountedElement = {};

  assert.equal(session.sleep(), true);
  assert.equal(disposed, 1);
  assert.equal(session.term, null);
  assert.equal(session.fitAddon, null);
  assert.equal(session.mountedElement, null);

  session.appendRecord({ type: "bytes", bytes: encoder.encode("world") });
  assert.equal(session.bufferText(), "hello world");
  assert.equal(session.sleep(), false);
});

test("AppController sleeps every terminal session except the focused one on render", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /sleepBackgroundTerminals\(\)/);
  const method = source.match(/sleepBackgroundTerminals\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(method, /session\.sleep\?\.\(\)/);
  assert.match(method, /type === "terminal"/);
});

test("TerminalSession reuses an already-mounted emulator and applies the configured scrollback", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /this\.mountedElement === element/);
  assert.match(source, /this\.term\.options\.scrollback = lineLimit/);
  assert.match(source, /scrollback: lineLimit/);
  assert.match(source, /async mount\(element, cwd = "~", fontSize = 20, maxLines = 4000\)/);
});

test("assistant transcript markers render as normal terminal text without decorations", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");

  assert.match(source, /terminalAssistantSegments\(message\)/);
  assert.match(source, /appendAssistantStream\(segment\.text\)/);
  assert.doesNotMatch(source, /assistant-highlight/);
  assert.doesNotMatch(source, /renderAssistantHighlight/);
  assert.doesNotMatch(source, /appendAssistantHighlight/);
});

test("programmatic terminal runs do not steal focus from the composer", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  const runMethod = source.match(/async run\(command\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(runMethod, /this\.write\(`\$\{command\}\\r`\)/);
  assert.doesNotMatch(runMethod, /this\.focus\(\)/);
});

test("terminal selection copy delegates to the command-backed clipboard action", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const copied = [];
  const session = new TerminalSession({ isNative: false }, {
    copyText: async (text) => copied.push(text)
  });
  session.term = { getSelection: () => "selected terminal text" };

  assert.equal(await session.copySelection(), true);
  assert.deepEqual(copied, ["selected terminal text"]);
});


test("AppView render resolves the active terminal subtab without throwing", async () => {
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  const { AppView } = await import("../src/views/app-view.js");
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback();
  const root = {
    innerHTML: "",
    querySelector() { return null; },
    ownerDocument: { documentElement: { style: { setProperty() {} } } }
  };

  try {
    const view = new AppView(root);
    let state = createInitialState();
    const terminal = state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal");
    state = reduceState(state, { type: "SUBTAB_SELECT", payload: { id: terminal.id } });
    assert.doesNotThrow(() => view.render(state, { native: true }));
    assert.match(root.innerHTML, /id="terminal-emulator"/);
  } finally {
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});
