export const SYSTEM_PROCESS_PAGE_SIZE = 10;

const VALID_SORTS = new Set(["cpu", "port", "name", "pid", "priority", "ram", "net", "disk"]);

export const emptySystemSnapshot = Object.freeze({
  capturedAt: null,
  host: { os: "Unknown", arch: "", hostname: "", uptimeSeconds: null },
  cpu: { brand: "Unknown CPU", cores: 0, usagePercent: null },
  memory: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: null, swapTotalBytes: 0, swapUsedBytes: 0, swapFreeBytes: 0, swapUsagePercent: null },
  network: { interfaces: [], downloadBytesPerSecond: null, uploadBytesPerSecond: null, totalRxBytes: 0, totalTxBytes: 0 },
  disk: { mounts: [], totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: null, readBytesPerSecond: null, writeBytesPerSecond: null },
  gpus: [],
  processes: []
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  // Native Option<f64> values arrive as null; keep unsupported counters distinct from a real zero.
  if (value === null || value === undefined || value === "") return null;
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

// Well-known port → application protocol. Kept deliberately small and readable:
// it only names protocols people recognise (http/https/ssh/ftp/db/…) and returns
// "" for anything unknown so the UI can fall back to the bare transport.
const WELL_KNOWN_PROTOCOLS = new Map([
  [20, "ftp"], [21, "ftp"], [22, "ssh"], [23, "telnet"], [25, "smtp"],
  [53, "dns"], [67, "dhcp"], [68, "dhcp"], [69, "tftp"], [110, "pop3"],
  [123, "ntp"], [143, "imap"], [161, "snmp"], [389, "ldap"], [443, "https"],
  [445, "smb"], [465, "smtps"], [514, "syslog"], [587, "smtp"], [631, "ipp"],
  [636, "ldaps"], [873, "rsync"], [993, "imaps"], [995, "pop3s"], [1433, "mssql"],
  [1521, "oracle"], [2049, "nfs"], [3306, "mysql"], [3389, "rdp"], [5060, "sip"],
  [5432, "postgres"], [5900, "vnc"], [6379, "redis"], [8443, "https"],
  [9092, "kafka"], [11211, "memcached"], [27017, "mongodb"]
]);

// Ports that are conventionally plain HTTP (dev servers and proxies).
const HTTP_PORTS = new Set([80, 3000, 4173, 5173, 8000, 8080, 8081, 8888]);

export function protocolForPort(port, transport = "tcp") {
  const number = Number(port);
  if (!Number.isInteger(number) || number <= 0) return "";
  if (WELL_KNOWN_PROTOCOLS.has(number)) return WELL_KNOWN_PROTOCOLS.get(number);
  if (HTTP_PORTS.has(number)) return "http";
  return "";
}

function normalizeTransport(transport) {
  return String(transport || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
}

// Structured port list [{ port, transport, protocol }], merged from the native
// `portDetails` (which carries the real tcp/udp transport) and the plain numeric
// `ports` (assumed tcp). Protocol is always derived here so there is a single
// source of truth for it. Deduplicated by transport+port and sorted by port.
export function normalizePortDetails(process) {
  const details = new Map();
  const add = (port, transport) => {
    const number = Number(port);
    if (!Number.isInteger(number) || number <= 0) return;
    const normalizedTransport = normalizeTransport(transport);
    const key = `${normalizedTransport}:${number}`;
    if (!details.has(key)) {
      details.set(key, { port: number, transport: normalizedTransport, protocol: protocolForPort(number, normalizedTransport) });
    }
  };
  if (Array.isArray(process?.portDetails)) {
    for (const detail of process.portDetails) add(detail?.port, detail?.transport);
  }
  for (const port of normalizePortList(process?.ports)) add(port, "tcp");
  return [...details.values()].sort((left, right) => left.port - right.port || left.transport.localeCompare(right.transport));
}

// Vague, case-insensitive search: whitespace splits the query into keywords and
// a process matches when ANY keyword is a substring of its searchable text, so
// "chrome claude" shows every Chrome and every Claude process.
function processSearchHaystack(process) {
  return [process?.name, process?.commandLine, process?.path, process?.pid, ...(process?.gpuNames || []), ...(process?.gpuIds || []), ...normalizePortList(process?.ports)]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
}

export function searchKeywords(query) {
  return String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesProcessSearch(process, query) {
  const keywords = searchKeywords(query);
  if (!keywords.length) return true;
  const haystack = processSearchHaystack(process);
  return keywords.some((keyword) => haystack.includes(keyword));
}

export function filterSystemProcesses(processes = [], query = "") {
  const list = Array.isArray(processes) ? processes : [];
  if (!searchKeywords(query).length) return list;
  return list.filter((process) => matchesProcessSearch(process, query));
}

export function systemProcessPageCount(processes = [], query = "") {
  return Math.max(1, Math.ceil(filterSystemProcesses(processes, query).length / SYSTEM_PROCESS_PAGE_SIZE));
}

export function clampSystemProcessPage(page, processes = [], query = "") {
  const requested = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 1;
  return Math.min(systemProcessPageCount(processes, query), Math.max(1, requested));
}

// Derives per-process network throughput (bytes/second) by diffing the
// cumulative download/upload counters against the previous snapshot. Pure and
// deterministic; the first snapshot (no previous) yields zero rates.
export function attachProcessNetworkRates(snapshot, previous) {
  const processes = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  const previousByPid = new Map();
  for (const process of previous?.processes || []) previousByPid.set(finiteNumber(process?.pid), process);
  const previousTime = Date.parse(previous?.capturedAt);
  const currentTime = Date.parse(snapshot?.capturedAt);
  const elapsedSeconds = Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime > previousTime
    ? (currentTime - previousTime) / 1000
    : 0;
  return {
    ...snapshot,
    processes: processes.map((process) => {
      const prior = previousByPid.get(finiteNumber(process?.pid));
      let downloadBytesPerSecond = 0;
      let uploadBytesPerSecond = 0;
      if (elapsedSeconds > 0 && prior) {
        const downloadDelta = finiteNumber(process?.downloadBytes) - finiteNumber(prior?.downloadBytes);
        const uploadDelta = finiteNumber(process?.uploadBytes) - finiteNumber(prior?.uploadBytes);
        downloadBytesPerSecond = downloadDelta > 0 ? downloadDelta / elapsedSeconds : 0;
        uploadBytesPerSecond = uploadDelta > 0 ? uploadDelta / elapsedSeconds : 0;
      }
      return { ...process, downloadBytesPerSecond, uploadBytesPerSecond };
    })
  };
}

function combinedNetworkBytes(process) {
  const rate = finiteNumber(process?.downloadBytesPerSecond) + finiteNumber(process?.uploadBytesPerSecond);
  if (rate > 0) return rate;
  return finiteNumber(process?.downloadBytes) + finiteNumber(process?.uploadBytes);
}

function combinedDiskBytes(process) {
  return finiteNumber(process?.diskReadBytes) + finiteNumber(process?.diskWriteBytes);
}

export function primaryProcessPort(process) {
  const ports = normalizePortList(process?.ports);
  return ports.length ? ports[0] : null;
}

export function processPriorityIdentity(process) {
  const path = String(process?.path || "").trim();
  if (path.includes("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const command = String(process?.commandLine || "").trim();
  if (command) return command.split(/\s+/)[0];
  return path || String(process?.name || "").trim();
}

export function sortSystemProcesses(processes = [], sortBy = "cpu", sortDirection = "desc") {
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
    if (normalizedSort === "priority") {
      const order = finiteNumber(left.priority) - finiteNumber(right.priority);
      return (sortDirection === "asc" ? order : -order) || String(left.name || "").localeCompare(String(right.name || ""));
    }
    if (normalizedSort === "ram") return finiteNumber(right.memoryBytes) - finiteNumber(left.memoryBytes) || finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent);
    if (normalizedSort === "net") return combinedNetworkBytes(right) - combinedNetworkBytes(left) || finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent);
    if (normalizedSort === "disk") return combinedDiskBytes(right) - combinedDiskBytes(left) || finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent);
    return finiteNumber(right.cpuPercent) - finiteNumber(left.cpuPercent) || finiteNumber(right.memoryBytes) - finiteNumber(left.memoryBytes);
  });
}

