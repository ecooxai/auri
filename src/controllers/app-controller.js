import { executeCommand } from "./command-controller.js";
import { createInitialState, reduceState, activeWorkspace, activeSubtab, serializeWorkspaceSession } from "../model/state.js";
import { classifyTerminalInput } from "../model/presentation.js";
import { MediaCapture } from "../services/media-recorder.js";
import { isSimpleCdCommand, shellQuote } from "../model/path.js";
import { defaultBookmarkName, nextWebZoom, normalizeWebUrl, titleForWebUrl } from "../model/browser.js";
import { AssistantStreamParser, parseAssistantReply } from "../model/assistant.js";
import { terminalCompletionContext, terminalCompletions } from "../model/terminal-completion.js";
import { shortcutFromKeyboardEvent, shortcutKeyMatchesKeyboardEvent, shortcutMatchesKeyboardEvent } from "../model/shortcut.js";

function parentPath(path) {
  const value = String(path || "~").replace(/\/+$/, "");
  if (value === "~" || value === "/") return value;
  const parts = value.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function quoteArg(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function scheduleFrame(callback) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else callback();
}

function isMacNavigationText(value) {
  return [...String(value ?? "")].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0xf700 && codePoint <= 0xf703;
  });
}

function stripMacNavigationText(value) {
  return [...String(value ?? "")].filter((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 0xf700 || codePoint > 0xf703;
  }).join("");
}

function folderPathArrowDirection(key) {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  const codePoint = String(key ?? "").codePointAt(0);
  if (codePoint === 0xf702) return -1;
  if (codePoint === 0xf703) return 1;
  return 0;
}

function attachmentKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

function hasAssistantActionPopup(state) {
  return Boolean(state?.ui?.assistantActions?.length || state?.ui?.assistantTranscripts?.length);
}

const WORKSPACE_PERSIST_EVENTS = new Set(["TAB_NEW", "TAB_SELECT", "TAB_CLOSE", "WORKDIR_SET", "TERMINAL_COMMAND_REMEMBER"]);

