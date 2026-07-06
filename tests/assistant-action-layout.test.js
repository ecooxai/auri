import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("assistant action popup is rendered inside the terminal content pane", async () => {
  const source = await readFile("src/views/app-view.js", "utf8");
  assert.ok(source.includes('<div class="content-pane">${renderActivePanel(state, { native: nativeWebview })}${renderAssistantTranscriptPopup(state)}</div>'));
  assert.doesNotMatch(source, /renderWebOverlay[^\n]*\n\s*\$\{renderAssistantTranscriptPopup\(state\)\}/);
});

test("assistant action popup is compact and positioned above the center of terminal content", async () => {
  const css = await readFile("styles.css", "utf8");
  assert.match(css, /\.content-pane\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.assistant-transcript-popup\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.assistant-transcript-popup\s*\{[^}]*left:\s*50%/s);
  assert.match(css, /\.assistant-transcript-popup\s*\{[^}]*top:\s*(?:3[5-9]|4[0-4])%/s);
  assert.match(css, /\.assistant-transcript-popup\s*\{[^}]*translate\(-50%,\s*-50%\)/s);
  assert.match(css, /\.assistant-transcript-popup\s*\{[^}]*width:\s*min\((?:4[0-8]0)px/s);
});
