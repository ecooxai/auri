import test from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/controllers/app-controller.js";
import { activeSubtab, activeWorkspace, reduceState } from "../src/model/state.js";

const HOST_RECT = { left: 120, top: 90, width: 660, height: 520, right: 780, bottom: 610 };

function makeHarness({ webviewSleepDelayMs = 5, wakeUrl = null } = {}) {
  const calls = [];
  const toasts = [];
  const host = { getBoundingClientRect: () => HOST_RECT, closest: () => null };
  const view = {
    root: { querySelector: (selector) => selector === "#native-webview-host" ? host : null },
    render() {},
    getTerminalInputValue: () => "",
    showToast(message, level) { toasts.push({ message, level }); }
  };
  const backend = {
    isNative: true,
    showWebview: async (id, url, bounds, navigate) => calls.push(["show", id, url, navigate]),
    hideWebviews: async () => calls.push(["hide-all"]),
    closeWebview: async (id) => calls.push(["close", id]),
    webviewAction: async (id, action, value) => calls.push(["action", id, action, value]),
    sleepWebview: async (id, url) => {
      calls.push(["sleep", id, url]);
      return { id, url, sleptAtMs: Date.now() };
    },
    wakeWebview: async (id) => {
      calls.push(["wake", id]);
      return wakeUrl ? { id, url: wakeUrl, sleptAtMs: 1 } : null;
    }
  };
  const controller = new AppController({
    view,
    backend,
    terminalSessionFactory: () => ({ initialize: async () => {} }),
    webviewSleepDelayMs
  });
  return { controller, calls, toasts };
}

async function withBackgroundWebview(harness) {
  const { controller } = harness;
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const webviewId = activeSubtab(controller.state).id;
  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "terminal" } });
  await controller.syncNativeWebview();
  return webviewId;
}

function waitFor(condition, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("Timed out waiting for condition."));
      setTimeout(check, 5);
    };
    check();
  });
}

test("a web tab left in the background sleeps to disk after the delay and shows a toast", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 5 });
  const { controller, calls, toasts } = harness;
  const webviewId = await withBackgroundWebview(harness);

  assert.equal(controller.webviewSleepTimers.has(webviewId), true);
  await waitFor(() => calls.some(([kind]) => kind === "sleep"));

  const sleep = calls.find(([kind]) => kind === "sleep");
  assert.equal(sleep[1], webviewId);
  assert.match(sleep[2], /^https?:\/\//);
  assert.equal(controller.nativeWebviewUrls.has(webviewId), false);
  assert.equal(controller.sleptWebviews.has(webviewId), true);
  assert.ok(toasts.some(({ message }) => /slept to disk/i.test(message)));
});

test("reselecting the web tab before the delay cancels the scheduled sleep", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller, calls } = harness;
  const webviewId = await withBackgroundWebview(harness);
  assert.equal(controller.webviewSleepTimers.has(webviewId), true);

  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: webviewId } });
  await controller.syncNativeWebview();

  assert.equal(controller.webviewSleepTimers.size, 0);
  assert.equal(calls.some(([kind]) => kind === "sleep"), false);
  assert.equal(controller.sleptWebviews.size, 0);
});

test("reopening a slept web tab restores it from disk, reapplies zoom, and shows a toast", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000, wakeUrl: "https://woken.example.com/page" });
  const { controller, calls, toasts } = harness;
  const webviewId = await withBackgroundWebview(harness);
  controller.state = reduceState(controller.state, { type: "SUBTAB_UPDATE", payload: { id: webviewId, patch: { zoom: 1.5 } } });
  await controller.sleepWebview(webviewId);
  assert.equal(controller.sleptWebviews.has(webviewId), true);
  calls.length = 0;

  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: webviewId } });
  await controller.syncNativeWebview();

  assert.ok(calls.find(([kind]) => kind === "wake"));
  const show = calls.find(([kind]) => kind === "show");
  assert.equal(show[1], webviewId);
  assert.equal(show[2], "https://woken.example.com/page");
  assert.equal(show[3], true);
  const zoom = calls.find(([kind, , action]) => kind === "action" && action === "zoom");
  assert.equal(zoom[3], 1.5);
  assert.equal(controller.sleptWebviews.has(webviewId), false);
  assert.equal(controller.webviewSleepTimers.has(webviewId), false);
  assert.ok(toasts.some(({ message }) => /restored from disk/i.test(message)));
  assert.equal(activeSubtab(controller.state).url, "https://woken.example.com/page");
});

