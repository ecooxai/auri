import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "../src/controllers/command-controller.js";
import { activeSubtab, createInitialState, reduceState } from "../src/model/state.js";

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


test("system commands open refresh and sort the process monitor", async () => {
  const h = harness();
  h.backend.systemSnapshot = async () => ({
    capturedAt: "2026-06-28T08:00:00.000Z",
    cpu: { brand: "Test CPU", cores: 8, usagePercent: 12 },
    memory: { totalBytes: 1000, usedBytes: 500 },
    network: { interfaces: [], totalRxBytes: 10, totalTxBytes: 20 },
    processes: [{ pid: 7, name: "server", cpuPercent: 4, memoryBytes: 100, ports: [8080] }]
  });

  await executeCommand("system open", h);
  assert.equal(activeSubtab(h.state()).type, "system");
  assert.ok(h.state().tabs[0].subtabs.some((subtab) => subtab.type === "disk"));
  assert.ok(h.state().tabs[0].subtabs.some((subtab) => subtab.type === "net"));
  assert.equal(h.state().system.snapshot.processes[0].ports[0], 8080);

  await executeCommand("system sort port", h);
  assert.equal(h.state().system.sortBy, "port");
});

test("system search sets and clears the process filter through the command layer", async () => {
  const h = harness();
  await executeCommand("system search chrome claude", h);
  assert.equal(h.state().system.filter, "chrome claude");
  await executeCommand("system search", h);
  assert.equal(h.state().system.filter, "");
});

test("system search toggle opens the filter box and clear runs the search command", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {},
    patchSystemMonitor() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  const click = (action) => controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action } } : null },
    preventDefault() {}
  });

  await click("system-search-toggle");
  assert.equal(controller.state.ui.systemSearchOpen, true);
  await click("system-search-clear");
  assert.deepEqual(commands, ["system search"]);
});


test("system monitor keyboard shortcut opens and focuses process search", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let focused = 0;
  const searchInput = { focus() { focused += 1; } };
  const view = {
    root: { querySelector: (selector) => selector === "#system-search-input" ? searchInput : null },
    render() {}, getTerminalInputValue: () => "", showToast() {}
  };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  const systemTab = controller.state.tabs[0].subtabs.find((item) => item.type === "system");
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: systemTab.id } });
  let prevented = false;
  await controller.handleKeydown({
    key: "f", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    target: { tagName: "DIV", isContentEditable: false },
    preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.equal(controller.state.ui.systemSearchOpen, true);
  assert.equal(focused, 1);
});

test("scrolling near the end of the process table replaces it with the next 10-row page", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let patches = 0;
  let topResets = 0;
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {}, patchSystemMonitor() { patches += 1; } };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.scrollProcessTableToEdge = (edge) => { if (edge === "top") topResets += 1; };
  controller.state = reduceState(controller.state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: { capturedAt: "2026-01-01T00:00:00.000Z", processes: Array.from({ length: 25 }, (_, index) => ({ pid: index + 1, name: `process-${index + 1}` })) } }
  });
  const target = {
    id: "", dataset: { hasNext: "true" }, scrollTop: 680, clientHeight: 300, scrollHeight: 1000,
    classList: { contains: (name) => name === "process-table" }
  };
  controller.handleScroll({ target });
  assert.equal(controller.state.system.processPage, 2);
  assert.equal(patches, 1);
  assert.equal(topResets, 1);
});

test("wheel scrolling advances a fully visible 10-row process page without skipping pages", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let prevented = 0;
  const table = {
    dataset: { hasNext: "true" }, scrollTop: 0, clientHeight: 500, scrollHeight: 500,
    classList: { contains: (name) => name === "process-table" },
    closest: (selector) => selector === ".process-table" ? table : null
  };
  const view = { root: { querySelector: () => table }, render() {}, getTerminalInputValue: () => "", showToast() {}, patchSystemMonitor() {} };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: { capturedAt: "2026-01-01T00:00:00.000Z", processes: Array.from({ length: 25 }, (_, index) => ({ pid: index + 1, name: `process-${index + 1}` })) } }
  });

  controller.handleProcessPageWheel({ target: table, deltaY: 40, preventDefault() { prevented += 1; } });
  controller.handleProcessPageWheel({ target: table, deltaY: 40, preventDefault() { prevented += 1; } });
  assert.equal(controller.state.system.processPage, 2);
  assert.equal(prevented, 1);
});

test("scrolling upward at the top returns to the previous process page", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let patches = 0;
  let bottomResets = 0;
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {}, patchSystemMonitor() { patches += 1; } };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.scrollProcessTableToEdge = (edge) => { if (edge === "bottom") bottomResets += 1; };
  controller.state = reduceState(controller.state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: { capturedAt: "2026-01-01T00:00:00.000Z", processes: Array.from({ length: 25 }, (_, index) => ({ pid: index + 1, name: `process-${index + 1}` })) } }
  });
  controller.state = reduceState(controller.state, { type: "SYSTEM_PROCESS_PAGE_NEXT" });
  const target = {
    id: "", dataset: { hasPrevious: "true", hasNext: "true", lastScrollTop: "120" }, scrollTop: 0, clientHeight: 300, scrollHeight: 1000,
    classList: { contains: (name) => name === "process-table" }
  };
  controller.handleScroll({ target });
  assert.equal(controller.state.system.processPage, 1);
  assert.equal(patches, 1);
  assert.equal(bottomResets, 1);
});

test("wheel scrolling upward returns one page and page arrows navigate both directions", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let prevented = 0;
  const table = {
    dataset: { hasPrevious: "true", hasNext: "true" }, scrollTop: 0, clientHeight: 500, scrollHeight: 500,
    classList: { contains: (name) => name === "process-table" },
    closest: (selector) => selector === ".process-table" ? table : null
  };
  const view = { root: { querySelector: () => table }, render() {}, getTerminalInputValue: () => "", showToast() {}, patchSystemMonitor() {} };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: { capturedAt: "2026-01-01T00:00:00.000Z", processes: Array.from({ length: 25 }, (_, index) => ({ pid: index + 1, name: `process-${index + 1}` })) } }
  });
  controller.state = reduceState(controller.state, { type: "SYSTEM_PROCESS_PAGE_NEXT" });

  controller.handleProcessPageWheel({ target: table, deltaY: -40, preventDefault() { prevented += 1; } });
  assert.equal(controller.state.system.processPage, 1);
  assert.equal(prevented, 1);

  controller.systemProcessPageTurnAt = 0;
  const click = (action) => controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action } } : null },
    preventDefault() {}
  });
  await click("system-process-page-next");
  assert.equal(controller.state.system.processPage, 2);
  await click("system-process-page-next");
  assert.equal(controller.state.system.processPage, 3, "explicit arrow clicks are not gesture-throttled");
  await click("system-process-page-prev");
  assert.equal(controller.state.system.processPage, 2);
});

test("tunnelling a non-http port warns the person but still starts the tunnel", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const toasts = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast: (msg, kind) => toasts.push({ msg, kind })
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const ran = [];
  controller.runInternal = async (command) => { ran.push(command); };

  await controller.toggleSystemPortTunnel(22);
  assert.equal(ran.at(-1), "system tunnel start 22");
  assert.ok(toasts.some((t) => t.kind === "info" && /HTTP/.test(t.msg)), "non-http port should warn");

  toasts.length = 0;
  await controller.toggleSystemPortTunnel(3000);
  assert.equal(ran.at(-1), "system tunnel start 3000");
  assert.ok(!toasts.some((t) => t.kind === "info"), "http port should not warn");
});

test("system process RAM, Port, CPU, Net, and Disk headers sort through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
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
  controller.runInternal = async (command) => { commands.push(command); };
  const clickSort = (sort) => controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "system-sort", sort } } : null },
    preventDefault() {}
  });

  await clickSort("ram");
  await clickSort("port");
  await clickSort("cpu");
  await clickSort("net");
  await clickSort("disk");

  assert.deepEqual(commands, ["system sort ram", "system sort port", "system sort cpu", "system sort net", "system sort disk"]);
});

