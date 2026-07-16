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
  assert.match(html, /data-action="web-reload"/);
  assert.match(html, /data-action="web-back"/);
  assert.match(html, /data-action="web-forward"/);
  assert.match(html, /data-action="subtab-new" data-type="webview"/);
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

test("each top tab uses a double-click action menu without a separate close button", () => {
  let state = createInitialState();
  const activeId = state.tabs[0].activeSubtabId;
  state = reduceState(state, { type: "UI_SET", payload: { subtabActionMenuId: activeId } });
  const html = renderSubtabs(state);

  assert.match(html, new RegExp(`data-tab-id="${activeId}"`));
  assert.match(html, new RegExp(`data-action="subtab-select" data-id="${activeId}"`));
  assert.doesNotMatch(html, /data-action="subtab-action-menu"/);
  assert.match(html, /data-action="subtab-action-reload"/);
  assert.match(html, /data-action="subtab-action-window"/);
  assert.match(html, /data-action="subtab-action-close"/);
  assert.match(html, />Reload tab</);
  assert.match(html, />Open in new window</);
  assert.match(html, />Close tab</);
  assert.doesNotMatch(html, /data-action="subtab-close"/);
});

test("switching away from a web tab closes its browser menu", () => {
  let state = webState();
  const terminal = state.tabs[0].subtabs.find((item) => item.type === "terminal");
  state = reduceState(state, { type: "UI_SET", payload: { webMenuOpen: true } });

  state = reduceState(state, { type: "SUBTAB_SELECT", payload: { id: terminal.id } });

  assert.equal(activeSubtab(state).id, terminal.id);
  assert.equal(state.ui.webMenuOpen, false);
});

test("compact utility tabs render short readable labels", () => {
  let state = createInitialState();
  for (const type of ["clipboard", "system", "info"]) {
    if (!state.tabs[0].subtabs.some((subtab) => subtab.type === type)) {
      state = reduceState(state, { type: "SUBTAB_NEW", payload: { type } });
    }
  }
  const html = renderSubtabs(state);

  assert.match(html, /<span class="subtab-title">Term<\/span>/);
  assert.match(html, /<span class="subtab-title">Copym<\/span>/);
  assert.match(html, /<span class="subtab-title">Sys<\/span>/);
  assert.match(html, /<span class="subtab-title">Info<\/span>/);
});

test("clicking a tab icon only selects it and double-clicking the tab opens its action menu", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "info" } });
  const terminal = controller.state.tabs[0].subtabs.find((item) => item.type === "terminal");
  const calls = [];
  controller.runInternal = async (command) => calls.push(command);

  const icon = {
    dataset: { action: "subtab-select", id: terminal.id },
    getBoundingClientRect: () => ({ left: 84 })
  };
  icon.closest = (selector) => selector.includes("[data-action]") ? icon : null;
  await controller.handleClick({
    preventDefault() {},
    stopPropagation() {},
    target: icon
  });

  assert.equal(calls[0], `subtab select ${terminal.id}`);
  assert.equal(controller.state.ui.subtabActionMenuId, null);

  const tab = {
    dataset: { tabId: terminal.id },
    getBoundingClientRect: () => ({ left: 84 })
  };
  tab.closest = (selector) => selector === ".subtab-bar"
    ? { getBoundingClientRect: () => ({ left: 20 }) }
    : null;
  await controller.handleDoubleClick({
    preventDefault() {},
    stopPropagation() {},
    target: { closest: (selector) => selector === "[data-tab-id]" ? tab : null }
  });

  assert.equal(calls[1], `subtab select ${terminal.id}`);
  assert.equal(controller.state.ui.subtabActionMenuId, terminal.id);
  assert.equal(controller.state.ui.subtabActionMenuX, 64);
});

test("two consecutive clicks open the action menu for every tab even when the tab DOM is replaced", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({ view, backend: { isNative: false }, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  for (const type of ["webview", "settings", "viewer"]) {
    controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type } });
  }
  controller.runInternal = async () => {};

  const clickTarget = (id, left) => {
    const tab = {
      dataset: { tabId: id },
      getBoundingClientRect: () => ({ left })
    };
    tab.closest = (selector) => selector === ".subtab-bar"
      ? { getBoundingClientRect: () => ({ left: 20 }) }
      : null;
    const target = { dataset: { action: "subtab-select", id } };
    target.closest = (selector) => selector === "[data-action]"
      ? target
      : selector === "[data-tab-id]"
        ? tab
        : null;
    return target;
  };

  for (const [index, tab] of controller.state.tabs[0].subtabs.entries()) {
    await controller.handleClick({ preventDefault() {}, stopPropagation() {}, target: clickTarget(tab.id, 84 + index * 12) });
    await controller.handleClick({ preventDefault() {}, stopPropagation() {}, target: clickTarget(tab.id, 84 + index * 12) });
    assert.equal(controller.state.ui.subtabActionMenuId, tab.id, `${tab.type} should open its tab menu`);
  }
});

