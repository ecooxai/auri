import { commandHelp, parseCommand, extractCommandTail, extractActionTail } from "../model/commands.js";
import { activeWorkspace, activeSubtab } from "../model/state.js";

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

async function persistConfiguration(backend, state) {
  await backend.saveSettings({
    settings: state.settings,
    models: state.models,
    selectedModelId: state.selectedModelId
  });
}

function openSubtab(type, context) {
  const normalized = SUBTAB_ALIASES[type] ?? type;
  const tab = activeWorkspace(context.getState());
  const existing = tab.subtabs.find((item) => item.type === normalized);
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

    if (domain === "subtab") {
      if (action === "new") {
        if (!args[0]) throw new Error("Choose a subtab type.");
        dispatch({ type: "SUBTAB_NEW", payload: { type: SUBTAB_ALIASES[args[0]] ?? args[0] } });
      } else if (action === "select") dispatch({ type: "SUBTAB_SELECT", payload: { id: args[0] } });
      else if (action === "close") dispatch({ type: "SUBTAB_CLOSE", payload: { id: args[0] } });
      else throw new Error(`Unknown subtab action: ${action}`);
      return { ok: true };
    }

    if (domain === "folder") {
      const workspace = activeWorkspace(getState());
      if (action === "sort") {
        const sortBy = args[0];
        if (!["name", "date", "type"].includes(sortBy)) throw new Error("Folder sort must be name, date, or type.");
        dispatch({ type: "FOLDER_SORT_SET", payload: { sortBy } });
        return { sortBy };
      }
      if (action === "create-file" || action === "create-folder") {
        const name = args.join(" ").trim();
        if (!name) throw new Error(`Enter a name for the new ${action === "create-file" ? "file" : "folder"}.`);
        const created = action === "create-file"
          ? await backend.createFile(workspace.folder.path, name)
          : await backend.createFolder(workspace.folder.path, name);
        const entries = await backend.listDirectory(workspace.folder.path);
        dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
        return created;
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
      const path = args.join(" ") || activeWorkspace(getState()).viewer.path;
      if (!path) throw new Error("Choose a file path.");
      if (action === "external") {
        if (!actions.openExternal) throw new Error("External file opening is unavailable.");
        await actions.openExternal(path);
        return { path };
      }
      if (action !== "inspect" && action !== "open") throw new Error(`Unknown file action: ${action}`);
      const metadata = await backend.inspectFile(path);
      dispatch({ type: "FILE_SELECT", payload: { path, metadata, open: action === "open" } });
      if (action === "inspect") {
        openSubtab("viewer", context);
        return metadata;
      }
      if (!actions.openFileInWebview) throw new Error("File WebView opening is unavailable.");
      const fileView = await actions.openFileInWebview(path, metadata);
      openSubtab("webview", context);
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
      return { ...metadata, ...fileView };
    }

    if (domain === "terminal" && action === "run") {
      const command = extractCommandTail(input) || args.join(" ");
      if (!command) throw new Error("Enter a shell command.");
      const workspace = activeWorkspace(getState());
      dispatch({ type: "TERMINAL_RUNNING_SET", payload: { value: true } });
      const result = await backend.runCommand(command, workspace.terminal.cwd);
      appendOutput(dispatch, { ...result, command, kind: "command" });
      if (result.cwd && result.cwd !== workspace.terminal.cwd) {
        dispatch({ type: "WORKDIR_SET", payload: { path: result.cwd } });
        const entries = await backend.listDirectory(result.cwd);
        dispatch({ type: "FOLDER_ENTRIES_SET", payload: { entries } });
      }
      return result;
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
        dispatch({ type: "TERMINAL_RUNNING_SET", payload: { value: true } });
        const result = await backend.askAi({ prompt, model, cwd: workspace.terminal.cwd, attachScreenshot: state.settings.alwaysAttachScreenshot, attachments });
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
      if (action === "open") {
        let url = extractActionTail(input, "web", "open") || args.join(" ");
        if (!url) throw new Error("Enter a URL.");
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        const subtab = activeSubtab(getState());
        if (subtab.type !== "webview") openSubtab("webview", context);
        const current = activeSubtab(getState());
        dispatch({ type: "SUBTAB_UPDATE", payload: { id: current.id, patch: { url, title: "Web", filePath: null, fileMime: null } } });
        return { url };
      }
      if (["reload", "back", "forward", "external"].includes(action)) {
        const handler = actions[`web${action[0].toUpperCase()}${action.slice(1)}`];
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
      if (action === "copy") {
        const text = args.join(" ");
        if (!actions.copyText) throw new Error("Clipboard writing is unavailable.");
        await actions.copyText(text);
        return { copied: text.length };
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
      throw new Error(`Unknown record action: ${action}`);
    }

    if (domain === "media" && action === "attach") {
      if (!actions.attachMedia) throw new Error("Media attachment is unavailable.");
      await actions.attachMedia(args[0]);
      return { ok: true };
    }

    if (domain === "settings" && action === "open") {
      openSubtab("settings", context);
      return { ok: true };
    }

    if (domain === "settings" && action === "set") {
      const key = args.shift();
      if (!key) throw new Error("Choose a setting key.");
      const value = parseSettingValue(args.join(" "));
      dispatch({ type: "SETTING_SET", payload: { key, value } });
      await persistConfiguration(backend, getState());
      return { key, value };
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