test("killing a process opens a confirmation prompt and only kills after confirm", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const { normalizeSystemSnapshot } = await import("../src/model/system.js");
  const commands = [];
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  controller.dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ processes: [{ pid: 42, name: "WindowServer" }] }) } });
  controller.dispatch({ type: "SYSTEM_PROCESS_SELECT", payload: { pid: 42 } });

  const click = (action, matches = []) => controller.handleClick({
    target: {
      closest: (selector) => {
        if (selector === "[data-action]") return { dataset: { action } };
        if (matches.includes(selector)) return {};
        return null;
      }
    },
    preventDefault() {}
  });

  // Clicking Kill arms the confirmation instead of killing immediately.
  await click("system-process-kill", [".system-process-detail"]);
  assert.deepEqual(commands, []);
  assert.deepEqual(controller.state.ui.systemKillPrompt, { pid: 42, name: "WindowServer" });

  // Confirming runs the kill command and clears the prompt.
  await click("system-kill-prompt-confirm", [".system-kill-prompt"]);
  assert.deepEqual(commands, ["system kill 42"]);
  assert.equal(controller.state.ui.systemKillPrompt, null);
});

test("cancelling the kill confirmation dismisses it without killing", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const { normalizeSystemSnapshot } = await import("../src/model/system.js");
  const commands = [];
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  controller.dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ processes: [{ pid: 42, name: "WindowServer" }] }) } });
  controller.dispatch({ type: "SYSTEM_PROCESS_SELECT", payload: { pid: 42 } });
  controller.dispatch({ type: "UI_SET", payload: { systemKillPrompt: { pid: 42, name: "WindowServer" } } });

  await controller.handleClick({
    target: {
      closest: (selector) => ([".system-kill-prompt", "button"].includes(selector) ? {} : selector === "[data-action]" ? { dataset: { action: "system-kill-prompt-cancel" } } : null)
    },
    preventDefault() {}
  });

  assert.deepEqual(commands, []);
  assert.equal(controller.state.ui.systemKillPrompt, null);
  // The process stays selected so the detail card remains open.
  assert.equal(controller.state.system.selectedProcessPid, 42);
});

test("workspace and cwd renders refocus the active terminal session", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback();
  const terminalHost = {};
  let rendersTerminal = false;
  const sessions = [];
  const view = {
    root: { querySelector: (selector) => selector === "#terminal-emulator" && rendersTerminal ? terminalHost : null },
    render(state) { rendersTerminal = activeSubtab(state)?.type === "terminal"; },
    getTerminalInputValue: () => "",
    showToast() {}
  };

  try {
    const controller = new AppController({
      view,
      backend: { isNative: true },
      terminalSessionFactory: () => {
        const session = {
          initialize: async () => {},
          mount: async () => {},
          focusCount: 0,
          focus() { this.focusCount += 1; }
        };
        sessions.push(session);
        return session;
      }
    });
    const terminal = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal");
    controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: terminal.id } });
    await Promise.resolve();

    controller.dispatch({ type: "TAB_NEW", payload: { title: "Build" } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sessions.at(-1).focusCount, 1);

    sessions.at(-1).focusCount = 0;
    controller.dispatch({ type: "WORKDIR_SET", payload: { path: "/tmp/build" } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sessions.at(-1).focusCount, 1);
  } finally {
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("topbar command menu selects opened tabs and exits through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
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
  controller.runInternal = async (command) => { commands.push(command); };

  await controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "command-menu" } } : null },
    preventDefault() {}
  });
  assert.equal(controller.state.ui.commandMenuOpen, true);

  await controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "command-menu-tab", id: "subtab-1" } } : null },
    preventDefault() {}
  });
  await controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "app-exit" } } : null },
    preventDefault() {}
  });

  assert.deepEqual(commands, ["subtab select subtab-1", "app exit"]);
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

test("app exit command delegates to the platform action", async () => {
  const h = harness();
  let exited = false;
  h.actions = { exitApp: async () => { exited = true; } };

  await executeCommand("app exit", h);

  assert.equal(exited, true);
});


test("file preview pin command updates the active preview state", async () => {
  const h = harness();
  h.dispatch({
    type: "FILE_SELECT",
    payload: { path: "/tmp/song.mp3", metadata: { name: "song.mp3", kind: "audio" }, preview: { url: "preview" }, open: false }
  });

  await executeCommand("file preview-pin on", h);
  assert.equal(h.state().tabs[0].viewer.pinned, true);
  await executeCommand("file preview-pin off", h);
  assert.equal(h.state().tabs[0].viewer.pinned, false);
});

test("file open routes the selected file into a webview subtab", async () => {
  const h = harness();
  h.backend.inspectFile = async (path) => ({ path, name: "test.m4a", kind: "audio" });
  let openOptions = null;
  h.actions = {
    openFileInWebview: async (path, metadata, options) => { openOptions = options; return { url: "blob:auri-audio", title: metadata.name, filePath: path }; }
  };

  await executeCommand('file open "/tmp/test.m4a"', h);

  const tab = h.state().tabs[0];
  const active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "webview");
  assert.equal(active.url, "blob:auri-audio");
  assert.equal(active.filePath, "/tmp/test.m4a");
  assert.equal(active.title, "test.m4a");
  assert.deepEqual(openOptions, { autoplay: true });
});

test("macOS Finder open requests create one current webview tab per file", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: {
      root: { querySelector: () => null },
      render() {},
      getTerminalInputValue: () => "",
      showToast() {}
    },
    backend: {
      isNative: true,
      inspectFile: async (path) => ({ path, name: path.split("/").pop(), kind: path.endsWith(".mp4") ? "video" : "text" }),
      createFileView: async (path, metadata) => ({
        url: `http://localhost:8895${path}?view=1`,
        title: metadata.name,
        filePath: path,
        mime: "text/html"
      })
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.configurationReady = true;

  await controller.openPendingFiles(["/tmp/read me.txt", "/tmp/movie.mp4"]);

  const fileTabs = controller.state.tabs[0].subtabs.filter((item) => item.type === "webview" && item.filePath);
  assert.deepEqual(fileTabs.map((item) => item.filePath), ["/tmp/read me.txt", "/tmp/movie.mp4"]);
  assert.equal(fileTabs[0].url, "http://localhost:8895/tmp/read me.txt?view=1");
  assert.equal(fileTabs[1].url, "http://localhost:8895/tmp/movie.mp4?view=1");
  assert.equal(controller.state.tabs[0].activeSubtabId, fileTabs[1].id);
});