test("pointer-down on the URL-bar browser menu toggles it before the website can cover the click", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: { isNative: true },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const menu = { dataset: { action: "web-menu" } };
  let prevented = false;

  const handled = controller.handleBrowserMenuPointerDown({
    button: 0,
    preventDefault() { prevented = true; },
    stopPropagation() {},
    target: { closest: (selector) => selector === '[data-action="web-menu"]' ? menu : null }
  });

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.equal(controller.state.ui.webMenuOpen, true);

  controller.webMenuSuppressClick = false;
  controller.handleBrowserMenuPointerDown({
    button: 0,
    preventDefault() {},
    stopPropagation() {},
    target: { closest: (selector) => selector === '[data-action="web-menu"]' ? menu : null }
  });

  assert.equal(controller.state.ui.webMenuOpen, false);
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
  assert.ok(overlay[2].height >= 420);
  assert.ok(overlay[2].y >= 56);
});

test("unchanged native browser overlays are reused across unrelated renders", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const overlays = [];
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
    showWebview: async () => {},
    showBrowserOverlay: async (...args) => overlays.push(args),
    hideBrowserOverlay: async () => {}
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });

  await controller.syncNativeWebview();
  await controller.syncNativeWebview();

  assert.equal(overlays.length, 1);
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
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: true, webMenuOpen: true } });

  await controller.handleBrowserOverlayAction({ action: "subtab-new", type: "terminal" });

  assert.equal(activeSubtab(controller.state).type, "terminal");
  assert.equal(controller.state.ui.addSubtabMenuOpen, false);
  assert.equal(controller.state.ui.webMenuOpen, false);
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

test("native tab action menu is rendered in the topmost overlay above the website", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 140, top: 90, width: 620, height: 500 }) };
  const tabNode = { getBoundingClientRect: () => ({ left: 420, right: 500, top: 8, bottom: 56 }) };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : selector.includes("data-tab-id") ? tabNode : null },
    render() {}, getTerminalInputValue: () => "", showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["website", ...args]),
    showBrowserOverlay: async (...args) => calls.push(["overlay", ...args]),
    hideBrowserOverlay: async () => {}
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const web = activeSubtab(controller.state);
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { subtabActionMenuId: web.id } });

  await controller.syncNativeWebview();

  const overlay = calls.find(([kind]) => kind === "overlay");
  assert.equal(overlay[1].mode, "subtab-actions");
  assert.equal(overlay[1].id, web.id);
  assert.ok(overlay[2].y >= 56);
});

test("native file viewers reuse the child webview and show every chrome menu above the file", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 140, top: 90, width: 620, height: 500 }) };
  const tabNode = { getBoundingClientRect: () => ({ left: 420, right: 500, top: 8, bottom: 56 }) };
  const add = { getBoundingClientRect: () => ({ left: 690, top: 8, right: 738, bottom: 56 }) };
  const menu = { getBoundingClientRect: () => ({ left: 730, top: 52, right: 760, bottom: 82 }) };
  const view = {
    root: {
      querySelector: (selector) => selector === "#native-webview-host"
        ? host
        : selector === '[data-action="subtab-menu"]'
          ? add
          : selector === '[data-action="web-menu"]'
            ? menu
            : selector.includes("data-tab-id")
              ? tabNode
              : null
    },
    render() {}, getTerminalInputValue: () => "", showToast() {}
  };
  const backend = {
    isNative: true,
    showWebview: async (...args) => calls.push(["file", ...args]),
    webviewAction: async (...args) => calls.push(["action", ...args]),
    updateBrowserOverlayZoom: async (...args) => calls.push(["overlay-zoom", ...args]),
    hideWebviews: async () => calls.push(["hide-files"]),
    showBrowserOverlay: async (...args) => calls.push(["overlay", ...args]),
    hideBrowserOverlay: async () => calls.push(["hide-overlay"])
  };
  const controller = new AppController({ view, backend, terminalSessionFactory: () => ({ initialize: async () => {} }) });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const file = activeSubtab(controller.state);
  const url = "http://localhost:8895/tmp/manual.pdf?view=1";
  controller.state = reduceState(controller.state, {
    type: "SUBTAB_UPDATE",
    payload: { id: file.id, patch: { url, filePath: "/tmp/manual.pdf", title: "manual.pdf" } }
  });

  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: true } });
  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { addSubtabMenuOpen: false, subtabActionMenuId: file.id } });
  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "UI_SET", payload: { subtabActionMenuId: null, webMenuOpen: true } });
  await controller.syncNativeWebview();

  const shown = calls.find(([kind]) => kind === "file");
  assert.equal(shown[2], url);
  assert.equal(calls.some(([kind]) => kind === "hide-files"), false);
  assert.deepEqual(calls.filter(([kind]) => kind === "overlay").map((call) => call[1].mode), ["new-tab", "subtab-actions", "menu"]);

  await controller.runWebviewAction("back");
  await controller.runWebviewZoom("in");

  assert.deepEqual(calls.find(([kind, , action]) => kind === "action" && action === "back"), ["action", file.id, "back", null]);
  assert.deepEqual(calls.find(([kind, , action]) => kind === "action" && action === "zoom"), ["action", file.id, "zoom", 1.1]);
  assert.equal(activeSubtab(controller.state).zoom, 1.1);
});

