import { executeCommand } from "./command-controller.js";
import { createInitialState, reduceState, activeWorkspace, activeSubtab } from "../model/state.js";
import { classifyTerminalInput } from "../model/presentation.js";
import { MediaCapture } from "../services/media-recorder.js";
import { isSimpleCdCommand, shellQuote } from "../model/path.js";

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

function attachmentKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

function attachmentPreviewUrl(file, kind) {
  if (kind === "file" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
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
    this.native = backend.isNative;
    this.fileViewUrl = null;
    this.nativeWebviewUrls = new Map();
    this.clipboardPollTimer = null;
    this.clipboardPolling = false;
  }

  context() {
    return {
      backend: this.backend,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event, { preserveInput: true }),
      actions: {
        startRecording: (kind) => this.startRecording(kind),
        stopRecording: () => this.capture.stop(),
        attachMedia: (kind) => this.attachRecordedMedia(kind),
        webReload: () => this.runWebviewAction("reload"),
        webBack: () => this.runWebviewAction("back"),
        webForward: () => this.runWebviewAction("forward"),
        webExternal: () => {
          const subtab = activeSubtab(this.state);
          return subtab.filePath
            ? this.openExternal(subtab.filePath)
            : window.open(this.view.getWebUrl(), "_blank", "noopener,noreferrer");
        },
        openExternal: (path) => this.openExternal(path),
        openFileInWebview: (path, metadata) => this.openFileInWebview(path, metadata),
        copyText: (text) => navigator.clipboard.writeText(text),
        pasteClipboardItem: (id) => this.backend.pasteClipboardItem(id),
        insertText: (text) => this.insertIntoTerminal(text),
        showUserMessage: (text, attachments) => this.activeTerminalSession().printUser(text, attachments),
        showAssistantMessage: (name, text, audio) => this.activeTerminalSession().printAssistant(name, text, audio)
      }
    };
  }

  terminalSessionFor(workspaceId = this.state.activeTabId) {
    let session = this.terminalSessions.get(workspaceId);
    if (session) return session;
    session = this.terminalSessionFactory(this.backend);
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

  dispatch(event, options = {}) {
    const changesWorkspace = ["TAB_SELECT", "TAB_NEW", "TAB_CLOSE"].includes(event.type);
    if (changesWorkspace) {
      const draft = this.view.getTerminalInputValue?.() || "";
      this.state = reduceState(this.state, { type: "TERMINAL_DRAFT_SET", payload: { value: draft } });
    }
    const previousIds = new Set(this.state.tabs.map((tab) => tab.id));
    const previousWebviews = new Set(this.state.tabs.flatMap((tab) => tab.subtabs.filter((item) => item.type === "webview").map((item) => item.id)));
    this.state = reduceState(this.state, event);
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
  }

  render(options = {}) {
    this.view.render(this.state, { native: this.native, ...options });
    const terminalHost = this.view.root.querySelector?.("#terminal-emulator");
    if (terminalHost) {
      const workspace = activeWorkspace(this.state);
      const session = this.terminalSessionFor(workspace.id);
      requestAnimationFrame(() => session.mount(terminalHost, workspace.terminal.cwd, this.state.settings.fontSize).catch((error) => this.reportError("Terminal", error)));
    }
    scheduleFrame(() => this.syncNativeWebview().catch((error) => this.reportError("Webview", error)));
  }

  async initialize() {
    this.bindEvents();
    await this.activeTerminalSession().initializePromise;
    this.render();
    try {
      this.externalUnlisten = await this.backend.listenForCommands?.((command) => this.handleExternalCommand(command));
      this.wakeUnlisten = await this.backend.listen?.("auri-wake", (payload) => this.activateWakeSession(payload));
      const initialized = await this.backend.initialize();
      const saved = this.native ? initialized?.configuration : localStorage.getItem("auri-settings");
      if (saved) {
        try {
          const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
          const settings = parsed.settings || parsed;
          for (const [key, value] of Object.entries(settings)) {
            if (key in this.state.settings) this.state = reduceState(this.state, { type: "SETTING_SET", payload: { key, value } });
          }
          if (Array.isArray(parsed.models)) this.state = { ...this.state, models: parsed.models };
          if (parsed.selectedModelId) this.state = { ...this.state, selectedModelId: parsed.selectedModelId };
        } catch {
          // Ignore malformed preferences and keep safe defaults.
        }
      }
      const root = initialized?.root || "~";
      this.state = reduceState(this.state, { type: "WORKDIR_SET", payload: { path: root } });
      const entries = await this.backend.listDirectory(root);
      this.state = reduceState(this.state, { type: "FOLDER_ENTRIES_SET", payload: { entries } });
      this.state = reduceState(this.state, {
        type: "INFO_ADD",
        payload: {
          level: "success",
          title: "Auri ready",
          message: this.native
            ? `Workspace initialized at ${root}.`
            : "Browser preview is active. Native shell, global shortcuts, filesystem capture, and system audio require the Tauri build."
        }
      });
      this.render();
      this.startClipboardPolling();
    } catch (error) {
      this.reportError("Startup", error);
    }
  }

  bindEvents() {
    this.view.root.addEventListener("click", (event) => this.handleClick(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleTopbarPointerDown(event));
    this.view.root.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.view.root.addEventListener("change", (event) => this.handleChange(event));
    this.view.root.addEventListener("submit", (event) => this.handleSubmit(event));
    window.addEventListener("keydown", (event) => this.handleGlobalKeydown(event));
    window.addEventListener("keyup", (event) => this.handleGlobalKeyup(event));
    window.addEventListener("resize", () => {
      this.activeTerminalSession().resize?.();
      this.syncNativeWebview().catch((error) => this.reportError("Webview", error));
    });
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
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    event.preventDefault();

    try {
      switch (action) {
        case "tab-new":
          await this.runInternal("tab new");
          await this.refreshFolder();
          break;
        case "tab-select":
          await this.runInternal(`tab select ${target.dataset.id}`);
          break;
        case "tab-close":
          await this.runInternal(`tab close ${target.dataset.id || ""}`.trim());
          break;
        case "subtab-select":
          await this.runInternal(`subtab select ${target.dataset.id}`);
          if (activeSubtab(this.state).type === "info") this.dispatch({ type: "INFO_READ", payload: {} });
          break;
        case "subtab-close":
          event.stopPropagation();
          await this.runInternal(`subtab close ${target.dataset.id}`);
          break;
        case "subtab-menu":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: !this.state.ui.addSubtabMenuOpen } });
          break;
        case "subtab-new":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: false } });
          await this.runInternal(`subtab new ${target.dataset.type}`);
          break;
        case "folder-home":
          await this.changeDirectory("~", { echoInTerminal: true });
          break;
        case "folder-up":
          await this.changeDirectory(parentPath(activeWorkspace(this.state).folder.path), { echoInTerminal: true });
          break;
        case "folder-refresh":
          await this.refreshFolder();
          break;
        case "file-entry":
          await this.openFolderEntry(target.dataset.path, target.dataset.kind);
          break;
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
        case "model-select":
          await this.runInternal(`ai model select ${target.dataset.id}`);
          break;
        case "model-save":
          await this.saveModel(target.dataset.id);
          break;
        case "info-open":
          await this.runInternal("info show");
          break;
        case "settings-open":
          await this.runInternal("settings open");
          break;
        case "info-clear":
          await this.runInternal("info clear");
          break;
        case "clipboard-refresh":
          await this.runInternal("clipboard list");
          break;
        case "clipboard-insert":
          await this.insertClipboard(target.dataset.id);
          break;
        case "copy-text":
          await this.runInternal(`clipboard copy ${quoteArg(target.dataset.value || "")}`);
          this.view.showToast("Copied", "success");
          break;
        case "transcript-insert":
          await this.runInternal(`input insert ${quoteArg(target.dataset.value || "")}`);
          break;
        case "attachment-remove":
          await this.runInternal(`attachment remove ${target.dataset.id}`);
          break;
        case "web-go":
          await this.runInternal(`web open ${this.view.getWebUrl()}`);
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
          await this.runInternal("web external");
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

  async handleKeydown(event) {
    if (event.target.id === "terminal-input" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      await this.submitTerminal("run");
      return;
    }
    if (event.target.id === "web-url" && event.key === "Enter") {
      event.preventDefault();
      this.navigateWeb(event.target.value);
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
    if (event.key === "Escape" && this.state.ui.commandPaletteOpen) {
      this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: false } });
    }
  }

  async handleChange(event) {
    const input = event.target;
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
      const value = this.view.getSettingValue(input);
      await this.runInternal(`settings set ${key} ${quoteArg(value)}`);
      this.view.showToast("Setting saved", "success");
    }
  }

  async handleSubmit(event) {
    if (event.target.id !== "model-form") return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    await this.runInternal(`ai model add ${quoteArg(values.name)} ${quoteArg(values.type)} ${quoteArg(values.model)} ${quoteArg(values.url || "")} ${quoteArg(values.apiKey)}`);
    this.view.showToast("Model added", "success");
  }

  handleGlobalKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!this.state.ui.commandPaletteOpen) {
        this.dispatch({ type: "UI_SET", payload: { commandPaletteOpen: true } });
        this.view.focusPalette();
      }
      return;
    }
    if (!this.native && event.altKey && event.code === "Space" && !event.repeat && !this.wakeTimer) {
      event.preventDefault();
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.activateWakeSession();
      }, Number(this.state.settings.wakeHoldSeconds) * 1000);
    }
  }

  handleGlobalKeyup(event) {
    if (event.code === "Space" && this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  async activateWakeSession(screenshot = null) {
    try {
      if (this.wakeLiveSession) await this.wakeLiveSession.cancel();

      const model = this.state.models.find((item) => item.id === this.state.selectedModelId);
      if (!model || model.type !== "gemini-live") {
        throw new Error("Select a Gemini Live model in Settings before using Alt+Space.");
      }

      this.openSingletonSubtab("terminal");
      this.wakeStreamText = "";
      this.wakeStreamStarted = false;
      this.activeTerminalSession().printMessage("Voice", "Listening…", "33");
      this.view.showToast("Listening…", "info");

      this.wakeLiveSession = await this.backend.startWakeLiveSession({
        model,
        screenshot,
        inactivitySeconds: this.state.settings.liveDisconnectSeconds,
        onStatus: (status) => this.handleWakeStatus(status),
        onText: (text) => this.handleWakeStreamText(text, model),
        onResult: (result) => this.finishWakeLiveResult(result, model),
        onError: (error) => this.failWakeLiveSession(error)
      });
    } catch (error) {
      this.wakeLiveSession = null;
      this.reportError("Wake shortcut", error);
    }
  }

  handleWakeStreamText(text, model) {
    const next = String(text || "");
    if (!next || next === this.wakeStreamText) return;
    if (!this.wakeStreamStarted) {
      this.wakeStreamStarted = true;
      this.activeTerminalSession().beginAssistantStream(model?.name || "Gemini Live");
    }

    const delta = next.startsWith(this.wakeStreamText)
      ? next.slice(this.wakeStreamText.length)
      : next;
    this.wakeStreamText = next;
    this.activeTerminalSession().appendAssistantStream(delta);
  }

  handleWakeStatus(status) {
    const disconnected = status.startsWith("disconnected");
    const liveConnected = status === "connected" || (this.state.ui.liveConnected && !disconnected);
    this.dispatch({ type: "UI_SET", payload: { liveConnected, liveStatus: status } }, { preserveInput: true });

    const messages = {
      recording: "Listening…",
      connecting: "Listening while Gemini Live connects…",
      connected: "Gemini Live connected — listening…",
      processing: "Gemini is responding…",
      disconnecting: "Disconnecting Gemini Live after inactivity…",
      "disconnected-idle": "Gemini Live disconnected after inactivity.",
      disconnected: "Gemini Live disconnected."
    };
    const message = messages[status];
    if (!message) return;
    if (disconnected) this.wakeLiveSession = null;
    this.view.showToast(message, status === "connected" ? "success" : "info");
  }

  finishWakeLiveResult(result, model) {
    const text = result?.text || "Gemini Live returned no response.";
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
    if (this.wakeStreamStarted) {
      this.activeTerminalSession().endAssistantStream();
      if (assistantAudio) this.activeTerminalSession().printMedia([assistantAudio]);
    } else {
      this.activeTerminalSession().printAssistant(model?.name || "Gemini Live", text, assistantAudio);
    }
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
  }

  failWakeLiveSession(error) {
    this.wakeLiveSession = null;
    if (this.wakeStreamStarted) this.activeTerminalSession().endAssistantStream();
    this.wakeStreamText = "";
    this.wakeStreamStarted = false;
    this.dispatch({ type: "UI_SET", payload: { liveConnected: false, liveStatus: "error" } }, { preserveInput: true });
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
    this.view.setTerminalInput("", false);
    if (mode === "ask") await this.runInternal(`ai ask ${value}`);
    else if (classifyTerminalInput(value) === "auri") await this.runInternal(value);
    else if (this.native) await this.runNativeTerminalCommand(value);
    else await this.runInternal(`terminal run ${value}`);
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
    const workspace = activeWorkspace(this.state);
    if (workspace.id === workspaceId && activeSubtab(this.state).type === "terminal") {
      scheduleFrame(() => this.terminalSessionFor(workspaceId).focus?.());
    }
  }

  async changeDirectory(path, { echoInTerminal = false } = {}) {
    const workspace = activeWorkspace(this.state);
    const command = `cd ${shellQuote(path)}`;
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

  async saveModel(id) {
    const patch = this.view.getModelFields(id);
    await this.runInternal(`ai model update ${quoteArg(id)} ${quoteArg(patch.url)} ${quoteArg(patch.apiKey)}`);
    this.view.showToast("Model saved", "success");
  }

  async persistConfiguration() {
    await this.backend.saveSettings({
      settings: this.state.settings,
      models: this.state.models,
      selectedModelId: this.state.selectedModelId
    });
  }

  navigateWeb(rawUrl) {
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const subtab = activeSubtab(this.state);
    this.dispatch({ type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { url } } });
  }

  async syncNativeWebview() {
    if (!this.native) return;
    const subtab = activeSubtab(this.state);
    const host = this.view.root.querySelector?.("#native-webview-host");
    if (subtab.type !== "webview" || subtab.filePath || !host) {
      await this.backend.hideWebviews?.();
      return;
    }
    const rect = host.getBoundingClientRect();
    const url = subtab.url || "https://www.google.com/";
    const navigate = this.nativeWebviewUrls.get(subtab.id) !== url;
    if (!this.backend.showWebview) return;
    await this.backend.showWebview(subtab.id, url, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }, navigate);
    this.nativeWebviewUrls.set(subtab.id, url);
  }

  async runWebviewAction(action) {
    const subtab = activeSubtab(this.state);
    if (subtab.type !== "webview" || subtab.filePath) throw new Error("Open a website tab first.");
    await this.backend.webviewAction(subtab.id, action);
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
