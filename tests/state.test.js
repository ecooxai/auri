import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState, serializeWorkspaceSession } from "../src/model/state.js";

test("initial workspace focuses its first terminal and pre-opens system monitor", () => {
  const state = createInitialState();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].subtabs[0].type, "terminal");
  assert.equal(state.tabs[0].activeSubtabId, state.tabs[0].subtabs[0].id);
  assert.ok(state.tabs[0].subtabs.some((item) => item.type === "system"));
  assert.equal(state.tabs[0].folder.visible, true);
});

test("window visibility defaults to all desktop workspaces", () => {
  const state = createInitialState();
  assert.equal(state.settings.visibleOnAllWorkspaces, true);
});

test("new main tabs and subtabs become active", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "TAB_NEW", payload: { title: "Work" } });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, state.tabs[1].id);
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const tab = state.tabs[1];
  assert.equal(tab.subtabs.at(-1).type, "webview");
  assert.equal(tab.activeSubtabId, tab.subtabs.at(-1).id);
});

test("new terminal subtabs stay grouped immediately after the first terminal", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "terminal" } });
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "terminal" } });

  assert.deepEqual(state.tabs[0].subtabs.slice(0, 3).map((item) => item.type), ["terminal", "terminal", "terminal"]);
  assert.equal(state.tabs[0].subtabs[0].title, "Terminal");
  assert.equal(state.tabs[0].subtabs[1].title, "Terminal 2");
  assert.equal(state.tabs[0].subtabs[2].title, "Terminal 3");
});

test("folder-only navigation does not change any terminal working directory", () => {
  const state = reduceState(createInitialState(), {
    type: "FOLDER_PATH_SET", payload: { path: "/tmp/project" }
  });
  assert.equal(state.tabs[0].folder.path, "/tmp/project");
  assert.equal(state.tabs[0].terminal.cwd, "~");
  assert.equal(state.tabs[0].subtabs[0].cwd, "~");
});

test("folder and terminal working directories stay synchronized", () => {
  const state = reduceState(createInitialState(), {
    type: "WORKDIR_SET", payload: { path: "/tmp/project" }
  });
  assert.equal(state.tabs[0].folder.path, "/tmp/project");
  assert.equal(state.tabs[0].terminal.cwd, "/tmp/project");
});

test("same-directory synchronization preserves a pinned file preview but real navigation clears it", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "FOLDER_PATH_SET", payload: { path: "/tmp/project" } });
  state = reduceState(state, {
    type: "FILE_SELECT",
    payload: { path: "/tmp/project/song.mp3", metadata: { name: "song.mp3", kind: "audio" }, preview: { url: "preview" }, open: false }
  });
  state = reduceState(state, { type: "FILE_PREVIEW_PIN_SET", payload: { pinned: true } });

  state = reduceState(state, { type: "FOLDER_PATH_SET", payload: { path: "/tmp/project" } });
  assert.equal(state.tabs[0].viewer.mode, "inspect");
  assert.equal(state.tabs[0].viewer.pinned, true);

  state = reduceState(state, { type: "WORKDIR_SET", payload: { path: "/tmp/project" } });
  assert.equal(state.tabs[0].viewer.mode, "inspect");
  assert.equal(state.tabs[0].viewer.pinned, true);

  state = reduceState(state, { type: "FOLDER_PATH_SET", payload: { path: "/tmp/other" } });
  assert.equal(state.tabs[0].viewer.mode, "empty");
  assert.equal(state.tabs[0].viewer.pinned, false);
});

test("switching terminal subtabs restores each terminal cwd without overwriting the others", () => {
  let state = createInitialState();
  const first = state.tabs[0].subtabs.find((item) => item.type === "terminal");
  state = reduceState(state, { type: "SUBTAB_SELECT", payload: { id: first.id } });
  state = reduceState(state, { type: "TERMINAL_CWD_SET", payload: { terminalId: first.id, path: "/tmp/first" } });
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "terminal", cwd: "/tmp/second" } });
  const second = state.tabs[0].subtabs.find((item) => item.type === "terminal" && item.id !== first.id);

  state = reduceState(state, { type: "TERMINAL_CWD_SET", payload: { terminalId: first.id, path: "/tmp/first-latest" } });
  assert.equal(state.tabs[0].terminal.cwd, "/tmp/second");

  state = reduceState(state, { type: "SUBTAB_SELECT", payload: { id: first.id } });
  assert.equal(state.tabs[0].terminal.cwd, "/tmp/first-latest");
  assert.equal(state.tabs[0].subtabs.find((item) => item.id === second.id).cwd, "/tmp/second");
});

