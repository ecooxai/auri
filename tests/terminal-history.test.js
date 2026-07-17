import test from "node:test";
import assert from "node:assert/strict";
import {
  countRecordLines,
  replayStartIndex,
  TERMINAL_RENDER_TAIL_LINES,
  TerminalSession
} from "../src/services/terminal-session.js";
import { serializeAppSnapshot } from "../src/model/snapshot.js";
import { createInitialState } from "../src/model/state.js";

const encoder = new TextEncoder();
const bytes = (text) => ({ type: "bytes", bytes: encoder.encode(text) });

test("terminal replay starts at the record that covers the last N lines", () => {
  const records = [
    bytes(Array.from({ length: 80 }, (_, i) => `old ${i}\n`).join("")),
    { type: "media", item: { id: "m1" } },
    bytes(Array.from({ length: 60 }, (_, i) => `mid ${i}\n`).join("")),
    bytes(Array.from({ length: 50 }, (_, i) => `new ${i}\n`).join(""))
  ];
  assert.equal(TERMINAL_RENDER_TAIL_LINES, 100);
  // 50 + 60 lines ≥ 100 → replay starts at the "mid" record; older records
  // stay stored but unrendered.
  assert.equal(replayStartIndex(records, 100), 2);
  assert.equal(replayStartIndex(records, 200), 0, "a big budget replays everything");
  assert.equal(replayStartIndex([], 100), 0);
  assert.equal(countRecordLines(records.slice(0, 2)), 80, "media records count no lines");
});

test("a session replays only the tail on mount and can expand toward older history", () => {
  const session = new TerminalSession({ isNative: false }, {});
  for (let index = 0; index < 300; index += 1) {
    session.remember(bytes(`history line ${index}\r\n`));
  }
  const start = replayStartIndex(session.output, TERMINAL_RENDER_TAIL_LINES);
  assert.equal(session.output.length - start, TERMINAL_RENDER_TAIL_LINES);

  // Expanding the budget doubles the window while the records stay stored.
  session.renderLineBudget = TERMINAL_RENDER_TAIL_LINES;
  session.renderedFromIndex = start;
  const expanded = replayStartIndex(session.output, session.renderLineBudget * 2);
  assert.ok(expanded < start, "the expanded window reaches older records");
  assert.equal(session.output.length, 300, "full history remains stored");
});

test("the app snapshot carries each terminal's grid size for shared-PTY clients", () => {
  const state = createInitialState();
  const workspace = state.tabs[0];
  const terminal = workspace.subtabs.find((subtab) => subtab.type === "terminal");
  const snapshot = serializeAppSnapshot(state, {
    terminalBuffers: {
      [terminal.id]: { sessionId: "session-9", text: "hello\r\n", cols: 120, rows: 32 }
    }
  });
  const buffer = snapshot.terminals[terminal.id];
  assert.equal(buffer.sessionId, "session-9");
  assert.equal(buffer.cols, 120);
  assert.equal(buffer.rows, 32);
});
