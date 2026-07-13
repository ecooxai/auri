import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewClipboardText, serializeClipboardEntry, formatByteSize, formatImageMeta, describeClipboardText } from "../src/model/clipboard.js";

test("short clipboard text stays intact", () => {
  assert.equal(previewClipboardText("hello"), "hello");
});

test("long clipboard text renders the first 100 and last 50 characters", () => {
  const value = "a".repeat(150) + "b".repeat(150);
  const preview = previewClipboardText(value);
  assert.equal(preview.length, 153);
  assert.equal(preview, "a".repeat(100) + "…\n…" + "b".repeat(50));
});

test("byte sizes render with human-friendly units", () => {
  assert.equal(formatByteSize(512), "512 B");
  assert.equal(formatByteSize(102400), "100 KB");
  assert.equal(formatByteSize(1843200), "1.8 MB");
  assert.equal(formatByteSize(0), "0 B");
  assert.equal(formatByteSize(null), "");
  assert.equal(formatByteSize(-1), "");
});

test("image metadata badge shows type, resolution, and size and drops unknown parts", () => {
  assert.equal(
    formatImageMeta({ format: "png", width: 1280, height: 720, byteSize: 102400 }),
    "PNG · 1280×720 · 100 KB"
  );
  assert.equal(formatImageMeta({ path: "/tmp/shot.JPG", width: 640, height: 480 }), "JPG · 640×480");
  assert.equal(formatImageMeta({ width: 0, height: 0 }), "");
});

test("text description counts bytes, characters, words, and lines", () => {
  assert.deepEqual(describeClipboardText("hello world"), { bytes: 11, chars: 11, words: 2, lines: 1 });
  assert.deepEqual(describeClipboardText("a\nb\nc"), { bytes: 5, chars: 5, words: 3, lines: 3 });
  assert.deepEqual(describeClipboardText(""), { bytes: 0, chars: 0, words: 0, lines: 0 });
  // Multi-byte characters count as one character but their real UTF-8 byte length.
  assert.deepEqual(describeClipboardText("café ☕"), { bytes: 9, chars: 6, words: 2, lines: 1 });
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

test("native paste-back keeps Auri visible, preserves Linux clipboard ownership, and reports paste failures", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  const commandStart = lib.indexOf("fn paste_clipboard_entry");
  const commandEnd = lib.indexOf("#[tauri::command]", commandStart + 10);
  const command = lib.slice(commandStart, commandEnd);
  assert.doesNotMatch(command, /\.hide\(/);
  assert.doesNotMatch(command, /\.minimize\(/);
  assert.match(command, /spawn_blocking/);
  assert.match(command, /focus_previous_and_paste/);
  assert.doesNotMatch(command, /std::thread::spawn/);
  assert.doesNotMatch(command, /let _ = clipboard::focus_previous_and_paste/);
  assert.match(clipboard, /OnceLock<Mutex<Clipboard>>/);
  assert.match(clipboard, /persistent_clipboard/);
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

test("clipboard item menu offers copy for all items and edit for text items", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [
      { id: "clip-text", kind: "text", text: "hello", createdAt: 2, pinned: false },
      { id: "clip-image", kind: "image", path: "/tmp/a.png", assetUrl: "asset://a.png", createdAt: 1, pinned: false }
    ] }
  });

  let html = renderClipboard(reduceState(state, { type: "UI_SET", payload: { clipboardMenuId: "clip-text" } }));
  assert.match(html, /data-action="clipboard-copy-item" data-id="clip-text"/);
  assert.match(html, /data-action="clipboard-edit" data-id="clip-text"/);

  html = renderClipboard(reduceState(state, { type: "UI_SET", payload: { clipboardMenuId: "clip-image" } }));
  assert.match(html, /data-action="clipboard-copy-item" data-id="clip-image"/);
  assert.doesNotMatch(html, /data-action="clipboard-edit" data-id="clip-image"/);
});

test("image cards show a type/resolution/size badge and the menu offers Info", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "img-1", kind: "image", path: "/tmp/a.png", assetUrl: "asset://a.png", createdAt: 1, format: "png", width: 1280, height: 720, byteSize: 102400 }] }
  });

  let html = renderClipboard(state);
  assert.match(html, /class="clipboard-image-badge"[^>]*>PNG · 1280×720 · 100 KB</);

  html = renderClipboard(reduceState(state, { type: "UI_SET", payload: { clipboardMenuId: "img-1" } }));
  assert.match(html, /data-action="clipboard-info" data-id="img-1"/);
});

