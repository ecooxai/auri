import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executeCommand } from "../src/controllers/command-controller.js";
import { defaultBookmarkName, normalizeWebUrl, nextWebZoom } from "../src/model/browser.js";
import { activeSubtab, createInitialState, reduceState } from "../src/model/state.js";
import { renderSubtabs, renderWebOverlay, renderWebview } from "../src/views/panels.js";

function harness() {
  let state = createInitialState();
  return {
    backend: { saveSettings: async () => {} },
    actions: {},
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); },
    state: () => state
  };
}

function webState() {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  return state;
}

test("browser URL, bookmark name, and zoom helpers follow browser-like defaults", () => {
  assert.equal(normalizeWebUrl("example.com/path"), "https://example.com/path");
  assert.equal(normalizeWebUrl('"https://example.com/path"'), "https://example.com/path");
  assert.equal(normalizeWebUrl('https://"https://example.com/path"'), "https://example.com/path");
  assert.equal(defaultBookmarkName("https://docs.example.com/path?q=1"), "docs.example.com");
  assert.equal(defaultBookmarkName("not a url"), "Bookmark");
  assert.equal(nextWebZoom(1, "in"), 1.1);
  assert.equal(nextWebZoom(0.3, "out"), 0.25);
  assert.equal(nextWebZoom(4.9, "in"), 5);
  assert.equal(nextWebZoom(1.7, "reset"), 1);
});

test("browser state stores bookmarks and bounded de-duplicated history", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "BROWSER_BOOKMARK_ADD", payload: { id: "bookmark-1", name: "Example", url: "https://example.com" } });
  state = reduceState(state, { type: "BROWSER_HISTORY_ADD", payload: { url: "https://example.com", title: "Example", at: "2026-06-25T10:00:00.000Z" } });
  state = reduceState(state, { type: "BROWSER_HISTORY_ADD", payload: { url: "https://example.com", title: "Example", at: "2026-06-25T10:01:00.000Z" } });
  assert.equal(state.browser.bookmarks.length, 1);
  assert.equal(state.browser.history.length, 1);
  assert.equal(state.browser.history[0].at, "2026-06-25T10:01:00.000Z");
});

test("webview toolbar replaces the external icon with a light browser menu", () => {
  let state = webState();
  state = reduceState(state, { type: "UI_SET", payload: { webMenuOpen: true } });
  const html = renderWebview(state);
  assert.match(html, /data-action="web-menu"/);
  assert.match(html, /class="web-menu"/);
  assert.match(html, /data-action="web-zoom-out"/);
  assert.match(html, /data-action="web-zoom-in"/);
  assert.match(html, /data-action="web-download"/);
  assert.match(html, /data-action="web-bookmarks"/);
  assert.match(html, /data-action="web-history"/);
  assert.match(html, /data-action="web-devtools"/);
  assert.match(html, /data-action="web-external"/);
});

test("browser dialogs render as a window-level overlay instead of inside webview content", () => {
  let state = webState();
  state = reduceState(state, { type: "BROWSER_BOOKMARK_ADD", payload: { id: "bookmark-1", name: "Example", url: "https://example.com" } });
  state = reduceState(state, { type: "UI_SET", payload: { webDialog: "bookmarks" } });
  const panel = renderWebview(state);
  const overlay = renderWebOverlay(state);
  assert.doesNotMatch(panel, /web-dialog-backdrop/);
  assert.match(overlay, /class="web-dialog-backdrop"/);
  assert.match(overlay, /aria-label="Bookmarks"/);
  assert.match(overlay, /data-action="web-bookmark-open"/);
  assert.match(overlay, /https:\/\/example\.com/);
});


test("add-bookmark overlay repairs an already malformed active URL", () => {
  let state = webState();
  const activeId = state.tabs[0].activeSubtabId;
  state = reduceState(state, { type: "SUBTAB_UPDATE", payload: { id: activeId, patch: { url: 'https://"https://www.google.com/"' } } });
  state = reduceState(state, { type: "UI_SET", payload: { webDialog: "add-bookmark" } });
  const overlay = renderWebOverlay(state);
  assert.match(overlay, /value="www\.google\.com"/);
  assert.match(overlay, /value="https:\/\/www\.google\.com\/"/);
  assert.doesNotMatch(overlay, /https:\/\/&quot;https:/);
});

test("quoted GUI navigation is normalized instead of becoming a doubled scheme", async () => {
  const h = harness();
  await executeCommand('web open "https://www.google.com/"', h);
  const active = h.state().tabs[0].subtabs.find((item) => item.id === h.state().tabs[0].activeSubtabId);
  assert.equal(active.url, "https://www.google.com/");
  assert.equal(active.title, "www.google.com");
});

