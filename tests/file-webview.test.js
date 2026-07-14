import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Backend, localFileUrl, localFileViewerUrl, previewMimeForPath } from "../src/services/backend.js";
import { captureFolderScroll } from "../src/views/app-view.js";

test("m4a files use the WebKit-compatible audio/mp4 MIME type", () => {
  assert.equal(previewMimeForPath("/tmp/test.m4a", "audio/x-m4a"), "audio/mp4");
  assert.equal(previewMimeForPath("/tmp/movie.mp4", "application/octet-stream"), "video/mp4");
  assert.equal(previewMimeForPath("/tmp/manual.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(previewMimeForPath("/tmp/scene.blend", "application/octet-stream"), "application/x-blender");
});

test("local file URLs map absolute paths onto the fixed loopback server", () => {
  assert.equal(localFileUrl("/Users/me/My Site/index.html"), "http://localhost:8890/Users/me/My%20Site/index.html");
  assert.equal(localFileUrl("/tmp/a#b?.glb"), "http://localhost:8890/tmp/a%23b%3F.glb");
  assert.equal(localFileUrl("/tmp/你好.mp4"), "http://localhost:8890/tmp/%E4%BD%A0%E5%A5%BD.mp4");
});

test("native Finder integration registers all macOS files and drains opened paths", async () => {
  const plist = readFileSync(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command, payload) => {
    calls.push({ command, payload });
    return ["/tmp/model.glb", "/tmp/notes.txt"];
  };

  assert.match(plist, /CFBundleDocumentTypes/);
  assert.match(plist, /public\.data/);
  assert.match(plist, /CFBundleTypeRole[\s\S]*Viewer/);
  assert.match(rust, /RunEvent::Opened/);
  assert.match(rust, /auri-open-files/);
  assert.match(rust, /take_pending_open_files/);
  assert.deepEqual(await backend.takePendingOpenFiles(), ["/tmp/model.glb", "/tmp/notes.txt"]);
  assert.deepEqual(calls, [{ command: "take_pending_open_files", payload: {} }]);
});

test("local file viewer URLs use the resolved server port and path query modes", () => {
  assert.equal(localFileUrl("/tmp/demo.txt", 8893), "http://localhost:8893/tmp/demo.txt");
  assert.equal(localFileViewerUrl("/tmp/My File.txt", 8893), "http://localhost:8893/tmp/My%20File.txt?view=1");
  assert.equal(localFileViewerUrl("/tmp/My File.txt", 8893, "edit"), "http://localhost:8893/tmp/My%20File.txt?edit=1");
});

test("local media viewer URLs preserve autoplay and compact preview options", () => {
  assert.equal(
    localFileViewerUrl("/tmp/My Song.mp3", 8895, "view", { autoplay: true, compact: true }),
    "http://localhost:8895/tmp/My%20Song.mp3?view=1&autoplay=1&compact=1"
  );
  assert.equal(
    localFileViewerUrl("/tmp/My Movie.mp4", 8895, "view", { autoplay: true }),
    "http://localhost:8895/tmp/My%20Movie.mp4?view=1&autoplay=1"
  );
});

test("native media viewer honors autoplay and compact chrome query flags", () => {
  const viewer = readFileSync(new URL("../src-tauri/src/core/viewer.html", import.meta.url), "utf8");

  assert.match(viewer, /query\.has\('autoplay'\)/);
  assert.match(viewer, /query\.has\('compact'\)/);
  assert.match(viewer, /\.compact-media \.topbar\{display:none\}/);
  assert.match(viewer, /\.compact-media \.media-title\{display:none\}/);
  assert.match(viewer, /player\.play\(\)\?\.catch/);
});

test("folder scroll is preserved only while rendering the same directory", () => {
  const list = { dataset: { folderPath: "/same" }, scrollTop: 384 };
  const root = { querySelector: () => list };
  assert.equal(captureFolderScroll(root, "/same"), 384);
  assert.equal(captureFolderScroll(root, "/different"), 0);
});


test("folder scroll restoration happens before a following render can capture it", () => {
  const source = readFileSync(new URL("../src/views/app-view.js", import.meta.url), "utf8");
  const restore = source.indexOf('if (folder) folder.scrollTop = folderScrollTop;');
  const frame = source.indexOf('requestAnimationFrame(() => {', restore - 100);
  assert.ok(restore >= 0);
  assert.ok(frame > restore, "folder scroll must be restored synchronously before deferred work");
});

import { renderWebview } from "../src/views/panels.js";
import { createInitialState, reduceState } from "../src/model/state.js";

test("website tabs use a native webview host instead of an iframe", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const html = renderWebview(state, { native: true });
  assert.match(html, /id="native-webview-host"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /https:\/\/www\.google\.com\//);
});

test("website tabs never fall back to an iframe for real websites", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const html = renderWebview(state, { native: false });
  assert.match(html, /id="native-webview-host"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /browser-frame/);
});

test("website webviews stay embedded by default but linux falls back to a browser window", () => {
  const rust = readFileSync(new URL("../src-tauri/src/core/webview.rs", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/services/backend.js", import.meta.url), "utf8");
  const panels = readFileSync(new URL("../src/views/panels.js", import.meta.url), "utf8");

  // Embedded child webviews remain the default (macOS) path…
  assert.match(rust, /\.add_child\(/);
  // …while Linux uses a dedicated, reliable browser window unless the user
  // opts back into the embedded webview via AURI_EMBEDDED_WEBVIEW=1.
  assert.match(rust, /use_window_webview/);
  assert.match(rust, /AURI_EMBEDDED_WEBVIEW/);
  assert.match(rust, /target_os = "linux"/);
  assert.doesNotMatch(rust, /\.always_on_top\(true\)/);
  assert.doesNotMatch(backend, /supportsNativeChildWebviews/);
  assert.doesNotMatch(panels, /browser-frame/);
});


test("native inspection does not create a restricted asset URL for arbitrary files", async () => {
  const backend = new Backend();
  backend.invoke = async (command, payload) => ({
    path: payload.path,
    name: "output.m4a",
    kind: "audio"
  });
  const metadata = await backend.inspectFile("/Users/ecoo/Desktop/testmedia/output.m4a");
  assert.equal(metadata.assetUrl, undefined);
});

test("opened files render through a blob-backed HTML viewer app document", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const id = state.tabs[0].activeSubtabId;
  state = reduceState(state, {
    type: "SUBTAB_UPDATE",
    payload: { id, patch: { url: "blob:auri-media-page", filePath: "/tmp/test.m4a", fileMime: "text/html" } }
  });
  const html = renderWebview(state);
  assert.match(html, /<iframe[^>]+src="blob:auri-media-page"/);
  assert.match(html, /allow="[^"]*camera[^"]*microphone[^"]*geolocation/);
  assert.doesNotMatch(html, /src="\/tmp\/test\.m4a"/);
});


test("native large video preview streams through the active local HTTP viewer", async () => {
  const previousWindow = globalThis.window;
  const previousUrl = globalThis.URL;
  const objectUrls = [];
  globalThis.window = {
    navigator: { platform: "MacIntel", userAgent: "Auri macOS" },
    __TAURI__: { core: { convertFileSrc: (path) => `asset://${path}` } }
  };
  globalThis.URL = {
    createObjectURL(value) {
      objectUrls.push(value);
      return `blob:viewer-${objectUrls.length}`;
    },
    revokeObjectURL() {}
  };
  try {
    const backend = new Backend();
    const calls = [];
    backend.invoke = async (command, payload) => {
      calls.push({ command, payload });
      if (command === "read_binary_file") throw new Error("read_binary_file should not be used for video preview");
      return {};
    };

    const view = await backend.createFileView("/tmp/huge.mp4", { name: "huge.mp4", mime: "video/mp4", size: 2_000_000_000 });

    assert.equal(view.title, "huge.mp4");
    assert.equal(view.mediaMime, "video/mp4");
    assert.equal(view.viewerKind, "video");
    assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
    assert.equal(view.url, "http://localhost:8890/tmp/huge.mp4?view=1");
    assert.deepEqual(objectUrls, []);
  } finally {
    globalThis.window = previousWindow;
    globalThis.URL = previousUrl;
  }
});

test("native mini media preview URLs request autoplay without changing normal viewer URLs", () => {
  assert.equal(
    localFileViewerUrl("/tmp/clip.mp4", 8895, "view", { autoplay: true }),
    "http://localhost:8895/tmp/clip.mp4?view=1&autoplay=1"
  );
  assert.equal(
    localFileViewerUrl("/tmp/clip.mp4", 8895, "view"),
    "http://localhost:8895/tmp/clip.mp4?view=1"
  );
});

test("native directory previews use the query-free folder browser URL", async () => {
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "fileserver_start") return { port: 8897, root: "/" };
    return {};
  };

  const view = await backend.createFileView("/Users/me/project/src", {
    name: "src",
    kind: "directory",
    mime: "inode/directory"
  });

  assert.equal(view.url, "http://localhost:8897/Users/me/project/src");
  assert.equal(view.resourceUrl, "http://localhost:8897/Users/me/project/src");
  assert.equal(view.viewerKind, "directory");
  assert.equal(view.mediaMime, "inode/directory");
  assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
});

