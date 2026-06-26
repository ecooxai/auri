import test from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/controllers/app-controller.js";
import { executeCommand } from "../src/controllers/command-controller.js";
import { createInitialState, reduceState } from "../src/model/state.js";
import { renderAssistantTranscriptPopup } from "../src/views/panels.js";

function controllerHarness({ reply = "Done" } = {}) {
  const calls = [];
  const session = {
    initialize: async () => {},
    printUser: (text) => calls.push(["user", text]),
    printAssistant: (name, text, audio) => calls.push(["assistant", name, text, audio]),
    beginAssistantStream: (name) => calls.push(["begin", name]),
    appendAssistantStream: (text) => calls.push(["text", text]),
    endAssistantStream: () => calls.push(["end"]),
    printMedia: (items) => calls.push(["media", items])
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: false,
    askAi: async () => ({ text: reply })
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => session });
  return { controller, calls };
}

test("assistant action popup is compact and gives command rows Copy, Insert, and Run", () => {
  const state = createInitialState();
  state.ui.assistantActions = [
    { kind: "command", text: 'echo "hello"' },
    { kind: "insert", text: "important sentence" }
  ];

  const html = renderAssistantTranscriptPopup(state);

  assert.match(html, /class="assistant-transcript-popup assistant-action-popup"/);
  assert.equal((html.match(/class="assistant-transcript-row/g) || []).length, 2);
  assert.doesNotMatch(html, />COMMAND</);
  assert.doesNotMatch(html, />TEXT</);
  assert.match(html, /data-action="copy-text" data-value="echo &quot;hello&quot;"/);
  assert.match(html, /data-action="assistant-insert" data-value="echo &quot;hello&quot;"/);
  assert.match(html, /data-action="assistant-run" data-value="echo &quot;hello&quot;"/);
  assert.match(html, /data-action="assistant-insert" data-value="important sentence"/);
  assert.match(html, /data-action="transcript-dismiss"/);
});

test("normal AI completion shows extracted actions only after the reply completes", async () => {
  const reply = "Run <cmd>npm test</cmd> and remember <i>tests passed</i>.";
  const { controller, calls } = controllerHarness({ reply });

  assert.deepEqual(controller.state.ui.assistantActions, []);
  await controller.runInternal("ai ask verify the project");

  assert.deepEqual(controller.state.ui.assistantActions, [
    { kind: "command", text: "npm test" },
    { kind: "insert", text: "tests passed" }
  ]);
  assert.deepEqual(calls.find((entry) => entry[0] === "assistant"), [
    "assistant",
    "Gemini Live",
    reply,
    null
  ]);
});

test("Live streaming stays plain and opens the action popup only at final completion", () => {
  const { controller, calls } = controllerHarness();
  const model = { name: "Gemini Live" };

  controller.handleWakeStreamText("Use <cmd>npm", model);
  controller.handleWakeStreamText("Use <cmd>npm test</cmd> then <i>done</i>", model);
  assert.deepEqual(controller.state.ui.assistantActions, []);

  controller.finishWakeLiveResult({ text: "Use <cmd>npm test</cmd> then <i>done</i>", streamedAudio: true }, model);

  assert.deepEqual(controller.state.ui.assistantActions, [
    { kind: "command", text: "npm test" },
    { kind: "insert", text: "done" }
  ]);
  assert.deepEqual(calls.filter((entry) => entry[0] === "text"), [
    ["text", "Use "],
    ["text", "npm"],
    ["text", " test"],
    ["text", " then "],
    ["text", "done"]
  ]);
});

test("transcript dismiss clears all assistant actions through the command layer", async () => {
  let state = createInitialState();
  state = reduceState(state, { type: "UI_SET", payload: {
    assistantActions: [{ kind: "insert", text: "hello" }],
    assistantTranscripts: ["legacy"]
  } });
  const context = {
    backend: {},
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); }
  };

  await executeCommand("transcript dismiss", context);

  assert.deepEqual(state.ui.assistantActions, []);
  assert.deepEqual(state.ui.assistantTranscripts, []);
});

test("popup actions use existing command paths and preserve shell syntax", async () => {
  const { controller } = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  const click = (action, value) => controller.handleClick({
    target: { closest: () => ({ dataset: { action, value } }) },
    preventDefault() {}
  });

  await click("copy-text", 'echo "hello"');
  await click("assistant-insert", 'echo "hello"');
  await click("assistant-run", 'printf "%s\\n" "hello world"');

  assert.deepEqual(commands, [
    'clipboard copy "echo \\"hello\\""',
    'input insert "echo \\"hello\\""',
    'terminal run printf "%s\\n" "hello world"'
  ]);
});


test("Escape dismisses assistant actions through the command layer", async () => {
  const { controller } = controllerHarness();
  controller.state.ui.assistantActions = [{ kind: "command", text: "npm test" }];
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  let prevented = false;

  await controller.handleGlobalKeydown({
    key: "Escape",
    code: "Escape",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    preventDefault() { prevented = true; }
  });

  assert.equal(prevented, true);
  assert.deepEqual(commands, ["transcript dismiss"]);
});

test("clicking outside the assistant action popup dismisses it", async () => {
  const { controller } = controllerHarness();
  controller.state.ui.assistantActions = [{ kind: "command", text: "npm test" }];
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };

  await controller.handleClick({
    target: { closest: () => null },
    preventDefault() {}
  });

  assert.deepEqual(commands, ["transcript dismiss"]);
});