function attachmentPreviewUrl(file, kind) {
  if (kind === "file" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function requestMediaPreview(item, index = 0) {
  const media = {
    id: String(item?.id || `request-media-${Date.now()}-${index}`),
    name: String(item?.name || `Attachment ${index + 1}`),
    kind: String(item?.kind || (String(item?.mime || "").startsWith("image/") ? "image" : String(item?.mime || "").startsWith("audio/") ? "audio" : "file")),
    mime: String(item?.mime || "application/octet-stream"),
    path: item?.path || null,
    url: item?.url || item?.assetUrl || null
  };
  if (!media.url && item?.path && typeof window !== "undefined") {
    const convertFileSrc = window.__TAURI__?.core?.convertFileSrc || window.__TAURI_INTERNALS__?.convertFileSrc;
    try { media.url = convertFileSrc?.(item.path) || null; } catch {}
  }
  if (!media.url && item?.blob && typeof URL !== "undefined" && URL.createObjectURL) {
    try { media.url = URL.createObjectURL(item.blob); } catch {}
  }
  if (!media.url && item?.base64 && typeof URL !== "undefined" && URL.createObjectURL && typeof atob === "function") {
    try {
      const binary = atob(item.base64);
      const bytes = new Uint8Array(binary.length);
      for (let position = 0; position < binary.length; position += 1) bytes[position] = binary.charCodeAt(position);
      media.url = URL.createObjectURL(new Blob([bytes], { type: media.mime }));
    } catch {}
  }
  return media;
}

export class AppController {
  constructor({ view, backend, terminalSessionFactory }) {
    this.view = view;
    this.backend = backend;
    this.state = createInitialState();
    this.capture = new MediaCapture();
    this.terminalSessionFactory = terminalSessionFactory || (() => { throw new Error("Terminal session factory is unavailable."); });
    this.terminalSessions = new Map();
    this.wakeTimer = null;
    this.wakeLiveSession = null;
    this.wakeStreamText = "";
    this.wakeStreamStarted = false;
    this.wakeStreamParser = null;
    this.liveRecordPointerId = null;
    this.liveRecordStartPromise = null;
    this.liveRecordHoldTimer = null;
    this.liveRecordLongPress = false;
    this.liveRecordSuppressClick = false;
    this.native = backend.isNative;
    this.fileViewUrl = null;
    this.nativeWebviewUrls = new Map();
    this.clipboardPollTimer = null;
    this.clipboardPolling = false;
    this.folderPathTimer = null;
    this.folderPathRequest = 0;
    this.configurationReady = false;
    this.terminalCompletions = [];
    this.terminalCompletionIndex = -1;
    this.terminalCompletionRange = null;
    this.terminalEnterHoldTimer = null;
    this.terminalEnterHeld = false;
  }

  context() {
    return {
      backend: this.backend,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event, { preserveInput: true }),
      actions: {
        startRecording: (kind) => this.startRecording(kind),
        stopRecording: () => this.capture.stop(),
        startLiveRecording: () => this.activateWakeSession(null, { captureScreenshot: true }),
        stopLiveRecording: () => this.stopWakeLiveRecording(),
        toggleLiveRecording: () => this.toggleLiveRecording(),
        refreshMediaPermissions: () => this.refreshMediaPermissions(),
        requestMediaPermission: (permission) => this.requestMediaPermission(permission),
        attachMedia: (kind) => this.attachRecordedMedia(kind),
        webReload: () => this.runWebviewAction("reload"),
        webBack: () => this.runWebviewAction("back"),
        webForward: () => this.runWebviewAction("forward"),
        webZoomIn: () => this.runWebviewZoom("in"),
        webZoomOut: () => this.runWebviewZoom("out"),
        webZoomReset: () => this.runWebviewZoom("reset"),
        webDownload: () => this.runWebviewAction("download"),
        webDevtools: () => this.runWebviewAction("devtools"),
        webExternal: () => this.openWebExternal(),
        openWebDialog: (dialog) => this.openWebDialog(dialog),
        openExternal: (path) => this.openExternal(path),
        openFileInWebview: (path, metadata) => this.openFileInWebview(path, metadata),
        copyText: (text) => navigator.clipboard.writeText(text),
        pasteClipboardItem: (id) => this.backend.pasteClipboardItem(id),
        insertText: (text) => this.insertIntoTerminal(text),
        showUserMessage: (text, attachments) => this.activeTerminalSession().printUser(text, attachments),
        showAssistantMessage: (name, text, audio) => this.showCompletedAssistantMessage(name, text, audio)
      }
    };
  }

  terminalSessionFor(workspaceId = this.state.activeTabId) {
    let session = this.terminalSessions.get(workspaceId);
    if (session) return session;
    session = this.terminalSessionFactory(this.backend, {
      insertText: async (text) => {
        try {
          await this.runInternal(`input insert ${quoteArg(text)}`);
        } catch (error) {
          this.view.showToast(error?.message || String(error), "error");
          throw error;
        }
      },
      copyText: async (text) => {
        try {
          await this.runInternal(`clipboard copy ${quoteArg(text)}`);
          this.view.showToast("Copied", "success");
        } catch (error) {
          this.view.showToast(error?.message || String(error), "error");
          throw error;
        }
      }
    });
    session.onCwdChange = (path) => this.handleTerminalCwdChange(workspaceId, path);
    session.initializePromise = Promise.resolve(session.initialize()).catch((error) => {
      this.reportError("Terminal", error);
      return false;
    });
    this.terminalSessions.set(workspaceId, session);
    return session;
  }

  activeTerminalSession() {
    return this.terminalSessionFor(this.state.activeTabId);
  }

  clearTerminalCompletions(updateView = true) {
    this.terminalCompletions = [];
    this.terminalCompletionIndex = -1;
    this.terminalCompletionRange = null;
    if (updateView) this.view.setTerminalCompletions?.([], -1);
  }

  refreshTerminalCompletions(value = this.view.getTerminalInputValue?.() || "", cursor) {
    const workspace = activeWorkspace(this.state);
    const context = terminalCompletionContext(value, cursor);
    this.terminalCompletionRange = { start: context.start, end: context.end };
    this.terminalCompletions = terminalCompletions(value, {
      cursor: context.end,
      history: workspace?.terminal?.commandHistory || [],
      shellHistory: this.state.completion?.shellHistory || [],
      customEntries: this.state.settings.customCompletions || "",
      entries: workspace?.folder?.entries || []
    });
    this.terminalCompletionIndex = this.terminalCompletions.length ? 0 : -1;
    this.view.setTerminalCompletions?.(this.terminalCompletions, this.terminalCompletionIndex);
    return this.terminalCompletions;
  }

  moveTerminalCompletion(delta) {
    if (!this.terminalCompletions.length) return false;
    const count = this.terminalCompletions.length;
    this.terminalCompletionIndex = (this.terminalCompletionIndex + delta + count) % count;
    this.view.setTerminalCompletions?.(this.terminalCompletions, this.terminalCompletionIndex);
    return true;
  }

  acceptTerminalCompletion(index = this.terminalCompletionIndex) {
    const resolvedIndex = Number.isInteger(Number(index)) ? Number(index) : this.terminalCompletionIndex;
    const completion = this.terminalCompletions[resolvedIndex];
    if (!completion) return false;
    const currentValue = this.view.getTerminalInputValue?.() || "";
    const range = this.terminalCompletionRange || terminalCompletionContext(currentValue);
    if (this.view.replaceTerminalInputRange) {
      this.view.replaceTerminalInputRange(range.start, range.end, completion.value);
    } else {
      const nextValue = `${currentValue.slice(0, range.start)}${completion.value}${currentValue.slice(range.end)}`;
      this.view.setTerminalInput(nextValue);
    }
    this.clearTerminalCompletions();
    return true;
  }

  showAssistantActions(reply) {
    const parsed = parseAssistantReply(reply);
    this.dispatch({
      type: "UI_SET",
      payload: { assistantActions: parsed.actions, assistantTranscripts: parsed.transcripts }
    }, { preserveInput: true });
    return parsed.actions;
  }

  showAssistantTranscripts(reply) {
    return this.showAssistantActions(reply);
  }

  showCompletedAssistantMessage(name, text, audio = null) {
    this.activeTerminalSession().printAssistant(name, text, audio);
    this.showAssistantActions(text);
  }

  dispatch(event, options = {}) {
    const changesWorkspace = ["TAB_SELECT", "TAB_NEW", "TAB_CLOSE"].includes(event.type);
    if (changesWorkspace) {
      const draft = this.view.getTerminalInputValue?.() || "";
      this.state = reduceState(this.state, { type: "TERMINAL_DRAFT_SET", payload: { value: draft } });
    }
    const previousIds = new Set(this.state.tabs.map((tab) => tab.id));
    const previousWebviews = new Set(this.state.tabs.flatMap((tab) => tab.subtabs.filter((item) => item.type === "webview").map((item) => item.id)));
    this.state = reduceState(this.state, event);
    this.clearTerminalCompletions(false);
    for (const id of previousIds) {
      if (!this.state.tabs.some((tab) => tab.id === id)) {
        this.terminalSessions.get(id)?.stop?.().catch?.(() => {});
        this.terminalSessions.delete(id);
      }
    }
    for (const id of previousWebviews) {
      const stillExists = this.state.tabs.some((tab) => tab.subtabs.some((item) => item.id === id));
      if (!stillExists) {
        this.backend.closeWebview?.(id).catch?.(() => {});
        this.nativeWebviewUrls.delete(id);
      }
    }
    this.render(changesWorkspace ? { ...options, preserveInput: false } : options);
    if (this.configurationReady && WORKSPACE_PERSIST_EVENTS.has(event.type)) {
      this.persistConfiguration().catch((error) => this.reportError("Workspace save", error));
    }
  }

  render(options = {}) {
    this.view.render(this.state, { native: this.native, ...options });
    const terminalHost = this.view.root.querySelector?.("#terminal-emulator");
    if (terminalHost) {
      const workspace = activeWorkspace(this.state);
      const session = this.terminalSessionFor(workspace.id);
      requestAnimationFrame(() => session.mount(terminalHost, workspace.terminal.cwd, this.state.settings.fontSize, this.state.settings.terminalMaxLines).catch((error) => this.reportError("Terminal", error)));
    }
    scheduleFrame(() => this.syncNativeWebview().catch((error) => this.reportError("Webview", error)));
  }

  async refreshMediaPermissions({ render = true } = {}) {
    if (!this.backend.getMediaPermissions) return this.state.permissions;
    const permissions = await this.backend.getMediaPermissions();
    if (render) {
      this.dispatch({ type: "PERMISSIONS_SET", payload: permissions }, { preserveInput: true });
    } else {
      this.state = reduceState(this.state, { type: "PERMISSIONS_SET", payload: permissions });
    }
    return this.state.permissions;
  }

  async requestMediaPermission(permission) {
    if (!this.backend.requestMediaPermission) return this.state.permissions;
    const permissions = await this.backend.requestMediaPermission(permission);
    this.dispatch({ type: "PERMISSIONS_SET", payload: permissions }, { preserveInput: true });
    const granted = this.state.permissions?.[permission] === "authorized";
    this.view.showToast(
      granted ? `${permission === "microphone" ? "Microphone" : "Screen recording"} access allowed` : "Complete permission access in System Settings, then return to Auri.",
      granted ? "success" : "info"
    );
    return this.state.permissions;
  }

  async ensureMediaPermission(permission) {
    if (!this.native) return true;
    let current = this.state.permissions?.[permission];
    if (!current || current === "unknown") {
      const permissions = await this.refreshMediaPermissions({ render: false });
      current = permissions?.[permission];
    }
    if (current === "authorized") return true;
    const permissions = await this.requestMediaPermission(permission);
    if (permissions?.[permission] === "authorized") return true;
    const label = permission === "microphone" ? "Microphone" : "Screen recording";
    throw new Error(`${label} access is required. Allow it in System Settings and try again.`);
  }

  async initialize() {
    this.bindEvents();
    try {
      this.externalUnlisten = await this.backend.listenForCommands?.((command) => this.handleExternalCommand(command));
      this.wakeUnlisten = await this.backend.listen?.("auri-wake", (payload) => this.activateWakeSession(payload));
      this.webNavigationUnlisten = await this.backend.listen?.("auri-web-navigation", (payload) => this.handleWebNavigation(payload));
      this.browserOverlayUnlisten = await this.backend.listen?.("auri-browser-overlay-action", (payload) => this.handleBrowserOverlayAction(payload));
      const initialized = await this.backend.initialize();
      await this.refreshMediaPermissions({ render: false });
      try {
        const shellHistory = await this.backend.readShellHistory?.();
        this.state = reduceState(this.state, { type: "SHELL_HISTORY_SET", payload: { commands: shellHistory || [] } });
      } catch (error) {
        this.state = reduceState(this.state, {
          type: "INFO_ADD",
          payload: { level: "warning", title: "Shell history", message: error?.message || String(error) }
        });
      }
      const saved = this.native ? initialized?.configuration : localStorage.getItem("auri-settings");
      let restoredWorkspaces = false;
      if (saved) {
        try {
          const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
          const settings = parsed.settings || parsed;
          for (const [key, value] of Object.entries(settings)) {
            if (key in this.state.settings) this.state = reduceState(this.state, { type: "SETTING_SET", payload: { key, value } });
          }
          if (Array.isArray(parsed.models)) this.state = { ...this.state, models: parsed.models };
          if (parsed.selectedModelId) this.state = { ...this.state, selectedModelId: parsed.selectedModelId };
          if (parsed.browser) this.state = reduceState(this.state, { type: "BROWSER_RESTORE", payload: parsed.browser });
          if (Array.isArray(parsed.workspaceSession?.items) && parsed.workspaceSession.items.length) {
            this.state = reduceState(this.state, { type: "WORKSPACES_RESTORE", payload: parsed.workspaceSession });
            restoredWorkspaces = true;
          }
        } catch {
          // Ignore malformed preferences and keep safe defaults.
        }
      }
      if (this.backend.setWakeShortcut) {
        try {
          await this.backend.setWakeShortcut(this.state.settings.wakeShortcut);
        } catch (error) {
          this.state = reduceState(this.state, {
            type: "INFO_ADD",
            payload: { level: "warning", title: "Wake shortcut", message: error?.message || String(error) }
          });
        }
      }
      const root = initialized?.root || "~";
      if (!restoredWorkspaces) {
        this.state = reduceState(this.state, { type: "WORKDIR_SET", payload: { path: root } });
      }
      let startupPath = activeWorkspace(this.state).folder.path || root;
      let entries;
      try {
        entries = await this.backend.listDirectory(startupPath);
      } catch (error) {
        if (!restoredWorkspaces || startupPath === root) throw error;
        startupPath = root;
        this.state = reduceState(this.state, { type: "WORKDIR_SET", payload: { path: root } });
        entries = await this.backend.listDirectory(root);
      }
      this.state = reduceState(this.state, { type: "FOLDER_ENTRIES_SET", payload: { entries } });
      this.state = reduceState(this.state, {
        type: "INFO_ADD",
        payload: {
          level: "success",
          title: "Auri ready",
          message: this.native
            ? `Workspace initialized at ${startupPath}.`
            : "Browser preview is active. Native shell, global shortcuts, filesystem capture, and system audio require the Tauri build."
        }
      });
      this.configurationReady = true;
      await this.activeTerminalSession().initializePromise;
      this.render();
      this.startClipboardPolling();
    } catch (error) {
      this.reportError("Startup", error);
    }
  }

  bindEvents() {
    this.view.root.addEventListener("click", (event) => this.handleClick(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleLiveRecordPointerDown(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleTopbarPointerDown(event));
    this.view.root.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.view.root.addEventListener("keyup", (event) => this.handleKeyup(event));
    this.view.root.addEventListener("beforeinput", (event) => this.handleBeforeInput(event));
    this.view.root.addEventListener("input", (event) => this.handleInput(event));
    this.view.root.addEventListener("change", (event) => this.handleChange(event));
    this.view.root.addEventListener("scroll", (event) => this.handleScroll(event), true);
    this.view.root.addEventListener("submit", (event) => this.handleSubmit(event));
    window.addEventListener("keydown", (event) => this.handleGlobalKeydown(event));
    window.addEventListener("keyup", (event) => this.handleGlobalKeyup(event));
    window.addEventListener("pointerup", (event) => this.handleLiveRecordPointerEnd(event));
    window.addEventListener("pointercancel", (event) => this.handleLiveRecordPointerEnd(event));
    window.addEventListener("focus", () => {
      this.wakeLiveSession?.resume?.().catch?.(() => {});
      this.refreshMediaPermissions().catch?.(() => {});
    });
    if (typeof document !== "undefined") {
      document.addEventListener?.("visibilitychange", () => {
        if (!document.hidden) {
          this.wakeLiveSession?.resume?.().catch?.(() => {});
          this.refreshMediaPermissions().catch?.(() => {});
        }
      });
    }
    window.addEventListener("resize", () => {
      this.activeTerminalSession().resize?.();
      this.syncNativeWebview().catch((error) => this.reportError("Webview", error));
    });
  }


  async handleLiveRecordPointerDown(event) {
    const target = event.target?.closest?.('[data-action="live-record"]');
    if (!target || event.button !== 0 || this.liveRecordPointerId !== null) return false;
    event.preventDefault?.();
    this.liveRecordPointerId = event.pointerId;
    this.liveRecordLongPress = false;
    this.liveRecordStartPromise = null;
    clearTimeout(this.liveRecordHoldTimer);
    target.setPointerCapture?.(event.pointerId);
    this.liveRecordHoldTimer = setTimeout(() => {
      if (this.liveRecordPointerId !== event.pointerId) return;
      this.liveRecordLongPress = true;
      this.liveRecordStartPromise = Promise.resolve(this.runInternal("live record start"))
        .then(() => true)
        .catch((error) => {
          this.view.showToast(error?.message || String(error), "error");
          return false;
        });
    }, 1000);
    return true;
  }

  async handleLiveRecordPointerEnd(event) {
    if (this.liveRecordPointerId === null || event.pointerId !== this.liveRecordPointerId) return false;
    event.preventDefault?.();
    clearTimeout(this.liveRecordHoldTimer);
    this.liveRecordHoldTimer = null;
    const wasLongPress = this.liveRecordLongPress;
    const startPromise = this.liveRecordStartPromise;
    this.liveRecordPointerId = null;
    this.liveRecordLongPress = false;
    this.liveRecordSuppressClick = event.type !== "pointercancel";

    try {
      if (wasLongPress) {
        const started = await startPromise;
        if (started !== false) await this.runInternal("live record stop");
        return true;
      }
      if (event.type === "pointercancel") return false;
      await this.runInternal("live record toggle");
      return true;
    } catch (error) {
      this.view.showToast(error?.message || String(error), "error");
      return false;
    } finally {
      this.liveRecordStartPromise = null;
    }
  }

  handleTopbarPointerDown(event) {
    if (event.button !== 0 || !this.native) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element?.closest(".subtab-bar")) return;
    if (element.closest("button, input, textarea, select, a, [data-action]")) return;
    event.preventDefault();
    this.backend.startWindowDragging().catch((error) => this.reportError("Window drag", error));
  }

  async handleClick(event) {
    const insideAssistantPopup = event.target?.closest?.(".assistant-action-popup");
    const target = event.target?.closest?.("[data-action]");
    if (hasAssistantActionPopup(this.state) && !insideAssistantPopup) {
      await this.runInternal("transcript dismiss");
    }
    if (!target) return;
    const action = target.dataset.action;
    event.preventDefault();

    try {
      switch (action) {
        case "live-record":
          if (this.liveRecordSuppressClick) {
            this.liveRecordSuppressClick = false;
            break;
          }
          await this.runInternal("live record toggle");
          break;
        case "permission-request": {
          const permission = target.dataset.permission === "screenRecording" ? "screen-recording" : "microphone";
          await this.runInternal(`permission request ${permission}`);
          break;
        }
        case "tab-new":
          await this.runInternal("tab new");
          await this.refreshFolder();
          break;
        case "tab-select":
          await this.runInternal(`tab select ${target.dataset.id}`);
          await this.refreshFolder();
          break;
        case "tab-close":
          await this.runInternal(`tab close ${target.dataset.id || ""}`.trim());
          break;
        case "subtab-select":
          await this.runInternal(`subtab select ${target.dataset.id}`);
          if (activeSubtab(this.state).type === "info") this.dispatch({ type: "INFO_READ", payload: {} });
          if (activeSubtab(this.state).type === "settings") await this.runInternal("permission status");
          break;
        case "subtab-close":
          event.stopPropagation();
          await this.runInternal(`subtab close ${target.dataset.id}`);
          break;
        case "subtab-menu":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: !this.state.ui.addSubtabMenuOpen, webMenuOpen: false, webDialog: null } });
          break;
        case "subtab-new":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: false } });
          await this.runInternal(`subtab new ${target.dataset.type}`);
          break;
        case "folder-home":
          this.cancelFolderPathNavigation();
          await this.changeDirectory("~", { echoInTerminal: true });
          break;
        case "folder-up":
          this.cancelFolderPathNavigation();
          await this.changeDirectory(parentPath(activeWorkspace(this.state).folder.path), { echoInTerminal: true });
          break;
        case "folder-refresh":
          this.cancelFolderPathNavigation();
          await this.refreshFolder();
          break;
        case "folder-more":
          this.dispatch({ type: "UI_SET", payload: { folderMenuOpen: !this.state.ui.folderMenuOpen } }, { preserveInput: true });
          break;
        case "folder-sort":
          this.dispatch({ type: "UI_SET", payload: { folderMenuOpen: false } }, { preserveInput: true });
          await this.runInternal(`folder sort ${target.dataset.sort}`);
          break;
        case "folder-new-file":
          this.cancelFolderPathNavigation();
          this.dispatch({ type: "UI_SET", payload: { folderMenuOpen: false, folderCreateKind: "file" } }, { preserveInput: true });
          break;
        case "folder-new-folder":
          this.cancelFolderPathNavigation();
          this.dispatch({ type: "UI_SET", payload: { folderMenuOpen: false, folderCreateKind: "folder" } }, { preserveInput: true });
          break;
        case "folder-create-confirm":
          await this.submitFolderCreate();
          break;
        case "folder-info":
          this.dispatch({ type: "UI_SET", payload: { folderMenuOpen: false } }, { preserveInput: true });
          await this.runInternal("folder info");
          break;
        case "file-entry":
          this.cancelFolderPathNavigation();
          await this.openFolderEntry(target.dataset.path, target.dataset.kind);
          break;
        case "terminal-completion-select":
          this.acceptTerminalCompletion(Number(target.dataset.index));
          break;
        case "custom-completions-save": {
          const value = this.view.getCustomCompletions?.() || "";
          await this.runInternal(`settings set customCompletions ${quoteArg(value)}`);
          this.view.showToast("Custom completions saved", "success");
          break;
        }
        case "terminal-run":
          await this.submitTerminal("run");
          break;
        case "terminal-ask":
          await this.submitTerminal("ask");
          break;
        case "terminal-clear":
          this.dispatch({ type: "TERMINAL_CLEAR", payload: {} });
          break;
        case "starter":
          this.view.setTerminalInput(target.dataset.value || "");
          break;
        case "model-menu":
          this.dispatch({
            type: "UI_SET",
            payload: { modelMenuId: this.state.ui.modelMenuId === target.dataset.id ? null : target.dataset.id }
          }, { preserveInput: true });
          break;
        case "model-edit":
          this.dispatch({ type: "UI_SET", payload: { modelMenuId: null, editingModelId: target.dataset.id } }, { preserveInput: true });
          break;
        case "model-edit-cancel":
          this.dispatch({ type: "UI_SET", payload: { editingModelId: null } }, { preserveInput: true });
          break;
        case "model-delete":
          await this.runInternal(`ai model delete ${quoteArg(target.dataset.id)}`);
          this.view.showToast("Model deleted", "success");
          break;
        case "model-select":
          this.dispatch({ type: "UI_SET", payload: { modelMenuId: null } }, { preserveInput: true });
          await this.runInternal(`ai model select ${quoteArg(target.dataset.id)}`);
          this.view.showToast("Default model updated", "success");
          break;
        case "info-open":
          await this.runInternal("info show");
          break;
        case "settings-open":
          await this.runInternal("settings open");
          break;
        case "info-clear":
          await this.runInternal("info clear");
          this.dispatch({ type: "UI_SET", payload: { infoMediaPreview: null } }, { preserveInput: true });
          break;
        case "info-media-open": {
          const infoItem = this.state.info.items.find((item) => item.id === target.dataset.infoId);
          const media = infoItem?.details?.media?.find((item) => item.id === target.dataset.mediaId);
          if (media) this.dispatch({ type: "UI_SET", payload: { infoMediaPreview: media } }, { preserveInput: true });
          break;
        }
        case "info-media-close":
          this.dispatch({ type: "UI_SET", payload: { infoMediaPreview: null } }, { preserveInput: true });
          break;
        case "clipboard-filter-pinned":
          this.dispatch({
            type: "UI_SET",
            payload: { clipboardPinnedOnly: !this.state.ui.clipboardPinnedOnly, clipboardMenuId: null }
          }, { preserveInput: true });
          break;
        case "clipboard-refresh":
          this.dispatch({ type: "UI_SET", payload: { clipboardMenuId: null } }, { preserveInput: true });
          await this.runInternal("clipboard list");
          break;
        case "clipboard-menu":
          this.dispatch({
            type: "UI_SET",
            payload: { clipboardMenuId: this.state.ui.clipboardMenuId === target.dataset.id ? null : target.dataset.id }
          }, { preserveInput: true });
          break;
        case "clipboard-pin":
        case "clipboard-unpin":
          this.dispatch({ type: "UI_SET", payload: { clipboardMenuId: null } }, { preserveInput: true });
          await this.runInternal(`clipboard ${action === "clipboard-pin" ? "pin" : "unpin"} ${target.dataset.id}`);
          this.view.showToast(action === "clipboard-pin" ? "Clipboard item pinned" : "Clipboard item unpinned", "success");
          break;
        case "clipboard-remove":
          this.dispatch({ type: "UI_SET", payload: { clipboardMenuId: null } }, { preserveInput: true });
          await this.runInternal(`clipboard remove ${target.dataset.id}`);
          this.view.showToast("Clipboard item removed", "success");
          break;
        case "clipboard-insert":
          await this.insertClipboard(target.dataset.id);
          break;
        case "copy-text":
          await this.runInternal(`clipboard copy ${quoteArg(target.dataset.value || "")}`);
          this.view.showToast("Copied", "success");
          break;
        case "transcript-insert":
        case "assistant-insert":
          await this.runInternal(`input insert ${quoteArg(target.dataset.value || "")}`);
          break;
        case "assistant-run": {
          const command = target.dataset.value || "";
          if (command) await this.runInternal(`terminal run ${command}`);
          break;
        }
        case "transcript-dismiss":
          await this.runInternal("transcript dismiss");
          break;
        case "attachment-remove":
          await this.runInternal(`attachment remove ${target.dataset.id}`);
          break;
        case "web-go":
          await this.runInternal(`web open ${quoteArg(this.view.getWebUrl())}`);
          break;
        case "web-menu":
          this.dispatch({ type: "UI_SET", payload: { webMenuOpen: !this.state.ui.webMenuOpen, webDialog: null, addSubtabMenuOpen: false } }, { preserveInput: true });
          break;
        case "web-menu-close":
          this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
          break;
        case "web-reload":
          await this.runInternal("web reload");
          break;
        case "web-back":
          await this.runInternal("web back");
          break;
        case "web-forward":
          await this.runInternal("web forward");
          break;
        case "web-external":
          this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
          await this.runInternal("web external");
          break;
        case "web-download":
          this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
          await this.runInternal("web download");
          this.view.showToast("Download started", "success");
          break;
        case "web-devtools":
          this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
          await this.runInternal("web devtools");
          break;
        case "web-zoom-in":
          await this.runInternal("web zoom-in");
          break;
        case "web-zoom-out":
          await this.runInternal("web zoom-out");
          break;
        case "web-zoom-reset":
          await this.runInternal("web zoom-reset");
          break;
        case "web-add-bookmark":
          await this.runInternal("web bookmark");
          break;
        case "web-bookmarks":
          await this.runInternal("web bookmarks");
          break;
        case "web-history":
          await this.runInternal("web history");
          break;
        case "web-dialog-close":
          this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
          break;
        case "web-bookmark-open":
        case "web-history-open":
          this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false } }, { preserveInput: true });
          await this.runInternal(`web open ${quoteArg(target.dataset.url)}`);
          break;
        case "web-bookmark-remove":
          await this.runInternal(`web bookmark remove ${quoteArg(target.dataset.id)}`);
          this.view.showToast("Bookmark removed", "success");
          break;
        case "web-history-clear":
          await this.runInternal("web history clear");
          this.view.showToast("History cleared", "success");
          break;
        case "file-external":
          await this.runInternal(`file external ${quoteArg(activeWorkspace(this.state).viewer.path || "")}`);
          break;
        case "record-start":
          await this.runInternal(`record start ${target.dataset.kind}`);
          break;
        case "record-stop":
          await this.runInternal("record stop");
          break;
        case "media-attach":
          await this.runInternal(`media attach ${target.dataset.kind}`);
          break;
        case "command-palette":
          this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: true } });
          this.view.focusPalette();
          break;
        case "palette-close":
          this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: false } });
          break;
        case "palette-command":
          this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: false } });
          await this.runInternal(target.dataset.value || "help");
          break;
        default:
          break;
      }
    } catch (error) {
      this.view.showToast(error.message || String(error), "error");
    }
  }

  async submitFolderCreate() {
    const kind = this.state.ui.folderCreateKind;
    if (kind !== "file" && kind !== "folder") return false;
    const name = String(this.view.getFolderCreateName?.() || "").trim();
    if (!name) {
      this.view.showToast(`Enter a ${kind} name.`, "error");
      return false;
    }
    try {
      await this.runInternal(`folder create-${kind} ${quoteArg(name)}`);
      this.dispatch({ type: "UI_SET", payload: { folderCreateKind: null } }, { preserveInput: true });
      this.view.showToast(`Created ${name}`, "success");
      return true;
    } catch (error) {
      this.view.showToast(error?.message || String(error), "error");
      return false;
    }
  }

  async handleKeydown(event) {
    if (event.target?.id === "wake-shortcut-input") {
      event.preventDefault?.();
      event.stopPropagation?.();
      const input = event.target;
      const previous = this.state.settings.wakeShortcut;
      if (event.key === "Escape") {
        input.value = previous;
        input.blur?.();
        return;
      }
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      input.value = shortcut;
      try {
        await this.runInternal(`settings set wakeShortcut ${quoteArg(shortcut)}`);
        input.blur?.();
        this.view.showToast("Wake shortcut saved", "success");
      } catch (error) {
        input.value = previous;
        this.view.showToast(error?.message || String(error), "error");
      }
      return;
    }
    if (event.target.id === "folder-create-input") {
      if (event.key === "Enter") {
        event.preventDefault();
        await this.submitFolderCreate();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.dispatch({ type: "UI_SET", payload: { folderCreateKind: null } }, { preserveInput: true });
        return;
      }
    }
    const plainFolderArrow = event.target.id === "folder-path-input"
      && event.altKey !== true && event.ctrlKey !== true
      && event.metaKey !== true && event.shiftKey !== true;
    if (plainFolderArrow) {
      const direction = folderPathArrowDirection(event.key);
      if (direction) {
        event.preventDefault();
        const input = event.target;
        const valueLength = String(input.value ?? "").length;
        const selectionStart = Number.isInteger(input.selectionStart) ? input.selectionStart : valueLength;
        const selectionEnd = Number.isInteger(input.selectionEnd) ? input.selectionEnd : selectionStart;
        const nextPosition = direction < 0
          ? (selectionStart === selectionEnd ? Math.max(0, selectionStart - 1) : selectionStart)
          : (selectionStart === selectionEnd ? Math.min(valueLength, selectionEnd + 1) : selectionEnd);
        input.setSelectionRange?.(nextPosition, nextPosition);
        return;
      }
    }
    if (event.target.id === "terminal-input") {
      const noModifier = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (this.terminalCompletions.length && noModifier && !event.isComposing) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          this.moveTerminalCompletion(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          this.acceptTerminalCompletion();
          return;
        }
        if (event.key === "Enter") this.clearTerminalCompletions();
        if (event.key === "Escape") {
          event.preventDefault();
          this.clearTerminalCompletions();
          return;
        }
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        await this.submitTerminal("run");
        return;
      }
      if (event.key === "Enter" && noModifier && !event.isComposing) {
        event.preventDefault();
        if (event.repeat || this.terminalEnterHoldTimer || this.terminalEnterHeld) return;
        this.terminalEnterHoldTimer = setTimeout(() => {
          this.terminalEnterHoldTimer = null;
          this.terminalEnterHeld = true;
          Promise.resolve(this.submitTerminal("run")).catch((error) => {
            this.view.showToast(error?.message || String(error), "error");
          });
        }, 2000);
        return;
      }
    }
    if (event.target.id === "web-url" && event.key === "Enter") {
      event.preventDefault();
      await this.runInternal(`web open ${quoteArg(event.target.value)}`);
      return;
    }
    if (event.target.id === "palette-input" && event.key === "Enter") {
      event.preventDefault();
      const value = event.target.value.trim();
      if (value) {
        this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: false } });
        await this.runInternal(value);
      }
      return;
    }
    if (event.key === "Escape" && this.state.ui.webDialog) {
      this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
      return;
    }
    if (event.key === "Escape" && this.state.ui.webMenuOpen) {
      this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
      return;
    }
    if (event.key === "Escape" && this.state.ui.commandPaletteOpen) {
      this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: false } });
    }
  }

  handleKeyup(event) {
    if (event.target?.id !== "terminal-input" || event.key !== "Enter") return false;
    const noModifier = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!noModifier) return false;
    event.preventDefault?.();
    if (this.terminalEnterHoldTimer) {
      clearTimeout(this.terminalEnterHoldTimer);
      this.terminalEnterHoldTimer = null;
      if (!this.terminalEnterHeld) {
        this.view.insertTerminalText?.("\n");
        this.clearTerminalCompletions();
      }
    }
    if (this.terminalEnterHeld) this.terminalEnterHeld = false;
    return true;
  }

  handleBeforeInput(event) {
    if (event.target.id !== "folder-path-input") return;
    if (event.inputType === "insertText" && isMacNavigationText(event.data)) event.preventDefault();
  }

  handleInput(event) {
    const input = event.target;
    if (input.id === "terminal-input") {
      this.refreshTerminalCompletions(input.value, input.selectionStart);
      return;
    }
    if (input.id === "custom-completions") {
      this.view.syncCustomCompletionLineNumbers?.(input.value);
      return;
    }
    if (input.id !== "folder-path-input") return;
    const originalValue = String(input.value ?? "");
    const cleanValue = stripMacNavigationText(originalValue);
    if (cleanValue !== originalValue) {
      const selectionStart = Number.isInteger(input.selectionStart) ? input.selectionStart : originalValue.length;
      const selectionEnd = Number.isInteger(input.selectionEnd) ? input.selectionEnd : selectionStart;
      const cleanSelectionStart = stripMacNavigationText(originalValue.slice(0, selectionStart)).length;
      const cleanSelectionEnd = stripMacNavigationText(originalValue.slice(0, selectionEnd)).length;
      input.value = cleanValue;
      input.setSelectionRange?.(cleanSelectionStart, cleanSelectionEnd);
    }
    this.scheduleFolderPathNavigation(input);
  }

  handleScroll(event) {
    const target = event.target;
    if (target.id !== "custom-completions") return;
    this.view.syncCustomCompletionScroll?.(target);
  }

  cancelFolderPathNavigation() {
    if (this.folderPathTimer) clearTimeout(this.folderPathTimer);
    this.folderPathTimer = null;
    this.folderPathRequest += 1;
  }

  scheduleFolderPathNavigation(input) {
    this.cancelFolderPathNavigation();
    input.removeAttribute?.("aria-invalid");
    input.classList?.remove?.("is-invalid");
    const path = String(input.value ?? "").trim();
    if (!path) return;
    const request = this.folderPathRequest;
    const workspaceId = this.state.activeTabId;
    this.folderPathTimer = setTimeout(() => {
      this.folderPathTimer = null;
      if (request !== this.folderPathRequest || workspaceId !== this.state.activeTabId) return;
      this.navigateTypedFolderPath(path, input).catch((error) => {
        this.view.showToast(error?.message || String(error), "error");
      });
    }, 2000);
  }

  async navigateTypedFolderPath(value, input) {
    const path = String(value ?? "").trim();
    if (!path || path === activeWorkspace(this.state).folder.path) return;
    try {
      await this.changeDirectory(path, { echoInTerminal: true });
    } catch (error) {
      input?.setAttribute?.("aria-invalid", "true");
      input?.classList?.add?.("is-invalid");
      this.view.showToast(error?.message || String(error), "error");
    }
  }

  async handleChange(event) {
    const input = event.target;
    if (input.id === "terminal-model-select") {
      await this.runInternal(`ai model select ${quoteArg(input.value)}`);
      return;
    }
    if (input.id === "file-attachment") {
      for (const selected of [...input.files]) {
        const kind = attachmentKind(selected);
        this.dispatch({
          type: "ATTACHMENT_ADD",
          payload: {
            id: `attachment-${Date.now()}-${Math.random()}`,
            name: selected.name,
            kind,
            mime: selected.type,
            file: selected,
            url: attachmentPreviewUrl(selected, kind)
          }
        }, { preserveInput: true });
      }
      return;
    }
    if (input.dataset.setting) {
      const key = input.dataset.setting;
      if (key === "wakeShortcut") return;
      const value = this.view.getSettingValue(input);
      await this.runInternal(`settings set ${key} ${quoteArg(value)}`);
      if (key === "liveDisconnectSeconds") {
        this.wakeLiveSession?.setInactivitySeconds?.(this.state.settings.liveDisconnectSeconds);
      }
      this.view.showToast("Setting saved", "success");
    }
  }

  async handleSubmit(event) {
    if (event.target.id === "folder-create-form") {
      event.preventDefault();
      await this.submitFolderCreate();
      return;
    }
    if (event.target.id === "web-bookmark-form") {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      await this.runInternal(`web bookmark add ${quoteArg(values.name)} ${quoteArg(values.url)}`);
      this.dispatch({ type: "UI_SET", payload: { webDialog: "bookmarks", webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
      this.view.showToast("Bookmark saved", "success");
      return;
    }
    if (event.target.id === "model-edit-form") {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      const id = event.target.dataset.id;
      await this.runInternal(`ai model update ${quoteArg(id)} ${quoteArg(values.name)} ${quoteArg(values.type)} ${quoteArg(values.model)} ${quoteArg(values.url || "")} ${quoteArg(values.apiKey || "")}`);
      this.dispatch({ type: "UI_SET", payload: { editingModelId: null } }, { preserveInput: true });
      this.view.showToast("Model saved", "success");
      return;
    }
    if (event.target.id !== "model-form") return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    await this.runInternal(`ai model add ${quoteArg(values.name)} ${quoteArg(values.type)} ${quoteArg(values.model)} ${quoteArg(values.url || "")} ${quoteArg(values.apiKey || "")}`);
    this.view.showToast("Model added", "success");
  }

  async handleGlobalKeydown(event) {
    if (event.key === "Escape" && hasAssistantActionPopup(this.state)) {
      event.preventDefault();
      await this.runInternal("transcript dismiss");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!this.state.ui.commandPaletteOpen) {
        this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: true } });
        this.view.focusPalette();
      }
      return;
    }
    if (!this.native && shortcutMatchesKeyboardEvent(event, this.state.settings.wakeShortcut) && !event.repeat && !this.wakeTimer) {
      event.preventDefault();
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.activateWakeSession();
      }, Number(this.state.settings.wakeHoldSeconds) * 1000);
    }
  }

  handleGlobalKeyup(event) {
    if (this.wakeTimer && shortcutKeyMatchesKeyboardEvent(event, this.state.settings.wakeShortcut)) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  async toggleLiveRecording() {
    if (this.wakeLiveSession || this.state.ui.liveConnected || this.state.ui.liveRecording) {
      const session = this.wakeLiveSession;
      this.wakeLiveSession = null;
      if (session) await session.cancel("manual");
      else this.handleWakeStatus("disconnected");
      return false;
    }
    await this.activateWakeSession();
    return true;
  }

  async activateWakeSession(screenshot = null, { captureScreenshot = false } = {}) {
    try {
      await this.ensureMediaPermission("microphone");
      if (!screenshot && captureScreenshot && this.backend.captureScreenshot) {
        try {
          screenshot = await this.backend.captureScreenshot();
        } catch (error) {
          this.dispatch({
            type: "INFO_ADD",
            payload: { level: "warning", title: "Live screenshot", message: error?.message || String(error) }
          }, { preserveInput: true });
        }
      }

      const model = this.state.models.find((item) => item.id === this.state.selectedModelId);
      if (!model || model.type !== "gemini-live") {
        throw new Error("Select a Gemini Live model in Settings before using voice input.");
      }

      this.openSingletonSubtab("terminal");
      this.dispatch({ type: "UI_SET", payload: { assistantActions: [], assistantTranscripts: [] } }, { preserveInput: true });
      this.finalizeWakeStream();
      this.activeTerminalSession().printMessage("Voice", "Listening…", "33");

      if (this.wakeLiveSession && !this.wakeLiveSession.completed && this.wakeLiveSession.restart) {
        await this.wakeLiveSession.restart({
          screenshot,
          inactivitySeconds: this.state.settings.liveDisconnectSeconds
        });
        return this.wakeLiveSession;
      }

      this.wakeLiveSession = await this.backend.startWakeLiveSession({
        model,
        screenshot,
        inactivitySeconds: this.state.settings.liveDisconnectSeconds,
        onStatus: (status) => this.handleWakeStatus(status),
        onText: (text) => this.handleWakeStreamText(text, model),
        onResult: (result) => this.finishWakeLiveResult(result, model),
        onRequest: (request) => this.logAiRequest({ ...request, modelName: model.name }),
        onError: (error) => this.failWakeLiveSession(error)
      });
      return this.wakeLiveSession;
    } catch (error) {
      this.wakeLiveSession = null;
      this.dispatch({ type: "UI_SET", payload: { liveConnected: false, liveRecording: false, liveStatus: "error" } }, { preserveInput: true });
      this.reportError("Live microphone", error);
      return null;
    }
  }

  logAiRequest(request = {}) {
    const media = Array.isArray(request.media) ? request.media.map(requestMediaPreview) : [];
    const text = String(request.text || "");
    const modelName = String(request.modelName || "Auri");
    this.dispatch({
      type: "INFO_ADD",
      payload: {
        level: "info",
        title: `AI request · ${modelName}`,
        message: text || (media.some((item) => item.kind === "audio") ? "Voice input" : "Media request"),
        details: { type: "ai-request", text, modelName, media }
      }
    }, { preserveInput: true });
  }

  renderWakeStreamEvents(events = []) {
    const session = this.activeTerminalSession();
    for (const event of events) session.appendAssistantStream(event.text);
  }

  handleWakeStreamText(text, model) {
    const next = String(text || "");
    if (!next || next === this.wakeStreamText) return;
    if (this.wakeStreamText && this.wakeStreamText.startsWith(next)) return;

    const previous = this.wakeStreamText;
    const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
    this.wakeStreamText = next;

    if (!this.wakeStreamStarted) {
      this.wakeStreamStarted = true;
      this.wakeStreamParser = new AssistantStreamParser();
      this.activeTerminalSession().beginAssistantStream(model?.name || "Gemini Live");
    }

    this.renderWakeStreamEvents(this.wakeStreamParser.push(delta));
  }

  finalizeWakeStream() {
    if (this.wakeStreamStarted && this.wakeStreamParser) {
      this.renderWakeStreamEvents(this.wakeStreamParser.finish());
      this.activeTerminalSession().endAssistantStream();
    }
    this.wakeStreamText = "";
    this.wakeStreamStarted = false;
    this.wakeStreamParser = null;
  }

  handleWakeStatus(status) {
    const disconnected = status.startsWith("disconnected");
    const liveConnected = status === "connected" || (this.state.ui.liveConnected && !disconnected);
    let liveRecording = this.state.ui.liveRecording;
    if (status === "recording" || status === "connecting") liveRecording = true;
    if (status === "connected" && this.wakeLiveSession?.stopped) liveRecording = false;
    if (status === "processing" || status === "error" || disconnected) liveRecording = false;
    this.dispatch({ type: "UI_SET", payload: { liveConnected, liveRecording, liveStatus: status } }, { preserveInput: true });

    if (disconnected) {
      this.wakeLiveSession = null;
      this.finalizeWakeStream();
    }
  }

  async stopWakeLiveRecording() {
    const session = this.wakeLiveSession;
    this.dispatch({ type: "UI_SET", payload: { liveRecording: false } }, { preserveInput: true });
    if (!session) return false;
    await session.stop();
    return true;
  }

  finishWakeLiveResult(result, model) {
    const text = result?.text || this.wakeStreamText || "Gemini Live returned no response.";
    let audioUrl = null;
    if (result?.audioBlob) {
      audioUrl = URL.createObjectURL(result.audioBlob);
      if (!result.streamedAudio) {
        try {
          const player = new Audio(audioUrl);
          player.play()?.catch?.(() => {});
        } catch {}
      }
    }

    const assistantAudio = audioUrl ? {
      name: `${model?.name || "Gemini Live"} response`,
      url: audioUrl,
      mime: result?.audioMime || "audio/wav"
    } : null;
    const session = this.activeTerminalSession();
    if (this.wakeStreamStarted && this.wakeStreamParser) {
      if (text.startsWith(this.wakeStreamText) && text.length > this.wakeStreamText.length) {
        this.handleWakeStreamText(text, model);
      }
      this.renderWakeStreamEvents(this.wakeStreamParser.finish());
      session.endAssistantStream();
      if (assistantAudio) session.printMedia([assistantAudio]);
    } else {
      session.printAssistant(model?.name || "Gemini Live", text, assistantAudio);
    }
    this.showAssistantActions(text);
    this.dispatch({
      type: "TERMINAL_OUTPUT_ADD",
      payload: {
        id: `output-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        at: new Date().toISOString(),
        code: 0,
        stdout: text,
        stderr: "",
        kind: "assistant",
        modelName: model?.name || "Gemini Live",
        audioUrl,
        audioMime: result?.audioMime || null
      }
    }, { preserveInput: true });
    this.wakeStreamText = "";
    this.wakeStreamStarted = false;
    this.wakeStreamParser = null;
  }

  failWakeLiveSession(error) {
    this.wakeLiveSession = null;
    this.finalizeWakeStream();
    this.dispatch({ type: "UI_SET", payload: { liveConnected: false, liveRecording: false, liveStatus: "error" } }, { preserveInput: true });
    this.reportError("Gemini Live", error);
  }

  async handleExternalCommand(command) {
    try {
      const result = await this.runInternal(command);
      this.view.showToast?.(`Ran: ${command}`, "success");
      return result;
    } catch (error) {
      this.reportError("External command", error);
      throw error;
    }
  }

  async runInternal(command) {
    return executeCommand(command, this.context());
  }

  async submitTerminal(mode) {
    const value = this.view.getTerminalInputValue().trim();
    if (!value) return;
    this.clearTerminalCompletions();
    this.view.setTerminalInput("", false);
    try {
      if (mode === "run") {
        this.dispatch({ type: "TERMINAL_COMMAND_REMEMBER", payload: { command: value } }, { preserveInput: true });
      }
      if (mode === "ask") await this.runInternal(`ai ask ${value}`);
      else if (classifyTerminalInput(value) === "auri") await this.runInternal(value);
      else if (this.native) await this.runNativeTerminalCommand(value);
      else await this.runInternal(`terminal run ${value}`);
    } finally {
      this.view.setTerminalInput("", true);
    }
  }

  async runNativeTerminalCommand(command) {
    const workspace = activeWorkspace(this.state);
    if (!isSimpleCdCommand(command)) {
      await this.activeTerminalSession().run(command);
      return;
    }

    const result = await this.backend.runCommand(command, workspace.terminal.cwd);
    await this.activeTerminalSession().run(command);
    if (result.code === 0 && result.cwd && result.cwd !== workspace.terminal.cwd) {
      await this.syncDirectory(result.cwd);
    }
  }

  async handleTerminalCwdChange(workspaceId, path) {
    const workspace = this.state.tabs.find((tab) => tab.id === workspaceId);
    if (!workspace || !path || path === workspace.terminal.cwd) return;
    await this.syncDirectory(path, workspaceId);
  }

  async syncDirectory(path, workspaceId = this.state.activeTabId) {
    const entries = await this.backend.listDirectory(path);
    this.dispatch({ type: "WORKDIR_SET", payload: { workspaceId, path } });
    this.dispatch({ type: "FOLDER_ENTRIES_SET", payload: { workspaceId, entries } });
  }

  async changeDirectory(path, { echoInTerminal = false } = {}) {
    const workspace = activeWorkspace(this.state);
    const command = path === "~" ? "cd ~" : `cd ${shellQuote(path)}`;
    const result = await this.backend.runCommand(command, workspace.terminal.cwd);
    if (result.code !== 0 || !result.cwd) throw new Error(result.stderr || `Could not open folder: ${path}`);
    if (echoInTerminal && this.native) await this.activeTerminalSession().run(command);
    await this.syncDirectory(result.cwd);
  }

  async refreshFolder() {
    const path = activeWorkspace(this.state).folder.path;
    const entries = await this.backend.listDirectory(path);
    this.dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
  }

  async openFolderEntry(path, kind) {
    if (kind === "directory") {
      await this.changeDirectory(path, { echoInTerminal: true });
      return;
    }
    const workspace = activeWorkspace(this.state);
    const repeat = workspace.folder.selectedPath === path;
    await this.runInternal(`file ${repeat ? "open" : "inspect"} ${quoteArg(path)}`);
  }

  openSingletonSubtab(type) {
    const tab = activeWorkspace(this.state);
    const existing = tab.subtabs.find((item) => item.type === type);
    this.dispatch(existing
      ? { type: "SUBTAB_SELECT", payload: { id: existing.id } }
      : { type: "SUBTAB_NEW", payload: { type } });
    if (type === "info") this.dispatch({ type: "INFO_READ", payload: {} });
  }

  insertIntoTerminal(text) {
    this.openSingletonSubtab("terminal");
    requestAnimationFrame(() => this.view.insertTerminalText(text));
  }

  async insertClipboard(id) {
    await this.runInternal(`clipboard insert ${id}`);
  }

  startClipboardPolling() {
    if (!this.native || this.clipboardPollTimer) return;
    const poll = () => this.pollClipboard().catch((error) => this.reportError("Clipboard", error));
    poll();
    this.clipboardPollTimer = setInterval(poll, 3000);
  }

  async pollClipboard() {
    if (this.clipboardPolling) return;
    this.clipboardPolling = true;
    try {
      const items = await this.backend.readClipboardHistory();
      const current = this.state.clipboard.items;
      const changed = items.length !== current.length || items.some((item, index) => item.id !== current[index]?.id);
      if (changed) this.dispatch({ type: "CLIPBOARD_SET", payload: { items } });
    } finally {
      this.clipboardPolling = false;
    }
  }


  async persistConfiguration() {
    if (!this.backend.saveSettings) return;
    await this.backend.saveSettings({
      settings: this.state.settings,
      models: this.state.models,
      selectedModelId: this.state.selectedModelId,
      browser: this.state.browser,
      workspaceSession: serializeWorkspaceSession(this.state)
    });
  }

  openWebDialog(dialog) {
    const subtab = activeSubtab(this.state);
    let currentUrl = subtab.url || "";
    try {
      currentUrl = normalizeWebUrl(currentUrl);
    } catch {}
    const bookmarkDraft = dialog === "add-bookmark"
      ? { name: defaultBookmarkName(currentUrl), url: currentUrl }
      : null;
    this.dispatch({ type: "UI_SET", payload: { webDialog: dialog, webMenuOpen: false, bookmarkDraft } }, { preserveInput: true });
  }

  async handleBrowserOverlayAction(payload) {
    const action = String(payload?.action || "");
    if (!action) return;
    if (action === "web-dialog-close" || action === "web-menu-close") {
      this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
      return;
    }
    if (action === "subtab-new") {
      const type = String(payload?.type || "");
      if (!type) return;
      this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: false } }, { preserveInput: true });
      await this.runInternal(`subtab new ${type}`);
      return;
    }
    if (action === "web-bookmark-save") {
      await this.runInternal(`web bookmark add ${quoteArg(payload?.name || "")} ${quoteArg(payload?.url || "")}`);
      this.dispatch({ type: "UI_SET", payload: { webDialog: "bookmarks", webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
      this.view.showToast("Bookmark saved", "success");
      return;
    }
    if (action === "web-bookmark-open" || action === "web-history-open") {
      this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false } }, { preserveInput: true });
      await this.runInternal(`web open ${quoteArg(payload?.url || "")}`);
      return;
    }
    if (action === "web-bookmark-remove") {
      await this.runInternal(`web bookmark remove ${quoteArg(payload?.id || "")}`);
      this.view.showToast("Bookmark removed", "success");
      return;
    }
    if (action === "web-history-clear") {
      await this.runInternal("web history clear");
      this.view.showToast("History cleared", "success");
      return;
    }
    if (["web-external", "web-download", "web-devtools"].includes(action)) {
      this.dispatch({ type: "UI_SET", payload: { webMenuOpen: false } }, { preserveInput: true });
    }
    const commands = {
      "web-external": "web external",
      "web-download": "web download",
      "web-devtools": "web devtools",
      "web-zoom-in": "web zoom-in",
      "web-zoom-out": "web zoom-out",
      "web-zoom-reset": "web zoom-reset",
      "web-add-bookmark": "web bookmark",
      "web-bookmarks": "web bookmarks",
      "web-history": "web history"
    };
    if (commands[action]) await this.runInternal(commands[action]);
  }

  async handleWebNavigation(payload) {
    const id = String(payload?.id || "");
    const url = String(payload?.url || "");
    if (!id || !/^https?:\/\//i.test(url)) return;
    const exists = this.state.tabs.some((tab) => tab.subtabs.some((item) => item.id === id && item.type === "webview"));
    if (!exists) return;
    const title = titleForWebUrl(url);
    this.nativeWebviewUrls.set(id, url);
    const active = activeSubtab(this.state);
    if (active.id === id) {
      this.dispatch({ type: "SUBTAB_UPDATE", payload: { id, patch: { url, title } } }, { preserveInput: true });
    }
    this.dispatch({ type: "BROWSER_HISTORY_ADD", payload: { url, title, at: new Date().toISOString() } }, { preserveInput: true });
    await this.persistConfiguration();
  }

  browserOverlayPayload(subtab) {
    if (this.state.ui.addSubtabMenuOpen) {
      return { mode: "new-tab" };
    }
    if (this.state.ui.webMenuOpen) {
      return { mode: "menu", zoom: `${Math.round((Number(subtab.zoom) || 1) * 100)}%` };
    }
    const mode = this.state.ui.webDialog;
    if (!mode) return null;
    return {
      mode,
      bookmarkDraft: this.state.ui.bookmarkDraft,
      bookmarks: this.state.browser.bookmarks,
      history: this.state.browser.history
    };
  }

  browserOverlayBounds(hostRect) {
    const viewportWidth = typeof window !== "undefined" && Number(window.innerWidth)
      ? Number(window.innerWidth)
      : hostRect.left + hostRect.width;
    const viewportHeight = typeof window !== "undefined" && Number(window.innerHeight)
      ? Number(window.innerHeight)
      : hostRect.top + hostRect.height;
    if (this.state.ui.addSubtabMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="subtab-menu"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 56, bottom: 56 };
      const width = 220;
      const height = 300;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || 56) + 6)),
        width,
        height
      };
    }
    if (this.state.ui.webMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="web-menu"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 8, bottom: hostRect.top };
      const width = 260;
      const height = 300;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || hostRect.top) + 6)),
        width,
        height
      };
    }
    const mode = this.state.ui.webDialog;
    const width = mode === "add-bookmark" ? 430 : 520;
    const itemCount = mode === "bookmarks" ? this.state.browser.bookmarks.length : this.state.browser.history.length;
    const height = mode === "add-bookmark" ? 260 : Math.min(560, Math.max(260, 126 + itemCount * 54));
    return {
      x: Math.max(8, Math.round((viewportWidth - width) / 2)),
      y: Math.max(8, Math.round((viewportHeight - height) / 2)),
      width: Math.min(width, Math.max(240, viewportWidth - 16)),
      height: Math.min(height, Math.max(220, viewportHeight - 16))
    };
  }

  async syncBrowserOverlay(subtab, hostRect) {
    const payload = this.browserOverlayPayload(subtab);
    if (!payload) {
      await this.backend.hideBrowserOverlay?.();
      return;
    }
    if (!this.backend.showBrowserOverlay) return;
    await this.backend.showBrowserOverlay(payload, this.browserOverlayBounds(hostRect));
  }

  async syncNativeWebview() {
    if (!this.native) return;
    const subtab = activeSubtab(this.state);
    const host = this.view.root.querySelector?.("#native-webview-host");
    if (subtab.type !== "webview" || subtab.filePath || !host) {
      await this.backend.hideBrowserOverlay?.();
      await this.backend.hideWebviews?.();
      return;
    }
    const rect = host.getBoundingClientRect();
    const url = subtab.url || "https://www.google.com/";
    const navigate = this.nativeWebviewUrls.get(subtab.id) !== url;
    if (this.backend.showWebview) {
      await this.backend.showWebview(subtab.id, url, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      }, navigate);
      this.nativeWebviewUrls.set(subtab.id, url);
    }
    await this.syncBrowserOverlay(subtab, rect);
  }

  async runWebviewAction(action, value = null) {
    const subtab = activeSubtab(this.state);
    if (subtab.type !== "webview" || subtab.filePath) throw new Error("Open a website tab first.");
    await this.backend.webviewAction(subtab.id, action, value);
  }

  async runWebviewZoom(direction) {
    const subtab = activeSubtab(this.state);
    if (subtab.type !== "webview" || subtab.filePath) throw new Error("Open a website tab first.");
    const zoom = nextWebZoom(subtab.zoom, direction);
    await this.runWebviewAction("zoom", zoom);
    const event = { type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { zoom } } };
    if (this.native && this.state.ui.webMenuOpen) {
      this.state = reduceState(this.state, event);
      await this.backend.updateBrowserOverlayZoom?.(`${Math.round(zoom * 100)}%`);
      return;
    }
    this.dispatch(event, { preserveInput: true });
  }

  async openWebExternal() {
    const subtab = activeSubtab(this.state);
    if (subtab.filePath) return this.openExternal(subtab.filePath);
    const url = subtab.url || this.view.getWebUrl();
    if (!url) throw new Error("Open a website first.");
    if (this.backend.isNative && this.backend.openExternalUrl) return this.backend.openExternalUrl(url);
    if (typeof window !== "undefined") return window.open(url, "_blank", "noopener,noreferrer");
    throw new Error("External browser opening is unavailable.");
  }

  async openFileInWebview(path, metadata) {
    if (this.fileViewUrl) this.backend.releaseFileView?.(this.fileViewUrl);
    const fileView = await this.backend.createFileView(path, metadata);
    this.fileViewUrl = fileView.url;
    return fileView;
  }

  async openExternal(path) {
    if (!path) return;
    if (this.backend.isNative) await this.backend.call("open_external", { path });
    else this.view.showToast("External file opening needs the native build.", "info");
  }

  async startRecording(kind) {
    const source = this.view.root.querySelector("#record-source")?.value;
    const includeMicrophone = Boolean(this.view.root.querySelector("#record-mic")?.checked);
    const needsMicrophone = source === "microphone" || source === "camera" || includeMicrophone;
    const needsScreenRecording = source === "screen" || source === "screen-audio";
    if (needsMicrophone) await this.ensureMediaPermission("microphone");
    if (needsScreenRecording) await this.ensureMediaPermission("screenRecording");
    await this.capture.start({
      kind,
      source,
      includeMicrophone,
      onReady: (result) => this.finishRecording(result)
    });
    this.dispatch({ type: "MEDIA_SET", payload: { status: "recording", kind, previewUrl: null, fileName: null } });
  }

  async finishRecording(result) {
    try {
      const saved = await this.backend.saveMedia({ name: result.fileName, kind: result.kind, blob: result.blob });
      this.dispatch({ type: "MEDIA_SET", payload: { status: "ready", ...result, path: saved.path } });
      this.dispatch({
        type: "INFO_ADD",
        payload: {
          level: "success",
          title: `${result.kind} capture`,
          message: saved.path ? `Saved to ${saved.path}.` : `${result.fileName} is ready to preview or attach.`
        }
      });
    } catch (error) {
      this.dispatch({ type: "MEDIA_SET", payload: { status: "ready", ...result } });
      this.reportError("Save recording", error);
    }
  }

  attachRecordedMedia(kind) {
    if (!this.state.media.previewUrl) return;
    this.dispatch({
      type: "ATTACHMENT_ADD",
      payload: {
        id: `attachment-${Date.now()}`,
        name: this.state.media.fileName,
        kind,
        mime: this.state.media.mime,
        blob: this.state.media.blob,
        url: this.state.media.previewUrl,
        path: this.state.media.path || null
      }
    });
    this.openSingletonSubtab("terminal");
    this.view.showToast("Added to prompt", "success");
  }

  reportError(title, error) {
    this.dispatch({
      type: "INFO_ADD",
      payload: { level: "error", title, message: error?.message || String(error) }
    });
    this.view.showToast(error?.message || String(error), "error");
  }
}
