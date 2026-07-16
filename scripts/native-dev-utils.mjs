export function parseProcessTable(output) {
  return String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]
    }));
}

export function isAuriDevelopmentCommand(command) {
  const normalized = String(command ?? "").replaceAll("\\", "/");
  return (
    /(?:^|[\s/])target\/debug\/(?:auri-desktop|auri-dev)(?:\s|$)/u.test(normalized) ||
    /\/(?:Auri Dev|auri-dev)\.app\/Contents\/MacOS\/(?:auri-desktop|auri-dev)(?:\s|$)/u.test(normalized)
  );
}

export function isAuriDevelopmentControllerCommand(command) {
  const normalized = String(command ?? "").replaceAll("\\", "/");
  return /(?:^|\s)(?:node\s+)?(?:[^\s]+\/)?scripts\/native-(?:dev|watch)\.mjs(?:\s|$)/u.test(normalized) ||
    /(?:^|\s)bash\s+(?:[^\s]+\/)?scripts\/native-watch\.sh(?:\s|$)/u.test(normalized);
}

function isProjectAuriDevelopmentCommand(command, projectRoot) {
  const normalized = String(command ?? "").replaceAll("\\", "/");
  const root = String(projectRoot ?? "").replaceAll("\\", "/").replace(/\/$/u, "");
  if (!root || !normalized.includes(`${root}/`)) return false;
  return isAuriDevelopmentCommand(normalized);
}

export function collectAuriDevelopmentProcessesToStop(
  processes,
  { currentPid = process.pid, lockOwnerPid = null, projectRoot = "" } = {}
) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const childrenByPid = new Map();
  for (const entry of processes) {
    const children = childrenByPid.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByPid.set(entry.ppid, children);
  }

  const protectedPids = new Set();
  let protectedProcess = byPid.get(currentPid);
  while (protectedProcess && !protectedPids.has(protectedProcess.pid)) {
    protectedPids.add(protectedProcess.pid);
    protectedProcess = byPid.get(protectedProcess.ppid);
  }

  const roots = new Set();
  const lockOwner = byPid.get(lockOwnerPid);
  if (
    lockOwner &&
    !protectedPids.has(lockOwner.pid) &&
    (isAuriDevelopmentControllerCommand(lockOwner.command) ||
      isProjectAuriDevelopmentCommand(lockOwner.command, projectRoot))
  ) {
    roots.add(lockOwner.pid);
  }

  for (const entry of processes) {
    if (protectedPids.has(entry.pid) || !isProjectAuriDevelopmentCommand(entry.command, projectRoot)) continue;
    let root = entry;
    let parent = byPid.get(root.ppid);
    while (parent && !protectedPids.has(parent.pid) && isAuriDevelopmentControllerCommand(parent.command)) {
      root = parent;
      parent = byPid.get(root.ppid);
    }
    roots.add(root.pid);
  }

  const selected = new Set();
  const visit = (pid) => {
    if (selected.has(pid) || protectedPids.has(pid)) return;
    selected.add(pid);
    for (const childPid of childrenByPid.get(pid) ?? []) visit(childPid);
  };
  for (const rootPid of roots) visit(rootPid);

  return processes.filter(({ pid }) => selected.has(pid));
}

export function findExistingAuriDevelopmentProcess(processes, { currentPid = process.pid } = {}) {
  return processes.find(({ pid, command }) => pid !== currentPid && isAuriDevelopmentCommand(command)) ?? null;
}
