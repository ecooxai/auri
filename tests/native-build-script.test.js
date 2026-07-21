import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { releaseBuildEnvironment, releaseBuildId } from "../scripts/app.mjs";
import { writeFileIfChanged } from "../scripts/build-files.mjs";
import {
  hasBundleOverride,
  nativeBuildArgs,
  shouldCreateMacDmg
} from "../scripts/native-build.mjs";

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
  assert.match(pkg.scripts["cli:build"], /--features cli-bin/);
  assert.match(pkg.scripts["cli:install"], /--features cli-bin/);
});

test("app builds use a stable identity for each project checkout", () => {
  const first = releaseBuildId({ projectRoot: "/tmp/auri-one" });
  assert.equal(releaseBuildId({ projectRoot: "/tmp/auri-one" }), first);
  assert.notEqual(releaseBuildId({ projectRoot: "/tmp/auri-two" }), first);

  assert.equal(
    releaseBuildEnvironment({ env: {}, projectRoot: "/tmp/auri-one" }).AURI_BUILD_ID,
    first
  );
  assert.equal(
    releaseBuildEnvironment({ env: { AURI_BUILD_ID: "release-stable" } }).AURI_BUILD_ID,
    "release-stable"
  );
});

test("generated build files keep their timestamp when content is unchanged", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auri-build-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "generated.js");

  assert.equal(await writeFileIfChanged(filename, "same output\n"), true);
  const first = await stat(filename);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(await writeFileIfChanged(filename, Buffer.from("same output\n")), false);
  assert.equal((await stat(filename)).mtimeMs, first.mtimeMs);

  assert.equal(await writeFileIfChanged(filename, "changed output\n"), true);
  assert.equal(await readFile(filename, "utf8"), "changed output\n");
  assert.ok((await stat(filename)).mtimeMs > first.mtimeMs);
});

test("native profiles retain incremental artifacts for repeated app and dev builds", async () => {
  const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
  assert.match(cargo, /\[profile\.dev\][\s\S]*?incremental\s*=\s*true/);
  assert.match(cargo, /\[profile\.dev\][\s\S]*?debug\s*=\s*1/);
  assert.match(cargo, /\[profile\.release\][\s\S]*?incremental\s*=\s*true/);
  assert.match(cargo, /\[profile\.release\][\s\S]*?lto\s*=\s*false/);
  assert.match(cargo, /\[profile\.release\.package\.auri\][\s\S]*?opt-level\s*=\s*1/);
  assert.match(cargo, /\[profile\.release\.package\.auri\][\s\S]*?codegen-units\s*=\s*256/);
});

test("non-desktop binaries require opt-in features so Tauri --bins skips them", async () => {
  const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
  assert.match(cargo, /name = "auri-dev"[\s\S]*?required-features = \["dev-bin"\]/);
  assert.match(cargo, /name = "auri"[\s\S]*?required-features = \["cli-bin"\]/);
});

test("desktop builds do not link unused mobile library artifact types", async () => {
  const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
  assert.match(cargo, /crate-type = \["rlib"\]/);
  assert.doesNotMatch(cargo, /crate-type = \[[^\]]*"(?:staticlib|cdylib)"/);
});
