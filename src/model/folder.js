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

export function mergePolledFolderEntries(previous = [], fresh = []) {
  const previousByPath = new Map((Array.isArray(previous) ? previous : []).map((entry) => [
    String(entry?.path || entry?.name || ""),
    entry
  ]));
  const current = Array.isArray(fresh) ? fresh : [];
  const added = current.filter((entry) => !previousByPath.has(String(entry?.path || entry?.name || ""))).map((entry) => ({ ...entry, _auriNew: true }));
  const existing = current.filter((entry) => previousByPath.has(String(entry?.path || entry?.name || ""))).map((entry) => {
    const previousEntry = previousByPath.get(String(entry?.path || entry?.name || ""));
    return { ...entry, _auriNew: Boolean(previousEntry?._auriNew) };
  });
  return [...added, ...existing];
}
