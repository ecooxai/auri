import test from "node:test";
import assert from "node:assert/strict";
import { previewMimeForPath } from "../src/services/backend.js";
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

import { renderWebview } from "../src/views/panels.js";
import { createInitialState, reduceState } from "../src/model/state.js";

test("website tabs use a native webview host instead of an iframe", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const html = renderWebview(state);
  assert.match(html, /id="native-webview-host"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /https:\/\/www\.google\.com\//);
});
