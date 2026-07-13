import test from "node:test";
import assert from "node:assert/strict";

import {
  linuxReleaseArchiveName,
  linuxReleaseDesktopEntry,
  linuxReleaseReadme
} from "../scripts/package-linux-release.mjs";

test("Linux release archive names identify the version, architecture, and Arch Linux build host", () => {
  assert.equal(
    linuxReleaseArchiveName("0.6.0", "x64"),
    "Auri_0.6.0_linux_x86_64_archlinux.tar.gz"
  );
});

test("Linux release instructions explain click-to-run use and distribution compatibility", () => {
  const readme = linuxReleaseReadme("0.6.0", "x86_64");

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
