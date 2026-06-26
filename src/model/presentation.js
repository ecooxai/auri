export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[index]}`;
}

export function iconForEntry(entry) {
  if (entry?.kind === "directory") return "▸";
  if (entry?.kind === "image") return "◈";
  if (entry?.kind === "audio") return "♪";
  if (entry?.kind === "video") return "▷";
  if (entry?.kind === "text") return "≡";
  return "·";
}

export function classifyTerminalInput(input) {
  return /^\s*auri(?:\s|$)/i.test(String(input ?? "")) ? "auri" : "shell";
}

export function workspaceLabel(workspace) {
  const path = String(workspace?.folder?.path ?? "").trim();
  const normalizedPath = path.replace(/[\\/]+$/, "");
  const folderName = path && path !== "~"
    ? normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) || path
    : "";
  const fallback = String(workspace?.title || "Workspace").trim() || "Workspace";
  return folderName || fallback;
}