test("native file viewer navigation keeps the filename and browser history unchanged", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const controller = new AppController({
    view: { root: { querySelector: () => null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: { isNative: true, saveSettings: async () => {} },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const file = activeSubtab(controller.state);
  const url = "http://localhost:8895/tmp/manual.pdf?view=1";
  controller.state = reduceState(controller.state, {
    type: "SUBTAB_UPDATE",
    payload: { id: file.id, patch: { url, filePath: "/tmp/manual.pdf", title: "manual.pdf" } }
  });

  await controller.handleWebNavigation({ id: file.id, url });

  assert.equal(activeSubtab(controller.state).title, "manual.pdf");
  assert.deepEqual(controller.state.browser.history, []);
});

test("native file viewer reload recreates the shared child webview", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 700, height: 540 }) };
  const controller = new AppController({
    view: { root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      closeWebview: async (id) => calls.push(["close", id]),
      showWebview: async (id, url, bounds, navigate) => calls.push(["show", id, url, bounds, navigate]),
      hideBrowserOverlay: async () => calls.push(["hide-overlay"])
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const file = activeSubtab(controller.state);
  const url = "http://localhost:8895/tmp/manual.pdf?view=1";
  controller.state = reduceState(controller.state, {
    type: "SUBTAB_UPDATE",
    payload: { id: file.id, patch: { url, filePath: "/tmp/manual.pdf", title: "manual.pdf" } }
  });
  controller.nativeWebviewUrls.set(file.id, url);

  await controller.reloadSubtab(file.id);

  assert.deepEqual(calls[0], ["hide-overlay"]);
  assert.deepEqual(calls[1], ["close", file.id]);
  assert.equal(calls[2][0], "show");
  assert.equal(calls[2][2], url);
});

test("unchanged native webview renders do not call show again or reload the current page", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 700, height: 540 }) };
  const controller = new AppController({
    view: { root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: { isNative: true, showWebview: async (...args) => calls.push(args), hideBrowserOverlay: async () => {} },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });

  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "FOLDER_ENTRIES_SET", payload: { entries: [{ path: "/tmp/new.txt", name: "new.txt", kind: "text" }] } });
  await controller.syncNativeWebview();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], true);
});

