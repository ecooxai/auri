import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createTauriLaunchOverride } from "./launch-config.mjs";
import {
  isNativeWatchPath,
  nativeWatchChangeRequiresBuild,
  normalizeWatchDelay
} from "./native-watch-utils.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
const instanceId = process.env.AURI_INSTANCE_ID || `watch-${projectId}-${process.pid}`;
const runDirectory = path.join(tmpdir(), `auri-native-watch-${projectId}-${process.pid}`);
const watchDelayMs = normalizeWatchDelay(process.env.AURI_WATCH_DELAY);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

let frontend = null;
let nativeApp = null;
let restartTimer = null;
let restartQueue = Promise.resolve();
let pendingNativeBuild = false;
let shuttingDown = false;
const watchers = [];

function childExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function groupIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killOwnedProcessGroup(child, graceMs = 3000) {
  if (!child?.pid || !groupIsAlive(child.pid)) return;
  const target = process.platform === "win32" ? child.pid : -child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    childExit(child),
    new Promise((resolve) => setTimeout(resolve, graceMs))
  ]);
  if (!groupIsAlive(child.pid)) return;
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // The owned process group finished between the liveness check and signal.
  }
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForFrontend(url, attempts = 100) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const probe = () => {
      const request = http.get(url, { timeout: 1000 }, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 400) {
          resolve();
          return;
        }
        retry();
      });
      request.once("timeout", () => request.destroy());
      request.once("error", retry);
    };
    const retry = () => {
      remaining -= 1;
      if (remaining <= 0) {
        reject(new Error(`Failed to start isolated frontend server at ${url}.`));
        return;
      }
      setTimeout(probe, 100);
    };
    probe();
  });
}

function spawnOwned(command, args, options = {}) {
  return spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    detached: true,
    ...options
  });
}

function nativeDebugExecutable() {
  const filename = process.platform === "win32" ? "auri-dev.exe" : "auri-dev";
  return path.join(projectRoot, "src-tauri", "target", "debug", filename);
}

async function restartNativeApp(reason, environment, rebuild = true) {
  if (shuttingDown) return;
  if (nativeApp) {
    console.log(`Restarting Auri development after ${reason}; stopping PID ${nativeApp.pid} first...`);
    await killOwnedProcessGroup(nativeApp);
  } else if (rebuild) {
    console.log("Building and starting Auri development...");
  }
  if (shuttingDown) return;
  if (rebuild) {
    nativeApp = spawnOwned("cargo", [
      "run",
      "--manifest-path", "src-tauri/Cargo.toml",
      "--features", "dev-bin",
      "--bin", "auri-dev"
    ], { env: environment });
  } else {
    console.log("Starting the existing debug executable; frontend-only changes need no Rust build.");
    nativeApp = spawnOwned(nativeDebugExecutable(), [], { env: environment });
  }
  const launched = nativeApp;
  launched.once("exit", (code, signal) => {
    if (nativeApp === launched) nativeApp = null;
    if (!shuttingDown && code && !signal) {
      console.error(`Auri development exited with code ${code}.`);
    }
  });
}

function scheduleRestart(filename, environment) {
  if (!isNativeWatchPath(filename) || shuttingDown) return;
  pendingNativeBuild ||= nativeWatchChangeRequiresBuild(filename);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const rebuild = pendingNativeBuild;
    pendingNativeBuild = false;
    restartQueue = restartQueue
      .then(() => restartNativeApp(`a change to ${filename}`, environment, rebuild))
      .catch((error) => console.error("Could not restart Auri development:", error));
  }, watchDelayMs);
}

function addDirectoryWatcher(relativeDirectory, environment) {
  const absoluteDirectory = path.join(projectRoot, relativeDirectory);
  watchers.push(watch(absoluteDirectory, { recursive: true }, (_event, filename) => {
    const relative = path.posix.join(relativeDirectory, String(filename || ""));
    scheduleRestart(relative, environment);
  }));
}

function addFileWatcher(relativeFile, environment) {
  watchers.push(watch(path.join(projectRoot, relativeFile), () => {
    scheduleRestart(relativeFile, environment);
  }));
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await restartQueue.catch(() => {});
  await killOwnedProcessGroup(nativeApp);
  await killOwnedProcessGroup(frontend);
  await rm(runDirectory, { recursive: true, force: true });
  process.exitCode = exitCode;
}

async function run() {
  await mkdir(runDirectory, { recursive: true });
  const port = process.env.AURI_DEV_PORT
    ? Number.parseInt(process.env.AURI_DEV_PORT, 10)
    : await freeLoopbackPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid AURI_DEV_PORT: ${process.env.AURI_DEV_PORT}`);
  }
  const serverUrl = `http://127.0.0.1:${port}/`;
  const devUrl = `${serverUrl}?auri-instance=${encodeURIComponent(instanceId)}`;
  const environment = {
    ...process.env,
    AURI_DEV_PORT: String(port),
    AURI_DIST_DIR: path.join(runDirectory, "dist"),
    TAURI_CONFIG: JSON.stringify(createTauriLaunchOverride(instanceId, devUrl, "auri-dev"))
  };

  frontend = spawnOwned(npmCommand, ["run", "dev:web"], { env: environment });
  await waitForFrontend(serverUrl);

  addDirectoryWatcher("src", environment);
  addDirectoryWatcher("src-tauri/src", environment);
  for (const filename of [
    "index.html", "styles.css", "favicon.png",
    "browser-overlay.html", "browser-overlay.css", "browser-overlay.js",
    "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/Info.plist", "src-tauri/build.rs"
  ]) addFileWatcher(filename, environment);

  console.log(`Watching Auri on ${serverUrl} with a ${watchDelayMs / 1000}s trailing restart debounce.`);
  console.log("Press Ctrl+C to stop this watcher and only the debug processes it owns.");
  await restartNativeApp("startup", environment);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143));
}

try {
  await run();
} catch (error) {
  console.error(error?.stack || error);
  await shutdown(1);
}
