import { attachProcessNetworkRates, clampSystemProcessPage } from "./system.js";

let idSequence = 0;
const id = (prefix) => `${prefix}-${++idSequence}`;

// Terminal output lives in the PTY emulator; this state copy only feeds
// command results, so keep it small instead of growing for the whole session.
const MAX_TERMINAL_HISTORY_ITEMS = 200;
const MAX_INFO_ITEMS = 200;

const labels = {
  terminal: "Terminal",
  webview: "Web",
  viewer: "Viewer",
  clipboard: "Clipboard",
  audio: "Audio",
  video: "Video",
  settings: "Settings",
  system: "System",
  disk: "Disk",
  net: "Net",
  info: "Info"
};

export function createSubtab(type = "terminal", extra = {}) {
  return {
    id: id("subtab"),
    type,
    title: labels[type] ?? type,
    url: type === "webview" ? "https://www.google.com/" : "",
    zoom: type === "webview" ? 1 : undefined,
    ...extra
  };
}

export function createWorkspace(title = "Home", options = {}) {
  const terminal = createSubtab("terminal", { cwd: "~" });
  const system = createSubtab("system");
  const subtabs = options.includeSystem
    ? [terminal, system, createSubtab("clipboard"), createSubtab("info")]
    : [terminal, createSubtab("clipboard"), createSubtab("info")];
  return {
    id: id("tab"),
    title,
    activeSubtabId: options.activeSubtabType === "system" ? system.id : terminal.id,
    subtabs,
    folder: { visible: true, path: "~", entries: [], expanded: {}, selectedPath: null, selectedCount: 0, sortBy: "name" },
    terminal: { cwd: "~", history: [], commandHistory: [], draft: "", running: false },
    viewer: { path: null, metadata: null, mode: "empty" }
  };
}

export function createInitialState() {
  const workspace = createWorkspace("Home", { includeSystem: true });
  return {
    activeTabId: workspace.id,
    tabs: [workspace],
    info: { unread: 0, items: [] },
    clipboard: { items: [] },
    system: { status: "idle", error: null, sortBy: "cpu", filter: "", processPage: 1, selectedProcessPid: null, snapshot: null, tunnels: {}, tunnelStatus: {} },
    browser: { bookmarks: [], history: [] },
    completion: { shellHistory: [] },
    permissions: { microphone: "unknown", screenRecording: "unknown" },
    models: [
      { id: "gemini-live-default", name: "Gemini Live", type: "gemini-live", model: "gemini-2.5-flash-native-audio", url: "", apiKey: "", enabled: true }
    ],
    selectedModelId: "gemini-live-default",
    settings: {
      theme: "aurora-light",
      fontSize: 20,
      folderPaneWidth: 230,
      terminalMaxLines: 4000,
      wakeShortcut: "Alt+Space",
      wakeHoldSeconds: 2,
      liveDisconnectSeconds: 60,
      visibleOnAllWorkspaces: true,
      alwaysAttachScreenshot: true,
      cursorHighlight: false,
      screenshotFormat: "jpg",
      audioFormat: "m4a",
      audioBitrateKbps: 64,
      customCompletions: "",
      webAiPrompts: "",
      commandUsage: []
    },
    media: {
      status: "idle", kind: null, previewUrl: null, fileName: null, attachments: [],
      mode: "video", paused: false, audioInputs: [], videoInputs: [],
      audioDeviceId: null, videoDeviceId: null, grid: false, mirror: true,
      autoZoom: true, cameraBubble: true, includeMicrophone: true, audioSource: "microphone"
    },
    ui: { addSubtabMenuOpen: false, folderMenuOpen: false, folderCreateKind: null, modelMenuId: null, editingModelId: null, clipboardMenuId: null, clipboardInfoId: null, clipboardEditId: null, clipboardPinnedOnly: false, clipboardPage: 0, webMenuOpen: false, webDialog: null, bookmarkDraft: null, webAiReply: null, webMagicMenuOpen: false, commandPaletteOpen: false, commandMenuOpen: false, focusedInput: "terminal", liveConnected: false, liveRecording: false, liveStatus: "idle", infoMediaPreview: null, assistantActions: [], assistantTranscripts: [], systemTunnelPrompt: null, systemKillPrompt: null, tunnelUrlMenuPort: null, systemSearchOpen: false }
  };
}

