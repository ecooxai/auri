import test from "node:test";
import assert from "node:assert/strict";
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
