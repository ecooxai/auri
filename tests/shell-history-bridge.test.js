import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("native backend exposes bounded shell history", async () => {
  const backend = await readFile("src/services/backend.js", "utf8");
  const native = await readFile("src-tauri/src/lib.rs", "utf8");
  const workspace = await readFile("src-tauri/src/core/workspace.rs", "utf8");

  assert.match(backend, /readShellHistory/);
  assert.match(backend, /read_shell_history/);
  assert.match(native, /fn read_shell_history/);
  assert.match(workspace, /\.zsh_history/);
  assert.match(workspace, /\.bash_history/);
  assert.match(workspace, /histories, 500/);
});
