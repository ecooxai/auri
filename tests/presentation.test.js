import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, iconForEntry, classifyTerminalInput } from "../src/model/presentation.js";

test("formats file sizes for the metadata viewer", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
});

test("uses dependable unicode symbols by file kind", () => {
  assert.equal(iconForEntry({ kind: "directory" }), "▸");
  assert.equal(iconForEntry({ kind: "image" }), "◈");
  assert.equal(iconForEntry({ kind: "text" }), "≡");
});

test("only public auri-prefixed terminal input is treated as an internal command", () => {
  assert.equal(classifyTerminalInput("auri tab new"), "auri");
  assert.equal(classifyTerminalInput("tab new"), "shell");
  assert.equal(classifyTerminalInput("  auri info show"), "auri");
});
