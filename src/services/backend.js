import { GeminiWakeSession, runGeminiLiveTurn } from "./gemini-live.js";

const SYSTEM_PROMPT = `You are Auri, a desktop assistant inside a terminal-centered workspace.
Be concise and practical. When the user asks you to input, type, or transcribe what they spoke, first repeat the exact recognized words inside <i></i> tags on their own line, then continue with the answer. Never place other content inside <i></i> tags.`;

function tauriInvoke() {
  if (typeof window === "undefined") return null;
  return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || null;
}

function extension(path) {
  const name = String(path).split("/").pop() || "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}


export function previewMimeForPath(path, reportedMime = "") {
  const ext = extension(path);
  const byExtension = {
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/plain",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "text/javascript"
  };
  return byExtension[ext] || (reportedMime && reportedMime !== "application/octet-stream" ? reportedMime : "application/octet-stream");
}


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function mediaPageHtml({ mediaUrl, mime, title }) {
  const safeUrl = escapeHtml(mediaUrl);
  const safeMime = escapeHtml(mime);
  const safeTitle = escapeHtml(title);
  const tag = String(mime).startsWith("video/") ? "video" : "audio";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f4f7fa;font:14px system-ui,sans-serif;color:#172033}.media{width:min(900px,calc(100% - 48px));display:grid;gap:18px;text-align:center}.media h1{font-size:16px;margin:0;overflow-wrap:anywhere}.media audio{width:min(560px,100%);justify-self:center}.media video{width:100%;max-height:calc(100vh - 110px);background:#111827;border-radius:16px}
</style>
</head>
<body><main class="media"><h1>${safeTitle}</h1><${tag} controls preload="metadata"><source src="${safeUrl}" type="${safeMime}">This media format is not supported.</${tag}></main></body>
</html>`;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function browserEntries(path) {
  const base = String(path || "~").replace(/\/$/, "");
  return [
    { name: "Projects", path: `${base}/Projects`, kind: "directory", size: 0 },
    { name: "media", path: `${base}/media`, kind: "directory", size: 0 },
    { name: "README.md", path: `${base}/README.md`, kind: "file", size: 8240 },
    { name: "aurora.jpg", path: `${base}/aurora.jpg`, kind: "file", size: 1843200 },
    { name: "notes.txt", path: `${base}/notes.txt`, kind: "file", size: 2940 }
  ];
}

function browserMetadata(path) {
  const ext = extension(path);
  const image = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  const audio = ["wav", "m4a", "mp3", "ogg", "flac"].includes(ext);
  const video = ["mp4", "mov", "webm", "mkv"].includes(ext);
  const text = ["txt", "md", "json", "js", "ts", "rs", "html", "css"].includes(ext);
  return {
    path,
    name: String(path).split("/").pop(),
    kind: image ? "image" : audio ? "audio" : video ? "video" : text ? "text" : "file",
    fileType: ext ? ext.toUpperCase() : "File",
    size: image ? 1843200 : text ? 2940 : 0,
    width: image ? 2560 : null,
    height: image ? 1440 : null,
    codec: audio ? "AAC" : video ? "H.264 / AAC" : null,
    bitrate: audio ? 64000 : video ? 4200000 : null,
    modified: new Date().toISOString(),
    preview: text ? "Auri browser preview\n\nNative file contents are available in the Tauri build." : null
  };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export class Backend {
  constructor() {
    this.invoke = tauriInvoke();
    this.fileViewResources = new Map();
  }

  get isNative() {
    return Boolean(this.invoke);
  }

  async call(command, payload = {}) {
    if (!this.invoke) throw new Error("This action needs the native Tauri build.");
    return this.invoke(command, payload);
  }

  async listenForCommands(handler) {
    if (typeof window === "undefined") return null;
    const listen = window.__TAURI__?.event?.listen;
    if (!listen) return null;
    return listen("auri-command", (event) => handler(String(event.payload ?? "")));
  }

  async listen(eventName, handler) {
    if (typeof window === "undefined") return null;
    const listen = window.__TAURI__?.event?.listen;
    if (!listen) return null;
    return listen(eventName, (event) => handler(event.payload));
  }

  async startTerminal(sessionId, cwd, cols, rows) { return this.call("terminal_start", { sessionId, cwd, cols, rows }); }
  async writeTerminal(sessionId, data) { return this.call("terminal_write", { sessionId, data: Array.from(data) }); }
  async getTerminalCwd(sessionId) { return this.call("terminal_cwd", { sessionId }); }
  async resizeTerminal(sessionId, cols, rows) { return this.call("terminal_resize", { sessionId, cols, rows }); }
  async stopTerminal(sessionId) { return this.call("terminal_stop", { sessionId }); }

  async startWindowDragging() { return this.call("window_start_dragging"); }

  async showWebview(id, url, bounds, navigate = false) {
    return this.call("webview_show", { id, url, navigate, ...bounds });
  }

  async hideWebviews() {
    if (!this.invoke) return;
    return this.call("webview_hide_all");
  }

  async webviewAction(id, action) {
    if (!this.invoke) throw new Error("Website navigation needs the native Tauri build.");
    return this.call("webview_action", { id, action });
  }

  async closeWebview(id) {
    if (!this.invoke) return;
    return this.call("webview_close", { id });
  }

  async initialize() {
    if (!this.invoke) return { root: "~", mode: "browser-preview" };
    return this.call("initialize_workspace");
  }

  async listDirectory(path) {
    if (!this.invoke) return browserEntries(path);
    return this.call("list_directory", { path });
  }

  async inspectFile(path) {
    if (!this.invoke) return browserMetadata(path);
    return this.call("inspect_file", { path });
  }


  async createFileView(path) {
    if (!this.invoke) {
      const metadata = browserMetadata(path);
      const blob = new Blob([metadata.preview || `Preview for ${path}`], { type: "text/plain" });
      return { url: URL.createObjectURL(blob), title: metadata.name, filePath: path, mime: blob.type };
    }
    const file = await this.call("read_binary_file", { path });
    const mime = previewMimeForPath(path, file.mime);
    const mediaBlob = new Blob([base64ToBytes(file.base64)], { type: mime });
    const resourceUrl = URL.createObjectURL(mediaBlob);
    if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      const page = new Blob([mediaPageHtml({ mediaUrl: resourceUrl, mime, title: file.name })], { type: "text/html" });
      const url = URL.createObjectURL(page);
      this.fileViewResources.set(url, resourceUrl);
      return { url, title: file.name, filePath: path, mime: "text/html", mediaMime: mime };
    }
    return { url: resourceUrl, title: file.name, filePath: path, mime };
  }

  releaseFileView(url) {
    if (typeof url !== "string" || !url.startsWith("blob:")) return;
    const resourceUrl = this.fileViewResources.get(url);
    if (resourceUrl) {
      URL.revokeObjectURL(resourceUrl);
      this.fileViewResources.delete(url);
    }
    URL.revokeObjectURL(url);
  }

  async readFile(path) {
    if (!this.invoke) return browserMetadata(path).preview || "Preview is available in the native build.";
    return this.call("read_text_file", { path });
  }

  async runCommand(command, cwd) {
    if (this.invoke) return this.call("run_command", { command, cwd });

    const trimmed = String(command).trim();
    if (trimmed === "pwd") return { stdout: `${cwd}\n`, stderr: "", code: 0, cwd };
    if (trimmed === "ls") {
      const names = browserEntries(cwd).map((entry) => entry.name).join("  ");
      return { stdout: `${names}\n`, stderr: "", code: 0, cwd };
    }
    if (trimmed.startsWith("echo ")) return { stdout: `${trimmed.slice(5)}\n`, stderr: "", code: 0, cwd };
    if (trimmed === "date") return { stdout: `${new Date().toString()}\n`, stderr: "", code: 0, cwd };
    if (trimmed === "clear") return { stdout: "", stderr: "", code: 0, cwd, clear: true };
    if (trimmed === "cd" || trimmed.startsWith("cd ")) {
      const next = trimmed.slice(2).trim() || "~";
      return { stdout: "", stderr: "", code: 0, cwd: next };
    }
    return {
      stdout: "",
      stderr: `“${trimmed}” requires the native Tauri terminal. Browser preview supports pwd, ls, cd, echo, date, and clear.\n`,
      code: 126,
      cwd
    };
  }

  async captureScreenshot() {
    if (!this.invoke) return null;
    return this.call("capture_screenshot");
  }

  async askAi({ prompt, model, attachScreenshot, attachments = [] }) {
    if (!model) throw new Error("Select an AI model in Settings.");
    if (!model.apiKey) throw new Error(`Add an API key for ${model.name} in Settings.`);

    let screenshot = null;
    if (attachScreenshot) {
      try {
        screenshot = await this.captureScreenshot();
      } catch (error) {
        throw new Error(`Could not capture the current screenshot: ${error.message || error}`);
      }
    }

    const inlineAttachments = await this.prepareAttachments(attachments);
    if (model.type === "openai" || model.type === "openai-live") {
      return this.askOpenAi({ prompt, model, screenshot, attachments: inlineAttachments });
    }
    if (model.type === "gemini-live") {
      const media = [...inlineAttachments];
      if (screenshot?.base64) {
        media.unshift({ name: screenshot.name || "screenshot.jpg", mime: screenshot.mime || "image/jpeg", base64: screenshot.base64 });
      }
      return runGeminiLiveTurn({ prompt, model, systemPrompt: SYSTEM_PROMPT, media });
    }
    if (model.type === "gemini") {
      return this.askGemini({ prompt, model, screenshot, attachments: inlineAttachments });
    }
    throw new Error(`Unsupported API type: ${model.type}`);
  }

  async startWakeLiveSession(options) {
    const { model, screenshot, inactivitySeconds, onStatus, onText, onResult, onError } = options;
    if (!model || model.type !== "gemini-live") throw new Error("Select a Gemini Live model.");
    const session = new GeminiWakeSession({ model, systemPrompt: SYSTEM_PROMPT, screenshot, inactivitySeconds, onStatus, onText, onResult, onError });
    await session.start();
    return session;
  }

  async prepareAttachments(attachments) {
    const output = [];
    for (const item of attachments) {
      if (item.file || item.blob) {
        const source = item.file || item.blob;
        output.push({ name: item.name, kind: item.kind, mime: item.mime || source.type || "application/octet-stream", base64: await blobToBase64(source) });
      } else if (item.path && this.invoke) {
        output.push(await this.call("read_binary_file", { path: item.path }));
      }
    }
    return output;
  }

  async askOpenAi({ prompt, model, screenshot, attachments }) {
    const endpoint = model.url || "https://api.openai.com/v1/chat/completions";
    const content = [{ type: "text", text: prompt }];
    if (screenshot?.base64) {
      content.push({ type: "image_url", image_url: { url: `data:${screenshot.mime || "image/jpeg"};base64,${screenshot.base64}` } });
    }
    for (const item of attachments) {
      if (item.mime?.startsWith("image/")) content.push({ type: "image_url", image_url: { url: `data:${item.mime};base64,${item.base64}` } });
      else content.push({ type: "text", text: `[Attached ${item.kind || "file"}: ${item.name}. This completion endpoint cannot directly decode this media type.]` });
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({ model: model.model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content }] })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `OpenAI request failed (${response.status}).`);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("The OpenAI response did not contain renderable text.");
    return { text };
  }

  async askGemini({ prompt, model, screenshot, attachments }) {
    const base = model.url || "https://generativelanguage.googleapis.com/v1beta";
    const endpoint = `${base.replace(/\/$/, "")}/models/${encodeURIComponent(model.model)}:generateContent?key=${encodeURIComponent(model.apiKey)}`;
    const parts = [{ text: prompt }];
    if (screenshot?.base64) parts.push({ inlineData: { mimeType: screenshot.mime || "image/jpeg", data: screenshot.base64 } });
    for (const item of attachments) parts.push({ inlineData: { mimeType: item.mime, data: item.base64 } });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: "user", parts }] })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Gemini request failed (${response.status}).`);
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) throw new Error("The Gemini response did not contain renderable text.");
    return { text };
  }

  async saveMedia({ name, kind, blob }) {
    if (!this.invoke) return { name, kind, path: null, size: blob.size, mime: blob.type };
    const base64 = await blobToBase64(blob);
    return this.call("save_media_file", { name, kind, base64 });
  }

  async pasteClipboardItem(id) {
    if (!this.invoke) throw new Error("Pasting into another application needs the native build.");
    return this.call("paste_clipboard_entry", { id });
  }

  async readClipboardHistory() {
    if (!this.invoke) {
      return [
        { id: "clip-1", kind: "text", text: "auri tab new Research", createdAt: new Date().toISOString() },
        { id: "clip-2", kind: "text", text: "Auri keeps commands testable and automatable.", createdAt: new Date().toISOString() }
      ];
    }
    const items = await this.call("read_clipboard_history");
    const convertFileSrc = window.__TAURI__?.core?.convertFileSrc || window.__TAURI_INTERNALS__?.convertFileSrc;
    if (convertFileSrc) {
      for (const item of items) {
        if (item.kind === "image" && item.path) item.assetUrl = convertFileSrc(item.path);
      }
    }
    return items;
  }

  async saveSettings(settings) {
    if (!this.invoke) {
      localStorage.setItem("auri-settings", JSON.stringify(settings));
      return { ok: true };
    }
    return this.call("save_settings", { settings });
  }
}