test("native folder file clicks reuse the floating terminal preview, open, then close back to floating preview", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previews = [];
  let dismissals = 0;
  const previewSession = {
    initialize: async () => {},
    run: async () => {},
    previewElement: null,
    showPreview(target, anchor, document) {
      previews.push({ target, anchor, document });
      this.previewElement = { isConnected: true };
    },
    dismissPreview() {
      dismissals += 1;
      this.previewElement = null;
    }
  };
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      inspectFile: async (path) => ({ path, name: "notes.txt", kind: "text", preview: "hello" }),
      createFileView: async (path) => ({
        url: `http://localhost:8895${path}?view=1`,
        title: "notes.txt",
        filePath: path,
        mime: "text/html"
      })
    },
    terminalSessionFactory: () => previewSession
  });
  const anchor = { left: 12, right: 220, top: 80, bottom: 108 };
  const ownerDocument = { body: {} };

  await controller.openFolderEntry("/tmp/notes.txt", "text", { previewAnchor: anchor, previewDocument: ownerDocument, previewText: "notes.txt" });
  let tab = controller.state.tabs[0];
  let active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "terminal");
  assert.equal(tab.viewer.path, "/tmp/notes.txt");
  assert.equal(tab.viewer.mode, "inspect");
  assert.equal(tab.subtabs.some((item) => item.type === "viewer"), false);
  assert.equal(tab.subtabs.some((item) => item.filePath === "/tmp/notes.txt"), false);
  assert.deepEqual(previews[0], {
    target: { kind: "file", value: "/tmp/notes.txt", text: "notes.txt", source: "folder-pane" },
    anchor,
    document: ownerDocument
  });

  // The preview's capture-phase outside-click handler removes the card before
  // the folder row receives its second click. The controller must still advance
  // the interaction cycle instead of recreating the mini preview.
  previewSession.previewElement = null;
  await controller.openFolderEntry("/tmp/notes.txt", "text", { previewAnchor: anchor, previewDocument: ownerDocument, previewText: "notes.txt" });
  tab = controller.state.tabs[0];
  active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "webview");
  assert.equal(active.filePath, "/tmp/notes.txt");
  assert.equal(dismissals, 1);

  await controller.openFolderEntry("/tmp/notes.txt", "text", { previewAnchor: anchor, previewDocument: ownerDocument, previewText: "notes.txt" });
  tab = controller.state.tabs[0];
  active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "terminal");
  assert.equal(tab.viewer.path, "/tmp/notes.txt");
  assert.equal(tab.viewer.mode, "inspect");
  assert.equal(tab.subtabs.some((item) => item.type === "viewer"), false);
  assert.equal(tab.subtabs.some((item) => item.filePath === "/tmp/notes.txt"), false);
  assert.equal(previews.length, 2);
});

test("folder previews anchor immediately to the right of the folder pane", async () => {
  const { folderPanePreviewAnchor } = await import("../src/controllers/app-controller.js");

  assert.deepEqual(
    folderPanePreviewAnchor(
      { left: 118, right: 362, top: 281, bottom: 319 },
      { left: 105, right: 382, top: 145, bottom: 690 }
    ),
    { left: 390, right: 391, top: 281, bottom: 319 }
  );
});

test("folder first click reuses the floating directory preview and second click enters it", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commandCalls = [];
  const previews = [];
  const previewSession = {
    initialize: async () => {},
    run: async () => {},
    previewElement: null,
    showPreview(target, anchor, document) {
      previews.push({ target, anchor, document });
      this.previewElement = { isConnected: true };
    },
    dismissPreview() { this.previewElement = null; }
  };
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      inspectFile: async (path) => ({ path, name: "src", kind: "directory", mime: "inode/directory" }),
      listDirectory: async (path) => path === "/tmp/src"
        ? [
            { path: "/tmp/src/index.js", name: "index.js", kind: "text" },
            { path: "/tmp/src/components", name: "components", kind: "directory" }
          ]
        : [],
      runCommand: async (command, cwd) => {
        commandCalls.push({ command, cwd });
        return { code: 0, cwd: "/tmp/src", stdout: "", stderr: "" };
      }
    },
    terminalSessionFactory: () => previewSession
  });
  controller.state.tabs[0].folder.path = "/tmp";
  // A path remembered from an older, dismissed preview must not make a newly
  // selected folder skip its content preview and navigate immediately.
  controller.folderPreviewPath = "/tmp/src";
  controller.state.tabs[0].folder.selectedPath = null;
  const anchor = { left: 10, right: 210, top: 40, bottom: 68 };
  const ownerDocument = { body: {} };

  await controller.openFolderEntry("/tmp/src", "directory", { previewAnchor: anchor, previewDocument: ownerDocument, previewText: "src" });
  let tab = controller.state.tabs[0];
  let active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "terminal");
  assert.equal(tab.viewer.path, "/tmp/src");
  assert.deepEqual(tab.viewer.metadata.entries.map((entry) => entry.name), ["index.js", "components"]);
  assert.deepEqual(commandCalls, []);
  assert.deepEqual(previews[0], {
    target: { kind: "file", value: "/tmp/src", text: "src", source: "folder-pane" },
    anchor,
    document: ownerDocument
  });

  await controller.openFolderEntry("/tmp/src", "directory", { previewAnchor: anchor, previewDocument: ownerDocument, previewText: "src" });
  tab = controller.state.tabs[0];
  assert.deepEqual(commandCalls, [{ command: "cd '/tmp/src'", cwd: "/tmp" }]);
  assert.equal(tab.folder.path, "/tmp/src");
});

test("folder file double-click opens the file directly in the webview app", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: false,
    inspectFile: async (path) => ({ path, name: "notes.txt", kind: "text" })
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.openFileInWebview = async (path, metadata) => ({ url: "blob:auri-file-viewer", title: metadata.name, filePath: path, mime: "text/html" });

  await controller.handleDoubleClick({
    target: { closest: () => ({ dataset: { action: "file-entry", path: "/tmp/notes.txt", kind: "text" } }) },
    preventDefault() {}
  });

  const tab = controller.state.tabs[0];
  const active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.type, "webview");
  assert.equal(active.filePath, "/tmp/notes.txt");
  assert.equal(active.url, "blob:auri-file-viewer");
});

test("folder directory rows select first and open on the second click", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commandCalls = [];
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: false,
      inspectFile: async (path) => ({ path, name: "src", kind: "directory", mime: "inode/directory" }),
      runCommand: async (command, cwd) => {
        commandCalls.push({ command, cwd });
        return { code: 0, cwd: "/tmp/src", stdout: "", stderr: "" };
      },
      listDirectory: async () => []
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state.tabs[0].folder.path = "/tmp";

  await controller.openFolderEntry("/tmp/src", "directory");
  assert.equal(controller.state.tabs[0].folder.selectedPath, "/tmp/src");
  assert.deepEqual(commandCalls, []);

  await controller.openFolderEntry("/tmp/src", "directory");
  assert.deepEqual(commandCalls, [{ command: "cd '/tmp/src'", cwd: "/tmp" }]);
  assert.equal(controller.state.tabs[0].folder.path, "/tmp/src");
});

test("folder triangle toggles expansion through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: false,
      listDirectory: async (path) => path === "/tmp/src" ? [{ name: "index.js", path: "/tmp/src/index.js", kind: "text" }] : []
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "folder-toggle", path: "/tmp/src" } } : null },
    preventDefault() {}
  });

  assert.equal(controller.state.tabs[0].folder.expanded["/tmp/src"].entries[0].name, "index.js");

  await controller.handleClick({
    target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action: "folder-toggle", path: "/tmp/src" } } : null },
    preventDefault() {}
  });

  assert.equal(controller.state.tabs[0].folder.expanded["/tmp/src"], undefined);
});

test("dragging the folder edge previews panel resize and persists through settings command", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const widths = [];
  let terminalResizes = 0;
  let webviewSyncs = 0;
  const handle = {
    dataset: { action: "folder-resize" },
    setPointerCapture() {}
  };
  const view = {
    root: {
      querySelector: (selector) => selector === ".folder-pane" ? { getBoundingClientRect: () => ({ width: 230 }) } : null
    },
    render() {},
    getTerminalInputValue: () => "",
    setFolderPaneWidth: (width) => widths.push(width),
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {}, resize: () => { terminalResizes += 1; } })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  controller.syncNativeWebview = async () => { webviewSyncs += 1; };

  controller.handleFolderResizePointerDown({
    button: 0,
    pointerId: 5,
    clientX: 100,
    target: { closest: (selector) => selector === '[data-action="folder-resize"]' ? handle : null },
    preventDefault() {}
  });
  controller.handleFolderResizePointerMove({ pointerId: 5, clientX: 190, preventDefault() {} });
  await controller.handleFolderResizePointerEnd({ pointerId: 5, preventDefault() {} });

  assert.deepEqual(widths, [320]);
  assert.deepEqual(commands, ["settings set folderPaneWidth 320"]);
  assert.equal(terminalResizes, 1);
  assert.equal(webviewSyncs, 1);
});

