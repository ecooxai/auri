import { terminalAssistantSegments } from "../model/assistant.js";

const encoder = new TextEncoder();
let terminalModulesPromise = null;

const TERMINAL_TARGET_PATTERN = /(?:https?:\/\/|file:\/\/\/)[^\s<>"'`]+|(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)(?:\\[ \t]|[^\s<>"'`])+/gi;
const TERMINAL_FILE_TOKEN_PATTERN = /(?:\\[ \t]|[^\s<>"'`()\[\]{},;])+/g;
const TERMINAL_TRAILING_PUNCTUATION = /[),.;:!?\]}]+$/;
const TERMINAL_FILE_EXTENSIONS = new Set([
  "aac", "aiff", "alac", "ape", "flac", "m4a", "mid", "midi", "mp3", "oga", "ogg", "opus", "wav", "wave", "wma",
  "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv",
  "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "psd", "svg", "tif", "tiff", "webp",
  "txt", "text", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "m", "mm", "cs", "java", "kt", "kts", "swift", "go", "rs",
  "py", "pyw", "rb", "php", "pl", "pm", "lua", "r", "dart", "scala", "sc", "groovy", "gradle", "clj", "cljs", "cljc",
  "ex", "exs", "erl", "hrl", "fs", "fsx", "fsi", "vb", "vbs", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "wasm", "wat",
  "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub",
  "blend", "dae", "fbx", "glb", "gltf", "obj", "ply", "stl", "3ds", "usd", "usda", "usdc", "usdz",
  "7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip", "zst",
  "apk", "dmg", "exe", "img", "iso", "jar", "deb", "rpm"
]);

