import { executeCommand } from "./command-controller.js";
import { createInitialState, reduceState, activeWorkspace, activeSubtab, serializeWorkspaceSession } from "../model/state.js";
import { appSnapshotJson } from "../model/snapshot.js";
import { normalizeSystemSnapshot, processPriorityIdentity, protocolForPort } from "../model/system.js";
import { expireNewFolderEntries, mergePolledFolderEntries, NEW_FOLDER_HIGHLIGHT_MS } from "../model/folder.js";
import { classifyTerminalInput } from "../model/presentation.js";
import { mirrorForwardsCommand } from "../model/commands.js";
import { MediaCapture, pickRecordingDevices } from "../services/media-recorder.js";
import { isSimpleCdCommand, shellQuote } from "../model/path.js";
import { defaultBookmarkName, nextWebZoom, normalizeWebUrl, titleForWebUrl, webAiMenuItems, webAiMenuPayload, webAiPrompt } from "../model/browser.js";
import { AssistantStreamParser, assistantPlainText, parseAssistantReply } from "../model/assistant.js";
import { terminalCompletionContext, terminalCompletions } from "../model/terminal-completion.js";
import { shortcutFromKeyboardEvent, shortcutKeyMatchesKeyboardEvent, shortcutMatchesKeyboardEvent, tabSwitchFromKeyboardEvent } from "../model/shortcut.js";
import { terminalFocusZone } from "../views/app-view.js";

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

function folderPaneWidth(value) {
  return Math.min(420, Math.max(160, Number(value) || 230));
}

export function folderPanePreviewAnchor(rowAnchor = {}, folderPaneRect = null) {
  const paneRight = Number(folderPaneRect?.right);
  const rowRight = Number(rowAnchor?.right);
  const rightEdge = Number.isFinite(paneRight)
    ? paneRight
    : (Number.isFinite(rowRight) ? rowRight : Number(rowAnchor?.left) || 0);
  return {
    left: rightEdge + 8,
    right: rightEdge + 9,
    top: Number(rowAnchor?.top) || 0,
    bottom: Number(rowAnchor?.bottom) || Number(rowAnchor?.top) || 1
  };
}

function scheduleFrame(callback) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else callback();
}

// A web tab left in the background this long has its native webview written to
// disk and destroyed so its WebKit content process stops consuming memory.
// Short grace period: an unfocused web tab drops its WebKit content process
// almost immediately (state persists to disk), while still surviving an
// accidental tab flip without a reload.
const WEBVIEW_SLEEP_DELAY_MS = 2_000;

// Cadence for mirroring the app-state JSON into the native layer for the
// external CLI/TUI. Terminal output can be chatty, so pushes are throttled.
const STATE_SYNC_DELAY_MS = 200;

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

function permissionsEqual(left, right) {
  if (!left || !right) return false;
  return left.platform === right.platform
    && left.microphone === right.microphone
    && left.screenRecording === right.screenRecording
    && left.systemAudio === right.systemAudio;
}

function systemSnapshotAgeMs(snapshot) {
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt) return Number.POSITIVE_INFINITY;
  const age = Date.now() - new Date(capturedAt).getTime();
  return Number.isFinite(age) && age >= 0 ? age : Number.POSITIVE_INFINITY;
}

const WORKSPACE_PERSIST_EVENTS = new Set(["TAB_NEW", "TAB_SELECT", "TAB_CLOSE", "WORKDIR_SET", "FOLDER_PATH_SET", "TERMINAL_COMMAND_REMEMBER"]);

