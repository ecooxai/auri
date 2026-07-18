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
  // The focused workspace is marked with a light-blue fill so the active
  // space stays visible at a glance.
  assert.match(activeTab, /background:\s*rgba\(147, 187, 253/);
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
  const config = await readFile("src-tauri/tauri.conf.json", "utf8");
  const native = await readFile("src-tauri/src/core/lifecycle.rs", "utf8");

  assert.doesNotMatch(source, /class="window-bar"/);
  assert.doesNotMatch(source, /class="window-title"/);
  assert.match(panels, /class="subtab-bar chrome-tabbar"/);
  assert.match(panels, /"subtab-menu"/);
  assert.match(panels, /"command-menu"/);
  assert.match(panels, /\["settings", "⚙", "Settings"\]/);
  assert.match(panels, /\["info", "ⓘ", "Info"\]/);
  assert.match(config, /"decorations":\s*false/);
  assert.match(native, /set_decorations\(false\)/);
  assert.match(native, /_MOTIF_WM_HINTS/);
  assert.match(native, /_NET_WM_DESKTOP/);
  assert.match(native, /0xFFFFFFFF/);
  assert.match(native, /windowraise/);
});

test("workspace rail keeps workspace navigation and workspace actions", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const start = panels.indexOf("export function renderMainTabs");
  const end = panels.indexOf("export function renderSubtabs");
  const renderMainTabs = panels.slice(start, end);

  assert.match(renderMainTabs, /tab-select/);
  assert.doesNotMatch(renderMainTabs, /info-open/);
  assert.doesNotMatch(renderMainTabs, /settings-open/);
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
  assert.doesNotMatch(rail, /"info-open"/);
  assert.doesNotMatch(rail, /"settings-open"/);
  assert.doesNotMatch(topbar, /"tab-new"/);
  assert.doesNotMatch(topbar, /"tab-close"/);
  assert.doesNotMatch(topbar, /"info-open"/);
  assert.doesNotMatch(topbar, /"settings-open"/);
  assert.match(topbar, /class="chrome-actions"/);
  assert.match(topbar, /"subtab-menu"/);
  assert.match(topbar, /"command-menu"/);
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


test("decorationless macOS window does not request system titlebar controls", async () => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const mainWindow = config.app.windows.find((window) => window.label === "main");

  assert.equal(mainWindow.decorations, false);
  assert.equal(mainWindow.titleBarStyle, undefined);
  assert.equal(mainWindow.hiddenTitle, undefined);
  assert.equal(mainWindow.trafficLightPosition, undefined);
});


test("empty topbar space remains draggable while tabs stay interactive", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  assert.match(panels, /class="subtab-bar chrome-tabbar" data-tauri-drag-region/);
  assert.match(panels, /class="subtab-scroll"[^>]*data-tauri-drag-region/);
  assert.match(css, /\.subtab-scroll[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.subtab \{[\s\S]*-webkit-app-region:\s*no-drag/);
});

test("the focused workspace and subtab are marked with a light-blue background", async () => {
  const css = await readFile("styles.css", "utf8");
  const tab = rule(css, ".main-tab");
  const active = rule(css, ".main-tab.is-active");
  const activeSubtab = rule(css, ".subtab.is-active");

  assert.match(tab, /border-radius:\s*0/);
  assert.match(active, /background:\s*rgba\(147, 187, 253, \.28\) !important/);
  assert.match(activeSubtab, /rgba\(184, 212, 254/);
});

test("top tabs stay readable between sixty and one hundred pixels", async () => {
  const css = await readFile("styles.css", "utf8");
  const tab = rule(css, ".subtab");

  assert.match(tab, /min-width:\s*60px/);
  assert.match(tab, /max-width:\s*100px/);
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


test("settings expose a persisted interface font-size control", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const appView = await readFile("src/views/app-view.js", "utf8");
  const css = await readFile("styles.css", "utf8");

  assert.match(panels, /data-setting="fontSize"/);
  assert.match(panels, /Interface font size/);
  assert.match(appView, /applyAppFontSize/);
  assert.match(panels, /max="30"/);
  assert.match(css, /html \{[^}]*font-size:\s*20px/s);
});

test("folder navigation controls sit above an editable compact path field", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  const start = panels.indexOf("export function renderFolder");
  const end = panels.indexOf("export function renderTerminal");
  const folder = panels.slice(start, end);

  assert.match(folder, /class="[^"]*folder-toolbar[^"]*"/);
  assert.match(folder, /id="folder-path-input"/);
  assert.match(folder, /button\("⌂", "Home", "folder-home"\)[\s\S]*button\("↑", "Parent folder", "folder-up"\)[\s\S]*button\("↻", "Refresh", "folder-refresh"\)/);
  assert.ok(folder.indexOf('folder-toolbar') < folder.indexOf('id="folder-path-input"'));
  assert.doesNotMatch(folder, /folder-heading-copy/);
  assert.doesNotMatch(folder, />FILES</);
  assert.doesNotMatch(folder, />LOCATION</);
  assert.match(css, /\.pane-heading\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*grid-template-rows:\s*auto auto/s);
  assert.match(css, /\.folder-toolbar\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*flex-wrap:\s*nowrap[^}]*width:\s*max-content/s);
  assert.match(css, /\.folder-path-input\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.56\)[^}]*border:\s*1px[^}]*border-radius:\s*9px[^}]*font-size:\s*\.6[0-9]*rem/s);
  assert.match(css, /\.folder-path-input\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\.folder-path-input:focus\s*\{[^}]*background:\s*white[^}]*box-shadow:/s);
});

