import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/services/backend.js";

test("assistant prompt defines distinct command and input-ready markers", () => {
  assert.match(SYSTEM_PROMPT, /<cmd>.*<\/cmd>/s);
  assert.match(SYSTEM_PROMPT, /shell command/i);
  assert.match(SYSTEM_PROMPT, /<i>.*<\/i>/s);
  assert.match(SYSTEM_PROMPT, /important|input-ready/i);
  assert.match(SYSTEM_PROMPT, /one complete item/i);
  assert.match(SYSTEM_PROMPT, /do not nest/i);
  assert.match(SYSTEM_PROMPT, /arbitrary HTML/i);
});

test("Live prompt only echoes speech for explicit dictation or voice input", () => {
  assert.match(LIVE_SYSTEM_PROMPT, /explicitly asks/i);
  assert.match(LIVE_SYSTEM_PROMPT, /dictation|dictate/i);
  assert.match(LIVE_SYSTEM_PROMPT, /voice input/i);
  assert.match(LIVE_SYSTEM_PROMPT, /<i>.*<\/i>/s);
  assert.match(LIVE_SYSTEM_PROMPT, /otherwise[^.]*do not[^.]*repeat/i);
  assert.match(LIVE_SYSTEM_PROMPT, /<cmd>.*<\/cmd>/s);
});
