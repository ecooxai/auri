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

export function findExistingAuriDevelopmentProcess(processes, { currentPid = process.pid } = {}) {
  return processes.find(({ pid, command }) => pid !== currentPid && isAuriDevelopmentCommand(command)) ?? null;
}
