import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["safari15"],
  outfile: "dist/app.js",
  sourcemap: true
});

const index = (await readFile("index.html", "utf8"))
  .replace('src="src/main.js"', 'src="app.js?v=3"');
await writeFile("dist/index.html", index);
await cp("styles.css", "dist/styles.css");
await cp("favicon.png", "dist/favicon.png");

console.log("Built bundled Auri frontend in dist/");
