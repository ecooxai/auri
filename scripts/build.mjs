import { build } from "esbuild";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileIfChanged } from "./build-files.mjs";

await mkdir("dist", { recursive: true });

async function writeBuildOutputs(buildResult) {
  await Promise.all(
    buildResult.outputFiles.map((output) => writeFileIfChanged(output.path, output.contents))
  );
}

// Release bundles are minified: WebKit keeps each bundle's source text and
// parsed code in the UI process, so smaller bundles directly lower app memory.
// keepNames preserves function and class names for readable error reports.
const appBuild = await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: "dist/app.js",
  sourcemap: true,
  minify: true,
  keepNames: true,
  write: false
});
await writeBuildOutputs(appBuild);

const codemirrorBuild = await build({
  entryPoints: ["src/services/codemirror-viewer-entry.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: "dist/codemirror-viewer.js",
  sourcemap: true,
  minify: true,
  keepNames: true,
  write: false
});
await writeBuildOutputs(codemirrorBuild);

const threeViewerBuild = await build({
  entryPoints: ["src/services/three-viewer-entry.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: "src-tauri/src/core/three-viewer.js",
  minify: true,
  write: false
});
await writeFileIfChanged(
  "src-tauri/src/core/three-viewer.js",
  threeViewerBuild.outputFiles[0].contents
);
await writeFileIfChanged("dist/three-viewer.js", threeViewerBuild.outputFiles[0].contents);

const index = (await readFile("index.html", "utf8"))
  .replace('src="src/main.js"', 'src="app.js?v=4"');
await writeFileIfChanged("dist/index.html", index);

const staticFiles = [
  "styles.css",
  "favicon.png",
  "browser-overlay.html",
  "browser-overlay.css",
  "browser-overlay.js"
];
await Promise.all(
  staticFiles.map(async (filename) => {
    await writeFileIfChanged(path.join("dist", filename), await readFile(filename));
  })
);

const expectedOutputs = new Set([
  "app.js",
  "app.js.map",
  "codemirror-viewer.js",
  "codemirror-viewer.js.map",
  "three-viewer.js",
  "index.html",
  ...staticFiles
]);
for (const entry of await readdir("dist")) {
  if (!expectedOutputs.has(entry)) {
    await rm(path.join("dist", entry), { recursive: true, force: true });
  }
}

console.log("Built bundled Auri frontend in dist/");
