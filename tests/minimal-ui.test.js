import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule for ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the workspace rail is visually integrated instead of a separate card", async () => {
  const css = await readFile("styles.css", "utf8");
  const rail = rule(css, ".main-tabs");
  const activeTab = rule(css, ".main-tab.is-active");

  assert.match(rail, /background:\s*var\(--app-bg\)/);
  assert.match(rail, /z-index:\s*2/);
  assert.match(rail, /border-radius:\s*0/);
  assert.match(rail, /backdrop-filter:\s*none/);
  assert.match(activeTab, /background:\s*transparent/);
  assert.match(activeTab, /box-shadow:\s*none/);
});

test("the outer app shell uses a flat minimalist surface", async () => {
  const css = await readFile("styles.css", "utf8");
  const shell = rule(css, ".auri-shell");
  const surface = rule(css, ".app-surface");

  assert.match(shell, /padding:\s*0/);
  assert.match(shell, /gap:\s*0/);
  assert.match(surface, /border-radius:\s*0/);
  assert.match(surface, /box-shadow:\s*none/);
  assert.match(surface, /backdrop-filter:\s*none/);
});

test("the app uses one Chrome-style top tab bar without the redundant window header", async () => {
  const source = await readFile("src/views/app-view.js", "utf8");
  const panels = await readFile("src/views/panels.js", "utf8");

  assert.doesNotMatch(source, /class="window-bar"/);
  assert.doesNotMatch(source, /class="window-title"/);
  assert.match(panels, /class="subtab-bar chrome-tabbar"/);
  assert.match(panels, /"subtab-menu"/);
  assert.match(panels, /"command-palette"/);
  assert.match(panels, /"info-open"/);
  assert.match(panels, /"settings-open"/);
});

test("workspace rail keeps workspace navigation and workspace actions", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const start = panels.indexOf("export function renderMainTabs");
  const end = panels.indexOf("export function renderSubtabs");
  const renderMainTabs = panels.slice(start, end);

  assert.match(renderMainTabs, /tab-select/);
  assert.match(renderMainTabs, /info-open/);
  assert.match(renderMainTabs, /settings-open/);
  assert.match(renderMainTabs, /tab-new/);
  assert.match(renderMainTabs, /tab-close/);
  assert.doesNotMatch(renderMainTabs, /brand-orb/);
});

test("workspace controls stay in the vertical rail while tab controls stay at the right of the top bar", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const mainStart = panels.indexOf("export function renderMainTabs");
  const subtabStart = panels.indexOf("export function renderSubtabs");
  const menuStart = panels.indexOf("function renderSubtabMenu");
  const rail = panels.slice(mainStart, subtabStart);
  const topbar = panels.slice(subtabStart, menuStart);

  assert.match(rail, /"tab-new"/);
  assert.match(rail, /"tab-close"/);
  assert.match(rail, /"info-open"/);
  assert.match(rail, /"settings-open"/);
  assert.doesNotMatch(topbar, /"tab-new"/);
  assert.doesNotMatch(topbar, /"tab-close"/);
  assert.doesNotMatch(topbar, /"info-open"/);
  assert.doesNotMatch(topbar, /"settings-open"/);
  assert.match(topbar, /class="chrome-actions"/);
  assert.match(topbar, /"subtab-menu"/);
  assert.match(topbar, /"command-palette"/);
});

test("the vertical rail starts below the title tab row", async () => {
  const css = await readFile("styles.css", "utf8");
  const shell = rule(css, ".auri-shell");
  const rail = rule(css, ".main-tabs");

  assert.match(shell, /grid-template-rows:\s*46px minmax\(0, 1fr\)/);
  assert.match(rail, /grid-row:\s*2/);
  assert.match(rail, /padding:\s*10px 8px/);
});

test("the top tab bar spans behind the macOS traffic lights", async () => {
  const css = await readFile("styles.css", "utf8");
  const surface = rule(css, ".app-surface");
  const workspace = rule(css, ".workspace-grid");

  assert.match(surface, /grid-column:\s*1 \/ 3/);
  assert.match(workspace, /margin-left:\s*72px/);
});


test("macOS traffic lights are vertically centered in the tab row", async () => {
  const config = await readFile("src-tauri/tauri.conf.json", "utf8");
  assert.match(config, /"trafficLightPosition": \{ "x": 14, "y": 24 \}/);
});


test("empty topbar space remains draggable while tabs stay interactive", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  assert.match(panels, /class="subtab-bar chrome-tabbar" data-tauri-drag-region/);
  assert.match(panels, /class="subtab-scroll"[^>]*data-tauri-drag-region/);
  assert.match(css, /\.subtab-scroll[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.subtab \{[\s\S]*-webkit-app-region:\s*no-drag/);
});

test("workspace active state has no filled or rounded container", async () => {
  const css = await readFile("styles.css", "utf8");
  const tab = rule(css, ".main-tab");
  const active = rule(css, ".main-tab.is-active");

  assert.match(tab, /border-radius:\s*0/);
  assert.match(active, /background:\s*transparent !important/);
  assert.match(active, /box-shadow:\s*none/);
});

test("empty topbar pointer down delegates to native window dragging", async () => {
  const controller = await readFile("src/controllers/app-controller.js", "utf8");
  const backend = await readFile("src/services/backend.js", "utf8");
  const native = await readFile("src-tauri/src/lib.rs", "utf8");

  assert.match(controller, /addEventListener\("pointerdown", \(event\) => this\.handleTopbarPointerDown\(event\)\)/);
  assert.match(controller, /closest\("\.subtab-bar"\)/);
  assert.match(controller, /closest\("button, input, textarea, select, a, \[data-action\]"\)/);
  assert.match(controller, /this\.backend\.startWindowDragging\(\)/);
  assert.match(backend, /startWindowDragging\(\)/);
  assert.match(native, /fn window_start_dragging/);
});
