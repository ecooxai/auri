import test from "node:test";
import assert from "node:assert/strict";
import { mirrorForwardsCommand } from "../src/model/commands.js";
import { createInitialState, reduceState } from "../src/model/state.js";
import { TerminalSession } from "../src/services/terminal-session.js";
import { terminalInputFromTransportCommand } from "../src/model/commands.js";
import { Backend } from "../src/services/backend.js";

const decoder = new TextDecoder();

function mirrorSnapshot() {
  return {
    v: 1,
    seq: 4,
    activeTabId: "gui-tab-2",
    activeSubtabId: "gui-sub-3",
    workspaces: [
      {
        id: "gui-tab-1",
        title: "Home",
        active: false,
        activeSubtabId: "gui-sub-1",
        folderPath: "/Users/demo",
        subtabs: [
          { id: "gui-sub-1", type: "terminal", title: "Terminal", active: true, cwd: "/Users/demo" },
          { id: "gui-sub-2", type: "system", title: "System", active: false }
        ],
        terminal: { cwd: "/Users/demo", running: false, draft: "", commandHistory: ["ls"] }
      },
      {
        id: "gui-tab-2",
        title: "Work",
        active: true,
        activeSubtabId: "gui-sub-3",
        folderPath: "/tmp",
        subtabs: [
          { id: "gui-sub-3", type: "terminal", title: "Terminal", active: true, cwd: "/tmp" },
          { id: "gui-sub-4", type: "webview", title: "Web", active: false, url: "https://example.com/" }
        ],
        terminal: { cwd: "/tmp", running: true, draft: "", commandHistory: [] }
      }
    ],
    terminals: {},
    settings: { theme: "aurora-light", fontSize: 20 }
  };
}

test("MIRROR_WORKSPACES_SYNC reshapes local tabs to the GUI snapshot", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot: mirrorSnapshot() } });

  assert.deepEqual(state.tabs.map((tab) => tab.id), ["gui-tab-1", "gui-tab-2"]);
  assert.equal(state.activeTabId, "gui-tab-2");
  assert.equal(state.tabs[1].activeSubtabId, "gui-sub-3");
  assert.equal(state.tabs[1].folder.path, "/tmp");
  assert.equal(state.tabs[1].terminal.cwd, "/tmp");
  assert.equal(state.tabs[1].terminal.running, true);
  assert.deepEqual(state.tabs[0].terminal.commandHistory, ["ls"]);
  const web = state.tabs[1].subtabs.find((subtab) => subtab.type === "webview");
  assert.equal(web.url, "https://example.com/");
  const terminal = state.tabs[0].subtabs.find((subtab) => subtab.id === "gui-sub-1");
  assert.equal(terminal.cwd, "/Users/demo");
});

test("mirror sync preserves surviving local panel state and drops removed workspaces", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot: mirrorSnapshot() } });
  state = reduceState(state, {
    type: "FOLDER_ENTRIES_SET",
    payload: { workspaceId: "gui-tab-2", entries: [{ name: "notes.md" }] }
  });

  const next = mirrorSnapshot();
  next.workspaces = [next.workspaces[1]];
  state = reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot: next } });

  assert.deepEqual(state.tabs.map((tab) => tab.id), ["gui-tab-2"]);
  assert.deepEqual(state.tabs[0].folder.entries, [{ name: "notes.md" }], "local folder entries survive a re-sync");

  assert.equal(reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: {} }), state, "a missing snapshot changes nothing");
  assert.equal(
    reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot: { workspaces: [] } } }),
    state,
    "an empty workspace list changes nothing"
  );
});

test("a stale active id in the snapshot falls back to the first workspace and subtab", () => {
  let state = createInitialState();
  const snapshot = mirrorSnapshot();
  snapshot.activeTabId = "gone";
  snapshot.workspaces[0].activeSubtabId = "gone-too";
  state = reduceState(state, { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot } });
  assert.equal(state.activeTabId, "gui-tab-1");
  assert.equal(state.tabs[0].activeSubtabId, "gui-sub-1");
});

test("hosted web sessions forward only commands that mutate mirrored app state", () => {
  const forwarded = [
    "tab new",
    "subtab select gui-sub-3",
    "auri terminal run ls -la",
    "web open https://example.com",
    "settings set theme dark",
    "info clear",
    "folder cd /tmp"
  ];
  for (const command of forwarded) {
    assert.equal(mirrorForwardsCommand(command), true, `${command} forwards to the GUI`);
  }
  const local = [
    "folder list",
    "folder toggle /tmp",
    "system sort cpu",
    "clipboard list",
    "ai ask hello there",
    "input insert x",
    "record audio",
    "help",
    "browser",
    "file open /tmp/a.txt",
    "not-a-command"
  ];
  for (const command of local) {
    assert.equal(mirrorForwardsCommand(command), false, `${command} stays local`);
  }
});

