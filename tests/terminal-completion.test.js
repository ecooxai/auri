import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fuzzyCommandCompletions, terminalCompletions } from "../src/model/terminal-completion.js";
import { createInitialState, reduceState, serializeWorkspaceSession } from "../src/model/state.js";
import { renderTerminal } from "../src/views/panels.js";

function remember(state, command) {
  return reduceState(state, { type: "TERMINAL_COMMAND_REMEMBER", payload: { command } });
}

test("command completion ranks recent prefix matches and removes duplicates", () => {
  const history = [
    "cargo check --manifest-path src-tauri/Cargo.toml",
    "git status --short",
    "npm run build",
    "git status --short",
    "npm test"
  ];

  const results = fuzzyCommandCompletions("git sta", history);

  assert.equal(results[0].value, "git status --short");
  assert.equal(results.filter((item) => item.value === "git status --short").length, 1);
});

test("command completion tolerates one or two typing mistakes", () => {
  const history = [
    "npm run tauri:build",
    "cargo check --manifest-path src-tauri/Cargo.toml",
    "git status --short"
  ];

  assert.equal(fuzzyCommandCompletions("git statsu", history)[0].value, "git status --short");
  assert.equal(fuzzyCommandCompletions("npn run biuld", history)[0].value, "npm run tauri:build");
});

test("command completion stays closed for short input and matches only the current line", () => {
  const history = ["npm test", "echo ignored"];
  assert.deepEqual(fuzzyCommandCompletions("np", history), []);
  assert.deepEqual(fuzzyCommandCompletions("echo ignored\nnp", history), []);

  const results = fuzzyCommandCompletions("echo ignored\nnpm te", history);
  assert.equal(results[0].value, "npm test");
  assert.equal(results.some((item) => item.value === "echo ignored"), false);
});

test("completion includes case-insensitive current-folder files and directories", () => {
  const entries = [
    { name: "README.md", kind: "file" },
    { name: "Source Files", kind: "directory" },
    { name: "package-lock.json", kind: "file" }
  ];

  const fileResults = terminalCompletions("cat reAD", { history: [], entries });
  assert.equal(fileResults[0].value, "cat README.md");
  assert.equal(fileResults[0].label, "README.md");
  assert.equal(fileResults[0].kind, "file");
  assert.equal(fileResults[0].detail, "Current folder");

  const typoResults = terminalCompletions("cat raedme", { history: [], entries });
  assert.equal(typoResults[0].value, "cat README.md");

  const directoryResults = terminalCompletions("cd sour", { history: [], entries });
  assert.equal(directoryResults[0].value, "cd 'Source Files/'");
  assert.equal(directoryResults[0].kind, "directory");
});

test("folder completions can appear before any command has been recorded", () => {
  const results = terminalCompletions("read", {
    history: [],
    entries: [{ name: "README.md", kind: "file" }]
  });
  assert.deepEqual(results.map((item) => item.value), ["README.md"]);
});

test("terminal command history is per workspace, newest first, bounded, and de-duplicated", () => {
  let state = createInitialState();
  const firstWorkspaceId = state.activeTabId;
  state = remember(state, "npm test");
  state = remember(state, "git status");
  state = remember(state, "npm test");

  assert.deepEqual(state.tabs[0].terminal.commandHistory, ["npm test", "git status"]);

  state = reduceState(state, { type: "TAB_NEW", payload: { title: "Second" } });
  state = remember(state, "cargo check");

  assert.deepEqual(state.tabs.find((tab) => tab.id === firstWorkspaceId).terminal.commandHistory, ["npm test", "git status"]);
  assert.deepEqual(state.tabs.find((tab) => tab.id === state.activeTabId).terminal.commandHistory, ["cargo check"]);

  for (let index = 0; index < 220; index += 1) state = remember(state, `echo ${index}`);
  assert.equal(state.tabs.find((tab) => tab.id === state.activeTabId).terminal.commandHistory.length, 200);
});

test("terminal composer exposes an accessible completion list above its textarea", async () => {
  const state = createInitialState();
  const html = renderTerminal(state);
  const css = await readFile("styles.css", "utf8");

  assert.match(html, /id="terminal-completion"[^>]*role="listbox"[^>]*hidden/);
  assert.match(html, /id="terminal-input"[^>]*role="combobox"[^>]*aria-autocomplete="list"[^>]*aria-controls="terminal-completion"/);
  assert.ok(html.indexOf('id="terminal-completion"') < html.indexOf('class="composer-wrap"'));
  assert.match(html, /terminal-input-zone[\s\S]*id="terminal-completion"[\s\S]*class="composer-wrap"/);
  assert.match(css, /\.terminal-input-zone\s*\{[^}]*position:\s*relative[^}]*z-index:\s*20/s);
  assert.match(css, /\.terminal-completion\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 7px\)/s);
  assert.match(css, /\.terminal-completion-option\[aria-selected="true"\]/);
  assert.match(css, /\.terminal-completion-detail/);
});

