import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState } from "../src/model/state.js";
import { renderSettings } from "../src/views/panels.js";
import { captureSettingsScroll } from "../src/views/app-view.js";

test("settings use a compact saved-model list without the preferences eyebrow", () => {
  const state = createInitialState();
  const html = renderSettings(state);

  assert.doesNotMatch(html, /PREFERENCES/);
  assert.ok(state.models.length >= 1);
  assert.match(html, /<strong>Gemini Live<\/strong>/);
  assert.match(html, /class="model-list"/);
  assert.match(html, /data-action="model-menu"/);
  assert.doesNotMatch(html, /data-model-key=/);
  assert.doesNotMatch(html, /Save model/);
});

test("model overflow menu exposes edit, delete, and set-default actions", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "UI_SET", payload: { modelMenuId: "gemini-live-default" } });
  const html = renderSettings(state);

  assert.match(html, /data-action="model-edit"/);
  assert.match(html, /data-action="model-delete"/);
  assert.match(html, /data-action="model-select"/);
  assert.match(html, />Set default</);
});

test("editing a saved model reveals all editable model properties", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "UI_SET", payload: { editingModelId: "gemini-live-default" } });
  const html = renderSettings(state);

  assert.match(html, /id="model-edit-form"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="type"/);
  assert.match(html, /name="model"/);
  assert.match(html, /name="url"/);
  assert.match(html, /name="apiKey"/);
  assert.match(html, /Save changes/);
});

test("deleting the default model selects the next saved model", () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "MODEL_ADD",
    payload: { id: "backup", name: "Backup", type: "openai", model: "gpt-test", url: "", apiKey: "", enabled: true }
  });
  state = reduceState(state, { type: "MODEL_DELETE", payload: { id: "gemini-live-default" } });

  assert.equal(state.models.some((model) => model.id === "gemini-live-default"), false);
  assert.equal(state.selectedModelId, state.models[0].id);
});

test("saved models use one light list surface with inline overflow actions", async () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "MODEL_ADD",
    payload: { id: "openai-test", name: "OpenAI", type: "openai", model: "gpt-test", url: "", apiKey: "", enabled: true }
  });
  state = reduceState(state, { type: "UI_SET", payload: { modelMenuId: "openai-test" } });

  const html = renderSettings(state);
  const css = await import("node:fs/promises").then(({ readFile }) => readFile("styles.css", "utf8"));

  assert.match(html, /class="model-row is-menu-open"/);
  assert.match(html, /class="model-row-copy"[\s\S]*class="model-row-title"[\s\S]*<strong>OpenAI<\/strong>/);
  assert.match(html, /<small>OpenAI · gpt-test<\/small>/);
  assert.match(html, /class="model-more"[^>]*aria-haspopup="menu"[^>]*aria-expanded="true"/);
  assert.match(html, /class="model-menu-separator" role="separator"/);

  assert.match(css, /\.model-list\s*\{[^}]*border:\s*1px solid/s);
  assert.match(css, /\.model-list\s*\{[^}]*border-radius:/s);
  assert.match(css, /\.model-list\s*\{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.model-list\s*\{[^}]*background:/s);
  assert.match(css, /\.model-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.model-row:not\(:last-child\)\s*\{[^}]*border-bottom:/s);
  assert.match(css, /\.model-row-actions\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.model-menu\s*\{[^}]*position:\s*absolute[^}]*right:\s*0[^}]*z-index:\s*50/s);
});


test("wake shortcut is a readonly press-to-capture field", () => {
  const html = renderSettings(createInitialState());

  assert.match(html, /id="wake-shortcut-input"/);
  assert.match(html, /data-setting="wakeShortcut"/);
  assert.match(html, /readonly/);
  assert.match(html, /Press the shortcut you want to use/);
});

test("settings expose an all-workspaces desktop visibility toggle", () => {
  const html = renderSettings(createInitialState());

  assert.match(html, /data-setting="visibleOnAllWorkspaces"/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /Show on every desktop/);
});

test("process priority settings are collapsed by default at the bottom and put Add above the saved list", () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "SYSTEM_PROCESS_PRIORITY_RULE_SET",
    payload: { identity: "/usr/bin/python3", nice: 10 }
  });
  let html = renderSettings(state);

  assert.match(html, /<h3>Process priorities<\/h3>/);
  assert.match(html, /data-action="process-priority-settings-toggle"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /class="priority-rule-card"/);
  assert.ok(html.indexOf("Browser AI prompts") < html.indexOf("Process priorities"));

  state = reduceState(state, { type: "UI_SET", payload: { processPrioritySettingsOpen: true } });
  html = renderSettings(state);
  assert.match(html, /data-action="process-priority-settings-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /class="process-priority-rule-form"[^>]*data-original-identity="\/usr\/bin\/python3"/);
  assert.match(html, /name="identity"[^>]*value="\/usr\/bin\/python3"/);
  assert.match(html, /name="nice"[^>]*min="-20"[^>]*max="19"[^>]*value="10"/);
  assert.match(html, /data-action="process-priority-rule-remove"[^>]*data-identity="\/usr\/bin\/python3"/);
  assert.match(html, /id="process-priority-rule-add"[\s\S]*name="identity"[\s\S]*name="nice"[\s\S]*Add rule/);
  assert.ok(html.indexOf('id="process-priority-rule-add"') < html.indexOf('class="priority-rule-list"'));
  assert.match(html, /data-action="process-priority-filter-toggle"/);
});

