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

test("submitted native commands do not inject a cwd printf probe", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.doesNotMatch(source, /auri-cwd=%s/);
  assert.match(source, /onCommand/);
  assert.match(source, /captureInput/);
});

test("terminal cwd notifications synchronize the folder UI", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /session\.onCwdChange/);
  assert.match(source, /handleTerminalCwdChange/);
  assert.match(source, /await this\.syncDirectory\(path, workspaceId\)/);
});

test("terminal visuals use the app light palette", async () => {
  const css = await readFile("styles.css", "utf8");
  const source = await readFile("src/services/terminal-session.js", "utf8");

  assert.match(css, /\.terminal-panel\s*\{[^}]*background:\s*#f8fbff/s);
  assert.match(css, /\.composer-wrap\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.9\)/s);
  assert.match(source, /background:\s*"#f8fbff"/);
  assert.match(source, /foreground:\s*"#24324a"/);
  assert.match(source, /cursor:\s*"#7089f8"/);
  assert.doesNotMatch(source, /background:\s*"#121c2f"/);
});

test("every terminal control stays light in connected and input states", async () => {
  const css = await readFile("styles.css", "utf8");

  assert.match(css, /\.terminal-input-zone\s*\{[^}]*background:\s*#f8fbff/s);
  assert.match(css, /\.model-chip\.is-live-connected\s*\{[^}]*color:\s*#405a86/s);
  assert.match(css, /\.terminal-emulator \.xterm \.composition-view\s*\{[^}]*background:\s*#f8fbff/s);
  assert.doesNotMatch(css, /\.model-chip\.is-live-connected\s*\{[^}]*color:\s*#e8f6ff/s);
});

test("xterm-submitted cd commands are surfaced without a printf probe", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");

  assert.match(source, /this\.inputBuffer/);
  assert.match(source, /this\.onCommand/);
  assert.match(source, /captureInput\(data\)/);
  assert.doesNotMatch(source, /printf '\\\\033\[2K/);
});
