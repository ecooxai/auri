import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { terminalFocusZone } from "../src/views/app-view.js";

function fakeTarget(id, ancestors = []) {
  const chain = new Set([id && `#${id}`, ...ancestors].filter(Boolean));
  return {
    id: id || "",
    closest: (selector) => (chain.has(selector) ? {} : null)
  };
}

test("focus zone classifier separates the emulator screen from the composer input", () => {
  assert.equal(terminalFocusZone(fakeTarget("terminal-input")), "composer");
  assert.equal(terminalFocusZone(fakeTarget("", ["#terminal-input"])), "composer");
  assert.equal(terminalFocusZone(fakeTarget("", ["#terminal-emulator"])), "screen");
  assert.equal(terminalFocusZone(fakeTarget("other-field")), null, "unrelated fields do not change the remembered zone");
  assert.equal(terminalFocusZone(null), null);
  assert.equal(terminalFocusZone({}), null, "targets without closest (window) are ignored");
});

test("switching back to a terminal restores the zone that was focused last", async () => {
  const controller = await readFile("src/controllers/app-controller.js", "utf8");
  // The controller remembers the last focused terminal zone from focusin…
  assert.match(controller, /addEventListener\("focusin", \(event\) => \{[^}]*terminalFocusZone\(event\.target\)/s);
  assert.match(controller, /this\.terminalFocusZone = zone/);
  // …and a focusTerminal render restores the composer when it was last active,
  // the emulator screen otherwise.
  assert.match(controller, /this\.terminalFocusZone === "composer"[\s\S]{0,120}getTerminalInput\?\.\(\)\?\.focus/);
  assert.match(controller, /if \(options\.focusTerminal && !this\.isTerminalComposerFocused\(\)\) session\.focus\?\.\(\)/);
});

test("subtab switches landing on a terminal focus it, not only workspace switches", async () => {
  const controller = await readFile("src/controllers/app-controller.js", "utf8");
  const condition = controller.match(/const shouldFocusTerminal = Boolean\(([\s\S]*?)\);/)?.[1] || "";
  assert.match(condition, /SUBTAB_SWITCH_EVENTS\.has\(event\.type\) && activeSubtab\(this\.state\)\?\.type === "terminal"/);
});
