import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hasBundleOverride, nativeBuildArgs, shouldCreateMacDmg } from "../scripts/native-build.mjs";

test("native npm build builds a macOS app before creating a DMG on macOS", () => {
  assert.deepEqual(nativeBuildArgs({ platform: "darwin" }), ["--bundles", "app"]);
  assert.equal(shouldCreateMacDmg({ platform: "darwin" }), true);
});

test("native npm build defaults to a runnable binary on Linux", () => {
  assert.deepEqual(nativeBuildArgs({ platform: "linux" }), ["--no-bundle"]);
});

test("native npm build preserves extra Tauri arguments after platform defaults", () => {
  assert.deepEqual(nativeBuildArgs({ platform: "darwin", extraArgs: ["--debug"] }), [
    "--bundles",
    "app",
    "--debug"
  ]);
});

test("native npm build respects explicit bundle overrides", () => {
  assert.equal(hasBundleOverride(["--bundles", "app"]), true);
  assert.equal(hasBundleOverride(["--bundles=app"]), true);
  assert.equal(hasBundleOverride(["--no-bundle"]), true);
  assert.deepEqual(nativeBuildArgs({ platform: "linux", extraArgs: ["--bundles", "deb"] }), [
    "--bundles",
    "deb"
  ]);
  assert.equal(shouldCreateMacDmg({ platform: "darwin", extraArgs: ["--bundles", "dmg"] }), false);
});

test("native npm build rejects unsupported host platforms", () => {
  assert.throws(() => nativeBuildArgs({ platform: "win32" }), /Unsupported native build platform/);
});

test("package scripts keep frontend build separate to avoid Tauri recursion", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

  assert.equal(pkg.scripts.build, "node scripts/native-build.mjs");
  assert.equal(pkg.scripts["build:web"], "node scripts/build.mjs");
  assert.equal(tauri.build.beforeBuildCommand, "npm run build:web");
});
