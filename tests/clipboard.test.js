import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewClipboardText, serializeClipboardEntry } from "../src/model/clipboard.js";

test("short clipboard text stays intact", () => {
  assert.equal(previewClipboardText("hello"), "hello");
});

test("long clipboard text renders only first and last 100 characters", () => {
  const value = "a".repeat(150) + "b".repeat(150);
  const preview = previewClipboardText(value);
  assert.equal(preview.length, 203);
  assert.equal(preview, "a".repeat(100) + "…\n…" + "b".repeat(100));
});

test("clipboard entries use the requested text/image JSON representation", () => {
  assert.deepEqual(serializeClipboardEntry({ kind: "text", text: "hi" }), { text: "hi" });
  assert.deepEqual(serializeClipboardEntry({ kind: "image", path: "/home/me/auri/media/picture/a.png" }), {
    image: "/home/me/auri/media/picture/a.png"
  });
});

test("clipboard panel renders captured image thumbnails as pasteable cards", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "clipboard" } });
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "image-1", kind: "image", path: "/tmp/image.png", assetUrl: "asset://image.png", createdAt: 1 }] }
  });
  const html = renderClipboard(state);
  assert.match(html, /class="clipboard-image"/);
  assert.match(html, /src="asset:\/\/image\.png"/);
  assert.match(html, /data-action="clipboard-insert"/);
});

test("native paste-back keeps Auri visible and switches apps before pasting", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  const commandStart = lib.indexOf("fn paste_clipboard_entry");
  const commandEnd = lib.indexOf("#[tauri::command]", commandStart + 10);
  const command = lib.slice(commandStart, commandEnd);
  assert.doesNotMatch(command, /\.hide\(/);
  assert.doesNotMatch(command, /\.minimize\(/);
  assert.match(command, /focus_previous_and_paste/);
  assert.match(clipboard, /key code 48 using command down/);
  assert.match(clipboard, /delay 0\.5/);
  assert.match(clipboard, /keystroke \\"v\\" using command down/);
});
