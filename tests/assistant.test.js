import test from "node:test";
import assert from "node:assert/strict";
import { parseAssistantReply, escapeHtml } from "../src/model/assistant.js";

test("extracts spoken-input echoes from i tags", () => {
  const parsed = parseAssistantReply("<i>open the project</i>\nI opened it.");
  assert.equal(parsed.transcripts[0], "open the project");
  assert.equal(parsed.text, "I opened it.");
});

test("supports multiple transcript lines and escapes markup", () => {
  const parsed = parseAssistantReply("<i>one</i><i>two</i><b>done</b>");
  assert.deepEqual(parsed.transcripts, ["one", "two"]);
  assert.equal(parsed.text, "<b>done</b>");
  assert.equal(escapeHtml(parsed.text), "&lt;b&gt;done&lt;/b&gt;");
});
