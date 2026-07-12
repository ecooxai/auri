import { spawn } from "node:child_process";
import process from "node:process";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

console.log("Starting Auri native development (esbuild watch + Tauri debug app)...");
const code = await runCommand("cargo", ["tauri", "dev"]);
process.exit(code);
