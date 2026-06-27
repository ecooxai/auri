import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppController } from "../src/controllers/app-controller.js";
import { executeCommand } from "../src/controllers/command-controller.js";
import { createInitialState } from "../src/model/state.js";
import { Backend } from "../src/services/backend.js";
import { renderSettings } from "../src/views/panels.js";

function controllerHarness(backend = {}) {
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  return new AppController({
    view,
    backend: { isNative: true, ...backend },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
}

test("settings show media permission status before assistant models", () => {
  const state = createInitialState();
  state.permissions = { microphone: "authorized", screenRecording: "denied" };

  const html = renderSettings(state);
  const permissionsIndex = html.indexOf("Privacy permissions");
  const modelsIndex = html.indexOf("Assistant models");

  assert.ok(permissionsIndex >= 0 && permissionsIndex < modelsIndex);
  assert.match(html, /data-permission="microphone"[\s\S]*Microphone[\s\S]*permission-check/);
  assert.match(html, /data-permission="screenRecording"[\s\S]*Screen &amp; System Audio Recording[\s\S]*data-action="permission-request"/);
  assert.match(html, /data-action="permission-request"[^>]*data-permission="screenRecording"[^>]*>Open Settings<\/button>/);
  assert.doesNotMatch(html, /data-action="permission-request"[^>]*data-permission="microphone"/);
});

test("not-determined permission uses a Request button", () => {
  const state = createInitialState();
  state.permissions = { microphone: "notDetermined", screenRecording: "authorized" };

  const html = renderSettings(state);

  assert.match(html, /data-action="permission-request"[^>]*data-permission="microphone"[^>]*>Request<\/button>/);
  assert.match(html, /data-permission="screenRecording"[\s\S]*permission-check/);
});

test("backend exposes native media permission commands", async () => {
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command, payload) => {
    calls.push([command, payload]);
    return { microphone: "authorized", screenRecording: "authorized" };
  };

  await backend.getMediaPermissions();
  await backend.requestMediaPermission("microphone");

  assert.deepEqual(calls, [
    ["media_permission_status", {}],
    ["request_media_permission", { permission: "microphone" }]
  ]);
});

test("requesting a permission refreshes controller state", async () => {
  const calls = [];
  const controller = controllerHarness({
    getMediaPermissions: async () => ({ microphone: "notDetermined", screenRecording: "authorized" }),
    requestMediaPermission: async (permission) => {
      calls.push(permission);
      return { microphone: "authorized", screenRecording: "authorized" };
    }
  });

  await controller.refreshMediaPermissions();
  assert.deepEqual(controller.state.permissions, { microphone: "notDetermined", screenRecording: "authorized" });

  await controller.handleClick({
    target: { closest: () => ({ dataset: { action: "permission-request", permission: "microphone" } }) },
    preventDefault() {}
  });

  assert.deepEqual(calls, ["microphone"]);
  assert.deepEqual(controller.state.permissions, { microphone: "authorized", screenRecording: "authorized" });
});

test("macOS bundle declares why Auri needs microphone access", async () => {
  const plist = await readFile("src-tauri/Info.plist", "utf8");
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(plist, /voice|microphone|record/i);
});

test("permission commands delegate status and requests through the shared action layer", async () => {
  let state = createInitialState();
  const calls = [];
  const context = {
    backend: {},
    getState: () => state,
    dispatch: (event) => { state = { ...state, lastEvent: event }; },
    actions: {
      refreshMediaPermissions: async () => { calls.push(["status"]); return { microphone: "authorized" }; },
      requestMediaPermission: async (permission) => { calls.push(["request", permission]); return { [permission]: "authorized" }; }
    }
  };

  await executeCommand("permission status", context);
  await executeCommand("permission request microphone", context);
  await executeCommand("permission request screen-recording", context);

  assert.deepEqual(calls, [
    ["status"],
    ["request", "microphone"],
    ["request", "screenRecording"]
  ]);
});

test("permission request button routes through the command layer", async () => {
  const controller = controllerHarness();
  const commands = [];
  controller.runInternal = async (command) => { commands.push(command); };

  await controller.handleClick({
    target: { closest: () => ({ dataset: { action: "permission-request", permission: "screenRecording" } }) },
    preventDefault() {}
  });

  assert.deepEqual(commands, ["permission request screen-recording"]);
});
