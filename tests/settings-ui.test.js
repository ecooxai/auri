import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState } from "../src/model/state.js";
import { renderSettings } from "../src/views/panels.js";

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