test("file viewer save messages write text through the backend", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const posted = [];
  const writes = [];
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, showToast() {} },
    backend: { isNative: false, writeTextFile: async (path, content) => { writes.push({ path, content }); return { path, size: content.length }; } },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  const result = await controller.handleFileViewerMessage({
    origin: "blob://viewer",
    data: { source: "auri-file-viewer", type: "save-text", path: "/tmp/notes.txt", content: "updated" },
    source: { postMessage: (message, origin) => posted.push({ message, origin }) }
  });

  assert.deepEqual(writes, [{ path: "/tmp/notes.txt", content: "updated" }]);
  assert.equal(result.size, 7);
  assert.deepEqual(posted[0], {
    message: { source: "auri-host", type: "save-result", ok: true, path: "/tmp/notes.txt" },
    origin: "blob://viewer"
  });
});


test("file viewer open-as-text messages replace the active file viewer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, showToast() {} },
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.dispatch({ type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.openFileInWebview = async (path, metadata, options) => ({ url: "blob:text-viewer", title: metadata.name, filePath: path, mime: "text/html", options });
  const posted = [];

  const result = await controller.handleFileViewerMessage({
    origin: "blob://viewer",
    data: { source: "auri-file-viewer", type: "open-as-text", path: "/tmp/data.bin" },
    source: { postMessage: (message, origin) => posted.push({ message, origin }) }
  });

  const tab = controller.state.tabs[0];
  const active = tab.subtabs.find((item) => item.id === tab.activeSubtabId);
  assert.equal(active.url, "blob:text-viewer");
  assert.equal(active.filePath, "/tmp/data.bin");
  assert.deepEqual(result.options, { asText: true });
  assert.equal(posted[0].message.type, "open-as-text-result");
  assert.equal(posted[0].message.ok, true);
});

test("file viewer conversion messages stage native conversion without final folder save", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const posted = [];
  const toasts = [];
  let refreshed = false;
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, showToast(message, tone) { toasts.push({ message, tone }); } },
    backend: {
      isNative: true,
      convertMediaFile: async (payload) => { calls.push(payload); return { path: "/tmp/.auri-convert/song.tmp.mp3", name: "converted_song.mp3", pending: true, originalName: "song.wav" }; },
      listDirectory: async () => { refreshed = true; return []; }
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state.tabs[0].folder.path = "/tmp";

  const result = await controller.handleFileViewerMessage({
    origin: "blob://viewer",
    data: { source: "auri-file-viewer", type: "convert-media", id: "c1", path: "/tmp/song.wav", format: "mp3", bitrateKbps: 192, sampleRate: "48000", resolution: "native" },
    source: { postMessage: (message, origin) => posted.push({ message, origin }) }
  });

  assert.deepEqual(calls, [{ path: "/tmp/song.wav", format: "mp3", bitrateKbps: 192, sampleRate: "48000", resolution: "native" }]);
  assert.equal(result.name, "converted_song.mp3");
  assert.equal(result.pending, true);
  assert.equal(posted[0].message.type, "convert-started");
  assert.equal(posted[1].message.type, "convert-result");
  assert.equal(posted[1].message.ok, true);
  assert.equal(refreshed, false);
  assert.deepEqual(toasts, []);
});

test("file viewer save-converted-media messages finalize the renamed converted artifact", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const posted = [];
  const toasts = [];
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, showToast(message, tone) { toasts.push({ message, tone }); } },
    backend: {
      isNative: true,
      saveConvertedMediaFile: async (payload) => { calls.push(payload); return { path: "/tmp/renamed.mp3", name: "renamed.mp3", size: 42 }; },
      listDirectory: async () => []
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state.tabs[0].folder.path = "/tmp";

  const result = await controller.handleFileViewerMessage({
    origin: "blob://viewer",
    data: { source: "auri-file-viewer", type: "save-converted-media", id: "c1", path: "/tmp/song.wav", tempPath: "/tmp/.auri-convert/song.tmp.mp3", name: "renamed.mp3" },
    source: { postMessage: (message, origin) => posted.push({ message, origin }) }
  });

  assert.deepEqual(calls, [{ sourcePath: "/tmp/song.wav", tempPath: "/tmp/.auri-convert/song.tmp.mp3", name: "renamed.mp3" }]);
  assert.equal(result.name, "renamed.mp3");
  assert.equal(posted[0].message.type, "save-converted-result");
  assert.equal(posted[0].message.ok, true);
  assert.equal(toasts[0].message, "Saved renamed.mp3");
  assert.equal(toasts[0].tone, "success");
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


test("completed Gemini Live reply uses the structured renderer with inline audio", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const session = {
    initialize: async () => {},
    printAssistant: (name, text, audio) => calls.push({ type: "assistant", name, text, audio })
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "assistant");
  assert.equal(calls[0].name, "Gemini Live");
  assert.equal(calls[0].text, "Finished response");
  assert.equal(calls[0].audio.name, "Gemini Live response");
  assert.equal(calls[0].audio.mime, "audio/wav");
  assert.match(calls[0].audio.url, /^blob:/);
  URL.revokeObjectURL(calls[0].audio.url);
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


test("new terminal subtabs create independent sessions at the workspace cwd", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const created = [];
  const mounts = [];
  const terminalSessionFactory = () => {
    const session = {
      initialize: async () => {},
      mount: async (_element, cwd) => { mounts.push({ session, cwd }); },
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
  const backend = {
    isNative: false,
    saveSettings: async () => {}
  };
  let host = null;
  const view = {
    root: {
      querySelector(selector) {
        if (selector === "#terminal-emulator") return host;
        return null;
      }
    },
    render(state) {
      const workspace = state.tabs.find((tab) => tab.id === state.activeTabId);
      const active = workspace.subtabs.find((subtab) => subtab.id === workspace.activeSubtabId);
      host = active?.type === "terminal"
        ? { dataset: { workspaceId: workspace.id, terminalId: active.id }, addEventListener() {} }
        : null;
    },
    getTerminalInputValue: () => "",
    setTerminalCompletions() {},
    showToast() {}
  };
  globalThis.requestAnimationFrame = (callback) => callback();

  try {
    const controller = new AppController({ view, backend, terminalSessionFactory });
    controller.dispatch({ type: "WORKDIR_SET", payload: { path: "/tmp/auri-space" } });

    await controller.runInternal("subtab new terminal");

    assert.equal(created.length, 2);
    assert.deepEqual(mounts.map((item) => item.cwd), ["/tmp/auri-space", "/tmp/auri-space"]);
  } finally {
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
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


test("clicking an image clipboard path copies the full stored path and confirms success", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const toasts = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast(message, level) { toasts.push([message, level]); }
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  await controller.handleClick({
    target: {
      closest(selector) {
        if (selector === "[data-action]") return { dataset: { action: "clipboard-copy-path", value: "/tmp/Auri Clipboard/image 1.png" } };
        if (selector === ".clipboard-info-popup") return {};
        return null;
      }
    },
    preventDefault() {}
  });

  assert.deepEqual(commands, ['clipboard copy "/tmp/Auri Clipboard/image 1.png"']);
  assert.deepEqual(toasts, [["Copied", "success"]]);
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
  assert.equal(renders, afterFirst);
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
  const terminal = controller.state.tabs[0].subtabs.find((item) => item.type === "terminal");
  controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: terminal.id } });

  await controller.changeDirectory("/tmp/project", { echoInTerminal: true });

  assert.deepEqual(calls, [["cd '/tmp/project'"]]);
  assert.equal(controller.state.tabs[0].terminal.cwd, "/tmp/project");
});

test("folder navigation opens a new adjacent terminal when the focused terminal is busy", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const runs = [];
  const sessions = [];
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} };
  const backend = {
    isNative: true,
    runCommand: async () => ({ code: 0, cwd: "/tmp/project", stdout: "", stderr: "" }),
    listDirectory: async () => []
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => {
      const isFirstSession = sessions.length === 0;
      const session = {
        cwd: "~",
        initialize: async () => {},
        isBusy: async () => isFirstSession,
        run: async (command) => { runs.push(command); session.cwd = "/tmp/project"; }
      };
      sessions.push(session);
      return session;
    }
  });
  const firstTerminalId = controller.state.tabs[0].subtabs[0].id;
  controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: firstTerminalId } });

  await controller.changeDirectory("/tmp/project", { echoInTerminal: true });

  const tab = controller.state.tabs[0];
  assert.equal(tab.subtabs.filter((item) => item.type === "terminal").length, 2);
  assert.equal(tab.subtabs[0].id, firstTerminalId);
  assert.equal(tab.subtabs[1].id, tab.activeSubtabId);
  assert.equal(tab.subtabs[1].cwd, "/tmp/project");
  assert.deepEqual(runs, []);
});

