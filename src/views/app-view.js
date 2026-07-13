import { activeSubtab, activeWorkspace } from "../model/state.js";
import { buildDiskMountRows, buildNetInterfaceRows, buildProcessMonitorPage, buildProcessMonitorRows, buildSystemMetrics, buildSystemStatusText, customCompletionLineNumbers, formatProcessPortCell, renderActivePanel, renderAssistantTranscriptPopup, renderFolder, renderFolderFilePreview, renderMainTabs, renderProcessMonitorContent, renderSubtabs, renderSystemProcessDetail, renderSystemKillPrompt, renderSystemTunnelPrompt, renderWebOverlay } from "./panels.js";

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

export function captureSettingsScroll(root) {
  const scroller = root && root.querySelector ? root.querySelector(".settings-scroll") : null;
  return scroller ? scroller.scrollTop : 0;
}

export function captureProcessScroll(root) {
  const table = root && root.querySelector ? root.querySelector(".process-table") : null;
  return table ? table.scrollTop : 0;
}

export class AppView {
  constructor(root) {
    this.root = root;
    this.terminalHosts = new Map();
    this.lastProcessSortBy = null;
  }

  terminalHostKey(host) {
    return host?.dataset?.terminalId || host?.dataset?.workspaceId || null;
  }

  stashTerminalHost() {
    const host = this.root?.querySelector?.("#terminal-emulator");
    const key = this.terminalHostKey(host);
    if (!host || !key) return null;
    this.terminalHosts.set(key, host);
    host.remove();
    return host;
  }

  restoreTerminalHost(terminalId) {
    const placeholder = this.root?.querySelector?.("#terminal-emulator");
    if (!placeholder) return null;
    const preserved = this.terminalHosts.get(terminalId);
    if (!preserved || preserved === placeholder) return placeholder;
    placeholder.replaceWith(preserved);
    return preserved;
  }

  pruneTerminalHosts(state) {
    const terminalIds = new Set(state.tabs.flatMap((tab) => tab.subtabs.filter((subtab) => subtab.type === "terminal").map((subtab) => subtab.id)));
    for (const terminalId of this.terminalHosts.keys()) {
      if (!terminalIds.has(terminalId)) this.terminalHosts.delete(terminalId);
    }
  }

  // Captures the currently focused element (if any) before a full innerHTML
  // rebuild so it can be refocused afterwards. The terminal composer has its
  // own dedicated focus/selection handling below (it also needs its value
  // restored, not just focus), so this only handles every *other* focusable
  // input/textarea/select: AI model forms, the web bookmark dialog, the
  // wake-shortcut field, settings fields, etc. Without this, any full
  // re-render (e.g. the periodic system-monitor poll while preserveInput is
  // set) silently drops focus from whatever the person was typing into.
  captureFocus(skipElement) {
    const doc = this.root.ownerDocument || (typeof document !== "undefined" ? document : null);
    const active = doc?.activeElement;
    if (!active || active === skipElement || active === doc.body) return null;
    if (this.root.contains && !this.root.contains(active)) return null;
    const id = active.id || null;
    const name = active.name || null;
    const formId = !id && name ? active.closest?.("form")?.id || null : null;
    const isTextLike = typeof active.selectionStart === "number" && typeof active.selectionEnd === "number";
    if (!id && !name) return null;
    return {
      id,
      name,
      formId,
      selectionStart: isTextLike ? active.selectionStart : null,
      selectionEnd: isTextLike ? active.selectionEnd : null
    };
  }

  restoreFocus(snapshot) {
    if (!snapshot || !this.root.querySelector) return;
    let target = null;
    if (snapshot.id) {
      target = this.root.querySelector(`#${snapshot.id}`);
    } else if (snapshot.name) {
      const scope = snapshot.formId ? this.root.querySelector(`#${snapshot.formId}`) : this.root;
      target = scope?.querySelector?.(`[name="${snapshot.name}"]`);
    }
    if (!target) return;
    target.focus?.();
    if (snapshot.selectionStart !== null && typeof target.setSelectionRange === "function") {
      const length = typeof target.value === "string" ? target.value.length : snapshot.selectionEnd;
      const start = Math.min(length, snapshot.selectionStart);
      const end = Math.min(length, Math.max(start, snapshot.selectionEnd));
      target.setSelectionRange(start, end);
    }
  }

