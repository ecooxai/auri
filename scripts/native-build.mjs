import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const BUNDLE_FLAGS = new Set(["--bundles", "-b", "--no-bundle"]);

export function hasBundleOverride(args) {
  return args.some((arg) => {
    if (BUNDLE_FLAGS.has(arg)) {
      return true;
    }
    return arg.startsWith("--bundles=");
  });
}

export function nativeBuildArgs({ platform = process.platform, extraArgs = [] } = {}) {
  const args = [...extraArgs];
  if (hasBundleOverride(args)) {
    return args;
  }

  if (platform === "darwin") {
    return ["--bundles", "app", ...args];
  }

  if (platform === "linux") {
    return ["--no-bundle", ...args];
  }

  throw new Error(
    `Unsupported native build platform "${platform}". ` +
      "Auri native npm builds currently support macOS DMG builds and Linux runnable binary builds."
  );
}

export function shouldCreateMacDmg({ platform = process.platform, extraArgs = [] } = {}) {
  return platform === "darwin" && !hasBundleOverride(extraArgs);
}

export function describeHost() {
  return `${process.platform}/${process.arch} (${os.type()} ${os.release()})`;
}

function expectedArtifactMessage(platform) {
  if (platform === "darwin") {
    return "Expected macOS installer image under src-tauri/target/release/bundle/dmg/.";
  }
  if (platform === "linux") {
    return "Expected runnable Linux binary at src-tauri/target/release/auri-desktop.";
  }
  return "";
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
  });
}

function macRustArch(arch = process.arch) {
  if (arch === "arm64") {
    return "aarch64";
  }
  if (arch === "x64") {
    return "x64";
  }
  return arch;
}

async function readTauriMetadata() {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  return {
    productName: config.productName ?? "Auri",
    version: config.version ?? "0.0.0"
  };
}

export async function createMacDmg() {
  const { productName, version } = await readTauriMetadata();
  const appPath = path.join("src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
  const dmgDir = path.join("src-tauri", "target", "release", "bundle", "dmg");
  const stagingDir = path.join(dmgDir, `${productName}-dmg-staging`);
  const dmgPath = path.join(dmgDir, `${productName}_${version}_${macRustArch()}.dmg`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await cp(appPath, path.join(stagingDir, `${productName}.app`), { recursive: true });
  await symlink("/Applications", path.join(stagingDir, "Applications"));

  await runCommand("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath
  ]);
  await rm(stagingDir, { recursive: true, force: true });
  console.log(`Built macOS installer image at ${dmgPath}`);
  return dmgPath;
}

export async function runNativeBuild({
  platform = process.platform,
  extraArgs = process.argv.slice(2),
  env = process.env
} = {}) {
  const args = nativeBuildArgs({ platform, extraArgs });
  console.log(`Host: ${describeHost()}`);
  console.log(`Running native build: node scripts/tauri-build.mjs ${args.join(" ")}`);
  await runCommand(process.execPath, ["scripts/tauri-build.mjs", ...args], env);

  if (shouldCreateMacDmg({ platform, extraArgs })) {
    await createMacDmg();
  }

  console.log(expectedArtifactMessage(platform));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeBuild().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
