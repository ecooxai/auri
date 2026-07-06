import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewClipboardText, serializeClipboardEntry } from "../src/model/clipboard.js";

test("short clipboard text stays intact", () => {
  assert.equal(previewClipboardText("hello"), "hello");
});

test("long clipboard text renders the first 100 and last 50 characters", () => {
  const value = "a".repeat(150) + "b".repeat(150);
  const preview = previewClipboardText(value);
  assert.equal(preview.length, 153);
  assert.equal(preview, "a".repeat(100) + "…\n…" + "b".repeat(50));
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

test("clipboard previews keep 150 characters and shorten longer text to 100 head plus 50 tail", () => {
  const exact = "x".repeat(150);
  assert.equal(previewClipboardText(exact), exact);

  const value = "a".repeat(100) + "middle" + "b".repeat(50);
  assert.equal(previewClipboardText(value), "a".repeat(100) + "…\n…" + "b".repeat(50));
});

test("clipboard cards expose paste only on their content and use a separate actions menu", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-1", kind: "text", text: "Paste me", createdAt: 1, pinned: true }] }
  });
  state = reduceState(state, { type: "UI_SET", payload: { clipboardMenuId: "clip-1" } });

  const html = renderClipboard(state);
  assert.doesNotMatch(html, />HISTORY</);
  assert.doesNotMatch(html, /↙/);
  assert.doesNotMatch(html, /<article[^>]+data-action="clipboard-insert"/);
  assert.match(html, /class="clipboard-content[^\"]*"[^>]+data-action="clipboard-insert"/);
  assert.match(html, /data-action="clipboard-menu"/);
  assert.match(html, /data-action="clipboard-unpin"/);
  assert.match(html, /data-action="clipboard-remove"/);
  assert.ok(html.indexOf('data-action="clipboard-filter-pinned"') < html.indexOf('data-action="clipboard-refresh"'));
});

test("clipboard pinned filter renders only pinned entries", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [
      { id: "pinned", kind: "text", text: "keep", createdAt: 2, pinned: true },
      { id: "regular", kind: "text", text: "hide", createdAt: 1, pinned: false }
    ] }
  });
  state = reduceState(state, { type: "UI_SET", payload: { clipboardPinnedOnly: true } });

  const html = renderClipboard(state);
  assert.match(html, /data-id="pinned"/);
  assert.doesNotMatch(html, /data-id="regular"/);
  assert.match(html, /Show all clipboard items/);
});

test("clipboard panel renders 50 items per page with previous and next controls", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: `clip-${index + 1}`,
    kind: "text",
    text: `item ${index + 1}`,
    createdAt: index + 1,
    pinned: false
  }));
  let state = createInitialState();
  state = reduceState(state, { type: "CLIPBOARD_SET", payload: { items } });
  state = reduceState(state, { type: "UI_SET", payload: { clipboardPage: 1 } });

  const html = renderClipboard(state);

  assert.match(html, /data-action="clipboard-page-prev"/);
  assert.match(html, /data-action="clipboard-page-next"/);
  assert.match(html, /Page 2 \/ 3/);
  assert.doesNotMatch(html, /data-id="clip-50"/);
  assert.match(html, /data-id="clip-51"/);
  assert.match(html, /data-id="clip-100"/);
  assert.doesNotMatch(html, /data-id="clip-101"/);
});

test("native clipboard history uses sha256 fingerprints and moves duplicate entries to the top", () => {
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  const readStart = clipboard.indexOf("pub fn read_history");
  const readEnd = clipboard.indexOf("pub fn set_text", readStart);
  const implementation = clipboard.slice(readStart, readEnd);

  assert.match(clipboard, /Sha256/);
  assert.doesNotMatch(clipboard, /DefaultHasher/);
  assert.match(implementation, /entries\s*\.iter\(\)\s*\.position\(\|entry\| entry\.fingerprint\.as_deref\(\) == Some\(fingerprint\.as_str\(\)\)\)/);
  assert.match(implementation, /let mut existing = entries\.remove\(duplicate_index\)/);
  assert.match(implementation, /existing\.created_at = now/);
  assert.match(implementation, /entries\.insert\(0, existing\)/);
});

test("native clipboard history uses a 1000-item soft limit and removes evicted image files", () => {
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  assert.match(clipboard, /const MAX_HISTORY_ITEMS: usize = 1000/);
  assert.match(clipboard, /remove_entry_image/);
  assert.match(clipboard, /fs::remove_file/);
  assert.doesNotMatch(clipboard, /entries\.truncate\(200\)/);
});

test("native clipboard polling and writes run off the Tauri command thread", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /async fn read_clipboard_history\(\)/);
  assert.match(lib, /spawn_blocking\(\|\| clipboard::read_history\(\)\)/);
  assert.match(lib, /async fn set_clipboard_text\(text: String\)/);
  assert.match(lib, /spawn_blocking\(move \|\| clipboard::set_text\(&text\)\)/);
});

test("clipboard retention never falls back to deleting a pinned item", () => {
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  const start = clipboard.indexOf("fn enforce_history_limit");
  const end = clipboard.indexOf("fn read_ignored_fingerprint", start);
  const implementation = clipboard.slice(start, end);
  assert.match(implementation, /rposition\(\|entry\| !entry\.pinned\)/);
  assert.match(implementation, /else \{\s*break;\s*\}/);
  assert.doesNotMatch(implementation, /unwrap_or\(entries\.len\(\) - 1\)/);
});


test("clipboard scroll position is captured for menu-state re-renders", async () => {
  const { captureClipboardScroll } = await import("../src/views/app-view.js");
  const grid = { scrollTop: 728 };
  const root = { querySelector: (selector) => selector === ".clipboard-grid" ? grid : null };
  assert.equal(captureClipboardScroll(root), 728);
  assert.equal(captureClipboardScroll({ querySelector: () => null }), 0);
});


test("clipboard scroll is restored synchronously after the app HTML is replaced", () => {
  const source = readFileSync(new URL("../src/views/app-view.js", import.meta.url), "utf8");
  const capture = source.indexOf("const clipboardScrollTop = captureClipboardScroll(this.root);");
  const replace = source.indexOf("this.root.innerHTML =", capture);
  const restore = source.indexOf("clipboard.scrollTop = clipboardScrollTop", replace);
  const frame = source.indexOf("requestAnimationFrame(() => {", restore);
  assert.ok(capture >= 0 && capture < replace, "clipboard scroll must be captured before replacing the DOM");
  assert.ok(restore > replace, "clipboard scroll must be restored after replacing the DOM");
  assert.ok(frame > restore, "clipboard scroll must be restored synchronously before deferred work");
});
