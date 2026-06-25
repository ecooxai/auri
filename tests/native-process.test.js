import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bundleIdentifierForBuild,
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

test("native watch starts an isolated process without replacing another watcher or app", async () => {
  const script = await readFile("scripts/native-watch.sh", "utf8");

  assert.doesNotMatch(script, /PID_FILE|OLD_PID|SOCKET_PATH|lsof -t/);
  assert.match(script, /AURI_DEV_PORT/);
  assert.match(script, /AURI_DIST_DIR/);
  assert.match(script, /TAURI_CONFIG/);
});

test("packaged builds use the isolated Tauri build wrapper", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.scripts["tauri:build"], "node scripts/tauri-build.mjs");
});
