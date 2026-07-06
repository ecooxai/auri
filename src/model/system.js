const VALID_SORTS = new Set(["cpu", "port", "name", "pid", "ram", "net"]);

export const emptySystemSnapshot = Object.freeze({
  capturedAt: null,
  host: { os: "Unknown", arch: "", hostname: "", uptimeSeconds: null },
  cpu: { brand: "Unknown CPU", cores: 0, usagePercent: null },
  memory: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: null, swapTotalBytes: 0, swapUsedBytes: 0, swapFreeBytes: 0, swapUsagePercent: null },
  network: { interfaces: [], downloadBytesPerSecond: null, uploadBytesPerSecond: null, totalRxBytes: 0, totalTxBytes: 0 },
  disk: { mounts: [], totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: null, readBytesPerSecond: null, writeBytesPerSecond: null },
  processes: []
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePortList(ports) {
  if (!Array.isArray(ports)) return [];
  return [...new Set(ports.map((port) => Number(port)).filter((port) => Number.isInteger(port) && port > 0))]
    .sort((left, right) => left - right);
}

export function normalizeSystemSort(sortBy) {
  return VALID_SORTS.has(sortBy) ? sortBy : "cpu";
}

function combinedNetworkBytes(process) {
  return finiteNumber(process?.downloadBytes) + finiteNumber(process?.uploadBytes);
}

export function primaryProcessPort(process) {
  const ports = normalizePortList(process?.ports);
  return ports.length ? ports[0] : null;
}

export function sortSystemProcesses(processes = [], sortBy = "cpu") {
  const normalizedSort = normalizeSystemSort(sortBy);
  const items = Array.isArray(processes) ? processes.map((item) => ({ ...item, ports: normalizePortList(item?.ports) })) : [];
  return items.sort((left, right) => {
    if (normalizedSort === "port") {
      const leftPort = primaryProcessPort(left);
      const rightPort = primaryProcessPort(right);
      if (leftPort === null && rightPort === null) return String(left.name || "").localeCompare(String(right.name || "")) || finiteNumber(left.pid) - finiteNumber(right.pid);
      if (leftPort === null) return 1;
      if (rightPort === null) return -1;
      return leftPort - rightPort || String(left.name || "").localeCompare(String(right.name || ""));
    }
    if (normalizedSort === "name") return String(left.name || "").localeCompare(String(right.name || "")) || finiteNumber(left.pid) - finiteNumber(right.pid);
    if (normalizedSort === "pid") return finiteNumber(left.pid) - finiteNumber(right.pid);
    if (normalizedSort === "ram") return finiteNumber(right.memoryBytes) - finiteNumber(left.memoryBytes) || finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent);
    if (normalizedSort === "net") return combinedNetworkBytes(right) - combinedNetworkBytes(left) || finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent);
    return finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent) || finiteNumber(right.memoryBytes) - finiteNumber(left.memoryBytes);
  });
}

function appNameFromText(value) {
  const text = String(value || "");
  const segment = text.split("/").find((part) => part.trim().endsWith(".app"));
  return segment ? segment.trim().replace(/\.app$/, "") : "";
}

function basenameFromText(value) {
  const first = String(value || "").trim().split(/\s+/)[0] || "";
  const name = first.split("/").filter(Boolean).pop() || first;
  return name.trim();
}

function displayProcessName(process) {
  const pid = finiteNumber(process?.pid);
  return appNameFromText(process?.commandLine)
    || appNameFromText(process?.path)
    || basenameFromText(process?.commandLine)
    || basenameFromText(process?.path)
    || String(process?.name || `pid ${pid}`);
}

