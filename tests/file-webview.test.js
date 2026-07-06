import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Backend, previewMimeForPath } from "../src/services/backend.js";
import { captureFolderScroll } from "../src/views/app-view.js";

test("m4a files use the WebKit-compatible audio/mp4 MIME type", () => {
  assert.equal(previewMimeForPath("/tmp/test.m4a", "audio/x-m4a"), "audio/mp4");
  assert.equal(previewMimeForPath("/tmp/movie.mp4", "application/octet-stream"), "video/mp4");
  assert.equal(previewMimeForPath("/tmp/manual.pdf", "application/octet-stream"), "application/pdf");
});

test("folder scroll is preserved only while rendering the same directory", () => {
  const list = { dataset: { folderPath: "/same" }, scrollTop: 384 };
  const root = { querySelector: () => list };
  assert.equal(captureFolderScroll(root, "/same"), 384);
  assert.equal(captureFolderScroll(root, "/different"), 0);
});


test("folder scroll restoration happens before a following render can capture it", () => {
  const source = readFileSync(new URL("../src/views/app-view.js", import.meta.url), "utf8");
  const restore = source.indexOf('if (folder) folder.scrollTop = folderScrollTop;');
  const frame = source.indexOf('requestAnimationFrame(() => {', restore - 100);
  assert.ok(restore >= 0);
  assert.ok(frame > restore, "folder scroll must be restored synchronously before deferred work");
});

import { renderWebview } from "../src/views/panels.js";
import { createInitialState, reduceState } from "../src/model/state.js";

test("website tabs use a native webview host instead of an iframe", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const html = renderWebview(state, { native: true });
  assert.match(html, /id="native-webview-host"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /https:\/\/www\.google\.com\//);
});

test("website tabs never fall back to an iframe for real websites", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const html = renderWebview(state, { native: false });
  assert.match(html, /id="native-webview-host"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /browser-frame/);
});

test("linux website webviews are embedded child webviews, not top-level windows", () => {
  const rust = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/services/backend.js", import.meta.url), "utf8");
  const panels = readFileSync(new URL("../src/views/panels.js", import.meta.url), "utf8");

  assert.match(rust, /\.add_child\(/);
  assert.doesNotMatch(rust, /WebviewWindowBuilder/);
  assert.doesNotMatch(rust, /\.always_on_top\(true\)/);
  assert.doesNotMatch(backend, /supportsNativeChildWebviews/);
  assert.doesNotMatch(panels, /browser-frame/);
});


test("native inspection does not create a restricted asset URL for arbitrary files", async () => {
  const backend = new Backend();
  backend.invoke = async (command, payload) => ({
    path: payload.path,
    name: "output.m4a",
    kind: "audio"
  });
  const metadata = await backend.inspectFile("/Users/ecoo/Desktop/testmedia/output.m4a");
  assert.equal(metadata.assetUrl, undefined);
});

test("opened files render through a blob-backed HTML viewer app document", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const id = state.tabs[0].activeSubtabId;
  state = reduceState(state, {
    type: "SUBTAB_UPDATE",
    payload: { id, patch: { url: "blob:auri-media-page", filePath: "/tmp/test.m4a", fileMime: "text/html" } }
  });
  const html = renderWebview(state);
  assert.match(html, /data="blob:auri-media-page"/);
  assert.match(html, /type="text\/html"/);
  assert.doesNotMatch(html, /data="\/tmp\/test\.m4a"/);
});


test("native large video preview streams from the file URL without reading the whole file", async () => {
  const previousWindow = globalThis.window;
  const previousUrl = globalThis.URL;
  const objectUrls = [];
  globalThis.window = {
    navigator: { platform: "MacIntel", userAgent: "Auri macOS" },
    __TAURI__: { core: { convertFileSrc: (path) => `asset://${path}` } }
  };
  globalThis.URL = {
    createObjectURL(value) {
      objectUrls.push(value);
      return `blob:viewer-${objectUrls.length}`;
    },
    revokeObjectURL() {}
  };
  try {
    const backend = new Backend();
    const calls = [];
    backend.invoke = async (command, payload) => {
      calls.push({ command, payload });
      if (command === "read_binary_file") throw new Error("read_binary_file should not be used for video preview");
      return {};
    };

    const view = await backend.createFileView("/tmp/huge.mp4", { name: "huge.mp4", mime: "video/mp4", size: 2_000_000_000 });

    assert.equal(view.title, "huge.mp4");
    assert.equal(view.mediaMime, "video/mp4");
    assert.equal(view.viewerKind, "video");
    assert.deepEqual(calls, []);
    const html = await objectUrls[0].text();
    assert.match(html, /asset:\/\/\/tmp\/huge\.mp4/);
    assert.doesNotMatch(html, /base64/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.URL = previousUrl;
  }
});

test("linux media previews avoid asset range requests by using a blob resource", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousUrl = globalThis.URL;
  const objectUrls = [];
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "Auri Linux" }, configurable: true });
  globalThis.window = {
    navigator: { platform: "Linux x86_64", userAgent: "Auri Linux" },
    __TAURI__: { core: { convertFileSrc: (path) => `asset://${path}` } }
  };
  globalThis.URL = {
    createObjectURL(value) {
      objectUrls.push(value);
      return `blob:viewer-${objectUrls.length}`;
    },
    revokeObjectURL() {}
  };
  try {
    const backend = new Backend();
    const calls = [];
    backend.invoke = async (command, payload) => {
      calls.push({ command, payload });
      if (command === "read_binary_file") {
        return { path: payload.path, name: "test.m4a", mime: "audio/mp4", base64: "AAAA" };
      }
      return {};
    };

    const view = await backend.createFileView("/home/a/Desktop/test.m4a", { name: "test.m4a", mime: "audio/mp4" });

    assert.equal(view.viewerKind, "audio");
    assert.deepEqual(calls, [{ command: "read_binary_file", payload: { path: "/home/a/Desktop/test.m4a" } }]);
    const html = await objectUrls[1].text();
    assert.match(html, /blob:viewer-1/);
    assert.doesNotMatch(html, /asset:\/\/\/home\/a\/Desktop\/test\.m4a/);
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    globalThis.URL = previousUrl;
  }
});

test("custom audio viewer controls catch unsupported play promises", () => {
  const source = readFileSync(new URL("../src/services/file-viewer-page.js", import.meta.url), "utf8");

  assert.match(source, /function playMedia\(mediaElement\)/);
  assert.match(source, /mediaElement\.play\(\)\?\.catch/);
  assert.doesNotMatch(source, /audio\.paused \? audio\.play\(\) : audio\.pause\(\)/);
});


test("desktop media files are inside the Tauri asset protocol scope", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const scope = config.app?.security?.assetProtocol?.scope || [];

  assert.equal(config.app?.security?.assetProtocol?.enable, true);
  assert.ok(scope.includes("$HOME/Desktop/**"), "Desktop files should be readable through asset://localhost for previews");
  assert.ok(scope.includes("$HOME/Downloads/**"), "Downloads should keep common opened media previewable");
  assert.ok(scope.includes("$HOME/Movies/**"), "Movies should keep common video previews streamable");
});

test("file webview object is sized as an embedded app surface", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const id = state.tabs[0].activeSubtabId;
  state = reduceState(state, {
    type: "SUBTAB_UPDATE",
    payload: { id, patch: { url: "blob:auri-file-viewer", filePath: "/tmp/manual.pdf", fileMime: "text/html" } }
  });

  const html = renderWebview(state);
  assert.match(html, /class="file-web-object"/);
  assert.match(html, /blob:auri-file-viewer/);
});
