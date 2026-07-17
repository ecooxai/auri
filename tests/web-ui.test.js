import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, parseCommand } from "../src/model/commands.js";
import { executeCommand } from "../src/controllers/command-controller.js";
import { createInitialState, reduceState } from "../src/model/state.js";
import { Backend } from "../src/services/backend.js";

function harness() {
  let state = createInitialState();
  return {
    backend: {},
    actions: {},
    getState: () => state,
    dispatch: (event) => { state = reduceState(state, event); },
    state: () => state
  };
}

function withBrowserGlobals(run) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  return (async () => {
    try {
      return await run();
    } finally {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      if (originalFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = originalFetch;
    }
  })();
}

test("auri browser parses as a registry command that opens the hosted UI", () => {
  const parsed = parseCommand("auri browser");
  assert.equal(parsed.domain, "browser");
  assert.equal(parsed.action, "open");
  assert.ok(COMMANDS.some(([syntax]) => syntax === "browser"), "the registry documents auri browser");
});

test("the browser command routes through the openBrowserUi platform action", async () => {
  const h = harness();
  const opened = [];
  h.actions.openBrowserUi = async () => {
    opened.push(true);
    return { url: "http://127.0.0.1:8899", port: 8899 };
  };

  const result = await executeCommand("browser", h);
  assert.equal(opened.length, 1);
  assert.equal(result.url, "http://127.0.0.1:8899");

  delete h.actions.openBrowserUi;
  await assert.rejects(() => executeCommand("browser", h), /needs the native Auri app/);
});

test("the hosted web bridge routes invoke calls over HTTP and unwraps the result envelope", async () => {
  await withBrowserGlobals(async () => {
    globalThis.window = {};
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/__auri__/ping") return { ok: true };
      if (url === "/__auri__/invoke/list_directory") {
        return { ok: true, json: async () => ({ ok: true, result: [{ name: "README.md" }] }) };
      }
      if (url === "/__auri__/invoke/kill_process") {
        return { ok: true, json: async () => ({ ok: false, error: "Process 1 is protected." }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const backend = new Backend();
    assert.equal(backend.isNative, false, "no Tauri runtime in the browser");
    assert.equal(await backend.connectHostedWebBridge(), true);
    assert.equal(backend.isHostedWeb, true);
    assert.equal(backend.isNative, true, "bridged invoke restores native capability");

    const entries = await backend.listDirectory("/tmp");
    assert.deepEqual(entries, [{ name: "README.md" }]);
    const invokeCall = calls.find((call) => call.url === "/__auri__/invoke/list_directory");
    assert.equal(invokeCall.options.method, "POST");
    assert.deepEqual(JSON.parse(invokeCall.options.body), { path: "/tmp" });

    await assert.rejects(() => backend.killProcess(1), /Process 1 is protected/);
  });
});

test("the hosted web session never publishes app state and keeps exit local", async () => {
  await withBrowserGlobals(async () => {
    let closed = 0;
    globalThis.window = { close: () => { closed += 1; } };
    const invoked = [];
    globalThis.fetch = async (url) => {
      invoked.push(url);
      return { ok: true, json: async () => ({ ok: true, result: null }) };
    };

    const backend = new Backend();
    await backend.connectHostedWebBridge();
    invoked.length = 0;

    const sync = await backend.syncAppState("{}");
    assert.equal(sync.hostedWeb, true);
    await backend.exitApp();
    assert.equal(closed, 1, "exit closes the browser tab, not the desktop app");
    assert.deepEqual(invoked, [], "neither call reaches the bridge");
  });
});

test("hosted web mode opens webview subtabs as named browser tabs", async () => {
  await withBrowserGlobals(async () => {
    const opened = [];
    const tab = { closed: false, focus() { this.focused = true; }, close() { this.closed = true; } };
    globalThis.window = {
      open: (url, name) => {
        opened.push({ url, name });
        return tab;
      }
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: null }) });

    const backend = new Backend();
    await backend.connectHostedWebBridge();

    const shown = await backend.showWebview("web-1", "https://example.com", { x: 0, y: 0, width: 10, height: 10 });
    assert.equal(shown.externalBrowser, true);
    assert.deepEqual(opened, [{ url: "https://example.com", name: "auri-web-web-1" }]);

    await backend.showWebview("web-1", "https://example.com", { x: 0, y: 0, width: 10, height: 10 });
    assert.equal(opened.length, 1, "the same URL reuses the already opened tab");

    await backend.closeWebview("web-1");
    assert.equal(tab.closed, true);

    globalThis.window.open = () => null;
    await assert.rejects(
      () => backend.showWebview("web-2", "https://blocked.example", { x: 0, y: 0, width: 10, height: 10 }),
      /pop-up/i
    );

    await assert.rejects(() => backend.webviewAction("web-1", "back"), /browser tab/i);
    assert.equal(await backend.hideWebviews(), undefined, "hide is a quiet no-op for external tabs");
  });
});

test("hosted web mode dispatches bridged events to registered listeners", async () => {
  await withBrowserGlobals(async () => {
    globalThis.window = {};
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: null }) });

    const backend = new Backend();
    await backend.connectHostedWebBridge();

    const seen = [];
    const off = await backend.listen("terminal-data", (payload) => seen.push(payload));
    backend.dispatchWebEvent("terminal-data", { sessionId: "s1", data: [104, 105] });
    assert.deepEqual(seen, [{ sessionId: "s1", data: [104, 105] }]);

    off();
    backend.dispatchWebEvent("terminal-data", { sessionId: "s1", data: [33] });
    assert.equal(seen.length, 1, "unlisten removes the handler");
  });
});
