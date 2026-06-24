import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir("target", { recursive: true });
const compile = spawnSync("rustc", ["--edition=2021", "--test", "src-tauri/tests/core_tests.rs", "-o", "target/auri-core-tests"], { stdio: "inherit" });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const run = spawnSync("target/auri-core-tests", [], { stdio: "inherit" });
process.exit(run.status ?? 1);