// Events that can move focus off the System monitor; leaving it drops the
// heavy process list from state until the monitor is refocused.
const SUBTAB_SWITCH_EVENTS = new Set(["TAB_NEW", "TAB_SELECT", "TAB_CLOSE", "SUBTAB_NEW", "SUBTAB_SELECT", "SUBTAB_CLOSE"]);

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
  constructor({ view, backend, terminalSessionFactory, webviewSleepDelayMs, stateSyncDelayMs }) {
    this.view = view;
    this.backend = backend;
    this.state = createInitialState();
    this.capture = new MediaCapture();
    this.terminalSessionFactory = terminalSessionFactory || (() => { throw new Error("Terminal session factory is unavailable."); });
    this.terminalSessions = new Map();
    // Last focused terminal zone ("screen" | "composer"), restored on switches.
    this.terminalFocusZone = "screen";
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
    this.magicPointerId = null;
    this.magicStartPromise = null;
    this.magicHoldTimer = null;
    this.magicLongPress = false;
    this.magicSuppressClick = false;
    // Where live-session replies render: the terminal transcript or the
    // floating panel on the current web tab.
    this.wakePresentation = "terminal";
    this.native = backend.isNative;
    this.fileViewUrl = null;
    this.nativeWebviewUrls = new Map();
    this.nativeWebviewLayouts = new Map();
    this.nativeWebviewShownId = null;
    this.nativeBrowserOverlayKey = null;
    this.webviewSleepTimers = new Map();
    this.sleptWebviews = new Map();
    this.webviewSleepDelayMs = Number.isFinite(webviewSleepDelayMs) ? webviewSleepDelayMs : WEBVIEW_SLEEP_DELAY_MS;
    this.webMenuSuppressClick = false;
    this.subtabClickId = null;
    this.subtabClickAt = 0;
    this.subtabMenuOpenedByClickId = null;
    this.subtabMenuOpenedByClickAt = 0;
    this.clipboardPollTimer = null;
    this.clipboardPolling = false;
    this.systemMonitorTimer = null;
    this.processPriorityTimer = null;
    this.processPrioritySuggestionTimer = null;
    this.processPriorityErrors = new Set();
    this.systemMonitorRefreshing = false;
    this.folderPollTimer = null;
    this.folderPolling = false;
    this.folderHighlightTimer = null;
    this.folderPathTimer = null;
    this.folderPathRequest = 0;
    this.folderPreviewPath = null;
    this.folderPreviewReturnSubtabId = null;
    this.configurationReady = false;
    this.terminalCompletions = [];
    this.terminalCompletionIndex = -1;
    this.terminalCompletionRange = null;
    this.terminalCompletionTimer = null;
    this.terminalCompletionPending = null;
    this.terminalSelectionRequest = 0;
    this.systemMonitorQuietPollCount = 0;
    this.systemProcessPageTurnAt = 0;
    this.terminalEnterHoldTimer = null;
    this.terminalEnterHeld = false;
    this.zoomHoldTimer = null;
    this.folderResizeDrag = null;
    this.systemTunnelPromptResolver = null;
    this.pendingOpenFiles = [];
    this.pendingOpenFilesDrain = null;
    this.pendingOpenFilesDrainRequested = false;
    this.stateSyncDelayMs = Number.isFinite(stateSyncDelayMs) ? stateSyncDelayMs : STATE_SYNC_DELAY_MS;
    this.stateSyncTimer = null;
    this.stateSyncSeq = 0;
    // Hosted web mirror: the latest snapshot's terminal map (subtab id →
    // shared PTY info) so new sessions can adopt the desktop window's PTYs.
    this.mirrorTerminals = {};
    this.mirrorUnlisten = null;
  }

  // The whole app state (including background terminal buffers) is mirrored as
  // one JSON line into the native layer, where the external CLI/TUI reads and
  // watches it. Trailing throttle: at most one push per window, never lost.
  scheduleStateSync() {
    if (!this.native || !this.backend.syncAppState) return;
    if (this.stateSyncTimer) return;
    this.stateSyncTimer = setTimeout(() => {
      this.stateSyncTimer = null;
      this.pushStateSnapshot().catch((error) => {
        // Not reportError: a failing push must not dispatch and reschedule itself.
        console.error("Could not sync app state", error);
      });
    }, this.stateSyncDelayMs);
    this.stateSyncTimer.unref?.();
  }

  terminalBufferSnapshots() {
    const buffers = {};
    for (const [subtabId, session] of this.terminalSessions) {
      buffers[subtabId] = {
        sessionId: session.sessionId || "",
        text: session.bufferText?.() || "",
        cols: session.cols || 0,
        rows: session.rows || 0
      };
    }
    return buffers;
  }

  async pushStateSnapshot() {
    if (!this.native || !this.backend.syncAppState) return false;
    this.stateSyncSeq += 1;
    const json = appSnapshotJson(this.state, {
      seq: this.stateSyncSeq,
      terminalBuffers: this.terminalBufferSnapshots()
    });
    await this.backend.syncAppState(json);
    return true;
  }

  context() {
    return {
      backend: this.backend,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event, { preserveInput: true }),
      actions: {
        startRecording: (kind) => this.startRecording(kind),
        stopRecording: () => this.capture.stop(),
        pauseRecording: () => this.capture.pause(),
        resumeRecording: () => this.capture.resume(),
        capturePhoto: () => this.capturePhoto(),
        switchMicrophone: (deviceId) => this.capture.switchMicrophone(deviceId),
        startLiveRecording: () => this.activateWakeSession(null, { captureScreenshot: true }),
        stopLiveRecording: () => this.stopWakeLiveRecording(),
        toggleLiveRecording: () => this.toggleLiveRecording(),
        refreshMediaPermissions: () => this.refreshMediaPermissions(),
        requestMediaPermission: (permission) => this.requestMediaPermission(permission),
        attachMedia: (kind) => this.attachRecordedMedia(kind),
        webReload: () => this.reloadSubtab(activeSubtab(this.state).id),
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
        openFileInWebview: (path, metadata, options) => this.openFileInWebview(path, metadata, options),
        copyText: (text) => this.backend.writeClipboardText
          ? this.backend.writeClipboardText(text)
          : navigator.clipboard.writeText(text),
        pasteClipboardItem: (id) => this.backend.pasteClipboardItem(id),
        insertText: (text) => this.insertIntoTerminal(text),
        selectSubtab: (id) => this.selectSubtab(id),
        reloadSubtab: (id) => this.reloadSubtab(id),
        moveSubtabToWindow: (id) => this.moveSubtabToWindow(id),
        moveSubtabToMain: (id) => this.moveSubtabToMain(id),
        showUserMessage: (text, attachments) => this.activeTerminalSession().printUser(text, attachments),
        showAssistantMessage: (name, text, audio) => this.showCompletedAssistantMessage(name, text, audio),
        refreshFolder: () => this.refreshFolder(),
        refreshSystemMonitor: () => this.refreshSystemMonitor(),
        requestProcessPriorityPermission: (prompt) => this.dispatch({ type: "UI_SET", payload: { systemPriorityPrompt: prompt } }, { preserveInput: true }),
        consumeProcessPriorityPassword: () => this.view.consumeSystemPriorityPassword?.() || "",
        closeProcessPriorityPermission: () => this.dispatch({ type: "UI_SET", payload: { systemPriorityPrompt: null } }, { preserveInput: true }),
        exitApp: () => this.backend.exitApp(),
        openBrowserUi: async () => {
          const info = await this.backend.serveUi();
          if (!info?.alreadyHosted) await this.backend.openExternalUrl(info.url);
          return info;
        }
      }
    };
  }

  terminalSubtabs(state = this.state) {
    return state.tabs.flatMap((workspace) => workspace.subtabs
      .filter((subtab) => subtab.type === "terminal")
      .map((subtab) => ({ workspace, subtab })));
  }

  resolveTerminalTarget(identifier = null) {
    const terminalSubtabs = this.terminalSubtabs();
    if (!terminalSubtabs.length) return null;

    if (identifier) {
      const bySubtab = terminalSubtabs.find(({ subtab }) => subtab.id === identifier);
      if (bySubtab) return bySubtab;
      const byWorkspace = terminalSubtabs.find(({ workspace }) => workspace.id === identifier);
      if (byWorkspace) return byWorkspace;
    }

    const workspace = activeWorkspace(this.state);
    const active = activeSubtab(this.state);
    if (active?.type === "terminal") return { workspace, subtab: active };
    return terminalSubtabs.find((item) => item.workspace.id === workspace.id) || terminalSubtabs[0];
  }

  terminalSessionFor(identifier = null) {
    const target = this.resolveTerminalTarget(identifier);
    if (!target) throw new Error("No terminal tab is available.");
    const sessionKey = target.subtab.id;
    let session = this.terminalSessions.get(sessionKey);
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
      },
      preparePreview: (target) => this.prepareTerminalPreview(target),
      openPreview: (target) => this.openTerminalPreview(target),
      releasePreview: (preview) => this.backend.releaseFileView?.(preview?.url)
    });
    session.onCwdChange = (path) => this.handleTerminalCwdChange(target.workspace.id, target.subtab.id, path);
    session.onOutput = () => this.scheduleStateSync();
    if (this.backend.isHostedWeb) {
      session.adoptOnly = true;
      const shared = this.mirrorTerminals?.[sessionKey];
      if (shared?.sessionId) {
        session.adopt(shared).catch((error) => this.reportError("Terminal mirror", error));
      }
    }
    session.initializePromise = Promise.resolve(session.initialize()).catch((error) => {
      this.reportError("Terminal", error);
      return false;
    });
    this.terminalSessions.set(sessionKey, session);
    return session;
  }

  activeTerminalSession() {
    return this.terminalSessionFor();
  }

  clearTerminalCompletions(updateView = true) {
    if (this.terminalCompletionTimer) {
      clearTimeout(this.terminalCompletionTimer);
      this.terminalCompletionTimer = null;
    }
    this.terminalCompletionPending = null;
    this.terminalCompletions = [];
    this.terminalCompletionIndex = -1;
    this.terminalCompletionRange = null;
    if (updateView) this.view.setTerminalCompletions?.([], -1);
  }

  completionInputSnapshot(pending) {
    const input = this.view.getTerminalInput?.();
    if (input && input.ownerDocument?.activeElement === input) {
      return { value: input.value, cursor: input.selectionStart };
    }
    return pending;
  }

  scheduleTerminalCompletions(value = this.view.getTerminalInputValue?.() || "", cursor) {
    this.terminalCompletionPending = { value, cursor };
    if (this.terminalCompletionTimer) clearTimeout(this.terminalCompletionTimer);
    this.terminalCompletionTimer = setTimeout(() => {
      this.terminalCompletionTimer = null;
      const pending = this.terminalCompletionPending;
      this.terminalCompletionPending = null;
      if (!pending) return;
      const snapshot = this.completionInputSnapshot(pending);
      this.refreshTerminalCompletions(snapshot.value, snapshot.cursor);
    }, 75);
    this.terminalCompletionTimer.unref?.();
  }

  flushTerminalCompletions() {
    if (!this.terminalCompletionTimer && !this.terminalCompletionPending) return;
    if (this.terminalCompletionTimer) {
      clearTimeout(this.terminalCompletionTimer);
      this.terminalCompletionTimer = null;
    }
    const pending = this.terminalCompletionPending;
    this.terminalCompletionPending = null;
    if (!pending) return;
    const snapshot = this.completionInputSnapshot(pending);
    this.refreshTerminalCompletions(snapshot.value, snapshot.cursor);
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
    const previousTerminals = new Set(this.terminalSubtabs().map(({ subtab }) => subtab.id));
    const previousWebviews = new Set(this.state.tabs.flatMap((tab) => tab.subtabs.filter((item) => item.type === "webview").map((item) => item.id)));
    this.state = reduceState(this.state, event);
    this.clearTerminalCompletions(false);
    const currentTerminals = new Set(this.terminalSubtabs().map(({ subtab }) => subtab.id));
    for (const id of previousTerminals) {
      if (!currentTerminals.has(id)) {
        this.terminalSessions.get(id)?.stop?.().catch?.(() => {});
        this.terminalSessions.delete(id);
      }
    }
    for (const id of previousWebviews) {
      const stillExists = this.state.tabs.some((tab) => tab.subtabs.some((item) => item.id === id));
      if (!stillExists) {
        this.backend.closeWebview?.(id).catch?.(() => {});
        this.backend.closeStandaloneTab?.(id).catch?.(() => {});
        this.forgetNativeWebview(id);
      }
    }
    if (SUBTAB_SWITCH_EVENTS.has(event.type) && !this.isSystemMonitorActive()) {
      this.state = reduceState(this.state, { type: "SYSTEM_SNAPSHOT_TRIM" });
    }
    const targetWorkspaceId = event.payload?.workspaceId || this.state.activeTabId;
    const shouldFocusTerminal = Boolean(
      options.focusTerminal
      || (SUBTAB_SWITCH_EVENTS.has(event.type) && activeSubtab(this.state)?.type === "terminal")
      || (event.type === "WORKDIR_SET" && targetWorkspaceId === this.state.activeTabId && activeSubtab(this.state)?.type === "terminal")
    );
    const renderOptions = { ...options, focusTerminal: shouldFocusTerminal };
    if (options.render !== false) {
      this.render(changesWorkspace ? { ...renderOptions, preserveInput: false } : renderOptions);
    }
    if (this.configurationReady && WORKSPACE_PERSIST_EVENTS.has(event.type)) {
      this.persistConfiguration().catch((error) => this.reportError("Workspace save", error));
    }
    this.scheduleStateSync();
  }

  render(options = {}) {
    this.view.render(this.state, { native: this.native, nativeWebview: this.native, ...options });
    this.scheduleFolderHighlightExpiry();
    const terminalHost = this.view.root.querySelector?.("#terminal-emulator");
    if (terminalHost) {
      const workspace = activeWorkspace(this.state);
      const terminalTarget = this.resolveTerminalTarget();
      if (terminalTarget) {
        const session = this.terminalSessionFor(terminalTarget.subtab.id);
        requestAnimationFrame(() => {
          session.mount(terminalHost, terminalTarget.subtab.cwd || workspace.terminal.cwd, this.state.settings.fontSize, this.state.settings.terminalMaxLines, this.state.settings.terminalShellCommand)
            .then(() => {
              // Restore whichever terminal zone was focused last: the
              // composer input below the terminal, or the emulator screen.
              if (options.focusTerminal && this.terminalFocusZone === "composer") {
                this.view.getTerminalInput?.()?.focus?.();
                return;
              }
              if (options.focusTerminal && !this.isTerminalComposerFocused()) session.focus?.();
            })
            .catch((error) => this.reportError("Terminal", error));
        });
      }
    }
    this.sleepBackgroundTerminals();
    scheduleFrame(() => this.syncNativeWebview().catch((error) => this.reportError("Webview", error)));
    scheduleFrame(() => this.syncRecorderUi());
    this.syncSystemMonitorPolling();
    const snapshotFresh = systemSnapshotAgeMs(this.state.system?.snapshot) < 4000;
    if (this.backend.systemSnapshot && this.isSystemMonitorActive() && this.state.system.status === "idle" && !snapshotFresh) {
      scheduleFrame(() => this.refreshSystemMonitor().catch((error) => this.reportError("System", error)));
    }
  }

  // Background terminals must not keep an emulator alive: their state stays
  // in the session's recorded output (and the JSON snapshot) until refocused.
  sleepBackgroundTerminals() {
    const active = activeSubtab(this.state);
    const focusedId = active?.type === "terminal" ? active.id : null;
    for (const [id, session] of this.terminalSessions) {
      if (id !== focusedId) session.sleep?.();
    }
  }

  isTerminalComposerFocused() {
    const input = this.view.getTerminalInput?.();
    return Boolean(input && input.ownerDocument?.activeElement === input);
  }

  isSystemMonitorActive(state = this.state) {
    return ["system", "disk", "net"].includes(activeSubtab(state)?.type);
  }

  applySystemMonitorEvent(event, { render = true } = {}) {
    if (render) {
      this.dispatch(event, { preserveInput: true });
    } else {
      this.state = reduceState(this.state, event);
      this.scheduleStateSync();
    }
  }

  syncSystemMonitorPolling() {
    if (this.backend.systemSnapshot && this.isSystemMonitorActive()) {
      if (!this.systemMonitorTimer) {
        this.systemMonitorTimer = setInterval(() => {
          if (!this.isSystemMonitorActive()) return;
          this.refreshSystemMonitor({ quiet: true }).catch((error) => this.reportError("System", error));
        }, 5000);
        this.systemMonitorTimer.unref?.();
      }
      return;
    }
    if (this.systemMonitorTimer) {
      clearInterval(this.systemMonitorTimer);
      this.systemMonitorTimer = null;
    }
  }

  startFolderPolling() {
    if (this.folderPollTimer || !this.backend.listDirectory) return;
    this.folderPollTimer = setInterval(() => {
      this.pollCurrentFolder().catch((error) => this.reportError("Folder refresh", error));
    }, 3000);
    this.folderPollTimer.unref?.();
    this.scheduleFolderHighlightExpiry();
  }

  scheduleFolderHighlightExpiry() {
    clearTimeout(this.folderHighlightTimer);
    this.folderHighlightTimer = null;
    const workspace = activeWorkspace(this.state);
    const now = Date.now();
    const deadlines = (workspace.folder.entries || [])
      .filter((entry) => entry?._auriNew)
      .map((entry) => (Number(entry._auriNewAt) || now) + NEW_FOLDER_HIGHLIGHT_MS);
    if (!deadlines.length) return;
    const workspaceId = workspace.id;
    const path = workspace.folder.path;
    this.folderHighlightTimer = setTimeout(() => {
      this.expireFolderHighlights({ workspaceId, path, now: Date.now() });
    }, Math.max(0, Math.min(...deadlines) - now));
    this.folderHighlightTimer.unref?.();
  }

  expireFolderHighlights({ workspaceId, path, now = Date.now() } = {}) {
    const workspace = this.state.tabs.find((tab) => tab.id === workspaceId);
    if (!workspace || workspace.folder.path !== path) {
      this.scheduleFolderHighlightExpiry();
      return false;
    }
    const entries = expireNewFolderEntries(workspace.folder.entries, now);
    const changed = entries.some((entry, index) => entry !== workspace.folder.entries[index]);
    if (!changed) {
      this.scheduleFolderHighlightExpiry();
      return false;
    }
    this.state = reduceState(this.state, { type: "FOLDER_ENTRIES_SET", payload: { workspaceId, entries } });
    if (this.state.activeTabId === workspaceId) {
      this.view.patchFolderEntries?.(this.state, { replaceAll: false, addedPaths: [] });
    }
    this.scheduleFolderHighlightExpiry();
    this.scheduleStateSync();
    return true;
  }

  async pollCurrentFolder() {
    if (this.folderPolling) return false;
    this.folderPolling = true;
    const workspaceId = this.state.activeTabId;
    const path = activeWorkspace(this.state).folder.path;
    try {
      const fresh = await this.backend.listDirectory(path);
      const workspace = activeWorkspace(this.state);
      if (this.state.activeTabId !== workspaceId || workspace.folder.path !== path) return false;
      const previous = workspace.folder.entries || [];
      const merged = mergePolledFolderEntries(previous, fresh);
      const comparable = (entries) => JSON.stringify(entries.map(({ _auriNew, _auriNewAt, ...entry }) => entry));
      const previousPaths = new Set(previous.map((entry) => String(entry.path || entry.name || "")));
      const addedPaths = merged
        .map((entry) => String(entry.path || entry.name || ""))
        .filter((entryPath) => !previousPaths.has(entryPath));
      const hasNew = addedPaths.length > 0;
      const markerChanged = merged.some((entry, index) => Boolean(entry?._auriNew) !== Boolean(previous[index]?._auriNew));
      if (!hasNew && !markerChanged && comparable(previous) === comparable(merged)) return false;
      this.state = reduceState(this.state, { type: "FOLDER_ENTRIES_SET", payload: { workspaceId, entries: merged } });
      this.view.patchFolderEntries?.(this.state, { replaceAll: false, addedPaths });
      this.scheduleFolderHighlightExpiry();
      this.scheduleStateSync();
      return true;
    } finally {
      this.folderPolling = false;
    }
  }

  startProcessPriorityEnforcement() {
    if (this.processPriorityTimer || !this.backend.setProcessPriority) return;
    this.processPriorityTimer = setInterval(() => {
      this.reapplySavedProcessPriorities().catch((error) => this.reportError("Process priority", error));
    }, 60_000);
    this.processPriorityTimer.unref?.();
  }

  async reapplySavedProcessPriorities() {
    const rules = this.state.system?.processPriorities || {};
    if (!Object.keys(rules).length || !this.backend.systemSnapshot) return [];
    const snapshot = normalizeSystemSnapshot(await this.backend.systemSnapshot({ includeGpus: Boolean(this.state.system.gpuMode) }));
    this.applySystemMonitorEvent({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } }, { render: false });
    const results = await this.applySavedProcessPriorities(snapshot);
    // Enforcement works from its local snapshot; state only keeps the heavy
    // process list while the monitor is actually on screen.
    if (!this.isSystemMonitorActive()) {
      this.applySystemMonitorEvent({ type: "SYSTEM_SNAPSHOT_TRIM" }, { render: false });
    }
    return results;
  }

  async applySavedProcessPriorities(snapshot) {
    if (!this.backend.setProcessPriority) return [];
    const rules = this.state.system?.processPriorities || {};
    const results = [];
    for (const process of snapshot.processes || []) {
      const identity = processPriorityIdentity(process);
      const rule = rules[identity];
      if (!rule || Number(process.priority) === Number(rule.nice)) continue;
      try {
        await this.backend.setProcessPriority(process.pid, rule.nice);
        this.applySystemMonitorEvent({ type: "SYSTEM_PROCESS_PRIORITY_APPLIED", payload: { pid: process.pid, nice: rule.nice } }, { render: false });
        this.processPriorityErrors.delete(identity);
        results.push({ pid: process.pid, identity, nice: rule.nice });
      } catch (error) {
        if (!this.processPriorityErrors.has(identity)) {
          this.processPriorityErrors.add(identity);
          this.reportError("Process priority", `${process.name}: ${error?.message || String(error)}`);
        }
      }
    }
    return results;
  }

  async refreshSystemMonitor({ quiet = false } = {}) {
    if (this.systemMonitorRefreshing) return this.state.system.snapshot;
    if (!this.backend.systemSnapshot) throw new Error("System monitor is unavailable in this runtime.");
    this.systemMonitorRefreshing = true;
    // Quiet polls never trigger a full render: state updates silently and,
    // when a monitor subtab is open, the visible values are patched in place.
    const render = !quiet;
    if (!quiet && !this.state.system.snapshot) {
      this.applySystemMonitorEvent({ type: "SYSTEM_STATUS_SET", payload: { status: "loading" } }, { render });
    }
    try {
      const snapshot = normalizeSystemSnapshot(await this.backend.systemSnapshot({ includeGpus: Boolean(this.state.system.gpuMode) }));
      this.applySystemMonitorEvent({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } }, { render });
      await this.applySavedProcessPriorities(snapshot);
      const syncTunnels = !quiet || (this.systemMonitorQuietPollCount += 1) % 3 === 0;
      if (syncTunnels) await this.refreshActiveTunnels({ render });
      if (quiet) this.patchOrRenderSystemMonitor();
      return snapshot;
    } catch (error) {
      this.applySystemMonitorEvent({ type: "SYSTEM_STATUS_SET", payload: { status: "error", error: error?.message || String(error) } }, { render });
      if (quiet) this.patchOrRenderSystemMonitor();
      throw error;
    } finally {
      this.systemMonitorRefreshing = false;
    }
  }

  patchOrRenderSystemMonitor() {
    if (!this.isSystemMonitorActive()) return;
    const patched = this.view.patchSystemMonitor?.(this.state);
    if (!patched) this.render({ preserveInput: true });
  }

  // Reconciles state.system.tunnels with tunnels actually running on the
  // host. This covers tunnels Auri itself started, but also ones started
  // outside Auri (e.g. a fixed-URL production tunnel via
  // `cloudflared tunnel run --token ...`), which discover_active_tunnels
  // finds by reading the cloudflared process list plus its log/config
  // files. Without this sync, externally-managed tunnels never show up in
  // the process detail UI, because state.system.tunnels was previously only
  // ever written to by the start/stop tunnel actions.
  async refreshActiveTunnels({ render = true } = {}) {
    if (!this.backend.cloudflaredActiveTunnels) return;
    let discovered;
    try {
      discovered = await this.backend.cloudflaredActiveTunnels();
    } catch (error) {
      return;
    }
    if (!Array.isArray(discovered)) return;

    // Cross-check each discovered tunnel's pid against the live process
    // list from the same system snapshot poll. discover_active_tunnels
    // already filters to processes whose command line contains
    // "cloudflared", but this extra check catches the case where the pid
    // was stale/reused or the snapshot and discovery briefly disagree, so a
    // dead tunnel's URL never lingers in the process detail panel.
    const hasProcessSnapshot = Array.isArray(this.state.system?.snapshot?.processes);
    const liveProcessPids = new Set(
      (this.state.system?.snapshot?.processes || [])
        .map((process) => Number(process?.pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    );

    const known = this.state.system?.tunnels || {};
    const seenPorts = new Set();
    for (const tunnel of discovered) {
      const port = Number(tunnel?.port);
      if (!Number.isInteger(port) || port <= 0) continue;
      const pid = Number(tunnel?.pid);
      // Only treat the live-process check as authoritative when we actually
      // have a process snapshot to check against and a real pid was
      // reported; otherwise fall back to trusting discovery alone so we
      // don't drop valid tunnels just because the snapshot hasn't loaded.
      if (hasProcessSnapshot && Number.isInteger(pid) && pid > 0 && !liveProcessPids.has(pid)) {
        continue;
      }
      seenPorts.add(port);
      const existing = known[port];
      if (existing && existing.url === tunnel.url && existing.pid === tunnel.pid && existing.path === tunnel.path) continue;
      this.applySystemMonitorEvent(
        { type: "SYSTEM_TUNNEL_SET", payload: { port, url: tunnel.url, pid: tunnel.pid, path: tunnel.path } },
        { render }
      );
    }
    for (const portKey of Object.keys(known)) {
      const port = Number(portKey);
      if (!seenPorts.has(port)) {
        this.applySystemMonitorEvent({ type: "SYSTEM_TUNNEL_REMOVE", payload: { port } }, { render });
        if (this.state.ui.tunnelUrlMenuPort === port) {
          this.applySystemMonitorEvent({ type: "UI_SET", payload: { tunnelUrlMenuPort: null } }, { render });
        }
      }
    }
  }

  async refreshMediaPermissions({ render = true } = {}) {
    if (!this.backend.getMediaPermissions) return this.state.permissions;
    const permissions = await this.backend.getMediaPermissions();
    if (permissionsEqual(this.state.permissions, permissions)) return this.state.permissions;
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

  // Hosted web mirror: subscribe to the desktop window's app-state stream and
  // seed from the latest published snapshot so the browser, GUI, and TUI all
  // render the same workspaces.
  async setupMirrorMode() {
    this.mirrorUnlisten = await this.backend.listen?.("app-state", (snapshot) => this.applyMirrorSnapshot(snapshot));
    try {
      const snapshot = await this.backend.fetchAppState();
      if (snapshot) this.applyMirrorSnapshot(snapshot);
    } catch (error) {
      this.reportError("App state mirror", error);
    }
  }

  applyMirrorSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    this.mirrorTerminals = snapshot.terminals || {};
    this.dispatch(
      { type: "MIRROR_WORKSPACES_SYNC", payload: { snapshot } },
      { preserveInput: true, render: this.configurationReady }
    );
    for (const key of ["theme", "fontSize", "terminalShellPreset", "terminalShellCommand"]) {
      const value = snapshot.settings?.[key];
      if (value !== undefined && value !== this.state.settings[key]) {
        this.dispatch({ type: "SETTING_SET", payload: { key, value } }, { preserveInput: true, render: this.configurationReady });
      }
    }
    for (const [subtabId, shared] of Object.entries(this.mirrorTerminals)) {
      const session = this.terminalSessions.get(subtabId);
      if (session?.adoptOnly && shared?.sessionId) {
        session.adopt(shared).catch((error) => this.reportError("Terminal mirror", error));
      }
    }
  }

  async initialize() {
    this.bindEvents();
    try {
      this.externalUnlisten = await this.backend.listenForCommands?.((command) => this.handleExternalCommand(command));
      this.openFilesUnlisten = await this.backend.listen?.("auri-open-files", () => {
        this.drainPendingOpenFiles().catch((error) => this.reportError("Open files", error));
      });
      this.wakeUnlisten = await this.backend.listen?.("auri-wake", (payload) => this.activateWakeSession(payload));
      this.webNavigationUnlisten = await this.backend.listen?.("auri-web-navigation", (payload) => this.handleWebNavigation(payload));
      this.webAiUnlisten = await this.backend.listen?.("auri-web-ai", (payload) => {
        this.handleWebAiAction(payload).catch((error) => this.reportError("Web AI", error));
      });
      this.webPopupErrorUnlisten = await this.backend.listen?.("auri-web-popup-error", (payload) => {
        this.reportError("Browser popup", payload?.message || payload || "The browser popup could not be opened.");
      });
      this.webProcessRecoveryUnlisten = await this.backend.listen?.("auri-web-process-recovered", (payload) => {
        const message = payload?.message || "Auri recovered a crashed website process.";
        this.dispatch({
          type: "INFO_ADD",
          payload: { level: "warning", title: "Website recovered", message }
        });
        this.view.showToast("Website recovered and reloaded", "info");
      });
      this.browserOverlayUnlisten = await this.backend.listen?.("auri-browser-overlay-action", (payload) => this.handleBrowserOverlayAction(payload));
      this.standaloneReturnUnlisten = await this.backend.listen?.("auri-tab-window-return", (payload) => {
        this.moveSubtabToMain(payload?.id, { closeWindow: false }).catch((error) => this.reportError("Tab window", error));
      });
      this.standaloneCloseUnlisten = await this.backend.listen?.("auri-tab-window-close", (payload) => {
        const id = String(payload?.id || "");
        if (id) this.runInternal(`subtab close ${id}`).catch((error) => this.reportError("Close tab", error));
      });
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
          for (const rule of Object.values(parsed.processPriorities || {})) {
            this.state = reduceState(this.state, { type: "SYSTEM_PROCESS_PRIORITY_SET", payload: rule });
          }
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
      if (this.backend.setVisibleOnAllWorkspaces) {
        try {
          await this.backend.setVisibleOnAllWorkspaces(this.state.settings.visibleOnAllWorkspaces);
        } catch (error) {
          this.state = reduceState(this.state, {
            type: "INFO_ADD",
            payload: { level: "warning", title: "Desktop visibility", message: error?.message || String(error) }
          });
        }
      }
      const root = initialized?.root || "~";
      if (!restoredWorkspaces) {
        this.state = reduceState(this.state, { type: "WORKDIR_SET", payload: { path: root } });
      }
      // A hosted web session mirrors the desktop window's workspaces before
      // the first render so the folder pane and terminals adopt shared state.
      if (this.backend.isHostedWeb) await this.setupMirrorMode();
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
      this.startFolderPolling();
      this.startProcessPriorityEnforcement();
      this.scheduleStateSync();
      await this.drainPendingOpenFiles();
    } catch (error) {
      this.reportError("Startup", error);
    }
  }

  bindEvents() {
    this.view.root.addEventListener("click", (event) => this.handleClick(event));
    this.view.root.addEventListener("dblclick", (event) => this.handleDoubleClick(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleLiveRecordPointerDown(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleMagicPointerDown(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleBrowserMenuPointerDown(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleFolderResizePointerDown(event));
    this.view.root.addEventListener("pointerdown", (event) => this.handleTopbarPointerDown(event));
    this.view.root.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.view.root.addEventListener("keyup", (event) => this.handleKeyup(event));
    this.view.root.addEventListener("beforeinput", (event) => this.handleBeforeInput(event));
    this.view.root.addEventListener("input", (event) => this.handleInput(event));
    this.view.root.addEventListener("change", (event) => this.handleChange(event));
    this.view.root.addEventListener("scroll", (event) => this.handleScroll(event), true);
    this.view.root.addEventListener("wheel", (event) => this.handleProcessPageWheel(event), { passive: false });
    this.view.root.addEventListener("submit", (event) => this.handleSubmit(event));
    window.addEventListener("keydown", (event) => this.handleGlobalKeydown(event));
    window.addEventListener("keyup", (event) => this.handleGlobalKeyup(event));
    window.addEventListener("pointerup", (event) => this.handleLiveRecordPointerEnd(event));
    window.addEventListener("pointercancel", (event) => this.handleLiveRecordPointerEnd(event));
    window.addEventListener("pointerup", (event) => this.handleMagicPointerEnd(event));
    window.addEventListener("pointercancel", (event) => this.handleMagicPointerEnd(event));
    window.addEventListener("pointermove", (event) => this.handleFolderResizePointerMove(event));
    window.addEventListener("pointerup", (event) => this.handleFolderResizePointerEnd(event));
    window.addEventListener("pointercancel", (event) => this.handleFolderResizePointerEnd(event));
    window.addEventListener("focus", () => {
      this.wakeLiveSession?.resume?.().catch?.(() => {});
      this.refreshMediaPermissions({ render: false }).catch?.(() => {});
    });
    window.addEventListener("focusin", (event) => {
      const zone = terminalFocusZone(event.target);
      if (zone) this.terminalFocusZone = zone;
    });
    if (typeof document !== "undefined") {
      document.addEventListener?.("visibilitychange", () => {
        if (!document.hidden) {
          this.wakeLiveSession?.resume?.().catch?.(() => {});
          this.refreshMediaPermissions({ render: false }).catch?.(() => {});
        }
      });
    }
    window.addEventListener("resize", () => {
      this.activeTerminalSession().resize?.();
      this.syncNativeWebview().catch((error) => this.reportError("Webview", error));
    });
    window.addEventListener("message", (event) => this.handleFileViewerMessage(event));
  }


  async handleDoubleClick(event) {
    const tab = event.target?.closest?.("[data-tab-id]");
    if (tab?.dataset?.tabId) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const id = tab.dataset.tabId;
      if (this.subtabMenuOpenedByClickId === id && Date.now() - this.subtabMenuOpenedByClickAt <= 700) {
        this.subtabMenuOpenedByClickId = null;
        this.subtabMenuOpenedByClickAt = 0;
        return true;
      }
      const wasOpen = this.state.ui.subtabActionMenuId === id;
      const placement = this.subtabActionMenuPlacement(tab);
      await this.selectSubtabFromClick(id);
      this.setSubtabActionMenu(wasOpen ? null : id, placement);
      return true;
    }
    const target = event.target?.closest?.('[data-action="file-entry"]');
    if (!target) return false;
    event.preventDefault?.();
    try {
      await this.openFolderEntry(target.dataset.path, target.dataset.kind, { forceOpen: true });
      return true;
    } catch (error) {
      this.view.showToast(error?.message || String(error), "error");
      return false;
    }
  }

  subtabActionMenuPlacement(tab) {
    const tabRect = tab?.getBoundingClientRect?.();
    const barRect = tab?.closest?.(".subtab-bar")?.getBoundingClientRect?.();
    return tabRect ? tabRect.left - (barRect?.left || 0) : 148;
  }

  setSubtabActionMenu(id, placement = 148) {
    this.dispatch({
      type: "UI_SET",
      payload: {
        subtabActionMenuId: id,
        subtabActionMenuX: placement,
        addSubtabMenuOpen: false,
        commandMenuOpen: false,
        webMenuOpen: false,
        webDialog: null
      }
    });
  }

  trackSubtabClick(id) {
    const now = Date.now();
    const repeated = this.subtabClickId === id && now - this.subtabClickAt <= 500;
    this.subtabClickId = repeated ? null : id;
    this.subtabClickAt = repeated ? 0 : now;
    return repeated;
  }

  handleBrowserMenuPointerDown(event) {
    const target = event.target?.closest?.('[data-action="web-menu"]');
    if (!target || event.button !== 0) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.webMenuSuppressClick = true;
    this.dispatch({
      type: "UI_SET",
      payload: { webMenuOpen: !this.state.ui.webMenuOpen, webDialog: null, addSubtabMenuOpen: false, commandMenuOpen: false }
    }, { preserveInput: true });
    return true;
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

  /// The webview magic button mirrors the terminal microphone: hold one
  /// second to talk with the Live API (screenshot attached), release to send.
  /// A short press falls through to the click handler, which opens the menu.
  async handleMagicPointerDown(event) {
    const target = event.target?.closest?.('[data-action="web-magic"]');
    if (!target || event.button !== 0 || this.magicPointerId !== null) return false;
    event.preventDefault?.();
    this.magicPointerId = event.pointerId;
    this.magicLongPress = false;
    this.magicStartPromise = null;
    clearTimeout(this.magicHoldTimer);
    target.setPointerCapture?.(event.pointerId);
    this.magicHoldTimer = setTimeout(() => {
      if (this.magicPointerId !== event.pointerId) return;
      this.magicLongPress = true;
      this.magicStartPromise = Promise.resolve(this.runInternal("live record start"))
        .then(() => true)
        .catch((error) => {
          this.view.showToast(error?.message || String(error), "error");
          return false;
        });
    }, 1000);
    return true;
  }

  async handleMagicPointerEnd(event) {
    if (this.magicPointerId === null || event.pointerId !== this.magicPointerId) return false;
    event.preventDefault?.();
    clearTimeout(this.magicHoldTimer);
    this.magicHoldTimer = null;
    const wasLongPress = this.magicLongPress;
    const startPromise = this.magicStartPromise;
    this.magicPointerId = null;
    this.magicLongPress = false;

    try {
      if (!wasLongPress) return false;
      this.magicSuppressClick = event.type !== "pointercancel";
      const started = await startPromise;
      if (started !== false) await this.runInternal("live record stop");
      return true;
    } catch (error) {
      this.view.showToast(error?.message || String(error), "error");
      return false;
    } finally {
      this.magicStartPromise = null;
    }
  }

  handleFolderResizePointerDown(event) {
    const target = event.target?.closest?.('[data-action="folder-resize"]');
    if (!target || event.button !== 0) return false;
    event.preventDefault?.();
    const pane = this.view.root.querySelector?.(".folder-pane");
    const startWidth = folderPaneWidth(pane?.getBoundingClientRect?.().width || this.state.settings.folderPaneWidth);
    this.folderResizeDrag = {
      pointerId: event.pointerId,
      startX: Number(event.clientX) || 0,
      startWidth,
      width: startWidth
    };
    target.setPointerCapture?.(event.pointerId);
    return true;
  }

  handleFolderResizePointerMove(event) {
    const drag = this.folderResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return false;
    event.preventDefault?.();
    const width = folderPaneWidth(drag.startWidth + ((Number(event.clientX) || 0) - drag.startX));
    if (width === drag.width) return true;
    drag.width = width;
    this.view.setFolderPaneWidth?.(width);
    this.activeTerminalSession().resize?.();
    this.syncNativeWebview().catch((error) => this.reportError("Webview", error));
    return true;
  }

  async handleFolderResizePointerEnd(event) {
    const drag = this.folderResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return false;
    event.preventDefault?.();
    this.folderResizeDrag = null;
    await this.runInternal(`settings set folderPaneWidth ${folderPaneWidth(drag.width)}`);
    return true;
  }

  handleTopbarPointerDown(event) {
    if (event.button !== 0 || !this.native) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element?.closest(".subtab-bar")) return;
    if (element.closest("button, input, textarea, select, a, [data-action]")) return;
    event.preventDefault();
    this.backend.startWindowDragging().catch((error) => this.reportError("Window drag", error));
  }



  systemTunnelPrompt(kind, port) {
    const number = Number(port);
    if (!Number.isInteger(number) || number <= 0) return Promise.resolve(false);
    const messages = {
      start: {
        title: `Enable HTTPS tunnel for port ${number}?`,
        message: `Start the helper for local port ${number} and show the generated HTTPS URL in this process detail.`,
        confirmLabel: "Enable tunnel"
      },
      install: {
        title: "Install helper?",
        message: "The tunnel helper is not installed in PATH or ~/.local/bin. Auri can install it to ~/.local/bin and continue.",
        confirmLabel: "Install and continue"
      },
      stop: {
        title: `Stop HTTPS tunnel for port ${number}?`,
        message: "Stop the helper process for this port and remove its URL from this process detail.",
        confirmLabel: "Stop tunnel"
      }
    };
    const prompt = { id: `system-tunnel-${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, port: number, ...(messages[kind] || messages.start) };
    if (this.systemTunnelPromptResolver) this.systemTunnelPromptResolver(false);
    return new Promise((resolve) => {
      this.systemTunnelPromptResolver = resolve;
      this.dispatch({ type: "UI_SET", payload: { systemTunnelPrompt: prompt } }, { preserveInput: true });
    });
  }

  resolveSystemTunnelPrompt(value) {
    const resolver = this.systemTunnelPromptResolver;
    this.systemTunnelPromptResolver = null;
    this.dispatch({ type: "UI_SET", payload: { systemTunnelPrompt: null } }, { preserveInput: true });
    resolver?.(Boolean(value));
  }

  async toggleSystemPortTunnel(port) {
    const number = Number(port);
    if (!Number.isInteger(number) || number <= 0) throw new Error("Choose a process port.");
    const existing = this.state.system?.tunnels?.[number];
    if (existing) {
      this.dispatch({ type: "SYSTEM_TUNNEL_PENDING_SET", payload: { port: number, status: "stopping" } }, { preserveInput: true });
      try {
        await this.runInternal(`system tunnel stop ${number}`);
      } catch (error) {
        this.dispatch({ type: "SYSTEM_TUNNEL_PENDING_REMOVE", payload: { port: number } }, { preserveInput: true });
        throw error;
      }
      return true;
    }

    // Cloudflare quick tunnels are built for HTTP(S). Warn (but still try) when
    // the port doesn't look like HTTP, so the person knows why it may not work.
    const protocol = protocolForPort(number);
    if (protocol !== "http" && protocol !== "https") {
      this.view.showToast?.("This port doesn't look like HTTP — Cloudflare tunnels only support HTTP(S). Trying anyway…", "info");
    }

    let installFlag = "";
    if (this.backend.cloudflaredStatus) {
      const status = await this.backend.cloudflaredStatus();
      if (!status?.available) {
        installFlag = " --install";
      }
    }

    this.dispatch({ type: "SYSTEM_TUNNEL_PENDING_SET", payload: { port: number, status: "starting" } }, { preserveInput: true });
    try {
      await this.runInternal(`system tunnel start ${number}${installFlag}`);
    } catch (error) {
      this.dispatch({ type: "SYSTEM_TUNNEL_PENDING_REMOVE", payload: { port: number } }, { preserveInput: true });
      throw error;
    }
    return true;
  }

  scrollProcessTableToTop() {
    this.scrollProcessTableToEdge("top");
  }

  async selectSubtabFromClick(id) {
    await this.runInternal(`subtab select ${id}`);
    if (activeSubtab(this.state).type === "info") this.dispatch({ type: "INFO_READ", payload: {} });
    if (activeSubtab(this.state).type === "settings") await this.runInternal("permission status");
    if (["system", "disk", "net"].includes(activeSubtab(this.state).type)) await this.runInternal("system refresh");
  }

  async handleClick(event) {
    const insideAssistantPopup = event.target?.closest?.(".assistant-action-popup");
    const insideProcessDetail = event.target?.closest?.(".system-process-detail");
    const insideSystemTunnelPrompt = event.target?.closest?.(".system-tunnel-prompt");
    const insideSystemKillPrompt = event.target?.closest?.(".system-kill-prompt");
    const insideSystemPriorityPrompt = event.target?.closest?.(".system-priority-prompt");
    const insideTunnelUrlMenu = event.target?.closest?.(".process-detail-port-url-menu, .process-detail-port-url");
    const insideCommandMenu = event.target?.closest?.(".command-menu-wrap");
    const insideSubtabActionMenu = event.target?.closest?.(".subtab-action-menu, .subtab-icon-menu");
    const target = event.target?.closest?.("[data-action]");
    if (hasAssistantActionPopup(this.state) && !insideAssistantPopup) {
      await this.runInternal("transcript dismiss");
    }
    if (this.state.ui.tunnelUrlMenuPort && !insideTunnelUrlMenu) {
      this.dispatch({ type: "UI_SET", payload: { tunnelUrlMenuPort: null } }, { preserveInput: true });
    }
    if (this.state.ui.commandMenuOpen && !insideCommandMenu) {
      this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: false } }, { preserveInput: true });
    }
    if (this.state.ui.subtabActionMenuId && !insideSubtabActionMenu) {
      this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } }, { preserveInput: true });
    }
    const insideClipboardInfo = event.target?.closest?.(".clipboard-info-popup");
    const clipboardInfoTrigger = event.target?.closest?.('[data-action="clipboard-info"], [data-action="clipboard-menu"]');
    if (this.state.ui.clipboardInfoId && !insideClipboardInfo && !clipboardInfoTrigger) {
      this.dispatch({ type: "UI_SET", payload: { clipboardInfoId: null } }, { preserveInput: true });
    }
    const action = target?.dataset?.action || "";
    if (this.state.system.selectedProcessPid && !insideProcessDetail && !insideSystemTunnelPrompt && !insideSystemKillPrompt && !insideSystemPriorityPrompt && !action.startsWith("system-tunnel-prompt-") && !action.startsWith("system-kill-prompt-") && !action.startsWith("system-priority-prompt-") && action !== "system-process-select") {
      await this.runInternal("system deselect");
    }
    if (!target) return;
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
          await this.refreshFolder({ focusTerminal: true });
          break;
        case "tab-select":
          await this.runInternal(`tab select ${target.dataset.id}`);
          await this.refreshFolder({ focusTerminal: true });
          break;
        case "tab-close":
          await this.runInternal(`tab close ${target.dataset.id || ""}`.trim());
          break;
        case "subtab-select": {
          const isDoubleClick = this.trackSubtabClick(target.dataset.id);
          const placement = isDoubleClick
            ? this.subtabActionMenuPlacement(target.closest?.("[data-tab-id]"))
            : 148;
          await this.selectSubtabFromClick(target.dataset.id);
          if (isDoubleClick) {
            event.stopPropagation?.();
            this.setSubtabActionMenu(target.dataset.id, placement);
            this.subtabMenuOpenedByClickId = target.dataset.id;
            this.subtabMenuOpenedByClickAt = Date.now();
          }
          break;
        }
        case "subtab-close":
          event.stopPropagation();
          await this.runInternal(`subtab close ${target.dataset.id}`);
          break;
        case "subtab-action-menu": {
          event.stopPropagation();
          const rect = target.getBoundingClientRect?.();
          const wasOpen = this.state.ui.subtabActionMenuId === target.dataset.id;
          await this.selectSubtabFromClick(target.dataset.id);
          this.dispatch({
            type: "UI_SET",
            payload: {
              subtabActionMenuId: wasOpen ? null : target.dataset.id,
              subtabActionMenuX: rect ? rect.left : 148,
              addSubtabMenuOpen: false,
              commandMenuOpen: false,
              webMenuOpen: false,
              webDialog: null
            }
          });
          break;
        }
        case "subtab-action-close":
          this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } });
          await this.runInternal(`subtab close ${target.dataset.id}`);
          break;
        case "subtab-action-reload":
          this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } });
          await this.runInternal(`subtab reload ${target.dataset.id}`);
          break;
        case "subtab-action-window":
          this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } });
          await this.runInternal(`subtab move-window ${target.dataset.id}`);
          break;
        case "subtab-action-main":
          this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } });
          await this.runInternal(`subtab move-main ${target.dataset.id}`);
          break;
        case "subtab-menu":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: !this.state.ui.addSubtabMenuOpen, commandMenuOpen: false, webMenuOpen: false, webDialog: null } });
          break;
        case "subtab-new":
          this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: false, webMenuOpen: false } });
          await this.runInternal(`subtab new ${target.dataset.type}`);
          if (["system", "disk", "net"].includes(activeSubtab(this.state).type)) await this.runInternal("system refresh");
          break;
        case "command-menu":
          this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: !this.state.ui.commandMenuOpen, addSubtabMenuOpen: false, webMenuOpen: false, webDialog: null } });
          break;
        case "command-menu-tab":
          this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: false } });
          await this.runInternal(`subtab select ${target.dataset.id}`);
          break;
        case "app-exit":
          this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: false } });
          await this.runInternal("app exit");
          break;
        case "system-tunnel-prompt-confirm":
          this.resolveSystemTunnelPrompt(true);
          break;
        case "system-tunnel-prompt-cancel":
          if (event.target.closest(".system-tunnel-prompt") && !event.target.closest("button")) {
            break;
          }
          this.resolveSystemTunnelPrompt(false);
          break;
        case "system-refresh":
          await this.runInternal("system refresh");
          break;
        case "system-gpus":
          await this.runInternal("system gpus");
          break;
        case "system-sort":
          await this.runInternal(`system sort ${target.dataset.sort || "cpu"}`);
          break;
        case "system-process-page-prev":
          this.turnSystemProcessPage(-1, { throttle: false });
          break;
        case "system-process-page-next":
          this.turnSystemProcessPage(1, { throttle: false });
          break;
        case "system-search-toggle": {
          const open = !this.state.ui.systemSearchOpen;
          this.dispatch({ type: "UI_SET", payload: { systemSearchOpen: open } }, { preserveInput: true });
          if (open) {
            this.view.root.querySelector?.("#system-search-input")?.focus?.();
          } else if (this.state.system.filter) {
            await this.runInternal("system search");
          }
          break;
        }
        case "system-search-clear":
          await this.runInternal("system search");
          this.view.root.querySelector?.("#system-search-input")?.focus?.();
          break;
        case "system-process-select":
          await this.runInternal(`system select ${target.dataset.pid || ""}`);
          break;
        case "system-process-priority": {
          const pid = this.state.system.selectedProcessPid;
          if (pid) await this.runInternal(`system priority ${pid} ${target.dataset.level || "normal"}`);
          break;
        }
        case "system-priority-prompt-confirm": {
          const prompt = this.state.ui.systemPriorityPrompt;
          if (prompt?.pid) await this.runInternal(`system priority-auth ${prompt.pid} ${prompt.level || "normal"} ${prompt.method || "sudo"}`);
          break;
        }
        case "system-priority-prompt-cancel":
          if (event.target.closest(".system-priority-prompt") && !event.target.closest("button")) break;
          this.dispatch({ type: "UI_SET", payload: { systemPriorityPrompt: null } }, { preserveInput: true });
          break;
        case "system-process-kill": {
          const pid = this.state.system.selectedProcessPid;
          if (!pid) break;
          const process = this.state.system.snapshot?.processes?.find((item) => Number(item.pid) === Number(pid));
          this.dispatch({ type: "UI_SET", payload: { systemKillPrompt: { pid, name: process?.name || "" } } }, { preserveInput: true });
          break;
        }
        case "system-kill-prompt-confirm": {
          const pid = this.state.ui.systemKillPrompt?.pid || this.state.system.selectedProcessPid || "";
          this.dispatch({ type: "UI_SET", payload: { systemKillPrompt: null } }, { preserveInput: true });
          if (pid) await this.runInternal(`system kill ${pid}`);
          break;
        }
        case "system-kill-prompt-cancel":
          if (event.target.closest(".system-kill-prompt") && !event.target.closest("button")) {
            break;
          }
          this.dispatch({ type: "UI_SET", payload: { systemKillPrompt: null } }, { preserveInput: true });
          break;
        case "system-process-open-path":
          await this.runInternal(`system open-path ${this.state.system.selectedProcessPid || ""}`);
          break;
        case "system-process-copy-value": {
          const value = target.dataset.value || "";
          if (value) await this.runInternal(`clipboard copy ${quoteArg(value)}`);
          break;
        }
        case "system-process-tunnel-toggle":
          await this.toggleSystemPortTunnel(target.dataset.port || "");
          break;
        case "system-process-tunnel-open": {
          const url = target.dataset.value || "";
          if (url) await this.openExternalUrl(url);
          break;
        }
        case "system-process-tunnel-url-menu-toggle": {
          const port = Number(target.dataset.port) || null;
          this.dispatch(
            { type: "UI_SET", payload: { tunnelUrlMenuPort: this.state.ui.tunnelUrlMenuPort === port ? null : port } },
            { preserveInput: true }
          );
          break;
        }
        case "system-process-tunnel-url-menu-open": {
          const url = target.dataset.value || "";
          this.dispatch({ type: "UI_SET", payload: { tunnelUrlMenuPort: null } }, { preserveInput: true });
          if (url) await this.openExternalUrl(url);
          break;
        }
        case "system-process-tunnel-url-menu-copy": {
          const value = target.dataset.value || "";
          this.dispatch({ type: "UI_SET", payload: { tunnelUrlMenuPort: null } }, { preserveInput: true });
          if (value) {
            await this.runInternal(`clipboard copy ${quoteArg(value)}`);
            this.view.showToast("Copied tunnel URL", "success");
          }
          break;
        }
        case "system-process-tunnel-copy-url": {
          const value = target.dataset.value || "";
          if (value) {
            await this.runInternal(`clipboard copy ${quoteArg(value)}`);
            this.view.showToast("Copied tunnel URL", "success");
          }
          break;
        }
        case "system-process-detail-close":
          await this.runInternal("system deselect");
          break;
        case "process-priority-settings-toggle":
          await this.runInternal("settings priority-rules toggle");
          break;
        case "process-priority-filter-toggle": {
          await this.runInternal("settings priority-rules search-toggle");
          if (this.state.ui.processPriorityFilterOpen) {
            this.view.root.querySelector?.("#process-priority-filter")?.focus?.();
          }
          break;
        }
        case "process-priority-suggestion": {
          const path = String(target.dataset.value || "");
          if (path) {
            await this.runInternal(`system priority-rule choose ${quoteArg(path)}`);
            this.view.root.querySelector?.("#process-priority-rule-identity")?.focus?.();
          }
          break;
        }
        case "process-priority-rule-remove": {
          const identity = String(target.dataset.identity || "");
          if (identity) {
            await this.runInternal(`system priority-rule remove ${quoteArg(identity)}`);
            this.view.showToast("Priority rule removed", "success");
          }
          break;
        }
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
          await this.runInternal("folder list");
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
        case "folder-toggle":
          this.cancelFolderPathNavigation();
          await this.runInternal(`folder toggle ${quoteArg(target.dataset.path || "")}`);
          break;
        case "file-entry":
          this.cancelFolderPathNavigation();
          {
            const rowAnchor = target.getBoundingClientRect?.();
            const folderPaneRect = this.view.root.querySelector?.(".folder-pane")?.getBoundingClientRect?.();
            await this.openFolderEntry(target.dataset.path, target.dataset.kind, {
              previewAnchor: folderPanePreviewAnchor(rowAnchor, folderPaneRect),
              previewDocument: target.ownerDocument || (typeof document !== "undefined" ? document : null),
              previewText: target.querySelector?.(".file-name")?.textContent?.trim()
            });
          }
          break;
        case "terminal-completion-select":
          this.flushTerminalCompletions();
          this.acceptTerminalCompletion(Number(target.dataset.index));
          break;
        case "custom-completions-save": {
          const value = this.view.getCustomCompletions?.() || "";
          await this.runInternal(`settings set customCompletions ${quoteArg(value)}`);
          this.view.showToast("Custom completions saved", "success");
          break;
        }
        case "web-ai-prompts-save": {
          const value = this.view.root.querySelector("#web-ai-prompts")?.value || "";
          await this.runInternal(`settings set webAiPrompts ${quoteArg(value)}`);
          this.view.showToast("Browser AI prompts saved", "success");
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
            payload: { clipboardPinnedOnly: !this.state.ui.clipboardPinnedOnly, clipboardMenuId: null, clipboardPage: 0 }
          }, { preserveInput: true });
          break;
        case "clipboard-page-prev":
        case "clipboard-page-next": {
          const pinnedOnly = Boolean(this.state.ui.clipboardPinnedOnly);
          const items = pinnedOnly ? this.state.clipboard.items.filter((item) => item.pinned) : this.state.clipboard.items;
          const maxPage = Math.max(0, Math.ceil(items.length / 50) - 1);
          const direction = action === "clipboard-page-next" ? 1 : -1;
          const clipboardPage = Math.min(maxPage, Math.max(0, (Number(this.state.ui.clipboardPage) || 0) + direction));
          this.dispatch({ type: "UI_SET", payload: { clipboardPage, clipboardMenuId: null } }, { preserveInput: true });
          break;
        }
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
        case "clipboard-copy-item":
          this.dispatch({ type: "UI_SET", payload: { clipboardMenuId: null } }, { preserveInput: true });
          await this.runInternal(`clipboard copy-item ${target.dataset.id}`);
          this.view.showToast("Copied to clipboard", "success");
          break;
        case "clipboard-copy-path":
          await this.runInternal(`clipboard copy ${quoteArg(target.dataset.value || "")}`);
          this.view.showToast("Copied", "success");
          break;
        case "clipboard-info":
          await this.runInternal(`clipboard info ${target.dataset.id}`);
          break;
        case "clipboard-info-close":
          this.dispatch({ type: "UI_SET", payload: { clipboardInfoId: null } }, { preserveInput: true });
          break;
        case "clipboard-edit":
          this.dispatch({ type: "UI_SET", payload: { clipboardMenuId: null, clipboardInfoId: null, clipboardEditId: target.dataset.id } }, { preserveInput: true });
          break;
        case "clipboard-edit-cancel":
          this.dispatch({ type: "UI_SET", payload: { clipboardEditId: null } }, { preserveInput: true });
          break;
        case "clipboard-edit-save": {
          const input = this.view.root.querySelector(`.clipboard-edit-input[data-id="${target.dataset.id}"]`);
          const text = input ? input.value : "";
          await this.runInternal(`clipboard edit ${target.dataset.id} ${quoteArg(text)}`);
          this.dispatch({ type: "UI_SET", payload: { clipboardEditId: null } }, { preserveInput: true });
          this.view.showToast("Clipboard item updated", "success");
          break;
        }
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
        case "web-magic":
          if (this.magicSuppressClick) {
            this.magicSuppressClick = false;
            break;
          }
          this.dispatch({
            type: "UI_SET",
            payload: { webMagicMenuOpen: !this.state.ui.webMagicMenuOpen, webMenuOpen: false, webDialog: null, addSubtabMenuOpen: false }
          }, { preserveInput: true });
          break;
        case "web-magic-close":
          this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
          break;
        case "web-magic-go":
          this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
          await this.runInternal(`web open ${quoteArg(this.view.getWebUrl())}`);
          break;
        case "web-magic-ask": {
          const question = String(this.view.getWebUrl?.() || "").trim();
          this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
          if (!question) throw new Error("Type a question in the URL bar first.");
          await this.runInternal(`web ask ${question}`);
          break;
        }
        case "web-ai-close":
          await this.runInternal("web ask-close");
          break;
        case "web-ai-copy": {
          const text = assistantPlainText(this.state.ui.webAiReply?.text || "").trim();
          if (!text) break;
          await this.runInternal(`clipboard copy ${quoteArg(text)}`);
          this.view.showToast("Copied", "success");
          break;
        }
        case "web-menu":
          if (this.webMenuSuppressClick) {
            this.webMenuSuppressClick = false;
            break;
          }
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
        case "file-attach-ai": {
          const path = target.dataset.path || activeWorkspace(this.state).viewer.path;
          if (!path) break;
          await this.runInternal(`attachment add ${quoteArg(path)}`);
          this.openSingletonSubtab("terminal");
          this.view.showToast("Added to prompt", "success");
          break;
        }
        case "file-serve":
          await this.runInternal(`file serve ${quoteArg(activeWorkspace(this.state).viewer.path || "")}`);
          break;
        case "record-pause":
          await this.runInternal("record pause");
          break;
        case "record-resume":
          await this.runInternal("record resume");
          break;
        case "record-photo":
          await this.runInternal("record photo");
          break;
        case "record-mode":
          await this.runInternal(`record mode ${target.dataset.mode}`);
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
    const keyTarget = event.target || {};
    const tagName = String(keyTarget.tagName || "").toLowerCase();
    const isEditing = Boolean(keyTarget.isContentEditable || ["input", "textarea", "select"].includes(tagName));
    const searchShortcut = this.isSystemMonitorActive()
      && !isEditing
      && !event.altKey
      && String(event.key || "").toLowerCase() === "f"
      && Boolean(event.metaKey || event.ctrlKey);
    const slashShortcut = this.isSystemMonitorActive()
      && !isEditing
      && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
      && event.key === "/";
    if (searchShortcut || slashShortcut) {
      event.preventDefault?.();
      if (!this.state.ui.systemSearchOpen) {
        this.dispatch({ type: "UI_SET", payload: { systemSearchOpen: true } }, { preserveInput: true });
      }
      this.view.root.querySelector?.("#system-search-input")?.focus?.();
      return;
    }
    if (keyTarget.id === "system-search-input" && event.key === "Escape") {
      event.preventDefault?.();
      this.dispatch({ type: "UI_SET", payload: { systemSearchOpen: false } }, { preserveInput: true });
      return;
    }
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
      if (noModifier && !event.isComposing && ["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) {
        this.flushTerminalCompletions();
      }
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
    if (event.key === "Escape" && this.state.ui.webMagicMenuOpen) {
      this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
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
      this.scheduleTerminalCompletions(input.value, input.selectionStart);
      return;
    }
    if (input.id === "system-search-input") {
      // Filter live without a full re-render so the field keeps focus/caret as
      // the person types multi-keyword queries; the list updates in place.
      this.dispatch({ type: "SYSTEM_FILTER_SET", payload: { filter: input.value } }, { render: false });
      this.view.patchSystemMonitor?.(this.state);
      this.scrollProcessTableToTop();
      return;
    }
    if (input.id === "custom-completions") {
      this.view.syncCustomCompletionLineNumbers?.(input.value);
      return;
    }
    if (input.id === "process-priority-rule-identity") {
      const query = String(input.value || "");
      this.dispatch({ type: "UI_SET", payload: { processPriorityDraft: query } }, { render: false });
      if (this.processPrioritySuggestionTimer) clearTimeout(this.processPrioritySuggestionTimer);
      this.processPrioritySuggestionTimer = null;
      if (query.trim().length <= 3) {
        if (this.state.ui.processPrioritySuggestions?.length) {
          this.dispatch({ type: "UI_SET", payload: { processPrioritySuggestions: [] } }, { preserveInput: true });
        }
        return;
      }
      this.processPrioritySuggestionTimer = setTimeout(() => {
        this.processPrioritySuggestionTimer = null;
        this.runInternal(`system priority-rule suggest ${quoteArg(query.trim())}`)
          .catch((error) => this.reportError("PATH command search", error));
      }, 150);
      return;
    }
    if (input.id === "process-priority-filter") {
      this.runInternal(`settings priority-rules filter ${quoteArg(input.value || "")}`)
        .catch((error) => this.reportError("Priority rule filter", error));
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

  turnSystemProcessPage(direction, { throttle = true } = {}) {
    const step = Number(direction) < 0 ? -1 : 1;
    const now = Date.now();
    if (throttle && now - this.systemProcessPageTurnAt < 250) return false;
    const before = Number(this.state.system.processPage) || 1;
    this.dispatch({ type: step < 0 ? "SYSTEM_PROCESS_PAGE_PREVIOUS" : "SYSTEM_PROCESS_PAGE_NEXT" }, { render: false });
    if ((Number(this.state.system.processPage) || 1) === before) return false;
    if (throttle) this.systemProcessPageTurnAt = now;
    const patched = this.view.patchSystemMonitor?.(this.state);
    if (patched === false) this.render({ preserveInput: true });
    this.scrollProcessTableToEdge(step < 0 ? "bottom" : "top");
    return true;
  }

  advanceSystemProcessPage() {
    return this.turnSystemProcessPage(1);
  }

  scrollProcessTableToEdge(edge = "top") {
    const table = this.view.root.querySelector?.(".process-table");
    if (!table) return;
    const top = edge === "bottom" ? Math.max(0, Number(table.scrollHeight || 0) - Number(table.clientHeight || 0)) : 0;
    if (typeof table.scrollTo === "function") table.scrollTo({ top, left: table.scrollLeft || 0, behavior: "auto" });
    else table.scrollTop = top;
    if (table.dataset) table.dataset.lastScrollTop = String(top);
  }

  handleScroll(event) {
    const target = event.target || {};
    if (target.id !== "custom-completions") {
      if (!target.classList?.contains?.("process-table")) return;
      const current = Number(target.scrollTop || 0);
      const previous = Number(target.dataset?.lastScrollTop ?? 0);
      if (target.dataset) target.dataset.lastScrollTop = String(current);
      const remaining = Number(target.scrollHeight || 0) - current - Number(target.clientHeight || 0);
      if (current < previous && current <= 48 && target.dataset?.hasPrevious === "true") {
        this.turnSystemProcessPage(-1);
      } else if (current > previous && remaining <= 48 && target.dataset?.hasNext === "true") {
        this.turnSystemProcessPage(1);
      }
      return;
    }
    this.view.syncCustomCompletionScroll?.(target);
  }

  handleProcessPageWheel(event) {
    const deltaY = Number(event?.deltaY);
    if (!deltaY) return false;
    const directTarget = event?.target || {};
    const table = directTarget.classList?.contains?.("process-table")
      ? directTarget
      : directTarget.closest?.(".process-table");
    if (!table) return false;
    const scrollTop = Number(table.scrollTop || 0);
    const remaining = Number(table.scrollHeight || 0) - scrollTop - Number(table.clientHeight || 0);
    const direction = deltaY < 0 ? -1 : 1;
    if (direction < 0) {
      if (table.dataset?.hasPrevious !== "true" || scrollTop > 48) return false;
    } else if (table.dataset?.hasNext !== "true" || remaining > 48) {
      return false;
    }
    if (!this.turnSystemProcessPage(direction)) return false;
    event.preventDefault?.();
    return true;
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
    if (input.id === "record-audio-device") {
      await this.runInternal(`record mic ${quoteArg(input.value || "default")}`).catch((error) => this.reportError("Microphone", error));
      return;
    }
    if (input.id === "record-video-device") {
      this.dispatch({ type: "MEDIA_SET", payload: { videoDeviceId: input.value === "default" ? null : input.value } }, { preserveInput: true });
      this.syncCameraPreview({ restart: true });
      return;
    }
    if (input.id === "record-source") {
      this.dispatch({ type: "MEDIA_SET", payload: { audioSource: input.value } }, { preserveInput: true });
      return;
    }
    if (input.dataset.key && input.type === "checkbox" && input.closest(".record-panel")) {
      this.dispatch({ type: "MEDIA_SET", payload: { [input.dataset.key]: input.checked } }, { preserveInput: true });
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
    if (event.target.id === "process-priority-rule-add" || event.target.classList?.contains?.("process-priority-rule-form")) {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      const identity = String(values.identity || "").trim();
      const nice = String(values.nice || "").trim();
      const originalIdentity = String(event.target.dataset.originalIdentity || "").trim();
      await this.runInternal(`system priority-rule set ${quoteArg(identity)} ${quoteArg(nice)}`);
      if (originalIdentity && originalIdentity !== identity) {
        await this.runInternal(`system priority-rule remove ${quoteArg(originalIdentity)}`);
      }
      this.view.showToast(originalIdentity ? "Priority rule saved" : "Priority rule added", "success");
      return;
    }
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
    // Holding Ctrl for two seconds while the screen compositor is running
    // flips auto zoom without interrupting the recording.
    if (event.key === "Control" && this.capture?.compositor && !this.zoomHoldTimer) {
      this.zoomHoldTimer = setTimeout(() => {
        this.zoomHoldTimer = null;
        if (!this.capture?.compositor) return;
        const autoZoom = !this.state.media.autoZoom;
        this.dispatch({ type: "MEDIA_SET", payload: { autoZoom } }, { preserveInput: true });
        this.view.showToast(autoZoom ? "Auto zoom to cursor on" : "Auto zoom to cursor off", "success");
      }, 2000);
    }
    const tabSwitch = tabSwitchFromKeyboardEvent(event);
    if (tabSwitch) {
      const target = tabSwitch.kind === "workspace"
        ? this.state.tabs[tabSwitch.index]
        : activeWorkspace(this.state).subtabs[tabSwitch.index];
      if (target) {
        event.preventDefault();
        await this.runInternal(`${tabSwitch.kind === "workspace" ? "tab" : "subtab"} select ${target.id}`);
        if (tabSwitch.kind === "workspace") await this.refreshFolder({ focusTerminal: true });
      }
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
    if (event.key === "Control" && this.zoomHoldTimer) {
      clearTimeout(this.zoomHoldTimer);
      this.zoomHoldTimer = null;
    }
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

      // Sessions started from a web tab keep the person on that tab and show
      // the reply in the floating panel; everything else uses the terminal.
      this.wakePresentation = activeSubtab(this.state)?.type === "webview" ? "web" : "terminal";
      this.finalizeWakeStream();
      if (this.wakePresentation === "web") {
        this.dispatch({
          type: "UI_SET",
          payload: {
            webAiReply: { status: "listening", prompt: "Voice input", modelName: model.name, text: "" },
            webMagicMenuOpen: false,
            assistantActions: [],
            assistantTranscripts: []
          }
        }, { preserveInput: true });
      } else {
        this.openSingletonSubtab("terminal");
        this.dispatch({ type: "UI_SET", payload: { assistantActions: [], assistantTranscripts: [] } }, { preserveInput: true });
        this.activeTerminalSession().printMessage("Voice", "Listening…", "33");
      }

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

    if (this.wakePresentation === "web") {
      const reply = this.state.ui.webAiReply || {};
      this.dispatch({
        type: "UI_SET",
        payload: {
          webAiReply: {
            status: "streaming",
            prompt: reply.prompt || "Voice input",
            modelName: model?.name || reply.modelName || "Gemini Live",
            text: next
          }
        }
      }, { preserveInput: true });
      return;
    }

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

    if (this.wakePresentation === "web") {
      const reply = this.state.ui.webAiReply || {};
      this.dispatch({
        type: "UI_SET",
        payload: {
          webAiReply: {
            status: "ready",
            prompt: reply.prompt || "Voice input",
            modelName: model?.name || reply.modelName || "Gemini Live",
            text,
            audioUrl
          }
        }
      }, { preserveInput: true });
      this.wakeStreamText = "";
      this.wakeStreamStarted = false;
      this.wakeStreamParser = null;
      return;
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
    const payload = { liveConnected: false, liveRecording: false, liveStatus: "error" };
    if (this.wakePresentation === "web") {
      const reply = this.state.ui.webAiReply || {};
      payload.webAiReply = {
        status: "error",
        prompt: reply.prompt || "Voice input",
        modelName: reply.modelName || "Gemini Live",
        text: error?.message || String(error)
      };
    }
    this.dispatch({ type: "UI_SET", payload }, { preserveInput: true });
    this.reportError("Gemini Live", error);
  }

  async openPendingFiles(paths = []) {
    const incoming = Array.isArray(paths)
      ? paths.map((path) => String(path || "")).filter(Boolean)
      : [];
    this.pendingOpenFiles.push(...incoming);
    if (!this.configurationReady) return [];

    const queued = this.pendingOpenFiles.splice(0);
    const opened = [];
    for (const path of queued) {
      try {
        await this.runInternal(`file open ${quoteArg(path)}`, { fileOpenMode: "new" });
        opened.push(path);
      } catch (error) {
        this.reportError("Open file", error);
      }
    }
    return opened;
  }

  async drainPendingOpenFiles() {
    this.pendingOpenFilesDrainRequested = true;
    if (this.pendingOpenFilesDrain) return this.pendingOpenFilesDrain;
    this.pendingOpenFilesDrain = (async () => {
      const opened = [];
      do {
        this.pendingOpenFilesDrainRequested = false;
        const paths = await this.backend.takePendingOpenFiles?.() || [];
        opened.push(...await this.openPendingFiles(paths));
      } while (this.pendingOpenFilesDrainRequested);
      return opened;
    })();
    try {
      return await this.pendingOpenFilesDrain;
    } finally {
      this.pendingOpenFilesDrain = null;
    }
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

  async selectSubtab(id) {
    const request = ++this.terminalSelectionRequest;
    const previousWorkspace = activeWorkspace(this.state);
    const previousTerminal = activeSubtab(this.state);
    if (previousTerminal?.type === "terminal") {
      const previousSession = this.terminalSessions.get(previousTerminal.id);
      try {
        await previousSession?.refreshCwd?.();
      } catch (error) {
        this.reportError("Terminal directory", error);
      }
      if (request !== this.terminalSelectionRequest) return false;
      const previousPath = previousSession?.cwd || previousTerminal.cwd;
      if (previousPath && previousPath !== previousTerminal.cwd) {
        this.dispatch({
          type: "TERMINAL_CWD_SET",
          payload: { workspaceId: previousWorkspace.id, terminalId: previousTerminal.id, path: previousPath }
        }, { preserveInput: true, render: false });
      }
    }

    if (request !== this.terminalSelectionRequest) return false;
    this.dispatch({ type: "SUBTAB_SELECT", payload: { id } }, { preserveInput: true });
    if (activeSubtab(this.state)?.type === "terminal") {
      await this.synchronizeActiveTerminalToFolder();
    }
    return true;
  }

  async runInternal(command, options = {}) {
    // A hosted web session hands mirrored-state commands to the desktop
    // window; the result arrives back as an app-state snapshot.
    if (this.backend.isHostedWeb && mirrorForwardsCommand(command)) {
      await this.backend.forwardCommand(command);
      return { forwarded: true };
    }
    return executeCommand(command, { ...this.context(), ...options });
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

  async handleTerminalCwdChange(workspaceId, terminalId, path) {
    const workspace = this.state.tabs.find((tab) => tab.id === workspaceId);
    const terminal = workspace?.subtabs.find((item) => item.id === terminalId);
    if (!workspace || !terminal || !path || path === terminal.cwd) return;
    if (workspace.activeSubtabId !== terminalId) {
      this.dispatch({
        type: "TERMINAL_CWD_SET",
        payload: { workspaceId, terminalId, path, mirrorWorkspace: false }
      }, { preserveInput: true, render: false });
      return;
    }
    await this.syncDirectory(path, workspaceId, terminalId);
  }

  async syncDirectory(path, workspaceId = this.state.activeTabId, terminalId = undefined) {
    const workspace = this.state.tabs.find((tab) => tab.id === workspaceId);
    const resolvedTerminalId = terminalId === undefined
      ? workspace?.subtabs.find((item) => item.type === "terminal")?.id || null
      : terminalId;
    const entries = await this.backend.listDirectory(path);
    const focusTerminal = workspaceId === this.state.activeTabId && activeSubtab(this.state)?.type === "terminal";
    // Apply both events in one pass so a directory change costs one render
    // (and one workspace persist) instead of two full DOM rebuilds.
    this.dispatch({ type: "FOLDER_PATH_SET", payload: { workspaceId, path } }, { preserveInput: true, focusTerminal, render: false });
    if (resolvedTerminalId) {
      this.dispatch({ type: "TERMINAL_CWD_SET", payload: { workspaceId, terminalId: resolvedTerminalId, path, mirrorWorkspace: true } }, { preserveInput: true, focusTerminal, render: false });
    }
    this.dispatch({ type: "FOLDER_ENTRIES_SET", payload: { workspaceId, entries } }, { preserveInput: true, focusTerminal });
  }

  async synchronizeActiveTerminalToFolder() {
    const workspace = activeWorkspace(this.state);
    const terminal = activeSubtab(this.state);
    if (terminal?.type !== "terminal") return false;
    const session = this.terminalSessionFor(terminal.id);
    try {
      await session.refreshCwd?.();
    } catch (error) {
      this.reportError("Terminal directory", error);
    }
    const latestWorkspace = activeWorkspace(this.state);
    const latestTerminal = activeSubtab(this.state);
    if (latestWorkspace?.id !== workspace.id || latestTerminal?.id !== terminal.id) return false;
    const path = session.cwd || latestTerminal.cwd || latestWorkspace.terminal.cwd;
    if (!path) return false;
    if (latestTerminal.cwd === path && latestWorkspace.folder.path === path) return false;
    await this.syncDirectory(path, latestWorkspace.id, latestTerminal.id);
    return true;
  }

  async changeDirectory(path, { echoInTerminal = false } = {}) {
    const workspace = activeWorkspace(this.state);
    const command = path === "~" ? "cd ~" : `cd ${shellQuote(path)}`;
    const result = await this.backend.runCommand(command, workspace.folder.path);
    if (result.code !== 0 || !result.cwd) throw new Error(result.stderr || `Could not open folder: ${path}`);
    const terminal = activeSubtab(this.state);
    if (terminal?.type !== "terminal") {
      await this.syncDirectory(result.cwd, workspace.id, null);
      return;
    }
    const session = this.terminalSessionFor(terminal.id);
    if (echoInTerminal && await session.isBusy?.()) {
      await this.runInternal("subtab new terminal");
      const newTerminal = activeSubtab(this.state);
      const newSession = this.terminalSessionFor(newTerminal.id);
      newSession.cwd = result.cwd;
      await this.syncDirectory(result.cwd, workspace.id, newTerminal.id);
      return;
    }
    if (echoInTerminal && this.native) await session.run(command);
    session.cwd = result.cwd;
    await this.syncDirectory(result.cwd, workspace.id, terminal.id);
  }

  async refreshFolder() {
    const workspaceId = this.state.activeTabId;
    const path = activeWorkspace(this.state).folder.path;
    const entries = await this.backend.listDirectory(path);
    const workspace = activeWorkspace(this.state);
    if (this.state.activeTabId !== workspaceId || workspace.folder.path !== path) return false;
    this.state = reduceState(this.state, { type: "FOLDER_ENTRIES_SET", payload: { workspaceId, entries } });
    this.view.patchFolderEntries?.(this.state, { replaceAll: true, addedPaths: [] });
    this.scheduleFolderHighlightExpiry();
    this.scheduleStateSync();
    return { entries };
  }

  showFolderEntryPreview(path, { previewAnchor, previewDocument, previewText } = {}) {
    const session = this.activeTerminalSession();
    this.folderPreviewPath = path;
    this.folderPreviewReturnSubtabId = activeWorkspace(this.state).activeSubtabId;
    session.showPreview?.({
      kind: "file",
      value: path,
      text: previewText || path.split(/[\\/]/u).filter(Boolean).at(-1) || path,
      source: "folder-pane"
    }, previewAnchor || { left: 0, right: 1, top: 0, bottom: 1 }, previewDocument || (typeof document !== "undefined" ? document : null));
  }

  async inspectFolderEntryInFloatingPreview(path, previewOptions) {
    await this.runInternal(`file inspect ${quoteArg(path)}`, { fileInspectMode: "floating" });
    this.showFolderEntryPreview(path, previewOptions);
  }

  async openFolderEntry(path, kind, { forceOpen = false, ...previewOptions } = {}) {
    const workspace = activeWorkspace(this.state);
    const repeat = workspace.folder.selectedPath === path;
    const previewSession = this.activeTerminalSession();
    // The preview's capture-phase outside-click listener removes its DOM node
    // before a repeated folder-row click reaches this handler. Keep the
    // controller-owned path as the interaction stage so that click still opens.
    const previewActive = repeat && this.folderPreviewPath === path;
    if (kind === "directory") {
      if (!forceOpen && !previewActive) {
        await this.inspectFolderEntryInFloatingPreview(path, previewOptions);
        return;
      }
      previewSession.dismissPreview?.();
      this.folderPreviewPath = null;
      await this.changeDirectory(path, { echoInTerminal: true });
      return;
    }
    const openTab = workspace.subtabs.find((item) => item.type === "webview" && item.filePath === path);
    if (!forceOpen && repeat && openTab) {
      const returnSubtabId = this.folderPreviewReturnSubtabId;
      await this.runInternal(`subtab close ${openTab.id}`);
      if (returnSubtabId && activeWorkspace(this.state).subtabs.some((item) => item.id === returnSubtabId)) {
        await this.runInternal(`subtab select ${returnSubtabId}`);
      }
      await this.inspectFolderEntryInFloatingPreview(path, previewOptions);
      return;
    }
    if (forceOpen && openTab) {
      await this.runInternal(`subtab select ${openTab.id}`);
      return;
    }
    if (!forceOpen && !previewActive) {
      await this.inspectFolderEntryInFloatingPreview(path, previewOptions);
      return;
    }
    previewSession.dismissPreview?.();
    await this.runInternal(`file open ${quoteArg(path)}`, { fileOpenMode: "new" });
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
      if (changed) {
        // Only the clipboard panel shows this data, so background polls keep
        // state current without rebuilding the DOM under other subtabs.
        if (activeSubtab(this.state)?.type === "clipboard") {
          this.dispatch({ type: "CLIPBOARD_SET", payload: { items } });
        } else {
          this.state = reduceState(this.state, { type: "CLIPBOARD_SET", payload: { items } });
        }
      }
    } finally {
      this.clipboardPolling = false;
    }
  }


  async persistConfiguration() {
    if (!this.backend.saveSettings) return;
    // The desktop window owns the saved configuration; a hosted web session
    // writing it too would race the owner with mirrored copies.
    if (this.backend.isHostedWeb) return;
    await this.backend.saveSettings({
      settings: this.state.settings,
      models: this.state.models,
      selectedModelId: this.state.selectedModelId,
      browser: this.state.browser,
      workspaceSession: serializeWorkspaceSession(this.state),
      processPriorities: this.state.system?.processPriorities || {}
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
    if (["subtab-action-reload", "subtab-action-window", "subtab-action-main", "subtab-action-close"].includes(action)) {
      const id = String(payload?.id || "");
      if (!id) return;
      this.dispatch({ type: "UI_SET", payload: { subtabActionMenuId: null } }, { preserveInput: true });
      const command = {
        "subtab-action-reload": `subtab reload ${id}`,
        "subtab-action-window": `subtab move-window ${id}`,
        "subtab-action-main": `subtab move-main ${id}`,
        "subtab-action-close": `subtab close ${id}`
      }[action];
      await this.runInternal(command);
      return;
    }
    if (action === "command-menu-tab") {
      const id = String(payload?.id || "");
      if (!id) return;
      this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: false } }, { preserveInput: true });
      await this.runInternal(`subtab select ${id}`);
      return;
    }
    if (action === "app-exit") {
      this.dispatch({ type: "UI_SET", payload: { commandMenuOpen: false } }, { preserveInput: true });
      await this.runInternal("app exit");
      return;
    }
    if (action === "web-dialog-close" || action === "web-menu-close") {
      this.dispatch({ type: "UI_SET", payload: { webDialog: null, webMenuOpen: false, bookmarkDraft: null } }, { preserveInput: true });
      return;
    }
    if (action === "subtab-new") {
      const type = String(payload?.type || "");
      if (!type) return;
      this.dispatch({ type: "UI_SET", payload: { addSubtabMenuOpen: false, webMenuOpen: false } }, { preserveInput: true });
      await this.runInternal(`subtab new ${type}`);
      if (["system", "disk", "net"].includes(type)) await this.runInternal("system refresh");
      return;
    }
    if (action === "web-magic-close") {
      this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
      return;
    }
    if (action === "web-magic-go") {
      this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
      await this.runInternal(`web open ${quoteArg(this.view.getWebUrl())}`);
      return;
    }
    if (action === "web-magic-ask") {
      const question = String(this.view.getWebUrl?.() || "").trim();
      this.dispatch({ type: "UI_SET", payload: { webMagicMenuOpen: false } }, { preserveInput: true });
      if (!question) {
        this.view.showToast("Type a question in the URL bar first.", "info");
        return;
      }
      await this.runInternal(`web ask ${question}`);
      return;
    }
    if (action === "web-ai-close") {
      await this.runInternal("web ask-close");
      return;
    }
    if (action === "web-ai-copy" || action === "copy-text") {
      const text = action === "copy-text"
        ? String(payload?.value || "")
        : assistantPlainText(this.state.ui.webAiReply?.text || "").trim();
      if (!text) return;
      await this.runInternal(`clipboard copy ${quoteArg(text)}`);
      this.view.showToast("Copied", "success");
      return;
    }
    if (action === "assistant-insert") {
      await this.runInternal(`input insert ${quoteArg(payload?.value || "")}`);
      return;
    }
    if (action === "assistant-run") {
      const command = String(payload?.value || "");
      if (command) await this.runInternal(`terminal run ${command}`);
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
      "web-reload": "web reload",
      "web-back": "web back",
      "web-forward": "web forward",
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
    const webview = this.state.tabs.flatMap((tab) => tab.subtabs).find((item) => item.id === id && item.type === "webview");
    if (!webview) return;
    this.nativeWebviewUrls.set(id, url);
    if (webview.filePath) return;
    const title = titleForWebUrl(url);
    const active = activeSubtab(this.state);
    if (active.id === id) {
      this.dispatch({ type: "SUBTAB_UPDATE", payload: { id, patch: { url, title } } }, { preserveInput: true });
    }
    this.dispatch({ type: "BROWSER_HISTORY_ADD", payload: { url, title, at: new Date().toISOString() } }, { preserveInput: true });
    await this.persistConfiguration();
  }

  async handleWebAiAction(payload) {
    const action = String(payload?.action || "");
    const item = webAiMenuItems(this.state.settings.webAiPrompts).find((entry) => entry.id === action);
    if (!item) return;
    if (item.speak) {
      const model = this.state.models.find((entry) => entry.id === this.state.selectedModelId);
      if (!model || !String(model.type || "").includes("live")) {
        this.view.showToast("Speech uses a Gemini Live model — select one in Settings.", "info");
        return;
      }
    }
    if (payload?.kind === "image" && payload.image && typeof atob === "function") {
      try {
        const binary = atob(String(payload.image));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const blob = new Blob([bytes], { type: "image/png" });
        this.dispatch({
          type: "ATTACHMENT_ADD",
          payload: {
            id: `attachment-${Date.now()}`,
            name: "web-image.png",
            kind: "image",
            mime: "image/png",
            blob,
            url: typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : null
          }
        }, { preserveInput: true });
      } catch {
        // A malformed image payload falls back to the text-only prompt.
      }
    }
    const prompt = webAiPrompt(item, payload || {});
    if (!prompt) return;
    // The reply appears in a floating panel over the current web tab; the
    // user explicitly stays where they are instead of jumping to the terminal.
    await this.runInternal(`web ask ${prompt}`);
  }

  async handleFileViewerMessage(event) {
    const data = event?.data || {};
    if (data.source !== "auri-file-viewer") return false;
    const path = String(data.path || "");
    const targetOrigin = event.origin || "*";
    const post = (message) => event.source?.postMessage?.({ source: "auri-host", ...message }, targetOrigin);
    if (!path) return false;

    if (data.type === "save-text") {
      try {
        const result = await this.backend.writeTextFile(path, String(data.content ?? ""));
        post({ type: "save-result", ok: true, path });
        this.view.showToast?.(`Saved ${path.split("/").pop() || "file"}`, "success");
        return result || true;
      } catch (error) {
        post({ type: "save-result", ok: false, path, error: error?.message || String(error) });
        this.reportError("File save", error);
        return false;
      }
    }

    if (data.type === "open-as-text") {
      try {
        const fileView = await this.openFileInWebview(path, { name: path.split("/").pop() || "Text" }, { asText: true });
        const current = activeSubtab(this.state);
        if (current.type === "webview") {
          this.dispatch({
            type: "SUBTAB_UPDATE",
            payload: {
              id: current.id,
              patch: {
                url: fileView.url,
                title: fileView.title || path.split("/").pop() || "Text",
                filePath: fileView.filePath || path,
                fileMime: fileView.mime || "text/html"
              }
            }
          }, { preserveInput: true });
        }
        post({ type: "open-as-text-result", ok: true, path });
        return fileView;
      } catch (error) {
        post({ type: "open-as-text-result", ok: false, path, error: error?.message || String(error) });
        this.reportError("Open as text", error);
        return false;
      }
    }

    if (data.type === "convert-media") {
      const id = String(data.id || "");
      post({ type: "convert-started", id, path });
      try {
        const result = await this.backend.convertMediaFile({
          path,
          format: String(data.format || ""),
          bitrateKbps: Number(data.bitrateKbps) || 128,
          sampleRate: data.sampleRate || null,
          resolution: data.resolution || "native"
        });
        post({ type: "convert-result", id, ok: true, path, result });
        return result;
      } catch (error) {
        post({ type: "convert-result", id, ok: false, path, error: error?.message || String(error) });
        this.reportError("Media conversion", error);
        return false;
      }
    }

    if (data.type === "save-converted-media") {
      const id = String(data.id || "");
      try {
        const result = await this.backend.saveConvertedMediaFile({
          sourcePath: path,
          tempPath: String(data.tempPath || ""),
          name: String(data.name || "")
        });
        post({ type: "save-converted-result", id, ok: true, path, result });
        await this.refreshFolder().catch(() => {});
        this.view.showToast?.(`Saved ${result.name || "media"}`, "success");
        return result;
      } catch (error) {
        post({ type: "save-converted-result", id, ok: false, path, error: error?.message || String(error) });
        this.reportError("Media save", error);
        return false;
      }
    }

    return false;
  }

  browserOverlayPayload(subtab) {
    if (this.state.ui.subtabActionMenuId) {
      const item = activeWorkspace(this.state).subtabs.find((candidate) => candidate.id === this.state.ui.subtabActionMenuId);
      if (item) {
        return {
          mode: "subtab-actions",
          id: item.id,
          title: item.title,
          standalone: Boolean(item.standalone)
        };
      }
    }
    if (this.state.ui.commandMenuOpen) {
      const workspace = activeWorkspace(this.state);
      return {
        mode: "command-menu",
        activeId: workspace.activeSubtabId,
        tabs: workspace.subtabs.map((item) => ({ id: item.id, title: item.title, type: item.type }))
      };
    }
    if (this.state.ui.addSubtabMenuOpen) {
      return { mode: "new-tab" };
    }
    if (this.state.ui.webMagicMenuOpen) {
      return { mode: "magic" };
    }
    if (this.state.ui.webMenuOpen) {
      return { mode: "menu", zoom: `${Math.round((Number(subtab.zoom) || 1) * 100)}%` };
    }
    const mode = this.state.ui.webDialog;
    if (mode) {
      return {
        mode,
        bookmarkDraft: this.state.ui.bookmarkDraft,
        bookmarks: this.state.browser.bookmarks,
        history: this.state.browser.history
      };
    }
    const reply = this.state.ui.webAiReply;
    if (reply) {
      return {
        mode: "ai-reply",
        reply: {
          status: reply.status,
          prompt: reply.prompt || "",
          modelName: reply.modelName || "AI",
          hasAudio: Boolean(reply.audioUrl),
          plainText: assistantPlainText(reply.text || ""),
          segments: parseAssistantReply(reply.text || "").segments
        }
      };
    }
    const toast = this.state.ui.webToast;
    if (toast) {
      return { mode: "toast", message: String(toast.message || ""), level: toast.level || "info" };
    }
    return null;
  }

  browserOverlayBounds(hostRect) {
    const viewportWidth = typeof window !== "undefined" && Number(window.innerWidth)
      ? Number(window.innerWidth)
      : hostRect.left + hostRect.width;
    const viewportHeight = typeof window !== "undefined" && Number(window.innerHeight)
      ? Number(window.innerHeight)
      : hostRect.top + hostRect.height;
    if (this.state.ui.subtabActionMenuId) {
      const tab = this.view.root.querySelector?.(`[data-tab-id="${this.state.ui.subtabActionMenuId}"]`);
      const tabRect = tab?.getBoundingClientRect?.() || { left: this.state.ui.subtabActionMenuX || 148, bottom: hostRect.top };
      const width = 250;
      const height = 150;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(tabRect.left || 0))),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(tabRect.bottom || hostRect.top) + 6)),
        width,
        height
      };
    }
    if (this.state.ui.commandMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="command-menu"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 8, bottom: hostRect.top };
      const width = 260;
      const tabCount = activeWorkspace(this.state).subtabs.length;
      const height = Math.min(420, Math.max(150, 76 + tabCount * 42));
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || hostRect.top) + 6)),
        width,
        height
      };
    }
    if (this.state.ui.addSubtabMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="subtab-menu"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 56, bottom: 56 };
      const width = 220;
      const height = 420;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || 56) + 6)),
        width,
        height
      };
    }
    if (this.state.ui.webMagicMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="web-magic"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 48, bottom: hostRect.top };
      const width = 240;
      const height = 170;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || hostRect.top) + 6)),
        width,
        height
      };
    }
    if (this.state.ui.webMenuOpen) {
      const button = this.view.root.querySelector?.('[data-action="web-menu"]');
      const buttonRect = button?.getBoundingClientRect?.() || { right: viewportWidth - 8, bottom: hostRect.top };
      const width = 260;
      const height = 500;
      return {
        x: Math.max(8, Math.min(viewportWidth - width - 8, Number(buttonRect.right || viewportWidth) - width)),
        y: Math.max(8, Math.min(viewportHeight - height - 8, Number(buttonRect.bottom || hostRect.top) + 6)),
        width,
        height
      };
    }
    if (!this.state.ui.webDialog && !this.state.ui.webAiReply && this.state.ui.webToast) {
      const width = Math.min(390, Math.max(220, hostRect.width - 24));
      const height = 56;
      return {
        x: Math.max(8, hostRect.left + hostRect.width - width - 16),
        y: Math.max(8, hostRect.top + hostRect.height - height - 16),
        width,
        height
      };
    }
    if (!this.state.ui.webDialog && this.state.ui.webAiReply) {
      const width = Math.min(460, Math.max(280, hostRect.width - 24));
      const height = Math.min(430, Math.max(220, hostRect.height - 24));
      return {
        x: Math.max(8, hostRect.left + hostRect.width - width - 12),
        y: Math.max(8, hostRect.top + 12),
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
      if (this.nativeBrowserOverlayKey !== null) {
        this.nativeBrowserOverlayKey = null;
        await this.backend.hideBrowserOverlay?.();
      }
      return;
    }
    if (!this.backend.showBrowserOverlay) return;
    const bounds = this.browserOverlayBounds(hostRect);
    const cachePayload = payload.mode === "menu" ? { ...payload, zoom: null } : payload;
    const key = JSON.stringify([cachePayload, bounds]);
    if (key === this.nativeBrowserOverlayKey) return;
    this.nativeBrowserOverlayKey = key;
    try {
      // Toasts are passive notices; taking focus would interrupt typing in
      // the website underneath.
      await this.backend.showBrowserOverlay(payload, bounds, payload.mode !== "toast");
    } catch (error) {
      if (this.nativeBrowserOverlayKey === key) this.nativeBrowserOverlayKey = null;
      throw error;
    }
  }

  async syncNativeWebview() {
    if (!this.native) return;
    const subtab = activeSubtab(this.state);
    const host = this.view.root.querySelector?.("#native-webview-host");
    if (subtab.type !== "webview" || subtab.standalone || !host) {
      if (this.nativeBrowserOverlayKey !== null) {
        this.nativeBrowserOverlayKey = null;
        await this.backend.hideBrowserOverlay?.();
      }
      await this.backend.hideWebviews?.();
      this.nativeWebviewShownId = null;
      this.updateWebviewSleepSchedule();
      return;
    }
    this.cancelWebviewSleep(subtab.id);
    const slept = this.sleptWebviews.get(subtab.id);
    let restoredUrl = null;
    if (slept) {
      let persisted = null;
      try {
        persisted = await this.backend.wakeWebview?.(subtab.id);
      } catch {
        // The in-memory record still restores the tab if the disk read fails.
      }
      restoredUrl = persisted?.url || slept.url || null;
    }
    const rect = this.nativeWebviewBounds(host);
    const url = restoredUrl || subtab.url || "https://www.google.com/";
    const navigate = this.nativeWebviewUrls.get(subtab.id) !== url;
    const layout = [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(Number(value) || 0)).join(":");
    const needsShow = navigate
      || this.nativeWebviewShownId !== subtab.id
      || this.nativeWebviewLayouts.get(subtab.id) !== layout;
    if (this.backend.showWebview && needsShow) {
      await this.backend.showWebview(subtab.id, url, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      }, navigate, webAiMenuPayload(this.state.settings.webAiPrompts));
      this.nativeWebviewUrls.set(subtab.id, url);
      this.nativeWebviewLayouts.set(subtab.id, layout);
      this.nativeWebviewShownId = subtab.id;
      if (slept) await this.finishWebviewRestore(subtab, restoredUrl);
    }
    await this.syncBrowserOverlay(subtab, rect);
    this.updateWebviewSleepSchedule();
  }

  async finishWebviewRestore(subtab, restoredUrl) {
    this.sleptWebviews.delete(subtab.id);
    if (restoredUrl && restoredUrl !== subtab.url && !subtab.filePath) {
      this.state = reduceState(this.state, { type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { url: restoredUrl } } });
    }
    const zoom = Number(subtab.zoom) || 1;
    if (zoom !== 1) {
      try {
        await this.backend.webviewAction?.(subtab.id, "zoom", zoom);
      } catch {
        // The restored page still works at the default zoom.
      }
    }
    // render: false because the caller's overlay sync picks the toast up in
    // this same pass.
    this.showWebTabToast(`"${subtab.title || "Web tab"}" restored from disk`, "success", { render: false });
  }

  /// The DOM toast sits underneath the native website view, so web tab
  /// notices also render through the native browser overlay whenever a
  /// website is covering the UI.
  showWebTabToast(message, level, { render = true } = {}) {
    this.view.showToast(message, level);
    const active = activeSubtab(this.state);
    if (this.native && active?.type === "webview" && !active.standalone) {
      this.setWebToast(message, level, { render });
    }
  }

  setWebToast(message, level, { render = true } = {}) {
    if (this.webToastTimer) clearTimeout(this.webToastTimer);
    const event = { type: "UI_SET", payload: { webToast: { message, level } } };
    if (render) this.dispatch(event, { preserveInput: true });
    else this.state = reduceState(this.state, event);
    this.webToastTimer = setTimeout(() => this.clearWebToast(), 2600);
    this.webToastTimer.unref?.();
  }

  clearWebToast() {
    if (this.webToastTimer) {
      clearTimeout(this.webToastTimer);
      this.webToastTimer = null;
    }
    if (!this.state.ui.webToast) return;
    this.dispatch({ type: "UI_SET", payload: { webToast: null } }, { preserveInput: true });
  }

  forgetNativeWebview(id) {
    this.cancelWebviewSleep(id);
    this.sleptWebviews.delete(id);
    this.nativeWebviewUrls.delete(id);
    this.nativeWebviewLayouts.delete(id);
    if (this.nativeWebviewShownId === id) this.nativeWebviewShownId = null;
  }

  cancelWebviewSleep(id) {
    const timer = this.webviewSleepTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.webviewSleepTimers.delete(id);
  }

  updateWebviewSleepSchedule() {
    if (!this.native || !this.backend.sleepWebview) return;
    const active = activeSubtab(this.state);
    const visibleId = active?.type === "webview" && !active.standalone ? active.id : null;
    const subtabs = new Map(this.state.tabs.flatMap((tab) => tab.subtabs).map((item) => [item.id, item]));
    for (const id of this.nativeWebviewUrls.keys()) {
      const subtab = subtabs.get(id);
      // File viewer tabs can hold unsaved editor state, so they never sleep.
      const eligible = subtab && subtab.type === "webview" && !subtab.standalone && !subtab.filePath && id !== visibleId;
      if (!eligible) {
        this.cancelWebviewSleep(id);
        continue;
      }
      if (this.webviewSleepTimers.has(id)) continue;
      const timer = setTimeout(() => {
        this.webviewSleepTimers.delete(id);
        this.sleepWebview(id).catch((error) => this.reportError("Web tab sleep", error));
      }, this.webviewSleepDelayMs);
      timer.unref?.();
      this.webviewSleepTimers.set(id, timer);
    }
  }

  async sleepWebview(id) {
    this.cancelWebviewSleep(id);
    const subtab = this.state.tabs.flatMap((tab) => tab.subtabs).find((item) => item.id === id);
    if (!subtab || subtab.type !== "webview" || subtab.standalone || subtab.filePath) return false;
    if (activeSubtab(this.state)?.id === id || !this.nativeWebviewUrls.has(id)) return false;
    const fallbackUrl = this.nativeWebviewUrls.get(id) || subtab.url || "";
    const saved = await this.backend.sleepWebview?.(id, fallbackUrl);
    if (!saved?.url) return false;
    this.nativeWebviewUrls.delete(id);
    this.nativeWebviewLayouts.delete(id);
    if (this.nativeWebviewShownId === id) this.nativeWebviewShownId = null;
    this.sleptWebviews.set(id, { url: saved.url, sleptAt: saved.sleptAtMs || Date.now() });
    if (saved.url !== subtab.url) {
      this.state = reduceState(this.state, { type: "SUBTAB_UPDATE", payload: { id, patch: { url: saved.url } } });
    }
    this.showWebTabToast(`"${subtab.title || "Web tab"}" slept to disk to free memory`, "info");
    return true;
  }

  nativeWebviewBounds(host) {
    const hostRect = host.getBoundingClientRect();
    const frameRect = host.closest?.(".web-frame-wrap")?.getBoundingClientRect?.();
    if (frameRect && frameRect.width > 0 && frameRect.height > 0) {
      return frameRect;
    }
    return hostRect;
  }

  async runWebviewAction(action, value = null) {
    const subtab = activeSubtab(this.state);
    if (subtab.type !== "webview") throw new Error("Open a web or file viewer tab first.");
    await this.backend.webviewAction(subtab.id, action, value);
  }

  subtabById(id) {
    return activeWorkspace(this.state).subtabs.find((item) => item.id === id) || null;
  }

  async reloadSubtab(id) {
    const subtab = this.subtabById(id);
    if (!subtab) throw new Error("Tab not found.");
    if (subtab.standalone) {
      await this.backend.closeStandaloneTab?.(subtab.id);
      await this.backend.showStandaloneTab?.(subtab.id, subtab.url, subtab.title || "Auri");
      return;
    }
    if (subtab.type === "webview" && this.native) {
      if (activeWorkspace(this.state).activeSubtabId !== subtab.id) await this.selectSubtab(subtab.id);
      await this.backend.hideBrowserOverlay?.();
      this.nativeBrowserOverlayKey = null;
      await this.backend.closeWebview?.(subtab.id);
      this.forgetNativeWebview(subtab.id);
      await this.syncNativeWebview();
      return;
    }
    if (["system", "disk", "net"].includes(subtab.type)) {
      if (activeWorkspace(this.state).activeSubtabId !== subtab.id) await this.selectSubtab(subtab.id);
      await this.runInternal("system refresh");
      return;
    }
    this.dispatch({ type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { reloadToken: Date.now() } } }, { preserveInput: true });
  }

  async moveSubtabToWindow(id) {
    const subtab = this.subtabById(id);
    if (!subtab) throw new Error("Tab not found.");
    if (subtab.type !== "webview" || !subtab.url) throw new Error("Standalone windows currently support web and file-viewer tabs.");
    if (!this.backend.showStandaloneTab) throw new Error("Standalone tab windows need the native Auri build.");
    await this.backend.showStandaloneTab(subtab.id, subtab.url, subtab.title || "Auri");
    // The standalone window has its own webview; keeping the embedded one
    // alive would hold a hidden WebKit content process for no reason.
    await this.backend.closeWebview?.(subtab.id);
    this.forgetNativeWebview(subtab.id);
    this.dispatch({ type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { standalone: true } } }, { preserveInput: true });
  }

  async moveSubtabToMain(id, { closeWindow = true } = {}) {
    const subtab = this.subtabById(id);
    if (!subtab) return false;
    if (closeWindow) await this.backend.closeStandaloneTab?.(subtab.id);
    this.dispatch({ type: "SUBTAB_UPDATE", payload: { id: subtab.id, patch: { standalone: false } } }, { preserveInput: true });
    await this.selectSubtab(subtab.id);
    return true;
  }

  async runWebviewZoom(direction) {
    const subtab = activeSubtab(this.state);
    if (subtab.type !== "webview") throw new Error("Open a web or file viewer tab first.");
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

  async prepareTerminalPreview(target) {
    if (target?.kind === "url") {
      const parsed = new URL(target.value);
      return { ...target, url: parsed.href, title: parsed.hostname || "Website", viewerKind: "web" };
    }
    if (target?.kind !== "file" || !target.value) throw new Error("Choose a file path or web URL.");
    const metadata = await this.backend.inspectFile(target.value);
    const fileView = await this.backend.createFileView(target.value, metadata, { autoplay: true });
    return { ...target, ...fileView, size: metadata.size, title: fileView.title || metadata.name || target.text, viewerKind: fileView.viewerKind || metadata.kind || "file" };
  }

  async openTerminalPreview(target) {
    if (target?.kind === "url") {
      await this.runInternal("subtab new webview");
      await this.runInternal(`web open ${quoteArg(target.value)}`);
      return;
    }
    if (target?.kind === "file") {
      const metadata = await this.backend.inspectFile(target.value);
      if (metadata?.kind === "directory") {
        await this.runInternal(`folder cd ${quoteArg(target.value)}`);
        return;
      }
      await this.runInternal(`file open ${quoteArg(target.value)}`, { fileOpenMode: "new" });
      return;
    }
    throw new Error("Choose a file path or web URL.");
  }

  async openFileInWebview(path, metadata, options = {}) {
    if (this.fileViewUrl) this.backend.releaseFileView?.(this.fileViewUrl);
    const fileView = await this.backend.createFileView(path, metadata, options);
    this.fileViewUrl = fileView.url;
    return fileView;
  }

  async openExternal(path) {
    if (!path) return;
    if (this.backend.isNative) await this.backend.call("open_external", { path });
    else this.view.showToast("External file opening needs the native build.", "info");
  }

  async openExternalUrl(url) {
    if (!url) return;
    if (this.backend.isNative && this.backend.openExternalUrl) {
      await this.backend.openExternalUrl(url);
      return;
    }
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    this.view.showToast("External browser opening needs the native build.", "info");
  }

  async startRecording(kind) {
    const media = this.state.media;
    const source = kind === "audio"
      ? (media.audioSource === "screen-audio" ? "screen-audio" : "microphone")
      : media.mode === "screen" ? "screen" : "camera";
    const includeMicrophone = Boolean(media.includeMicrophone);
    const needsMicrophone = source === "microphone" || source === "camera" || (source === "screen" && includeMicrophone);
    const needsScreenRecording = source === "screen" || source === "screen-audio";
    if (needsMicrophone) await this.ensureMediaPermission("microphone");
    if (needsScreenRecording) await this.ensureMediaPermission("screenRecording");
    this.stopCameraPreview();
    await this.capture.start({
      kind,
      source,
      includeMicrophone,
      audioDeviceId: media.audioDeviceId,
      videoDeviceId: media.videoDeviceId,
      effects: source === "screen"
        ? {
            autoZoom: Boolean(media.autoZoom),
            cameraBubble: Boolean(media.cameraBubble),
            zoomLevel: 1.9,
            getCursor: this.screenCursorProvider(),
            // Read live so holding Ctrl (auto zoom) or flipping the setting
            // (cursor circle) takes effect mid-recording.
            getAutoZoom: () => Boolean(this.state.media.autoZoom),
            getCursorHighlight: () => Boolean(this.state.settings.cursorHighlight)
          }
        : null,
      onReady: (result) => this.finishRecording(result)
    });
    this.dispatch({ type: "MEDIA_SET", payload: { status: "recording", kind, paused: false, previewUrl: null, fileName: null } });
  }

  /// Global cursor position mapped into captured-screen pixels, used by the
  /// screen recorder's Screen-Studio style auto zoom.
  screenCursorProvider() {
    const tauriWindow = typeof window !== "undefined" ? window.__TAURI__?.window : null;
    if (!tauriWindow?.cursorPosition) return () => null;
    let latest = null;
    let pending = false;
    return () => {
      if (!pending) {
        pending = true;
        Promise.resolve(tauriWindow.cursorPosition())
          .then((position) => { latest = { x: position.x, y: position.y }; })
          .catch(() => {})
          .finally(() => { pending = false; });
      }
      return latest;
    };
  }

  async capturePhoto() {
    const preview = this.view.root.querySelector?.("#camera-preview");
    const result = await this.capture.capturePhoto({
      videoDeviceId: this.state.media.videoDeviceId,
      previewElement: preview,
      mirror: Boolean(this.state.media.mirror)
    });
    try {
      const saved = await this.backend.saveMedia({ name: result.fileName, kind: "image", blob: result.blob });
      this.dispatch({ type: "MEDIA_SET", payload: { status: "ready", ...result, path: saved.path } });
      this.dispatch({
        type: "INFO_ADD",
        payload: { level: "success", title: "Photo", message: saved.path ? `Saved to ${saved.path}.` : `${result.fileName} is ready.` }
      });
    } catch (error) {
      this.dispatch({ type: "MEDIA_SET", payload: { status: "ready", ...result } });
      this.reportError("Save photo", error);
    }
  }

  /// Keeps the recorder panel alive: refreshes device lists once, attaches
  /// the live camera preview, and runs the waveform/timer loops.
  syncRecorderUi() {
    const subtab = activeSubtab(this.state);
    const type = subtab?.type;
    if (type !== "audio" && type !== "video") {
      this.stopCameraPreview();
      this.stopRecorderLoops();
      return;
    }
    this.refreshRecordingDevices().catch(() => {});
    if (type === "video" && this.state.media.mode !== "screen" && this.state.media.status !== "recording") {
      this.startCameraPreview().catch((error) => this.reportError("Camera preview", error));
    } else if (type === "video" && this.state.media.mode === "screen") {
      this.stopCameraPreview();
    }
    this.syncRecorderLoops();
  }

  async refreshRecordingDevices() {
    if (this.recordingDevicesLoaded || !navigator.mediaDevices?.enumerateDevices) return;
    this.recordingDevicesLoaded = true;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const { audioInputs, videoInputs } = pickRecordingDevices(devices);
    this.dispatch({ type: "MEDIA_SET", payload: { audioInputs, videoInputs } }, { preserveInput: true, render: false });
    navigator.mediaDevices.addEventListener?.("devicechange", async () => {
      const updated = pickRecordingDevices(await navigator.mediaDevices.enumerateDevices());
      this.dispatch({ type: "MEDIA_SET", payload: updated }, { preserveInput: true });
    });
  }

  async startCameraPreview() {
    const host = this.view.root.querySelector?.("#camera-preview");
    if (!host || !navigator.mediaDevices?.getUserMedia) return;
    const deviceId = this.state.media.videoDeviceId;
    if (this.cameraPreviewStream && this.cameraPreviewDeviceId === (deviceId || null) && host.srcObject) return;
    this.stopCameraPreview();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true
    });
    this.cameraPreviewStream = stream;
    this.cameraPreviewDeviceId = deviceId || null;
    host.srcObject = stream;
  }

  stopCameraPreview() {
    if (this.cameraPreviewStream) {
      this.cameraPreviewStream.getTracks().forEach((track) => track.stop());
      this.cameraPreviewStream = null;
      this.cameraPreviewDeviceId = null;
    }
    const host = this.view.root.querySelector?.("#camera-preview");
    if (host?.srcObject && !this.cameraPreviewStream) host.srcObject = null;
  }

  syncCameraPreview({ restart = false } = {}) {
    if (restart) this.stopCameraPreview();
    scheduleFrame(() => this.syncRecorderUi());
  }

  syncRecorderLoops() {
    const recording = this.state.media.status === "recording";
    if (!recording) {
      this.stopRecorderLoops();
      return;
    }
    if (!this.recorderTimerInterval) {
      this.recorderTimerInterval = setInterval(() => {
        const timer = this.view.root.querySelector?.("#record-timer");
        if (!timer) return;
        const total = Math.floor(this.capture.elapsedMs() / 1000);
        timer.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      }, 250);
    }
    if (!this.waveformFrame && this.capture.analyser) {
      const draw = () => {
        this.waveformFrame = null;
        const canvas = this.view.root.querySelector?.("#audio-waveform");
        const analyser = this.capture.analyser;
        if (!canvas || !analyser || this.state.media.status !== "recording") return;
        const context = canvas.getContext("2d");
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.lineWidth = 3;
        context.strokeStyle = this.state.media.paused ? "rgba(154,166,186,.6)" : "#7089f8";
        context.beginPath();
        const step = canvas.width / data.length;
        for (let index = 0; index < data.length; index += 1) {
          const y = (data[index] / 255) * canvas.height;
          if (index === 0) context.moveTo(0, y);
          else context.lineTo(index * step, y);
        }
        context.stroke();
        this.waveformFrame = requestAnimationFrame(draw);
      };
      this.waveformFrame = requestAnimationFrame(draw);
    }
  }

  stopRecorderLoops() {
    if (this.recorderTimerInterval) {
      clearInterval(this.recorderTimerInterval);
      this.recorderTimerInterval = null;
    }
    if (this.waveformFrame) {
      cancelAnimationFrame(this.waveformFrame);
      this.waveformFrame = null;
    }
  }

  async finishRecording(result) {
    try {
      const saved = await this.backend.saveMedia({ name: result.fileName, kind: result.kind, blob: result.blob });
      this.dispatch({ type: "MEDIA_SET", payload: { status: "ready", paused: false, ...result, path: saved.path } });
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