test("controller opens, navigates, accepts with Tab, and dismisses on Enter", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const input = {
    id: "terminal-input",
    value: "git sta",
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  const updates = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    setTerminalInput(value, focus = true) {
      input.value = value;
      if (focus) input.focus();
      input.setSelectionRange(value.length, value.length);
    },
    insertTerminalText(value) {
      input.value += value;
      input.setSelectionRange(input.value.length, input.value.length);
    },
    setTerminalCompletions(items, selectedIndex) {
      updates.push({ items: items.map((item) => item.value), selectedIndex });
    },
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  for (const command of ["git stash list", "git status --short", "git status --branch"]) {
    controller.state = remember(controller.state, command);
  }

  controller.handleInput({ target: input });
  assert.deepEqual(updates.at(-1).items, ["git status --branch", "git status --short", "git stash list"]);
  assert.equal(updates.at(-1).selectedIndex, 0);

  let prevented = 0;
  await controller.handleKeydown({
    target: input,
    key: "ArrowDown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; }
  });
  assert.equal(updates.at(-1).selectedIndex, 1);

  await controller.handleKeydown({
    target: input,
    key: "Tab",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; }
  });
  assert.equal(input.value, "git status --short");
  assert.deepEqual(updates.at(-1).items, []);
  assert.equal(prevented, 2);

  input.value = "git sta";
  input.setSelectionRange(input.value.length, input.value.length);
  controller.handleInput({ target: input });
  const enterEvent = {
    target: input,
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() { prevented += 1; }
  };
  await controller.handleKeydown(enterEvent);
  assert.equal(input.value, "git sta");
  assert.deepEqual(updates.at(-1).items, []);
  controller.handleKeyup(enterEvent);
  assert.equal(input.value, "git sta\n");

  input.value = "git sta";
  input.setSelectionRange(input.value.length, input.value.length);
  controller.handleInput({ target: input });
  await controller.handleKeydown({
    target: input,
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; }
  });
  assert.deepEqual(updates.at(-1).items, []);
  assert.equal(input.value, "git sta");
});

test("Tab completion replaces only the current line and preserves surrounding lines", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const input = {
    id: "terminal-input",
    value: "echo first\ngit sta\necho last",
    selectionStart: "echo first\ngit sta".length,
    selectionEnd: "echo first\ngit sta".length,
    focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    setTerminalInput(value) { input.value = value; },
    setTerminalCompletions() {},
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = remember(controller.state, "git status --short");

  controller.handleInput({ target: input });
  await controller.handleKeydown({
    target: input,
    key: "Tab",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault() {}
  });

  assert.equal(input.value, "echo first\ngit status --short\necho last");
});

test("controller uses active folder entries when command history is empty", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const input = { id: "terminal-input", value: "read", focus() {}, setSelectionRange() {} };
  const updates = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    setTerminalInput(value) { input.value = value; },
    setTerminalCompletions(items, selectedIndex) { updates.push({ items, selectedIndex }); },
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, {
    type: "FOLDER_ENTRIES_SET",
    payload: { entries: [{ name: "README.md", kind: "file" }, { name: "src", kind: "directory" }] }
  });

  controller.handleInput({ target: input });

  assert.equal(updates.at(-1).items[0].value, "README.md");
  assert.equal(updates.at(-1).items[0].kind, "file");
  assert.equal(updates.at(-1).selectedIndex, 0);
});

test("workspace command history is serialized and restored when present", () => {
  let state = createInitialState();
  state = remember(state, "npm test");
  state = remember(state, "git status");

  const saved = serializeWorkspaceSession(state);
  const restored = reduceState(createInitialState(), {
    type: "WORKSPACES_RESTORE",
    payload: saved
  });

  assert.deepEqual(restored.tabs[0].terminal.commandHistory, ["git status", "npm test"]);
});

test("clicking a terminal completion fills the composer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const input = { id: "terminal-input", value: "npm tes", focus() {}, setSelectionRange() {} };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    setTerminalInput(value) { input.value = value; },
    setTerminalCompletions() {},
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = remember(controller.state, "npm test");
  controller.handleInput({ target: input });

  await controller.handleClick({
    target: { closest: () => ({ dataset: { action: "terminal-completion-select", index: "0" } }) },
    preventDefault() {}
  });

  assert.equal(input.value, "npm test");
});

test("completion merges workspace, shell, and custom command sources", () => {
  const results = terminalCompletions("docker comp", {
    history: ["docker compose ps"],
    shellHistory: ["docker compose up -d", "git status"],
    customEntries: "docker compose logs -f\n\nDOCKER COMPOSE DOWN"
  });

  assert.deepEqual(results.slice(0, 4).map((item) => item.value), [
    "docker compose ps",
    "docker compose logs -f",
    "DOCKER COMPOSE DOWN",
    "docker compose up -d"
  ]);
  assert.deepEqual(results.slice(0, 4).map((item) => item.detail), [
    "Workspace history",
    "Custom",
    "Custom",
    "Shell history"
  ]);
});

