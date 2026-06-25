import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState } from "../src/model/state.js";

test("initial workspace focuses terminal and includes folder pane", () => {
  const state = createInitialState();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].activeSubtabId, state.tabs[0].subtabs[0].id);
  assert.equal(state.tabs[0].subtabs[0].type, "terminal");
  assert.equal(state.tabs[0].folder.visible, true);
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

test("folder and terminal working directories stay synchronized", () => {
  const state = reduceState(createInitialState(), {
    type: "WORKDIR_SET", payload: { path: "/tmp/project" }
  });
  assert.equal(state.tabs[0].folder.path, "/tmp/project");
  assert.equal(state.tabs[0].terminal.cwd, "/tmp/project");
});

test("errors and malformed render output are routed to Info", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "INFO_ADD", payload: { level: "error", message: "Network unavailable" } });
  assert.equal(state.info.items[0].message, "Network unavailable");
  assert.equal(state.info.unread, 1);
});

test("model settings can be updated without replacing other providers", () => {
  const state = reduceState(createInitialState(), {
    type: "MODEL_UPDATE",
    payload: { id: "openai-default", patch: { apiKey: "local-key" } }
  });
  assert.equal(state.models.find((item) => item.id === "openai-default").apiKey, "local-key");
  assert.equal(state.models.length, 2);
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