function trimTerminalCandidate(value) {
  return String(value || "")
    .trim()
    .replace(TERMINAL_TRAILING_PUNCTUATION, "")
    .replace(/\\([ \t'"\\])/g, "$1");
}

function normalizeAbsolutePath(value) {
  const windows = /^[A-Za-z]:[\\/]/.test(value);
  const normalized = String(value || "").replaceAll("\\", "/");
  const prefix = windows ? normalized.slice(0, 2) : normalized.startsWith("/") ? "/" : "";
  const body = windows ? normalized.slice(2) : normalized;
  const parts = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (windows) return `${prefix}/${parts.join("/")}`;
  return `${prefix}${parts.join("/")}` || prefix || "/";
}

function inferredHome(cwd) {
  const match = String(cwd || "").match(/^\/(?:Users|home)\/[^/]+/);
  return match?.[0] || null;
}

function hasRecognizedFileExtension(value) {
  const path = String(value || "");
  if (!path || /[?#]/.test(path) || path.startsWith("-") || path.includes("=") || path.includes("@")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return false;
  if (/[|&*$<>]/.test(path)) return false;
  const name = path.replaceAll("\\", "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return TERMINAL_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function resolveTerminalPath(value, cwd) {
  let path = trimTerminalCandidate(value);
  if (/^file:\/\/\//i.test(path)) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return null; }
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) return normalizeAbsolutePath(path);
  if (path.startsWith("~/")) {
    const home = inferredHome(cwd);
    return home ? normalizeAbsolutePath(`${home}/${path.slice(2)}`) : path;
  }
  const explicitRelative = /^\.{1,2}\//.test(path);
  if (!explicitRelative && !hasRecognizedFileExtension(path)) return null;
  const base = String(cwd || "").replaceAll("\\", "/");
  return base.startsWith("/") || /^[A-Za-z]:\//.test(base)
    ? normalizeAbsolutePath(`${base}/${path}`)
    : path;
}

function parsedTerminalCandidate(raw, cwd) {
  const text = trimTerminalCandidate(raw);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      return { kind: "url", value: parsed.href, text };
    } catch {
      return null;
    }
  }
  const fileText = text.replace(/:(?:\d+)(?::\d+)?$/, "");
  const value = resolveTerminalPath(fileText, cwd);
  return value ? { kind: "file", value, text: fileText } : null;
}

function terminalCandidateSpans(input, cwd) {
  const text = String(input || "");
  const spans = [];
  const quoted = /(["'])([^"'\n]+)\1/g;
  for (const match of text.matchAll(quoted)) {
    const parsed = parsedTerminalCandidate(match[2], cwd);
    if (!parsed) continue;
    spans.push({ ...parsed, start: match.index + 1, end: match.index + 1 + match[2].length });
  }
  for (const pattern of [TERMINAL_TARGET_PATTERN, TERMINAL_FILE_TOKEN_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const parsed = parsedTerminalCandidate(match[0], cwd);
      if (!parsed) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (spans.some((item) => start >= item.start && end <= item.end)) continue;
      spans.push({ ...parsed, start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
}

export function extractTerminalPreviewTarget(input, cwd = "", cursorIndex = null) {
  const candidates = terminalCandidateSpans(input, cwd);
  const candidate = Number.isInteger(cursorIndex)
    ? candidates.find((item) => cursorIndex >= item.start && cursorIndex < item.end)
    : candidates[0];
  if (!candidate) return null;
  return { kind: candidate.kind, value: candidate.value, text: candidate.text };
}

export function terminalPreviewPlacement(anchor, viewport, size = { width: 450, height: 330 }) {
  const margin = 8;
  const gap = 8;
  const width = Math.max(1, Number(size.width) || 450);
  const height = Math.max(1, Number(size.height) || 330);
  const viewportWidth = Math.max(width + margin * 2, Number(viewport.width) || width + margin * 2);
  const viewportHeight = Math.max(height + margin * 2, Number(viewport.height) || height + margin * 2);
  const left = Math.min(viewportWidth - width - margin, Math.max(margin, Number(anchor.left) || margin));
  const below = (Number(anchor.bottom) || 0) + gap;
  const above = below + height > viewportHeight - margin;
  const top = above
    ? Math.max(margin, (Number(anchor.top) || 0) - gap - height)
    : Math.min(viewportHeight - height - margin, below);
  return { left, top, above };
}

async function loadTerminalModules() {
  if (!terminalModulesPromise) {
    terminalModulesPromise = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit")
    ]).then(([xtermModule, fitAddonModule]) => ({
      Terminal: xtermModule.Terminal || xtermModule.default?.Terminal,
      FitAddon: fitAddonModule.FitAddon || fitAddonModule.default?.FitAddon
    }));
  }
  return terminalModulesPromise;
}

function mediaRows(kind) {
  if (kind === "image") return 14;
  if (kind === "video") return 16;
  if (kind === "audio") return 5;
  return 3;
}

function snapshotMedia(item) {
  return {
    name: item?.name || "Attachment",
    kind: item?.kind || "file",
    mime: item?.mime || "application/octet-stream",
    url: item?.url || item?.assetUrl || null,
    path: item?.path || null
  };
}

export class TerminalSession {
  constructor(backend, assistantActions = {}) {
    this.backend = backend;
    this.assistantActions = assistantActions;
    this.sessionId = `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.term = null;
    this.fitAddon = null;
    this.mountedElement = null;
    this.started = false;
    this.output = [];
    this.outputBytes = 0;
    this.maxOutputBytes = 2097152;
    this.unlisten = [];
    this.cwd = "~";
    this.startPromise = null;
    this.mountGeneration = 0;
    this.cwdMarkerBuffer = "";
    this.cwdRefreshTimer = null;
    this.onCwdChange = null;
    this.renderQueue = Promise.resolve();
    this.assistantStreamAtLineStart = true;
    this.clipboardAbort = null;
    this.previewElement = null;
    this.previewData = null;
    this.previewRequest = 0;
    this.previewDocumentAbort = null;
    this.previewPointerDown = null;
  }

  async initialize() {
    if (!this.backend.isNative) return;
    const offData = await this.backend.listen("terminal-data", (payload) => {
      if (payload?.sessionId !== this.sessionId) return;
      const bytes = new Uint8Array(payload.data || []);
      const visible = this.consumeTerminalData(bytes);
      if (!visible.byteLength) return;
      this.appendRecord({ type: "bytes", bytes: visible });
    });
    const offExit = await this.backend.listen("terminal-exit", (payload) => {
      if (payload?.sessionId === this.sessionId) this.started = false;
    });
    this.unlisten.push(offData, offExit);
  }

  consumeTerminalData(bytes) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let text = this.cwdMarkerBuffer + decoder.decode(bytes);
    this.cwdMarkerBuffer = "";
    const markerStart = String.fromCharCode(27) + "]777;auri-cwd=";
    const markerEnd = String.fromCharCode(7);
    let visible = "";

    while (text) {
      const start = text.indexOf(markerStart);
      if (start < 0) {
        const escapeIndex = text.lastIndexOf(String.fromCharCode(27));
        if (escapeIndex >= 0 && markerStart.startsWith(text.slice(escapeIndex))) {
          visible += text.slice(0, escapeIndex);
          this.cwdMarkerBuffer = text.slice(escapeIndex);
        } else {
          visible += text;
        }
        break;
      }

      visible += text.slice(0, start);
      const end = text.indexOf(markerEnd, start + markerStart.length);
      if (end < 0) {
        this.cwdMarkerBuffer = text.slice(start);
        break;
      }

      const cwd = text.slice(start + markerStart.length, end);
      if (cwd && cwd !== this.cwd) {
        this.cwd = cwd;
        Promise.resolve(this.onCwdChange?.(cwd)).catch((error) => {
          console.error("Could not synchronize terminal directory", error);
        });
      }
      text = text.slice(end + markerEnd.length);
    }

    return encoder.encode(visible);
  }

  recordByteLength(record) {
    return record?.type === "bytes" ? record.bytes?.byteLength || 0 : 0;
  }

  remember(record) {
    this.output.push(record);
    this.outputBytes += this.recordByteLength(record);
    while (this.outputBytes > this.maxOutputBytes && this.output.length > 1) {
      this.outputBytes -= this.recordByteLength(this.output.shift());
    }
  }

  appendRecord(record) {
    this.remember(record);
    if (this.term) this.queueRender(record, this.mountGeneration);
  }

  queueRender(record, generation) {
    this.renderQueue = this.renderQueue
      .then(() => {
        if (!this.term || generation !== this.mountGeneration) return;
        return this.renderRecord(record, generation);
      })
      .catch((error) => {
        console.error("Could not render terminal output", error);
      });
    return this.renderQueue;
  }

  writeToTerminal(data, generation) {
    return new Promise((resolve) => {
      if (!this.term || generation !== this.mountGeneration) {
        resolve();
        return;
      }
      this.term.write(data, resolve);
    });
  }

  async renderRecord(record, generation) {
    if (record.type === "media") {
      await this.renderInlineMedia(record.item, generation);
      return;
    }
    await this.writeToTerminal(record.bytes, generation);
  }

  populateMediaElement(element, item) {
    if (element.dataset.auriMediaReady === "true") return;
    element.dataset.auriMediaReady = "true";
    element.classList.add("terminal-inline-media", `is-${item.kind}`);
    element.style.pointerEvents = "auto";

    const document = element.ownerDocument;
    const card = document.createElement("div");
    card.className = "terminal-inline-media-card";

    if (item.kind === "image" && item.url) {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = item.name;
      image.loading = "lazy";
      card.append(image);
    } else if (item.kind === "video" && item.url) {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      video.preload = "metadata";
      card.append(video);
    } else if (item.kind === "audio" && item.url) {
      const audio = document.createElement("audio");
      audio.src = item.url;
      audio.controls = true;
      audio.preload = "metadata";
      card.append(audio);
    }

    const caption = document.createElement("div");
    caption.className = "terminal-inline-media-caption";
    const icon = item.kind === "image" ? "◈" : item.kind === "audio" ? "♪" : item.kind === "video" ? "▷" : "◇";
    caption.textContent = `${icon} ${item.name}`;
    card.append(caption);
    element.replaceChildren(card);
  }

  async renderInlineMedia(rawItem, generation) {
    if (!this.term || generation !== this.mountGeneration) return;
    const item = snapshotMedia(rawItem);
    const rows = mediaRows(item.kind);
    const marker = this.term.registerMarker(0);
    if (!marker) return;

    const decoration = this.term.registerDecoration({
      marker,
      width: Math.max(1, this.term.cols),
      height: rows,
      layer: "top"
    });
    if (decoration) {
      const render = (element) => this.populateMediaElement(element, item);
      decoration.onRender(render);
      if (decoration.element) render(decoration.element);
    }

    await this.writeToTerminal("\r\n".repeat(rows), generation);
  }

  async mount(element, cwd = "~", fontSize = 20, maxLines = 4000) {
    if (!element) return;
    if (!this.started) this.cwd = cwd || this.cwd;
    const lineLimit = Math.min(100000, Math.max(100, Number(maxLines) || 4000));
    const terminalFontSize = Math.round(Math.min(30, Math.max(14, Number(fontSize) || 20)) * 0.6);

    if (this.term && this.mountedElement === element) {
      this.term.options.scrollback = lineLimit;
      this.term.options.fontSize = terminalFontSize;
      this.fitAddon?.fit();
      if (!this.started && this.backend.isNative) {
        await this.ensureStarted(this.cwd, this.term.cols, this.term.rows);
      } else if (this.started) {
        this.backend.resizeTerminal(this.sessionId, this.term.cols, this.term.rows).catch(() => {});
      }
      return;
    }

    const generation = ++this.mountGeneration;
    this.clipboardAbort?.abort();
    this.dismissPreview();
    this.term?.dispose();
    const { Terminal, FitAddon } = await loadTerminalModules();
    this.fitAddon = new FitAddon();
    this.term = new Terminal({
      cursorBlink: true,
      scrollback: lineLimit,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: terminalFontSize,
      lineHeight: 1.25,
      theme: {
        background: "#f8fbff",
        foreground: "#24324a",
        cursor: "#7089f8",
        cursorAccent: "#f8fbff",
        selectionBackground: "#cfd9ff99",
        black: "#24324a",
        red: "#c65d6a",
        green: "#3f9277",
        yellow: "#a97726",
        blue: "#546be1",
        magenta: "#8b62c8",
        cyan: "#318f96",
        white: "#e7ecf3",
        brightBlack: "#7a879b",
        brightRed: "#d86b78",
        brightGreen: "#5ebc99",
        brightYellow: "#c49138",
        brightBlue: "#7089f8",
        brightMagenta: "#a87ce5",
        brightCyan: "#58b9bd",
        brightWhite: "#ffffff"
      }
    });
    this.term.loadAddon(this.fitAddon);
    this.term.open(element);
    this.mountedElement = element;
    this.installClipboardHandlers(element);
    this.fitAddon.fit();
    this.renderQueue = Promise.resolve();
    for (const record of this.output) this.queueRender(record, generation);

    this.term.onData((data) => {
      if (data.includes("\r") || data.includes("\n")) this.scheduleCwdRefresh();
      this.write(data).catch((error) => {
        console.error("Could not write terminal input", error);
      });
    });
    element.addEventListener("mousedown", () => this.term?.focus());
    this.term.onResize(({ cols, rows }) => {
      if (this.started) this.backend.resizeTerminal(this.sessionId, cols, rows).catch(() => {});
    });

    if (!this.started && this.backend.isNative) {
      await this.ensureStarted(this.cwd, this.term.cols, this.term.rows);
      if (generation !== this.mountGeneration) return;
    } else if (!this.backend.isNative && this.output.length === 0) {
      this.term.writeln("Browser preview does not provide a native PTY.");
    }
  }

  scheduleCwdRefresh() {
    clearTimeout(this.cwdRefreshTimer);
    this.cwdRefreshTimer = setTimeout(() => {
      this.refreshCwd().catch((error) => {
        console.error("Could not synchronize terminal directory", error);
      });
    }, 120);
  }

  async refreshCwd() {
    if (!this.backend.isNative || !this.started) return;
    const cwd = await this.backend.getTerminalCwd(this.sessionId);
    if (!cwd || cwd === this.cwd) return;
    this.cwd = cwd;
    await this.onCwdChange?.(cwd);
  }

  async isBusy() {
    if (!this.backend.isNative || !this.started) return false;
    if (!this.backend.isTerminalBusy) return false;
    return Boolean(await this.backend.isTerminalBusy(this.sessionId));
  }

  selectedText() {
    return this.term?.getSelection?.() || "";
  }

  async copySelection() {
    const text = this.selectedText();
    if (!text) return false;
    if (!this.assistantActions.copyText) return false;
    await this.assistantActions.copyText(text);
    return true;
  }

  terminalTextAtEvent(element, event) {
    const screen = element.querySelector?.(".xterm-screen") || element;
    const rect = screen.getBoundingClientRect?.();
    const cols = Math.max(1, Number(this.term?.cols) || 1);
    const rows = Math.max(1, Number(this.term?.rows) || 1);
    if (!rect?.width || !rect?.height) return null;
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    const column = Math.min(cols - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * cols)));
    const viewportRow = Math.min(rows - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * rows)));
    const buffer = this.term?.buffer?.active;
    const line = buffer?.getLine?.((Number(buffer.viewportY) || 0) + viewportRow);
    const text = line?.translateToString?.(true) || "";
    const cellWidth = rect.width / cols;
    const cellHeight = rect.height / rows;
    return {
      text,
      column,
      anchor: {
        left: rect.left + column * cellWidth,
        right: rect.left + (column + 1) * cellWidth,
        top: rect.top + viewportRow * cellHeight,
        bottom: rect.top + (viewportRow + 1) * cellHeight
      }
    };
  }

  dismissPreview() {
    this.previewRequest += 1;
    this.previewDocumentAbort?.abort();
    this.previewDocumentAbort = null;
    if (this.previewData) this.assistantActions.releasePreview?.(this.previewData);
    this.previewData = null;
    this.previewElement?.remove?.();
    this.previewElement = null;
  }

  positionPreview(element, anchor) {
    const view = element.ownerDocument?.defaultView || globalThis;
    const placement = terminalPreviewPlacement(anchor, {
      width: Number(view.innerWidth) || 1024,
      height: Number(view.innerHeight) || 768
    }, {
      width: element.offsetWidth || 450,
      height: element.offsetHeight || 330
    });
    element.style.left = `${placement.left}px`;
    element.style.top = `${placement.top}px`;
    element.dataset.placement = placement.above ? "above" : "below";
  }

  async openPreviewTarget(target, status) {
    if (!this.assistantActions.openPreview) return;
    status.textContent = "Opening…";
    try {
      await this.assistantActions.openPreview(target);
      this.dismissPreview();
    } catch (error) {
      status.textContent = error?.message || String(error);
      console.error("Could not open terminal preview", error);
    }
  }

  showPreview(target, anchor, document) {
    if (!target || !document?.body) return;
    this.dismissPreview();
    const request = ++this.previewRequest;
    const preview = document.createElement("aside");
    preview.className = "terminal-link-preview";
    preview.setAttribute("role", "dialog");
    preview.setAttribute("aria-label", `Preview ${target.text}`);

    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = target.text;
    const status = document.createElement("small");
    status.textContent = target.kind === "url" ? "Website preview" : "File preview";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-link-preview-close";
    close.setAttribute("aria-label", "Close preview");
    close.textContent = "×";
    header.append(title, status, close);

    const body = document.createElement("div");
    body.className = "terminal-link-preview-body";
    body.setAttribute("role", "button");
    body.setAttribute("tabindex", "0");
    body.setAttribute("aria-label", `Open ${target.text} in a new tab`);
    const frame = document.createElement("iframe");
    frame.className = "terminal-link-preview-frame";
    frame.title = `Preview of ${target.text}`;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads");
    frame.setAttribute("tabindex", "-1");
    const loading = document.createElement("span");
    loading.className = "terminal-link-preview-loading";
    loading.textContent = "Loading preview…";
    body.append(frame, loading);
    preview.append(header, body);
    document.body.append(preview);
    this.previewElement = preview;
    this.positionPreview(preview, anchor);

    close.addEventListener("click", (event) => {
      event.stopPropagation();
      this.dismissPreview();
    });
    const open = () => this.openPreviewTarget(target, status);
    body.addEventListener("click", open);
    body.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    frame.addEventListener("load", () => loading.remove());

    this.previewDocumentAbort = new AbortController();
    const { signal } = this.previewDocumentAbort;
    document.addEventListener("pointerdown", (event) => {
      if (!preview.contains(event.target)) this.dismissPreview();
    }, { capture: true, signal });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.dismissPreview();
    }, { signal });
    document.defaultView?.addEventListener?.("resize", () => this.dismissPreview(), { signal });

    Promise.resolve(this.assistantActions.preparePreview?.(target) || target)
      .then((prepared) => {
        if (request !== this.previewRequest || this.previewElement !== preview) {
          this.assistantActions.releasePreview?.(prepared);
          return;
        }
        this.previewData = prepared;
        title.textContent = prepared.title || target.text;
        status.textContent = prepared.viewerKind === "web" ? "Website · click to open" : `${prepared.viewerKind || "file"} · click to open`;
        if (prepared.viewerKind === "image" && prepared.resourceUrl) {
          const image = document.createElement("img");
          image.className = "terminal-link-preview-image";
          image.alt = prepared.title || target.text || "Image preview";
          image.addEventListener("load", () => loading.remove());
          image.addEventListener("error", () => {
            loading.textContent = "Image preview is unavailable. Click to open it.";
          });
          preview.classList.add("is-image");
          header.remove();
          frame.replaceWith(image);
          image.src = prepared.resourceUrl;
          return;
        }
        if (!prepared.url) throw new Error("Preview URL is unavailable.");
        frame.src = prepared.url;
      })
      .catch((error) => {
        if (request !== this.previewRequest || this.previewElement !== preview) return;
        loading.textContent = error?.message || String(error);
        status.textContent = "Click to try opening";
      });
  }

  handlePreviewMouseUp(element, event) {
    if (event.button !== 0) return;
    const down = this.previewPointerDown;
    this.previewPointerDown = null;
    const moved = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
    const point = this.terminalTextAtEvent(element, event);
    const anchor = point?.anchor || { left: event.clientX, right: event.clientX + 1, top: event.clientY, bottom: event.clientY + 1 };
    const document = element.ownerDocument;
    setTimeout(() => {
      const selected = extractTerminalPreviewTarget(this.selectedText(), this.cwd);
      const clicked = point ? extractTerminalPreviewTarget(point.text, this.cwd, point.column) : null;
      const target = moved ? selected || clicked : clicked;
      if (target) this.showPreview(target, anchor, document);
      else this.dismissPreview();
    }, 0);
  }

  installClipboardHandlers(element) {
    this.clipboardAbort?.abort();
    this.clipboardAbort = new AbortController();
    const { signal } = this.clipboardAbort;
    element.addEventListener("mousedown", (event) => {
      if (event.button === 0) this.previewPointerDown = { x: event.clientX, y: event.clientY };
    }, { signal });
    element.addEventListener("mouseup", (event) => this.handlePreviewMouseUp(element, event), { signal });
    element.addEventListener("keydown", (event) => {
      const key = String(event.key || "").toLowerCase();
      const isCopyShortcut = (event.ctrlKey && event.shiftKey && key === "c") || (event.metaKey && key === "c") || (event.ctrlKey && event.key === "Insert");
      if (!isCopyShortcut || !this.selectedText()) return;
      event.preventDefault();
      this.copySelection().catch((error) => {
        console.error("Could not copy terminal selection", error);
      });
    }, { signal });
    element.addEventListener("contextmenu", (event) => {
      if (!this.selectedText()) return;
      event.preventDefault();
      this.copySelection().catch((error) => {
        console.error("Could not copy terminal selection", error);
      });
    }, { signal });
  }

  async ensureStarted(cwd = this.cwd, cols = this.term?.cols || 80, rows = this.term?.rows || 24) {
    if (!this.backend.isNative) return false;
    if (this.started) return true;
    if (!this.startPromise) {
      this.cwd = cwd || this.cwd;
      this.startPromise = this.backend.startTerminal(this.sessionId, this.cwd, cols, rows)
        .then(() => {
          this.started = true;
          return true;
        })
        .finally(() => {
          this.startPromise = null;
        });
    }
    return this.startPromise;
  }

  async write(data) {
    if (!this.backend.isNative) return;
    await this.ensureStarted();
    await this.backend.writeTerminal(this.sessionId, encoder.encode(data));
  }

  async stop() {
    this.mountGeneration += 1;
    clearTimeout(this.cwdRefreshTimer);
    this.clipboardAbort?.abort();
    this.clipboardAbort = null;
    this.dismissPreview();
    this.term?.dispose();
    this.term = null;
    this.mountedElement = null;
    for (const off of this.unlisten.splice(0)) off?.();
    if (this.started && this.backend.isNative) await this.backend.stopTerminal(this.sessionId);
    this.started = false;
  }

  resize() {
    if (!this.term || !this.fitAddon) return;
    this.fitAddon.fit();
    if (this.started) {
      this.backend.resizeTerminal(this.sessionId, this.term.cols, this.term.rows).catch(() => {});
    }
  }

  focus() {
    this.term?.focus();
  }

  async run(command) {
    await this.write(`${command}\r`);
    this.scheduleCwdRefresh();
  }

  printMedia(items = []) {
    for (const item of items) this.appendRecord({ type: "media", item: snapshotMedia(item) });
  }

  printUser(message, attachments = []) {
    this.printMessage("You", message, "36");
    this.printMedia(attachments);
  }

  printAssistant(name, message, audio = null) {
    this.beginAssistantStream(name);
    for (const segment of terminalAssistantSegments(message)) this.appendAssistantStream(segment.text);
    this.endAssistantStream();
    if (audio) this.printMedia([{ ...audio, kind: "audio" }]);
  }

  beginAssistantStream(name) {
    const esc = String.fromCharCode(27);
    const output = `\r\n${esc}[1;35m${name || "Auri"}${esc}[0m\r\n`;
    this.appendRecord({ type: "bytes", bytes: encoder.encode(output) });
    this.assistantStreamAtLineStart = true;
  }

  appendAssistantStream(text) {
    if (!text) return;
    const normalized = String(text).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    this.appendRecord({ type: "bytes", bytes: encoder.encode(normalized) });
    this.assistantStreamAtLineStart = normalized.endsWith("\r\n");
  }

  endAssistantStream() {
    if (!this.assistantStreamAtLineStart) {
      this.appendRecord({ type: "bytes", bytes: encoder.encode("\r\n") });
    }
    this.assistantStreamAtLineStart = true;
  }

  printMessage(label, message, color) {
    const normalized = String(message ?? "").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    const esc = String.fromCharCode(27);
    const output = `\r\n${esc}[1;${color}m${label}${esc}[0m\r\n${normalized}\r\n`;
    this.appendRecord({ type: "bytes", bytes: encoder.encode(output) });
  }
}
