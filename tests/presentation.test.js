import test from "node:test";
import assert from "node:assert/strict";
import { classifyTerminalInput, formatBytes, iconForEntry, workspaceLabel } from "../src/model/presentation.js";

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

test("workspace labels use only the current folder basename", () => {
  assert.equal(workspaceLabel({ title: "Home", folder: { path: "/Users/auri/Desktop" } }), "Desktop");
  assert.equal(workspaceLabel({ title: "Space 2", folder: { path: "/Users/auri/Projects/" } }), "Projects");
});

test("workspace labels preserve a sensible title when no concrete folder is selected", () => {
  assert.equal(workspaceLabel({ title: "Home", folder: { path: "~" } }), "Home");
  assert.equal(workspaceLabel({ title: "Research", folder: { path: "" } }), "Research");
});
