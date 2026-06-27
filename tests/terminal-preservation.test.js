import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppView } from "../src/views/app-view.js";

function terminalHost(workspaceId) {
  return {
    dataset: { workspaceId },
    removed: false,
    remove() { this.removed = true; }
  };
}

test("AppView preserves the same terminal emulator host for each workspace", () => {
  const first = terminalHost("workspace-1");
  let current = first;
  let replacement = null;
  const placeholder = {
    replaceWith(value) { replacement = value; }
  };
  const root = {
    querySelector(selector) {
      if (selector === "#terminal-emulator") return current;
      return null;
    }
  };
  const view = new AppView(root);

  view.stashTerminalHost();
  assert.equal(first.removed, true);

  current = placeholder;
  const restored = view.restoreTerminalHost("workspace-1");
  assert.equal(restored, first);
  assert.equal(replacement, first);
});

test("TerminalSession reuses an already-mounted emulator and applies the configured scrollback", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  assert.match(source, /this\.mountedElement === element/);
  assert.match(source, /this\.term\.options\.scrollback = lineLimit/);
  assert.match(source, /scrollback: lineLimit/);
  assert.match(source, /async mount\(element, cwd = "~", fontSize = 20, maxLines = 4000\)/);
});

test("assistant transcript markers render as normal terminal text without decorations", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");

  assert.match(source, /terminalAssistantSegments\(message\)/);
  assert.match(source, /appendAssistantStream\(segment\.text\)/);
  assert.doesNotMatch(source, /assistant-highlight/);
  assert.doesNotMatch(source, /renderAssistantHighlight/);
  assert.doesNotMatch(source, /appendAssistantHighlight/);
});

test("programmatic terminal runs do not steal focus from the composer", async () => {
  const source = await readFile("src/services/terminal-session.js", "utf8");
  const runMethod = source.match(/async run\(command\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(runMethod, /this\.write\(`\$\{command\}\\r`\)/);
  assert.doesNotMatch(runMethod, /this\.focus\(\)/);
});