const updateTab = (state, workspaceId, updater) => ({
  ...state,
  tabs: state.tabs.map((tab) => tab.id === (workspaceId || state.activeTabId) ? updater(tab) : tab)
});

const updateActiveTab = (state, updater) => updateTab(state, state.activeTabId, updater);

export function serializeWorkspaceSession(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === state?.activeTabId));
  return {
    activeIndex,
    items: tabs.map((tab, index) => {
      const commandHistory = Array.isArray(tab?.terminal?.commandHistory)
        ? tab.terminal.commandHistory.filter((item) => typeof item === "string" && item.trim()).slice(0, 200)
        : [];
      return {
        title: String(tab?.title || (index === 0 ? "Home" : `Space ${index + 1}`)),
        path: String(tab?.folder?.path || tab?.terminal?.cwd || "~"),
        ...(commandHistory.length ? { commandHistory } : {})
      };
    })
  };
}

function workspaceFromSession(item, index) {
  const fallbackTitle = index === 0 ? "Home" : `Space ${index + 1}`;
  const title = String(item?.title || fallbackTitle).trim() || fallbackTitle;
  const path = String(item?.path || "~").trim() || "~";
  const workspace = createWorkspace(title, { includeSystem: index === 0 });
  const firstTerminal = workspace.subtabs.find((item) => item.type === "terminal");
  return {
    ...workspace,
    activeSubtabId: firstTerminal?.id || workspace.activeSubtabId,
    subtabs: workspace.subtabs.map((item) => item.id === firstTerminal?.id ? { ...item, cwd: path } : item),
    folder: { ...workspace.folder, path },
    terminal: {
      ...workspace.terminal,
      cwd: path,
      commandHistory: Array.isArray(item?.commandHistory)
        ? item.commandHistory.filter((entry) => typeof entry === "string" && entry.trim()).slice(0, 200)
        : []
    }
  };
}