function normalizeGpuProcess(process) {
  return {
    pid: finiteNumber(process?.pid),
    name: String(process?.name || `pid ${finiteNumber(process?.pid)}`),
    usagePercent: nullableNumber(process?.usagePercent),
    vramBytes: finiteNumber(process?.vramBytes)
  };
}

function normalizeGpu(gpu, index) {
  const id = String(gpu?.id || `gpu-${index}`);
  return {
    id,
    vendor: String(gpu?.vendor || "unknown").toLowerCase(),
    name: String(gpu?.name || id),
    usagePercent: nullableNumber(gpu?.usagePercent),
    vramTotalBytes: finiteNumber(gpu?.vramTotalBytes),
    vramUsedBytes: finiteNumber(gpu?.vramUsedBytes),
    temperatureCelsius: nullableNumber(gpu?.temperatureCelsius),
    processes: Array.isArray(gpu?.processes)
      ? gpu.processes.map(normalizeGpuProcess).filter((process) => process.pid > 0)
      : []
  };
}

export function gpuProcessesForSnapshot(snapshot = emptySystemSnapshot) {
  const systemProcesses = new Map((snapshot?.processes || []).map((process) => [finiteNumber(process?.pid), process]));
  const combined = new Map();
  for (const gpu of snapshot?.gpus || []) {
    for (const gpuProcess of gpu?.processes || []) {
      const pid = finiteNumber(gpuProcess?.pid);
      if (!pid) continue;
      const current = combined.get(pid) || {
        ...(systemProcesses.get(pid) || {}),
        pid,
        name: String(gpuProcess?.name || systemProcesses.get(pid)?.name || `pid ${pid}`),
        gpuIds: [],
        gpuNames: [],
        gpuDetails: [],
        gpuLabel: "",
        usagePercent: null,
        vramBytes: 0
      };
      if (!current.gpuIds.includes(gpu.id)) current.gpuIds.push(gpu.id);
      if (!current.gpuNames.includes(gpu.name)) current.gpuNames.push(gpu.name);
      const usage = nullableNumber(gpuProcess?.usagePercent);
      const vendor = String(gpu.vendor || "unknown").toLowerCase();
      const shortName = vendor === "nvidia" ? "NV" : vendor === "intel" ? "Intel" : vendor === "amd" ? "AMD" : String(gpu.name || gpu.id);
      if (!current.gpuDetails.some((detail) => detail.id === gpu.id)) {
        current.gpuDetails.push({
          id: gpu.id,
          name: shortName,
          fullName: gpu.name,
          vendor,
          usagePercent: usage,
          vramBytes: finiteNumber(gpuProcess?.vramBytes)
        });
      }
      if (usage !== null) current.usagePercent = current.usagePercent === null ? usage : Math.max(current.usagePercent, usage);
      current.vramBytes += finiteNumber(gpuProcess?.vramBytes);
      current.gpuLabel = current.gpuDetails.map((detail) => `${detail.name} (${detail.usagePercent === null ? "—" : `${detail.usagePercent < 10 ? detail.usagePercent.toFixed(1) : Math.round(detail.usagePercent)}%`})`).join(" · ");
      combined.set(pid, current);
    }
  }
  return [...combined.values()].sort((left, right) =>
    finiteNumber(right.usagePercent, -1) - finiteNumber(left.usagePercent, -1)
    || finiteNumber(right.vramBytes) - finiteNumber(left.vramBytes)
    || String(left.name || "").localeCompare(String(right.name || ""))
  );
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
    gpus: Array.isArray(snapshot?.gpus) ? snapshot.gpus.map(normalizeGpu) : [],
    processes: Array.isArray(snapshot?.processes)
      ? snapshot.processes.map((process) => {
          const portDetails = normalizePortDetails(process);
          return {
            pid: finiteNumber(process?.pid),
            name: displayProcessName(process),
            path: String(process?.path || ""),
            workingDirectory: String(process?.workingDirectory || ""),
            commandLine: String(process?.commandLine || process?.path || process?.name || ""),
            status: String(process?.status || ""),
            priority: Math.trunc(finiteNumber(process?.priority)),
            cpuPercent: finiteNumber(process?.cpuPercent),
            memoryBytes: finiteNumber(process?.memoryBytes),
            downloadBytes: finiteNumber(process?.downloadBytes),
            uploadBytes: finiteNumber(process?.uploadBytes),
            diskReadBytes: finiteNumber(process?.diskReadBytes),
            diskWriteBytes: finiteNumber(process?.diskWriteBytes),
            ports: [...new Set(portDetails.map((detail) => detail.port))].sort((left, right) => left - right),
            portDetails
          };
        })
      : []
  };
}
