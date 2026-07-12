import test from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/controllers/app-controller.js";
import { executeCommand } from "../src/controllers/command-controller.js";
import { activeSubtab, createInitialState, reduceState } from "../src/model/state.js";
import { renderWebAiReply, renderWebview } from "../src/views/panels.js";

function controllerHarness({ webUrl = "https://example.org", backend = {} } = {}) {
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    getWebUrl: () => webUrl,
    showToast() {}
  };
  return new AppController({
    view,
    backend: { isNative: false, ...backend },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
}

const clickEvent = (action, dataset = {}) => ({
  target: { closest: (selector) => selector === "[data-action]" ? { dataset: { action, ...dataset } } : null },
  preventDefault() {}
});

test("magic button short click toggles the magic menu", async () => {
  const controller = controllerHarness();
  await controller.handleClick(clickEvent("web-magic"));
  assert.equal(controller.state.ui.webMagicMenuOpen, true);
  await controller.handleClick(clickEvent("web-magic"));
  assert.equal(controller.state.ui.webMagicMenuOpen, false);
});

test("magic Go runs web open with the URL bar value through the command layer", async () => {
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webMagicMenuOpen: true } });

  await controller.handleClick(clickEvent("web-magic-go"));

  assert.deepEqual(commands, ['web open "https://example.org"']);
  assert.equal(controller.state.ui.webMagicMenuOpen, false);
});

test("magic Ask sends the URL bar text to web ask and shows the floating reply", async () => {
  const controller = controllerHarness({
    webUrl: "what is on this page?",
    backend: { askAi: async () => ({ text: "A test page." }) }
  });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webMagicMenuOpen: true } });

  await controller.handleClick(clickEvent("web-magic-ask"));

  assert.equal(controller.state.ui.webMagicMenuOpen, false);
  assert.equal(controller.state.ui.webAiReply.status, "ready");
  assert.equal(controller.state.ui.webAiReply.text, "A test page.");
  assert.equal(controller.state.ui.webAiReply.prompt, "what is on this page?");
});

test("web-ai-close dismisses the floating reply through the command layer", async () => {
  const controller = controllerHarness();
  controller.state = reduceState(controller.state, {
    type: "UI_SET",
    payload: { webAiReply: { status: "ready", prompt: "p", text: "t" } }
  });

  await controller.handleClick(clickEvent("web-ai-close"));

  assert.equal(controller.state.ui.webAiReply, null);
});

test("web-ai-copy copies the full reply text without the action tags", async () => {
  const copied = [];
  const controller = controllerHarness({ backend: { writeClipboardText: async (text) => { copied.push(text); } } });
  controller.state = reduceState(controller.state, {
    type: "UI_SET",
    payload: { webAiReply: { status: "ready", prompt: "p", text: "Run <cmd>ls</cmd> now" } }
  });

  await controller.handleClick(clickEvent("web-ai-copy"));

  assert.deepEqual(copied, ["Run ls now"]);
});

test("magic menu closes when Escape is pressed", async () => {
  const controller = controllerHarness();
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webMagicMenuOpen: true } });

  await controller.handleKeydown({ key: "Escape", target: {}, preventDefault() {} });

  assert.equal(controller.state.ui.webMagicMenuOpen, false);
});

test("holding the magic button starts a live turn and release sends it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  const button = { dataset: { action: "web-magic" }, setPointerCapture() {} };

  await controller.handleMagicPointerDown({
    button: 0,
    pointerId: 4,
    target: { closest: () => button },
    preventDefault() {}
  });
  t.mock.timers.tick(999);
  assert.deepEqual(commands, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(commands, ["live record start"]);

  await controller.handleMagicPointerEnd({ type: "pointerup", pointerId: 4, preventDefault() {} });
  assert.deepEqual(commands, ["live record start", "live record stop"]);
});

test("a short magic press falls through to the click menu instead of the live API", async () => {
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  const button = { dataset: { action: "web-magic" }, setPointerCapture() {} };

  await controller.handleMagicPointerDown({
    button: 0,
    pointerId: 5,
    target: { closest: () => button },
    preventDefault() {}
  });
  await controller.handleMagicPointerEnd({ type: "pointerup", pointerId: 5, preventDefault() {} });

  assert.deepEqual(commands, []);
  await controller.handleClick(clickEvent("web-magic"));
  assert.equal(controller.state.ui.webMagicMenuOpen, true);
});

test("live sessions started from a web tab stream the reply into the floating panel", async () => {
  let handlers = null;
  const controller = controllerHarness({
    backend: {
      startWakeLiveSession: async (options) => {
        handlers = options;
        return { stop: async () => {}, cancel: async () => {} };
      }
    }
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });

  await controller.activateWakeSession();

  assert.equal(activeSubtab(controller.state).type, "webview");
  assert.equal(controller.state.ui.webAiReply.status, "listening");

  handlers.onText("Hello from");
  assert.equal(controller.state.ui.webAiReply.status, "streaming");
  assert.equal(controller.state.ui.webAiReply.text, "Hello from");

  handlers.onResult({ text: "Hello from Gemini <i>note</i>" });
  assert.equal(controller.state.ui.webAiReply.status, "ready");
  assert.equal(controller.state.ui.webAiReply.text, "Hello from Gemini <i>note</i>");
});