export function reduceState(state, event) {
  switch (event.type) {
    case "WORKSPACES_RESTORE": {
      const items = Array.isArray(event.payload?.items) ? event.payload.items.slice(0, 50) : [];
      if (!items.length) return state;
      const tabs = items.map(workspaceFromSession);
      return { ...state, tabs, activeTabId: tabs[0].id };
    }
    case "TAB_NEW": {
      const workspace = createWorkspace(event.payload?.title || `Space ${state.tabs.length + 1}`);
      return { ...state, tabs: [...state.tabs, workspace], activeTabId: workspace.id };
    }
    case "TAB_SELECT":
      return state.tabs.some((tab) => tab.id === event.payload.id)
        ? { ...state, activeTabId: event.payload.id }
        : state;
    case "TAB_CLOSE": {
      if (state.tabs.length === 1) return state;
      const closingId = event.payload?.id || state.activeTabId;
      const closingIndex = state.tabs.findIndex((tab) => tab.id === closingId);
      const tabs = state.tabs.filter((tab) => tab.id !== closingId);
      if (tabs.length === state.tabs.length) return state;
      const activeTabId = state.activeTabId === closingId
        ? tabs[Math.max(0, closingIndex - 1)]?.id || tabs[0].id
        : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }
    case "SUBTAB_NEW":
      return updateActiveTab(state, (tab) => {
        const type = event.payload.type;
        const terminalCount = tab.subtabs.filter((item) => item.type === "terminal").length;
        const subtab = createSubtab(type, type === "terminal" ? {
          cwd: event.payload.cwd || tab.folder.path || tab.terminal.cwd,
          title: `Terminal ${terminalCount + 1}`
        } : {});
        if (type !== "terminal") return { ...tab, subtabs: [...tab.subtabs, subtab], activeSubtabId: subtab.id };
        const insertAt = tab.subtabs.reduce((last, item, index) => item.type === "terminal" ? index + 1 : last, 0);
        const subtabs = [...tab.subtabs];
        subtabs.splice(insertAt, 0, subtab);
        return { ...tab, subtabs, activeSubtabId: subtab.id, terminal: { ...tab.terminal, cwd: subtab.cwd } };
      });
    case "SUBTAB_SELECT":
      return updateActiveTab(state, (tab) => {
        const selected = tab.subtabs.find((item) => item.id === event.payload.id);
        if (!selected) return tab;
        return {
          ...tab,
          activeSubtabId: selected.id,
          terminal: selected.type === "terminal"
            ? { ...tab.terminal, cwd: selected.cwd || tab.terminal.cwd }
            : tab.terminal
        };
      });
    case "SUBTAB_CLOSE":
      return updateActiveTab(state, (tab) => {
        if (tab.subtabs.length === 1) return tab;
        const closingId = event.payload?.id || tab.activeSubtabId;
        const index = tab.subtabs.findIndex((item) => item.id === closingId);
        const subtabs = tab.subtabs.filter((item) => item.id !== closingId);
        return {
          ...tab,
          subtabs,
          activeSubtabId: tab.activeSubtabId === closingId
            ? subtabs[Math.max(0, index - 1)]?.id || subtabs[0].id
            : tab.activeSubtabId
        };
      });
    case "WORKDIR_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({
        ...tab,
        folder: { ...tab.folder, path: event.payload.path, expanded: {}, selectedPath: null, selectedCount: 0 },
        terminal: { ...tab.terminal, cwd: event.payload.path },
        subtabs: tab.subtabs.map((item) => item.id === tab.activeSubtabId && item.type === "terminal"
          ? { ...item, cwd: event.payload.path }
          : item)
      }));
    case "FOLDER_PATH_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({
        ...tab,
        folder: { ...tab.folder, path: event.payload.path, expanded: {}, selectedPath: null, selectedCount: 0 }
      }));
    case "TERMINAL_CWD_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => {
        const terminalId = event.payload.terminalId || tab.activeSubtabId;
        return {
          ...tab,
          terminal: (event.payload.mirrorWorkspace ?? (terminalId === tab.activeSubtabId))
            ? { ...tab.terminal, cwd: event.payload.path }
            : tab.terminal,
          subtabs: tab.subtabs.map((item) => item.id === terminalId && item.type === "terminal"
            ? { ...item, cwd: event.payload.path }
            : item)
        };
      });
    case "FOLDER_ENTRIES_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({ ...tab, folder: { ...tab.folder, entries: event.payload.entries } }));
    case "FOLDER_SORT_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({ ...tab, folder: { ...tab.folder, sortBy: event.payload.sortBy } }));
    case "FOLDER_EXPANDED_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({
        ...tab,
        folder: {
          ...tab.folder,
          expanded: {
            ...(tab.folder.expanded || {}),
            [event.payload.path]: { entries: Array.isArray(event.payload.entries) ? event.payload.entries : [] }
          }
        }
      }));
    case "FOLDER_EXPANDED_REMOVE":
      return updateTab(state, event.payload.workspaceId, (tab) => {
        const expanded = { ...(tab.folder.expanded || {}) };
        delete expanded[event.payload.path];
        return { ...tab, folder: { ...tab.folder, expanded } };
      });
    case "FOLDER_ENTRY_SELECT":
      return updateActiveTab(state, (tab) => ({
        ...tab,
        folder: {
          ...tab.folder,
          selectedPath: event.payload.path,
          selectedCount: tab.folder.selectedPath === event.payload.path ? tab.folder.selectedCount + 1 : 1
        }
      }));
    case "FILE_SELECT":
      return updateActiveTab(state, (tab) => ({
        ...tab,
        folder: {
          ...tab.folder,
          selectedPath: event.payload.path,
          selectedCount: tab.folder.selectedPath === event.payload.path ? tab.folder.selectedCount + 1 : 1
        },
        viewer: { ...tab.viewer, path: event.payload.path, metadata: event.payload.metadata ?? null, mode: event.payload.open ? "open" : "inspect" }
      }));
    case "TERMINAL_DRAFT_SET":
      return updateActiveTab(state, (tab) => ({ ...tab, terminal: { ...tab.terminal, draft: event.payload.value } }));
    case "SHELL_HISTORY_SET": {
      const commands = Array.isArray(event.payload?.commands)
        ? event.payload.commands.filter((item) => typeof item === "string" && item.trim()).slice(0, 500)
        : [];
      return { ...state, completion: { ...state.completion, shellHistory: commands } };
    }
    case "TERMINAL_COMMAND_REMEMBER": {
      const command = String(event.payload?.command ?? "").trim();
      if (!command) return state;
      const withHistory = updateActiveTab(state, (tab) => {
        const previous = Array.isArray(tab.terminal.commandHistory) ? tab.terminal.commandHistory : [];
        const commandHistory = [command, ...previous.filter((item) => item !== command)].slice(0, 200);
        return { ...tab, terminal: { ...tab.terminal, commandHistory } };
      });
      const previousUsage = Array.isArray(state.settings.commandUsage) ? state.settings.commandUsage : [];
      const previousEntry = previousUsage.find((item) => item?.command === command);
      const count = Math.max(0, Number(previousEntry?.count) || 0) + 1;
      const commandUsage = [
        { command, count },
        ...previousUsage.filter((item) => item?.command !== command)
      ].slice(0, 500);
      const customLines = String(state.settings.customCompletions || "")
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const hasCustom = customLines.some((item) => item.toLocaleLowerCase() === command.toLocaleLowerCase());
      const customCompletions = count >= 5 && !hasCustom
        ? [...customLines, command].join("\n")
        : String(state.settings.customCompletions || "");
      return {
        ...withHistory,
        settings: { ...withHistory.settings, commandUsage, customCompletions }
      };
    }
    case "TERMINAL_OUTPUT_ADD":
      return updateActiveTab(state, (tab) => ({
        ...tab,
        terminal: { ...tab.terminal, history: [...tab.terminal.history, event.payload].slice(-MAX_TERMINAL_HISTORY_ITEMS), running: false }
      }));
    case "TERMINAL_RUNNING_SET":
      return updateActiveTab(state, (tab) => ({ ...tab, terminal: { ...tab.terminal, running: event.payload.value } }));
    case "TERMINAL_CLEAR":
      return updateActiveTab(state, (tab) => ({ ...tab, terminal: { ...tab.terminal, history: [] } }));
    case "INFO_ADD":
      return {
        ...state,
        info: {
          unread: state.info.unread + 1,
          items: [{ id: id("info"), at: new Date().toISOString(), ...event.payload }, ...state.info.items].slice(0, MAX_INFO_ITEMS)
        }
      };
    case "INFO_CLEAR":
      return { ...state, info: { unread: 0, items: [] } };
    case "INFO_READ":
      return { ...state, info: { ...state.info, unread: 0 } };
    case "PERMISSIONS_SET":
      return {
        ...state,
        permissions: { ...state.permissions, ...(event.payload || {}) }
      };
    case "SETTING_SET": {
      let value = event.payload.value;
      if (event.payload.key === "fontSize") {
        value = Math.min(30, Math.max(14, Number(value) || 20));
      } else if (event.payload.key === "folderPaneWidth") {
        value = Math.min(420, Math.max(160, Number(value) || 230));
      } else if (event.payload.key === "terminalMaxLines") {
        value = Math.min(100000, Math.max(100, Number(value) || 4000));
      } else if (event.payload.key === "liveDisconnectSeconds") {
        const seconds = Number(value);
        value = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, seconds)) : 60;
      }
      return { ...state, settings: { ...state.settings, [event.payload.key]: value } };
    }
    case "MODEL_ADD":
      return { ...state, models: [...state.models, event.payload] };
    case "MODEL_UPDATE":
      return { ...state, models: state.models.map((model) => model.id === event.payload.id ? { ...model, ...event.payload.patch } : model) };
    case "MODEL_SELECT":
      return state.models.some((model) => model.id === event.payload.id)
        ? { ...state, selectedModelId: event.payload.id }
        : state;
    case "MODEL_DELETE": {
      const models = state.models.filter((model) => model.id !== event.payload.id);
      if (models.length === state.models.length) return state;
      const selectedModelId = state.selectedModelId === event.payload.id
        ? models[0]?.id || null
        : state.selectedModelId;
      return {
        ...state,
        models,
        selectedModelId,
        ui: {
          ...state.ui,
          modelMenuId: state.ui.modelMenuId === event.payload.id ? null : state.ui.modelMenuId,
          editingModelId: state.ui.editingModelId === event.payload.id ? null : state.ui.editingModelId
        }
      };
    }
    case "CLIPBOARD_SET": {
      const items = Array.isArray(event.payload.items) ? event.payload.items : [];
      const maxPage = Math.max(0, Math.ceil(items.length / 50) - 1);
      const clipboardPage = Math.min(maxPage, Math.max(0, Number(state.ui.clipboardPage) || 0));
      return { ...state, clipboard: { items }, ui: { ...state.ui, clipboardPage } };
    }
    case "SYSTEM_STATUS_SET":
      return { ...state, system: { ...state.system, status: event.payload.status, error: event.payload.error || null } };
    case "SYSTEM_SNAPSHOT_SET": {
      const snapshot = attachProcessNetworkRates(event.payload.snapshot, state.system.snapshot);
      const processPage = clampSystemProcessPage(state.system.processPage, snapshot?.processes, state.system.filter);
      return { ...state, system: { ...state.system, status: "ready", error: null, snapshot, processPage } };
    }
    case "SYSTEM_SORT_SET":
      return { ...state, system: { ...state.system, sortBy: event.payload.sortBy || "cpu", processPage: 1 } };
    case "SYSTEM_FILTER_SET":
      return { ...state, system: { ...state.system, filter: String(event.payload?.filter ?? "").trim(), processPage: 1 } };
    case "SYSTEM_PROCESS_PAGE_NEXT":
      return {
        ...state,
        system: {
          ...state.system,
          processPage: clampSystemProcessPage((Number(state.system.processPage) || 1) + 1, state.system.snapshot?.processes, state.system.filter)
        }
      };
    case "SYSTEM_PROCESS_PAGE_PREVIOUS":
      return {
        ...state,
        system: {
          ...state.system,
          processPage: clampSystemProcessPage((Number(state.system.processPage) || 1) - 1, state.system.snapshot?.processes, state.system.filter)
        }
      };
    case "SYSTEM_PROCESS_SELECT": {
      const selectedProcessPid = Number(event.payload.pid) || null;
      // Closing or switching the detail card must not leave a kill prompt for the old process.
      const systemKillPrompt = selectedProcessPid === state.system.selectedProcessPid ? state.ui.systemKillPrompt : null;
      return { ...state, system: { ...state.system, selectedProcessPid }, ui: { ...state.ui, systemKillPrompt } };
    }
    case "SYSTEM_TUNNEL_PENDING_SET": {
      const port = Number(event.payload?.port);
      if (!Number.isInteger(port) || port <= 0) return state;
      return { ...state, system: { ...state.system, tunnelStatus: { ...(state.system.tunnelStatus || {}), [port]: { port, status: String(event.payload?.status || "starting") } } } };
    }
    case "SYSTEM_TUNNEL_PENDING_REMOVE": {
      const port = Number(event.payload?.port);
      if (!Number.isInteger(port) || port <= 0) return state;
      const tunnelStatus = { ...(state.system.tunnelStatus || {}) };
      delete tunnelStatus[port];
      return { ...state, system: { ...state.system, tunnelStatus } };
    }
    case "SYSTEM_TUNNEL_SET": {
      const port = Number(event.payload?.port);
      if (!Number.isInteger(port) || port <= 0) return state;
      const tunnel = {
        port,
        url: String(event.payload?.url || ""),
        pid: Number(event.payload?.pid) || null,
        path: String(event.payload?.path || "")
      };
      const tunnelStatus = { ...(state.system.tunnelStatus || {}) };
      delete tunnelStatus[port];
      return { ...state, system: { ...state.system, tunnels: { ...(state.system.tunnels || {}), [port]: tunnel }, tunnelStatus } };
    }
    case "SYSTEM_TUNNEL_REMOVE": {
      const port = Number(event.payload?.port);
      if (!Number.isInteger(port) || port <= 0) return state;
      const tunnels = { ...(state.system.tunnels || {}) };
      const tunnelStatus = { ...(state.system.tunnelStatus || {}) };
      delete tunnels[port];
      delete tunnelStatus[port];
      return { ...state, system: { ...state.system, tunnels, tunnelStatus } };
    }
    case "BROWSER_RESTORE":
      return {
        ...state,
        browser: {
          bookmarks: Array.isArray(event.payload?.bookmarks) ? event.payload.bookmarks : [],
          history: Array.isArray(event.payload?.history) ? event.payload.history.slice(0, 200) : []
        }
      };
    case "BROWSER_BOOKMARK_ADD": {
      const item = event.payload;
      const bookmarks = state.browser.bookmarks.filter((entry) => entry.id !== item.id && entry.url !== item.url);
      return { ...state, browser: { ...state.browser, bookmarks: [item, ...bookmarks] } };
    }
    case "BROWSER_BOOKMARK_REMOVE":
      return { ...state, browser: { ...state.browser, bookmarks: state.browser.bookmarks.filter((item) => item.id !== event.payload.id) } };
    case "BROWSER_HISTORY_ADD": {
      const item = event.payload;
      const history = state.browser.history[0]?.url === item.url
        ? [item, ...state.browser.history.slice(1)]
        : [item, ...state.browser.history];
      return { ...state, browser: { ...state.browser, history: history.slice(0, 200) } };
    }
    case "BROWSER_HISTORY_CLEAR":
      return { ...state, browser: { ...state.browser, history: [] } };
    case "MEDIA_SET":
      return { ...state, media: { ...state.media, ...event.payload } };
    case "ATTACHMENT_ADD":
      return { ...state, media: { ...state.media, attachments: [...state.media.attachments, event.payload] } };
    case "ATTACHMENT_REMOVE":
      return { ...state, media: { ...state.media, attachments: state.media.attachments.filter((item) => item.id !== event.payload.id) } };
    case "ATTACHMENTS_CLEAR":
      return { ...state, media: { ...state.media, attachments: [] } };
    case "SUBTAB_UPDATE":
      return updateActiveTab(state, (tab) => ({
        ...tab,
        subtabs: tab.subtabs.map((item) => item.id === event.payload.id ? { ...item, ...event.payload.patch } : item)
      }));
    case "UI_SET":
      return { ...state, ui: { ...state.ui, ...event.payload } };
    default:
      return state;
  }
}

export function activeWorkspace(state) {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

export function activeSubtab(state) {
  const tab = activeWorkspace(state);
  return tab.subtabs.find((item) => item.id === tab.activeSubtabId) ?? tab.subtabs[0];
}
