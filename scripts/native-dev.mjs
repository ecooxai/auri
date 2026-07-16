import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  collectAuriDevelopmentProcessesToStop,
  parseProcessTable
} from "./native-dev-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const watchScript = path.join(projectRoot, "scripts", "native-watch.sh");
const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
const lockPath = path.join(tmpdir(), `auri-native-dev-${projectId}.lock`);

async function readProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 4 * 1024 * 1024
  });
  return parseProcessTable(stdout);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireProjectLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return { acquired: true, ownerPid: process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      if (processIsAlive(ownerPid)) return { acquired: false, ownerPid };
      await rm(lockPath, { force: true });
    }
  }
  return { acquired: false, ownerPid: null };
}

async function releaseProjectLock() {
  const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
  if (ownerPid === process.pid) await rm(lockPath, { force: true });
}

async function readLockOwnerPid() {
  const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
  return Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForProcessesToExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopPreviousDevelopment() {
  const lockOwnerPid = await readLockOwnerPid();
  const processes = await readProcesses();
  const targets = collectAuriDevelopmentProcessesToStop(processes, {
    currentPid: process.pid,
    lockOwnerPid,
    projectRoot
  });
  if (targets.length === 0) return;

  const targetPids = new Set(targets.map(({ pid }) => pid));
  const roots = targets.filter(({ ppid }) => !targetPids.has(ppid));
  console.log(`Stopping ${targets.length} process${targets.length === 1 ? "" : "es"} from the previous Auri development instance...`);
  for (const { pid } of roots) signalProcess(pid, "SIGTERM");
  await waitForProcessesToExit(targets.map(({ pid }) => pid));

  const remaining = targets.filter(({ pid }) => processIsAlive(pid));
  for (const { pid } of remaining.reverse()) signalProcess(pid, "SIGKILL");
  await waitForProcessesToExit(remaining.map(({ pid }) => pid), 1000);

  if (lockOwnerPid && !processIsAlive(lockOwnerPid)) await rm(lockPath, { force: true });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
}

export async function runNativeDevelopment() {
  await stopPreviousDevelopment();

  const lock = await acquireProjectLock();
  if (!lock.acquired) {
    console.log(`Auri development launcher is already running (PID ${lock.ownerPid ?? "unknown"}); not starting another instance.`);
    return 0;
  }

  let child = null;
  let requestedSignal = null;
  const signalHandlers = new Map();

  try {
    const watchDelay = String(process.env.AURI_WATCH_DELAY ?? "10").trim() || "10";
    console.log(`Starting guarded Auri development with a ${watchDelay}-second trailing rebuild debounce...`);
    child = spawn("bash", [watchScript], {
      cwd: projectRoot,
      env: { ...process.env, AURI_WATCH_DELAY: watchDelay },
      stdio: "inherit"
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        requestedSignal = signal;
        if (child && !child.killed) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    const result = await waitForExit(child);
    if (requestedSignal || result.signal) {
      const signal = requestedSignal || result.signal;
      if (signal === "SIGINT") return 130;
      if (signal === "SIGHUP") return 129;
      return 143;
    }
    return result.code;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    await releaseProjectLock();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isMain) process.exitCode = await runNativeDevelopment();
