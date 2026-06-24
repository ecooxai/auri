import test from "node:test";
import assert from "node:assert/strict";
import { isSimpleCdCommand, shellQuote } from "../src/model/path.js";

test("shellQuote safely quotes folder paths", () => {
  assert.equal(shellQuote("/tmp/new folder"), "'/tmp/new folder'");
  assert.equal(shellQuote("/tmp/it's here"), "'/tmp/it'\"'\"'s here'");
});

test("simple cd detection excludes compound shell expressions", () => {
  assert.equal(isSimpleCdCommand("cd ../project"), true);
  assert.equal(isSimpleCdCommand("cd '/tmp/new folder'"), true);
  assert.equal(isSimpleCdCommand("cd /tmp && pwd"), false);
  assert.equal(isSimpleCdCommand("echo cd /tmp"), false);
});
