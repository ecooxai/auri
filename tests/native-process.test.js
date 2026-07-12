import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  RELEASE_ICON_PATHS,
  bundleIdentifierForBuild,
  createTauriBuildOverride,
  createTauriLaunchOverride
} from "../scripts/launch-config.mjs";

test("different Auri builds receive different valid application identifiers", () => {
  const first = bundleIdentifierForBuild("build-one");
  const second = bundleIdentifierForBuild("build-two");

  assert.notEqual(first, second);
  assert.match(first, /^app\.auri\.desktop\.build\.[a-z0-9-]+$/);
  assert.match(second, /^app\.auri\.desktop\.build\.[a-z0-9-]+$/);
});

test("native launch overrides isolate the app identity and frontend URL", () => {
  assert.deepEqual(createTauriLaunchOverride("watch-123", "http://127.0.0.1:43123/"), {
    identifier: bundleIdentifierForBuild("watch-123"),
    app: { enableGTKAppId: true },
    build: { devUrl: "http://127.0.0.1:43123/" }
  });
});

test("native watch launch override uses the development product name", () => {
  assert.deepEqual(
    createTauriLaunchOverride("watch-123", "http://127.0.0.1:43123/", "auri-dev"),
    {
      productName: "auri-dev",
      identifier: bundleIdentifierForBuild("watch-123"),
      app: { enableGTKAppId: true },
      build: { devUrl: "http://127.0.0.1:43123/" }
    }
  );
});

test("native watch starts an isolated process without replacing another watcher or app", async () => {
  const script = await readFile("scripts/native-watch.sh", "utf8");

  assert.doesNotMatch(script, /PID_FILE|OLD_PID|SOCKET_PATH|lsof -t/);
  assert.match(script, /npm run dev:web/);
  assert.doesNotMatch(script, /npm run dev[^:]/);
  assert.match(script, /AURI_DIST_DIR/);
  assert.match(script, /TAURI_CONFIG/);
  assert.match(script, /launch-config\.mjs.*auri-dev/);
  assert.match(script, /cargo run --bin auri-dev/);

  const manifest = await readFile("src-tauri/Cargo.toml", "utf8");
  assert.match(manifest, /name = "auri-dev"/);
  await access("src-tauri/src/bin/auri-dev.rs");
});


test("npm run app builds the release app and launches it in the terminal session", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.scripts.app, "node scripts/app.mjs");

  const { releaseAppPath, releaseBuildArgs, releaseLaunchCommand } = await import("../scripts/app.mjs");

  assert.equal(
    releaseAppPath({ platform: "darwin", productName: "Auri", binaryName: "auri-desktop" }),
    path.join("src-tauri", "target", "release", "bundle", "macos", "Auri.app")
  );
  assert.equal(
    releaseAppPath({ platform: "linux", productName: "Auri", binaryName: "auri-desktop" }),
    path.join("src-tauri", "target", "release", "auri-desktop")
  );

  assert.deepEqual(releaseBuildArgs({ platform: "darwin", extraArgs: [] }), ["--bundles", "app"]);
  assert.deepEqual(releaseBuildArgs({ platform: "linux", extraArgs: [] }), []);
  assert.deepEqual(releaseBuildArgs({ platform: "darwin", extraArgs: ["--debug"] }), [
    "--bundles",
    "app",
    "--debug"
  ]);
  assert.deepEqual(releaseBuildArgs({ platform: "darwin", extraArgs: ["--no-bundle"] }), ["--no-bundle"]);

  assert.deepEqual(
    releaseLaunchCommand({ platform: "darwin", appPath: "Built.app", binaryName: "auri-desktop" }),
    {
      command: path.join("Built.app", "Contents", "MacOS", "auri-desktop"),
      args: []
    }
  );
  assert.deepEqual(releaseLaunchCommand({ platform: "linux", appPath: "./auri-desktop", binaryName: "auri-desktop" }), {
    command: "./auri-desktop",
    args: []
  });
});

test("packaged builds use the isolated Tauri build wrapper", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.scripts["tauri:build"], "node scripts/tauri-build.mjs");
});

test("packaged builds use the complete black-background release icon set", async () => {
  const override = createTauriBuildOverride("package-123");
  assert.deepEqual(override.bundle.icon, RELEASE_ICON_PATHS);
  assert.ok(RELEASE_ICON_PATHS.includes("icons/release/icon.icns"));

  for (const iconPath of RELEASE_ICON_PATHS) {
    await access(`src-tauri/${iconPath}`);
  }
});
