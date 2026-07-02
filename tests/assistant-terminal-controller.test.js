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
