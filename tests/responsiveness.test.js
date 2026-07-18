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


test("terminal media is rendered inline in the scroll flow instead of a separate history pane", async () => {
  const state = createInitialState();
  state.tabs[0].terminal.history.push({ kind: "assistant", stdout: "response", audioUrl: "blob:audio" });

  const html = renderTerminal(state);
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const css = await readFile("styles.css", "utf8");

  assert.match(html, /id="terminal-emulator"/);
  assert.doesNotMatch(html, /terminal-message-feed/);
  assert.doesNotMatch(html, /terminal-emulator-frame/);
  assert.doesNotMatch(html, /<audio/);
  assert.match(terminal, /placeMediaCards\(/);
  assert.match(terminal, /mediaCards\.push\(/);
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
  // Input typed before the PTY exists must either start it (ensureStarted)
  // or queue for the adopted shared session — never be discarded.
  const startGuards = writeMethod.match(/!this\.started/g) || [];
  const adoptQueueGuards = writeMethod.match(/this\.adoptOnly && !this\.started[\s\S]{0,80}pendingAdoptInput \+= data/g) || [];
  assert.equal(startGuards.length, adoptQueueGuards.length, "every not-started early path queues the keystrokes");
});

test("terminal remounts are generation guarded and clicking restores terminal focus", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /mountGeneration/);
  assert.match(source, /generation !== this\.mountGeneration/);
  assert.match(source, /addEventListener\("mousedown", \(\) => root\.focus\(/);
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
  assert.match(source, /await this\.syncDirectory\(path, workspaceId, terminalId\)/);
});

test("terminal visuals use the app light palette", async () => {
  const css = await readFile("styles.css", "utf8");
  const source = await readFile("src/services/terminal-session.js", "utf8");

  assert.match(css, /\.terminal-panel\s*\{[^}]*background:\s*#f8fbff/s);
  assert.match(css, /\.composer-wrap\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.9\)/s);
  void source;
  assert.match(css, /\.term-scroll\s*\{[^}]*color: var\(--term-fg\)/s);
  assert.match(css, /--term-fg: #24324a/);
  assert.match(css, /--term-bg: #f8fbff/);
  assert.match(css, /\.term-cursor\s*\{[^}]*background: #7089f8/s);
  assert.doesNotMatch(css, /\.term-scroll\s*\{[^}]*#121c2f/s);
});

test("terminal ANSI backgrounds fill the complete row box", async () => {
  const css = await readFile("styles.css", "utf8");

  assert.match(css, /\.term-row\s*\{[^}]*height:\s*1\.25em[^}]*line-height:\s*1\.25em/s);
  assert.match(css, /\.term-row\s*>\s*span\s*\{[^}]*display:\s*inline-block[^}]*height:\s*100%[^}]*vertical-align:\s*top/s);
});

test("every terminal control stays light in connected and input states", async () => {
  const css = await readFile("styles.css", "utf8");

  assert.match(css, /\.terminal-input-zone\s*\{[^}]*background:\s*#f8fbff/s);
  assert.match(css, /\.model-select-wrap\.is-live-connected\s*\{[^}]*color:\s*#405a86/s);
  assert.match(css, /\.term-root\s*\{[^}]*--term-bg: #f8fbff/s);
  assert.doesNotMatch(css, /\.model-select-wrap\.is-live-connected\s*\{[^}]*color:\s*#e8f6ff/s);
});

test("terminal submissions refresh cwd from the native shell process", async () => {
  const frontend = await readFile("src/services/terminal-session.js", "utf8");
  const backend = await readFile("src-tauri/src/core/terminal.rs", "utf8");

  assert.match(frontend, /sequence\.includes\("\\r"\).*scheduleCwdRefresh/s);
  assert.match(frontend, /backend\.getTerminalCwd/);
  assert.match(backend, /pub fn cwd\(session_id: &str, logical_cwd: Option<&str>\)/);
  assert.match(backend, /process_id\(\)/);
});

test("terminal cwd refresh sends the logical path for symlink preservation", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const calls = [];
  const session = new TerminalSession({
    isNative: true,
    getTerminalCwd: async (...args) => {
      calls.push(args);
      return "/home/a/project";
    }
  });
  session.started = true;
  session.sessionId = "terminal-link";
  session.cwd = "/home/a/project";

  await session.refreshCwd();

  assert.deepEqual(calls, [["terminal-link", "/home/a/project"]]);
});

test("window resizing remeasures the grid and resizes the native PTY", async () => {
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const controller = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(terminal, /resize\(\)\s*\{[^}]*this\.measureMetrics\(\)/s);
  assert.match(terminal, /resizeTerminal\(this\.sessionId, grid\.cols, grid\.rows\)/);
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

  assert.match(terminal, /async mount\(element, cwd = "~", fontSize = 20, maxLines = 4000, shellCommand = ""\)/);
  assert.match(terminal, /const terminalFontSize = Math\.round/);
  assert.match(terminal, /--term-font-size/);
  assert.match(controller, /session\.mount\(terminalHost, terminalTarget\.subtab\.cwd \|\| workspace\.terminal\.cwd, this\.state\.settings\.fontSize, this\.state\.settings\.terminalMaxLines, this\.state\.settings\.terminalShellCommand\)/);
});

test("full renders restore non-terminal focus when preserveInput is set", async () => {
  const source = await readFile("src/views/app-view.js", "utf8");
  assert.match(source, /if \(focusSnapshot && !terminalWasFocused\) this\.restoreFocus\(focusSnapshot\)/);
});

test("terminal completion scoring is debounced during fast typing", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /scheduleTerminalCompletions\(input\.value, input\.selectionStart\)/);
  assert.match(source, /this\.terminalCompletionTimer = setTimeout\(\(\) => \{/);
  assert.match(source, /completionInputSnapshot\(pending\)/);
  assert.match(source, /flushTerminalCompletions\(\)/);
});

test("system monitor render skips refresh when the snapshot is still fresh", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /systemSnapshotAgeMs\(this\.state\.system\?\.snapshot\) < 4000/);
  assert.match(source, /&& !snapshotFresh/);
});

test("window focus refreshes permissions without forcing a full render", async () => {
  const source = await readFile("src/controllers/app-controller.js", "utf8");
  assert.match(source, /refreshMediaPermissions\(\{ render: false \}\)/);
});