test("custom completion input uses one trimmed non-empty command per line", () => {
  const results = terminalCompletions("kub get", {
    customEntries: "  kubectl get pods  \n\nkubectl get services\nKUBECTL GET PODS"
  });

  assert.deepEqual(results.map((item) => item.value), [
    "kubectl get pods",
    "kubectl get services"
  ]);
});

test("controller completion uses loaded shell history and custom settings", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const input = { id: "terminal-input", value: "cargo che", focus() {}, setSelectionRange() {} };
  const updates = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    setTerminalInput(value) { input.value = value; },
    setTerminalCompletions(items, selectedIndex) { updates.push({ items, selectedIndex }); },
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, {
    type: "SHELL_HISTORY_SET",
    payload: { commands: ["cargo check --workspace"] }
  });
  controller.state = reduceState(controller.state, {
    type: "SETTING_SET",
    payload: { key: "customCompletions", value: "cargo check --all-targets" }
  });

  controller.handleInput({ target: input });

  assert.deepEqual(updates.at(-1).items.slice(0, 2).map((item) => item.detail), ["Custom", "Shell history"]);
  assert.deepEqual(updates.at(-1).items.slice(0, 2).map((item) => item.value), [
    "cargo check --all-targets",
    "cargo check --workspace"
  ]);
});

test("custom completion settings save explicitly through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const saved = [];
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    getCustomCompletions: () => "zzcustom smoke command\ngit status",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true, saveSettings: async (configuration) => saved.push(configuration) },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.handleClick({
    target: { closest: () => ({ dataset: { action: "custom-completions-save" } }) },
    preventDefault() {}
  });

  assert.equal(controller.state.settings.customCompletions, "zzcustom smoke command\ngit status");
  assert.equal(saved.at(-1).settings.customCompletions, "zzcustom smoke command\ngit status");
});

test("a command is promoted to saved custom completions on its fifth use", () => {
  let state = createInitialState();
  for (let index = 0; index < 4; index += 1) state = remember(state, "npm run check");
  assert.equal(state.settings.customCompletions, "");
  assert.equal(state.settings.commandUsage[0].count, 4);

  state = remember(state, "npm run check");
  assert.equal(state.settings.customCompletions, "npm run check");
  assert.equal(state.settings.commandUsage[0].count, 5);

  state = remember(state, "npm run check");
  assert.equal(state.settings.customCompletions, "npm run check");
  assert.equal(state.settings.commandUsage[0].count, 6);
});

test("frequent commands append without duplicating existing custom lines", () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "SETTING_SET",
    payload: { key: "customCompletions", value: "git status\nnpm test" }
  });
  for (let index = 0; index < 5; index += 1) state = remember(state, "GIT STATUS");
  for (let index = 0; index < 5; index += 1) state = remember(state, "cargo check");

  assert.equal(state.settings.customCompletions, "git status\nnpm test\ncargo check");
});

test("quick Enter inserts a newline while holding Enter for two seconds runs once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { AppController } = await import("../src/controllers/app-controller.js");
  const inserted = [];
  let runs = 0;
  const input = { id: "terminal-input", value: "echo hello" };
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => input.value,
    insertTerminalText(value) { inserted.push(value); input.value += value; },
    setTerminalCompletions() {},
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.submitTerminal = async () => { runs += 1; };
  const event = {
    target: input,
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() {}
  };

  await controller.handleKeydown(event);
  t.mock.timers.tick(300);
  controller.handleKeyup(event);
  assert.deepEqual(inserted, ["\n"]);
  assert.equal(runs, 0);

  input.value = "echo held";
  await controller.handleKeydown(event);
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.equal(runs, 1);
  controller.handleKeyup(event);
  assert.deepEqual(inserted, ["\n"]);
});

test("running from the composer restores composer focus and never focuses the PTY", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const focusFlags = [];
  let terminalFocusCalls = 0;
  let inputValue = "echo hello";
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => inputValue,
    setTerminalInput(value, focus) { inputValue = value; focusFlags.push(focus); },
    setTerminalCompletions() {},
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: true },
    terminalSessionFactory: () => ({
      initialize: async () => {},
      run: async () => {},
      focus: () => { terminalFocusCalls += 1; }
    })
  });

  await controller.submitTerminal("run");

  assert.equal(inputValue, "");
  assert.equal(focusFlags.at(-1), true);
  assert.equal(terminalFocusCalls, 0);
});

test("custom completion textarea Enter remains a normal multiline edit", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  let prevented = 0;
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });

  await controller.handleKeydown({
    target: { id: "custom-completions", value: "first" },
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; }
  });

  assert.equal(prevented, 0);
});
