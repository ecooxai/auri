import test from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/controllers/app-controller.js";

function makeHarness({ isNative = true, session = null } = {}) {
  const syncs = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative,
    syncAppState: async (json) => { syncs.push(json); }
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => session || { initialize: async () => {} },
    stateSyncDelayMs: 5
  });
  return { controller, syncs };
}

function waitFor(condition, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("Timed out waiting for condition."));
      setTimeout(check, 5);
    };
    check();
  });
}

test("dispatch pushes a debounced single-line JSON snapshot to the native backend", async () => {
  const { controller, syncs } = makeHarness();
  controller.dispatch({ type: "TAB_NEW", payload: { title: "Research" } });
  controller.dispatch({ type: "TAB_NEW", payload: { title: "Extra" } });

  await waitFor(() => syncs.length >= 1);
  const snapshot = JSON.parse(syncs.at(-1));
  assert.ok(!syncs.at(-1).includes("\n"));
  assert.equal(snapshot.workspaces.length, 3);
  assert.ok(snapshot.seq >= 1);
  assert.equal(snapshot.workspaces.at(-1).title, "Extra");
});

test("terminal output schedules a sync and the snapshot carries the session buffer", async () => {
  const fakeSession = {
    sessionId: "native-session-9",
    initialize: async () => {},
    bufferText: () => "replayable output",
    onOutput: null
  };
  const { controller, syncs } = makeHarness({ session: fakeSession });
  controller.terminalSessionFor();
  assert.equal(typeof fakeSession.onOutput, "function", "controller wires the output hook");

  fakeSession.onOutput();
  await waitFor(() => syncs.length >= 1);
  const snapshot = JSON.parse(syncs.at(-1));
  const terminalId = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal").id;
  assert.equal(snapshot.terminals[terminalId].sessionId, "native-session-9");
  assert.equal(snapshot.terminals[terminalId].text, "replayable output");
});

test("browser preview does not push snapshots", async () => {
  const { controller, syncs } = makeHarness({ isNative: false });
  controller.dispatch({ type: "TAB_NEW", payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(syncs.length, 0);
});

test("SYSTEM_SNAPSHOT_TRIM drops the heavy process and gpu lists but keeps the metrics", async () => {
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: {
      snapshot: {
        cpu: { brand: "M4", cores: 10, usagePercent: 4 },
        memory: { totalBytes: 16, usedBytes: 8 },
        processes: [{ pid: 1, name: "chrome" }],
        gpus: [{ name: "GPU" }]
      }
    }
  });
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_TRIM" });
  assert.equal(state.system.snapshot.processes.length, 0);
  assert.equal(state.system.snapshot.gpus.length, 0);
  assert.equal(state.system.snapshot.cpu.brand, "M4");
});

test("leaving the system monitor trims the retained process list from app state", async () => {
  const { activeSubtab } = await import("../src/model/state.js");
  const { controller } = makeHarness();
  const terminalId = controller.state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal").id;
  controller.dispatch({ type: "SUBTAB_NEW", payload: { type: "system" } });
  assert.equal(activeSubtab(controller.state).type, "system");
  controller.dispatch({
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: { memory: { usedBytes: 1 }, processes: [{ pid: 7, name: "node" }], gpus: [] } }
  });
  assert.equal(controller.state.system.snapshot.processes.length, 1, "visible monitor keeps the full list");

  controller.dispatch({ type: "SUBTAB_SELECT", payload: { id: terminalId } });
  assert.equal(controller.state.system.snapshot.processes.length, 0, "background monitor keeps metrics only");
  assert.equal(controller.state.system.snapshot.memory.usedBytes, 1);
});

test("TerminalSession notifies the output hook when new bytes are recorded", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const session = new TerminalSession({ isNative: false }, {});
  let notified = 0;
  session.onOutput = () => { notified += 1; };
  session.appendRecord({ type: "bytes", bytes: new TextEncoder().encode("data") });
  assert.equal(notified, 1);
});

test("TerminalSession keeps an incrementally decoded tail instead of re-decoding all records", async () => {
  const { TerminalSession, TERMINAL_TAIL_MAX_CHARS } = await import("../src/services/terminal-session.js");
  const encoder = new TextEncoder();
  const session = new TerminalSession({ isNative: false }, {});

  session.appendRecord({ type: "bytes", bytes: encoder.encode("first ") });
  session.appendRecord({ type: "bytes", bytes: encoder.encode("second") });
  assert.equal(session.bufferText(), "first second");

  // A multi-byte character split across two records must decode correctly.
  const euro = encoder.encode("€");
  session.appendRecord({ type: "bytes", bytes: euro.slice(0, 1) });
  session.appendRecord({ type: "bytes", bytes: euro.slice(1) });
  assert.equal(session.bufferText().endsWith("second€"), true);

  // The tail stays bounded no matter how much output arrives.
  session.appendRecord({ type: "bytes", bytes: encoder.encode("x".repeat(TERMINAL_TAIL_MAX_CHARS + 500)) });
  assert.equal(session.bufferText().length, TERMINAL_TAIL_MAX_CHARS);
  assert.equal(session.bufferText().endsWith("x"), true);
});