test("errors and malformed render output are routed to Info", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "INFO_ADD", payload: { level: "error", message: "Network unavailable" } });
  assert.equal(state.info.items[0].message, "Network unavailable");
  assert.equal(state.info.unread, 1);
});

test("terminal output history stays bounded in long sessions", () => {
  let state = createInitialState();
  for (let index = 0; index < 260; index += 1) {
    state = reduceState(state, { type: "TERMINAL_OUTPUT_ADD", payload: { stdout: `line ${index}` } });
  }
  const history = state.tabs[0].terminal.history;
  assert.equal(history.length, 200);
  assert.equal(history[history.length - 1].stdout, "line 259");
  assert.equal(history[0].stdout, "line 60");
});

test("info notifications stay bounded while keeping the newest first", () => {
  let state = createInitialState();
  for (let index = 0; index < 260; index += 1) {
    state = reduceState(state, { type: "INFO_ADD", payload: { level: "info", message: `event ${index}` } });
  }
  assert.equal(state.info.items.length, 200);
  assert.equal(state.info.items[0].message, "event 259");
  assert.equal(state.info.unread, 260);
});

test("model settings can be updated without replacing other providers", () => {
  const state = reduceState(createInitialState(), {
    type: "MODEL_UPDATE",
    payload: { id: "gemini-live-default", patch: { apiKey: "local-key" } }
  });
  assert.equal(state.models.find((item) => item.id === "gemini-live-default").apiKey, "local-key");
  assert.equal(state.models.length, 1);
});

test("terminal clear removes history without changing its working directory", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "TERMINAL_OUTPUT_ADD", payload: { stdout: "x" } });
  state = reduceState(state, { type: "TERMINAL_CLEAR", payload: {} });
  assert.equal(state.tabs[0].terminal.history.length, 0);
  assert.equal(state.tabs[0].terminal.cwd, "~");
});

test("terminal directory updates can target an inactive workspace", () => {
  let state = createInitialState();
  const firstId = state.activeTabId;
  state = reduceState(state, { type: "TAB_NEW", payload: { title: "Second" } });
  const secondId = state.activeTabId;

  state = reduceState(state, { type: "WORKDIR_SET", payload: { workspaceId: firstId, path: "/tmp/first" } });
  state = reduceState(state, { type: "FOLDER_ENTRIES_SET", payload: { workspaceId: firstId, entries: [{ name: "one" }] } });

  assert.equal(state.activeTabId, secondId);
  assert.equal(state.tabs.find((tab) => tab.id === firstId).terminal.cwd, "/tmp/first");
  assert.equal(state.tabs.find((tab) => tab.id === firstId).folder.entries[0].name, "one");
  assert.equal(state.tabs.find((tab) => tab.id === secondId).terminal.cwd, "~");
});

test("new web subtabs open Google by default", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const web = state.tabs[0].subtabs.at(-1);
  assert.equal(web.url, "https://www.google.com/");
});


test("interface font size has a larger readable default", () => {
  const state = createInitialState();
  assert.equal(state.settings.fontSize, 20);
});

test("folder sort defaults to name and can be changed per workspace", () => {
  let state = createInitialState();
  assert.equal(state.tabs[0].folder.sortBy, "name");
  state = reduceState(state, { type: "FOLDER_SORT_SET", payload: { sortBy: "type" } });
  assert.equal(state.tabs[0].folder.sortBy, "type");
});

test("folder creation UI opens and closes without changing folder contents", () => {
  let state = createInitialState();
  assert.equal(state.ui.folderCreateKind, null);
  state = reduceState(state, { type: "UI_SET", payload: { folderCreateKind: "file" } });
  assert.equal(state.ui.folderCreateKind, "file");
  state = reduceState(state, { type: "UI_SET", payload: { folderCreateKind: null } });
  assert.equal(state.ui.folderCreateKind, null);
});

test("initial workspace opens Terminal, System, Clipboard, and Info with Terminal active", () => {
  const state = createInitialState();
  const workspace = state.tabs[0];
  assert.deepEqual(workspace.subtabs.map((item) => item.type), ["terminal", "system", "clipboard", "info"]);
  assert.equal(workspace.activeSubtabId, workspace.subtabs[0].id);
});

test("terminal line retention defaults to 4000 and rejects unsafe values", () => {
  let state = createInitialState();
  assert.equal(state.settings.terminalMaxLines, 4000);

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalMaxLines", value: 1250 } });
  assert.equal(state.settings.terminalMaxLines, 1250);

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalMaxLines", value: -10 } });
  assert.equal(state.settings.terminalMaxLines, 100);

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalMaxLines", value: "not-a-number" } });
  assert.equal(state.settings.terminalMaxLines, 4000);
});

