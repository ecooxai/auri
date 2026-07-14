import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, commandHelp, extractCommandTail, extractActionTail } from "../src/model/commands.js";

test("accepts both public auri prefix and internal command form", () => {
  assert.deepEqual(parseCommand("auri tab new"), { domain: "tab", action: "new", args: [] });
  assert.deepEqual(parseCommand("tab new"), { domain: "tab", action: "new", args: [] });
});

test("preserves quoted arguments and terminal command tails", () => {
  assert.deepEqual(parseCommand('settings set theme "aurora light"'), {
    domain: "settings", action: "set", args: ["theme", "aurora light"]
  });
  assert.deepEqual(parseCommand("terminal run printf '%s %s' hello world"), {
    domain: "terminal", action: "run", args: ["printf", "%s %s", "hello", "world"]
  });
});

test("rejects empty and incomplete commands with actionable errors", () => {
  assert.throws(() => parseCommand(""), /Enter a command/);
  assert.throws(() => parseCommand("auri"), /Enter a command after auri/);
  assert.throws(() => parseCommand("tab"), /action/);
});

test("help is generated from one command registry", () => {
  const help = commandHelp();
  assert.match(help, /auri tab new/);
  assert.match(help, /auri ai ask/);
  assert.match(help, /auri clipboard list/);
  assert.match(help, /auri web open/);
  assert.match(help, /auri record start/);
  assert.match(help, /auri live record start/);
  assert.match(help, /auri attachment add/);
  assert.match(help, /auri input insert/);
  assert.match(help, /auri transcript dismiss/);
  assert.match(help, /auri subtab reload/);
  assert.match(help, /auri subtab move-window/);
  assert.match(help, /auri subtab move-main/);
});


test("terminal command tails preserve shell quoting exactly", () => {
  assert.equal(extractCommandTail("auri terminal run printf \'%s %s\' hello world"), "printf \'%s %s\' hello world");
});


test("AI prompt tails preserve punctuation and quotes", () => {
  assert.equal(extractActionTail('auri ai ask say "hello world" exactly', "ai", "ask"), 'say "hello world" exactly');
});

test("quoted empty arguments are preserved for optional command fields", () => {
  assert.deepEqual(parseCommand('ai model add Name gemini model "" key').args, ["add", "Name", "gemini", "model", "", "key"]);
});