test("browser chrome CSS stays compact, fixed, and cache-busted", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(css, /\.web-dialog-backdrop\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.web-dialog\s*\{[^}]*font-size:\s*13px/s);
  assert.match(css, /\.web-menu\s*\{[^}]*width:\s*260px/s);
  assert.match(css, /\.web-menu[^}]*font-size:\s*13px/s);
  assert.match(index, /styles\.css\?v=\d+/);
});

test("bookmark add command supports hostname defaults and persists browser data", async () => {
  const h = harness();
  const saved = [];
  h.backend.saveSettings = async (configuration) => saved.push(configuration);
  await executeCommand("web bookmark add https://news.ycombinator.com/newest", h);
  assert.equal(h.state().browser.bookmarks[0].name, "news.ycombinator.com");
  assert.equal(h.state().browser.bookmarks[0].url, "https://news.ycombinator.com/newest");
  assert.equal(saved.at(-1).browser.bookmarks.length, 1);
});

test("browser commands delegate zoom, download, dialogs, external opening, and devtools", async () => {
  const h = harness();
  const calls = [];
  h.actions = {
    webZoomIn: async () => calls.push("zoom-in"),
    webZoomOut: async () => calls.push("zoom-out"),
    webZoomReset: async () => calls.push("zoom-reset"),
    webDownload: async () => calls.push("download"),
    webExternal: async () => calls.push("external"),
    webDevtools: async () => calls.push("devtools"),
    openWebDialog: async (dialog) => calls.push(dialog)
  };
  for (const command of ["web zoom-in", "web zoom-out", "web zoom-reset", "web download", "web external", "web devtools", "web bookmarks", "web history"]) {
    await executeCommand(command, h);
  }
  assert.deepEqual(calls, ["zoom-in", "zoom-out", "zoom-reset", "download", "external", "devtools", "bookmarks", "history"]);
});



test("native non-web tabs keep the normal New Tab dropdown visible", () => {
  for (const type of ["terminal", "info", "clipboard", "settings", "viewer", "audio", "video"]) {
    let state = createInitialState();
    if (type !== "terminal") state = reduceState(state, { type: "SUBTAB_NEW", payload: { type } });
    state = reduceState(state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });
    assert.match(renderSubtabs(state, { native: true }), /class="pop-menu"/, `${type} should show the DOM dropdown`);
  }
});

test("native web tabs omit the DOM new-tab popover because it is rendered in the topmost child overlay", () => {
  let state = webState();
  state = reduceState(state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });
  assert.match(renderSubtabs(state), /class="pop-menu"/);
  assert.doesNotMatch(renderSubtabs(state, { native: true }), /class="pop-menu"/);
});

test("topbar command menu lists opened tabs and exits through a command action", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "settings" } });
  state = reduceState(state, { type: "UI_SET", payload: { commandMenuOpen: true } });
  const html = renderSubtabs(state);

  assert.match(html, /class="command-menu pop-menu"/);
  assert.match(html, /data-action="command-menu-tab"/);
  assert.match(html, /Terminal/);
  assert.match(html, /Settings/);
  assert.match(html, /data-action="app-exit"/);
  assert.match(html, /Exit Auri/);
});

test("native New Tab menu uses the topmost overlay without hiding the website", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 120, top: 90, width: 660, height: 520 }) };
  const add = { getBoundingClientRect: () => ({ left: 690, top: 8, right: 738, bottom: 56, width: 48, height: 48 }) };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : selector === '[data-action="subtab-menu"]' ? add : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    hideWebviews: async () => calls.push(["hide-websites"]),
    showBrowserOverlay: async (...args) => calls.push(["overlay", ...args]),
    hideBrowserOverlay: async () => calls.push(["hide-overlay"])
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });

  await controller.syncNativeWebview();

  assert.ok(calls.find(([kind]) => kind === "website"));
  assert.equal(calls.some(([kind]) => kind === "hide-websites"), false);
  const overlay = calls.find(([kind]) => kind === "overlay");
  assert.equal(overlay[1].mode, "new-tab");
  assert.equal(overlay[2].width, 220);
  assert.ok(overlay[2].y >= 56);
});


test("native New Tab overlay selections return through the shared subtab command", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = { isNative: true };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });

  await controller.handleBrowserOverlayAction({ action: "subtab-new", type: "terminal" });

  assert.equal(activeSubtab(controller.state).type, "terminal");
  assert.equal(controller.state.ui.addSubtabMenuOpen, false);
});

test("native zoom updates the existing menu in place without rerendering or recreating its overlay", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  let renders = 0;
  const view = {
    root: { querySelector: () => null },
    render() { renders += 1; },
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    webviewAction: async (...args) => calls.push(["zoom", ...args]),
    updateBrowserOverlayZoom: async (value) => calls.push(["overlay-zoom", value]),
    showBrowserOverlay: async () => calls.push(["overlay-recreated"])
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webMenuOpen: true } });

  await controller.runWebviewZoom("in");

  assert.equal(activeSubtab(controller.state).zoom, 1.1);
  assert.equal(renders, 0);
  assert.equal(calls.some(([kind]) => kind === "overlay-recreated"), false);
  assert.deepEqual(calls.find(([kind]) => kind === "overlay-zoom"), ["overlay-zoom", "110%"]);
});