test("native image previews expose both the full viewer and raw image resource URLs", async () => {
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {};
  };

  const view = await backend.createFileView("/Users/me/Pictures/photo one.jpg", { name: "photo one.jpg", mime: "image/jpeg" });

  assert.equal(view.viewerKind, "image");
  assert.equal(view.url, "http://localhost:8890/Users/me/Pictures/photo%20one.jpg?view=1");
  assert.equal(view.resourceUrl, "http://localhost:8890/Users/me/Pictures/photo%20one.jpg");
  assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
});

test("native HTML files open in the HTTP app and preview through the raw sibling-aware path", async () => {
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {};
  };

  const view = await backend.createFileView("/Users/me/My Site/index.html", { name: "index.html", mime: "text/html" });

  assert.equal(view.url, "http://localhost:8890/Users/me/My%20Site/index.html?view=1");
  assert.equal(view.mime, "text/html");
  assert.equal(view.viewerKind, "html");
  assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
});

test("native 3D previews stream from the active local HTTP server", async () => {
  const previousWindow = globalThis.window;
  const previousUrl = globalThis.URL;
  const objectUrls = [];
  globalThis.window = {
    navigator: { platform: "MacIntel", userAgent: "Auri macOS" },
    __TAURI__: { core: { convertFileSrc: (path) => `asset://${path}` } }
  };
  globalThis.URL = {
    createObjectURL(value) {
      objectUrls.push(value);
      return `blob:model-${objectUrls.length}`;
    },
    revokeObjectURL() {}
  };
  try {
    const backend = new Backend();
    const calls = [];
    backend.invoke = async (command, payload) => {
      calls.push({ command, payload });
      return { path: payload.path, name: "mario.glb", mime: "model/gltf-binary", base64: "Z2xURg==" };
    };

    const view = await backend.createFileView("/Users/ecoo/project/game/assets/mario.glb", { name: "mario.glb", mime: "model/gltf-binary" });

    assert.equal(view.viewerKind, "model3d");
    assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
    assert.equal(view.url, "http://localhost:8890/Users/ecoo/project/game/assets/mario.glb?view=1");
    assert.deepEqual(objectUrls, []);
  } finally {
    globalThis.window = previousWindow;
    globalThis.URL = previousUrl;
  }
});

