import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const encoder = new TextEncoder();

export class TerminalSession {
  constructor(backend) {
    this.backend = backend;
    this.sessionId = `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.term = null;
    this.fitAddon = null;
    this.started = false;
    this.output = [];
    this.outputBytes = 0;
    this.maxOutputBytes = 2097152;
    this.unlisten = [];
    this.cwd = "~";
    this.startPromise = null;
    this.mountGeneration = 0;
    this.cwdMarkerBuffer = "";
    this.onCwdChange = null;
  }

  async initialize() {
    if (!this.backend.isNative) return;
    const offData = await this.backend.listen("terminal-data", (payload) => {
      if (payload?.sessionId !== this.sessionId) return;
      const bytes = new Uint8Array(payload.data || []);
      const visible = this.consumeTerminalData(bytes);
      if (!visible.byteLength) return;
      this.remember(visible);
      this.term?.write(visible);
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

  remember(bytes) {
    this.output.push(bytes);
    this.outputBytes += bytes.byteLength;
    while (this.outputBytes > this.maxOutputBytes && this.output.length > 1) {
      this.outputBytes -= this.output.shift().byteLength;
    }
  }

  async mount(element, cwd = "~") {
    if (!element) return;
    const generation = ++this.mountGeneration;
    this.cwd = cwd || this.cwd;
    this.term?.dispose();
    this.fitAddon = new FitAddon();
    this.term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
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
    this.fitAddon.fit();
    this.term.onData((data) => {
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
    } else {
      for (const chunk of this.output) this.term.write(chunk);
      if (!this.backend.isNative) this.term.writeln("Browser preview does not provide a native PTY.");
    }
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
    this.term?.dispose();
    this.term = null;
    for (const off of this.unlisten.splice(0)) off?.();
    if (this.started && this.backend.isNative) await this.backend.stopTerminal(this.sessionId);
    this.started = false;
  }

  async run(command, { probeCwd = true } = {}) {
    const probe = probeCwd
      ? `printf '\\033[2K\\r\\033]777;auri-cwd=%s\\007' "$PWD"`
      : "";
    await this.write(`${command}\r${probe ? `${probe}\r` : ""}`);
    this.term?.focus();
  }

  printUser(message) {
    this.printMessage("You", message, "36");
  }

  printAssistant(name, message) {
    this.printMessage(name || "Auri", message, "35");
  }

  beginAssistantStream(name) {
    const esc = String.fromCharCode(27);
    const output = `\r\n${esc}[1;35m${name || "Auri"}${esc}[0m\r\n`;
    const bytes = encoder.encode(output);
    this.remember(bytes);
    this.term?.write(bytes);
  }

  appendAssistantStream(text) {
    if (!text) return;
    const normalized = String(text).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    const bytes = encoder.encode(normalized);
    this.remember(bytes);
    this.term?.write(bytes);
  }

  endAssistantStream() {
    const bytes = encoder.encode("\r\n");
    this.remember(bytes);
    this.term?.write(bytes);
  }

  printMessage(label, message, color) {
    const normalized = String(message ?? "").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    const esc = String.fromCharCode(27);
    const output = `\r\n${esc}[1;${color}m${label}${esc}[0m\r\n${normalized}\r\n`;
    const bytes = encoder.encode(output);
    this.remember(bytes);
    this.term?.write(bytes);
  }
}
