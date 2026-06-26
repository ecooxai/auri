import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  assert.match(script, /AURI_DEV_PORT/);
  assert.match(script, /AURI_DIST_DIR/);
  assert.match(script, /TAURI_CONFIG/);
  assert.match(script, /launch-config\.mjs.*auri-dev/);
  assert.match(script, /cargo run --bin auri-dev/);

  const manifest = await readFile("src-tauri/Cargo.toml", "utf8");
  assert.match(manifest, /name = "auri-dev"/);
  await access("src-tauri/src/bin/auri-dev.rs");
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
