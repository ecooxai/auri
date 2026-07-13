import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export function linuxReleaseArchitecture(arch = process.arch) {
  if (arch === "x64" || arch === "x86_64") return "x86_64";
  if (arch === "arm64" || arch === "aarch64") return "aarch64";
  throw new Error(`Unsupported Linux release architecture: ${arch}`);
}

export function linuxReleaseArchiveName(version, arch = process.arch) {
  return `Auri_${version}_linux_${linuxReleaseArchitecture(arch)}_archlinux.tar.gz`;
}

export function linuxReleaseReadme(version, arch = linuxReleaseArchitecture()) {
  return `Auri ${version} for Linux (${arch})

QUICK START

1. Extract this archive.
2. Double-click the executable named Auri.
3. If your file manager asks whether to run or display it, choose Run.

You can also launch it from a terminal:

  ./Auri

COMPATIBILITY

This binary was built and tested on an Arch Linux-based system. It dynamically
links to the host GTK 3, WebKitGTK 4.1, GStreamer, and related system libraries.
Debian and Ubuntu may not work with this build because their library versions
can differ. More Linux builds are coming soon.

FILES

- Auri: directly runnable application executable.
- Auri.desktop: optional desktop launcher; keep it beside Auri.
- auri.png: application icon.
- SHA256SUMS: checksum for the executable and launcher files.
`;
}

export function linuxReleaseDesktopEntry() {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Auri
Comment=Terminal-centered assistant workspace
Exec=./Auri
Icon=auri
Terminal=false
Categories=Utility;
StartupNotify=true
`;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function packageLinuxRelease({
  rootDir = process.cwd(),
  version,
  arch = process.arch
} = {}) {
  if (process.platform !== "linux") throw new Error("Linux release archives must be packaged on Linux.");
  const configPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const releaseVersion = version || config.version;
  if (!/^\d+\.\d+\.\d+$/.test(String(releaseVersion || ""))) {
    throw new Error(`Invalid release version: ${releaseVersion || "missing"}`);
  }

  const architecture = linuxReleaseArchitecture(arch);
  const packageStem = `Auri_${releaseVersion}_linux_${architecture}_archlinux`;
  const outputDir = path.join(rootDir, "src-tauri", "target", "release", "packages");
  const stagingDir = path.join(outputDir, packageStem);
  const archivePath = path.join(outputDir, `${packageStem}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const executablePath = path.join(stagingDir, "Auri");
  const desktopPath = path.join(stagingDir, "Auri.desktop");
  const iconPath = path.join(stagingDir, "auri.png");
  const sourceExecutable = path.join(rootDir, "src-tauri", "target", "release", "auri-desktop");
  const sourceIcon = path.join(rootDir, "src-tauri", "icons", "release", "icon.png");

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await copyFile(sourceExecutable, executablePath);
  await copyFile(sourceIcon, iconPath);
  await writeFile(path.join(stagingDir, "README.txt"), linuxReleaseReadme(releaseVersion, architecture));
  await writeFile(desktopPath, linuxReleaseDesktopEntry());
  await chmod(executablePath, 0o755);
  await chmod(desktopPath, 0o755);

  const checksums = await Promise.all(["Auri", "Auri.desktop", "README.txt", "auri.png"].map(async (name) => (
    `${await sha256(path.join(stagingDir, name))}  ${name}`
  )));
  await writeFile(path.join(stagingDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  await rm(archivePath, { force: true });
  await execFileAsync("tar", ["-czf", archivePath, "-C", outputDir, packageStem]);
  await rm(stagingDir, { recursive: true, force: true });
  const archiveHash = await sha256(archivePath);
  await writeFile(checksumPath, `${archiveHash}  ${path.basename(archivePath)}\n`);

  return { archivePath, checksumPath, archiveHash, version: releaseVersion, architecture };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageLinuxRelease().then((result) => {
    console.log(`Built ${result.archivePath}`);
    console.log(`SHA-256 ${result.archiveHash}`);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
