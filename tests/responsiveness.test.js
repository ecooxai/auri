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


test("terminal media is rendered inline by xterm instead of a separate history pane", async () => {
  const state = createInitialState();
  state.tabs[0].terminal.history.push({ kind: "assistant", stdout: "response", audioUrl: "blob:audio" });

  const html = renderTerminal(state);
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const css = await readFile("styles.css", "utf8");

  assert.match(html, /id="terminal-emulator"/);
  assert.doesNotMatch(html, /terminal-message-feed/);
  assert.doesNotMatch(html, /terminal-emulator-frame/);
  assert.doesNotMatch(html, /<audio/);
  assert.match(terminal, /registerMarker\(/);
  assert.match(terminal, /registerDecoration\(/);
  assert.match(terminal, /createElement\("audio"\)/);
  assert.match(terminal, /createElement\("video"\)/);
  assert.match(terminal, /createElement\("img"\)/);
  assert.match(css, /\.terminal-inline-media/);
});

test("terminal input waits for the PTY instead of silently dropping keystrokes", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /async ensureStarted/);
  assert.match(source, /await this\.ensureStarted\(\)/);
  const writeMethod = source.slice(source.indexOf("async write(data)"), source.indexOf("async stop()"));
  assert.doesNotMatch(writeMethod, /!this\.started/);
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
  assert.match(source, /getTerminalCwd/);
  assert.match(source, /scheduleCwdRefresh/);
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

test("xterm submissions refresh cwd from the native shell process", async () => {
  const frontend = await readFile("src/services/terminal-session.js", "utf8");
  const backend = await readFile("src-tauri/src/core/terminal.rs", "utf8");

  assert.match(frontend, /data\.includes\("\\r"\).*scheduleCwdRefresh/);
  assert.match(frontend, /backend\.getTerminalCwd/);
  assert.match(backend, /pub fn cwd\(session_id: &str\)/);
  assert.match(backend, /process_id\(\)/);
});

test("window resizing refits xterm and resizes the native PTY", async () => {
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const controller = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(terminal, /resize\(\)\s*\{[^}]*this\.fitAddon\.fit\(\)/s);
  assert.match(terminal, /resizeTerminal\(this\.sessionId, this\.term\.cols, this\.term\.rows\)/);
  assert.match(controller, /window\.addEventListener\("resize", \(\) => \{[^}]*activeTerminalSession\(\)\.resize/s);
});

test("desktop window launches compact at the top-left", async () => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const window = config.app.windows[0];
  assert.equal(window.width, 800);
  assert.equal(window.x, 0);
  assert.equal(window.y, 0);
  assert.equal(window.center, false);
  assert.ok(window.minWidth <= window.width);
});


test("terminal uses the configured interface font size", async () => {
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const controller = await readFile("src/controllers/app-controller.js", "utf8");

  assert.match(terminal, /async mount\(element, cwd = "~", fontSize = 20\)/);
  assert.match(terminal, /fontSize: Math\.round\(Math\.min\(30, Math\.max\(14[^\n]+\* 0\.6\)/);
  assert.match(controller, /session\.mount\(terminalHost, workspace\.terminal\.cwd, this\.state\.settings\.fontSize\)/);
});