test("folder navigation outside a terminal changes only the folder path", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const runs = [];
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} };
  const backend = {
    isNative: true,
    runCommand: async () => ({ code: 0, cwd: "/tmp/project", stdout: "", stderr: "" }),
    listDirectory: async () => []
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => ({ initialize: async () => {}, isBusy: async () => false, run: async (command) => runs.push(command) })
  });
  const system = controller.state.tabs[0].subtabs.find((item) => item.type === "system");
  controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: system.id } });

  await controller.changeDirectory("/tmp/project", { echoInTerminal: true });

  assert.equal(controller.state.tabs[0].folder.path, "/tmp/project");
  assert.equal(controller.state.tabs[0].subtabs[0].cwd, "~");
  assert.deepEqual(runs, []);
});

test("switching terminals keeps their own pwd and opens the folder at the selected terminal pwd", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const listed = [];
  const runs = [];
  const sessions = new Map();
  const view = { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      listDirectory: async (path) => {
        listed.push(path);
        return [{ name: path.split("/").at(-1), path, kind: "directory" }];
      }
    },
    terminalSessionFactory: () => ({ initialize: async () => {}, run: async (command) => runs.push(command) })
  });
  const workspace = controller.state.tabs[0];
  const first = workspace.subtabs.find((item) => item.type === "terminal");
  controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: first.id } });
  controller.dispatch({ type: "TERMINAL_CWD_SET", payload: { terminalId: first.id, path: "/tmp/first" } });
  controller.dispatch({ type: "SUBTAB_NEW", payload: { type: "terminal", cwd: "/tmp/second" } });
  const second = controller.state.tabs[0].subtabs.find((item) => item.type === "terminal" && item.id !== first.id);
  sessions.set(first.id, { cwd: "/tmp/first-latest", refreshCwd: async () => {}, run: async (command) => runs.push(command) });
  sessions.set(second.id, { cwd: "/tmp/second", refreshCwd: async () => {}, run: async (command) => runs.push(command) });
  controller.terminalSessions = sessions;

  await controller.runInternal(`subtab select ${first.id}`);
  assert.equal(controller.state.tabs[0].folder.path, "/tmp/first-latest");
  assert.equal(controller.state.tabs[0].subtabs.find((item) => item.id === second.id).cwd, "/tmp/second");

  await controller.runInternal(`subtab select ${second.id}`);
  assert.equal(controller.state.tabs[0].folder.path, "/tmp/second");
  assert.equal(controller.state.tabs[0].subtabs.find((item) => item.id === first.id).cwd, "/tmp/first-latest");
  assert.deepEqual(listed, ["/tmp/first-latest", "/tmp/second"]);
  assert.deepEqual(runs, []);
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

test("cwd synchronization does not steal focus from the composer", async () => {
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
  assert.equal(focusCalls, 0);
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

test("folder create commands run quoted terminal commands and refresh entries", async () => {
  const h = harness();
  const commands = [];
  h.backend.runCommand = async (command, cwd) => {
    commands.push([command, cwd]);
    return { stdout: "", stderr: "", code: 0, cwd };
  };
  h.backend.listDirectory = async () => [{ name: "created.txt", path: "~/created.txt", kind: "text", size: 0, modified: 1 }];

  await executeCommand('folder create-file "created file.txt"', h);
  await executeCommand('folder create-folder "New Folder"', h);

  assert.deepEqual(commands, [["touch 'created file.txt'", "~"], ["mkdir -p 'New Folder'", "~"]]);
  assert.equal(h.state().tabs[0].folder.entries[0].name, "created.txt");
  assert.deepEqual(h.state().tabs[0].terminal.history.slice(-2).map((item) => item.command), ["touch 'created file.txt'", "mkdir -p 'New Folder'"]);
});

test("folder creation form submits on Enter and cancels on Escape", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    getFolderCreateName: () => "notes today.txt",
    showToast() {}
  };
  const backend = { isNative: true };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.runInternal = async (command) => { commands.push(command); };
  controller.dispatch({ type: "UI_SET", payload: { folderCreateKind: "file" } });

  let prevented = 0;
  await controller.handleKeydown({
    target: { id: "folder-create-input" },
    key: "Enter",
    preventDefault() { prevented += 1; }
  });
  assert.deepEqual(commands, ['folder create-file "notes today.txt"']);
  assert.equal(controller.state.ui.folderCreateKind, null);
  assert.equal(prevented, 1);

  controller.dispatch({ type: "UI_SET", payload: { folderCreateKind: "folder" } });
  await controller.handleKeydown({
    target: { id: "folder-create-input" },
    key: "Escape",
    preventDefault() { prevented += 1; }
  });
  assert.equal(controller.state.ui.folderCreateKind, null);
  assert.equal(commands.length, 1);
  assert.equal(prevented, 2);
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

test("folder New File and OK button open and submit the inline form", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    getFolderCreateName: () => "button-created.txt",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => { commands.push(command); };
  const click = (action) => controller.handleClick({
    target: { closest: () => ({ dataset: { action } }) },
    preventDefault() {}
  });

  await click("folder-new-file");
  assert.equal(controller.state.ui.folderCreateKind, "file");
  await click("folder-create-confirm");

  assert.deepEqual(commands, ['folder create-file "button-created.txt"']);
  assert.equal(controller.state.ui.folderCreateKind, null);
});

test("terminal model dropdown selects a model through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
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
  controller.runInternal = async (command) => { commands.push(command); };

  await controller.handleChange({ target: { id: "terminal-model-select", value: "openai-default", dataset: {} } });

  assert.deepEqual(commands, ['ai model select "openai-default"']);
});



test("selected process detail copy and outside click use the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
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
  controller.state = {
    ...controller.state,
    system: {
      ...controller.state.system,
      selectedProcessPid: 42,
      snapshot: { processes: [{ pid: 42, commandLine: "/usr/bin/python -m app" }] }
    }
  };
  controller.runInternal = async (command) => { commands.push(command); };

  const targetForAction = (dataset, insideDetail = false) => ({
    closest: (selector) => {
      if (selector === ".system-process-detail") return insideDetail ? {} : null;
      if (selector === "[data-action]") return { dataset };
      return null;
    }
  });

  await controller.handleClick({
    target: targetForAction({ action: "system-process-copy-value", value: "/usr/bin/python -m app" }, true),
    preventDefault() {}
  });
  await controller.handleClick({
    target: { closest: () => null },
    preventDefault() {}
  });

  assert.deepEqual(commands, ['clipboard copy "/usr/bin/python -m app"', "system deselect"]);
});

