let idSequence = 0;
const id = (prefix) => `${prefix}-${++idSequence}`;

const labels = {
  terminal: "Terminal",
  webview: "Web",
  viewer: "Viewer",
  clipboard: "Clipboard",
  audio: "Audio",
  video: "Video",
  settings: "Settings",
  info: "Info"
};

export function createSubtab(type = "terminal", extra = {}) {
  return {
    id: id("subtab"),
    type,
    title: labels[type] ?? type,
    url: type === "webview" ? "https://www.google.com/" : "",
    ...extra
  };
}

export function createWorkspace(title = "Home") {
  const terminal = createSubtab("terminal");
  return {
    id: id("tab"),
    title,
    activeSubtabId: terminal.id,
    subtabs: [terminal, createSubtab("clipboard"), createSubtab("info")],
    folder: { visible: true, path: "~", entries: [], selectedPath: null, selectedCount: 0, sortBy: "name" },
    terminal: { cwd: "~", history: [], draft: "", running: false },
    viewer: { path: null, metadata: null, mode: "empty" }
  };
}

export function createInitialState() {
  const workspace = createWorkspace();
  return {
    activeTabId: workspace.id,
    tabs: [workspace],
    info: { unread: 0, items: [] },
    clipboard: { items: [] },
    models: [
      { id: "gemini-live-default", name: "Gemini Live", type: "gemini-live", model: "gemini-2.5-flash-native-audio", url: "", apiKey: "", enabled: true },
      { id: "openai-default", name: "OpenAI", type: "openai", model: "gpt-4.1-mini", url: "", apiKey: "", enabled: false }
    ],
    selectedModelId: "gemini-live-default",
    settings: {
      theme: "aurora-light",
      fontSize: 20,
      terminalMaxLines: 4000,
      wakeShortcut: "Alt+Space",
      wakeHoldSeconds: 2,
      liveDisconnectSeconds: 60,
      alwaysAttachScreenshot: true,
      screenshotFormat: "jpg",
      audioFormat: "m4a",
      audioBitrateKbps: 64
    },
    media: { status: "idle", kind: null, previewUrl: null, fileName: null, attachments: [] },
    ui: { addSubtabMenuOpen: false, folderMenuOpen: false, commandPaletteOpen: false, focusedInput: "terminal", liveConnected: false, liveStatus: "idle" }
  };
}

const updateTab = (state, workspaceId, updater) => ({
  ...state,
  tabs: state.tabs.map((tab) => tab.id === (workspaceId || state.activeTabId) ? updater(tab) : tab)
});

const updateActiveTab = (state, updater) => updateTab(state, state.activeTabId, updater);

export function reduceState(state, event) {
  switch (event.type) {
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
        const subtab = createSubtab(event.payload.type);
        return { ...tab, subtabs: [...tab.subtabs, subtab], activeSubtabId: subtab.id };
      });
    case "SUBTAB_SELECT":
      return updateActiveTab(state, (tab) => tab.subtabs.some((item) => item.id === event.payload.id)
        ? { ...tab, activeSubtabId: event.payload.id }
        : tab);
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
        folder: { ...tab.folder, path: event.payload.path },
        terminal: { ...tab.terminal, cwd: event.payload.path }
      }));
    case "FOLDER_ENTRIES_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({ ...tab, folder: { ...tab.folder, entries: event.payload.entries } }));
    case "FOLDER_SORT_SET":
      return updateTab(state, event.payload.workspaceId, (tab) => ({ ...tab, folder: { ...tab.folder, sortBy: event.payload.sortBy } }));
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
    case "TERMINAL_OUTPUT_ADD":
      return updateActiveTab(state, (tab) => ({
        ...tab,
        terminal: { ...tab.terminal, history: [...tab.terminal.history, event.payload], running: false }
      }));
    case "TERMINAL_RUNNING_SET":
      return updateActiveTab(state, (tab) => ({ ...tab, terminal: { ...tab.terminal, running: event.payload.value } }));
    case "TERMINAL_CLEAR":
      return updateActiveTab(state, (tab) => ({ ...tab, terminal: { ...tab.terminal, history: [] } }));
    case "INFO_ADD":
      return {
        ...state,
        info: { unread: state.info.unread + 1, items: [{ id: id("info"), at: new Date().toISOString(), ...event.payload }, ...state.info.items] }
      };
    case "INFO_CLEAR":
      return { ...state, info: { unread: 0, items: [] } };
    case "INFO_READ":
      return { ...state, info: { ...state.info, unread: 0 } };
    case "SETTING_SET": {
      let value = event.payload.value;
      if (event.payload.key === "fontSize") {
        value = Math.min(30, Math.max(14, Number(value) || 20));
      } else if (event.payload.key === "terminalMaxLines") {
        value = Math.min(100000, Math.max(100, Number(value) || 4000));
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
    case "CLIPBOARD_SET":
      return { ...state, clipboard: { items: event.payload.items } };
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