test("clipboard info popup shows text stats and image details", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [
      { id: "clip-text", kind: "text", text: "one two\nthree", createdAt: 2, pinned: false },
      { id: "clip-image", kind: "image", path: "/tmp/a.png", assetUrl: "asset://a.png", createdAt: 1, format: "png", width: 640, height: 480, byteSize: 2048 }
    ] }
  });

  let html = renderClipboard(reduceState(state, { type: "UI_SET", payload: { clipboardInfoId: "clip-text" } }));
  assert.match(html, /class="clipboard-info-popup"/);
  assert.match(html, /Characters<\/span><strong>13/);
  assert.match(html, /Words<\/span><strong>3/);
  assert.match(html, /Lines<\/span><strong>2/);
  assert.match(html, /data-action="clipboard-info-close"/);

  html = renderClipboard(reduceState(state, { type: "UI_SET", payload: { clipboardInfoId: "clip-image" } }));
  assert.match(html, /Resolution<\/span><strong>640 × 480/);
  assert.match(html, /Type<\/span><strong>PNG/);
  assert.match(html, /data-action="clipboard-copy-path"/);
  assert.match(html, /data-value="\/tmp\/a\.png"/);
  assert.match(html, />\/tmp\/a\.png<\/button>/);
});

test("clipboard info command opens the panel and marks the item for its info popup", async () => {
  const { executeCommand } = await import("../src/controllers/command-controller.js");
  const { createInitialState, reduceState, activeSubtab } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-1", kind: "text", text: "hi", createdAt: 1, pinned: false }] }
  });
  const context = {
    getState: () => state,
    dispatch: (action) => { state = reduceState(state, action); },
    backend: {},
    actions: {}
  };

  const result = await executeCommand("clipboard info clip-1", context);
  assert.deepEqual(result, { info: "clip-1" });
  assert.equal(state.ui.clipboardInfoId, "clip-1");
  assert.equal(activeSubtab(state).type, "clipboard");

  await assert.rejects(executeCommand("clipboard info missing", context), /Clipboard item was not found/);
});

test("clipboard edit mode renders a textarea with save and cancel controls", async () => {
  const { renderClipboard } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-1", kind: "text", text: "editable text", createdAt: 1, pinned: false }] }
  });
  state = reduceState(state, { type: "UI_SET", payload: { clipboardEditId: "clip-1" } });

  const html = renderClipboard(state);
  assert.match(html, /<textarea class="clipboard-edit-input" data-id="clip-1"[^>]*>editable text<\/textarea>/);
  assert.match(html, /data-action="clipboard-edit-save" data-id="clip-1"/);
  assert.match(html, /data-action="clipboard-edit-cancel" data-id="clip-1"/);
});

test("clipboard edit and copy-item commands route through the backend", async () => {
  const { executeCommand } = await import("../src/controllers/command-controller.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, {
    type: "CLIPBOARD_SET",
    payload: { items: [{ id: "clip-1", kind: "text", text: "before", createdAt: 1, pinned: false }] }
  });
  const calls = [];
  const context = {
    getState: () => state,
    dispatch: (action) => { state = reduceState(state, action); },
    backend: {
      updateClipboardItem: async (id, text) => { calls.push(["update", id, text]); return [{ id, kind: "text", text, createdAt: 1, pinned: false }]; },
      copyClipboardItem: async (id) => { calls.push(["copy", id]); }
    },
    actions: {}
  };

  await executeCommand('clipboard edit clip-1 "line one\nline two"', context);
  assert.deepEqual(calls[0], ["update", "clip-1", "line one\nline two"]);
  assert.equal(state.clipboard.items[0].text, "line one\nline two");

  await executeCommand("clipboard copy-item clip-1", context);
  assert.deepEqual(calls[1], ["copy", "clip-1"]);
});

test("linux paste-back supports wayland (wtype), x11 (xdotool), and ydotool fallbacks", () => {
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  assert.match(clipboard, /WAYLAND_DISPLAY/);
  assert.match(clipboard, /wtype/);
  assert.match(clipboard, /xdotool/);
  assert.match(clipboard, /ydotool/);
  assert.match(clipboard, /update_entry_text/);
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

test("native clipboard entries carry image type, resolution, and size metadata", () => {
  const clipboard = readFileSync(new URL("../src-tauri/src/core/clipboard.rs", import.meta.url), "utf8");
  // Persisted entry keeps optional image metadata that serializes as camelCase JSON.
  assert.match(clipboard, /pub width: Option<u32>/);
  assert.match(clipboard, /pub height: Option<u32>/);
  assert.match(clipboard, /pub byte_size: Option<u64>/);
  assert.match(clipboard, /pub format: Option<String>/);
  // Copied image files preserve their original encoded bytes and extension;
  // decoded pixel-only clipboard images use PNG as the lossless fallback.
  assert.match(clipboard, /width: Some\(width as u32\)/);
  assert.match(clipboard, /byte_size = fs::metadata\(&image_path\)/);
  assert.match(clipboard, /clipboard\.get\(\)\.file_list\(\)/);
  assert.match(clipboard, /fs::write\(&image_path, bytes\)/);
  assert.match(clipboard, /format: Some\(extension\)/);
  assert.match(clipboard, /extension: "png"\.to_string\(\)/);
  // Older entries are backfilled from the saved file on read.
  assert.match(clipboard, /fn backfill_image_metadata/);
  assert.match(clipboard, /image::image_dimensions\(&path\)/);
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