test("priority rule search filters saved rules and PATH suggestions appear after four typed characters", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SYSTEM_PROCESS_PRIORITY_RULE_SET", payload: { identity: "/usr/bin/python3", nice: 10 } });
  state = reduceState(state, { type: "SYSTEM_PROCESS_PRIORITY_RULE_SET", payload: { identity: "/usr/bin/node", nice: 15 } });
  state = reduceState(state, { type: "UI_SET", payload: {
    processPrioritySettingsOpen: true,
    processPriorityFilterOpen: true,
    processPriorityFilter: "python",
    processPriorityDraft: "pyth",
    processPrioritySuggestions: [
      { name: "python3", path: "/usr/bin/python3" },
      { name: "python3.13", path: "/usr/bin/python3.13" }
    ]
  } });
  const html = renderSettings(state);

  assert.match(html, /id="process-priority-filter"[^>]*value="python"/);
  assert.match(html, /data-original-identity="\/usr\/bin\/python3"/);
  assert.doesNotMatch(html, /data-original-identity="\/usr\/bin\/node"/);
  assert.match(html, /id="process-priority-rule-identity"[^>]*value="pyth"/);
  assert.match(html, /class="priority-command-suggestions"/);
  assert.match(html, /data-action="process-priority-suggestion"[^>]*data-value="\/usr\/bin\/python3"/);
  assert.match(html, /python3\.13/);
});

test("settings expose a light numbered custom terminal completion editor", async () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "SETTING_SET",
    payload: { key: "customCompletions", value: "git status\nnpm test" }
  });
  const html = renderSettings(state);
  const css = await import("node:fs/promises").then(({ readFile }) => readFile("styles.css", "utf8"));

  assert.equal(state.settings.customCompletions, "git status\nnpm test");
  assert.match(html, /class="custom-completions-shell"/);
  assert.match(html, /id="custom-completions-lines"[^>]*aria-hidden="true"[^>]*>1\n2<\/div>/);
  assert.match(html, /<textarea[^>]*id="custom-completions"[^>]*rows="8"/);
  assert.doesNotMatch(html, /id="custom-completions"[^>]*data-setting=/);
  assert.match(html, />git status\nnpm test<\/textarea>/);
  assert.match(html, /id="custom-completions-count"[^>]*>2 lines<\/small>/);
  assert.match(html, /One command per line/);
  assert.match(html, /data-action="custom-completions-save"/);
  assert.match(html, />Save commands<\/button>/);
  assert.match(css, /\.custom-completions-shell\s*\{[^}]*width:\s*90%/s);
  assert.match(css, /\.custom-completions-shell\s*\{[^}]*grid-template-columns:\s*[^;]*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.custom-completions-shell\s*\{[^}]*background:\s*rgba?\(/s);
  assert.match(css, /\.custom-completions-gutter\s*\{[^}]*border-right:/s);
});

test("settings scroll position is retained across save-triggered re-renders", async () => {
  const scroller = { scrollTop: 612 };
  const root = { querySelector: (selector) => selector === ".settings-scroll" ? scroller : null };
  assert.equal(captureSettingsScroll(root), 612);
  assert.equal(captureSettingsScroll({ querySelector: () => null }), 0);

  const source = await import("node:fs/promises").then(({ readFile }) => readFile("src/views/app-view.js", "utf8"));
  const capture = source.indexOf("const settingsScrollTop = captureSettingsScroll(this.root);");
  const replace = source.indexOf("this.root.innerHTML =", capture);
  const restore = source.indexOf("settings.scrollTop = settingsScrollTop", replace);
  const frame = source.indexOf("requestAnimationFrame(() => {", restore);
  assert.ok(capture >= 0 && capture < replace, "settings scroll must be captured before replacing the DOM");
  assert.ok(restore > replace, "settings scroll must be restored after replacing the DOM");
  assert.ok(frame > restore, "settings scroll must be restored synchronously before deferred work");
});

test("custom command line numbers update on input and follow textarea scrolling", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile("src/controllers/app-controller.js", "utf8"));
  assert.match(source, /input\.id === "custom-completions"[\s\S]*syncCustomCompletionLineNumbers/);
  assert.match(source, /addEventListener\("scroll",[^;]*true\)/);
  assert.match(source, /target\.id !== "custom-completions"[\s\S]*syncCustomCompletionScroll/);
});
