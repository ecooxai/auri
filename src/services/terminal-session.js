import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalAssistantSegments } from "../model/assistant.js";

const encoder = new TextEncoder();

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
    this.term?.dispose();
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
