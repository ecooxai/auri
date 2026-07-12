import test from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/controllers/app-controller.js";

function createController(terminalSessionFactory, toasts = []) {
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast(message, level) { toasts.push([message, level]); }
  };
  return new AppController({ view, backend: { isNative: false }, terminalSessionFactory });
}

test("terminal sessions receive command-backed Insert and Copy callbacks", async () => {
  let actions;
  const controller = createController((_backend, receivedActions) => {
    actions = receivedActions;
    return { initialize: async () => {} };
  });
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };

  controller.terminalSessionFor();
  await actions.insertText('echo "hello"');
  await actions.copyText("key sentence");

  assert.deepEqual(commands, [
    'input insert "echo \\"hello\\""',
    'clipboard copy "key sentence"'
  ]);
});



test("terminal sessions receive file and URL mini-preview actions", async () => {
  let actions;
  const calls = [];
  const backend = {
    isNative: true,
    inspectFile: async (path) => ({ path, name: "test.png", kind: "image", mime: "image/png" }),
    createFileView: async (path) => ({ url: `http://localhost:8890${path}?view=1`, resourceUrl: `http://localhost:8890${path}`, title: "test.png", filePath: path, mime: "text/html", viewerKind: "image" }),
    releaseFileView: (url) => calls.push(["release", url])
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: (_backend, receivedActions) => {
      actions = receivedActions;
      return { initialize: async () => {} };
    }
  });
  const commands = [];
  controller.runInternal = async (command, options) => { commands.push([command, options]); };

  controller.terminalSessionFor();
  const filePreview = await actions.preparePreview({ kind: "file", value: "/tmp/test.png", text: "/tmp/test.png" });
  const webPreview = await actions.preparePreview({ kind: "url", value: "https://example.com/page", text: "https://example.com/page" });
  await actions.openPreview({ kind: "file", value: "/tmp/test.png" });
  await actions.openPreview({ kind: "url", value: "https://example.com/page" });
  actions.releasePreview(filePreview);

  assert.equal(filePreview.url, "http://localhost:8890/tmp/test.png?view=1");
  assert.equal(filePreview.viewerKind, "image");
  assert.equal(filePreview.resourceUrl, "http://localhost:8890/tmp/test.png");
  assert.equal(webPreview.url, "https://example.com/page");
  assert.equal(webPreview.title, "example.com");
  assert.deepEqual(commands, [
    ['file open "/tmp/test.png"', { fileOpenMode: "new" }],
    ["subtab new webview", undefined],
    ['web open "https://example.com/page"', undefined]
  ]);
  assert.deepEqual(calls, [["release", "http://localhost:8890/tmp/test.png?view=1"]]);
});
test("platform copy prefers the native backend clipboard writer", async () => {
  const copied = [];
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
      writeClipboardText: async (text) => copied.push(text)
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.context().actions.copyText("native text");

  assert.deepEqual(copied, ["native text"]);
});

test("completed Live replies without stream events use the static structured renderer", () => {
  const calls = [];
  const session = {
    initialize: async () => {},
    printAssistant: (name, text, audio) => calls.push({ name, text, audio })
  };
  const controller = createController(() => session);

  controller.finishWakeLiveResult({ text: "Finished response", streamedAudio: true }, { name: "Gemini Live" });

  assert.deepEqual(calls, [{
    name: "Gemini Live",
    text: "Finished response",
    audio: null
  }]);
});

test("Live cumulative text streams plain text and completed tagged blocks without replay", () => {
  const calls = [];
  const session = {
    initialize: async () => {},
    beginAssistantStream: (name) => calls.push(["begin", name]),
    appendAssistantStream: (text) => calls.push(["text", text]),
    endAssistantStream: () => calls.push(["end"])
  };
  const controller = createController(() => session);
  const model = { name: "Gemini Live" };

  controller.handleWakeStreamText("Run ", model);
  controller.handleWakeStreamText("Run <i>npm", model);
  controller.handleWakeStreamText("Run <i>npm test</i> now", model);

  assert.deepEqual(calls, [
    ["begin", "Gemini Live"],
    ["text", "Run "],
    ["text", "npm"],
    ["text", " test"],
    ["text", " now"]
  ]);

  controller.finishWakeLiveResult({
    text: "Run <i>npm test</i> now",
    streamedAudio: true
  }, model);

  assert.deepEqual(calls, [
    ["begin", "Gemini Live"],
    ["text", "Run "],
    ["text", "npm"],
    ["text", " test"],
    ["text", " now"],
    ["end"]
  ]);
});

test("Live finalization streams a final suffix before ending", () => {
  const calls = [];
  const session = {
    initialize: async () => {},
    beginAssistantStream: () => calls.push(["begin"]),
    appendAssistantStream: (text) => calls.push(["text", text]),
    endAssistantStream: () => calls.push(["end"])
  };
  const controller = createController(() => session);
  const model = { name: "Gemi Live" };

  controller.handleWakeStreamText("Hello", model);
  controller.finishWakeLiveResult({ text: "Hello world", streamedAudio: true }, model);

  assert.deepEqual(calls, [
    ["begin"],
    ["text", "Hello"],
    ["text", " world"],
    ["end"]
  ]);
});
