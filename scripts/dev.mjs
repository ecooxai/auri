import { build, context } from "esbuild";
import { watch as watchFileSystem } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./build-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.AURI_DIST_DIR
  ? path.resolve(process.env.AURI_DIST_DIR)
  : path.join(root, "dist");
const port = Number.parseInt(process.env.AURI_DEV_PORT || "4173", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid AURI_DEV_PORT: ${process.env.AURI_DEV_PORT}`);
}

const STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "favicon.png",
  "browser-overlay.html",
  "browser-overlay.css",
  "browser-overlay.js"
]);
const staticCopyTimers = new Map();
let staticCopyQueue = Promise.resolve();

async function copyStaticFile(filename) {
  if (filename === "index.html") {
    const index = (await readFile(path.join(root, filename), "utf8"))
      .replace('src="src/main.js"', 'src="app.js?v=4"');
    await writeFile(path.join(dist, filename), index);
    return;
  }
  await cp(path.join(root, filename), path.join(dist, filename));
}

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await Promise.all([...STATIC_FILES].map((filename) => copyStaticFile(filename)));
}

function scheduleStaticCopy(filename) {
  if (!STATIC_FILES.has(filename)) return;
  const previous = staticCopyTimers.get(filename);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    staticCopyTimers.delete(filename);
    staticCopyQueue = staticCopyQueue
      .then(() => copyStaticFile(filename))
      .catch((error) => console.error(`Failed to refresh ${filename}:`, error));
  }, 50);
  timer.unref?.();
  staticCopyTimers.set(filename, timer);
}

await rm(dist, { recursive: true, force: true });
await copyStatic();

const threeViewerBuild = await build({
  entryPoints: [path.join(root, "src/services/three-viewer-entry.js")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: path.join(root, "src-tauri/src/core/three-viewer.js"),
  minify: true,
  write: false
});
await writeFileIfChanged(
  path.join(root, "src-tauri/src/core/three-viewer.js"),
  threeViewerBuild.outputFiles[0].contents
);
await cp(path.join(root, "src-tauri/src/core/three-viewer.js"), path.join(dist, "three-viewer.js"));

const ctx = await context({
  entryPoints: [path.join(root, "src/main.js")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: path.join(dist, "app.js"),
  sourcemap: "inline"
});
await ctx.watch();

const codemirrorCtx = await context({
  entryPoints: [path.join(root, "src/services/codemirror-viewer-entry.js")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: path.join(dist, "codemirror-viewer.js"),
  sourcemap: "inline"
});
await codemirrorCtx.watch();

// esbuild watches JavaScript dependency graphs, but root-level HTML/CSS/assets
// need their own watcher so the isolated AURI_DIST_DIR stays current between
// native app restarts.
const staticWatcher = watchFileSystem(root, (_eventType, filename) => {
  scheduleStaticCopy(String(filename || ""));
});

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filename = path.resolve(dist, relative);
    if (!filename.startsWith(`${dist}${path.sep}`) && filename !== path.join(dist, "index.html")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filename);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "content-type": mime[path.extname(filename)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    const data = await readFile(filename);
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Auri dev server: http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close();
  staticWatcher.close();
  for (const timer of staticCopyTimers.values()) clearTimeout(timer);
  staticCopyTimers.clear();
  await staticCopyQueue.catch(() => {});
  await ctx.dispose();
  await codemirrorCtx.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
