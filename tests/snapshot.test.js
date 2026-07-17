import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState } from "../src/model/state.js";
import { appSnapshotJson, serializeAppSnapshot, TERMINAL_BUFFER_MAX_CHARS } from "../src/model/snapshot.js";

function stateWithSystemSnapshot() {
  let state = createInitialState();
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: {
      snapshot: {
        capturedAt: "2026-07-16T00:00:00.000Z",
        host: { os: "macOS", arch: "arm64", hostname: "mini", uptimeSeconds: 42 },
        cpu: { brand: "Apple M4", cores: 10, usagePercent: 12.5 },
        memory: { totalBytes: 16e9, usedBytes: 8e9, freeBytes: 8e9, usagePercent: 50 },
        network: { interfaces: [], downloadBytesPerSecond: 100, uploadBytesPerSecond: 50, totalRxBytes: 0, totalTxBytes: 0 },
        disk: { mounts: [], totalBytes: 1e12, usedBytes: 5e11, freeBytes: 5e11, usagePercent: 50, readBytesPerSecond: 1, writeBytesPerSecond: 2 },
        gpus: [],
        processes: [
          { pid: 10, name: "chrome", cpuPercent: 5, memoryBytes: 300, ports: [] },
          { pid: 11, name: "node server", cpuPercent: 1, memoryBytes: 900, ports: [3000] },
          { pid: 12, name: "node worker", cpuPercent: 9, memoryBytes: 100, ports: [] }
        ]
      }
    }
  });
  return state;
}

test("snapshot captures workspaces, subtabs, and terminal state", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "TAB_NEW", payload: { title: "Research" } });
  state = reduceState(state, { type: "TERMINAL_COMMAND_REMEMBER", payload: { command: "ls -la" } });
  const snapshot = serializeAppSnapshot(state, { seq: 7 });

  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.seq, 7);
  assert.equal(snapshot.workspaces.length, 2);
  assert.equal(snapshot.activeTabId, state.activeTabId);
  const active = snapshot.workspaces.find((workspace) => workspace.active);
  assert.equal(active.title, "Research");
  assert.equal(active.activeSubtabId, state.tabs[1].activeSubtabId);
  assert.deepEqual(active.terminal.commandHistory.slice(0, 1), ["ls -la"]);
  assert.ok(active.subtabs.every((subtab) => typeof subtab.id === "string" && typeof subtab.type === "string"));
  const terminalSubtab = active.subtabs.find((subtab) => subtab.type === "terminal");
  assert.equal(terminalSubtab.cwd, "~");
});

test("snapshot passes terminal buffers through and keeps only the tail beyond the cap", () => {
  const state = createInitialState();
  const terminalId = state.tabs[0].subtabs.find((subtab) => subtab.type === "terminal").id;
  const long = `${"x".repeat(TERMINAL_BUFFER_MAX_CHARS)}TAIL-MARKER`;
  const snapshot = serializeAppSnapshot(state, {
    terminalBuffers: { [terminalId]: { sessionId: "session-1", text: long } }
  });
  const buffer = snapshot.terminals[terminalId];
  assert.equal(buffer.sessionId, "session-1");
  assert.equal(buffer.text.length, TERMINAL_BUFFER_MAX_CHARS);
  assert.ok(buffer.text.endsWith("TAIL-MARKER"));
});

test("snapshot sorts and filters the full process list before slicing", () => {
  let state = stateWithSystemSnapshot();
  state = reduceState(state, { type: "SYSTEM_FILTER_SET", payload: { filter: "node" } });
  state = reduceState(state, { type: "SYSTEM_SORT_SET", payload: { sortBy: "ram" } });
  const snapshot = serializeAppSnapshot(state, { processLimit: 1 });

  assert.equal(snapshot.system.processCount, 2);
  assert.equal(snapshot.system.processes.length, 1);
  assert.equal(snapshot.system.processes[0].pid, 11);
  assert.equal(snapshot.system.sortBy, "ram");
  assert.equal(snapshot.system.filter, "node");
  assert.equal(snapshot.system.metrics.hostname, "mini");
  assert.equal(snapshot.system.metrics.cpuUsagePercent, 12.5);
});

test("snapshot json is a single line and round-trips", () => {
  const state = stateWithSystemSnapshot();
  const json = appSnapshotJson(state, {
    seq: 3,
    terminalBuffers: { any: { sessionId: "s", text: "line1\r\nline2[31mred[0m" } }
  });
  assert.ok(!json.includes("\n"));
  const parsed = JSON.parse(json);
  assert.equal(parsed.seq, 3);
  assert.equal(parsed.terminals.any.text, "line1\r\nline2[31mred[0m");
});

test("snapshot lists clipboard items with the 100+50 preview rule and image metadata", () => {
  let state = createInitialState();
  const long = `${"a".repeat(120)}${"b".repeat(120)}`;
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: {
      items: [
        { id: "c1", kind: "text", text: long, pinned: true, createdAt: 1 },
        { id: "c2", kind: "image", path: "/tmp/shot.png", width: 800, height: 600, byteSize: 2048, createdAt: 2 }
      ]
    }
  });
  const snapshot = serializeAppSnapshot(state);
  assert.equal(snapshot.clipboard.count, 2);
  const [text, image] = snapshot.clipboard.items;
  assert.equal(text.id, "c1");
  assert.equal(text.pinned, true);
  assert.ok(text.preview.length < 160, "long text is truncated for the snapshot");
  assert.ok(text.preview.startsWith("a".repeat(100)));
  assert.ok(text.preview.endsWith("b".repeat(50)));
  assert.equal(image.kind, "image");
  assert.match(image.preview, /PNG · 800×600/);
});

test("snapshot carries recent info items and clipboard count without full payloads", () => {
  let state = createInitialState();
  for (let index = 0; index < 40; index += 1) {
    state = reduceState(state, { type: "INFO_ADD", payload: { title: `Note ${index}`, message: "m", level: "info" } });
  }
  state = reduceState(state, { type: "CLIPBOARD_SET", payload: { items: [{ id: "c1" }, { id: "c2" }] } });
  const snapshot = serializeAppSnapshot(state);
  assert.equal(snapshot.info.unread, 40);
  assert.equal(snapshot.info.items.length, 30);
  assert.equal(snapshot.info.items[0].title, "Note 39");
  assert.equal(snapshot.clipboard.count, 2);
});
