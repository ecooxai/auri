function typeKey(entry) {
  if (entry.kind === "directory") return "";
  return String(entry.kind || "file").toLowerCase();
}

function nameKey(entry) {
  return String(entry.name || "").toLocaleLowerCase();
}

function hiddenKey(entry) {
  return String(entry.name || "").startsWith(".") ? 1 : 0;
}

export const NEW_FOLDER_HIGHLIGHT_MS = 30_000;

export function sortFolderEntries(entries = [], sortBy = "name") {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    if (Boolean(left?._auriNew) !== Boolean(right?._auriNew)) return left?._auriNew ? -1 : 1;
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    const hiddenOrder = hiddenKey(left) - hiddenKey(right);
    if (hiddenOrder) return hiddenOrder;

    if (sortBy === "date") {
      const dateOrder = Number(right.modified || 0) - Number(left.modified || 0);
      if (dateOrder) return dateOrder;
    } else if (sortBy === "type") {
      const typeOrder = typeKey(left).localeCompare(typeKey(right));
      if (typeOrder) return typeOrder;
    }

    return nameKey(left).localeCompare(nameKey(right));
  });
  return sorted;
}

export function mergePolledFolderEntries(previous = [], fresh = [], now = Date.now()) {
  const previousByPath = new Map((Array.isArray(previous) ? previous : []).map((entry) => [
    String(entry?.path || entry?.name || ""),
    entry
  ]));
  const current = Array.isArray(fresh) ? fresh : [];
  const added = current.filter((entry) => !previousByPath.has(String(entry?.path || entry?.name || ""))).map((entry) => ({ ...entry, _auriNew: true, _auriNewAt: now }));
  const existing = current.filter((entry) => previousByPath.has(String(entry?.path || entry?.name || ""))).map((entry) => {
    const previousEntry = previousByPath.get(String(entry?.path || entry?.name || ""));
    const discoveredAt = Number(previousEntry?._auriNewAt) || now;
    const isNew = Boolean(previousEntry?._auriNew) && now - discoveredAt < NEW_FOLDER_HIGHLIGHT_MS;
    return { ...entry, _auriNew: isNew, ...(isNew ? { _auriNewAt: discoveredAt } : {}) };
  });
  return [...added, ...existing];
}

export function expireNewFolderEntries(entries = [], now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry?._auriNew) return entry;
    const discoveredAt = Number(entry._auriNewAt) || now;
    if (now - discoveredAt < NEW_FOLDER_HIGHLIGHT_MS) return entry;
    const { _auriNewAt, ...rest } = entry;
    return { ...rest, _auriNew: false };
  });
}
