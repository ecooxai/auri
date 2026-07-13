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


test("terminal preview parser resolves selected relative directory paths against cwd", () => {
  assert.deepEqual(
    extractTerminalPreviewTarget("open dir1/dir2/ after selecting it", "/Users/me/project"),
    { kind: "file", value: "/Users/me/project/dir1/dir2", text: "dir1/dir2/" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget("choose src/", "/Users/me/project"),
    { kind: "file", value: "/Users/me/project/src", text: "src/" }
  );
});

test("terminal preview parser resolves bare filenames and nested relative file paths against cwd", () => {
  const cwd = "/Users/me/project";
  const cases = [
    ["test.png", "/Users/me/project/test.png"],
    ["notes.md", "/Users/me/project/notes.md"],
    ["index.html", "/Users/me/project/index.html"],
    ["src/app.js", "/Users/me/project/src/app.js"],
    ["dir1/dir2/main.rs", "/Users/me/project/dir1/dir2/main.rs"],
    ["docs/report.pdf", "/Users/me/project/docs/report.pdf"],
    ["models/scene.glb", "/Users/me/project/models/scene.glb"],
    ["models/scene.blend", "/Users/me/project/models/scene.blend"],
    ["audio/theme.m4a", "/Users/me/project/audio/theme.m4a"],
    ["video/demo.mp4", "/Users/me/project/video/demo.mp4"],
    ["archive/source.tar.gz", "/Users/me/project/archive/source.tar.gz"],
    ["CMakeLists.txt", "/Users/me/project/CMakeLists.txt"]
  ];
  for (const [input, value] of cases) {
    assert.deepEqual(extractTerminalPreviewTarget(`open ${input}`, cwd), { kind: "file", value, text: input });
  }
  assert.deepEqual(
    extractTerminalPreviewTarget('open "My Screenshot.webp"', cwd),
    { kind: "file", value: "/Users/me/project/My Screenshot.webp", text: "My Screenshot.webp" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget("open My\\ Screenshot.webp", cwd),
    { kind: "file", value: "/Users/me/project/My Screenshot.webp", text: "My Screenshot.webp" }
  );
});

test("terminal bare-file parsing covers common file families", () => {
  const cwd = "/work";
  const names = [
    "photo.jpg", "graphic.svg", "sound.wav", "song.mp3", "movie.mov", "clip.webm",
    "readme.txt", "guide.markdown", "data.json", "config.yaml", "table.csv", "site.css",
    "main.py", "main.rs", "main.go", "main.java", "main.cpp", "main.h", "main.swift",
    "main.kt", "main.cs", "main.php", "main.rb", "main.sh", "query.sql", "component.tsx",
    "document.docx", "sheet.xlsx", "slides.pptx", "book.epub", "manual.pdf",
    "mesh.obj", "mesh.stl", "scene.gltf", "scene.blend", "bundle.zip"
  ];
  for (const name of names) {
    assert.equal(extractTerminalPreviewTarget(name, cwd)?.value, `/work/${name}`);
  }
});

test("terminal bare-file parsing rejects dotted prose, versions, domains, and option assignments", () => {
  const cwd = "/work";
  for (const input of [
    "version 1.2.3", "release v2.10.4", "visit example.com", "package foo.dev",
    "use --config=app.js", "set OUTPUT=result.pdf", "flag --notes.md", "word e.g.",
    "https://example.com/app.js"
  ]) {
    const result = extractTerminalPreviewTarget(input, cwd);
    if (input.startsWith("https://")) {
      assert.deepEqual(result, { kind: "url", value: "https://example.com/app.js", text: "https://example.com/app.js" });
    } else {
      assert.equal(result, null, input);
    }
  }
});

test("terminal click parsing chooses the candidate under the clicked cell", () => {
  const line = "first /tmp/one.png then https://example.com/two";
  assert.deepEqual(
    extractTerminalPreviewTarget(line, "/tmp", line.indexOf("example.com") + 3),
    { kind: "url", value: "https://example.com/two", text: "https://example.com/two" }
  );
  assert.equal(extractTerminalPreviewTarget(line, "/tmp", line.indexOf("then") + 1), null);

  const relativeLine = "built dist/assets/demo.glb and src/main.rs:42:7";
  assert.deepEqual(
    extractTerminalPreviewTarget(relativeLine, "/Users/me/project", relativeLine.indexOf("demo.glb") + 3),
    { kind: "file", value: "/Users/me/project/dist/assets/demo.glb", text: "dist/assets/demo.glb" }
  );
  assert.deepEqual(
    extractTerminalPreviewTarget(relativeLine, "/Users/me/project", relativeLine.indexOf("main.rs") + 2),
    { kind: "file", value: "/Users/me/project/src/main.rs", text: "src/main.rs" }
  );
  assert.equal(extractTerminalPreviewTarget(relativeLine, "/Users/me/project", relativeLine.indexOf("and") + 1), null);
});



test("terminal pointer coordinates reconstruct a full logical line across soft wraps", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const session = new TerminalSession({ isNative: false });
  const rows = [
    { isWrapped: false, text: "open /Users/" },
    { isWrapped: true, text: "me/Desktop/g" },
    { isWrapped: true, text: "irl.jpg" }
  ];
  session.term = {
    cols: 12,
    rows: 3,
    buffer: {
      active: {
        viewportY: 0,
        getLine(row) {
          const item = rows[row];
          return item ? {
            isWrapped: item.isWrapped,
            translateToString(trimRight) {
              return trimRight ? item.text.trimEnd() : item.text.padEnd(12, " ");
            }
          } : undefined;
        }
      }
    }
  };
  const screen = { getBoundingClientRect: () => ({ left: 0, right: 120, top: 0, bottom: 60, width: 120, height: 60 }) };
  const element = { querySelector: () => screen };

  const point = session.terminalTextAtEvent(element, { clientX: 45, clientY: 50 });

  assert.equal(point.text, "open /Users/me/Desktop/girl.jpg");
  assert.equal(point.column, 28);
  assert.deepEqual(
    extractTerminalPreviewTarget(point.text, "/tmp", point.column),
    { kind: "file", value: "/Users/me/Desktop/girl.jpg", text: "/Users/me/Desktop/girl.jpg" }
  );
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
          return row === 5 ? { isWrapped: false, translateToString: () => "open /tmp/test.png" } : undefined;
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
test("terminal drag selection previews a contained relative directory path", async () => {
  const { TerminalSession } = await import("../src/services/terminal-session.js");
  const session = new TerminalSession({ isNative: false });
  session.cwd = "/Users/me/project";
  session.term = { getSelection: () => "selected dir1/dir2/ from output" };
  session.previewPointerDown = { x: 10, y: 10 };
  session.terminalTextAtEvent = () => ({
    text: "ordinary output",
    column: 3,
    anchor: { left: 20, right: 21, top: 20, bottom: 21 }
  });
  let shown = null;
  session.showPreview = (target) => { shown = target; };
  session.dismissPreview = () => {};

  session.handlePreviewMouseUp({ ownerDocument: {} }, { button: 0, clientX: 30, clientY: 10 });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(shown, {
    kind: "file",
    value: "/Users/me/project/dir1/dir2",
    text: "dir1/dir2/"
  });
});

test("terminal mini preview stays below normal text and flips above near the bottom", () => {
  assert.deepEqual(
    terminalPreviewPlacement(
      { left: 180, right: 181, top: 80, bottom: 96 },
      { width: 1000, height: 800 },
      { width: 450, height: 330 }
    ),
    { left: 180, top: 104, above: false }
  );
  assert.deepEqual(
    terminalPreviewPlacement(
      { left: 900, right: 901, top: 740, bottom: 756 },
      { width: 1000, height: 800 },
      { width: 450, height: 330 }
    ),
    { left: 542, top: 402, above: true }
  );
});

test("terminal image previews are chrome-free, 1.5x larger, and remain click-to-open", async () => {
  const terminal = await readFile("src/services/terminal-session.js", "utf8");
  const css = await readFile("styles.css", "utf8");
  assert.match(terminal, /terminal-link-preview/);
  assert.match(terminal, /createElement\("iframe"\)/);
  assert.match(terminal, /createElement\("img"\)/);
  assert.match(terminal, /prepared\.viewerKind === "image" && prepared\.resourceUrl/);
  assert.match(terminal, /preview\.classList\.add\("is-image"\)/);
  assert.match(terminal, /event\.button !== 0/);
  assert.match(terminal, /contextmenu[\s\S]*copySelection/);
  assert.match(css, /\.terminal-link-preview\s*\{[^}]*width:\s*min\(450px/s);
  assert.match(css, /\.terminal-link-preview\s*\{[^}]*height:\s*min\(330px/s);
  assert.match(css, /\.terminal-link-preview\.is-image[^}]*grid-template-rows:\s*1fr/s);
  assert.match(css, /\.terminal-link-preview-image[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.terminal-link-preview-frame/);
});
