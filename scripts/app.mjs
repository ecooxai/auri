import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hasBundleOverride, runNativeBuild } from "./native-build.mjs";

export async function readTauriAppMetadata() {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  return {
    productName: config.productName ?? "Auri",
    binaryName: config.mainBinaryName ?? "auri-desktop"
  };
}

export function releaseAppPath({
  platform = process.platform,
  productName = "Auri",
  binaryName = "auri-desktop"
} = {}) {
  if (platform === "darwin") {
    return path.join("src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
  }

  if (platform === "linux") {
    return path.join("src-tauri", "target", "release", binaryName);
  }

  throw new Error(
    `Unsupported release app platform "${platform}". ` +
      "npm run app currently supports launching the built macOS .app bundle or Linux release binary."
  );
}

export function releaseBuildArgs({ platform = process.platform, extraArgs = [] } = {}) {
  if (platform === "darwin" && !hasBundleOverride(extraArgs)) {
    return ["--bundles", "app", ...extraArgs];
  }

  return [...extraArgs];
}

export function releaseExecutablePath({
  platform = process.platform,
  appPath,
  binaryName = "auri-desktop"
} = {}) {
  if (!appPath) {
    throw new Error("Missing release app path.");
  }

  if (platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", binaryName);
  }

  if (platform === "linux") {
    return appPath;
  }

  throw new Error(
    `Unsupported release app platform "${platform}". ` +
      "npm run app currently supports launching the built macOS .app executable or Linux release binary."
  );
}

export function releaseLaunchCommand({
  platform = process.platform,
  appPath,
  binaryName = "auri-desktop"
} = {}) {
  return {
    command: releaseExecutablePath({ platform, appPath, binaryName }),
    args: []
  };
}

function spawnInCurrentTerminal(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runReleaseApp({ platform = process.platform, extraArgs = process.argv.slice(2) } = {}) {
  const metadata = await readTauriAppMetadata();
  await runNativeBuild({ platform, extraArgs: releaseBuildArgs({ platform, extraArgs }) });

  const appPath = releaseAppPath({ platform, ...metadata });
  const { command, args } = releaseLaunchCommand({ platform, appPath, binaryName: metadata.binaryName });
  await access(command, constants.X_OK);

  console.log(`Running release app in this terminal: ${[command, ...args].join(" ")}`);
  const code = await spawnInCurrentTerminal(command, args);
  if (code !== 0) {
    process.exitCode = code;
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseApp().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
