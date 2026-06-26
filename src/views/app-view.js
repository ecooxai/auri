import { activeWorkspace } from "../model/state.js";
import { renderActivePanel, renderAssistantTranscriptPopup, renderFolder, renderMainTabs, renderSubtabs, renderWebOverlay } from "./panels.js";

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

export function captureClipboardScroll(root) {
  const grid = root && root.querySelector ? root.querySelector(".clipboard-grid") : null;
  return grid ? grid.scrollTop : 0;
}

export class AppView {
  constructor(root) {
    this.root = root;
    this.terminalHosts = new Map();
  }

  stashTerminalHost() {
    const host = this.root?.querySelector?.("#terminal-emulator");
    const workspaceId = host?.dataset?.workspaceId;
    if (!host || !workspaceId) return null;
    this.terminalHosts.set(workspaceId, host);
    host.remove();
    return host;
  }

  restoreTerminalHost(workspaceId) {
    const placeholder = this.root?.querySelector?.("#terminal-emulator");
    if (!placeholder) return null;
    const preserved = this.terminalHosts.get(workspaceId);
    if (!preserved || preserved === placeholder) return placeholder;
    placeholder.replaceWith(preserved);
    return preserved;
  }

  pruneTerminalHosts(state) {
    const workspaceIds = new Set(state.tabs.map((tab) => tab.id));
    for (const workspaceId of this.terminalHosts.keys()) {
      if (!workspaceIds.has(workspaceId)) this.terminalHosts.delete(workspaceId);
    }
  }

  render(state, options = {}) {
    applyAppFontSize(this.root, state.settings.fontSize);
    const tab = activeWorkspace(state);
    this.stashTerminalHost();
    this.pruneTerminalHosts(state);
    const inputValue = options.preserveInput ? this.getTerminalInputValue() : tab.terminal.draft;
    const folderCreateValue = state.ui.folderCreateKind ? this.getFolderCreateName() : "";
    const folderScrollTop = captureFolderScroll(this.root, tab.folder.path);
    const clipboardScrollTop = captureClipboardScroll(this.root);
    this.root.innerHTML = `
      <div class="auri-shell">
        ${renderMainTabs(state)}
        <main class="app-surface">
          ${renderSubtabs(state, { native: Boolean(options.native) })}
          <div class="workspace-grid">
            ${renderFolder(state)}
            <div class="content-pane">${renderActivePanel(state, { native: Boolean(options.native) })}${renderAssistantTranscriptPopup(state)}</div>
          </div>
        </main>
      </div>
      ${renderWebOverlay(state, { native: Boolean(options.native) })}
      ${state.ui.commandPaletteOpen ? this.renderCommandPalette() : ""}`;
    this.restoreTerminalHost(tab.id);

    if (inputValue && this.root.querySelector("#terminal-input")) {
      this.root.querySelector("#terminal-input").value = inputValue;
    }
    if (folderCreateValue && this.root.querySelector("#folder-create-input")) {
      this.root.querySelector("#folder-create-input").value = folderCreateValue;
    }
    const folder = this.root.querySelector(".folder-list");
    if (folder) folder.scrollTop = folderScrollTop;
    const clipboard = this.root.querySelector(".clipboard-grid");
    if (clipboard) clipboard.scrollTop = clipboardScrollTop;
    requestAnimationFrame(() => {
      const history = this.root.querySelector("#terminal-history");
      if (history) history.scrollTop = history.scrollHeight;
      if (state.ui.folderCreateKind) {
        const input = this.root.querySelector("#folder-create-input");
        input?.focus();
        input?.select();
      }
      if (!options.native && state.ui.webDialog === "add-bookmark") {
        const input = this.root.querySelector("#web-bookmark-name");
        input?.focus();
        input?.select();
      }
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

  getFolderCreateName() {
    return this.root.querySelector("#folder-create-input")?.value || "";
  }

  getWebUrl() {
    return this.root.querySelector("#web-url")?.value?.trim() || "";
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
