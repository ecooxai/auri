import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState } from "../src/model/state.js";
import { renderTerminal } from "../src/views/panels.js";

test("native shell work is moved off the Tauri command thread", async () => {
  const source = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(source, /async fn run_command/);
  assert.match(source, /spawn_blocking/);
});

test("terminal composer disables expensive macOS text services", () => {
  const html = renderTerminal(createInitialState());
  assert.match(html, /id="terminal-input"/);
  assert.match(html, /spellcheck="false"/);
  assert.match(html, /autocorrect="off"/);
  assert.match(html, /autocapitalize="off"/);
  assert.match(html, /autocomplete="off"/);
});

test("terminal input waits for the PTY instead of silently dropping keystrokes", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /async ensureStarted/);
  assert.match(source, /await this\.ensureStarted\(\)/);
  assert.doesNotMatch(source, /if \(!this\.backend\.isNative \|\| !this\.started\) return;/);
});

test("terminal remounts are generation guarded and clicking restores xterm focus", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /mountGeneration/);
  assert.match(source, /generation !== this\.mountGeneration/);
  assert.match(source, /addEventListener\("mousedown", \(\) => this\.term\?\.focus\(\)\)/);
});

test("each submitted native command probes the PTY working directory", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /auri-cwd=%s/);
  assert.match(source, /onCwdChange/);
  assert.match(source, /consumeTerminalData/);
});

test("terminal cwd notifications synchronize the folder UI", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /session\.onCwdChange/);
  assert.match(source, /handleTerminalCwdChange/);
  assert.match(source, /await this\.syncDirectory\(path, workspaceId\)/);
});