test("selected process tunnel buttons prompt and use the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const confirmations = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = (message) => {
    confirmations.push(message);
    return true;
  };
  try {
    const controller = new AppController({
      view,
      backend: { isNative: true, cloudflaredStatus: async () => ({ available: false }) },
      terminalSessionFactory: () => ({ initialize: async () => {} })
    });
    controller.state = {
      ...controller.state,
      system: {
        ...controller.state.system,
        selectedProcessPid: 42,
        tunnels: { 5173: { port: 5173, url: "https://auri-preview.trycloudflare.com", pid: 222 } },
        snapshot: { processes: [{ pid: 42, commandLine: "/usr/bin/python -m app", ports: [3000, 5173] }] }
      }
    };
    controller.runInternal = async (command) => { commands.push(command); };
    const targetForAction = (dataset) => ({
      closest: (selector) => {
        if (selector === ".system-process-detail") return {};
        if (selector === "[data-action]") return { dataset };
        return null;
      }
    });

    await controller.handleClick({
      target: targetForAction({ action: "system-process-tunnel-toggle", port: "3000" }),
      preventDefault() {}
    });
    await controller.handleClick({
      target: targetForAction({ action: "system-process-tunnel-toggle", port: "5173" }),
      preventDefault() {}
    });
    await controller.handleClick({
      target: targetForAction({ action: "system-process-tunnel-copy-url", value: "https://auri-preview.trycloudflare.com" }),
      preventDefault() {}
    });
  } finally {
    globalThis.confirm = previousConfirm;
  }

  assert.deepEqual(commands, ["system tunnel start 3000 --install", "system tunnel stop 5173", 'clipboard copy "https://auri-preview.trycloudflare.com"']);
  assert.equal(confirmations.length, 0);
});

test("system tunnel commands call the backend and update tunnel state", async () => {
  const h = harness();
  const calls = [];
  h.backend.startCloudflaredTunnel = async ({ port, installIfMissing }) => {
    calls.push(["start", port, installIfMissing]);
    return { port, url: `https://port-${port}.trycloudflare.com`, pid: 999 };
  };
  h.backend.stopCloudflaredTunnel = async (port) => {
    calls.push(["stop", port]);
    return { port };
  };

  await executeCommand("system tunnel start 8080 --install", h);
  assert.equal(h.state().system.tunnels[8080].url, "https://port-8080.trycloudflare.com");
  await executeCommand("system tunnel stop 8080", h);
  assert.equal(h.state().system.tunnels[8080], undefined);
  assert.deepEqual(calls, [["start", 8080, true], ["stop", 8080]]);
});

test("clipboard pin and remove commands persist through the backend and replace state", async () => {
  const h = harness();
  h.dispatch({
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-1", kind: "text", text: "one", pinned: false, createdAt: 1 }] }
  });
  const calls = [];
  h.backend.setClipboardPinned = async (id, pinned) => {
    calls.push(["pin", id, pinned]);
    return [{ id, kind: "text", text: "one", pinned, createdAt: 1 }];
  };
  h.backend.removeClipboardItem = async (id) => {
    calls.push(["remove", id]);
    return [];
  };

  await executeCommand("clipboard pin clip-1", h);
  assert.equal(h.state().clipboard.items[0].pinned, true);
  await executeCommand("clipboard remove clip-1", h);
  assert.equal(h.state().clipboard.items.length, 0);
  assert.deepEqual(calls, [["pin", "clip-1", true], ["remove", "clip-1"]]);
});

test("clipboard menu click toggles the menu without pasting", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let pasted = 0;
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false, pasteClipboardItem: async () => { pasted += 1; } },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  await controller.handleClick({
    target: { closest: () => ({ dataset: { action: "clipboard-menu", id: "clip-1" } }) },
    preventDefault() {}
  });

  assert.equal(controller.state.ui.clipboardMenuId, "clip-1");
  assert.equal(pasted, 0);
});


test("configuration saves include the current workspace session", async () => {
  const h = harness();
  const saved = [];
  h.backend.saveSettings = async (configuration) => saved.push(configuration);
  h.dispatch({ type: "WORKDIR_SET", payload: { path: "/Users/auri/Desktop" } });

  await executeCommand("settings set fontSize 18", h);

  assert.deepEqual(saved.at(-1).workspaceSession, {
    activeIndex: 0,
    items: [{ title: "Home", path: "/Users/auri/Desktop" }]
  });
});

test("app startup restores open workspaces and loads the active saved folder", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const loadedPaths = [];
  const savedSession = {
    activeIndex: 1,
    items: [
      { title: "Home", path: "/Users/auri/Desktop" },
      { title: "Client", path: "/Users/auri/Projects/client-app" }
    ]
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ workspaceSession: savedSession }),
    setItem() {}
  };
  const view = {
    root: { addEventListener() {}, querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: false,
    initialize: async () => ({ root: "~", mode: "browser-preview" }),
    listDirectory: async (path) => { loadedPaths.push(path); return []; },
    saveSettings: async () => ({ ok: true })
  };
  const terminalSessionFactory = () => ({
    initialize: async () => true,
    mount: async () => {},
    stop: async () => {}
  });

  try {
    const controller = new AppController({ view, backend, terminalSessionFactory });
    await controller.initialize();
    assert.deepEqual(controller.state.tabs.map((tab) => tab.folder.path), [
      "/Users/auri/Desktop",
      "/Users/auri/Projects/client-app"
    ]);
    assert.equal(controller.state.activeTabId, controller.state.tabs[0].id);
    assert.equal(controller.state.tabs[0].activeSubtabId, controller.state.tabs[0].subtabs[0].id);
    assert.equal(controller.state.tabs[0].folder.path, controller.state.tabs[0].subtabs[0].cwd);
    assert.ok(controller.state.tabs[0].subtabs.some((item) => item.type === "system"));
    assert.equal(loadedPaths.at(-1), "/Users/auri/Desktop");
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("workspace and folder changes automatically persist the session", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const saved = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false, saveSettings: async (configuration) => saved.push(configuration) },
    terminalSessionFactory: () => ({ initialize: async () => {}, stop: async () => {} })
  });
  controller.configurationReady = true;

  controller.dispatch({ type: "WORKDIR_SET", payload: { path: "/Users/auri/Desktop" } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(saved.at(-1).workspaceSession.items[0].path, "/Users/auri/Desktop");
});

test("folder Home uses an unquoted tilde while normal paths stay safely quoted", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const commands = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: false,
    runCommand: async (command) => {
      commands.push(command);
      return { code: 0, cwd: command === "cd ~" ? "/Users/ecoo" : "/tmp/project", stdout: "", stderr: "" };
    },
    listDirectory: async () => []
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => ({ initialize: async () => {}, focus() {} })
  });

  await controller.changeDirectory("~");
  await controller.changeDirectory("/tmp/project");

  assert.deepEqual(commands, ["cd ~", "cd '/tmp/project'"]);
});

test("every AI request adds sanitized text and sent media details to Info", async () => {
  const h = harness();
  h.backend.askAi = async ({ prompt, onRequest }) => {
    await onRequest({
      text: prompt,
      modelName: "Gemini Live",
      media: [
        { id: "screen-1", name: "screen.jpg", kind: "image", mime: "image/jpeg", url: "asset://screen.jpg", path: "/tmp/screen.jpg" },
        { id: "audio-1", name: "voice.wav", kind: "audio", mime: "audio/wav", url: "blob:voice" }
      ]
    });
    return { text: "done" };
  };

  await executeCommand("ai ask inspect this", h);

  const item = h.state().info.items[0];
  assert.equal(item.title, "AI request · Gemini Live");
  assert.equal(item.message, "inspect this");
  assert.equal(item.details.type, "ai-request");
  assert.equal(item.details.text, "inspect this");
  assert.deepEqual(item.details.media.map((media) => media.kind), ["image", "audio"]);
  assert.equal("apiKey" in item.details, false);
});


test("wake shortcut settings replace the registered native accelerator before persisting", async () => {
  const h = harness();
  const registrations = [];
  const saved = [];
  h.backend.setWakeShortcut = async (shortcut) => registrations.push(shortcut);
  h.backend.saveSettings = async (configuration) => saved.push(configuration);

  await executeCommand('settings set wakeShortcut "Control+Shift+K"', h);

  assert.deepEqual(registrations, ["Control+Shift+K"]);
  assert.equal(h.state().settings.wakeShortcut, "Control+Shift+K");
  assert.equal(saved.at(-1).settings.wakeShortcut, "Control+Shift+K");
});

