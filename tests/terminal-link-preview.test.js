import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  extractTerminalPreviewTarget,
  terminalPreviewPlacement
} from "../src/services/terminal-session.js";

test("terminal preview parser finds URLs and paths inside surrounding text", () => {
  assert.deepEqual(
    extractTerminalPreviewTarget("download https://example.com/image.png, then continue", "/tmp"),
    { kind: "url", value: "https://example.com/image.png", text: "https://example.com/image.png" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget("created /tmp/test.png)", "/work"),
    { kind: "file", value: "/tmp/test.png", text: "/tmp/test.png" }
  );
});

test("terminal preview parser resolves relative paths against the terminal cwd", () => {
  assert.deepEqual(
    extractTerminalPreviewTarget("preview ./images/test.png", "/Users/me/project"),
    { kind: "file", value: "/Users/me/project/images/test.png", text: "./images/test.png" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget("../shared/demo.glb", "/Users/me/project/assets"),
    { kind: "file", value: "/Users/me/project/shared/demo.glb", text: "../shared/demo.glb" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget('open "/tmp/My File.png"', "/Users/me/project"),
    { kind: "file", value: "/tmp/My File.png", text: "/tmp/My File.png" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget("file:///tmp/a%20b.png", "/Users/me/project"),
    { kind: "file", value: "/tmp/a b.png", text: "file:///tmp/a%20b.png" }
  );
});

test("terminal click parsing chooses the candidate under the clicked cell", () => {
  const line = "first /tmp/one.png then https://example.com/two";
  assert.deepEqual(
    extractTerminalPreviewTarget(line, "/tmp", line.indexOf("example.com") + 3),
    { kind: "url", value: "https://example.com/two", text: "https://example.com/two" }
  );
  assert.equal(extractTerminalPreviewTarget(line, "/tmp", line.indexOf("then") + 1), null);
});



test("terminal pointer coordinates map to the visible xterm buffer cell", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const session = new TerminalSession({ isNative: false });
  session.term = {
    cols: 10,
    rows: 5,
    buffer: {
      active: {
        viewportY: 3,
        getLine(row) {
          assert.equal(row, 5);
          return { translateToString: () => "open /tmp/test.png" };
        }
      }
    }
  };
  const screen = { getBoundingClientRect: () => ({ left: 100, right: 300, top: 50, bottom: 150, width: 200, height: 100 }) };
  const element = { querySelector: () => screen };

  const point = session.terminalTextAtEvent(element, { clientX: 210, clientY: 98 });

  assert.equal(point.column, 5);
  assert.equal(point.text, "open /tmp/test.png");
  assert.deepEqual(point.anchor, { left: 200, right: 220, top: 90, bottom: 110 });
});
test("terminal mini preview stays below normal text and flips above near the bottom", () => {
  assert.deepEqual(
    terminalPreviewPlacement(
      { left: 180, right: 181, top: 80, bottom: 96 },
      { width: 1000, height: 800 },
      { width: 300, height: 220 }
    ),
    { left: 180, top: 104, above: false }
  );
  assert.deepEqual(
    terminalPreviewPlacement(
      { left: 900, right: 901, top: 740, bottom: 756 },
      { width: 1000, height: 800 },
      { width: 300, height: 220 }
    ),
    { left: 692, top: 512, above: true }
  );
});

test("terminal preview UI uses a compact iframe card and leaves right-click copy in place", async () => {
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  assert.match(terminal, /terminal-link-preview/);
  assert.match(terminal, /createElement\("iframe"\)/);
  assert.match(terminal, /event\.button !== 0/);
  assert.match(terminal, /contextmenu[\s\S]*copySelection/);
  assert.match(css, /\.terminal-link-preview\s*\{[^}]*width:\s*min\(300px/s);
  assert.match(css, /\.terminal-link-preview-frame/);
});
