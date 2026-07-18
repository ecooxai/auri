import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  linuxReleaseArchiveName,
  linuxReleaseDesktopEntry,
  linuxReleaseReadme
} from "../scripts/package-linux-release.mjs";

const projectRoot = new URL("../", import.meta.url);

test("release metadata stays aligned for Auri v0.8", async () => {
  const [packageSource, tauriSource, cargoSource, lockSource, readme, agentGuide] = await Promise.all([
    readFile(new URL("package.json", projectRoot), "utf8"),
    readFile(new URL("src-tauri/tauri.conf.json", projectRoot), "utf8"),
    readFile(new URL("src-tauri/Cargo.toml", projectRoot), "utf8"),
    readFile(new URL("src-tauri/Cargo.lock", projectRoot), "utf8"),
    readFile(new URL("README.md", projectRoot), "utf8"),
    readFile(new URL("AGENTS.md", projectRoot), "utf8")
  ]);
  const packageVersion = JSON.parse(packageSource).version;
  const tauriVersion = JSON.parse(tauriSource).version;
  const cargoVersion = cargoSource.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
  const lockVersion = lockSource.match(/^name = "auri"\nversion = "([^"]+)"/m)?.[1];

  assert.equal(packageVersion, "0.8.0");
  assert.equal(tauriVersion, packageVersion);
  assert.equal(cargoVersion, packageVersion);
  assert.equal(lockVersion, packageVersion);
  assert.match(readme, /Current release: \*\*v0\.8\*\* \(package version `0\.8\.0`\)\./);
  assert.match(agentGuide, /Current release: \*\*v0\.8\*\* \(package version `0\.8\.0`\)\./);
});

test("Linux release archive names identify the version, architecture, and Arch Linux build host", () => {
  assert.equal(
    linuxReleaseArchiveName("0.7.0", "x64"),
    "Auri_0.7.0_linux_x86_64_archlinux.tar.gz"
  );
});

test("Linux release instructions explain click-to-run use and distribution compatibility", () => {
  const readme = linuxReleaseReadme("0.7.0", "x86_64");

  assert.match(readme, /extract/i);
  assert.match(readme, /double-click the executable named Auri/i);
  assert.match(readme, /built and tested on an Arch Linux-based system/i);
  assert.match(readme, /Debian and Ubuntu may not work/i);
  assert.match(readme, /more Linux builds are coming soon/i);
});

test("Linux archive includes a desktop launcher for the colocated executable", () => {
  const desktop = linuxReleaseDesktopEntry();

  assert.match(desktop, /^\[Desktop Entry\]$/m);
  assert.match(desktop, /^Name=Auri$/m);
  assert.match(desktop, /^Exec=\.\/Auri$/m);
  assert.match(desktop, /^Terminal=false$/m);
});