test("all-workspaces visibility setting applies natively before persisting", async () => {
  const h = harness();
  const applied = [];
  const saved = [];
  h.backend.setVisibleOnAllWorkspaces = async (enabled) => applied.push(enabled);
  h.backend.saveSettings = async (configuration) => saved.push(configuration);

  await executeCommand("settings set visibleOnAllWorkspaces false", h);

  assert.deepEqual(applied, [false]);
  assert.equal(h.state().settings.visibleOnAllWorkspaces, false);
  assert.equal(saved.at(-1).settings.visibleOnAllWorkspaces, false);
});

test("failed all-workspaces visibility change leaves the previous setting intact", async () => {
  const h = harness();
  let saveCount = 0;
  h.backend.setVisibleOnAllWorkspaces = async () => { throw new Error("X11 desktop visibility is unavailable"); };
  h.backend.saveSettings = async () => { saveCount += 1; };

  await assert.rejects(
    () => executeCommand("settings set visibleOnAllWorkspaces false", h),
    /X11 desktop visibility is unavailable/
  );

  assert.equal(h.state().settings.visibleOnAllWorkspaces, true);
  assert.equal(saveCount, 0);
});

test("failed wake shortcut registration leaves the previous setting intact", async () => {
  const h = harness();
  let saveCount = 0;
  h.backend.setWakeShortcut = async () => { throw new Error("shortcut unavailable"); };
  h.backend.saveSettings = async () => { saveCount += 1; };

  await assert.rejects(() => executeCommand('settings set wakeShortcut "Command+K"', h), /shortcut unavailable/);

  assert.equal(h.state().settings.wakeShortcut, "Alt+Space");
  assert.equal(saveCount, 0);
});

test("wake shortcut field captures the pressed combination instead of typed text", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const registrations = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: false,
      setWakeShortcut: async (shortcut) => registrations.push(shortcut),
      saveSettings: async () => {}
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  let prevented = false;
  let stopped = false;
  let blurred = false;
  const input = {
    id: "wake-shortcut-input",
    dataset: { setting: "wakeShortcut" },
    value: "Alt+Space",
    blur() { blurred = true; }
  };

  await controller.handleKeydown({
    target: input,
    code: "KeyJ",
    key: "j",
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
  });

  assert.equal(input.value, "Command+Alt+J");
  assert.equal(controller.state.settings.wakeShortcut, "Command+Alt+J");
  assert.deepEqual(registrations, ["Command+Alt+J"]);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(blurred, true);
});

test("browser preview wake listener follows the configured shortcut", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: { root: {}, render() {}, showToast() {} },
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state.settings.wakeShortcut = "Control+Shift+J";
  controller.state.settings.wakeHoldSeconds = 30;
  const custom = {
    code: "KeyJ", key: "j", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false,
    preventDefault() {}
  };

  await controller.handleGlobalKeydown({ code: "Space", key: " ", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault() {} });
  assert.equal(controller.wakeTimer, null);

  await controller.handleGlobalKeydown(custom);
  assert.notEqual(controller.wakeTimer, null);
  controller.handleGlobalKeyup({ code: "KeyJ", key: "j" });
  assert.equal(controller.wakeTimer, null);
});

test("native startup applies the restored wake shortcut", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousWindow = globalThis.window;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  const registrations = [];
  const controller = new AppController({
    view: { root: { addEventListener() {}, querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      listenForCommands: async () => {},
      listen: async () => {},
      initialize: async () => ({ root: "~", configuration: { settings: { wakeShortcut: "Command+Shift+U" } } }),
      setWakeShortcut: async (shortcut) => registrations.push(shortcut),
      listDirectory: async () => [],
      readShellHistory: async () => [],
      readClipboardHistory: async () => [],
      mediaPermissionStatus: async () => ({ microphone: "authorized", screenRecording: "authorized" })
    },
    terminalSessionFactory: () => ({ initialize: async () => true, mount: async () => {} })
  });

  try {
    await controller.initialize();
    assert.deepEqual(registrations, ["Command+Shift+U"]);
  } finally {
    if (controller.clipboardPollTimer) clearInterval(controller.clipboardPollTimer);
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("native startup applies the restored all-workspaces visibility preference", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousWindow = globalThis.window;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  const applied = [];
  const controller = new AppController({
    view: { root: { addEventListener() {}, querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      listenForCommands: async () => {},
      listen: async () => {},
      initialize: async () => ({ root: "~", configuration: { settings: { visibleOnAllWorkspaces: false } } }),
      setWakeShortcut: async () => {},
      setVisibleOnAllWorkspaces: async (enabled) => applied.push(enabled),
      listDirectory: async () => [],
      readShellHistory: async () => [],
      readClipboardHistory: async () => [],
      mediaPermissionStatus: async () => ({ microphone: "authorized", screenRecording: "authorized" })
    },
    terminalSessionFactory: () => ({ initialize: async () => true, mount: async () => {} })
  });

  try {
    await controller.initialize();
    assert.deepEqual(applied, [false]);
  } finally {
    if (controller.clipboardPollTimer) clearInterval(controller.clipboardPollTimer);
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }
});

test("native wake handler is dynamic instead of matching Alt+Space", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile("src-tauri/src/lib.rs", "utf8"));
  assert.match(source, /fn set_wake_shortcut/);
  assert.match(source, /unregister/);
  assert.doesNotMatch(source, /shortcut\.matches\(Modifiers::ALT, Code::Space\)/);
  assert.match(source, /set_wake_shortcut,/);
});

test("refreshActiveTunnels reconciles externally-managed tunnels (e.g. token-based fixed-URL tunnels) into process detail state", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };

  let discoveredTunnels = [
    { port: 8009, url: "https://miniswetagentmcpmacneo.22222233.xyz", pid: 75278, path: "" }
  ];

  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 5 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: [{ pid: 75278, name: "cloudflared", cpuPercent: 1, memoryBytes: 10, ports: [8009] }]
      }),
      cloudflaredActiveTunnels: async () => discoveredTunnels
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  // Simulate a tunnel that was never started through Auri's own start/stop
  // flow (e.g. `cloudflared tunnel run --token ...` started independently,
  // exposing a fixed production URL on port 8009). Before the fix, nothing
  // ever called cloudflaredActiveTunnels, so state.system.tunnels stayed
  // empty and the process detail panel showed "No public tunnel".
  await controller.refreshActiveTunnels();
  assert.equal(controller.state.system.tunnels[8009].url, "https://miniswetagentmcpmacneo.22222233.xyz");
  assert.equal(controller.state.system.tunnels[8009].pid, 75278);

  // If the tunnel later disappears (process exits), the stale entry should
  // be removed rather than left showing a dead tunnel as active.
  discoveredTunnels = [];
  await controller.refreshActiveTunnels();
  assert.equal(controller.state.system.tunnels[8009], undefined);
});


test("quiet background system polling updates state without rendering inactive tabs", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let renderCount = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renderCount += 1; },
    getTerminalInputValue: () => "typing in composer",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 7 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: [{ pid: 77, name: "node", cpuPercent: 1 }]
      }),
      cloudflaredActiveTunnels: async () => [
        { port: 5173, url: "https://auri-preview.example", pid: 77, path: "" }
      ]
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const terminalSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal");
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: terminalSubtab.id } });

  await controller.refreshSystemMonitor({ quiet: true });
  await controller.refreshActiveTunnels({ render: false });

  assert.equal(renderCount, 0);
  assert.equal(activeSubtab(controller.state).type, "terminal");
  assert.equal(controller.state.system.snapshot.processes[0].pid, 77);
  assert.equal(controller.state.system.tunnels[5173].url, "https://auri-preview.example");
});

