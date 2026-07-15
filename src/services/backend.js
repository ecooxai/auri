import { GeminiWakeSession, runGeminiLiveTurn } from "./gemini-live.js";
import { fileViewerPageHtml, isEditableTextFile, viewerKindForFile } from "./file-viewer-page.js";

export const SYSTEM_PROMPT = `You are Auri, a desktop assistant inside a terminal-centered workspace.
Be concise, practical, and direct.

Use these two response tags only when they add an actionable item to Auri's floating action panel:
- Wrap every complete executable shell command in <cmd>...</cmd>. Put only the command text inside the tag, with no Markdown fence or explanation. Put one complete item in each tag.
- Wrap standalone important or input-ready text in <i>...</i>. Use this for a key point, sentence, path, value, or exact text the user may want to insert or copy. Put one complete item in each tag.

Keep ordinary explanation outside the tags. Do not nest tags. Do not use arbitrary HTML. Never put a shell command in <i>; use <cmd> for shell commands.`;

export const LIVE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}
For voice turns, answer the user's request directly. Only repeat the user's spoken words if the user explicitly asks for dictation, to dictate text, or for voice input. When they do, put only the exact words they want entered inside a separate <i>...</i> tag. Otherwise, do not quote, paraphrase, transcribe, or repeat what the user said. Put any complete executable shell command in a separate <cmd>...</cmd> tag.`;

function tauriInvoke() {
  if (typeof window === "undefined") return null;
  return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || null;
}

function extension(path) {
  const name = String(path).split("/").pop() || "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

function titleForPath(path, fallback = "File") {
  return String(path || "").split("/").pop() || fallback;
}

export const LOCAL_FILE_SERVER_ORIGIN = "http://localhost:8890";

export function localFileServerOrigin(port = 8890) {
  const parsed = Number(port);
  const safePort = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8890;
  return `http://localhost:${safePort}`;
}

