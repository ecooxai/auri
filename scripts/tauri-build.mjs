import { spawn } from "node:child_process";
import {
  bundleIdentifierForBuild,
  createTauriLaunchOverride,
  createUniqueBuildId
} from "./launch-config.mjs";

const buildId = process.env.AURI_BUILD_ID || createUniqueBuildId("package");
const config = createTauriLaunchOverride(buildId);
const identifier = bundleIdentifierForBuild(buildId);

console.log(`Building Auri as independent application ${identifier}`);

const child = spawn(
  "cargo",
  ["tauri", "build", "--config", JSON.stringify(config), ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);

child.on("error", (error) => {
  console.error(`Could not start the Tauri build: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