test("system monitor polling runs only while system disk or net subtabs are focused", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const timers = [];
  const cleared = [];
  globalThis.setInterval = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    cleared.push(timer);
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true, systemSnapshot: async () => ({ processes: [] }) },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const terminalSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal");
  const systemSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "system");

  try {
    controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: terminalSubtab.id } });
    controller.syncSystemMonitorPolling();
    assert.equal(timers.length, 0);

    controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: systemSubtab.id } });
    controller.syncSystemMonitorPolling();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5000);

    controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: terminalSubtab.id } });
    controller.syncSystemMonitorPolling();
    assert.deepEqual(cleared, [timers[0]]);
    assert.equal(controller.systemMonitorTimer, null);
  } finally {
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
  }
});

test("system monitor refresh also syncs discovered tunnels automatically", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };

  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 5 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: [{ pid: 75278, name: "cloudflared", ports: [8009] }]
      }),
      cloudflaredActiveTunnels: async () => [
        { port: 8009, url: "https://miniswetagentmcpmacneo.22222233.xyz", pid: 75278, path: "" }
      ]
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.refreshSystemMonitor();
  // refreshActiveTunnels is fired-and-forgotten inside refreshSystemMonitor;
  // await it directly too so the assertion isn't racy in this test.
  await controller.refreshActiveTunnels();
  assert.equal(controller.state.system.tunnels[8009].url, "https://miniswetagentmcpmacneo.22222233.xyz");
});

test("refreshActiveTunnels removes a tunnel URL once its process is no longer in the live process snapshot", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };

  let liveProcesses = [{ pid: 75278, name: "cloudflared", cpuPercent: 1, memoryBytes: 10, ports: [8009] }];

  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 5 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: liveProcesses
      }),
      // discover_active_tunnels still reports the tunnel (e.g. a brief race
      // where the ps scan and the process snapshot disagree, or a stale
      // pid was reused) but the live process snapshot says the pid is gone.
      cloudflaredActiveTunnels: async () => [
        { port: 8009, url: "https://miniswetagentmcpmacneo.22222233.xyz", pid: 75278, path: "" }
      ]
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.refreshSystemMonitor();
  await controller.refreshActiveTunnels();
  assert.equal(controller.state.system.tunnels[8009].url, "https://miniswetagentmcpmacneo.22222233.xyz");

  // Process disappears from the live snapshot (cloudflared died).
  liveProcesses = [];
  await controller.refreshSystemMonitor();
  await controller.refreshActiveTunnels();
  assert.equal(controller.state.system.tunnels[8009], undefined);
});

test("clicking the tunnel URL opens a float menu with Open in browser and Copy URL, each closing the menu after use", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const opened = [];
  const copied = [];

  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      openExternalUrl: async (url) => { opened.push(url); },
      saveSettings: async () => {}
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.runInternal = async (command) => {
    if (command.startsWith("clipboard copy")) copied.push(command);
  };

  const targetForAction = (dataset, insideProcessDetail = false) => ({
    closest: (selector) => {
      if (selector === "[data-action]") return { dataset };
      if (selector === ".system-process-detail") return insideProcessDetail ? {} : null;
      if (selector === ".process-detail-port-url-menu, .process-detail-port-url") return insideProcessDetail ? {} : null;
      return null;
    }
  });

  // Toggle the popover open.
  await controller.handleClick({
    target: targetForAction({ action: "system-process-tunnel-url-menu-toggle", port: "8009", value: "https://miniswetagentmcpmacneo.22222233.xyz" }, true),
    preventDefault() {}
  });
  assert.equal(controller.state.ui.tunnelUrlMenuPort, 8009);

  // Choosing "Open in browser" opens it and closes the menu.
  await controller.handleClick({
    target: targetForAction({ action: "system-process-tunnel-url-menu-open", value: "https://miniswetagentmcpmacneo.22222233.xyz" }, true),
    preventDefault() {}
  });
  assert.deepEqual(opened, ["https://miniswetagentmcpmacneo.22222233.xyz"]);
  assert.equal(controller.state.ui.tunnelUrlMenuPort, null);

  // Reopen, then choose "Copy URL" — should copy and show a toast.
  let toasted = null;
  view.showToast = (message, kind) => { toasted = [message, kind]; };
  await controller.handleClick({
    target: targetForAction({ action: "system-process-tunnel-url-menu-toggle", port: "8009", value: "https://miniswetagentmcpmacneo.22222233.xyz" }, true),
    preventDefault() {}
  });
  await controller.handleClick({
    target: targetForAction({ action: "system-process-tunnel-url-menu-copy", value: "https://miniswetagentmcpmacneo.22222233.xyz" }, true),
    preventDefault() {}
  });
  assert.equal(copied.length, 1);
  assert.deepEqual(toasted, ["Copied tunnel URL", "success"]);
  assert.equal(controller.state.ui.tunnelUrlMenuPort, null);
});

test("the dedicated open button opens the tunnel URL directly without requiring the float menu", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const opened = [];

  const controller = new AppController({
    view,
    backend: { isNative: true, openExternalUrl: async (url) => { opened.push(url); } },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  const targetForAction = (dataset) => ({
    closest: (selector) => (selector === "[data-action]" ? { dataset } : (selector === ".system-process-detail" ? {} : null))
  });

  await controller.handleClick({
    target: targetForAction({ action: "system-process-tunnel-open", value: "https://miniswetagentmcpmacneo.22222233.xyz" }),
    preventDefault() {}
  });
  assert.deepEqual(opened, ["https://miniswetagentmcpmacneo.22222233.xyz"]);
});

test("syncDirectory applies the working directory and folder entries with a single render", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let renderCount = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renderCount += 1; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      listDirectory: async () => [{ name: "a.txt", path: "/tmp/project/a.txt", kind: "file" }]
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.syncDirectory("/tmp/project");

  assert.equal(renderCount, 1);
  const workspace = controller.state.tabs.find((tab) => tab.id === controller.state.activeTabId);
  assert.equal(workspace.terminal.cwd, "/tmp/project");
  assert.equal(workspace.folder.path, "/tmp/project");
  assert.deepEqual(workspace.folder.entries.map((entry) => entry.name), ["a.txt"]);
});

test("clipboard polling updates state without re-rendering while the clipboard subtab is inactive", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let renderCount = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renderCount += 1; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      readClipboardHistory: async () => [{ id: "clip-1", text: "copied elsewhere" }]
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const terminalSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal");
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: terminalSubtab.id } });

  await controller.pollClipboard();

  assert.equal(renderCount, 0);
  assert.equal(controller.state.clipboard.items[0].id, "clip-1");

  // With the clipboard subtab focused, the same change must still render.
  const clipboardSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "clipboard")
    || (() => {
      controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "clipboard" } });
      return controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "clipboard");
    })();
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: clipboardSubtab.id } });
  controller.state = reduceState(controller.state, { type: "CLIPBOARD_SET", payload: { items: [] } });
  await controller.pollClipboard();
  assert.equal(renderCount, 1);
  assert.equal(controller.state.clipboard.items[0].id, "clip-1");
});

test("quiet system polling patches the open monitor in place instead of a full re-render", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let renderCount = 0;
  let patchCount = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renderCount += 1; },
    patchSystemMonitor() { patchCount += 1; return true; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 7 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: [{ pid: 77, name: "node", cpuPercent: 1 }]
      })
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const systemSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "system");
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: systemSubtab.id } });

  await controller.refreshSystemMonitor({ quiet: true });

  assert.equal(renderCount, 0);
  assert.equal(patchCount, 1);
  assert.equal(controller.state.system.snapshot.processes[0].pid, 77);
});

test("quiet system polling falls back to a full render when in-place patching is not possible", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let renderCount = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renderCount += 1; },
    patchSystemMonitor() { return false; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: {
      isNative: true,
      systemSnapshot: async () => ({
        capturedAt: "2026-06-30T08:00:00.000Z",
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 7 },
        memory: { totalBytes: 1000, usedBytes: 500 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: []
      })
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const systemSubtab = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "system");
  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: systemSubtab.id } });

  await controller.refreshSystemMonitor({ quiet: true });

  assert.equal(renderCount, 1);
});
