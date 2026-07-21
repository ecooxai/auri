import {
  commandHelp,
  parseCommand,
  extractCommandTail,
  extractActionTail,
  terminalInputFromTransportCommand
} from "../model/commands.js";
import { shellQuote } from "../model/path.js";
import { activeWorkspace, activeSubtab, serializeWorkspaceSession } from "../model/state.js";
import { normalizeSystemSnapshot, normalizeSystemSort, processPriorityIdentity } from "../model/system.js";
import { defaultBookmarkName, normalizeWebUrl, titleForWebUrl } from "../model/browser.js";
import { normalizeShortcut } from "../model/shortcut.js";

const SUBTAB_ALIASES = Object.freeze({
  "recorder-audio": "audio",
  "recorder-video": "video",
  "audio-recording": "audio",
  "video-recording": "video"
});

const parseSettingValue = (value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
};


function prepareAssistantAudio(audioBlob) {
  if (!audioBlob || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(audioBlob);
  if (typeof Audio !== "undefined") {
    try {
      const player = new Audio(url);
      player.addEventListener("error", () => {}, { once: true });
      const playback = player.play();
      playback?.catch?.(() => {});
    } catch {}
  }
  return url;
}

function snapshotAttachments(attachments = []) {
  return attachments.map((item) => ({
    id: item.id,
    name: item.name || "Attachment",
    kind: item.kind || "file",
    mime: item.mime || "application/octet-stream",
    url: item.url || item.assetUrl || null,
    path: item.path || null
  }));
}

function addAiRequestInfo(dispatch, request = {}, fallbackModelName = "Auri") {
  const text = String(request.text ?? "");
  const modelName = String(request.modelName || fallbackModelName || "Auri");
  const media = Array.isArray(request.media)
    ? request.media.map((item, index) => ({
        id: String(item?.id || `request-media-${Date.now()}-${index}`),
        name: String(item?.name || `Attachment ${index + 1}`),
        kind: String(item?.kind || "file"),
        mime: String(item?.mime || "application/octet-stream"),
        url: item?.url || item?.assetUrl || null,
        path: item?.path || null
      }))
    : [];
  dispatch({
    type: "INFO_ADD",
    payload: {
      level: "info",
      title: `AI request · ${modelName}`,
      message: text || (media.some((item) => item.kind === "audio") ? "Voice input" : "Media request"),
      details: { type: "ai-request", text, modelName, media }
    }
  });
}

function appendOutput(dispatch, output) {
  dispatch({
    type: "TERMINAL_OUTPUT_ADD",
    payload: {
      id: `output-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      code: 0,
      stdout: "",
      stderr: "",
      kind: "system",
      ...output
    }
  });
}

async function runTerminalCommand(command, context, cwdOverride = null) {
  const { getState, dispatch, backend } = context;
  if (!command) throw new Error("Enter a shell command.");
  if (cwdOverride === null && context.actions?.runTerminalCommand) {
    return context.actions.runTerminalCommand(command);
  }
  const workspace = activeWorkspace(getState());
  const cwd = cwdOverride || workspace.terminal.cwd;
  dispatch({ type: "TERMINAL_RUNNING_SET", payload: { value: true } });
  const result = await backend.runCommand(command, cwd);
  appendOutput(dispatch, { ...result, command, kind: "command" });
  if (result.cwd && result.cwd !== workspace.terminal.cwd) {
    dispatch({ type: "WORKDIR_SET", payload: { path: result.cwd } });
    const entries = await backend.listDirectory(result.cwd);
    dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
  }
  return result;
}

async function persistConfiguration(backend, state) {
  if (!backend.saveSettings) return;
  await backend.saveSettings({
    settings: state.settings,
    models: state.models,
    selectedModelId: state.selectedModelId,
    browser: state.browser,
    workspaceSession: serializeWorkspaceSession(state),
    processPriorities: state.system?.processPriorities || {}
  });
}

function openSubtab(type, context, { forceNew = false } = {}) {
  const normalized = SUBTAB_ALIASES[type] ?? type;
  const tab = activeWorkspace(context.getState());
  const existing = forceNew ? null : tab.subtabs.find((item) => item.type === normalized);
  context.dispatch(existing
    ? { type: "SUBTAB_SELECT", payload: { id: existing.id } }
    : { type: "SUBTAB_NEW", payload: { type: normalized } });
}

export async function executeCommand(input, context) {
  const { getState, dispatch, backend } = context;
  const actions = context.actions || {};
  let parsed;

  try {
    parsed = parseCommand(input);
    const { domain, action, args } = parsed;

    if (domain === "help") {
      const stdout = commandHelp();
      appendOutput(dispatch, { stdout, kind: "help" });
      return { stdout };
    }

    if (domain === "tab") {
      if (action === "new") dispatch({ type: "TAB_NEW", payload: { title: args.join(" ") } });
      else if (action === "select") dispatch({ type: "TAB_SELECT", payload: { id: args[0] } });
      else if (action === "close") dispatch({ type: "TAB_CLOSE", payload: { id: args[0] } });
      else throw new Error(`Unknown tab action: ${action}`);
      return { ok: true };
    }

    if (domain === "app") {
      if (action !== "exit") throw new Error(`Unknown app action: ${action}`);
      if (!actions.exitApp) throw new Error("App exit is unavailable in this runtime.");
      await actions.exitApp();
      return { ok: true };
    }

    if (domain === "subtab") {
      if (action === "new") {
        if (!args[0]) throw new Error("Choose a subtab type.");
        dispatch({ type: "SUBTAB_NEW", payload: { type: SUBTAB_ALIASES[args[0]] ?? args[0] } });
      } else if (action === "select") {
        if (actions.selectSubtab) await actions.selectSubtab(args[0]);
        else dispatch({ type: "SUBTAB_SELECT", payload: { id: args[0] } });
      }
      else if (action === "close") dispatch({ type: "SUBTAB_CLOSE", payload: { id: args[0] } });
      else if (action === "reload") {
        if (!actions.reloadSubtab) throw new Error("Tab reload is unavailable in this runtime.");
        await actions.reloadSubtab(args[0] || activeWorkspace(getState()).activeSubtabId);
      }
      else if (action === "move-window") {
        if (!actions.moveSubtabToWindow) throw new Error("Standalone tab windows are unavailable in this runtime.");
        await actions.moveSubtabToWindow(args[0] || activeWorkspace(getState()).activeSubtabId);
      }
      else if (action === "move-main") {
        if (!actions.moveSubtabToMain) throw new Error("Returning tabs to the main window is unavailable in this runtime.");
        await actions.moveSubtabToMain(args[0] || activeWorkspace(getState()).activeSubtabId);
      }
      else throw new Error(`Unknown subtab action: ${action}`);
      return { ok: true };
    }

    if (domain === "folder") {
      const workspace = activeWorkspace(getState());
      if (action === "list" && !args.length && actions.refreshFolder) {
        return await actions.refreshFolder();
      }
      if (action === "sort") {
        const sortBy = args[0];
        if (!["name", "date", "type"].includes(sortBy)) throw new Error("Folder sort must be name, date, or type.");
        dispatch({ type: "FOLDER_SORT_SET", payload: { sortBy } });
        return { sortBy };
      }
      if (action === "toggle") {
        const path = args.join(" ").trim();
        if (!path) throw new Error("Choose a folder to expand.");
        if (workspace.folder.expanded?.[path]) {
          dispatch({ type: "FOLDER_EXPANDED_REMOVE", payload: { path } });
          return { path, expanded: false };
        }
        const entries = await backend.listDirectory(path);
        dispatch({ type: "FOLDER_EXPANDED_SET", payload: { path, entries } });
        return { path, entries, expanded: true };
      }
      if (action === "create-file" || action === "create-folder") {
        const name = args.join(" ").trim();
        if (!name) throw new Error(`Enter a name for the new ${action === "create-file" ? "file" : "folder"}.`);
        if (name === "." || name === ".." || /[\/\\]/.test(name)) {
          throw new Error("Create items directly in the current folder; path separators are not allowed.");
        }
        const safeName = name.startsWith("-") ? `./${name}` : name;
        const command = action === "create-file"
          ? `touch ${shellQuote(safeName)}`
          : `mkdir -p ${shellQuote(safeName)}`;
        const result = await runTerminalCommand(command, context, workspace.folder.path);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || `Could not create ${name}.`);
        const entries = await backend.listDirectory(workspace.folder.path);
        dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
        return { name, command };
      }
      if (action === "info") {
        const path = args.join(" ") || workspace.folder.path;
        const details = await backend.folderInfo(path);
        dispatch({
          type: "INFO_ADD",
          payload: {
            level: "info",
            title: `Folder info · ${details.name || path}`,
            message: details.path || path,
            details
          }
        });
        openSubtab("info", context);
        dispatch({ type: "INFO_READ", payload: {} });
        return details;
      }
      const path = args.join(" ") || workspace.folder.path;
      if (action === "cd") dispatch({ type: "WORKDIR_SET", payload: { path } });
      if (action !== "cd" && action !== "list") throw new Error(`Unknown folder action: ${action}`);
      const entries = await backend.listDirectory(path);
      dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
      return { entries };
    }

    if (domain === "file") {
      if (action === "preview-pin") {
        const value = String(args[0] || "").toLowerCase();
        if (value !== "on" && value !== "off") throw new Error("Choose file preview-pin on or off.");
        if (activeWorkspace(getState()).viewer.mode !== "inspect") throw new Error("No floating file preview is open.");
        dispatch({ type: "FILE_PREVIEW_PIN_SET", payload: { pinned: value === "on" } });
        return { pinned: value === "on" };
      }
      const path = args.join(" ") || activeWorkspace(getState()).viewer.path;
      if (!path) throw new Error("Choose a file path.");
      if (action === "external") {
        if (!actions.openExternal) throw new Error("External file opening is unavailable.");
        await actions.openExternal(path);
        return { path };
      }
      if (action === "serve") {
        if (!backend.startFileServer) throw new Error("The web file viewer needs the native Auri build.");
        const metadata = await backend.inspectFile(path);
        const served = await backend.startFileServer("/");
        const normalized = path.replaceAll("\\", "/");
        const pathname = (normalized.startsWith("/") ? normalized : `/${normalized}`)
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        const url = `http://localhost:${served.port}${pathname}${metadata.kind === "directory" ? "" : "?view=1"}`;
        openSubtab("webview", context);
        const current = activeSubtab(getState());
        dispatch({
          type: "SUBTAB_UPDATE",
          payload: { id: current.id, patch: { url, title: metadata.name || "Files" } }
        });
        return { url, port: served.port, root: served.root };
      }
      if (action !== "inspect" && action !== "open") throw new Error(`Unknown file action: ${action}`);
      const inspected = await backend.inspectFile(path);
      const metadata = inspected.kind === "directory" && backend.listDirectory
        ? { ...inspected, entries: await backend.listDirectory(path) }
        : inspected;
      if (action === "inspect") {
        dispatch({ type: "FILE_SELECT", payload: { path, metadata, open: false } });
        if (context.fileInspectMode !== "floating") openSubtab("viewer", context);
        return metadata;
      }
      dispatch({ type: "FILE_SELECT", payload: { path, metadata, open: true } });
      if (!actions.openFileInWebview) throw new Error("File WebView opening is unavailable.");
      const fileView = await actions.openFileInWebview(path, metadata, {
        autoplay: metadata.kind === "audio" || metadata.kind === "video"
      });
      const workspace = activeWorkspace(getState());
      const currentViewer = workspace.subtabs.find((item) => item.type === "webview" && item.filePath);
      if (currentViewer) dispatch({ type: "SUBTAB_SELECT", payload: { id: currentViewer.id } });
      else openSubtab("webview", context, { forceNew: true });
      const current = activeSubtab(getState());
      dispatch({
        type: "SUBTAB_UPDATE",
        payload: {
          id: current.id,
          patch: {
            url: fileView.url,
            title: fileView.title || metadata.name || "File",
            filePath: fileView.filePath || path,
            fileMime: fileView.mime || ""
          }
        }
      });
      if (currentViewer?.standalone && actions.moveSubtabToWindow) {
        await actions.moveSubtabToWindow(current.id);
      }
      return { ...metadata, ...fileView };
    }

    if (domain === "terminal" && action === "run") {
      const command = context.terminalCommand
        ?? terminalInputFromTransportCommand(input)
        ?? (extractCommandTail(input) || args.join(" "));
      return runTerminalCommand(command, context);
    }

    if (domain === "ai") {
      if (action === "ask") {
        const prompt = extractActionTail(input, "ai", "ask") || args.join(" ");
        if (!prompt) throw new Error("Enter a prompt for the assistant.");
        const state = getState();
        const workspace = activeWorkspace(state);
        const model = state.models.find((item) => item.id === state.selectedModelId);
        const attachments = [...state.media.attachments];
        const sentAttachments = snapshotAttachments(attachments);
        actions.showUserMessage?.(prompt, sentAttachments);
        appendOutput(dispatch, {
          stdout: prompt,
          kind: "user",
          cwd: workspace.terminal.cwd,
          modelName: model?.name,
          attachments: sentAttachments
        });
        dispatch({ type: "ATTACHMENTS_CLEAR", payload: {} });
        dispatch({ type: "UI_SET", payload: { assistantActions: [], assistantTranscripts: [] } });
        dispatch({ type: "TERMINAL_RUNNING_SET", payload: { value: true } });
        const result = await backend.askAi({
          prompt,
          model,
          cwd: workspace.terminal.cwd,
          attachScreenshot: state.settings.alwaysAttachScreenshot,
          attachments,
          onRequest: (request) => addAiRequestInfo(dispatch, request, model?.name)
        });
        const audioUrl = prepareAssistantAudio(result.audioBlob);
        const assistantAudio = audioUrl ? {
          name: `${model?.name || "Auri"} response`,
          url: audioUrl,
          mime: result.audioMime || "audio/wav"
        } : null;
        actions.showAssistantMessage?.(model?.name, result.text, assistantAudio);
        appendOutput(dispatch, {
          stdout: result.text,
          transcript: result.transcript,
          kind: "assistant",
          modelName: model?.name,
          audioUrl,
          audioMime: result.audioMime
        });
        return result;
      }
      if (action === "model" && args[0] === "select") {
        dispatch({ type: "MODEL_SELECT", payload: { id: args[1] } });
        await persistConfiguration(backend, getState());
        return { ok: true };
      }
      if (action === "model" && args[0] === "add") {
        const [name, type, model, url = "", apiKey = ""] = args.slice(1);
        if (!name || !type || !model) throw new Error("Model add needs name, type, and model.");
        const item = { id: `model-${Date.now()}`, name, type, model, url, apiKey, enabled: true };
        dispatch({ type: "MODEL_ADD", payload: item });
        await persistConfiguration(backend, getState());
        return item;
      }
      if (action === "model" && args[0] === "update") {
        const [id, name, type, model, url = "", apiKey = ""] = args.slice(1);
        if (!id || !name || !type || !model) throw new Error("Model update needs id, name, type, and model.");
        if (!getState().models.some((item) => item.id === id)) throw new Error("Model not found.");
        const patch = { name, type, model, url, apiKey };
        dispatch({ type: "MODEL_UPDATE", payload: { id, patch } });
        await persistConfiguration(backend, getState());
        return { id, ...patch };
      }
      if (action === "model" && args[0] === "delete") {
        const id = args[1];
        if (!id) throw new Error("Choose a model to delete.");
        if (!getState().models.some((item) => item.id === id)) throw new Error("Model not found.");
        dispatch({ type: "MODEL_DELETE", payload: { id } });
        await persistConfiguration(backend, getState());
        return { id };
      }
      throw new Error(`Unknown AI action: ${action}`);
    }


    if (domain === "web") {
      if (action === "ask") {
        const prompt = extractActionTail(input, "web", "ask") || args.join(" ");
        if (!prompt) throw new Error("Enter a prompt to ask.");
        const state = getState();
        const model = state.models.find((item) => item.id === state.selectedModelId);
        const attachments = [...state.media.attachments];
        dispatch({ type: "ATTACHMENTS_CLEAR", payload: {} });
        dispatch({
          type: "UI_SET",
          payload: { webAiReply: { status: "loading", prompt, modelName: model?.name || "AI", text: "" }, webMagicMenuOpen: false }
        });
        try {
          const result = await backend.askAi({
            prompt,
            model,
            attachScreenshot: false,
            attachments,
            onRequest: (request) => addAiRequestInfo(dispatch, request, model?.name)
          });
          const audioUrl = prepareAssistantAudio(result.audioBlob);
          const text = result.text || result.transcript || "";
          dispatch({
            type: "UI_SET",
            payload: { webAiReply: { status: "ready", prompt, modelName: model?.name || "AI", text, audioUrl } }
          });
          return result;
        } catch (error) {
          const message = error?.message || String(error);
          dispatch({
            type: "UI_SET",
            payload: { webAiReply: { status: "error", prompt, modelName: model?.name || "AI", text: message } }
          });
          dispatch({ type: "INFO_ADD", payload: { level: "error", title: "Web AI", message } });
          return { error: message };
        }
      }
      if (action === "ask-close") {
        dispatch({ type: "UI_SET", payload: { webAiReply: null } });
        return { ok: true };
      }
      if (action === "open") {
        const url = normalizeWebUrl(args.join(" ") || extractActionTail(input, "web", "open"));
        const subtab = activeSubtab(getState());
        if (subtab.type !== "webview") openSubtab("webview", context);
        const current = activeSubtab(getState());
        const title = titleForWebUrl(url);
        dispatch({ type: "SUBTAB_UPDATE", payload: { id: current.id, patch: { url, title, filePath: null, fileMime: null } } });
        dispatch({ type: "BROWSER_HISTORY_ADD", payload: { url, title, at: new Date().toISOString() } });
        await persistConfiguration(backend, getState());
        return { url };
      }
      if (action === "bookmark") {
        const operation = args[0];
        if (!operation) {
          if (!actions.openWebDialog) throw new Error("The add-bookmark dialog is unavailable.");
          await actions.openWebDialog("add-bookmark");
          return { ok: true };
        }
        if (operation === "add") {
          const current = activeSubtab(getState());
          const values = args.slice(1);
          let rawUrl = current.url;
          let requestedName = "";
          if (values.length === 1) {
            try {
              normalizeWebUrl(values[0]);
              rawUrl = values[0];
            } catch {
              requestedName = values[0];
            }
          } else if (values.length >= 2) {
            requestedName = values[0];
            rawUrl = values[1];
          }
          const url = normalizeWebUrl(rawUrl);
          const name = String(requestedName).trim() || defaultBookmarkName(url);
          const item = { id: `bookmark-${Date.now()}-${Math.random().toString(16).slice(2)}`, name, url, createdAt: new Date().toISOString() };
          dispatch({ type: "BROWSER_BOOKMARK_ADD", payload: item });
          await persistConfiguration(backend, getState());
          return item;
        }
        if (operation === "remove") {
          const id = args[1];
          if (!id || !getState().browser.bookmarks.some((item) => item.id === id)) throw new Error("Bookmark not found.");
          dispatch({ type: "BROWSER_BOOKMARK_REMOVE", payload: { id } });
          await persistConfiguration(backend, getState());
          return { id };
        }
        throw new Error(`Unknown bookmark action: ${operation}`);
      }
      if (action === "bookmarks") {
        if (!actions.openWebDialog) throw new Error("Bookmarks are unavailable.");
        await actions.openWebDialog("bookmarks");
        return { ok: true };
      }
      if (action === "history") {
        if (args[0] === "clear") {
          dispatch({ type: "BROWSER_HISTORY_CLEAR" });
          await persistConfiguration(backend, getState());
          return { ok: true };
        }
        if (!actions.openWebDialog) throw new Error("Browser history is unavailable.");
        await actions.openWebDialog("history");
        return { ok: true };
      }
      const actionNames = {
        reload: "webReload",
        back: "webBack",
        forward: "webForward",
        external: "webExternal",
        download: "webDownload",
        "zoom-in": "webZoomIn",
        "zoom-out": "webZoomOut",
        "zoom-reset": "webZoomReset",
        devtools: "webDevtools"
      };
      if (actionNames[action]) {
        const handler = actions[actionNames[action]];
        if (!handler) throw new Error(`Web action is unavailable: ${action}`);
        await handler();
        return { ok: true };
      }
      throw new Error(`Unknown web action: ${action}`);
    }

    if (domain === "clipboard") {
      if (action === "list") {
        const items = await backend.readClipboardHistory();
        dispatch({ type: "CLIPBOARD_SET", payload: { items } });
        openSubtab("clipboard", context);
        return { items };
      }
      if (action === "insert") {
        const item = getState().clipboard.items.find((entry) => entry.id === args[0]);
        if (!item) throw new Error("Clipboard item was not found.");
        if (!actions.pasteClipboardItem) throw new Error("System clipboard paste is unavailable.");
        await actions.pasteClipboardItem(item.id);
        return { pasted: item.id };
      }
      if (action === "pin" || action === "unpin") {
        const id = args[0];
        if (!id || !getState().clipboard.items.some((entry) => entry.id === id)) throw new Error("Clipboard item was not found.");
        if (!backend.setClipboardPinned) throw new Error("Clipboard pinning is unavailable.");
        const items = await backend.setClipboardPinned(id, action === "pin");
        dispatch({ type: "CLIPBOARD_SET", payload: { items } });
        return { id, pinned: action === "pin" };
      }
      if (action === "remove") {
        const id = args[0];
        if (!id || !getState().clipboard.items.some((entry) => entry.id === id)) throw new Error("Clipboard item was not found.");
        if (!backend.removeClipboardItem) throw new Error("Clipboard removal is unavailable.");
        const items = await backend.removeClipboardItem(id);
        dispatch({ type: "CLIPBOARD_SET", payload: { items } });
        return { removed: id };
      }
      if (action === "copy") {
        const text = args.join(" ");
        if (!actions.copyText) throw new Error("Clipboard writing is unavailable.");
        await actions.copyText(text);
        return { copied: text.length };
      }
      if (action === "copy-item") {
        const id = args[0];
        if (!id || !getState().clipboard.items.some((entry) => entry.id === id)) throw new Error("Clipboard item was not found.");
        if (!backend.copyClipboardItem) throw new Error("Clipboard writing is unavailable.");
        await backend.copyClipboardItem(id);
        return { copied: id };
      }
      if (action === "edit") {
        const id = args[0];
        if (!id || !getState().clipboard.items.some((entry) => entry.id === id)) throw new Error("Clipboard item was not found.");
        if (!backend.updateClipboardItem) throw new Error("Clipboard editing is unavailable.");
        // Quoted GUI values arrive as a single token that keeps newlines and spacing.
        const items = await backend.updateClipboardItem(id, args.slice(1).join(" "));
        dispatch({ type: "CLIPBOARD_SET", payload: { items } });
        return { updated: id };
      }
      if (action === "info") {
        const id = args[0];
        if (!id || !getState().clipboard.items.some((entry) => entry.id === id)) throw new Error("Clipboard item was not found.");
        openSubtab("clipboard", context);
        dispatch({ type: "UI_SET", payload: { clipboardInfoId: id, clipboardMenuId: null } });
        return { info: id };
      }
      throw new Error(`Unknown clipboard action: ${action}`);
    }

    if (domain === "attachment") {
      if (action === "remove") {
        dispatch({ type: "ATTACHMENT_REMOVE", payload: { id: args[0] } });
        return { ok: true };
      }
      if (action === "add") {
        const path = args.join(" ");
        if (!path) throw new Error("Choose an attachment path.");
        const metadata = await backend.inspectFile(path);
        const item = { id: `attachment-${Date.now()}`, name: metadata.name, kind: metadata.kind, mime: metadata.mime || "application/octet-stream", path };
        dispatch({ type: "ATTACHMENT_ADD", payload: item });
        return item;
      }
      throw new Error(`Unknown attachment action: ${action}`);
    }

    if (domain === "input" && action === "insert") {
      const text = args.join(" ");
      if (!actions.insertText) throw new Error("No focused input is available.");
      await actions.insertText(text);
      return { inserted: text.length };
    }

    if (domain === "transcript" && action === "dismiss") {
      dispatch({ type: "UI_SET", payload: { assistantActions: [], assistantTranscripts: [] } });
      return { ok: true };
    }

    if (domain === "live" && action === "record") {
      const operation = args[0];
      if (operation === "start") {
        if (!actions.startLiveRecording) throw new Error("Live microphone input is unavailable in this runtime.");
        await actions.startLiveRecording();
        return { ok: true };
      }
      if (operation === "stop") {
        if (!actions.stopLiveRecording) throw new Error("No Live microphone session is active.");
        await actions.stopLiveRecording();
        return { ok: true };
      }
      if (operation === "toggle") {
        if (!actions.toggleLiveRecording) throw new Error("Live microphone input is unavailable in this runtime.");
        await actions.toggleLiveRecording();
        return { ok: true };
      }
      throw new Error("Live record action must be start, stop, or toggle.");
    }

    if (domain === "record") {
      if (action === "audio" || action === "video") {
        openSubtab(action, context);
        return { ok: true };
      }
      if (action === "start") {
        const kind = args[0];
        if (kind !== "audio" && kind !== "video") throw new Error("Choose audio or video recording.");
        openSubtab(kind, context);
        if (!actions.startRecording) throw new Error("Recording is unavailable in this runtime.");
        await actions.startRecording(kind);
        return { ok: true };
      }
      if (action === "stop") {
        if (!actions.stopRecording) throw new Error("No recording controller is available.");
        await actions.stopRecording();
        return { ok: true };
      }
      if (action === "pause" || action === "resume") {
        const handler = action === "pause" ? actions.pauseRecording : actions.resumeRecording;
        if (!handler) throw new Error("Recording pause is unavailable in this runtime.");
        await handler();
        dispatch({ type: "MEDIA_SET", payload: { paused: action === "pause" } });
        return { ok: true };
      }
      if (action === "photo") {
        openSubtab("video", context);
        if (!actions.capturePhoto) throw new Error("Photo capture is unavailable in this runtime.");
        await actions.capturePhoto();
        return { ok: true };
      }
      if (action === "mic") {
        const deviceId = args[0];
        if (!deviceId) throw new Error("Choose a microphone device id.");
        const resolved = deviceId === "default" ? null : deviceId;
        if (getState().media.status === "recording") {
          if (!actions.switchMicrophone) throw new Error("Microphone switching is unavailable in this runtime.");
          await actions.switchMicrophone(resolved);
        }
        dispatch({ type: "MEDIA_SET", payload: { audioDeviceId: resolved } });
        return { deviceId: resolved };
      }
      if (action === "mode") {
        const mode = args[0];
        if (!["photo", "video", "screen"].includes(mode)) throw new Error("Choose photo, video, or screen mode.");
        dispatch({ type: "MEDIA_SET", payload: { mode } });
        openSubtab("video", context);
        return { mode };
      }
      throw new Error(`Unknown record action: ${action}`);
    }

    if (domain === "media" && action === "attach") {
      if (!actions.attachMedia) throw new Error("Media attachment is unavailable.");
      await actions.attachMedia(args[0]);
      return { ok: true };
    }

    if (domain === "browser") {
      if (action !== "open") throw new Error(`Unknown browser action: ${action}`);
      if (!actions.openBrowserUi) throw new Error("The browser UI needs the native Auri app.");
      const info = await actions.openBrowserUi();
      appendOutput(dispatch, { stdout: `Auri UI: ${info?.url || "http://127.0.0.1:8899"}\n` });
      return info || { ok: true };
    }

    if (domain === "settings" && action === "open") {
      openSubtab("settings", context);
      return { ok: true };
    }

    if (domain === "settings" && action === "priority-rules") {
      const mode = String(args.shift() || "toggle").toLowerCase();
      const ui = getState().ui || {};
      if (mode === "filter") {
        const filter = args.join(" ").trim();
        dispatch({ type: "UI_SET", payload: { processPriorityFilter: filter } });
        return { filter };
      }
      if (mode === "search-toggle") {
        const open = !Boolean(ui.processPriorityFilterOpen);
        dispatch({ type: "UI_SET", payload: { processPriorityFilterOpen: open, ...(open ? {} : { processPriorityFilter: "" }) } });
        return { searchOpen: open };
      }
      if (!["open", "close", "toggle"].includes(mode)) throw new Error("Choose open, close, toggle, search-toggle, or filter.");
      const open = mode === "open" ? true : mode === "close" ? false : !Boolean(ui.processPrioritySettingsOpen);
      dispatch({ type: "UI_SET", payload: {
        processPrioritySettingsOpen: open,
        ...(!open ? { processPriorityFilterOpen: false, processPriorityFilter: "", processPrioritySuggestions: [] } : {})
      } });
      return { open };
    }

    if (domain === "settings" && action === "set") {
      const key = args.shift();
      if (!key) throw new Error("Choose a setting key.");
      let value = parseSettingValue(args.join(" "));
      if (key === "wakeShortcut") {
        const shortcut = normalizeShortcut(value);
        if (!shortcut) throw new Error("Press a valid wake shortcut.");
        await backend.setWakeShortcut?.(shortcut);
        value = shortcut;
      }
      if (key === "visibleOnAllWorkspaces") {
        await backend.setVisibleOnAllWorkspaces?.(Boolean(value));
        value = Boolean(value);
      }
      dispatch({ type: "SETTING_SET", payload: { key, value } });
      await persistConfiguration(backend, getState());
      return { key, value };
    }

    if (domain === "permission") {
      if (action === "status") {
        if (!actions.refreshMediaPermissions) throw new Error("Media permission status is unavailable in this runtime.");
        return actions.refreshMediaPermissions();
      }
      if (action === "request") {
        const requested = args[0];
        const permission = requested === "screen-recording" ? "screenRecording" : requested;
        if (!["microphone", "screenRecording"].includes(permission)) throw new Error("Permission must be microphone or screen-recording.");
        if (!actions.requestMediaPermission) throw new Error("Media permission requests are unavailable in this runtime.");
        return actions.requestMediaPermission(permission);
      }
      throw new Error(`Unknown permission action: ${action}`);
    }


    if (domain === "system") {
      if (action === "open") {
        openSubtab("system", context);
        openSubtab("disk", context);
        openSubtab("net", context);
        openSubtab("system", context);
        if (actions.refreshSystemMonitor) {
          await actions.refreshSystemMonitor();
        } else if (backend.systemSnapshot) {
          const snapshot = normalizeSystemSnapshot(await backend.systemSnapshot({ includeGpus: false }));
          dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } });
        }
        return { ok: true };
      }
      if (action === "gpus") {
        const includeGpus = !Boolean(getState().system.gpuMode);
        dispatch({ type: "SYSTEM_GPU_MODE_TOGGLE" });
        if (actions.refreshSystemMonitor) {
          await actions.refreshSystemMonitor();
        } else if (backend.systemSnapshot) {
          const snapshot = normalizeSystemSnapshot(await backend.systemSnapshot({ includeGpus }));
          dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } });
        }
        return { includeGpus };
      }
      if (action === "sort") {
        const sortBy = normalizeSystemSort(args[0]);
        dispatch({ type: "SYSTEM_SORT_SET", payload: { sortBy } });
        return { sortBy };
      }
      if (action === "search") {
        const filter = args.join(" ").trim();
        dispatch({ type: "SYSTEM_FILTER_SET", payload: { filter } });
        return { filter };
      }
      if (action === "refresh") {
        if (!backend.systemSnapshot) throw new Error("System monitor is unavailable in this runtime.");
        const snapshot = normalizeSystemSnapshot(await backend.systemSnapshot({ includeGpus: Boolean(getState().system.gpuMode) }));
        dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } });
        if (backend.cloudflaredActiveTunnels) {
          try {
            const tunnels = await backend.cloudflaredActiveTunnels();
            const activePorts = new Set(tunnels.map((t) => Number(t.port)));
            const currentPorts = Object.keys(getState().system.tunnels || {}).map(Number);
            for (const port of currentPorts) {
              if (!activePorts.has(port)) {
                dispatch({ type: "SYSTEM_TUNNEL_REMOVE", payload: { port } });
              }
            }
            for (const tunnel of tunnels) {
              dispatch({ type: "SYSTEM_TUNNEL_SET", payload: tunnel });
            }
          } catch (e) {
            console.error("Failed to fetch active tunnels", e);
          }
        }
        return snapshot;
      }
      if (action === "select") {
        const pid = Number(args[0]);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Choose a process PID.");
        dispatch({ type: "SYSTEM_PROCESS_SELECT", payload: { pid } });
        if (backend.cloudflaredActiveTunnels) {
          try {
            const tunnels = await backend.cloudflaredActiveTunnels();
            const activePorts = new Set(tunnels.map((t) => Number(t.port)));
            const currentPorts = Object.keys(getState().system.tunnels || {}).map(Number);
            for (const port of currentPorts) {
              if (!activePorts.has(port)) {
                dispatch({ type: "SYSTEM_TUNNEL_REMOVE", payload: { port } });
              }
            }
            for (const tunnel of tunnels) {
              dispatch({ type: "SYSTEM_TUNNEL_SET", payload: tunnel });
            }
          } catch (e) {
            console.error("Failed to fetch active tunnels", e);
          }
        }
        return { pid };
      }
      if (action === "priority-rule") {
        const ruleAction = String(args.shift() || "").toLowerCase();
        if (ruleAction === "suggest") {
          const query = args.join(" ").trim();
          dispatch({ type: "UI_SET", payload: { processPriorityDraft: query } });
          if (query.length <= 3) {
            dispatch({ type: "UI_SET", payload: { processPrioritySuggestions: [] } });
            return { query, suggestions: [] };
          }
          if (!backend.searchPathCommands) throw new Error("PATH command search is unavailable in this runtime.");
          const suggestions = await backend.searchPathCommands(query);
          if (String(getState().ui?.processPriorityDraft || "") === query) {
            dispatch({ type: "UI_SET", payload: { processPrioritySuggestions: Array.isArray(suggestions) ? suggestions : [] } });
          }
          return { query, suggestions };
        }
        if (ruleAction === "choose") {
          const path = args.join(" ").trim();
          if (!path) throw new Error("Choose a PATH command.");
          dispatch({ type: "UI_SET", payload: { processPriorityDraft: path, processPrioritySuggestions: [] } });
          return { path };
        }
        if (ruleAction !== "set" && ruleAction !== "remove") throw new Error("Choose set, remove, suggest, or choose for the priority rule.");
        const identity = String(args.shift() || "").trim();
        if (!identity) throw new Error("Enter a process name or executable path.");
        if (ruleAction === "remove") {
          dispatch({ type: "SYSTEM_PROCESS_PRIORITY_REMOVE", payload: { identity } });
          await persistConfiguration(backend, getState());
          return { identity, removed: true };
        }
        const nice = Number(args.shift());
        if (!Number.isInteger(nice) || nice < -20 || nice > 19) throw new Error("Priority nice value must be an integer from -20 through 19.");
        dispatch({ type: "SYSTEM_PROCESS_PRIORITY_SET", payload: { identity, level: "custom", nice } });
        dispatch({ type: "UI_SET", payload: { processPriorityDraft: "", processPrioritySuggestions: [] } });
        await persistConfiguration(backend, getState());
        return { identity, nice };
      }
      if (action === "priority") {
        const pid = Number(args[0] || getState().system.selectedProcessPid);
        const level = String(args[1] || "").toLowerCase();
        const niceByLevel = { low: 10, lower: 15, lowest: 19, normal: 1, high: -10 };
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Choose a process PID.");
        if (!(level in niceByLevel) && level !== "unset") throw new Error("Choose low, lower, lowest, normal, high, or unset priority.");
        const process = getState().system.snapshot?.processes?.find((item) => Number(item.pid) === pid);
        if (!process) throw new Error(`Process ${pid} is no longer running.`);
        const identity = processPriorityIdentity(process);
        if (!identity) throw new Error("This process has no stable executable identity.");
        if (level === "unset") {
          dispatch({ type: "SYSTEM_PROCESS_PRIORITY_REMOVE", payload: { identity } });
          await persistConfiguration(backend, getState());
          return { pid, identity, level };
        }
        if (!backend.setProcessPriority) throw new Error("Changing process priority is unavailable in this runtime.");
        const nice = niceByLevel[level];
        try {
          await backend.setProcessPriority(pid, nice);
        } catch (error) {
          const message = error?.message || String(error);
          if ((message.includes("AURI_PRIORITY_ADMIN_REQUIRED") || message.includes("AURI_PRIORITY_ROOT_REQUIRED")) && actions.requestProcessPriorityPermission) {
            const method = message.includes("AURI_PRIORITY_ROOT_REQUIRED") ? "root" : "sudo";
            actions.requestProcessPriorityPermission({ pid, name: process.name || "process", method, level, nice, error: "" });
            return { pid, identity, level, nice, pendingPermission: true };
          }
          throw error;
        }
        dispatch({ type: "SYSTEM_PROCESS_PRIORITY_APPLIED", payload: { pid, nice } });
        dispatch({ type: "SYSTEM_PROCESS_PRIORITY_SET", payload: { identity, level, nice } });
        await persistConfiguration(backend, getState());
        return { pid, identity, level, nice };
      }
      if (action === "priority-auth") {
        const pid = Number(args[0]);
        const level = String(args[1] || "").toLowerCase();
        const method = String(args[2] || "").toLowerCase();
        const niceByLevel = { low: 10, lower: 15, lowest: 19, normal: 1, high: -10 };
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Choose a process PID.");
        if (!(level in niceByLevel)) throw new Error("Choose low, lower, lowest, normal, or high priority.");
        if (method !== "sudo" && method !== "root") throw new Error("Choose sudo or root authorization.");
        const process = getState().system.snapshot?.processes?.find((item) => Number(item.pid) === pid);
        if (!process) throw new Error(`Process ${pid} is no longer running.`);
        const identity = processPriorityIdentity(process);
        if (!identity) throw new Error("This process has no stable executable identity.");
        if (!backend.setProcessPriorityPrivileged || !actions.consumeProcessPriorityPassword) {
          throw new Error("Administrator priority authorization is unavailable in this runtime.");
        }
        const password = actions.consumeProcessPriorityPassword();
        if (!password) throw new Error(`Enter the ${method === "root" ? "root" : "administrator"} password.`);
        const nice = niceByLevel[level];
        const result = await backend.setProcessPriorityPrivileged(pid, nice, password, method);
        if (result?.applied) {
          dispatch({ type: "SYSTEM_PROCESS_PRIORITY_APPLIED", payload: { pid, nice } });
          dispatch({ type: "SYSTEM_PROCESS_PRIORITY_SET", payload: { identity, level, nice } });
          await persistConfiguration(backend, getState());
          actions.closeProcessPriorityPermission?.();
          return { pid, identity, level, nice };
        }
        const nextMethod = result?.requiresRoot ? "root" : method;
        const message = String(result?.message || (nextMethod === "root" ? "Root authorization failed." : "Administrator authorization failed."));
        actions.requestProcessPriorityPermission?.({ pid, name: process.name || "process", method: nextMethod, level, nice, error: message });
        if (!result?.requiresRoot) {
          dispatch({ type: "INFO_ADD", payload: { level: "error", title: "Process priority", message } });
        }
        return { pid, identity, level, nice, pendingPermission: true };
      }
      if (action === "deselect") {
        dispatch({ type: "SYSTEM_PROCESS_SELECT", payload: { pid: null } });
        return { pid: null };
      }
      if (action === "kill") {
        const pid = Number(args[0] || getState().system.selectedProcessPid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Choose a process PID to kill.");
        if (!backend.killProcess) throw new Error("Killing processes is unavailable in this runtime.");
        await backend.killProcess(pid);
        if (backend.systemSnapshot) {
          const snapshot = normalizeSystemSnapshot(await backend.systemSnapshot({ includeGpus: Boolean(getState().system.gpuMode) }));
          dispatch({ type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot } });
        }
        return { pid };
      }
      if (action === "open-path") {
        const pid = Number(args[0] || getState().system.selectedProcessPid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Choose a process PID to open.");
        const process = getState().system.snapshot?.processes?.find((item) => Number(item.pid) === pid);
        const processPath = String(process?.path || "").trim();
        const workingDirectory = String(process?.workingDirectory || "").trim();
        const folder = workingDirectory && workingDirectory !== "/"
          ? workingDirectory
          : processPath.split(/[\/]/).slice(0, -1).join("/") || processPath;
        if (!folder) throw new Error("This process path is unavailable.");
        if (!actions.openExternal) throw new Error("Opening process paths is unavailable in this runtime.");
        await actions.openExternal(folder);
        return { pid, path: folder };
      }
      if (action === "tunnel") {
        const tunnelAction = args[0];
        const port = Number(args[1]);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Choose a valid process port.");
        if (tunnelAction === "start") {
          if (!backend.startCloudflaredTunnel) throw new Error("Cloudflare tunnels need the native Tauri build.");
          const tunnel = await backend.startCloudflaredTunnel({ port, installIfMissing: args.includes("--install") });
          dispatch({ type: "SYSTEM_TUNNEL_SET", payload: tunnel });
          return tunnel;
        }
        if (tunnelAction === "stop") {
          if (!backend.stopCloudflaredTunnel) throw new Error("Cloudflare tunnels need the native Tauri build.");
          const tunnel = await backend.stopCloudflaredTunnel(port);
          dispatch({ type: "SYSTEM_TUNNEL_REMOVE", payload: { port } });
          return tunnel;
        }
        throw new Error("Use system tunnel start <port> or system tunnel stop <port>.");
      }
      throw new Error(`Unknown system action: ${action}`);
    }

    if (domain === "info") {
      if (action === "show") {
        openSubtab("info", context);
        dispatch({ type: "INFO_READ", payload: {} });
      } else if (action === "clear") dispatch({ type: "INFO_CLEAR", payload: {} });
      else throw new Error(`Unknown info action: ${action}`);
      return { ok: true };
    }

    throw new Error(`Unknown command: ${domain} ${action}. Try: auri help`);
  } catch (error) {
    dispatch({
      type: "INFO_ADD",
      payload: { level: "error", title: parsed ? `${parsed.domain} ${parsed.action}` : "Command", message: error.message || String(error) }
    });
    dispatch({ type: "TERMINAL_RUNNING_SET", payload: { value: false } });
    throw error;
  }
}
