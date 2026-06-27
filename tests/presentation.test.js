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


test("audio metadata groups type with codec and size with bitrate", async () => {
  const { renderViewer } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, { type: "FILE_SELECT", payload: { path: "/tmp/song.wav", open: false, metadata: { name: "song.wav", kind: "audio", fileType: "WAV", codec: "pcm_s16le", size: 48000, bitrate: 1536000, sampleRate: 48000 } } });

  const html = renderViewer(state);

  assert.match(html, /Type · Codec/);
  assert.match(html, /WAV · pcm_s16le/);
  assert.match(html, /Size · Bitrate/);
  assert.match(html, /1536 kbps/);
  assert.match(html, /Sample rate/);
  assert.match(html, /48 kHz/);
});