test("live sessions started from the terminal keep printing into the terminal", async () => {
  let handlers = null;
  const printed = [];
  const controller = controllerHarness({
    backend: {
      startWakeLiveSession: async (options) => {
        handlers = options;
        return { stop: async () => {}, cancel: async () => {} };
      }
    }
  });
  controller.terminalSessionFor = () => ({
    initializePromise: Promise.resolve(true),
    printMessage: (...args) => printed.push(args),
    beginAssistantStream: () => printed.push(["begin"]),
    appendAssistantStream: (text) => printed.push(["stream", text]),
    endAssistantStream: () => printed.push(["end"]),
    printAssistant: (...args) => printed.push(["assistant", ...args]),
    printMedia: () => {}
  });

  await controller.activateWakeSession();
  handlers.onText("Hi");

  assert.equal(controller.state.ui.webAiReply, null);
  assert.ok(printed.some(([kind]) => kind === "stream"));
});

test("web live errors surface in the floating panel and in Info", async () => {
  const controller = controllerHarness({
    backend: {
      startWakeLiveSession: async (options) => ({ stop: async () => {}, cancel: async () => {} })
    }
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });

  await controller.activateWakeSession();
  controller.failWakeLiveSession(new Error("Live socket dropped"));

  assert.equal(controller.state.ui.webAiReply.status, "error");
  assert.match(controller.state.ui.webAiReply.text, /Live socket dropped/);
  assert.ok(controller.state.info.items.some((item) => item.level === "error"));
});

test("the floating reply renders tag actions with Run, Insert, and Copy", () => {
  const html = renderWebAiReply({
    status: "ready",
    prompt: "prompt",
    modelName: "Gemini",
    text: 'Try <cmd>git status</cmd> or paste <i>hello world</i>.'
  });

  assert.match(html, /data-action="assistant-run" data-value="git status"/);
  assert.match(html, /data-action="assistant-insert" data-value="hello world"/);
  assert.match(html, /data-action="copy-text" data-value="git status"/);
  assert.doesNotMatch(html, /<cmd>/);
});

test("the floating reply keeps plain replies selectable text with Copy all", () => {
  const html = renderWebAiReply({ status: "ready", prompt: "p", modelName: "AI", text: "Plain reply" });
  assert.match(html, /data-action="web-ai-copy"/);
  assert.match(html, /web-ai-float-text/);
});

test("web ask streams into the float while loading and web ask-close clears it", async () => {
  let state = createInitialState();
  const h = {
    backend: { askAi: async () => ({ text: "done" }) },
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); },
    actions: {}
  };

  const pending = executeCommand("web ask what is this?", h);
  assert.equal(state.ui.webAiReply.status, "loading");
  await pending;
  assert.equal(state.ui.webAiReply.status, "ready");
  assert.equal(state.ui.webAiReply.text, "done");

  await executeCommand("web ask-close", h);
  assert.equal(state.ui.webAiReply, null);
});

test("the webview URL bar shows a magic button instead of a Go button", () => {
  const state = createInitialState();
  state.tabs[0].subtabs.push({ id: "subtab-web-test", type: "webview", title: "Web", url: "https://example.org/" });
  state.tabs[0].activeSubtabId = "subtab-web-test";

  const html = renderWebview(state);

  assert.match(html, /data-action="web-magic"/);
  assert.doesNotMatch(html, /data-action="web-go"/);
  assert.match(html, /magic-button/);
});

test("Alt+digit switches workspaces and Ctrl+digit switches subtabs through commands", async () => {
  const { AppController: Controller } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new Controller({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  controller.refreshFolder = async () => {};
  controller.state = reduceState(controller.state, { type: "TAB_NEW", payload: { title: "Second" } });

  await controller.handleGlobalKeydown({ code: "Digit1", key: "1", altKey: true, preventDefault() {} });
  assert.equal(commands.at(-1), `tab select ${controller.state.tabs[0].id}`);

  const subtabs = controller.state.tabs.find((tab) => tab.id === controller.state.activeTabId).subtabs;
  await controller.handleGlobalKeydown({ code: "Digit2", key: "2", ctrlKey: true, preventDefault() {} });
  assert.equal(commands.at(-1), `subtab select ${subtabs[1].id}`);

  // Out-of-range digits do nothing.
  const before = commands.length;
  await controller.handleGlobalKeydown({ code: "Digit9", key: "9", ctrlKey: true, preventDefault() {} });
  assert.equal(commands.length, before);
});
