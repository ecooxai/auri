import test from "node:test";
import assert from "node:assert/strict";
import { AssistantStreamParser, assistantPlainText, parseAssistantReply, escapeHtml, terminalAssistantSegments } from "../src/model/assistant.js";

test("extracts command and input-ready actions from allowlisted tags", () => {
  const parsed = parseAssistantReply("Run <cmd>npm test</cmd> then enter <i>ship the release</i>.");
  assert.deepEqual(parsed.actions, [
    { kind: "command", text: "npm test" },
    { kind: "insert", text: "ship the release" }
  ]);
  assert.deepEqual(parsed.transcripts, ["ship the release"]);
  assert.equal(parsed.text, "Run  then enter .");
});

test("supports multiple actions and leaves arbitrary markup as escaped prose", () => {
  const parsed = parseAssistantReply("<cmd>npm test</cmd><i>key point</i><b>done</b>");
  assert.deepEqual(parsed.actions, [
    { kind: "command", text: "npm test" },
    { kind: "insert", text: "key point" }
  ]);
  assert.equal(parsed.text, "<b>done</b>");
  assert.equal(escapeHtml(parsed.text), "&lt;b&gt;done&lt;/b&gt;");
});

test("preserves ordered plain and tagged reply segments for extraction", () => {
  const parsed = parseAssistantReply("Before<cmd>npm test</cmd>After <i>important sentence</i>Done");
  assert.deepEqual(parsed.segments, [
    { kind: "text", text: "Before" },
    { kind: "command", text: "npm test" },
    { kind: "text", text: "After " },
    { kind: "insert", text: "important sentence" },
    { kind: "text", text: "Done" }
  ]);
});

test("drops empty allowlisted tags without losing surrounding text", () => {
  const parsed = parseAssistantReply("alpha<cmd> </cmd>beta<i>   </i>gamma");
  assert.deepEqual(parsed.actions, []);
  assert.deepEqual(parsed.segments, [
    { kind: "text", text: "alpha" },
    { kind: "text", text: "beta" },
    { kind: "text", text: "gamma" }
  ]);
});

test("terminal replies remove cmd and i markers but keep their contents as normal text", () => {
  assert.equal(assistantPlainText("Before<cmd>npm test</cmd><i>done</i>After"), "Beforenpm testdoneAfter");
  assert.deepEqual(terminalAssistantSegments("Before <cmd>npm test</cmd> <i>done</i> After"), [
    { kind: "text", text: "Before npm test done After" }
  ]);
  assert.deepEqual(terminalAssistantSegments("Before\n<cmd>npm test</cmd>\nAfter"), [
    { kind: "text", text: "Before\r\nnpm test\r\nAfter" }
  ]);
});

test("streams cmd and i contents as plain text while buffering split tag boundaries", () => {
  const parser = new AssistantStreamParser();
  assert.deepEqual(parser.push("Run <c"), [{ kind: "text", text: "Run " }]);
  assert.deepEqual(parser.push("md>npm"), [{ kind: "text", text: "npm" }]);
  assert.deepEqual(parser.push(" test</cm"), [{ kind: "text", text: " test" }]);
  assert.deepEqual(parser.push("d> then <i>go</i>"), [
    { kind: "text", text: " then " },
    { kind: "text", text: "go" }
  ]);
});

test("streams multiple completed tagged blocks as ordinary text", () => {
  const parser = new AssistantStreamParser();
  assert.deepEqual(parser.push("A <cmd>one</cmd> B <i>two</i> C"), [
    { kind: "text", text: "A " },
    { kind: "text", text: "one" },
    { kind: "text", text: " B " },
    { kind: "text", text: "two" },
    { kind: "text", text: " C" }
  ]);
});

test("incomplete allowlisted markup still renders its contents exactly once", () => {
  const parser = new AssistantStreamParser();
  assert.deepEqual(parser.push("Run <cmd>npm test"), [
    { kind: "text", text: "Run " },
    { kind: "text", text: "npm test" }
  ]);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.finish(), []);
});