test("hosted composer forwards its complete terminal input in a line-safe command", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const forwarded = [];
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: false,
      isHostedWeb: true,
      forwardCommand: async (command) => forwarded.push(command)
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const input = "printf 'one'\nprintf 'snowman ☃'";

  await controller.runInternal("terminal run", { terminalCommand: input });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].includes("\n"), false);
  assert.equal(terminalInputFromTransportCommand(forwarded[0]), input);
});

test("an adopt-only terminal session joins the GUI PTY instead of starting its own", async () => {
  const calls = [];
  const backend = {
    isNative: true,
    startTerminal: async () => { calls.push(["start"]); },
    writeTerminal: async (sessionId, data) => { calls.push(["write", sessionId, decoder.decode(Uint8Array.from(data))]); },
    resizeTerminal: async (sessionId, cols, rows) => { calls.push(["resize", sessionId, cols, rows]); }
  };
  const session = new TerminalSession(backend, {});
  session.adoptOnly = true;

  await session.write("ls\n");
  assert.equal(session.started, false);
  assert.deepEqual(calls, [], "no PTY starts or writes before adoption");

  await session.adopt({ sessionId: "gui-session-1", text: "seeded tail\r\n", cols: 120, rows: 30 });
  assert.equal(session.started, true);
  assert.equal(session.sessionId, "gui-session-1");
  assert.ok(session.bufferText().includes("seeded tail"), "the snapshot text seeds the buffer");
  assert.deepEqual(calls, [["write", "gui-session-1", "ls\n"]], "queued input flushes to the adopted PTY");

  await session.write("pwd\n");
  assert.deepEqual(calls.at(-1), ["write", "gui-session-1", "pwd\n"]);

  await session.adopt({ sessionId: "gui-session-1", text: "ignored" });
  assert.equal(calls.filter(([kind]) => kind === "write").length, 2, "re-adopting the same session is a no-op");
  await session.adopt({ sessionId: "gui-session-2" });
  assert.equal(session.sessionId, "gui-session-2", "a restarted GUI session id swaps over");
  assert.ok(!calls.some(([kind]) => kind === "start"), "adopt-only sessions never start a PTY");
});

test("a popup-blocked web tab errors once and stays quiet on mirror re-renders", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  try {
    let attempts = 0;
    globalThis.window = { open: () => { attempts += 1; return null; } };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: null }) });

    const backend = new Backend();
    await backend.connectHostedWebBridge();

    await assert.rejects(() => backend.showWebview("web-1", "https://example.com", {}), /pop-up/i);
    const repeat = await backend.showWebview("web-1", "https://example.com", {});
    assert.equal(repeat.blocked, true, "the same blocked URL becomes a quiet no-op");
    assert.equal(attempts, 1, "no window.open retry per render");

    globalThis.window.open = () => ({ closed: false });
    const other = await backend.showWebview("web-1", "https://other.example", {});
    assert.equal(other.blocked, undefined, "a new URL clears the blocked marker");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("the hosted web bridge fetches app state and forwards commands to the GUI", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.window = {};
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/__auri__/ping") return { ok: true };
      if (url === "/__auri__/state") {
        return { ok: true, json: async () => ({ ok: true, result: { v: 1, seq: 7, workspaces: [] } }) };
      }
      if (url === "/__auri__/command") {
        return { ok: true, json: async () => ({ ok: true, result: null }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const backend = new Backend();
    await backend.connectHostedWebBridge();

    const snapshot = await backend.fetchAppState();
    assert.equal(snapshot.seq, 7);

    await backend.forwardCommand("tab new Research");
    const forwarded = calls.find((call) => call.url === "/__auri__/command");
    assert.equal(forwarded.options.method, "POST");
    assert.deepEqual(JSON.parse(forwarded.options.body), { command: "tab new Research" });

    const seen = [];
    await backend.listen("app-state", (payload) => seen.push(payload));
    backend.dispatchWebEvent("app-state", { seq: 8 });
    assert.deepEqual(seen, [{ seq: 8 }], "app-state events reach mirror listeners");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});