test("newly polled folder entries render with a very light blue marker", async () => {
  const { renderFolder } = await import("../src/views/panels.js");
  const { createInitialState } = await import("../src/model/state.js");
  const state = createInitialState();
  state.tabs[0].folder.entries = [{
    path: "/tmp/new-folder",
    name: "new-folder",
    kind: "directory",
    _auriNew: true
  }];
  const html = renderFolder(state);
  const css = await readFile("styles.css", "utf8");

  assert.match(html, /file-row-wrap[^\"]*is-new/);
  assert.match(css, /\.file-row-wrap\.is-new\s*\{[^}]*background:\s*#f0f7ff/i);
});

test("folder rows keep expanders but show full wrapped names without item icons", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  const { createInitialState } = await import("../src/model/state.js");
  const { renderFolder } = await import("../src/views/panels.js");
  const state = createInitialState();
  const longName = "2fee12a6-5cd6-4c9d-8c71-373efeb82b2-f57c9dd8-9e4a-4798-converted-preview-image.webp";
  state.tabs[0].folder.path = "/home/a/Desktop/teptic";
  state.tabs[0].folder.entries = [
    { name: longName, path: `${state.tabs[0].folder.path}/${longName}`, kind: "image" },
    { name: "archive", path: `${state.tabs[0].folder.path}/archive`, kind: "directory" }
  ];
  const html = renderFolder(state);

  assert.match(panels, /data-action="folder-toggle"/);
  assert.match(panels, /aria-expanded="\$\{expanded \? "true" : "false"\}"/);
  assert.match(panels, /file-row \$\{isDirectory \? "is-directory" : ""\}/);
  assert.doesNotMatch(html, /class="file-icon/);
  assert.match(html, new RegExp(longName));
  assert.doesNotMatch(panels, /class="file-size"/);
  assert.match(css, /\.file-name\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(css, /\.file-name\s*\{[^}]*-webkit-line-clamp:/s);
  assert.doesNotMatch(css, /\.file-name\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.file-name\s*\{[^}]*font-size:\s*\.68rem/s);
  // Block flow so multi-line names grow the row instead of spilling over the
  // next entry (WebKit under-measures grid/flex button content).
  assert.match(css, /\.file-row\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.file-row\s*\{[^}]*height:\s*auto/s);
  assert.doesNotMatch(css, /\.file-size\s*\{/);
});

test("folder pane exposes a right-edge resize handle and drives the workspace grid width", async () => {
  const view = await readFile("src/views/app-view.js", "utf8");
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");

  assert.match(view, /--folder-pane-width:\$\{state\.settings\.folderPaneWidth\}px/);
  assert.match(view, /setFolderPaneWidth\(width\)/);
  assert.match(panels, /data-action="folder-resize"/);
  assert.match(css, /\.workspace-grid\s*\{[^}]*grid-template-columns:\s*var\(--folder-pane-width,\s*230px\) minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.folder-resize-handle\s*\{[^}]*cursor:\s*col-resize/s);
});

test("folder More menu contains sorting, creation, and folder info actions", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  const start = panels.indexOf("export function renderFolder");
  const end = panels.indexOf("export function renderTerminal");
  const folder = panels.slice(start, end);

  assert.match(folder, /button\("⋯", "More folder actions", "folder-more"/);
  assert.match(folder, /data-action="folder-sort" data-sort="name"/);
  assert.match(folder, /data-action="folder-sort" data-sort="date"/);
  assert.match(folder, /data-action="folder-sort" data-sort="type"/);
  assert.match(folder, /data-action="folder-new-file"/);
  assert.match(folder, /data-action="folder-new-folder"/);
  assert.match(folder, /data-action="folder-info"/);
  assert.match(css, /\.folder-more-wrap\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.folder-menu\s*\{[^}]*position:\s*absolute/s);
});

test("inspected media files render an immediate local preview", async () => {
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  const { renderViewer } = await import("../src/views/panels.js");
  let state = createInitialState();

  state = reduceState(state, {
    type: "FILE_SELECT",
    payload: {
      path: "/tmp/song.mp3",
      metadata: { name: "song.mp3", kind: "audio", assetUrl: "asset:///tmp/song.mp3" },
      open: false
    }
  });

  const html = renderViewer(state);
  assert.match(html, /<audio controls/);
  assert.match(html, /asset:\/\/\/tmp\/song\.mp3/);
  assert.doesNotMatch(html, /inspect-hint/);
});

test("inspected folders render their contents in the mini viewer", async () => {
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  const { renderViewer } = await import("../src/views/panels.js");
  let state = createInitialState();

  state = reduceState(state, {
    type: "FILE_SELECT",
    payload: {
      path: "/tmp/src",
      metadata: {
        name: "src",
        kind: "directory",
        entries: [
          { name: "components", path: "/tmp/src/components", kind: "directory" },
          { name: "index.js", path: "/tmp/src/index.js", kind: "text", size: 128 }
        ]
      },
      open: false
    }
  });

  const html = renderViewer(state);
  assert.match(html, /folder-preview-list/);
  assert.match(html, /components/);
  assert.match(html, /index\.js/);
  assert.match(html, /2 items/);
});

test("new file and folder use an inline floating name form below the path", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const view = await readFile("src/views/app-view.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  const start = panels.indexOf("export function renderFolder");
  const end = panels.indexOf("export function renderTerminal");
  const folder = panels.slice(start, end);

  assert.match(folder, /id="folder-create-form"/);
  assert.match(folder, /id="folder-create-input"/);
  assert.match(folder, /data-action="folder-create-confirm"/);
  assert.ok(folder.indexOf('id="folder-path-input"') < folder.indexOf('id="folder-create-form"'));
  assert.match(view, /folderCreateKind[\s\S]*#folder-create-input[\s\S]*focus/);
  assert.match(css, /\.folder-create-popover\s*\{[^}]*position:\s*absolute[^}]*z-index/s);
  assert.match(css, /\.folder-create-form\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
});

test("settings expose a persisted terminal line retention control", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  assert.match(panels, /data-setting="terminalMaxLines"/);
  assert.match(panels, /Terminal retained lines/);
  assert.match(panels, /value="\$\{state\.settings\.terminalMaxLines\}"/);
});

test("terminal AI controls use a model dropdown followed by Ask and Run actions", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const start = panels.indexOf("export function renderTerminal");
  const end = panels.indexOf("function metadataRows");
  const terminal = panels.slice(start, end);

  assert.match(terminal, /<select id="terminal-model-select"[^>]*aria-label="AI model"/);
  assert.match(terminal, /state\.models\.filter\(\(item\) => item\.enabled\)[\s\S]*<option/);
  assert.doesNotMatch(terminal, /class="model-chip/);
  assert.doesNotMatch(terminal, /model-select-icon/);
  assert.match(terminal, /data-action="terminal-ask"><span>✦<\/span>Ask<\/button>/);
  assert.match(terminal, /data-action="terminal-run"><span>▶<\/span>Run<\/button>/);
  assert.ok(terminal.indexOf('data-action="terminal-ask"') < terminal.indexOf('data-action="terminal-run"'));

  const css = await readFile("styles.css", "utf8");
  assert.match(css, /\.model-select\s*\{[^}]*appearance:\s*none[^}]*-webkit-appearance:\s*none/s);
  assert.match(css, /\.model-select-wrap\s*\{[^}]*width:\s*25px[^}]*min-width:\s*25px[^}]*flex:\s*0 0 25px/s);
  assert.match(css, /\.model-select-wrap\s*\{[^}]*background:\s*#f4f7fb/s);
  assert.match(css, /\.model-select-wrap\s*\{[^}]*border:\s*1px solid/s);
  assert.match(css, /\.model-select-wrap::after\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.model-select\s*\{[^}]*position:\s*absolute[^}]*opacity:\s*0/s);
  assert.match(css, /\.composer-buttons\s*\{[^}]*margin-left:\s*auto/s);
});

test("workspace rail renders a small left-aligned folder name without ellipsis", async () => {
  const panels = await readFile("src/views/panels.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  const start = panels.indexOf("export function renderMainTabs");
  const end = panels.indexOf("export function renderSubtabs");
  const rail = panels.slice(start, end);

  assert.match(rail, /workspaceLabel\(tab\)/);
  assert.doesNotMatch(rail, /workspaceLabel\(tab, index\)/);
  assert.match(rail, /class="main-tab-label"/);
  assert.doesNotMatch(rail, /<span>\$\{index \+ 1\}<\/span>/);
  assert.doesNotMatch(rail, /<small>/);
  assert.match(css, /\.main-tab-label\s*\{[^}]*text-overflow:\s*clip(?:\s*!important)?/s);
  assert.match(css, /\.main-tab\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(css, /\.main-tab-label\s*\{[^}]*flex:\s*1/s);
  assert.match(css, /\.main-tab-label\s*\{[^}]*text-align:\s*left/s);
  assert.doesNotMatch(css, /\.main-tab-label\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.main-tab-label\s*\{[^}]*font-size:\s*\.66rem/s);
});
