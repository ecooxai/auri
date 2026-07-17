import { filterSystemProcesses, normalizePortDetails, sortSystemProcesses } from "./system.js";

// Terminal buffers ride along in the snapshot so background tabs can live as
// JSON text instead of DOM; the cap keeps one runaway tab from bloating every
// snapshot push and every TUI update.
export const TERMINAL_BUFFER_MAX_CHARS = 65536;
export const SNAPSHOT_PROCESS_LIMIT = 40;
const INFO_ITEM_LIMIT = 30;

function bufferTail(text) {
  const value = String(text ?? "");
  return value.length > TERMINAL_BUFFER_MAX_CHARS ? value.slice(-TERMINAL_BUFFER_MAX_CHARS) : value;
}

function serializeSubtab(subtab, workspace) {
  return {
    id: subtab.id,
    type: subtab.type,
    title: subtab.title,
    active: subtab.id === workspace.activeSubtabId,
    ...(subtab.type === "terminal" ? { cwd: subtab.cwd || workspace.terminal?.cwd || "~" } : {}),
    ...(subtab.type === "webview" ? { url: subtab.url || "" } : {})
  };
}

function serializeWorkspace(workspace, state) {
  return {
    id: workspace.id,
    title: workspace.title,
    active: workspace.id === state.activeTabId,
    activeSubtabId: workspace.activeSubtabId,
    folderPath: workspace.folder?.path || "~",
    subtabs: workspace.subtabs.map((subtab) => serializeSubtab(subtab, workspace)),
    terminal: {
      cwd: workspace.terminal?.cwd || "~",
      running: Boolean(workspace.terminal?.running),
      draft: String(workspace.terminal?.draft || ""),
      commandHistory: (workspace.terminal?.commandHistory || []).slice(0, 50)
    }
  };
}

function serializeProcess(process) {
  return {
    pid: Number(process?.pid) || 0,
    name: String(process?.name || ""),
    cpuPercent: Number(process?.cpuPercent) || 0,
    memoryBytes: Number(process?.memoryBytes) || 0,
    downloadBytesPerSecond: Number(process?.downloadBytesPerSecond) || 0,
    uploadBytesPerSecond: Number(process?.uploadBytesPerSecond) || 0,
    readBytesPerSecond: Number(process?.readBytesPerSecond) || 0,
    writeBytesPerSecond: Number(process?.writeBytesPerSecond) || 0,
    priority: process?.priority ?? null,
    ports: normalizePortDetails(process).map((detail) => detail.port)
  };
}

function serializeSystem(state, processLimit) {
  const system = state.system || {};
  const snapshot = system.snapshot;
  const filtered = filterSystemProcesses(snapshot?.processes || [], system.filter || "");
  const sorted = sortSystemProcesses(filtered, system.sortBy || "cpu", system.sortDirection || "desc");
  return {
    status: system.status || "idle",
    error: system.error || null,
    sortBy: system.sortBy || "cpu",
    sortDirection: system.sortDirection || "desc",
    filter: system.filter || "",
    gpuMode: Boolean(system.gpuMode),
    selectedPid: system.selectedProcessPid ?? null,
    capturedAt: snapshot?.capturedAt ?? null,
    metrics: snapshot ? {
      hostname: snapshot.host?.hostname || "",
      os: snapshot.host?.os || "",
      uptimeSeconds: snapshot.host?.uptimeSeconds ?? null,
      cpuBrand: snapshot.cpu?.brand || "",
      cpuCores: Number(snapshot.cpu?.cores) || 0,
      cpuUsagePercent: snapshot.cpu?.usagePercent ?? null,
      memoryUsedBytes: Number(snapshot.memory?.usedBytes) || 0,
      memoryTotalBytes: Number(snapshot.memory?.totalBytes) || 0,
      memoryUsagePercent: snapshot.memory?.usagePercent ?? null,
      downloadBytesPerSecond: snapshot.network?.downloadBytesPerSecond ?? null,
      uploadBytesPerSecond: snapshot.network?.uploadBytesPerSecond ?? null,
      diskUsedBytes: Number(snapshot.disk?.usedBytes) || 0,
      diskTotalBytes: Number(snapshot.disk?.totalBytes) || 0,
      diskReadBytesPerSecond: snapshot.disk?.readBytesPerSecond ?? null,
      diskWriteBytesPerSecond: snapshot.disk?.writeBytesPerSecond ?? null
    } : null,
    processCount: filtered.length,
    processes: sorted.slice(0, processLimit).map(serializeProcess)
  };
}

function serializeInfo(info) {
  return {
    unread: Number(info?.unread) || 0,
    items: (info?.items || []).slice(0, INFO_ITEM_LIMIT).map((item) => ({
      id: item.id,
      at: item.at,
      title: item.title ?? item.label ?? "",
      message: item.message ?? "",
      level: item.level ?? "info"
    }))
  };
}

function serializeTerminalBuffers(buffers) {
  const terminals = {};
  for (const [subtabId, buffer] of Object.entries(buffers || {})) {
    terminals[subtabId] = {
      sessionId: String(buffer?.sessionId || ""),
      text: bufferTail(buffer?.text)
    };
  }
  return terminals;
}

// Pure snapshot of everything the TUI (and any external observer) needs to
// mirror the GUI: workspaces/subtabs, terminal text, system monitor, and info.
// Terminal buffers and the sequence number come from the caller because the
// model owns neither the emulator output nor the transport.
export function serializeAppSnapshot(state, extras = {}) {
  const processLimit = Number.isInteger(extras.processLimit) ? extras.processLimit : SNAPSHOT_PROCESS_LIMIT;
  const activeWorkspace = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  return {
    v: 1,
    seq: Number(extras.seq) || 0,
    activeTabId: state.activeTabId,
    activeSubtabId: activeWorkspace?.activeSubtabId ?? null,
    workspaces: state.tabs.map((workspace) => serializeWorkspace(workspace, state)),
    terminals: serializeTerminalBuffers(extras.terminalBuffers),
    system: serializeSystem(state, processLimit),
    info: serializeInfo(state.info),
    clipboard: { count: (state.clipboard?.items || []).length },
    settings: { theme: state.settings?.theme || "aurora-light", fontSize: state.settings?.fontSize || 20 }
  };
}

export function appSnapshotJson(state, extras = {}) {
  return JSON.stringify(serializeAppSnapshot(state, extras));
}
