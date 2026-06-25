function typeKey(entry) {
  if (entry.kind === "directory") return "";
  return String(entry.kind || "file").toLowerCase();
}

function nameKey(entry) {
  return String(entry.name || "").toLocaleLowerCase();
}

export function sortFolderEntries(entries = [], sortBy = "name") {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;

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