test("native web reload destroys and recreates the current webview", async () => {
  const { AppController } = await import("../src/controllers/app-controller.js");
  const calls = [];
  const host = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 700, height: 540 }) };
  const controller = new AppController({
    view: { root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null }, render() {}, getTerminalInputValue: () => "", showToast() {} },
    backend: {
      isNative: true,
      closeWebview: async (id) => calls.push(["close", id]),
      showWebview: async (id, url, bounds, navigate) => calls.push(["show", id, url, bounds, navigate]),
      hideBrowserOverlay: async () => calls.push(["hide-overlay"])
    },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const web = activeSubtab(controller.state);
  controller.nativeWebviewUrls.set(web.id, web.url);

  await controller.reloadSubtab(web.id);

  assert.deepEqual(calls[0], ["hide-overlay"]);
  assert.deepEqual(calls[1], ["close", web.id]);
  assert.equal(calls[2][0], "show");
  assert.equal(calls[2][4], true);
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
  for (const label of ["System", "Disk", "Network", "Info"]) assert.match(overlay, new RegExp(label));
  for (const action of ["web-reload", "web-back", "web-forward", "subtab-new"]) assert.match(overlay, new RegExp(action));
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

test("web AI menu items combine built-ins with custom label|prompt lines", async () => {
  const { webAiMenuItems, webAiMenuPayload, webAiPrompt } = await import("../src/model/browser.js");
  const items = webAiMenuItems("Summarize | Summarize this: {text}\nbroken line\n | missing label");
  assert.deepEqual(items.map((item) => item.id), ["ask", "translate", "tts", "custom-0"]);
  assert.equal(items[3].label, "Summarize");
  assert.equal(webAiPrompt(items[3], { kind: "text", text: "hello" }), "Summarize this: hello");
  assert.equal(webAiPrompt(items[0], { kind: "text", text: "plain" }), "plain");
  const payload = JSON.parse(webAiMenuPayload(""));
  assert.deepEqual(payload, [
    { id: "ask", label: "Ask" },
    { id: "translate", label: "Translate" },
    { id: "tts", label: "Speak" }
  ]);
});

test("web AI image prompts fall back to the image URL when no pixels were captured", async () => {
  const { webAiMenuItems, webAiPrompt } = await import("../src/model/browser.js");
  const ask = webAiMenuItems("").find((item) => item.id === "ask");
  const prompt = webAiPrompt(ask, { kind: "image", imageUrl: "https://example.com/cat.png" });
  assert.match(prompt, /Describe this image\./);
  assert.match(prompt, /https:\/\/example\.com\/cat\.png/);
});

test("native webviews preserve Google OAuth popups and recover a crashed Linux web process", () => {
  const source = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /auri\.internal/);
  assert.match(source, /handle_internal_navigation/);
  assert.match(source, /auri-web-ai/);
  assert.match(source, /\.on_new_window/);
  assert.match(source, /const nativeOpen = window\.open\.bind\(window\)/);
  assert.match(source, /window\.open = function \(url/);
  assert.match(source, /\? "about:blank" : url/);
  assert.match(source, /return nativeOpen\(targetUrl/);
  assert.doesNotMatch(source, /go\("popup"/);
  assert.doesNotMatch(source, /fn open_popup/);
  assert.match(source, /PAGE_SCRIPT_TEMPLATE/);
  assert.match(source, /#\[cfg\(not\(target_os = "linux"\)\)\]\s*let builder = builder\.on_new_window\(managed_popup_handler/);
  assert.match(source, /\.window_features\(features\)/);
  assert.match(source, /tauri::webview::NewWindowResponse::Create \{ window \}/);
  assert.match(source, /set_hardware_acceleration_policy\(HardwareAccelerationPolicy::Never\)/);
  assert.match(source, /connect_create/);
  assert.match(source, /WebView::with_related_view/);
  assert.match(source, /gtk::Window::new\(gtk::WindowType::Toplevel\)/);
  assert.match(lib, /WEBKIT_DISABLE_DMABUF_RENDERER/);
  assert.match(source, /connect_web_process_terminated/);
  assert.match(source, /WebProcessTerminationReason::Crashed/);
  assert.match(source, /set_enable_media_stream\(false\)/);
  assert.match(source, /auri-web-process-recovered/);
});

test("native browser webviews share a stable persistent profile directory", () => {
  const webview = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(webview, /pub fn browser_profile_dir/);
  assert.match(webview, /app_data_dir\(\)/);
  assert.match(webview, /join\("browser-profile"\)/);
  assert.match(webview, /\.data_directory\(browser_profile_dir/);
  assert.doesNotMatch(lib, /WebviewBuilder::from_config[\s\S]*?\.data_directory\(\s*webview::browser_profile_dir/);
});

test("native webviews publish completed top-level URLs instead of iframe navigation requests", () => {
  const source = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  assert.match(source, /\.on_page_load\(move \|_, payload\|/);
  assert.match(source, /payload\.event\(\) != tauri::webview::PageLoadEvent::Finished/);
  assert.match(source, /url: payload\.url\(\)\.to_string\(\)/);
});

test("linux web tabs stay embedded and prompt before granting website media access", () => {
  const source = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fn use_window_webview/);
  assert.doesNotMatch(source, /AURI_EMBEDDED_WEBVIEW/);
  assert.doesNotMatch(source, /fn show_window_webview/);
  assert.match(source, /install_linux_webview_layer/);
  assert.match(source, /embed_linux_webview/);
  assert.match(source, /gtk::Overlay/);
  assert.match(source, /add_overlay\(&inner\)/);
  assert.match(source, /reorder_overlay\(&inner, -1\)/);
  assert.match(source, /connect_get_child_position/);
  assert.match(source, /gtk::Rectangle::new/);
  assert.match(source, /set_data\(LINUX_WEBVIEW_BOUNDS_KEY/);
  assert.match(source, /set_margin_start\(0\)/);
  assert.match(source, /set_margin_top\(0\)/);
  assert.doesNotMatch(source, /gtk::Fixed/);
  assert.doesNotMatch(source, /layer\.put/);
  assert.match(source, /connect_permission_request/);
  assert.match(source, /UserMediaPermissionRequest/);
  assert.match(source, /PermissionRequestExt::allow/);
  assert.match(source, /PermissionRequestExt::deny/);
  assert.match(source, /fn linux_related_view/);
  assert.match(source, /builder\.with_related_view\(related\)/);
  assert.match(source, /CookieAcceptPolicy::Always/);
  assert.match(source, /set_itp_enabled\(false\)/);
});
