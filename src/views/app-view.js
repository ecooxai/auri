import { activeWorkspace } from "../model/state.js";
import { renderActivePanel, renderFolder, renderMainTabs, renderSubtabs } from "./panels.js";

export function applyAppFontSize(root, value) {
  const size = Math.min(30, Math.max(14, Number(value) || 20));
  const documentElement = root?.ownerDocument?.documentElement || globalThis.document?.documentElement;
  documentElement?.style?.setProperty("font-size", `${size}px`);
  return size;
}

export function captureFolderScroll(root, nextPath) {
  const list = root?.querySelector?.(".folder-list");
  return list?.dataset?.folderPath === nextPath ? list.scrollTop : 0;
}

export class AppView {
  constructor(root) {
    this.root = root;
  }

  render(state, options = {}) {
    applyAppFontSize(this.root, state.settings.fontSize);
    const tab = activeWorkspace(state);
    const inputValue = options.preserveInput ? this.getTerminalInputValue() : tab.terminal.draft;
    const folderScrollTop = captureFolderScroll(this.root, tab.folder.path);
    this.root.innerHTML = `
      <div class="auri-shell">
        ${renderMainTabs(state)}
        <main class="app-surface">
          ${renderSubtabs(state)}
          <div class="workspace-grid">
            ${renderFolder(state)}
            <div class="content-pane">${renderActivePanel(state)}</div>
          </div>
        </main>
      </div>
      ${state.ui.commandPaletteOpen ? this.renderCommandPalette() : ""}`;

    if (inputValue && this.root.querySelector("#terminal-input")) {
      this.root.querySelector("#terminal-input").value = inputValue;
    }
    const folder = this.root.querySelector(".folder-list");
    if (folder) folder.scrollTop = folderScrollTop;
    requestAnimationFrame(() => {
      const history = this.root.querySelector("#terminal-history");
      if (history) history.scrollTop = history.scrollHeight;
    });
  }

  renderCommandPalette() {
    return `<div class="palette-backdrop" data-action="palette-close"><section class="command-palette" role="dialog" aria-modal="true" aria-label="Auri command palette" onclick="event.stopPropagation()"><div class="palette-input"><span>⌘</span><input id="palette-input" autocomplete="off" placeholder="Type an Auri command…"></div><div class="palette-hints"><button type="button" data-action="palette-command" data-value="tab new">＋ New workspace</button><button type="button" data-action="palette-command" data-value="subtab new terminal">⌘ New terminal</button><button type="button" data-action="palette-command" data-value="clipboard list">▣ Clipboard</button><button type="button" data-action="palette-command" data-value="settings set alwaysAttachScreenshot true">◇ Attach screenshots</button><button type="button" data-action="palette-command" data-value="help">ⓘ Command help</button></div></section></div>`;
  }

  getTerminalInput() {
    return this.root.querySelector("#terminal-input");
  }

  getTerminalInputValue() {
    return this.getTerminalInput()?.value || "";
  }

  setTerminalInput(value, focus = true) {
    const input = this.getTerminalInput();
    if (!input) return;
    input.value = value;
    if (focus) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  insertTerminalText(value) {
    const input = this.getTerminalInput();
    if (!input) return false;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${value}${input.value.slice(end)}`;
    input.focus();
    const cursor = start + value.length;
    input.setSelectionRange(cursor, cursor);
    return true;
  }

  requestText(message, defaultValue = "") {
    const host = this.root?.ownerDocument?.defaultView || globalThis;
    return typeof host.prompt === "function" ? host.prompt(message, defaultValue) : null;
  }

  getWebUrl() {
    return this.root.querySelector("#web-url")?.value?.trim() || "";
  }

  getModelFields(id) {
    return {
      apiKey: this.root.querySelector(`[data-model-key="${CSS.escape(id)}"]`)?.value || "",
      url: this.root.querySelector(`[data-model-url="${CSS.escape(id)}"]`)?.value || ""
    };
  }

  getSettingValue(input) {
    if (input.type === "checkbox") return input.checked;
    if (input.type === "number") return Number(input.value);
    return input.value;
  }

  showToast(message, level = "info") {
    const existing = this.root.querySelector(".toast");
    existing?.remove();
    const toast = document.createElement("div");
    toast.className = `toast ${level}`;
    toast.textContent = message;
    this.root.append(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  focusPalette() {
    requestAnimationFrame(() => this.root.querySelector("#palette-input")?.focus());
  }
}