export function localFileUrl(path, port = 8890) {
  const absolute = String(path || "").replaceAll("\\", "/");
  const pathname = absolute.startsWith("/") ? absolute : `/${absolute}`;
  return `${localFileServerOrigin(port)}${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

export function localFileViewerUrl(path, port = 8890, mode = "view", options = {}) {
  const queryMode = mode === "edit" ? "edit" : "view";
  const query = [`${queryMode}=1`];
  if (options.autoplay) query.push("autoplay=1");
  if (options.compact) query.push("compact=1");
  return `${localFileUrl(path, port)}?${query.join("&")}`;
}


export function previewMimeForPath(path, reportedMime = "") {
  const ext = extension(path);
  const byExtension = {
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    wave: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    flac: "audio/flac",
    opus: "audio/ogg",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    blend: "application/x-blender",
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    obj: "model/obj",
    stl: "model/stl",
    txt: "text/plain",
    text: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    log: "text/plain",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    jsonl: "application/json",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    cjs: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    jsx: "text/javascript",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    toml: "text/plain",
    ini: "text/plain",
    rs: "text/plain",
    py: "text/x-python",
    sh: "text/x-shellscript"
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
  return fileViewerPageHtml({
    resourceUrl: mediaUrl,
    mime,
    title,
    path: title || "media"
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mediaKindForMime(mime, fallback = "file") {
  const value = String(mime || "");
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "audio";
  if (value.startsWith("video/")) return "video";
  return fallback || "file";
}

function nativeAssetUrl(path) {
  if (!path || typeof window === "undefined") return null;
  const convertFileSrc = window.__TAURI__?.core?.convertFileSrc || window.__TAURI_INTERNALS__?.convertFileSrc;
  try { return convertFileSrc ? convertFileSrc(path) : null; } catch { return null; }
}

function appAssetUrl(name) {
  if (typeof document === "undefined") return "";
  try {
    return new URL(name, document.baseURI || window.location.href).href;
  } catch {
    return "";
  }
}

export function isLinuxPlatform() {
  const nav = typeof window !== "undefined"
    ? window.navigator
    : typeof navigator !== "undefined"
      ? navigator
      : null;
  const value = `${nav?.platform || ""} ${nav?.userAgent || ""}`.toLowerCase();
  return value.includes("linux") && !value.includes("android");
}

function objectUrlForBinary(item) {
  if (!item?.base64 || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(new Blob([base64ToBytes(item.base64)], { type: item.mime || "application/octet-stream" }));
  } catch {
    return null;
  }
}

function requestMediaDetail(item, index = 0) {
  const mime = item?.mime || "application/octet-stream";
  const kind = item?.kind || mediaKindForMime(mime);
  return {
    id: String(item?.id || `request-media-${Date.now()}-${index}`),
    name: item?.name || `Attachment ${index + 1}`,
    kind,
    mime,
    path: item?.path || null,
    url: item?.url || item?.assetUrl || nativeAssetUrl(item?.path) || objectUrlForBinary(item)
  };
}

function browserSystemSnapshot() {
  const memory = typeof performance !== "undefined" && performance.memory
    ? { totalBytes: performance.memory.jsHeapSizeLimit || 0, usedBytes: performance.memory.usedJSHeapSize || 0, freeBytes: Math.max(0, (performance.memory.jsHeapSizeLimit || 0) - (performance.memory.usedJSHeapSize || 0)), swapTotalBytes: 0, swapUsedBytes: 0, swapFreeBytes: 0, swapUsagePercent: null }
    : { totalBytes: 0, usedBytes: 0, freeBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, swapFreeBytes: 0, swapUsagePercent: null };
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 0 : 0;
  const platform = typeof navigator !== "undefined" ? navigator.platform || "Browser" : "Browser";
  return {
    capturedAt: new Date().toISOString(),
    host: { os: platform, arch: "browser", hostname: "browser-preview", uptimeSeconds: Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : 0) / 1000) },
    cpu: { brand: platform, cores, usagePercent: null },
    memory,
    network: { interfaces: [{ name: "browser", ip: "Unavailable in browser preview", status: "preview", rxBytes: 0, txBytes: 0 }], downloadBytesPerSecond: null, uploadBytesPerSecond: null, totalRxBytes: 0, totalTxBytes: 0 },
    disk: { mounts: [], totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: null, readBytesPerSecond: null, writeBytesPerSecond: null },
    gpus: [],
    processes: []
  };
}

function browserEntries(path) {
  const base = String(path || "~").replace(/\/$/, "");
  return [
    { name: "Projects", path: `${base}/Projects`, kind: "directory", size: 0, modified: Date.now() - 400000 },
    { name: "media", path: `${base}/media`, kind: "directory", size: 0, modified: Date.now() - 300000 },
    { name: "README.md", path: `${base}/README.md`, kind: "file", size: 8240, modified: Date.now() - 200000 },
    { name: "aurora.jpg", path: `${base}/aurora.jpg`, kind: "file", size: 1843200, modified: Date.now() - 100000 },
    { name: "notes.txt", path: `${base}/notes.txt`, kind: "file", size: 2940, modified: Date.now() }
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
    sampleRate: audio ? 48000 : null,
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
    this.fileServerInfo = null;
    this.fileServerPromise = null;
    this.browserClipboardHistory = [
      { id: "clip-1", kind: "text", text: "auri tab new Research", createdAt: new Date().toISOString(), pinned: false },
      { id: "clip-2", kind: "text", text: "Auri keeps commands testable and automatable.", createdAt: new Date().toISOString(), pinned: false }
    ];
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
  async isTerminalBusy(sessionId) { return this.call("terminal_busy", { sessionId }); }
  async resizeTerminal(sessionId, cols, rows) { return this.call("terminal_resize", { sessionId, cols, rows }); }
  async stopTerminal(sessionId) { return this.call("terminal_stop", { sessionId }); }

  async startWindowDragging() { return this.call("window_start_dragging"); }

  async exitApp() {
    if (!this.invoke) {
      if (typeof window !== "undefined") window.close?.();
      return { ok: true };
    }
    return this.call("app_exit");
  }

  async setVisibleOnAllWorkspaces(enabled) {
    if (!this.invoke) return { supported: false, enabled: Boolean(enabled), mode: "browser-preview" };
    return this.call("window_set_visible_on_all_workspaces", { enabled: Boolean(enabled) });
  }

  async showWebview(id, url, bounds, navigate = false, aiPrompts = null) {
    return this.call("webview_show", { id, url, navigate, aiPrompts, ...bounds });
  }

  async hideWebviews() {
    if (!this.invoke) return;
    return this.call("webview_hide_all");
  }

  async showBrowserOverlay(payload, bounds) {
    if (!this.invoke) return;
    return this.call("webview_overlay_show", { payload: JSON.stringify(payload), ...bounds });
  }

  async hideBrowserOverlay() {
    if (!this.invoke) return;
    return this.call("webview_overlay_hide");
  }

  async updateBrowserOverlayZoom(value) {
    if (!this.invoke) return;
    return this.call("webview_overlay_update_zoom", { value });
  }

  async webviewAction(id, action, value = null) {
    if (!this.invoke) throw new Error("Website navigation needs the native Tauri build.");
    return this.call("webview_action", { id, action, value });
  }

  async openExternalUrl(url) {
    if (!this.invoke) {
      if (typeof window !== "undefined") return window.open(url, "_blank", "noopener,noreferrer");
      throw new Error("External browser opening is unavailable.");
    }
    return this.call("open_external_url", { url });
  }

  async closeWebview(id) {
    if (!this.invoke) return;
    return this.call("webview_close", { id });
  }

  async showStandaloneTab(id, url, title) {
    if (!this.invoke) throw new Error("Standalone tab windows need the native Auri build.");
    return this.call("tab_window_show", { id, url, title });
  }

  async reloadStandaloneTab(id) {
    if (!this.invoke) return;
    return this.call("tab_window_reload", { id });
  }

  async closeStandaloneTab(id) {
    if (!this.invoke) return;
    return this.call("tab_window_close", { id });
  }

  async initialize() {
    if (!this.invoke) return { root: "~", mode: "browser-preview" };
    return this.call("initialize_workspace");
  }

  async takePendingOpenFiles() {
    if (!this.invoke) return [];
    return this.call("take_pending_open_files");
  }

  async readShellHistory() {
    if (!this.invoke) return [];
    return this.call("read_shell_history");
  }

  async systemSnapshot(options = {}) {
    if (!this.invoke) return browserSystemSnapshot();
    return this.call("system_snapshot", { includeGpus: Boolean(options.includeGpus) });
  }

  async searchPathCommands(query) {
    if (!this.invoke) return [];
    return this.call("search_path_commands", { query: String(query || "") });
  }

  async killProcess(pid) {
    if (!this.invoke) throw new Error("Killing processes needs the native Tauri build.");
    return this.call("kill_process", { pid: Number(pid) });
  }

  async setProcessPriority(pid, nice) {
    if (!this.invoke) throw new Error("Changing process priority needs the native Tauri build.");
    return this.call("set_process_priority", { pid: Number(pid), nice: Number(nice) });
  }

  async setProcessPriorityPrivileged(pid, nice, password, method) {
    if (!this.invoke) throw new Error("Administrator priority authorization needs the native Tauri build.");
    return this.call("set_process_priority_privileged", {
      pid: Number(pid),
      nice: Number(nice),
      password: String(password || ""),
      method: String(method || "")
    });
  }

  async cloudflaredActiveTunnels() {
    if (!this.invoke) return [];
    return this.call("cloudflared_active_tunnels");
  }

  async cloudflaredStatus() {
    if (!this.invoke) return { available: false, path: "" };
    return this.call("cloudflared_status");
  }

  async startCloudflaredTunnel({ port, installIfMissing = false }) {
    if (!this.invoke) throw new Error("Cloudflare tunnels need the native Tauri build.");
    return this.call("cloudflared_start_tunnel", { port: Number(port), installIfMissing: Boolean(installIfMissing) });
  }

  async stopCloudflaredTunnel(port) {
    if (!this.invoke) throw new Error("Cloudflare tunnels need the native Tauri build.");
    return this.call("cloudflared_stop_tunnel", { port: Number(port) });
  }

  async startFileServer(root) {
    if (!this.invoke) throw new Error("The web file viewer needs the native Auri build.");
    if (this.fileServerInfo) return this.fileServerInfo;
    if (!this.fileServerPromise) {
      this.fileServerPromise = this.call("fileserver_start")
        .then((info) => {
          this.fileServerInfo = info;
          return info;
        })
        .finally(() => { this.fileServerPromise = null; });
    }
    return this.fileServerPromise;
  }

  async listDirectory(path) {
    if (!this.invoke) return browserEntries(path);
    return this.call("list_directory", { path });
  }

  async inspectFile(path) {
    if (!this.invoke) return browserMetadata(path);
    return this.call("inspect_file", { path });
  }

  async createFile(directory, name) {
    if (!this.invoke) throw new Error("Creating files needs the native Tauri build.");
    return this.call("create_file", { directory, name });
  }

  async createFolder(directory, name) {
    if (!this.invoke) throw new Error("Creating folders needs the native Tauri build.");
    return this.call("create_folder", { directory, name });
  }

  async folderInfo(path) {
    if (!this.invoke) throw new Error("Folder ownership, permissions, and disk information need the native Tauri build.");
    return this.call("folder_info", { path });
  }


  createFileViewPage({ resourceUrl = "", mime = "application/octet-stream", title = "File", path = "", text = null, autoplay = false, compact = false }) {
    const page = new Blob([fileViewerPageHtml({
      resourceUrl,
      mime,
      title,
      path,
      text,
      autoplay,
      compact,
      codemirrorModuleUrl: appAssetUrl("codemirror-viewer.js"),
      threeModuleUrl: appAssetUrl("three-viewer.js")
    })], { type: "text/html" });
    return URL.createObjectURL(page);
  }

  async createFileView(path, metadata = {}, options = {}) {
    const autoplay = Boolean(options.autoplay);
    const compact = Boolean(options.compact);
    if (!this.invoke) {
      const item = browserMetadata(path);
      const mime = options.asText ? "text/plain" : previewMimeForPath(path, metadata.mime);
      const title = metadata.name || item.name || titleForPath(path);
      const text = options.asText || isEditableTextFile(path, mime)
        ? item.preview || `Preview for ${path}`
        : null;
      const url = this.createFileViewPage({ mime, title, path, text, autoplay, compact });
      return { url, title, filePath: path, mime: "text/html", mediaMime: mime, viewerKind: viewerKindForFile(path, mime) };
    }

    const isDirectory = metadata.kind === "directory" || metadata.mime === "inode/directory";
    const mediaMime = isDirectory
      ? "inode/directory"
      : options.asText ? "text/plain" : previewMimeForPath(path, metadata.mime || "");
    const title = metadata.name || titleForPath(path);
    const server = await this.startFileServer("/");
    const resourceUrl = localFileUrl(path, server.port);
    if (isDirectory) {
      return {
        url: resourceUrl,
        resourceUrl,
        title,
        filePath: path,
        mime: "text/html",
        mediaMime,
        viewerKind: "directory"
      };
    }
    const mode = options.asText ? "edit" : "view";
    const isHtml = mediaMime.toLowerCase() === "text/html" || /\.html?$/i.test(String(path || ""));
    return {
      url: localFileViewerUrl(path, server.port, mode, { autoplay, compact }),
      resourceUrl,
      title,
      filePath: path,
      mime: "text/html",
      mediaMime,
      viewerKind: options.asText ? "text" : isHtml ? "html" : viewerKindForFile(path, mediaMime)
    };
  }

  releaseFileView(url) {
    if (typeof url !== "string" || !url.startsWith("blob:")) return;
    const resources = this.fileViewResources.get(url) || [];
    for (const resourceUrl of resources) URL.revokeObjectURL(resourceUrl);
    this.fileViewResources.delete(url);
    URL.revokeObjectURL(url);
  }

  async readFile(path) {
    if (!this.invoke) return browserMetadata(path).preview || "Preview is available in the native build.";
    return this.call("read_text_file", { path });
  }

  async writeTextFile(path, content) {
    if (!this.invoke) {
      return { path, size: String(content ?? "").length, browserPreview: true };
    }
    return this.call("write_text_file", { path, content });
  }

  async convertMediaFile({ path, format, bitrateKbps = 4000, sampleRate = null, resolution = "native" }) {
    if (!this.invoke) throw new Error("Media conversion needs the native Tauri build with ffmpeg installed.");
    const normalizedSampleRate = sampleRate && sampleRate !== "original" ? Number(sampleRate) : null;
    return this.call("convert_media_file", {
      path,
      format,
      bitrateKbps: Number(bitrateKbps) || 4000,
      sampleRate: normalizedSampleRate,
      resolution: resolution || "native"
    });
  }

  async saveConvertedMediaFile({ sourcePath, tempPath, name }) {
    if (!this.invoke) throw new Error("Saving converted media needs the native Tauri build.");
    return this.call("save_converted_media_file", { sourcePath, tempPath, name });
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

  async getMediaPermissions() {
    if (!this.invoke) {
      return { platform: "browser", microphone: "unavailable", screenRecording: "unavailable", systemAudio: "unavailable" };
    }
    return this.call("media_permission_status");
  }

  async requestMediaPermission(permission) {
    if (!this.invoke) {
      if (permission !== "microphone" || !navigator.mediaDevices?.getUserMedia) {
        return this.getMediaPermissions();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return { platform: "browser", microphone: "authorized", screenRecording: "unavailable", systemAudio: "unavailable" };
    }
    return this.call("request_media_permission", { permission });
  }

  async askAi({ prompt, model, attachScreenshot, attachments = [], onRequest }) {
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
    const sentMedia = [screenshot, ...inlineAttachments].filter(Boolean).map(requestMediaDetail);
    await onRequest?.({ text: prompt, modelName: model.name, media: sentMedia });
    if (model.type === "openai" || model.type === "openai-live") {
      return this.askOpenAi({ prompt, model, screenshot, attachments: inlineAttachments, systemPrompt: model.type === "openai-live" ? LIVE_SYSTEM_PROMPT : SYSTEM_PROMPT });
    }
    if (model.type === "gemini-live") {
      const media = [...inlineAttachments];
      if (screenshot?.base64) {
        media.unshift({ name: screenshot.name || "screenshot.jpg", mime: screenshot.mime || "image/jpeg", base64: screenshot.base64 });
      }
      return runGeminiLiveTurn({ prompt, model, systemPrompt: LIVE_SYSTEM_PROMPT, media });
    }
    if (model.type === "gemini") {
      return this.askGemini({ prompt, model, screenshot, attachments: inlineAttachments });
    }
    throw new Error(`Unsupported API type: ${model.type}`);
  }

  async startWakeLiveSession(options) {
    const { model, screenshot, inactivitySeconds, onStatus, onText, onResult, onError, onRequest } = options;
    if (!model || model.type !== "gemini-live") throw new Error("Select a Gemini Live model.");
    const session = new GeminiWakeSession({ model, systemPrompt: LIVE_SYSTEM_PROMPT, screenshot, inactivitySeconds, onStatus, onText, onResult, onError, onRequest });
    await session.start();
    return session;
  }

  async prepareAttachments(attachments) {
    const output = [];
    for (const item of attachments) {
      if (item.file || item.blob) {
        const source = item.file || item.blob;
        output.push({
          id: item.id,
          name: item.name,
          kind: item.kind,
          mime: item.mime || source.type || "application/octet-stream",
          base64: await blobToBase64(source),
          path: item.path || null,
          url: item.url || item.assetUrl || (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(source) : null)
        });
      } else if (item.path && this.invoke) {
        const binary = await this.call("read_binary_file", { path: item.path });
        output.push({ ...binary, id: item.id, kind: item.kind || mediaKindForMime(binary.mime), url: item.url || item.assetUrl || nativeAssetUrl(item.path) });
      }
    }
    return output;
  }

  async askOpenAi({ prompt, model, screenshot, attachments, systemPrompt = SYSTEM_PROMPT }) {
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
      body: JSON.stringify({ model: model.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content }] })
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

  async writeClipboardText(text) {
    if (!this.invoke) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
      }
      throw new Error("Clipboard writing is unavailable.");
    }
    return this.call("set_clipboard_text", { text: String(text ?? "") });
  }

  decorateClipboardItems(items) {
    const result = items.map((item) => ({ ...item }));
    const convertFileSrc = typeof window === "undefined"
      ? null
      : window.__TAURI__?.core?.convertFileSrc || window.__TAURI_INTERNALS__?.convertFileSrc;
    if (convertFileSrc) {
      for (const item of result) {
        if (item.kind === "image" && item.path) item.assetUrl = convertFileSrc(item.path);
      }
    }
    return result;
  }

  async readClipboardHistory() {
    if (!this.invoke) return this.decorateClipboardItems(this.browserClipboardHistory);
    return this.decorateClipboardItems(await this.call("read_clipboard_history"));
  }

  async setClipboardPinned(id, pinned) {
    if (!this.invoke) {
      const item = this.browserClipboardHistory.find((entry) => entry.id === id);
      if (!item) throw new Error("Clipboard item was not found.");
      item.pinned = Boolean(pinned);
      return this.decorateClipboardItems(this.browserClipboardHistory);
    }
    return this.decorateClipboardItems(await this.call("set_clipboard_pinned", { id, pinned: Boolean(pinned) }));
  }

  async updateClipboardItem(id, text) {
    if (!this.invoke) {
      const item = this.browserClipboardHistory.find((entry) => entry.id === id);
      if (!item) throw new Error("Clipboard item was not found.");
      if (item.kind !== "text") throw new Error("Only text clipboard items can be edited.");
      item.text = String(text ?? "");
      return this.decorateClipboardItems(this.browserClipboardHistory);
    }
    return this.decorateClipboardItems(await this.call("update_clipboard_entry", { id, text: String(text ?? "") }));
  }

  async copyClipboardItem(id) {
    if (!this.invoke) {
      const item = this.browserClipboardHistory.find((entry) => entry.id === id);
      if (!item) throw new Error("Clipboard item was not found.");
      if (item.kind === "text") return this.writeClipboardText(item.text || "");
      throw new Error("Copying images to the clipboard needs the native build.");
    }
    return this.call("copy_clipboard_entry", { id });
  }

  async removeClipboardItem(id) {
    if (!this.invoke) {
      const index = this.browserClipboardHistory.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("Clipboard item was not found.");
      this.browserClipboardHistory.splice(index, 1);
      return this.decorateClipboardItems(this.browserClipboardHistory);
    }
    return this.decorateClipboardItems(await this.call("remove_clipboard_entry", { id }));
  }

  async setWakeShortcut(shortcut) {
    if (!this.invoke) return { shortcut };
    return this.call("set_wake_shortcut", { shortcut });
  }

  async saveSettings(settings) {
    if (!this.invoke) {
      localStorage.setItem("auri-settings", JSON.stringify(settings));
      return { ok: true };
    }
    return this.call("save_settings", { settings });
  }
}
