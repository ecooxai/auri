import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "../src/controllers/command-controller.js";
import { AppController } from "../src/controllers/app-controller.js";
import { createInitialState, reduceState } from "../src/model/state.js";
import { renderTerminal } from "../src/views/panels.js";

function commandHarness() {
  let state = createInitialState();
  return {
    backend: {},
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); },
    state: () => state
  };
}

function controllerHarness() {
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  return new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
}

test("terminal composer places a hold-to-talk microphone immediately before Ask", () => {
  const state = createInitialState();
  const html = renderTerminal(state);
  const micIndex = html.indexOf('data-action="live-record"');
  const askIndex = html.indexOf('data-action="terminal-ask"');

  assert.notEqual(micIndex, -1);
  assert.ok(micIndex < askIndex);
  assert.match(html, /class="icon-button live-mic-button"/);
  assert.match(html, /aria-label="Click to connect or hold one second to talk"/);
  assert.match(html, /aria-pressed="false"/);
});

test("microphone renders a recording indicator only while Live is connected and recording", () => {
  const state = createInitialState();
  state.ui.liveConnected = true;
  state.ui.liveRecording = true;
  const active = renderTerminal(state);
  assert.match(active, /live-mic-button is-recording/);
  assert.match(active, /aria-label="Recording — release to send or click to disconnect"/);
  assert.match(active, /aria-pressed="true"/);
  assert.match(active, /live-recording-glyph/);

  state.ui.liveRecording = false;
  const stopped = renderTerminal(state);
  assert.doesNotMatch(stopped, /live-mic-button is-recording/);
  assert.doesNotMatch(stopped, /live-recording-glyph/);
});

test("live record commands delegate start and stop through the command context", async () => {
  const h = commandHarness();
  const calls = [];
  h.actions = {
    startLiveRecording: async () => { calls.push("start"); },
    stopLiveRecording: async () => { calls.push("stop"); },
    toggleLiveRecording: async () => { calls.push("toggle"); }
  };

  await executeCommand("live record start", h);
  await executeCommand("live record stop", h);
  await executeCommand("live record toggle", h);

  assert.deepEqual(calls, ["start", "stop", "toggle"]);
});

test("Live status returns the microphone to idle when recording stops or disconnects", () => {
  const controller = controllerHarness();

  controller.handleWakeStatus("recording");
  controller.handleWakeStatus("connecting");
  controller.handleWakeStatus("connected");
  assert.equal(controller.state.ui.liveConnected, true);
  assert.equal(controller.state.ui.liveRecording, true);

  controller.handleWakeStatus("processing");
  assert.equal(controller.state.ui.liveConnected, true);
  assert.equal(controller.state.ui.liveRecording, false);

  controller.handleWakeStatus("disconnected");
  assert.equal(controller.state.ui.liveConnected, false);
  assert.equal(controller.state.ui.liveRecording, false);
});

test("short microphone press toggles the persistent Live session", async () => {
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  const button = { dataset: { action: "live-record" }, setPointerCapture() {} };

  await controller.handleLiveRecordPointerDown({
    button: 0,
    pointerId: 7,
    target: { closest: () => button },
    preventDefault() {}
  });
  await controller.handleLiveRecordPointerEnd({ type: "pointerup", pointerId: 7, preventDefault() {} });

  assert.deepEqual(commands, ["live record toggle"]);
});


test("one-second microphone hold starts push-to-talk and release sends it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };
  const button = { dataset: { action: "live-record" }, setPointerCapture() {} };

  await controller.handleLiveRecordPointerDown({
    button: 0,
    pointerId: 9,
    target: { closest: () => button },
    preventDefault() {}
  });
  t.mock.timers.tick(999);
  assert.deepEqual(commands, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(commands, ["live record start"]);

  await controller.handleLiveRecordPointerEnd({ type: "pointerup", pointerId: 9, preventDefault() {} });
  assert.deepEqual(commands, ["live record start", "live record stop"]);
});


test("click toggle disconnects an existing Live session and reports disconnected status", async () => {
  const toasts = [];
  const controller = controllerHarness();
  controller.view.showToast = (message) => toasts.push(message);
  let cancelled = false;
  controller.wakeLiveSession = {
    cancel: async () => {
      cancelled = true;
      controller.handleWakeStatus("disconnected");
    }
  };
  controller.state.ui.liveConnected = true;
  controller.state.ui.liveRecording = true;

  await controller.toggleLiveRecording();

  assert.equal(cancelled, true);
  assert.equal(controller.wakeLiveSession, null);
  assert.equal(controller.state.ui.liveConnected, false);
  assert.equal(controller.state.ui.liveRecording, false);
  assert.match(toasts.at(-1), /Live chat disconnected/i);
});
