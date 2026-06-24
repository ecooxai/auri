import { context } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  const index = (await readFile(path.join(root, "index.html"), "utf8"))
    .replace('src="src/main.js"', 'src="app.js?v=3"');
  await writeFile(path.join(dist, "index.html"), index);
  await cp(path.join(root, "styles.css"), path.join(dist, "styles.css"));
  await cp(path.join(root, "favicon.png"), path.join(dist, "favicon.png"));
}

await rm(dist, { recursive: true, force: true });
await copyStatic();

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

server.listen(4173, "127.0.0.1", () => {
  console.log("Auri dev server: http://127.0.0.1:4173");
});

async function shutdown() {
  server.close();
  await ctx.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