test("linux media previews stream from the active local HTTP server", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousUrl = globalThis.URL;
  const objectUrls = [];
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "Auri Linux" }, configurable: true });
  globalThis.window = {
    navigator: { platform: "Linux x86_64", userAgent: "Auri Linux" },
    __TAURI__: { core: { convertFileSrc: (path) => `asset://${path}` } }
  };
  globalThis.URL = {
    createObjectURL(value) {
      objectUrls.push(value);
      return `blob:viewer-${objectUrls.length}`;
    },
    revokeObjectURL() {}
  };
  try {
    const backend = new Backend();
    const calls = [];
    backend.invoke = async (command, payload) => {
      calls.push({ command, payload });
      if (command === "read_binary_file") {
        return { path: payload.path, name: "test.m4a", mime: "audio/mp4", base64: "AAAA" };
      }
      return {};
    };

    const view = await backend.createFileView("/home/a/Desktop/test.m4a", { name: "test.m4a", mime: "audio/mp4" });

    assert.equal(view.viewerKind, "audio");
    assert.deepEqual(calls, [{ command: "fileserver_start", payload: {} }]);
    assert.equal(view.url, "http://localhost:8890/home/a/Desktop/test.m4a?view=1");
    assert.deepEqual(objectUrls, []);
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    globalThis.URL = previousUrl;
  }
});

test("native file views discover the active fallback port and use the HTTP app for text and HTML", async () => {
  const backend = new Backend();
  const calls = [];
  backend.invoke = async (command) => {
    calls.push(command);
    if (command === "fileserver_start") return { root: "/", port: 8894 };
    throw new Error(`unexpected native call: ${command}`);
  };

  const text = await backend.createFileView("/tmp/notes.txt", { name: "notes.txt", mime: "text/plain" });
  const html = await backend.createFileView("/tmp/site/index.html", { name: "index.html", mime: "text/html" });

  assert.equal(text.url, "http://localhost:8894/tmp/notes.txt?view=1");
  assert.equal(html.url, "http://localhost:8894/tmp/site/index.html?view=1");
  assert.deepEqual(calls, ["fileserver_start"]);
});

