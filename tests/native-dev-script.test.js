import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("default development command opens native mode and the framework uses a frontend-only helper", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const nativeDev = await readFile("scripts/native-dev.mjs", "utf8");

  assert.equal(packageJson.scripts.dev, "node scripts/native-dev.mjs");
  assert.equal(packageJson.scripts["dev:web"], "node scripts/dev.mjs");
  assert.equal(packageJson.scripts["tauri:dev"], "cargo tauri dev");
  assert.equal(tauriConfig.build.beforeDevCommand, "npm run dev:web");
  assert.notEqual(tauriConfig.build.beforeDevCommand, packageJson.scripts.dev);
  assert.match(nativeDev, /cargo.*tauri.*dev/);
});