test("native browser menu overlays the website without hiding or moving it", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 140, top: 90, width: 620, height: 500 }) };
  const menu = { getBoundingClientRect: () => ({ left: 730, top: 52, right: 760, bottom: 82, width: 30, height: 30 }) };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : selector === '[data-action="web-menu"]' ? menu : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    hideWebviews: async () => calls.push(["hide-websites"]),
    showBrowserOverlay: async (...args) => calls.push(["overlay", ...args]),
    hideBrowserOverlay: async () => calls.push(["hide-overlay"])
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webMenuOpen: true } });

  await controller.syncNativeWebview();

  const website = calls.find(([kind]) => kind === "website");
  const overlay = calls.find(([kind]) => kind === "overlay");
  assert.ok(website, "website remains shown");
  assert.deepEqual(website[3], { x: 140, y: 90, width: 620, height: 500 });
  assert.equal(calls.some(([kind]) => kind === "hide-websites"), false);
  assert.equal(overlay[1].mode, "menu");
  assert.equal(overlay[2].width, 260);
});

test("native webview uses the full web frame bounds when the host is collapsed on Linux", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const frame = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 700, height: 540 }) };
  const host = {
    getBoundingClientRect: () => ({ left: 100, top: 350, width: 700, height: 270 }),
    closest: (selector) => selector === ".web-frame-wrap" ? frame : null
  };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    hideBrowserOverlay: async () => {}
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });

  await controller.syncNativeWebview();

  const website = calls.find(([kind]) => kind === "website");
  assert.deepEqual(website[3], { x: 100, y: 80, width: 700, height: 540 });
});

test("native webview uses the frame origin when Linux reports a displaced host", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const frame = { getBoundingClientRect: () => ({ left: 392, top: 124, width: 786, height: 796 }) };
  const host = {
    getBoundingClientRect: () => ({ left: 392, top: 475, width: 786, height: 796 }),
    closest: (selector) => selector === ".web-frame-wrap" ? frame : null
  };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    hideBrowserOverlay: async () => {}
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });

  await controller.syncNativeWebview();

  const website = calls.find(([kind]) => kind === "website");
  assert.deepEqual(website[3], { x: 392, y: 124, width: 786, height: 796 });
});

test("native bookmark and history dialogs use centered overlay children while the website stays visible", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 130, top: 90, width: 650, height: 520 }) };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    hideWebviews: async () => calls.push(["hide-websites"]),
    showBrowserOverlay: async (...args) => calls.push(["overlay", ...args]),
    hideBrowserOverlay: async () => calls.push(["hide-overlay"])
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webDialog: "history" } });

  await controller.syncNativeWebview();

  assert.equal(calls.some(([kind]) => kind === "hide-websites"), false);
  assert.ok(calls.find(([kind]) => kind === "website"));
  const overlay = calls.find(([kind]) => kind === "overlay");
  assert.equal(overlay[1].mode, "history");
  assert.ok(overlay[2].x > 0);
  assert.ok(overlay[2].y > 0);
});


test("native overlay actions return through the command layer", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const backend = { isNative: true, saveSettings: async () => {} };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { webDialog: "add-bookmark", bookmarkDraft: { name: "Example", url: "https://example.com" } } });

  await controller.handleBrowserOverlayAction({ action: "web-bookmark-save", name: "Example", url: "https://example.com" });

  assert.equal(controller.state.browser.bookmarks[0].name, "Example");
  assert.equal(controller.state.browser.bookmarks[0].url, "https://example.com");
  assert.equal(controller.state.ui.webDialog, "bookmarks");
});

test("native browser overlays are local child webviews with their own bundled assets", () => {
  const rust = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(rust, /browser-overlay\.html/);
  assert.match(rust, /OVERLAY_LABEL/);
  assert.match(rust, /initialization_script/);
  assert.match(rust, /transparent\(true\)/);
  assert.match(build, /browser-overlay\.html/);
  assert.match(build, /browser-overlay\.js/);
  assert.match(build, /browser-overlay\.css/);
  const overlay = readFileSync(new URL("../browser-overlay.js", import.meta.url), "utf8");
  assert.match(overlay, /new-tab/);
  assert.match(overlay, /__AURI_UPDATE_ZOOM__/);
});

test("native child webviews bridge navigation, zoom, downloads, and devtools", () => {
  const source = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  assert.match(source, /on_navigation/);
  assert.match(source, /auri-web-navigation/);
  assert.match(source, /set_zoom/);
  assert.match(source, /update_overlay_zoom/);
  assert.match(source, /__AURI_UPDATE_ZOOM__/);
  assert.match(source, /open_devtools/);
  assert.match(source, /download/);
});