test("custom audio viewer controls catch unsupported play promises", () => {
  const source = readFileSync(new URL("../src/services/file-viewer-page.js", import.meta.url), "utf8");

  assert.match(source, /function playMedia\(mediaElement\)/);
  assert.match(source, /mediaElement\.play\(\)\?\.catch/);
  assert.doesNotMatch(source, /audio\.paused \? audio\.play\(\) : audio\.pause\(\)/);
});


test("desktop media files are inside the Tauri asset protocol scope", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const scope = config.app?.security?.assetProtocol?.scope || [];

  assert.equal(config.app?.security?.assetProtocol?.enable, true);
  assert.ok(scope.includes("$HOME/Desktop/**"), "Desktop files should be readable through asset://localhost for previews");
  assert.ok(scope.includes("$HOME/Downloads/**"), "Downloads should keep common opened media previewable");
  assert.ok(scope.includes("$HOME/Movies/**"), "Movies should keep common video previews streamable");
});

test("file webview frame is sized as an embedded app surface and delegates browser capabilities", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "webview" } });
  const id = state.tabs[0].activeSubtabId;
  state = reduceState(state, {
    type: "SUBTAB_UPDATE",
    payload: { id, patch: { url: "blob:auri-file-viewer", filePath: "/tmp/manual.pdf", fileMime: "text/html" } }
  });

  const html = renderWebview(state);
  assert.match(html, /<iframe class="file-web-object"/);
  assert.match(html, /src="blob:auri-file-viewer"/);
  for (const capability of ["camera", "microphone", "geolocation", "display-capture", "clipboard-read", "clipboard-write", "fullscreen"]) {
    assert.match(html, new RegExp("allow=\"[^\"]*" + capability));
  }
});

test("file serve starts the folder HTTP server and opens the web viewer", async () => {
  const { executeCommand } = await import("../src/controllers/command-controller.js");
  let state = createInitialState();
  state = reduceState(state, { type: "WORKDIR_SET", payload: { path: "/home/me/project" } });
  const calls = [];
  const context = {
    getState: () => state,
    dispatch: (action) => { state = reduceState(state, action); },
    backend: {
      inspectFile: async (path) => ({ path, name: path.split("/").pop(), kind: "video", mime: "video/mp4" }),
      startFileServer: async (root) => { calls.push(root); return { root: "/", port: 8890 }; }
    },
    actions: {}
  };
  const result = await executeCommand("file serve /home/me/project/demo/clip.mp4", context);
  assert.deepEqual(calls, ["/"]);
  assert.equal(result.url, "http://localhost:8890/home/me/project/demo/clip.mp4?view=1");
  const subtab = state.tabs[0].subtabs.find((item) => item.type === "webview");
  assert.ok(subtab);
  assert.equal(subtab.url, result.url);
});

