import { terminalAssistantSegments } from "../model/assistant.js";
import { encodeKeyEvent, encodePasteText, rowText, runSpanSpec } from "./terminal-screen.js";

const encoder = new TextEncoder();

// Rolling decoded tail kept for state snapshots. Matches the snapshot cap so
// pushes never re-decode the whole record log (which would churn the WebKit
// heap on every output burst).
export const TERMINAL_TAIL_MAX_CHARS = 65536;
// A freshly mounted terminal renders only this many trailing lines; the full
// record history stays stored and scrolling to the top loads older chunks.
export const TERMINAL_RENDER_TAIL_LINES = 100;

export function countRecordLines(records) {
  let lines = 0;
  for (const record of records) {
    if (record?.type !== "bytes" || !record.bytes) continue;
    for (const byte of record.bytes) {
      if (byte === 10) lines += 1;
    }
  }
  return lines;
}

// The first record index whose replay covers at least `maxLines` trailing
// newlines — everything before it stays stored but unrendered.
export function replayStartIndex(records, maxLines) {
  let lines = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "bytes" && record.bytes) {
      for (const byte of record.bytes) {
        if (byte === 10) lines += 1;
      }
      if (lines >= maxLines) return index;
    }
  }
  return 0;
}

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

export function formatMiniImageMetadata(sizeBytes, width, height) {
  const size = Number(sizeBytes);
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const parts = [];
  if (Number.isFinite(size) && size >= 0) {
    const kb = size / 1024;
    parts.push(`${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`);
  }
  if (w > 0 && h > 0) parts.push(`${w}×${h}`);
  return parts.join("  ");
}

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

