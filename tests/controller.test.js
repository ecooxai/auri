import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "../src/controllers/command-controller.js";
import { createInitialState, reduceState } from "../src/model/state.js";

function harness() {
  let state = createInitialState();
  return {
    backend: {},
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); },
    state: () => state
  };
}

test("GUI command creates a tab through the same command layer", async () => {
  const h = harness();
  await executeCommand("tab new Research", h);
  assert.equal(h.state().tabs.length, 2);
  assert.equal(h.state().tabs[1].title, "Research");
});

test("web open updates the active web subtab through command dispatch", async () => {
  const h = harness();
  await executeCommand("subtab new webview", h);
  await executeCommand("web open https://example.org", h);
  const tab = h.state().tabs[0];
  assert.equal(tab.subtabs.find((item) => item.id === tab.activeSubtabId).url, "https://example.org");
});

test("record start delegates hardware work through the command context", async () => {
  const h = harness();
  let received = null;
  h.actions = { startRecording: async (kind) => { received = kind; } };
  await executeCommand("record start audio", h);
  assert.equal(received, "audio");
});

test("attachment remove is a state command", async () => {
  const h = harness();
  h.dispatch({ type: "ATTACHMENT_ADD", payload: { id: "a-1", name: "x.png", kind: "image" } });
  await executeCommand("attachment remove a-1", h);
  assert.equal(h.state().media.attachments.length, 0);
});

test("clipboard copy delegates to the platform action", async () => {
  const h = harness();
  let copied = "";
  h.actions = { copyText: async (text) => { copied = text; } };
  await executeCommand('clipboard copy "hello world"', h);
  assert.equal(copied, "hello world");
});

test("CLI events use the main command controller", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = { root: {}, render() {}, showToast() {} };
  const backend = { isNative: true };
  const controller = new AppController({ view, backend });
  await controller.handleExternalCommand("tab new External");
  assert.equal(controller.state.tabs.length, 2);
  assert.equal(controller.state.tabs[1].title, "External");
});


test("file open routes the selected file into a webview subtab", async () => {
  const h = harness();
  h.backend.inspectFile = async (path) => ({ path, name: "test.m4a", kind: "audio" });
  h.actions = {
    openFileInWebview: async (path, metadata) => ({ url: "blob:auri-audio", title: metadata.name, filePath: path })
  };

  await executeCommand('file open "/tmp/test.m4a"', h);

  const tab = h.state().tabs[0];
  const active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "webview");
  assert.equal(active.url, "blob:auri-audio");
  assert.equal(active.filePath, "/tmp/test.m4a");
  assert.equal(active.title, "test.m4a");
});

test("AI requests add the user message before the assistant reply", async () => {
  const h = harness();
  h.backend.askAi = async () => ({ text: "hello back" });
  h.dispatch({ type: "MODEL_UPDATE", payload: { id: "model-openai", patch: { apiKey: "test" } } });

  await executeCommand("ai ask hello there", h);

  const history = h.state().tabs[0].terminal.history;
  assert.equal(history.at(-2).kind, "user");
  assert.equal(history.at(-2).stdout, "hello there");
  assert.equal(history.at(-1).kind, "assistant");
  assert.equal(history.at(-1).stdout, "hello back");
});


test("each workspace owns a distinct terminal session", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const created = [];
  const terminalSessionFactory = () => {
    const session = {
      initialize: async () => {},
      mount: async () => {},
      run: async () => {},
      stop: async () => {},
      printUser() {},
      printAssistant() {},
      printMessage() {},
      beginAssistantStream() {},
      appendAssistantStream() {},
      endAssistantStream() {}
    };
    created.push(session);
    return session;
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory });
  const firstId = controller.state.activeTabId;
  const firstSession = controller.terminalSessionFor(firstId);

  controller.dispatch({ type: "TAB_NEW", payload: { title: "Second" } });
  const secondId = controller.state.activeTabId;
  const secondSession = controller.terminalSessionFor(secondId);

  assert.notEqual(firstSession, secondSession);
  assert.equal(controller.terminalSessionFor(firstId), firstSession);
  assert.equal(controller.terminalSessionFor(secondId), secondSession);
  assert.equal(created.length, 2);
});
