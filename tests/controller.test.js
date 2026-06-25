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


test("AI requests snapshot sent media into terminal history and clear the composer", async () => {
  const h = harness();
  const attachment = {
    id: "attachment-photo",
    name: "photo.png",
    kind: "image",
    mime: "image/png",
    url: "blob:photo-preview",
    file: { type: "image/png" }
  };
  h.dispatch({ type: "ATTACHMENT_ADD", payload: attachment });
  let shownUser = null;
  h.actions = {
    showUserMessage: (text, attachments) => { shownUser = { text, attachments }; }
  };
  h.backend.askAi = async ({ attachments }) => {
    assert.equal(attachments[0], attachment);
    return { text: "I can see it." };
  };

  await executeCommand("ai ask what is this?", h);

  const history = h.state().tabs[0].terminal.history;
  assert.deepEqual(history.at(-2).attachments, [{
    id: "attachment-photo",
    name: "photo.png",
    kind: "image",
    mime: "image/png",
    url: "blob:photo-preview",
    path: null
  }]);
  assert.deepEqual(shownUser, {
    text: "what is this?",
    attachments: history.at(-2).attachments
  });
  assert.equal(h.state().media.attachments.length, 0);
});


test("AI audio replies are forwarded to the inline terminal renderer", async () => {
  const h = harness();
  let shownAssistant = null;
  h.actions = {
    showAssistantMessage: (name, text, audio) => { shownAssistant = { name, text, audio }; }
  };
  h.backend.askAi = async () => ({
    text: "Spoken reply",
    audioBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
    audioMime: "audio/wav"
  });

  await executeCommand("ai ask speak", h);

  assert.equal(shownAssistant.name, "Gemini Live");
  assert.equal(shownAssistant.text, "Spoken reply");
  assert.equal(shownAssistant.audio.name, "Gemini Live response");
  assert.equal(shownAssistant.audio.mime, "audio/wav");
  assert.match(shownAssistant.audio.url, /^blob:/);
  URL.revokeObjectURL(shownAssistant.audio.url);
});


test("completed Gemini Live audio is appended inline after streamed text", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const session = {
    initialize: async () => {},
    endAssistantStream: () => calls.push({ type: "end" }),
    printMedia: (items) => calls.push({ type: "media", items }),
    printAssistant: () => calls.push({ type: "assistant" })
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => session
  });
  controller.wakeStreamStarted = true;

  controller.finishWakeLiveResult({
    text: "Finished response",
    audioBlob: new Blob([new Uint8Array([1, 2])], { type: "audio/wav" }),
    audioMime: "audio/wav",
    streamedAudio: true
  }, { name: "Gemini Live" });

  assert.equal(calls[0].type, "end");
  assert.equal(calls[1].type, "media");
  assert.equal(calls[1].items[0].name, "Gemini Live response");
  assert.equal(calls[1].items[0].mime, "audio/wav");
  assert.match(calls[1].items[0].url, /^blob:/);
  URL.revokeObjectURL(calls[1].items[0].url);
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

test("clipboard insert delegates paste-back to the native action", async () => {
  const h = harness();
  h.dispatch({
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-9", kind: "image", path: "/tmp/clip-9.png", createdAt: Date.now() }] }
  });
  let pasted = null;
  h.actions = { pasteClipboardItem: async (id) => { pasted = id; } };
  const result = await executeCommand("clipboard insert clip-9", h);
  assert.equal(pasted, "clip-9");
  assert.deepEqual(result, { pasted: "clip-9" });
});

test("clipboard polling updates state only when history changes", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let items = [{ id: "clip-1", kind: "text", text: "one", createdAt: 1 }];
  let renders = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renders += 1; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = { isNative: true, readClipboardHistory: async () => items };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  await controller.pollClipboard();
  const afterFirst = renders;
  await controller.pollClipboard();
  assert.equal(renders, afterFirst);
  items = [{ id: "clip-2", kind: "image", path: "/tmp/two.png", createdAt: 2 }, ...items];
  await controller.pollClipboard();
  assert.equal(controller.state.clipboard.items[0].id, "clip-2");
  assert.equal(renders, afterFirst + 1);
});

test("folder navigation runs cd without the terminal cwd probe", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const session = {
    initialize: async () => {},
    run: async (...args) => { calls.push(args); }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    runCommand: async () => ({ code: 0, cwd: "/tmp/project", stdout: "", stderr: "" }),
    listDirectory: async () => []
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => session });

  await controller.changeDirectory("/tmp/project", { echoInTerminal: true });

  assert.deepEqual(calls, [["cd '/tmp/project'"]]);
  assert.equal(controller.state.tabs[0].terminal.cwd, "/tmp/project");
});

test("typed terminal cd synchronizes the folder pane without a printf probe", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const terminalCalls = [];
  const session = {
    initialize: async () => {},
    run: async (...args) => { terminalCalls.push(args); }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    runCommand: async (command, cwd) => {
      assert.equal(command, "cd /tmp/project");
      assert.equal(cwd, "~");
      return { code: 0, cwd: "/tmp/project", stdout: "", stderr: "" };
    },
    listDirectory: async (path) => {
      assert.equal(path, "/tmp/project");
      return [{ name: "src", path: "/tmp/project/src", kind: "directory" }];
    }
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => session });

  await controller.runNativeTerminalCommand("cd /tmp/project");

  assert.deepEqual(terminalCalls, [["cd /tmp/project"]]);
  assert.equal(controller.state.tabs[0].terminal.cwd, "/tmp/project");
  assert.equal(controller.state.tabs[0].folder.path, "/tmp/project");
  assert.equal(controller.state.tabs[0].folder.entries[0].name, "src");
});

test("terminal keeps focus after cwd synchronization updates the folder", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let focusCalls = 0;
  const session = {
    initialize: async () => {},
    mount: async () => {},
    focus: () => { focusCalls += 1; }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    listDirectory: async () => []
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => session });
  await controller.syncDirectory("/tmp/project");
  assert.equal(focusCalls, 1);
});

test("inactive workspace cwd synchronization does not steal terminal focus", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let focusCalls = 0;
  const session = {
    initialize: async () => {},
    mount: async () => {},
    focus: () => { focusCalls += 1; }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = { isNative: true, listDirectory: async () => [] };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => session });
  const activeId = controller.state.activeTabId;
  controller.dispatch({ type: "TAB_NEW", payload: { title: "Other" } });
  await controller.syncDirectory("/tmp/background", activeId);
  assert.equal(focusCalls, 0);
});