function hasRelativeDirectoryShape(value) {
  const path = String(value || "").replaceAll("\\", "/");
  if (!path.endsWith("/") || path.startsWith("/") || path.startsWith("~/") || /^\.{1,2}\//.test(path)) return false;
  if (/^[A-Za-z]:\//.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  if (path.includes("//") || /[?#=|&*$<>@]/.test(path)) return false;
  return path.slice(0, -1).split("/").every((part) => part && part !== "." && part !== "..");
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
  if (!explicitRelative && !hasRecognizedFileExtension(path) && !hasRelativeDirectoryShape(path)) return null;
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

export function extractTerminalSelectionPreviewTarget(input, cwd = "") {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const quoted = raw.match(/^(["'])([\s\S]*)\1$/);
  const selected = quoted ? quoted[2] : raw;
  const exact = parsedTerminalCandidate(selected, cwd);
  if (exact) return exact;
  return extractTerminalPreviewTarget(raw, cwd);
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

/// Web-page minipreviews fill 70% of the terminal panel with a 400px floor,
/// capped so they never overflow the window.
export function webPreviewSize(panel = {}, viewport = {}) {
  const panelWidth = Number(panel?.width) || 0;
  const panelHeight = Number(panel?.height) || 0;
  const viewWidth = Number(viewport?.width) || 0;
  const viewHeight = Number(viewport?.height) || 0;
  let width = Math.max(400, panelWidth * 0.7);
  let height = Math.max(400, panelHeight * 0.7);
  if (viewWidth > 0) width = Math.min(width, Math.max(1, viewWidth - 16));
  if (viewHeight > 0) height = Math.min(height, Math.max(1, viewHeight - 16));
  return { width: Math.round(width), height: Math.round(height) };
}

export function mediaPreviewSize(intrinsicWidth, intrinsicHeight, {
  preferredWidth = 450,
  maxHeight = 500,
  viewportWidth = 1024,
  viewportHeight = 768
} = {}) {
  const sourceWidth = Math.max(1, Number(intrinsicWidth) || 1);
  const sourceHeight = Math.max(1, Number(intrinsicHeight) || 1);
  const ratio = sourceWidth / sourceHeight;
  const availableWidth = Math.max(1, Math.min(
    Math.max(1, Number(preferredWidth) || 450),
    Math.max(1, (Number(viewportWidth) || 1024) - 16)
  ));
  const heightLimit = Math.max(1, Math.min(
    Math.max(1, Number(maxHeight) || 500),
    Math.max(1, (Number(viewportHeight) || 768) - 16)
  ));
  let width = availableWidth;
  let height = width / ratio;
  if (height > heightLimit) {
    height = heightLimit;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
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

// Fallback-only display cleanup: strip escape sequences from recorded bytes
// so the no-PTY browser preview can show readable text without an emulator.
export function stripAnsi(text) {
  return String(text || "")
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/[@-_]/g, "")
    .replace(/[ --]/g, "");
}

export class TerminalSession {
  constructor(backend, assistantActions = {}) {
    this.backend = backend;
    this.assistantActions = assistantActions;
    this.sessionId = `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.started = false;
    this.adoptOnly = false;
    this.pendingAdoptInput = "";
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
    this.onOutput = null;
    this.bufferTail = "";
    this.tailDecoder = new TextDecoder();
    this.renderLineBudget = TERMINAL_RENDER_TAIL_LINES;
    this.lastHistoryExpand = 0;
    this.assistantStreamAtLineStart = true;
    this.clipboardAbort = null;
    this.previewElement = null;
    this.previewData = null;
    this.previewRequest = 0;
    this.previewDocumentAbort = null;
    this.previewPointerDown = null;

    // Backend-frame renderer state: the Rust VtScreen is the emulator, the
    // DOM below only mirrors its grid and scrollback window.
    this.cols = 0;
    this.rows = 0;
    this.cellWidth = 8;
    this.rowHeight = 16;
    this.modes = { applicationCursorKeys: false, bracketedPaste: false };
    this.scrollbackLimit = 4000;
    this.mountedElement = null;
    this.rootElement = null;
    this.scrollElement = null;
    this.backElement = null;
    this.screenElement = null;
    this.cursorElement = null;
    this.frameTimer = null;
    this.frameInflight = false;
    this.frameDirty = false;
    this.backSeeded = false;
    this.backStart = 0;
    this.backEnd = 0;
    this.lastFrame = null;
    this.mediaCards = [];
    this.printQueue = Promise.resolve(null);
    this.lastPrintLine = null;
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
    const byteEncoder = new TextEncoder();
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

    return byteEncoder.encode(visible);
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
    if (record.type === "bytes") {
      this.bufferTail += this.tailDecoder.decode(record.bytes, { stream: true });
      if (this.bufferTail.length > TERMINAL_TAIL_MAX_CHARS) {
        this.bufferTail = this.bufferTail.slice(-TERMINAL_TAIL_MAX_CHARS);
      }
    }
  }

  appendRecord(record) {
    this.remember(record);
    if (this.rootElement) {
      if (this.backend.isNative) this.scheduleFrameRefresh();
      else this.renderFallback();
    }
    this.onOutput?.();
  }

  // ---- Backend frame rendering -------------------------------------------

  scheduleFrameRefresh(delay = 16) {
    if (this.frameTimer || !this.rootElement) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.refreshFrame().catch((error) => {
        console.error("Could not render terminal frame", error);
      });
    }, delay);
  }

  async refreshFrame() {
    if (!this.backend.isNative || !this.rootElement || !this.started) return;
    if (this.frameInflight) {
      this.frameDirty = true;
      return;
    }
    this.frameInflight = true;
    const generation = this.mountGeneration;
    try {
      const frame = await this.backend.terminalFrame(this.sessionId);
      if (!frame || generation !== this.mountGeneration || !this.rootElement) return;
      await this.renderFrame(frame, generation);
    } catch (error) {
      console.error("Could not render terminal frame", error);
    } finally {
      this.frameInflight = false;
      if (this.frameDirty) {
        this.frameDirty = false;
        this.scheduleFrameRefresh();
      }
    }
  }

  async renderFrame(frame, generation) {
    this.lastFrame = frame;
    this.cols = Number(frame.cols) || 0;
    this.rows = Number(frame.rows) || 0;
    this.modes.applicationCursorKeys = Boolean(frame.applicationCursorKeys);
    this.modes.bracketedPaste = Boolean(frame.bracketedPaste);

    const total = Number(frame.scrollbackLen) || 0;
    const first = Number(frame.scrollbackStart) || 0;
    const atBottom = this.isAtBottom();

    // The emulator was reset or trimmed past our window: rebuild it.
    if (total < this.backEnd || this.backStart < first) this.backSeeded = false;
    if (!this.backSeeded) {
      this.backStart = Math.max(first, total - this.renderLineBudget);
      this.backEnd = this.backStart;
      this.backElement.replaceChildren();
      this.backSeeded = true;
    }
    if (total > this.backEnd) {
      const from = this.backEnd;
      const rows = await this.backend.terminalScrollback(this.sessionId, from, total - from);
      if (generation !== this.mountGeneration || !this.rootElement) return;
      const document = this.rootElement.ownerDocument;
      for (let index = 0; index < rows.length; index += 1) {
        this.backElement.append(this.renderRow(document, rows[index], from + index));
      }
      this.backEnd = from + rows.length;
      if (atBottom) {
        while (this.backEnd - this.backStart > this.renderLineBudget && this.backElement.firstChild) {
          this.backElement.firstChild.remove();
          this.backStart += 1;
        }
      }
    }

    const document = this.rootElement.ownerDocument;
    const screenRows = [];
    const lines = Array.isArray(frame.lines) ? frame.lines : [];
    for (let index = 0; index < lines.length; index += 1) {
      screenRows.push(this.renderRow(document, lines[index], total + index));
    }
    this.screenElement.replaceChildren(...screenRows, this.cursorElement);
    this.positionCursor(frame);
    this.placeMediaCards();
    if (atBottom) this.scrollToBottom();
  }

  renderRow(document, runs, absoluteLine) {
    const row = document.createElement("div");
    row.className = "term-row";
    row.dataset.line = String(absoluteLine);
    const text = rowText(runs);
    row.dataset.text = text;
    if (!Array.isArray(runs) || !runs.length) return row;
    for (const run of runs) {
      const spec = runSpanSpec(run);
      if (!spec.text) continue;
      const span = document.createElement("span");
      span.textContent = spec.text;
      if (spec.className) span.className = spec.className;
      if (spec.color) span.style.color = spec.color;
      if (spec.background) span.style.backgroundColor = spec.background;
      row.append(span);
    }
    return row;
  }

  positionCursor(frame) {
    const cursor = this.cursorElement;
    if (!cursor) return;
    const visible = frame.cursorVisible !== false;
    cursor.hidden = !visible;
    if (!visible) return;
    const x = Math.max(0, Number(frame.cursorX) || 0);
    const y = Math.max(0, Number(frame.cursorY) || 0);
    const row = this.screenElement?.querySelectorAll?.(".term-row")?.[y];
    // Anchor to the row WebKit actually laid out. A hidden font probe can
    // round to a different height on Linux, and multiplying that small error
    // by cursorY eventually draws the cursor one or more rows above input.
    const top = Number.isFinite(row?.offsetTop) ? row.offsetTop : y * this.rowHeight;
    const height = Number(row?.offsetHeight) > 0 ? row.offsetHeight : this.rowHeight;
    cursor.style.left = `${Math.round(x * this.cellWidth)}px`;
    cursor.style.top = `${Math.round(top)}px`;
    cursor.style.width = `${Math.max(1, Math.round(this.cellWidth))}px`;
    cursor.style.height = `${Math.max(1, Math.round(height))}px`;
  }

  placeMediaCards() {
    if (!this.rootElement || !this.mediaCards.length) return;
    const document = this.rootElement.ownerDocument;
    for (const card of this.mediaCards) {
      if (!card.element) {
        card.element = document.createElement("div");
        this.populateMediaElement(card.element, card.item);
      }
      const row =
        this.backElement.querySelector(`[data-line="${card.line}"]`) ||
        this.screenElement.querySelector(`[data-line="${card.line}"]`);
      if (row) row.after(card.element);
      else if (!card.element.isConnected && card.line >= this.backStart) {
        // Row not rendered yet (e.g. anchored past current content): keep the
        // card at the end of the scrollback flow so it stays visible.
        this.backElement.append(card.element);
      }
    }
  }

  isAtBottom() {
    const scroll = this.scrollElement;
    if (!scroll) return true;
    return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - this.rowHeight * 1.5;
  }

  scrollToBottom() {
    const scroll = this.scrollElement;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // Scrolled to the very top with older history stored in the backend:
  // double the window and prepend the older rows, keeping the viewport
  // anchored at the seam so the newly loaded lines are what the user sees.
  expandHistory() {
    if (!this.rootElement || !this.backend.isNative || !this.lastFrame) return false;
    const first = Number(this.lastFrame.scrollbackStart) || 0;
    if (this.backStart <= first) return false;
    const now = Date.now();
    if (now - this.lastHistoryExpand < 500) return false;
    this.lastHistoryExpand = now;

    this.renderLineBudget = Math.min(this.renderLineBudget * 2, 1000000);
    const from = Math.max(first, this.backEnd - this.renderLineBudget);
    if (from >= this.backStart) return false;
    const count = this.backStart - from;
    const generation = this.mountGeneration;
    this.backend
      .terminalScrollback(this.sessionId, from, count)
      .then((rows) => {
        if (generation !== this.mountGeneration || !this.rootElement || !rows?.length) return;
        const document = this.rootElement.ownerDocument;
        const scroll = this.scrollElement;
        const heightBefore = scroll.scrollHeight;
        const nodes = rows.map((runs, index) => this.renderRow(document, runs, from + index));
        this.backElement.prepend(...nodes);
        this.backStart = from;
        scroll.scrollTop += scroll.scrollHeight - heightBefore;
      })
      .catch((error) => {
        console.error("Could not load terminal history", error);
      });
    return true;
  }

  // No-PTY browser preview: show the recorded output as stripped plain text.
  renderFallback() {
    if (!this.rootElement) return;
    const document = this.rootElement.ownerDocument;
    const start = replayStartIndex(this.output, this.renderLineBudget);
    let text = "";
    for (const record of this.output.slice(start)) {
      if (record?.type === "bytes" && record.bytes) text += new TextDecoder().decode(record.bytes);
    }
    const rows = stripAnsi(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const nodes = rows.map((line, index) => {
      const row = document.createElement("div");
      row.className = "term-row";
      row.dataset.line = String(index);
      row.dataset.text = line;
      row.textContent = line;
      return row;
    });
    this.screenElement.replaceChildren(...nodes);
    this.cursorElement.hidden = true;
    this.scrollToBottom();
  }

  // ---- Mounting and input -------------------------------------------------

  measureMetrics() {
    if (!this.rootElement) return;
    const document = this.rootElement.ownerDocument;
    const probe = document.createElement("span");
    probe.className = "term-probe";
    probe.textContent = "W".repeat(50);
    this.screenElement.append(probe);
    const rect = probe.getBoundingClientRect?.();
    if (rect?.width) this.cellWidth = rect.width / 50;
    if (probe.offsetHeight) this.rowHeight = probe.offsetHeight;
    probe.remove();
  }

  gridForViewport() {
    const scroll = this.scrollElement;
    if (!scroll) return { cols: this.cols || 80, rows: this.rows || 24 };
    const cols = Math.max(2, Math.floor((scroll.clientWidth || 0) / this.cellWidth) || 80);
    const rows = Math.max(2, Math.floor((scroll.clientHeight || 0) / this.rowHeight) || 24);
    return { cols, rows };
  }

  async mount(element, cwd = "~", fontSize = 20, maxLines = 4000) {
    if (!element) return;
    if (!this.started) this.cwd = cwd || this.cwd;
    this.scrollbackLimit = Math.min(100000, Math.max(100, Number(maxLines) || 4000));
    this.renderLineBudget = Math.max(this.renderLineBudget, TERMINAL_RENDER_TAIL_LINES);
    const terminalFontSize = Math.round(Math.min(30, Math.max(14, Number(fontSize) || 20)) * 0.6);

    if (this.rootElement && this.mountedElement === element) {
      this.rootElement.style.setProperty("--term-font-size", `${terminalFontSize}px`);
      this.measureMetrics();
      this.resize();
      if (!this.started && this.backend.isNative) {
        const grid = this.gridForViewport();
        await this.ensureStarted(this.cwd, grid.cols, grid.rows);
      }
      this.scheduleFrameRefresh(0);
      return;
    }

    const generation = ++this.mountGeneration;
    this.clipboardAbort?.abort();
    this.dismissPreview();
    const document = element.ownerDocument;
    element.replaceChildren();

    const root = document.createElement("div");
    root.className = "term-root";
    root.tabIndex = 0;
    root.style.setProperty("--term-font-size", `${terminalFontSize}px`);
    const scroll = document.createElement("div");
    scroll.className = "term-scroll";
    const back = document.createElement("div");
    back.className = "term-back";
    const screen = document.createElement("div");
    screen.className = "term-screen";
    const cursor = document.createElement("div");
    cursor.className = "term-cursor";
    cursor.hidden = true;
    screen.append(cursor);
    scroll.append(back, screen);
    root.append(scroll);
    element.append(root);

    this.mountedElement = element;
    this.rootElement = root;
    this.scrollElement = scroll;
    this.backElement = back;
    this.screenElement = screen;
    this.cursorElement = cursor;
    this.backSeeded = false;
    this.lastFrame = null;
    for (const card of this.mediaCards) card.element = null;

    this.measureMetrics();
    this.installClipboardHandlers(root);
    this.installInputHandlers(root);
    scroll.addEventListener("scroll", () => {
      if (scroll.scrollTop === 0) this.expandHistory();
    }, { signal: this.clipboardAbort.signal });

    if (this.backend.isNative) {
      const grid = this.gridForViewport();
      if (!this.started) {
        await this.ensureStarted(this.cwd, grid.cols, grid.rows);
        if (generation !== this.mountGeneration) return;
      } else if (!this.adoptOnly && (grid.cols !== this.cols || grid.rows !== this.rows)) {
        this.backend.resizeTerminal(this.sessionId, grid.cols, grid.rows).catch(() => {});
      }
      this.scheduleFrameRefresh(0);
    } else {
      if (this.output.length === 0) {
        this.remember({ type: "bytes", bytes: encoder.encode("Browser preview does not provide a native PTY.\n") });
      }
      this.renderFallback();
    }
  }

  installInputHandlers(root) {
    const { signal } = this.clipboardAbort;
    root.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      const sequence = encodeKeyEvent(event, this.modes);
      if (sequence === null) return;
      event.preventDefault();
      this.scrollToBottom();
      if (sequence.includes("\r") || sequence.includes("\n")) this.scheduleCwdRefresh();
      this.write(sequence).catch((error) => {
        console.error("Could not write terminal input", error);
      });
    }, { signal });
    root.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData?.("text") || "";
      if (!text) return;
      event.preventDefault();
      this.write(encodePasteText(text, this.modes.bracketedPaste)).catch((error) => {
        console.error("Could not paste into terminal", error);
      });
    }, { signal });
    root.addEventListener("mousedown", () => root.focus({ preventScroll: true }));
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
    const root = this.rootElement;
    const selection = root?.ownerDocument?.getSelection?.();
    if (!root || !selection || selection.isCollapsed) return "";
    if (!root.contains(selection.anchorNode)) return "";
    return selection.toString();
  }

  async copySelection() {
    const text = this.selectedText();
    if (!text) return false;
    if (!this.assistantActions.copyText) return false;
    await this.assistantActions.copyText(text);
    return true;
  }

  terminalTextAtEvent(element, event) {
    const target = event.target?.closest?.(".term-row");
    const row = target && element.contains(target) ? target : null;
    if (!row) return null;
    const rect = row.getBoundingClientRect?.();
    if (!rect?.width) return null;
    const column = Math.max(0, Math.floor((event.clientX - rect.left) / this.cellWidth));
    const cols = Math.max(1, this.cols || Math.round(rect.width / this.cellWidth));
    const rowString = (node) => String(node?.dataset?.text ?? node?.textContent ?? "");

    // Rows whose text fills the whole grid width are soft-wrap continuations:
    // join them so a long path or URL split across rows previews as one line.
    let text = rowString(row);
    let logicalColumn = column;
    let previous = row.previousElementSibling;
    while (previous?.classList?.contains?.("term-row") && rowString(previous).length === cols) {
      text = rowString(previous) + text;
      logicalColumn += cols;
      previous = previous.previousElementSibling;
    }
    let current = row;
    while (rowString(current).length === cols) {
      const next = current.nextElementSibling;
      if (!next?.classList?.contains?.("term-row")) break;
      text += rowString(next);
      current = next;
    }

    if (!text.trim()) return null;
    return {
      text,
      column: Math.min(logicalColumn, Math.max(0, text.length - 1)),
      anchor: {
        left: rect.left + column * this.cellWidth,
        right: rect.left + (column + 1) * this.cellWidth,
        top: rect.top,
        bottom: rect.bottom
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

  async openPreviewTarget(target, showFeedback) {
    if (!this.assistantActions.openPreview) return;
    showFeedback?.("Opening…");
    try {
      await this.assistantActions.openPreview(target);
      this.dismissPreview();
    } catch (error) {
      showFeedback?.(error?.message || String(error));
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

    const body = document.createElement("div");
    body.className = "terminal-link-preview-body";
    const openButton = document.createElement("button");
    openButton.className = "terminal-link-preview-open";
    openButton.type = "button";
    openButton.textContent = "↗";
    openButton.title = target.kind === "url" ? "Open in web tab" : "Open in viewer tab";
    openButton.setAttribute("aria-label", `Open ${target.text} in a new tab`);
    const frame = document.createElement("iframe");
    frame.className = "terminal-link-preview-frame";
    frame.title = `Preview of ${target.text}`;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads");
    frame.setAttribute("allow", "autoplay");
    const loading = document.createElement("span");
    loading.className = "terminal-link-preview-loading";
    loading.textContent = "Loading preview…";
    body.append(frame, loading);
    preview.append(body, openButton);
    document.body.append(preview);
    this.previewElement = preview;
    if (target.kind === "url") {
      const panelRect = this.mountedElement?.getBoundingClientRect?.()
        || this.scrollElement?.getBoundingClientRect?.()
        || {};
      const view = document.defaultView || globalThis;
      const size = webPreviewSize(panelRect, {
        width: Number(view.innerWidth) || 0,
        height: Number(view.innerHeight) || 0
      });
      preview.style.width = `${size.width}px`;
      preview.style.height = `${size.height}px`;
    }
    this.positionPreview(preview, anchor);
    const previewView = document.defaultView || globalThis;
    const preferredMediaWidth = preview.offsetWidth || Math.min(
      Math.max(225, (Number(previewView.innerWidth) || 1024) * .45),
      Math.max(1, (Number(previewView.innerWidth) || 1024) - 16)
    );
    const resizeMediaPreview = (width, height) => {
      const size = mediaPreviewSize(width, height, {
        preferredWidth: preferredMediaWidth,
        viewportWidth: Number(previewView.innerWidth) || 1024,
        viewportHeight: Number(previewView.innerHeight) || 768
      });
      preview.style.width = `${size.width}px`;
      preview.style.height = `${size.height}px`;
      this.positionPreview(preview, anchor);
    };

    const showFeedback = (message) => {
      loading.textContent = message;
      if (!loading.isConnected) body.append(loading);
    };
    const open = () => this.openPreviewTarget(target, showFeedback);
    openButton.addEventListener("click", open);
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
        if (prepared.viewerKind === "image" && prepared.resourceUrl) {
          const image = document.createElement("img");
          image.className = "terminal-link-preview-image";
          image.alt = prepared.title || target.text || "Image preview";
          image.addEventListener("load", () => {
            resizeMediaPreview(image.naturalWidth, image.naturalHeight);
            const infoText = formatMiniImageMetadata(prepared.size, image.naturalWidth, image.naturalHeight);
            if (infoText) {
              const info = document.createElement("span");
              info.className = "terminal-link-preview-media-info";
              info.textContent = infoText;
              body.append(info);
            }
            loading.remove();
          });
          image.addEventListener("error", () => {
            loading.textContent = "Image preview is unavailable. Use the open button to view it.";
          });
          preview.classList.add("is-image");
          frame.replaceWith(image);
          image.src = prepared.resourceUrl;
          return;
        }
        if (prepared.viewerKind === "video" && prepared.resourceUrl) {
          const video = document.createElement("video");
          video.className = "terminal-link-preview-video";
          video.autoplay = true;
          video.preload = "metadata";
          video.setAttribute("playsinline", "");
          video.addEventListener("loadedmetadata", () => {
            resizeMediaPreview(video.videoWidth, video.videoHeight);
            loading.remove();
            video.play?.().catch?.(() => {});
          });
          video.addEventListener("error", () => {
            loading.textContent = "Video preview is unavailable. Use the open button to view it.";
          });
          preview.classList.add("is-video");
          frame.replaceWith(video);
          video.src = prepared.resourceUrl;
          return;
        }
        if (!prepared.url) throw new Error("Preview URL is unavailable.");
        frame.src = prepared.url;
      })
      .catch((error) => {
        if (request !== this.previewRequest || this.previewElement !== preview) return;
        showFeedback(error?.message || String(error));
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
      const selected = extractTerminalSelectionPreviewTarget(this.selectedText(), this.cwd);
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

  // Hosted web mirror: instead of starting an own PTY, join the desktop
  // window's session from the snapshot. Input typed before adoption queues
  // and flushes once the shared session id is known.
  async adopt({ sessionId, text = "", cols = 0, rows = 0 } = {}) {
    void cols; void rows; // the desktop window owns the shared PTY size
    const id = String(sessionId || "");
    if (!id || (this.started && this.sessionId === id)) return false;
    this.sessionId = id;
    this.started = true;
    this.backSeeded = false;
    if (!this.output.length && text) this.appendRecord({ type: "bytes", bytes: encoder.encode(text) });
    const pending = this.pendingAdoptInput;
    this.pendingAdoptInput = "";
    if (pending) await this.backend.writeTerminal(this.sessionId, encoder.encode(pending));
    this.scheduleFrameRefresh(0);
    return true;
  }

  async ensureStarted(cwd = this.cwd, cols = this.cols || 80, rows = this.rows || 24) {
    if (!this.backend.isNative) return false;
    if (this.started) return true;
    if (this.adoptOnly) return false;
    if (!this.startPromise) {
      this.cwd = cwd || this.cwd;
      this.startPromise = this.backend.startTerminal(this.sessionId, this.cwd, cols, rows, this.scrollbackLimit)
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
    if (this.adoptOnly && !this.started) {
      this.pendingAdoptInput += data;
      return;
    }
    await this.ensureStarted();
    await this.backend.writeTerminal(this.sessionId, encoder.encode(data));
  }

  // Background terminals live as recorded output only: the DOM mirror is
  // released while the PTY and its backend emulator keep running, so a later
  // mount() re-fetches the exact same screen.
  sleep() {
    if (!this.rootElement) return false;
    this.mountGeneration += 1;
    clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.clipboardAbort?.abort();
    this.clipboardAbort = null;
    this.dismissPreview();
    this.rootElement.remove();
    this.rootElement = null;
    this.scrollElement = null;
    this.backElement = null;
    this.screenElement = null;
    this.cursorElement = null;
    this.mountedElement = null;
    this.backSeeded = false;
    for (const card of this.mediaCards) card.element = null;
    return true;
  }

  bufferText() {
    return this.bufferTail;
  }

  async stop() {
    this.mountGeneration += 1;
    clearTimeout(this.cwdRefreshTimer);
    clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.clipboardAbort?.abort();
    this.clipboardAbort = null;
    this.dismissPreview();
    this.rootElement?.remove();
    this.rootElement = null;
    this.scrollElement = null;
    this.backElement = null;
    this.screenElement = null;
    this.cursorElement = null;
    this.mountedElement = null;
    for (const off of this.unlisten.splice(0)) off?.();
    // Adopted sessions borrow the desktop window's PTY; only that window may
    // end it.
    if (this.started && this.backend.isNative && !this.adoptOnly) await this.backend.stopTerminal(this.sessionId);
    this.started = false;
  }

  resize() {
    if (!this.rootElement) return;
    this.measureMetrics();
    const grid = this.gridForViewport();
    if (this.started && !this.adoptOnly && (grid.cols !== this.cols || grid.rows !== this.rows)) {
      this.backend.resizeTerminal(this.sessionId, grid.cols, grid.rows).catch(() => {});
    }
    this.scheduleFrameRefresh();
  }

  focus() {
    this.rootElement?.focus({ preventScroll: true });
  }

  async run(command) {
    await this.write(`${command}\r`);
    this.scheduleCwdRefresh();
  }

  // ---- Printed messages and media ----------------------------------------
  // GUI-side messages (You/assistant blocks) print through the backend
  // emulator so every mirror — GUI, browser session, TUI attach — shows them.
  // The bytes come back over the terminal-data event, which also keeps the
  // record log and state snapshot in sync.

  enqueuePrint(text) {
    this.printQueue = this.printQueue
      .then(async () => {
        if (!text) return this.lastPrintLine;
        if (!this.backend.isNative || (this.adoptOnly && !this.started)) {
          this.appendRecord({ type: "bytes", bytes: encoder.encode(text) });
          return this.lastPrintLine;
        }
        await this.ensureStarted();
        const line = await this.backend.printTerminal(this.sessionId, text);
        this.lastPrintLine = typeof line === "number" ? line : this.lastPrintLine;
        return this.lastPrintLine;
      })
      .catch((error) => {
        console.error("Could not print to terminal", error);
        return this.lastPrintLine;
      });
    return this.printQueue;
  }

  populateMediaElement(element, item) {
    if (element.dataset.auriMediaReady === "true") return;
    element.dataset.auriMediaReady = "true";
    element.classList.add("terminal-inline-media", `is-${item.kind}`);

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

  printMedia(items = []) {
    if (!items.length) return;
    const snapshots = items.map((item) => snapshotMedia(item));
    this.printQueue = this.printQueue.then((line) => {
      const anchor = typeof line === "number"
        ? line
        : (Number(this.lastFrame?.scrollbackLen) || 0) + (Number(this.lastFrame?.cursorY) || 0);
      for (const item of snapshots) {
        this.mediaCards.push({ item, line: anchor, element: null });
      }
      while (this.mediaCards.length > 40) {
        const dropped = this.mediaCards.shift();
        dropped.element?.remove?.();
      }
      this.scheduleFrameRefresh(0);
      this.placeMediaCards();
      return line;
    });
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
    this.enqueuePrint(`\r\n${esc}[1;35m${name || "Auri"}${esc}[0m\r\n`);
    this.assistantStreamAtLineStart = true;
  }

  appendAssistantStream(text) {
    if (!text) return;
    const normalized = String(text).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    this.enqueuePrint(normalized);
    this.assistantStreamAtLineStart = normalized.endsWith("\r\n");
  }

  endAssistantStream() {
    if (!this.assistantStreamAtLineStart) this.enqueuePrint("\r\n");
    this.assistantStreamAtLineStart = true;
  }

  printMessage(label, message, color) {
    const normalized = String(message ?? "").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    const esc = String.fromCharCode(27);
    this.enqueuePrint(`\r\n${esc}[1;${color}m${label}${esc}[0m\r\n${normalized}\r\n`);
  }
}