test("Blender files are safely exported to GLB and reused by the existing Three.js viewer", () => {
  const server = readFileSync(new URL("../src-tauri/src/core/fileserver.rs", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src-tauri/src/core/viewer.html", import.meta.url), "utf8");

  assert.match(server, /\/api\/blend-preview/);
  assert.match(server, /--disable-autoexec/);
  assert.match(server, /export_scene\.gltf/);
  assert.match(server, /Blender\.app\/Contents\/MacOS\/Blender/);
  assert.match(viewer, /blend-preview/);
  assert.match(viewer, /GLTFLoader/);
  assert.doesNotMatch(viewer, /blend[^\n]+needs conversion/i);
});

test("HTML previews delegate browser capabilities and macOS declares camera and location use", () => {
  const server = readFileSync(new URL("../src-tauri/src/core/fileserver.rs", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src-tauri/src/core/viewer.html", import.meta.url), "utf8");
  const plist = readFileSync(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");

  assert.match(server, /Permissions-Policy/);
  const iframeAllow = viewer.match(/const htmlFeaturePolicy='([^']+)'/)?.[1] || "";
  assert.match(viewer, /allow="'\+htmlFeaturePolicy\+'"/);
  for (const capability of ["camera", "microphone", "geolocation", "display-capture", "clipboard-read", "clipboard-write", "fullscreen"]) {
    assert.match(server, new RegExp(capability + "=\\(self\\)"));
    assert.match(iframeAllow, new RegExp("(?:^|;\\s*)" + capability + "(?:;|$)"));
  }
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSLocationWhenInUseUsageDescription/);
});

test("file viewer footer truncates and copies long names with compact icon actions", () => {
  const viewer = readFileSync(new URL("../src-tauri/src/core/viewer.html", import.meta.url), "utf8");

  assert.match(viewer, /function compactFileName\(name/);
  assert.match(viewer, /slice\(0,40\).*slice\(-10\)/s);
  assert.match(viewer, /\.title\{[^}]*max-width:200px/s);
  assert.match(viewer, /copyFileName/);
  assert.match(viewer, /label:'⌑'.*title:'Open folder'/s);
  assert.match(viewer, /label:'✎'.*title:'Edit file'/s);
  assert.match(viewer, /toggleFileMenu/);
  assert.match(viewer, /download="'\+esc\(baseName\(\)\)/);
  assert.doesNotMatch(viewer, /items\.push\(\{label:'Download'/);
});

test("the embedded web viewer serves ranges, saves, and covers common file types", () => {
  const server = readFileSync(new URL("../src-tauri/src/core/fileserver.rs", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src-tauri/src/core/viewer.html", import.meta.url), "utf8");
  assert.match(server, /TcpListener::bind/);
  assert.match(server, /pub const PORT: u16 = default_file_server_port\(cfg!\(debug_assertions\)\)/);
  assert.match(server, /PORT_SEARCH_LIMIT/);
  assert.match(server, /try_stop_conflicting_dev_listener/);
  assert.match(server, /Content-Range/);
  assert.match(server, /\/api\/save/);
  assert.match(server, /canonicalize/);
  assert.match(server, /include_str!\("viewer\.html"\)/);
  for (const feature of ["renderImage", "renderMedia", "renderPdf", "renderModel", "renderHtml", "renderText", "renderFolder"]) {
    assert.match(viewer, new RegExp(feature));
  }
  assert.match(viewer, /GLTFLoader/);
  assert.match(viewer, /import\("\/three-viewer\.js"\)/);
  assert.doesNotMatch(viewer, /unpkg\.com\/three|cdn\.jsdelivr\.net\/npm\/three/);
  assert.match(server, /THREE_VIEWER_JS/);
  assert.match(server, /\/three-viewer\.js/);
  assert.match(viewer, /nextMode \+ '=1'|appUrl\(filePath,'edit'\)/);
  assert.match(viewer, /data-parent/);
  assert.match(viewer, /Convert to PNG/);
  assert.match(viewer, /Convert to MP4/);
  assert.match(viewer, /auri-convert-bitrate/);
  assert.match(viewer, /4000/);
  assert.match(viewer, /query\.has\('autoplay'\)/);
  assert.match(viewer, /player\.play\(\)\?\.catch/);
  assert.doesNotMatch(viewer, /<div class="media-title"/);
  assert.match(viewer, /\.app\{[^}]*grid-template-rows:1fr auto/s);
  assert.match(viewer, /<main class="main"[^>]*>[\s\S]*<header class="topbar">/);
  assert.match(viewer, /\.media-stage\{[^}]*align-items:start/s);
  assert.match(viewer, /\.media-facts\{[^}]*top:8px[^}]*background:rgba\(0,0,0,\.5\)[^}]*color:#fff[^}]*font:600 9px/s);
  assert.match(viewer, /facts\.push\(formatSizeCompact\(size\)\)/);
  assert.match(viewer, /Math\.round\(details\.width\)\+'x'\+Math\.round\(details\.height\)/);
  assert.match(viewer, /details\.kind==='video'.*formatVideoBitrate/s);
  assert.match(viewer, /details\.kind==='audio'.*kbps/s);
  assert.match(viewer, /facts\.join\('\\u00a0\\u00a0'\)/);
  assert.match(viewer, /@media\(max-height:360px\)[\s\S]*?\.brand\{display:none\}/);
  assert.doesNotMatch(viewer, /facts\.push\('Size /);
  assert.doesNotMatch(viewer, /facts\.push\('Resolution /);
  assert.doesNotMatch(viewer, /facts\.push\('Bitrate /);
  assert.match(viewer, /function showMediaFacts\(/);
  assert.match(viewer, /naturalWidth/);
  assert.match(viewer, /videoWidth/);
  assert.match(viewer, /function estimatedBitrate\(/);
});
