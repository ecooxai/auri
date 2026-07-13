import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  findExistingAuriDevelopmentProcess,
  parseProcessTable
} from "../scripts/native-dev-utils.mjs";

test("default development commands use the guarded native watcher", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const nativeDev = await readFile("scripts/native-dev.mjs", "utf8");
  const nativeWatch = await readFile("scripts/native-watch.sh", "utf8");
  const webDev = await readFile("scripts/dev.mjs", "utf8");

  assert.equal(packageJson.scripts.dev, "node scripts/native-dev.mjs");
  assert.equal(packageJson.scripts["native:watch"], "node scripts/native-dev.mjs");
  assert.equal(packageJson.scripts["dev:web"], "node scripts/dev.mjs");
  assert.equal(packageJson.scripts["tauri:dev"], "cargo tauri dev");
  assert.equal(tauriConfig.build.beforeDevCommand, "npm run dev:web");
  assert.notEqual(tauriConfig.build.beforeDevCommand, packageJson.scripts.dev);
  assert.match(nativeDev, /native-watch\.sh/);
  assert.match(nativeWatch, /--delay\s+"\$WATCH_DELAY"/);
  assert.match(nativeWatch, /AURI_WATCH_DELAY:-10/);
  assert.match(nativeWatch, /trap cleanup EXIT INT TERM HUP/);
  assert.match(webDev, /watchFileSystem\(root/);
  assert.match(webDev, /STATIC_FILES/);
  assert.match(webDev, /scheduleStaticCopy/);
});

test("development process detection finds debug apps and ignores release apps", () => {
  const processes = parseProcessTable(`
88355 87704 /Users/example/project/src-tauri/target/release/bundle/macos/Auri.app/Contents/MacOS/auri-desktop
90100 90099 /Users/example/project/src-tauri/target/debug/auri-desktop
`);

  assert.deepEqual(
    findExistingAuriDevelopmentProcess(processes, { currentPid: 99999 }),
    {
      pid: 90100,
      ppid: 90099,
      command: "/Users/example/project/src-tauri/target/debug/auri-desktop"
    }
  );
});

test("development process detection recognizes the isolated auri-dev binary", () => {
  const processes = parseProcessTable(`
90200 90199 target/debug/auri-dev
`);

  assert.equal(findExistingAuriDevelopmentProcess(processes, { currentPid: 99999 })?.pid, 90200);
});