export function normalizeSystemSnapshot(snapshot = emptySystemSnapshot) {
  const memoryTotal = finiteNumber(snapshot?.memory?.totalBytes);
  const memoryUsed = finiteNumber(snapshot?.memory?.usedBytes);
  const memoryFree = Number.isFinite(Number(snapshot?.memory?.freeBytes))
    ? finiteNumber(snapshot.memory.freeBytes)
    : Math.max(0, memoryTotal - memoryUsed);
  const memoryUsage = nullableNumber(snapshot?.memory?.usagePercent)
    ?? (memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 1000) / 10 : null);
  const swapTotal = finiteNumber(snapshot?.memory?.swapTotalBytes);
  const swapUsed = finiteNumber(snapshot?.memory?.swapUsedBytes);
  const swapFree = Number.isFinite(Number(snapshot?.memory?.swapFreeBytes))
    ? finiteNumber(snapshot.memory.swapFreeBytes)
    : Math.max(0, swapTotal - swapUsed);
  const swapUsage = nullableNumber(snapshot?.memory?.swapUsagePercent)
    ?? (swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : null);

  return {
    capturedAt: snapshot?.capturedAt || new Date().toISOString(),
    host: {
      os: String(snapshot?.host?.os || emptySystemSnapshot.host.os),
      arch: String(snapshot?.host?.arch || ""),
      hostname: String(snapshot?.host?.hostname || ""),
      uptimeSeconds: nullableNumber(snapshot?.host?.uptimeSeconds)
    },
    cpu: {
      brand: String(snapshot?.cpu?.brand || emptySystemSnapshot.cpu.brand),
      cores: finiteNumber(snapshot?.cpu?.cores),
      usagePercent: nullableNumber(snapshot?.cpu?.usagePercent)
    },
    memory: {
      totalBytes: memoryTotal,
      usedBytes: memoryUsed,
      freeBytes: memoryFree,
      usagePercent: memoryUsage,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapUsed,
      swapFreeBytes: swapFree,
      swapUsagePercent: swapUsage
    },
    network: {
      interfaces: Array.isArray(snapshot?.network?.interfaces)
        ? snapshot.network.interfaces.map((iface) => ({
            name: String(iface?.name || ""),
            ip: String(iface?.ip || ""),
            status: String(iface?.status || "unknown"),
            rxBytes: finiteNumber(iface?.rxBytes),
            txBytes: finiteNumber(iface?.txBytes)
          })).filter((iface) => iface.name)
        : [],
      downloadBytesPerSecond: nullableNumber(snapshot?.network?.downloadBytesPerSecond),
      uploadBytesPerSecond: nullableNumber(snapshot?.network?.uploadBytesPerSecond),
      totalRxBytes: finiteNumber(snapshot?.network?.totalRxBytes),
      totalTxBytes: finiteNumber(snapshot?.network?.totalTxBytes)
    },
    disk: (() => {
      const diskTotal = finiteNumber(snapshot?.disk?.totalBytes);
      const diskUsed = finiteNumber(snapshot?.disk?.usedBytes);
      const diskFree = Number.isFinite(Number(snapshot?.disk?.freeBytes))
        ? finiteNumber(snapshot.disk.freeBytes)
        : Math.max(0, diskTotal - diskUsed);
      return {
        mounts: Array.isArray(snapshot?.disk?.mounts)
          ? snapshot.disk.mounts.map((mount) => ({
              name: String(mount?.name || mount?.mountPoint || ""),
              mountPoint: String(mount?.mountPoint || mount?.name || ""),
              totalBytes: finiteNumber(mount?.totalBytes),
              usedBytes: finiteNumber(mount?.usedBytes),
              freeBytes: finiteNumber(mount?.freeBytes),
              usagePercent: nullableNumber(mount?.usagePercent)
            })).filter((mount) => mount.mountPoint)
          : [],
        totalBytes: diskTotal,
        usedBytes: diskUsed,
        freeBytes: diskFree,
        usagePercent: nullableNumber(snapshot?.disk?.usagePercent) ?? (diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 1000) / 10 : null),
        readBytesPerSecond: nullableNumber(snapshot?.disk?.readBytesPerSecond),
        writeBytesPerSecond: nullableNumber(snapshot?.disk?.writeBytesPerSecond)
      };
    })(),
    processes: Array.isArray(snapshot?.processes)
      ? snapshot.processes.map((process) => ({
          pid: finiteNumber(process?.pid),
          name: displayProcessName(process),
          path: String(process?.path || ""),
          workingDirectory: String(process?.workingDirectory || ""),
          commandLine: String(process?.commandLine || process?.path || process?.name || ""),
          status: String(process?.status || ""),
          cpuPercent: finiteNumber(process?.cpuPercent),
          memoryBytes: finiteNumber(process?.memoryBytes),
          downloadBytes: finiteNumber(process?.downloadBytes),
          uploadBytes: finiteNumber(process?.uploadBytes),
          diskReadBytes: finiteNumber(process?.diskReadBytes),
          diskWriteBytes: finiteNumber(process?.diskWriteBytes),
          ports: normalizePortList(process?.ports)
        }))
      : []
  };
}