test("terminal shell presets keep the direct executable field synchronized", () => {
  let state = createInitialState();
  assert.equal(state.settings.terminalShellPreset, "default");
  assert.equal(state.settings.terminalShellCommand, "");

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalShellPreset", value: "bash" } });
  assert.equal(state.settings.terminalShellPreset, "bash");
  assert.equal(state.settings.terminalShellCommand, "/bin/bash");

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalShellCommand", value: "/bin/zsh" } });
  assert.equal(state.settings.terminalShellPreset, "zsh");
  assert.equal(state.settings.terminalShellCommand, "/bin/zsh");

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalShellCommand", value: "/usr/local/bin/fish" } });
  assert.equal(state.settings.terminalShellPreset, "custom");
  assert.equal(state.settings.terminalShellCommand, "/usr/local/bin/fish");

  state = reduceState(state, { type: "SETTING_SET", payload: { key: "terminalShellPreset", value: "default" } });
  assert.equal(state.settings.terminalShellPreset, "default");
  assert.equal(state.settings.terminalShellCommand, "");
});

test("folder pane width has a usable persisted range", () => {
  let state = createInitialState();
  assert.equal(state.settings.folderPaneWidth, 230);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "folderPaneWidth", value: 340 } });
  assert.equal(state.settings.folderPaneWidth, 340);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "folderPaneWidth", value: 80 } });
  assert.equal(state.settings.folderPaneWidth, 160);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "folderPaneWidth", value: 900 } });
  assert.equal(state.settings.folderPaneWidth, 420);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "folderPaneWidth", value: "bad" } });
  assert.equal(state.settings.folderPaneWidth, 230);
});


test("workspace sessions preserve all open folder paths and the active workspace", () => {
  let state = createInitialState();
  const firstId = state.activeTabId;
  state = reduceState(state, { type: "WORKDIR_SET", payload: { path: "/Users/auri/Desktop" } });
  state = reduceState(state, { type: "TAB_NEW", payload: { title: "Client" } });
  state = reduceState(state, { type: "WORKDIR_SET", payload: { path: "/Users/auri/Projects/client-app" } });
  state = reduceState(state, { type: "TAB_SELECT", payload: { id: firstId } });

  const saved = serializeWorkspaceSession(state);
  assert.deepEqual(saved, {
    activeIndex: 0,
    items: [
      { title: "Home", path: "/Users/auri/Desktop" },
      { title: "Client", path: "/Users/auri/Projects/client-app" }
    ]
  });

  const restored = reduceState(createInitialState(), { type: "WORKSPACES_RESTORE", payload: saved });
  assert.deepEqual(restored.tabs.map((tab) => tab.folder.path), [
    "/Users/auri/Desktop",
    "/Users/auri/Projects/client-app"
  ]);
  assert.deepEqual(restored.tabs.map((tab) => tab.terminal.cwd), [
    "/Users/auri/Desktop",
    "/Users/auri/Projects/client-app"
  ]);
  assert.equal(restored.activeTabId, restored.tabs[0].id);
});


test("restored workspace sessions always focus the first space and its first terminal", () => {
  const restored = reduceState(createInitialState(), {
    type: "WORKSPACES_RESTORE",
    payload: {
      activeIndex: 1,
      items: [
        { title: "Home", path: "/Users/auri/Desktop" },
        { title: "Client", path: "/Users/auri/Projects/client-app" }
      ]
    }
  });
  const first = restored.tabs[0];
  const firstTerminal = first.subtabs.find((item) => item.type === "terminal");
  assert.equal(restored.activeTabId, first.id);
  assert.equal(first.activeSubtabId, firstTerminal.id);
  assert.equal(firstTerminal.cwd, "/Users/auri/Desktop");
  assert.equal(first.folder.path, firstTerminal.cwd);
  assert.ok(first.subtabs.some((item) => item.type === "system"));
});


test("Live disconnect seconds preserve user values and clamp unsafe input", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "liveDisconnectSeconds", value: 3 } });
  assert.equal(state.settings.liveDisconnectSeconds, 3);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "liveDisconnectSeconds", value: 0 } });
  assert.equal(state.settings.liveDisconnectSeconds, 1);
  state = reduceState(state, { type: "SETTING_SET", payload: { key: "liveDisconnectSeconds", value: 5000 } });
  assert.equal(state.settings.liveDisconnectSeconds, 3600);
});