test("sleeping records the live URL on the subtab so the workspace persists it", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller } = harness;
  const webviewId = await withBackgroundWebview(harness);
  controller.nativeWebviewUrls.set(webviewId, "https://moved.example.com/live");

  await controller.sleepWebview(webviewId);

  const subtab = activeWorkspace(controller.state).subtabs.find((item) => item.id === webviewId);
  assert.equal(subtab.url, "https://moved.example.com/live");
});

test("closing a slept subtab discards its saved state without waking it", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller, calls } = harness;
  const webviewId = await withBackgroundWebview(harness);
  await controller.sleepWebview(webviewId);
  calls.length = 0;

  controller.dispatch({ type: "SUBTAB_CLOSE", payload: { id: webviewId } });

  assert.equal(controller.sleptWebviews.size, 0);
  assert.equal(controller.webviewSleepTimers.size, 0);
  assert.ok(calls.find(([kind]) => kind === "close"));
  assert.equal(calls.some(([kind]) => kind === "wake"), false);
});

test("file viewer web tabs never sleep because they can hold unsaved editor state", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 5 });
  const { controller, calls } = harness;
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const webviewId = activeSubtab(controller.state).id;
  controller.state = reduceState(controller.state, { type: "SUBTAB_UPDATE", payload: { id: webviewId, patch: { filePath: "/tmp/example.txt" } } });
  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "terminal" } });
  await controller.syncNativeWebview();

  assert.equal(controller.webviewSleepTimers.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.some(([kind]) => kind === "sleep"), false);
});

test("web tab toasts render through the native overlay when a website covers the UI", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller, calls } = harness;
  controller.backend.showBrowserOverlay = async (payload, bounds, focus) => calls.push(["overlay", payload, bounds, focus]);
  controller.backend.hideBrowserOverlay = async () => calls.push(["overlay-hide"]);
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const first = activeSubtab(controller.state).id;
  await controller.syncNativeWebview();
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  await controller.syncNativeWebview();

  await controller.sleepWebview(first);

  assert.match(controller.state.ui.webToast?.message || "", /slept to disk/i);
  await controller.syncNativeWebview();
  const overlay = calls.filter(([kind]) => kind === "overlay").at(-1);
  assert.equal(overlay[1].mode, "toast");
  assert.match(overlay[1].message, /slept to disk/i);
  assert.equal(overlay[3], false);
  assert.ok(overlay[2].y > HOST_RECT.top);

  controller.clearWebToast();
  assert.equal(controller.state.ui.webToast, null);
});

test("restore toasts also use the overlay because the restored website hides the DOM toast", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000, wakeUrl: "https://woken.example.com/" });
  const { controller, calls } = harness;
  controller.backend.showBrowserOverlay = async (payload, bounds, focus) => calls.push(["overlay", payload, bounds, focus]);
  controller.backend.hideBrowserOverlay = async () => calls.push(["overlay-hide"]);
  const webviewId = await withBackgroundWebview(harness);
  await controller.sleepWebview(webviewId);
  controller.clearWebToast();
  calls.length = 0;

  controller.state = reduceState(controller.state, { type: "SUBTAB_SELECT", payload: { id: webviewId } });
  await controller.syncNativeWebview();

  const overlay = calls.filter(([kind]) => kind === "overlay").at(-1);
  assert.equal(overlay[1].mode, "toast");
  assert.match(overlay[1].message, /restored from disk/i);
  assert.equal(overlay[3], false);
});

test("toasts stay off the overlay when no website is covering the UI", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller, toasts } = harness;
  const webviewId = await withBackgroundWebview(harness);

  await controller.sleepWebview(webviewId);

  assert.equal(controller.state.ui.webToast ?? null, null);
  assert.ok(toasts.some(({ message }) => /slept to disk/i.test(message)));
});

test("moving a web tab to a standalone window closes its embedded webview", async () => {
  const harness = makeHarness({ webviewSleepDelayMs: 60_000 });
  const { controller, calls } = harness;
  controller.backend.showStandaloneTab = async (...args) => calls.push(["standalone", ...args]);
  controller.state = reduceState(controller.state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const webviewId = activeSubtab(controller.state).id;
  await controller.syncNativeWebview();
  assert.equal(controller.nativeWebviewUrls.has(webviewId), true);

  await controller.moveSubtabToWindow(webviewId);

  assert.ok(calls.find(([kind]) => kind === "standalone"));
  assert.ok(calls.find(([kind, id]) => kind === "close" && id === webviewId));
  assert.equal(controller.nativeWebviewUrls.has(webviewId), false);
  assert.equal(controller.webviewSleepTimers.has(webviewId), false);
});
