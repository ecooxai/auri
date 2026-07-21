import test from "node:test";
import assert from "node:assert/strict";
import { terminalLineAtCursor } from "../src/model/terminal-input.js";

test("terminalLineAtCursor selects the caret line and its removable newline", () => {
  const value = "echo first\necho current\necho last";

  assert.deepEqual(terminalLineAtCursor(value, "echo first\necho cur".length), {
    text: "echo current",
    start: 11,
    end: 23,
    removeStart: 11,
    removeEnd: 24
  });
  assert.deepEqual(terminalLineAtCursor(value, value.length), {
    text: "echo last",
    start: 24,
    end: 33,
    removeStart: 23,
    removeEnd: 33
  });
});
