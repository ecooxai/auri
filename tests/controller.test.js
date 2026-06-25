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

test("model overflow Edit action reveals and closes the model editor", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const click = (action, id = "gemini-live-default") => controller.handleClick({
    target: { closest: () => ({ dataset: { action, id } }) },
    preventDefault() {}
  });

  await click("model-menu");
  assert.equal(controller.state.ui.modelMenuId, "gemini-live-default");
  await click("model-edit");
  assert.equal(controller.state.ui.modelMenuId, null);
  assert.equal(controller.state.ui.editingModelId, "gemini-live-default");
  await click("model-edit-cancel");
  assert.equal(controller.state.ui.editingModelId, null);
});

test("AI model update modifies every editable property through the command layer", async () => {
  const h = harness();
  h.backend.saveSettings = async () => {};

  await executeCommand('ai model update gemini-live-default "Studio assistant" openai "gpt-custom" "https://example.test/v1" "secret"', h);

  assert.deepEqual(h.state().models[0], {
    id: "gemini-live-default",
    name: "Studio assistant",
    type: "openai",
    model: "gpt-custom",
    url: "https://example.test/v1",
    apiKey: "secret",
    enabled: true
  });
});

test("AI model delete removes the provider and persists the fallback default", async () => {
  const h = harness();
  const saved = [];
  h.backend.saveSettings = async (configuration) => { saved.push(configuration); };
  await executeCommand('ai model add Backup openai gpt-test "" ""', h);

  await executeCommand('ai model delete gemini-live-default', h);

  assert.equal(h.state().models.some((model) => model.id === "gemini-live-default"), false);
  assert.equal(h.state().selectedModelId, h.state().models[0].id);
  assert.equal(saved.at(-1).selectedModelId, h.state().models[0].id);
});

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

test("folder path typing waits two seconds and navigates only the latest value", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { AppController } = await import("../src/controllers/app-controller.js");
  const navigated = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = { isNative: true };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.changeDirectory = async (path, options) => { navigated.push([path, options]); };

  controller.handleInput({ target: { id: "folder-path-input", value: "/tmp/first", removeAttribute() {}, classList: { remove() {} } } });
  t.mock.timers.tick(1500);
  controller.handleInput({ target: { id: "folder-path-input", value: " /tmp/latest ", removeAttribute() {}, classList: { remove() {} } } });
  t.mock.timers.tick(1999);
  assert.deepEqual(navigated, []);
  t.mock.timers.tick(1);
  await Promise.resolve();

  assert.deepEqual(navigated, [["/tmp/latest", { echoInTerminal: true }]]);
});

test("invalid typed folder paths keep the current folder and mark the input invalid", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const toasts = [];
  const attributes = new Map();
  const classes = new Set();
  const input = {
    id: "folder-path-input",
    value: "/does/not/exist",
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast: (...args) => { toasts.push(args); }
  };
  const backend = { isNative: true };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.changeDirectory = async () => { throw new Error("Folder not found"); };
  const originalPath = controller.state.tabs[0].folder.path;

  await controller.navigateTypedFolderPath(input.value, input);

  assert.equal(controller.state.tabs[0].folder.path, originalPath);
  assert.equal(attributes.get("aria-invalid"), "true");
  assert.ok(classes.has("is-invalid"));
  assert.deepEqual(toasts, [["Folder not found", "error"]]);
});

test("folder path blocks macOS arrow characters while preserving the caret", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const leftArrowText = String.fromCodePoint(0xf702);
  const rightArrowText = String.fromCodePoint(0xf703);
  let prevented = 0;

  controller.handleBeforeInput({
    target: { id: "folder-path-input" },
    inputType: "insertText",
    data: leftArrowText,
    preventDefault() { prevented += 1; }
  });
  controller.handleBeforeInput({
    target: { id: "folder-path-input" },
    inputType: "insertText",
    data: "/",
    preventDefault() { prevented += 1; }
  });

  assert.equal(prevented, 1);

  const cleanPath = "/Users/ecoo/auri";
  let keyPrevented = 0;
  let keySelection = null;
  const keyInput = {
    id: "folder-path-input",
    value: cleanPath,
    selectionStart: cleanPath.length,
    selectionEnd: cleanPath.length,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      keySelection = [start, end];
    }
  };
  await controller.handleKeydown({
    target: keyInput,
    key: "ArrowLeft",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { keyPrevented += 1; }
  });
  assert.deepEqual(keySelection, [cleanPath.length - 1, cleanPath.length - 1]);
  await controller.handleKeydown({
    target: keyInput,
    key: rightArrowText,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { keyPrevented += 1; }
  });
  assert.deepEqual(keySelection, [cleanPath.length, cleanPath.length]);
  assert.equal(keyPrevented, 2);

  const dirtyPath = `${cleanPath}${leftArrowText}${rightArrowText}`;
  let selection = null;
  let scheduledValue = null;
  const input = {
    id: "folder-path-input",
    value: dirtyPath,
    selectionStart: dirtyPath.length,
    selectionEnd: dirtyPath.length,
    setSelectionRange(start, end) { selection = [start, end]; },
    removeAttribute() {},
    classList: { remove() {} }
  };
  controller.scheduleFolderPathNavigation = (target) => { scheduledValue = target.value; };

  controller.handleInput({ target: input });

  assert.equal(input.value, cleanPath);
  assert.deepEqual(selection, [cleanPath.length, cleanPath.length]);
  assert.equal(scheduledValue, cleanPath);
});

test("folder sort command stores the selected order", async () => {
  const h = harness();
  await executeCommand("folder sort date", h);
  assert.equal(h.state().tabs[0].folder.sortBy, "date");
  await assert.rejects(() => executeCommand("folder sort size", h), /name, date, or type/);
});

test("folder create commands use the current directory and refresh entries", async () => {
  const h = harness();
  const calls = [];
  h.backend.createFile = async (...args) => { calls.push(["file", ...args]); return { name: args[1] }; };
  h.backend.createFolder = async (...args) => { calls.push(["folder", ...args]); return { name: args[1] }; };
  h.backend.listDirectory = async () => [{ name: "created.txt", path: "~/created.txt", kind: "text", size: 0, modified: 1 }];

  await executeCommand('folder create-file "created.txt"', h);
  await executeCommand('folder create-folder "New Folder"', h);

  assert.deepEqual(calls, [["file", "~", "created.txt"], ["folder", "~", "New Folder"]]);
  assert.equal(h.state().tabs[0].folder.entries[0].name, "created.txt");
});

test("folder info opens Info with structured disk, ownership, and permission details", async () => {
  const h = harness();
  h.backend.folderInfo = async (path) => ({
    path,
    name: "project",
    totalSize: 1024,
    diskTotal: 10000,
    diskUsed: 6000,
    diskAvailable: 4000,
    owner: "ecoo",
    mode: "0755",
    permissions: { read: true, write: true, execute: true }
  });

  await executeCommand("folder info", h);

  const active = h.state().tabs[0].subtabs.find((item) => item.id === h.state().tabs[0].activeSubtabId);
  assert.equal(active.type, "info");
  assert.equal(h.state().info.items[0].title, "Folder info · project");
  assert.equal(h.state().info.items[0].details.owner, "ecoo");
  assert.equal(h.state().info.items[0].details.permissions.execute, true);
});
