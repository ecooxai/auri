export function normalizeWatchDelay(value) {
  const input = String(value ?? "10").trim() || "10";
  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(input)) {
    throw new Error("AURI_WATCH_DELAY must be a non-negative number of seconds.");
  }
  return Math.round(Number(input) * 1000);
}

export function isNativeWatchPath(value) {
  const filename = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
  if (!filename) return false;
  if (
    filename === "dist" || filename.startsWith("dist/") ||
    filename === "node_modules" || filename.startsWith("node_modules/") ||
    filename === "src-tauri/target" || filename.startsWith("src-tauri/target/")
  ) return false;
  return (
    filename === "index.html" ||
    filename === "styles.css" ||
    filename === "favicon.png" ||
    filename === "browser-overlay.html" ||
    filename === "browser-overlay.css" ||
    filename === "browser-overlay.js" ||
    filename === "src-tauri/Cargo.toml" ||
    filename === "src-tauri/tauri.conf.json" ||
    filename === "src-tauri/Info.plist" ||
    filename === "src-tauri/build.rs" ||
    filename.startsWith("src/") ||
    filename.startsWith("src-tauri/src/")
  );
}

export function nativeWatchChangeRequiresBuild(value) {
  const filename = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
  return (
    filename === "src-tauri/Cargo.toml" ||
    filename === "src-tauri/tauri.conf.json" ||
    filename === "src-tauri/Info.plist" ||
    filename === "src-tauri/build.rs" ||
    filename.startsWith("src-tauri/src/")
  );
}