  render(state, options = {}) {
    applyAppFontSize(this.root, state.settings.fontSize);
    const tab = activeWorkspace(state);
    this.stashTerminalHost();
    this.pruneTerminalHosts(state);
    const terminalInput = this.getTerminalInput();
    const terminalWasFocused = Boolean(options.preserveInput && terminalInput && terminalInput.ownerDocument?.activeElement === terminalInput);
    const inputValue = options.preserveInput ? this.getTerminalInputValue() : tab.terminal.draft;
    const inputSelectionStart = terminalWasFocused && Number.isInteger(terminalInput.selectionStart) ? terminalInput.selectionStart : inputValue.length;
    const inputSelectionEnd = terminalWasFocused && Number.isInteger(terminalInput.selectionEnd) ? terminalInput.selectionEnd : inputSelectionStart;
    const focusSnapshot = options.preserveInput ? this.captureFocus(terminalInput) : null;
    const folderCreateValue = state.ui.folderCreateKind ? this.getFolderCreateName() : "";
    const folderScrollTop = captureFolderScroll(this.root, tab.folder.path);
    const clipboardScrollTop = captureClipboardScroll(this.root);
    const settingsScrollTop = captureSettingsScroll(this.root);
    const processSortBy = state.system?.sortBy || "";
    const resetProcessScroll = this.lastProcessSortBy !== null && this.lastProcessSortBy !== processSortBy;
    const processScrollTop = resetProcessScroll ? 0 : captureProcessScroll(this.root);
    const nativeWebview = options.nativeWebview !== undefined ? Boolean(options.nativeWebview) : Boolean(options.native);
    this.root.innerHTML = `
      <div class="auri-shell">
        ${renderMainTabs(state)}
        <main class="app-surface">
          ${renderSubtabs(state, { native: nativeWebview })}
          <div class="workspace-grid" style="--folder-pane-width:${state.settings.folderPaneWidth}px">
            ${renderFolder(state)}
            <div class="content-pane">${renderActivePanel(state, { native: nativeWebview })}${renderFolderFilePreview(state)}${renderAssistantTranscriptPopup(state)}</div>
          </div>
        </main>
      </div>
      ${renderWebOverlay(state, { native: nativeWebview })}
      ${renderSystemTunnelPrompt(state)}
      ${renderSystemKillPrompt(state)}
      ${state.ui.commandPaletteOpen ? this.renderCommandPalette() : ""}`;
    const active = activeSubtab(state);
    this.restoreTerminalHost(active?.type === "terminal" ? active.id : null);

    const nextTerminalInput = this.getTerminalInput();
    if (nextTerminalInput) {
      nextTerminalInput.value = inputValue;
      if (terminalWasFocused) {
        nextTerminalInput.focus?.();
        const safeStart = Math.min(nextTerminalInput.value.length, Math.max(0, inputSelectionStart));
        const safeEnd = Math.min(nextTerminalInput.value.length, Math.max(safeStart, inputSelectionEnd));
        nextTerminalInput.setSelectionRange?.(safeStart, safeEnd);
      }
    }
    if (focusSnapshot && !terminalWasFocused) this.restoreFocus(focusSnapshot);
    if (folderCreateValue && this.root.querySelector("#folder-create-input")) {
      this.root.querySelector("#folder-create-input").value = folderCreateValue;
    }
    const folder = this.root.querySelector(".folder-list");
    if (folder) folder.scrollTop = folderScrollTop;
    const clipboard = this.root.querySelector(".clipboard-grid");
    if (clipboard) clipboard.scrollTop = clipboardScrollTop;
    const settings = this.root.querySelector(".settings-scroll");
    if (settings) settings.scrollTop = settingsScrollTop;
    const processTable = this.root.querySelector(".process-table");
    if (processTable) processTable.scrollTop = processScrollTop;
    this.lastProcessSortBy = processSortBy;
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

  // In-place refresh for the quiet 5s system-monitor poll. Updates the
  // status line, metric tiles, disk/net rows, process table, and the
  // selected-process detail inside the open System/Disk/Net panel without
  // rebuilding the whole shell (which would drop focus, hover, and scroll
  // everywhere else). Returns false when the expected structure is missing
  // so the caller can fall back to a full render.
  patchSystemMonitor(state) {
    const panel = this.root?.querySelector?.(".system-panel");
    if (!panel) return false;
    const kind = activeSubtab(state)?.type;
    if (!["system", "disk", "net"].includes(kind)) return false;
    const processPage = buildProcessMonitorPage(state, kind);

    const status = panel.querySelector("[data-system-status]");
    if (status && kind === "system") {
      status.textContent = buildSystemStatusText(state);
      status.classList?.toggle?.("is-error", state.system.status === "error");
    }
    const host = panel.querySelector("[data-system-host]");
    if (host) host.textContent = state.system.snapshot?.host?.hostname || "—";
    const pageLabel = panel.querySelector("[data-system-page]");
    if (pageLabel) pageLabel.textContent = `Page ${processPage.currentPage} / ${processPage.pageCount}`;
    const previousPageButton = panel.querySelector("[data-system-page-prev]");
    if (previousPageButton) previousPageButton.disabled = !processPage.hasPrevious;
    const nextPageButton = panel.querySelector("[data-system-page-next]");
    if (nextPageButton) nextPageButton.disabled = !processPage.hasNext;

    for (const metric of buildSystemMetrics(state, kind)) {
      const tile = panel.querySelector(`[data-metric="${metric.key}"]`);
      if (!tile) return false;
      const value = tile.querySelector("[data-metric-value]");
      if (value) value.textContent = metric.value;
      const unit = tile.querySelector("[data-metric-unit]");
      if (unit) {
        unit.textContent = metric.unit || "";
        unit.hidden = !metric.unit;
      }
      const detail = tile.querySelector("[data-metric-detail]");
      if (detail) {
        detail.textContent = metric.detail || "";
        detail.hidden = !metric.detail;
      }
    }

    if (kind === "disk" && !this.patchKeyedRows(panel, buildDiskMountRows(state), "mount", ["title", "percent", "usage", "free"])) return false;
    if (kind === "net" && !this.patchKeyedRows(panel, buildNetInterfaceRows(state), "interface", ["title", "status", "ip", "traffic"])) return false;

    const monitor = panel.querySelector(".process-monitor");
    if (monitor) {
      if (!this.patchProcessRows(monitor, processPage.rows, processPage)) {
        const scrollTop = monitor.querySelector(".process-table")?.scrollTop || 0;
        monitor.innerHTML = renderProcessMonitorContent(state, kind);
        const table = monitor.querySelector(".process-table");
        if (table) table.scrollTop = scrollTop;
      }
    }

    const detailHtml = renderSystemProcessDetail(state, kind);
    const backdrop = panel.querySelector(".system-process-detail-backdrop");
    if (backdrop && detailHtml) backdrop.outerHTML = detailHtml;
    else if (backdrop) backdrop.remove();
    else if (detailHtml) panel.insertAdjacentHTML?.("beforeend", detailHtml);
    return true;
  }

  patchKeyedRows(panel, rows, prefix, fields) {
    const existing = panel.querySelectorAll?.(`[data-${prefix}-row]`);
    if (existing && existing.length !== rows.length) return false;
    for (const row of rows) {
      const element = panel.querySelector(`[data-${prefix}-row="${row.key}"]`);
      if (!element) return false;
      for (const field of fields) {
        const target = element.querySelector(`[data-${prefix}-${field}]`);
        if (target) target.textContent = row[field];
      }
    }
    return true;
  }

  patchProcessRows(monitor, rows, page = { total: rows.length, currentPage: 1, pageCount: 1, hasPrevious: false, hasNext: false }) {
    const table = monitor?.querySelector?.(".process-table");
    if (!table || !rows.length) return false;
    const existing = table.querySelectorAll?.("[data-process-row]");
    if (!existing || existing.length !== rows.length) return false;
    for (const row of rows) {
      const element = table.querySelector(`[data-process-row="${row.key}"]`);
      if (!element) return false;
      const nameCell = element.querySelector("[data-process-name]");
      if (nameCell) {
        nameCell.textContent = row.name;
        nameCell.title = row.nameTitle;
      }
      const portCell = element.querySelector("[data-process-port]");
      if (portCell) portCell.innerHTML = formatProcessPortCell(row.ports);
      const ramCell = element.querySelector("[data-process-ram]");
      if (ramCell) ramCell.textContent = row.ram;
      const cpuCell = element.querySelector("[data-process-cpu]");
      if (cpuCell) cpuCell.textContent = row.cpu;
      const diskCell = element.querySelector("[data-process-disk]");
      if (diskCell) diskCell.textContent = row.disk;
      const netCell = element.querySelector("[data-process-net]");
      if (netCell) netCell.textContent = row.net;
      element.classList?.toggle?.("is-selected", row.selected);
    }
    if (table.dataset) {
      table.dataset.hasPrevious = String(Boolean(page.hasPrevious));
      table.dataset.hasNext = String(Boolean(page.hasNext));
      table.dataset.processPage = String(Number(page.currentPage) || 1);
      table.dataset.processPages = String(Number(page.pageCount) || 1);
      table.dataset.processTotal = String(Number(page.total) || 0);
    }
    const status = table.querySelector?.("[data-process-load-status]");
    if (status) {
      const pageProcessLabel = `${rows.length} process${rows.length === 1 ? "" : "es"} on page ${page.currentPage} of ${page.pageCount}`;
      const scrollHint = page.hasPrevious && page.hasNext
        ? "scroll up or down to change page"
        : page.hasPrevious
          ? "scroll up for previous page"
          : page.hasNext
            ? "scroll down for next page"
            : "";
      status.textContent = scrollHint ? `${pageProcessLabel} · ${scrollHint}` : pageProcessLabel;
    }
    const countLabel = monitor.querySelector(".process-monitor-head span:last-child");
    if (countLabel) countLabel.textContent = `${rows.length} on page`;
    return true;
  }

  renderCommandPalette() {
    return `<div class="palette-backdrop" data-action="palette-close"><section class="command-palette" role="dialog" aria-modal="true" aria-label="Auri command palette" onclick="event.stopPropagation()"><div class="palette-input"><span>⌘</span><input id="palette-input" autocomplete="off" placeholder="Type an Auri command…"></div><div class="palette-hints"><button type="button" data-action="palette-command" data-value="tab new">＋ New workspace</button><button type="button" data-action="palette-command" data-value="subtab new terminal">⌘ New terminal</button><button type="button" data-action="palette-command" data-value="clipboard list">▣ Clipboard</button><button type="button" data-action="palette-command" data-value="settings set alwaysAttachScreenshot true">◇ Attach screenshots</button><button type="button" data-action="palette-command" data-value="help">ⓘ Command help</button></div></section></div>`;
  }

  setFolderPaneWidth(width) {
    const value = Math.min(420, Math.max(160, Number(width) || 230));
    this.root.querySelector?.(".workspace-grid")?.style?.setProperty("--folder-pane-width", `${value}px`);
    return value;
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

  setTerminalCompletions(items = [], selectedIndex = -1) {
    const popup = this.root.querySelector("#terminal-completion");
    const input = this.getTerminalInput();
    if (!popup || !input) return;

    popup.replaceChildren();
    if (!items.length) {
      popup.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }

    const documentRef = popup.ownerDocument || this.root.ownerDocument || globalThis.document;
    const safeIndex = Math.min(items.length - 1, Math.max(0, selectedIndex));
    items.forEach((item, index) => {
      const option = documentRef.createElement("button");
      option.type = "button";
      option.id = `terminal-completion-option-${index}`;
      option.className = "terminal-completion-option";
      option.dataset.action = "terminal-completion-select";
      option.dataset.index = String(index);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === safeIndex));
      option.tabIndex = -1;

      const glyph = documentRef.createElement("span");
      glyph.className = `terminal-completion-glyph is-${item.kind || "history"}`;
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = item.kind === "directory"
        ? "▸"
        : item.kind === "file"
          ? "◇"
          : item.kind === "custom"
            ? "+"
            : item.kind === "shell"
              ? "↺"
              : "⌘";
      const label = documentRef.createElement("span");
      label.className = "terminal-completion-label";
      label.textContent = item.label || item.value;
      const detail = documentRef.createElement("span");
      detail.className = "terminal-completion-detail";
      detail.textContent = item.detail || (item.kind === "history" ? "History" : "Current folder");
      option.title = item.value;
      option.append(glyph, label, detail);
      popup.append(option);
    });

    popup.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", `terminal-completion-option-${safeIndex}`);
    popup.children[safeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  replaceTerminalInputRange(start, end, value, focus = true) {
    const input = this.getTerminalInput();
    if (!input) return false;
    const safeStart = Math.min(input.value.length, Math.max(0, Number(start) || 0));
    const safeEnd = Math.min(input.value.length, Math.max(safeStart, Number(end) || safeStart));
    input.value = `${input.value.slice(0, safeStart)}${value}${input.value.slice(safeEnd)}`;
    const cursor = safeStart + String(value).length;
    if (focus) input.focus();
    input.setSelectionRange(cursor, cursor);
    return true;
  }

  insertTerminalText(value) {
    const input = this.getTerminalInput();
    if (!input) return false;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    return this.replaceTerminalInputRange(start, end, value);
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

  getCustomCompletions() {
    return this.root.querySelector("#custom-completions")?.value || "";
  }

  syncCustomCompletionLineNumbers(value = this.getCustomCompletions()) {
    const lineNumbers = customCompletionLineNumbers(value);
    const gutter = this.root.querySelector("#custom-completions-lines");
    if (gutter) gutter.textContent = lineNumbers;
    const count = lineNumbers.split("\n").length;
    const countLabel = this.root.querySelector("#custom-completions-count");
    if (countLabel) countLabel.textContent = `${count} ${count === 1 ? "line" : "lines"}`;
    return count;
  }

  syncCustomCompletionScroll(input = this.root.querySelector("#custom-completions")) {
    const gutter = this.root.querySelector("#custom-completions-lines");
    if (!gutter || !input) return 0;
    gutter.scrollTop = input.scrollTop || 0;
    return gutter.scrollTop;
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
