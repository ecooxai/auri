import { escapeHtml } from "../model/assistant.js";
import { formatBytes, iconForEntry, workspaceLabel } from "../model/presentation.js";
import { previewClipboardText } from "../model/clipboard.js";
import { activeSubtab, activeWorkspace } from "../model/state.js";
import { sortFolderEntries } from "../model/folder.js";
import { defaultBookmarkName, normalizeWebUrl, webZoomPercent } from "../model/browser.js";
import { emptySystemSnapshot, sortSystemProcesses } from "../model/system.js";

const subtabIcons = {
  terminal: "⌘",
  webview: "◎",
  viewer: "◈",
  clipboard: "▣",
  audio: "♪",
  video: "▷",
  settings: "⚙",
  system: "◬",
  disk: "▤",
  net: "⇄",
  info: "ⓘ"
};

const button = (icon, label, action, extra = "") =>
  `<button class="icon-button" type="button" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${extra}>${icon}</button>`;

export function renderAssistantTranscriptPopup(state) {
  const configured = Array.isArray(state?.ui?.assistantActions) ? state.ui.assistantActions : [];
  const legacy = Array.isArray(state?.ui?.assistantTranscripts)
    ? state.ui.assistantTranscripts.map((text) => ({ kind: "insert", text }))
    : [];
  const items = (configured.length ? configured : legacy)
    .filter((item) => ["command", "insert"].includes(item?.kind) && String(item?.text || "").trim())
    .map((item) => ({ kind: item.kind, text: String(item.text).trim() }));
  if (!items.length) return "";

  return `<aside class="assistant-transcript-popup assistant-action-popup" role="dialog" aria-label="AI reply actions">
    <header><strong>AI actions</strong><button type="button" data-action="transcript-dismiss" aria-label="Close AI actions" title="Close">×</button></header>
    <div class="assistant-transcript-list assistant-action-list">
      ${items.map((item) => {
        const escaped = escapeHtml(item.text);
        const command = item.kind === "command";
        return `<div class="assistant-transcript-row assistant-action-row is-${item.kind}">
          <pre>${escaped}</pre>
          <div class="assistant-transcript-actions assistant-action-buttons">
            <button type="button" data-action="copy-text" data-value="${escaped}">Copy</button>
            <button type="button" data-action="assistant-insert" data-value="${escaped}">Insert</button>
            ${command ? `<button type="button" class="is-primary" data-action="assistant-run" data-value="${escaped}">Run</button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  </aside>`;
}

export function renderMainTabs(state) {
  return `
    <nav class="main-tabs" aria-label="Workspaces">
      <div class="main-tab-list">
        ${state.tabs.map((tab) => `
          <button type="button" class="main-tab ${tab.id === state.activeTabId ? "is-active" : ""}"
            data-action="tab-select" data-id="${tab.id}" title="${escapeHtml(workspaceLabel(tab))}">
            <span class="main-tab-label">${escapeHtml(workspaceLabel(tab))}</span>
          </button>
        `).join("")}
      </div>
      ${button("＋", "New workspace", "tab-new")}
      <div class="rail-spacer"></div>
      ${button("×", "Close workspace", "tab-close")}
    </nav>`;
}

export function renderSubtabs(state, { native = false } = {}) {
  const tab = activeWorkspace(state);
  const nativeWebviewActive = native && activeSubtab(state).type === "webview";
  return `
    <div class="subtab-bar chrome-tabbar" data-tauri-drag-region>
      <div class="subtab-scroll" role="tablist" aria-label="Workspace tabs" data-tauri-drag-region>
        ${tab.subtabs.map((item) => `
          <button type="button" role="tab" aria-selected="${item.id === tab.activeSubtabId}" class="subtab ${item.id === tab.activeSubtabId ? "is-active" : ""}"
            data-action="subtab-select" data-id="${item.id}" title="${escapeHtml(item.title)}">
            <span class="subtab-icon" aria-hidden="true">${subtabIcons[item.type] || "·"}</span>
            <span class="subtab-title">${escapeHtml(item.title)}</span>
            ${tab.subtabs.length > 1 ? `<i data-action="subtab-close" data-id="${item.id}" aria-label="Close tab">×</i>` : ""}
          </button>
        `).join("")}
      </div>
      <div class="chrome-actions" aria-label="Tab controls">
        <div class="subtab-add-wrap">
          ${button("＋", "New tab", "subtab-menu", 'data-chrome-control="true"')}
          ${state.ui.addSubtabMenuOpen && !nativeWebviewActive ? renderSubtabMenu() : ""}
        </div>
        ${button("⌘", "Command palette", "command-palette", 'data-chrome-control="true"')}
      </div>
    </div>`;
}

function renderSubtabMenu() {
  const items = [
    ["terminal", "⌘", "Terminal"], ["webview", "◎", "Webview"], ["viewer", "◈", "Viewer"],
    ["clipboard", "▣", "Clipboard"], ["audio", "♪", "Audio recording"], ["video", "▷", "Video recording"],
    ["settings", "⚙", "Settings"], ["system", "◬", "System monitor"], ["disk", "▤", "Disk monitor"], ["net", "⇄", "Network monitor"], ["info", "ⓘ", "Info"]
  ];
  return `<div class="pop-menu" role="menu">
    ${items.map(([type, icon, label]) => `<button type="button" data-action="subtab-new" data-type="${type}"><span>${icon}</span>${label}</button>`).join("")}
  </div>`;
}

export function renderFolder(state) {
  const tab = activeWorkspace(state);
  const entries = sortFolderEntries(tab.folder.entries || [], tab.folder.sortBy);
  return `
    <aside class="folder-pane">
      <div class="pane-heading">
        <div class="compact-actions folder-toolbar" aria-label="Folder navigation">
          ${button("⌂", "Home", "folder-home")}
          ${button("↑", "Parent folder", "folder-up")}
          ${button("↻", "Refresh", "folder-refresh")}
          <div class="folder-more-wrap">
            ${button("⋯", "More folder actions", "folder-more", `aria-haspopup="menu" aria-expanded="${state.ui.folderMenuOpen}"`)}
            ${state.ui.folderMenuOpen ? renderFolderMenu(tab.folder.sortBy) : ""}
          </div>
        </div>
        <label class="folder-path-field" for="folder-path-input">
          <input id="folder-path-input" class="folder-path-input" type="text" value="${escapeHtml(tab.folder.path)}"
            aria-label="Folder path" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        </label>
        ${state.ui.folderCreateKind ? renderFolderCreateForm(state.ui.folderCreateKind) : ""}
      </div>
      <div class="folder-list" role="list" data-folder-path="${escapeHtml(tab.folder.path)}">
        ${entries.length ? entries.map((entry) => {
          const selected = entry.path === tab.folder.selectedPath;
          return `<button type="button" class="file-row ${selected ? "is-selected" : ""}" data-action="file-entry"
            data-path="${escapeHtml(entry.path)}" data-kind="${escapeHtml(entry.kind)}">
            <span class="file-icon">${iconForEntry(entry)}</span>
            <span class="file-name">${escapeHtml(entry.name)}</span>
            <span class="file-size">${entry.kind === "directory" ? "" : formatBytes(entry.size)}</span>
          </button>`;
        }).join("") : `<div class="empty-small"><span>◇</span><p>This folder is empty.</p></div>`}
      </div>
      <div class="folder-footer"><span>${entries.length} items</span><span>Synced with terminal</span></div>
    </aside>`;
}

function renderFolderCreateForm(kind) {
  const label = kind === "file" ? "New file name" : "New folder name";
  const placeholder = kind === "file" ? "untitled.txt" : "New Folder";
  return `<div class="folder-create-popover">
    <form id="folder-create-form" class="folder-create-form" autocomplete="off">
      <input id="folder-create-input" name="name" type="text" aria-label="${label}" placeholder="${placeholder}"
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <button type="button" data-action="folder-create-confirm">OK</button>
    </form>
    <small>Enter to create · Esc to cancel</small>
  </div>`;
}

function renderFolderMenu(sortBy) {
  return `<div class="folder-menu" role="menu" aria-label="More folder actions">
    <div class="folder-menu-label">Sort</div>
    <button type="button" role="menuitemradio" aria-checked="${sortBy === "name"}" data-action="folder-sort" data-sort="name">${sortBy === "name" ? "✓" : ""}<span>Name</span></button>
    <button type="button" role="menuitemradio" aria-checked="${sortBy === "date"}" data-action="folder-sort" data-sort="date">${sortBy === "date" ? "✓" : ""}<span>Date</span></button>
    <button type="button" role="menuitemradio" aria-checked="${sortBy === "type"}" data-action="folder-sort" data-sort="type">${sortBy === "type" ? "✓" : ""}<span>Type</span></button>
    <div class="folder-menu-separator"></div>
    <button type="button" data-action="folder-new-file">New File</button>
    <button type="button" data-action="folder-new-folder">New Folder</button>
    <button type="button" data-action="folder-info">Info</button>
  </div>`;
}

function renderLiveStatus(status) {
  const messages = {
    recording: "Listening…",
    connecting: "Listening while Gemini Live connects…",
    connected: "Live chat connected — listening…",
    processing: "Gemini is responding…",
    disconnecting: "Disconnecting Live chat after no reply…",
    "disconnected-idle": "Live chat disconnected after inactivity.",
    "disconnected-timeout": "Live chat disconnected — no reply before the configured timeout.",
    disconnected: "Live chat disconnected."
  };
  const message = messages[status];
  if (!message) return "";
  const tone = status === "connected"
    ? "connected"
    : status.startsWith("disconnected")
      ? "disconnected"
      : status;
  return `<div class="live-status-banner is-${tone}" role="status" aria-live="polite"><span aria-hidden="true"></span>${message}</div>`;
}

export function renderTerminal(state) {
  const tab = activeWorkspace(state);
  const terminal = activeSubtab(state);
  const terminalId = terminal?.type === "terminal" ? terminal.id : tab.subtabs.find((item) => item.type === "terminal")?.id || tab.id;
  return `
    <section class="terminal-panel">
      <div class="terminal-toolbar">
        <div class="cwd-pill"><span>⌂</span><strong>${escapeHtml(tab.terminal.cwd)}</strong></div>
        <div class="terminal-status"><span class="status-dot ${tab.terminal.running ? "is-busy" : ""}"></span>${tab.terminal.running ? "Working" : "Ready"}</div>
        ${button("⌫", "Clear terminal", "terminal-clear")}
      </div>
      <div class="terminal-history" id="terminal-history"><div id="terminal-emulator" class="terminal-emulator" data-workspace-id="${escapeHtml(tab.id)}" data-terminal-id="${escapeHtml(terminalId)}"></div></div>
      <div class="terminal-input-zone">
        <div id="terminal-completion" class="terminal-completion" role="listbox" aria-label="Terminal completion suggestions" hidden></div>
        <div class="composer-wrap">
          ${renderLiveStatus(state.ui.liveStatus)}
          ${state.media.attachments.length ? `<div class="attachment-row">${state.media.attachments.map((item) => `<span class="attachment-chip">${item.kind === "image" ? "◈" : item.kind === "audio" ? "♪" : "▷"} ${escapeHtml(item.name)}<button type="button" data-action="attachment-remove" data-id="${item.id}">×</button></span>`).join("")}</div>` : ""}
          <textarea id="terminal-input" rows="3" role="combobox" aria-autocomplete="list" aria-controls="terminal-completion" aria-expanded="false" aria-haspopup="listbox" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" placeholder="Type a command or ask Auri…  Enter adds a line · hold Enter 2s or ⌘/Ctrl + Enter runs"></textarea>
        <div class="composer-actions">
          <label class="model-select-wrap ${state.ui.liveConnected ? "is-live-connected" : ""}" title="Select AI model">
            <select id="terminal-model-select" class="model-select" aria-label="AI model">
              ${state.models.filter((item) => item.enabled).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedModelId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
            </select>
          </label>
          <div class="composer-buttons">
            <label class="icon-button attach-button" title="Attach files" aria-label="Attach files">＋<input id="file-attachment" type="file" multiple hidden></label>
            <button type="button" class="icon-button live-mic-button${state.ui.liveConnected && state.ui.liveRecording ? " is-recording" : ""}" data-action="live-record" aria-label="${state.ui.liveConnected && state.ui.liveRecording ? "Recording — release to send or click to disconnect" : "Click to connect or hold one second to talk"}" title="${state.ui.liveConnected && state.ui.liveRecording ? "Recording — release to send or click to disconnect" : "Click to connect or hold one second to talk"}" aria-pressed="${state.ui.liveConnected && state.ui.liveRecording}">${state.ui.liveConnected && state.ui.liveRecording ? '<span class="live-recording-glyph" aria-hidden="true"><i></i><i></i><i></i></span>' : '<svg class="live-mic-glyph" aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a6 6 0 0 0 12 0M12 18v3M9 21h6"/></svg>'}</button>
            <button type="button" class="action-button primary" data-action="terminal-ask"><span>✦</span>Ask</button>
            <button type="button" class="action-button secondary" data-action="terminal-run"><span>▶</span>Run</button>
          </div>
          </div>
        </div>
      </div>
    </section>`;
}

function formatSampleRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate >= 1000 ? `${Number((rate / 1000).toFixed(1))} kHz` : `${rate} Hz`;
}

function metadataRows(meta) {
  if (!meta) return "";
  const typeCodec = [meta.fileType || meta.kind, meta.codec].filter(Boolean).join(" · ");
  const sizeBitrate = [
    formatBytes(meta.size),
    meta.bitrate ? `${Math.round(meta.bitrate / 1000)} kbps` : null
  ].filter(Boolean).join(" · ");
  const values = [
    ["Type · Codec", typeCodec],
    ["Size · Bitrate", sizeBitrate],
    ["Sample rate", formatSampleRate(meta.sampleRate)],
    ["Resolution", meta.width && meta.height ? `${meta.width} × ${meta.height}` : null],
    ["Modified", meta.modified ? new Date(meta.modified).toLocaleString() : null]
  ].filter(([, value]) => value);
  return values.map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

export function renderViewer(state) {
  const viewer = activeWorkspace(state).viewer;
  if (!viewer.path) return renderEmptyPanel("◈", "Choose a file", "Click a file once for details and again to open it.");
  const meta = viewer.metadata || {};
  let preview = `<div class="generic-preview"><span>${iconForEntry(meta)}</span><p>Open this file in its native application.</p></div>`;
  if (meta.kind === "image") preview = meta.assetUrl ? `<div class="image-preview"><img src="${escapeHtml(meta.assetUrl)}" alt="${escapeHtml(meta.name || "Image preview")}"></div>` : `<div class="image-preview"><div class="image-placeholder"><span>◈</span><strong>${escapeHtml(meta.name || viewer.path)}</strong><small>${meta.width || "—"} × ${meta.height || "—"}</small></div></div>`;
  if (meta.kind === "audio") preview = `<div class="media-preview"><span class="media-art">♪</span><audio controls src="${escapeHtml(meta.assetUrl || "")}"></audio></div>`;
  if (meta.kind === "video") preview = `<div class="media-preview"><video controls src="${escapeHtml(meta.assetUrl || "")}"></video></div>`;
  if (meta.kind === "text") preview = `<pre class="text-preview">${escapeHtml(meta.preview || "Select Open to load the native file contents.")}</pre>`;
  return `<section class="viewer-panel">
    <header class="panel-title"><div><span>${iconForEntry(meta)}</span><div><small>FILE</small><h2>${escapeHtml(meta.name || viewer.path.split("/").pop())}</h2></div></div>${button("↗", "Open externally", "file-external")}</header>
    <div class="viewer-layout"><div class="viewer-stage">${viewer.mode === "open" ? preview : `<div class="inspect-hint"><span>◎</span><p>Click the selected file again to open a preview.</p></div>`}</div><aside class="metadata-panel"><span class="eyebrow">DETAILS</span>${metadataRows(meta)}<p class="full-path">${escapeHtml(viewer.path)}</p></aside></div>
  </section>`;
}

function renderWebMenu(subtab) {
  return `<div class="web-menu" role="menu" aria-label="Browser menu">
    <button type="button" role="menuitem" data-action="web-external"><span>↗</span><strong>Open externally</strong></button>
    <button type="button" role="menuitem" data-action="web-download"><span>↓</span><strong>Download page</strong></button>
    <button type="button" role="menuitem" data-action="web-add-bookmark"><span>☆</span><strong>Add bookmark</strong></button>
    <button type="button" role="menuitem" data-action="web-bookmarks"><span>★</span><strong>Bookmarks</strong></button>
    <button type="button" role="menuitem" data-action="web-history"><span>◷</span><strong>History</strong></button>
    <div class="web-menu-separator"></div>
    <div class="web-zoom-row" aria-label="Page zoom">
      <span>Zoom</span>
      <div><button type="button" data-action="web-zoom-out" aria-label="Zoom out">−</button><button class="web-zoom-value" type="button" data-action="web-zoom-reset" aria-label="Reset zoom">${webZoomPercent(subtab.zoom)}</button><button type="button" data-action="web-zoom-in" aria-label="Zoom in">＋</button></div>
    </div>
    <div class="web-menu-separator"></div>
    <button type="button" role="menuitem" data-action="web-devtools"><span>⌘</span><strong>Developer tools</strong></button>
  </div>`;
}

function renderBookmarkDialog(state, subtab) {
  const draft = state.ui.bookmarkDraft || {};
  const rawUrl = draft.url || subtab.url || "";
  let url = rawUrl;
  try {
    url = normalizeWebUrl(rawUrl);
  } catch {}
  const name = draft.name || defaultBookmarkName(url);
  return `<div class="web-dialog-backdrop" data-action="web-dialog-close">
    <section class="web-dialog web-bookmark-dialog" role="dialog" aria-modal="true" aria-label="Add bookmark" onclick="event.stopPropagation()">
      <header><div><span>☆</span><div><small>PAGE</small><h2>Add bookmark</h2></div></div><button type="button" data-action="web-dialog-close" aria-label="Close">×</button></header>
      <form id="web-bookmark-form">
        <label>Name<input id="web-bookmark-name" name="name" value="${escapeHtml(name)}" required autocomplete="off"></label>
        <label>URL<input id="web-bookmark-url" name="url" type="url" value="${escapeHtml(url)}" required autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div><button class="action-button secondary" type="button" data-action="web-dialog-close">Cancel</button><button class="action-button primary" type="submit">Save bookmark</button></div>
      </form>
    </section>
  </div>`;
}

function renderBookmarksDialog(state) {
  const rows = state.browser.bookmarks.length
    ? state.browser.bookmarks.map((item) => `<article class="web-list-row">
        <button class="web-list-open" type="button" data-action="web-bookmark-open" data-url="${escapeHtml(item.url)}">
          <span>★</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.url)}</small></div>
        </button>
        <button class="web-list-remove" type="button" data-action="web-bookmark-remove" data-id="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}">×</button>
      </article>`).join("")
    : `<div class="web-list-empty"><span>☆</span><strong>No bookmarks yet</strong><p>Save the current page from the browser menu.</p></div>`;
  return `<div class="web-dialog-backdrop" data-action="web-dialog-close">
    <section class="web-dialog web-list-dialog" role="dialog" aria-modal="true" aria-label="Bookmarks" onclick="event.stopPropagation()">
      <header><div><span>★</span><div><small>LIBRARY</small><h2>Bookmarks</h2></div></div><button type="button" data-action="web-dialog-close" aria-label="Close">×</button></header>
      <div class="web-list">${rows}</div>
      <footer><button class="action-button primary" type="button" data-action="web-add-bookmark">＋ Add bookmark</button></footer>
    </section>
  </div>`;
}

function renderHistoryDialog(state) {
  const rows = state.browser.history.length
    ? state.browser.history.map((item) => `<button class="web-history-row" type="button" data-action="web-history-open" data-url="${escapeHtml(item.url)}">
        <span>◷</span><div><strong>${escapeHtml(item.title || defaultBookmarkName(item.url))}</strong><small>${escapeHtml(item.url)}</small></div><time>${escapeHtml(new Date(item.at).toLocaleString())}</time>
      </button>`).join("")
    : `<div class="web-list-empty"><span>◷</span><strong>No browsing history</strong><p>Pages opened in Auri will appear here.</p></div>`;
  return `<div class="web-dialog-backdrop" data-action="web-dialog-close">
    <section class="web-dialog web-list-dialog" role="dialog" aria-modal="true" aria-label="History" onclick="event.stopPropagation()">
      <header><div><span>◷</span><div><small>RECENT</small><h2>History</h2></div></div><button type="button" data-action="web-dialog-close" aria-label="Close">×</button></header>
      <div class="web-list">${rows}</div>
      <footer>${state.browser.history.length ? `<button class="action-button secondary" type="button" data-action="web-history-clear">Clear history</button>` : ""}</footer>
    </section>
  </div>`;
}

function renderWebDialog(state, subtab) {
  if (state.ui.webDialog === "add-bookmark") return renderBookmarkDialog(state, subtab);
  if (state.ui.webDialog === "bookmarks") return renderBookmarksDialog(state);
  if (state.ui.webDialog === "history") return renderHistoryDialog(state);
  return "";
}

export function renderSystemTunnelPrompt(state) {
  const prompt = state.ui?.systemTunnelPrompt;
  if (!prompt) return "";
  const danger = prompt.kind === "stop";
  const icon = prompt.kind === "install" ? "↓" : prompt.kind === "stop" ? "■" : "↗";
  return `<div class="system-tunnel-prompt-backdrop" data-action="system-tunnel-prompt-cancel">
    <section class="system-tunnel-prompt" role="dialog" aria-modal="true" aria-label="${escapeHtml(prompt.title || "Confirm tunnel action")}">
      <header><span>${icon}</span><div><small>HTTPS tunnel</small><h2>${escapeHtml(prompt.title || "Confirm tunnel action")}</h2></div></header>
      <p>${escapeHtml(prompt.message || "")}</p>
      <footer>
        <button type="button" class="action-button secondary" data-action="system-tunnel-prompt-cancel">Cancel</button>
        <button type="button" class="action-button ${danger ? "secondary danger" : "primary"}" data-action="system-tunnel-prompt-confirm">${escapeHtml(prompt.confirmLabel || "Confirm")}</button>
      </footer>
    </section>
  </div>`;
}

export function renderWebOverlay(state, { native = false } = {}) {
  if (native) return "";
  const subtab = activeSubtab(state);
  if (subtab.type !== "webview" || !state.ui.webDialog) return "";
  return renderWebDialog(state, subtab);
}

export function renderWebview(state, { native = false } = {}) {
  const subtab = activeSubtab(state);
  const url = subtab.url || "https://www.google.com/";
  const displayUrl = subtab.filePath || url;
  const content = subtab.filePath
    ? `<object class="file-web-object" data="${escapeHtml(url)}" type="${escapeHtml(subtab.fileMime || "application/octet-stream")}"><p>This file cannot be previewed here.</p></object>`
    : `<div id="native-webview-host" class="native-webview-host" data-webview-id="${escapeHtml(subtab.id)}" data-url="${escapeHtml(url)}"><div class="native-webview-fallback"><span>◎</span><p>Website content opens in the native Auri webview.</p><small>Browser preview cannot bypass site embedding restrictions.</small></div></div>`;
  return `<section class="web-panel">
    <div class="url-bar">${button("←", "Back", "web-back")}${button("→", "Forward", "web-forward")}${button("↻", "Reload", "web-reload")}<input id="web-url" value="${escapeHtml(displayUrl)}" aria-label="URL"><button type="button" class="go-button" data-action="web-go">Go</button><div class="web-menu-wrap">${button("⋮", "Browser menu", "web-menu", `aria-haspopup="menu" aria-expanded="${state.ui.webMenuOpen}"`)}${state.ui.webMenuOpen && !native ? `<button class="web-menu-dismiss" type="button" data-action="web-menu-close" aria-label="Close browser menu"></button>${renderWebMenu(subtab)}` : ""}</div></div>
    <div class="web-frame-wrap">${content}</div>
  </section>`;
}

function renderAiRequestDetails(details, infoId) {
  const text = String(details.text || "");
  const media = Array.isArray(details.media) ? details.media : [];
  const cards = media.map((item, index) => {
    const id = escapeHtml(item.id || `media-${index}`);
    const name = escapeHtml(item.name || `Attachment ${index + 1}`);
    const url = escapeHtml(item.url || "");
    const kind = item.kind || "file";
    let preview = `<span class="ai-request-file-glyph" aria-hidden="true">◇</span>`;
    if (kind === "image" && url) {
      preview = `<button class="ai-request-image" type="button" data-action="info-media-open" data-info-id="${escapeHtml(infoId)}" data-media-id="${id}" aria-label="View ${name}"><img src="${url}" alt="${name}"></button>`;
    } else if (kind === "audio" && url) {
      preview = `<audio controls preload="metadata" src="${url}" aria-label="Play ${name}"></audio>`;
    } else if (kind === "video" && url) {
      preview = `<video controls preload="metadata" src="${url}" aria-label="Play ${name}"></video>`;
    }
    return `<div class="ai-request-media-card is-${escapeHtml(kind)}">${preview}<div><strong>${name}</strong><small>${escapeHtml(item.mime || kind)}</small></div></div>`;
  }).join("");
  return `<div class="ai-request-details">${text ? `<pre class="ai-request-text">${escapeHtml(text)}</pre>` : ""}${cards ? `<div class="ai-request-media-grid">${cards}</div>` : `<small class="ai-request-no-media">No media attached.</small>`}</div>`;
}

function renderInfoDetails(details, infoId = "") {
  if (!details) return "";
  if (details.type === "ai-request") return renderAiRequestDetails(details, infoId);
  const permissions = details.permissions || {};
  const access = [permissions.read ? "Read" : null, permissions.write ? "Write" : null, permissions.execute ? "Execute" : null].filter(Boolean).join(" · ") || "None";
  const rows = [
    ["Folder size", Number.isFinite(details.totalSize) ? formatBytes(details.totalSize) : null],
    ["Disk used", Number.isFinite(details.diskUsed) ? formatBytes(details.diskUsed) : null],
    ["Disk available", Number.isFinite(details.diskAvailable) ? formatBytes(details.diskAvailable) : null],
    ["Disk capacity", Number.isFinite(details.diskTotal) ? formatBytes(details.diskTotal) : null],
    ["Owner", details.owner],
    ["Permissions", details.mode],
    ["Owner access", access]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  return `<dl class="info-details">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function renderInfoMediaViewer(state) {
  const media = state.ui.infoMediaPreview;
  if (!media?.url) return "";
  const name = escapeHtml(media.name || "AI request media");
  const url = escapeHtml(media.url);
  const content = media.kind === "audio"
    ? `<audio controls autoplay src="${url}"></audio>`
    : media.kind === "video"
      ? `<video controls autoplay src="${url}"></video>`
      : `<img src="${url}" alt="${name}">`;
  return `<div class="info-media-viewer" data-action="info-media-close"><section role="dialog" aria-modal="true" aria-label="${name}" onclick="event.stopPropagation()"><header><strong>${name}</strong><button type="button" data-action="info-media-close" aria-label="Close media viewer">×</button></header>${content}</section></div>`;
}

export function renderInfo(state) {
  return `<section class="info-panel"><header class="panel-title"><div><span>ⓘ</span><div><small>ACTIVITY</small><h2>Info</h2></div></div>${button("⌫", "Clear messages", "info-clear")}</header>
    <div class="info-list">${state.info.items.length ? state.info.items.map((item) => `<article class="info-item ${item.level || "info"}"><span>${item.level === "error" ? "!" : item.level === "success" ? "✓" : "i"}</span><div><div><strong>${escapeHtml(item.title || "Auri")}</strong><time>${new Date(item.at).toLocaleString()}</time></div><p>${escapeHtml(item.message)}</p>${renderInfoDetails(item.details, item.id)}</div></article>`).join("") : `<div class="empty-state"><span>✓</span><h2>All clear</h2><p>Errors, network notices, and rendering fallbacks appear here.</p></div>`}</div>
    ${renderInfoMediaViewer(state)}
  </section>`;
}

export function renderClipboard(state) {
  const pinnedOnly = Boolean(state.ui.clipboardPinnedOnly);
  const items = pinnedOnly ? state.clipboard.items.filter((item) => item.pinned) : state.clipboard.items;
  const filterLabel = pinnedOnly ? "Show all clipboard items" : "Show pinned clipboard items";
  const cards = items.map((item) => {
    const menuOpen = state.ui.clipboardMenuId === item.id;
    const content = item.kind === "image" && item.assetUrl
      ? `<button class="clipboard-content clipboard-image-content" type="button" data-action="clipboard-insert" data-id="${item.id}" aria-label="Paste clipboard image"><img class="clipboard-image" src="${escapeHtml(item.assetUrl)}" alt="Clipboard image"></button>`
      : `<button class="clipboard-content clipboard-text-content" type="button" data-action="clipboard-insert" data-id="${item.id}" aria-label="Paste clipboard text"><pre>${escapeHtml(item.kind === "text" ? previewClipboardText(item.text) : item.path)}</pre></button>`;
    return `<article class="clipboard-card ${item.pinned ? "is-pinned" : ""}" data-id="${item.id}">
      <div class="clipboard-card-head">
        <div class="clipboard-card-menu-wrap">
          <button class="clipboard-menu-button" type="button" data-action="clipboard-menu" data-id="${item.id}" aria-label="Clipboard item actions" aria-haspopup="menu" aria-expanded="${menuOpen}" title="Clipboard item actions">≡</button>
          ${menuOpen ? `<div class="clipboard-menu" role="menu">
            <button type="button" role="menuitem" data-action="clipboard-${item.pinned ? "unpin" : "pin"}" data-id="${item.id}">${item.pinned ? "Unpin" : "Pin"}</button>
            <button type="button" role="menuitem" data-action="clipboard-remove" data-id="${item.id}">Remove</button>
          </div>` : ""}
        </div>
        <div class="clipboard-card-meta">${item.pinned ? `<span aria-label="Pinned" title="Pinned">📌</span>` : ""}<time>${new Date(item.createdAt).toLocaleTimeString()}</time></div>
      </div>
      ${content}
    </article>`;
  }).join("");
  const emptyTitle = pinnedOnly ? "No pinned clipboard items" : "No clipboard history";
  const emptyCopy = pinnedOnly ? "Pin an item from its menu to keep it easy to find." : "Copied text and images appear here automatically.";
  return `<section class="clipboard-panel"><header class="panel-title"><div><span>▣</span><h2>Clipboard</h2></div><div class="clipboard-toolbar">
      <button class="icon-button ${pinnedOnly ? "is-active" : ""}" type="button" data-action="clipboard-filter-pinned" aria-label="${filterLabel}" title="${filterLabel}" aria-pressed="${pinnedOnly}">📌</button>
      ${button("↻", "Refresh clipboard", "clipboard-refresh")}
    </div></header>
    <div class="clipboard-grid">${cards || `<div class="empty-state"><span>▣</span><h2>${emptyTitle}</h2><p>${emptyCopy}</p></div>`}</div>
  </section>`;
}

const MODEL_TYPES = [
  ["gemini", "Gemini"],
  ["gemini-live", "Gemini Live"],
  ["openai", "OpenAI"],
  ["openai-live", "OpenAI Live"]
];

function renderModelTypeOptions(selectedType) {
  return MODEL_TYPES.map(([value, label]) =>
    `<option value="${value}" ${value === selectedType ? "selected" : ""}>${label}</option>`
  ).join("");
}

function modelTypeLabel(type) {
  return MODEL_TYPES.find(([value]) => value === type)?.[1] || type;
}

function renderModelEditor(model) {
  if (!model) return "";
  return `<form id="model-edit-form" class="model-editor" data-id="${model.id}">
    <div class="model-editor-heading"><div><strong>Edit ${escapeHtml(model.name)}</strong><small>Update the saved provider configuration.</small></div><button type="button" data-action="model-edit-cancel" aria-label="Close editor" title="Close editor">×</button></div>
    <div class="form-grid">
      <label>Display name<input name="name" required value="${escapeHtml(model.name)}"></label>
      <label>API type<select name="type">${renderModelTypeOptions(model.type)}</select></label>
      <label>Model name<input name="model" required value="${escapeHtml(model.model)}"></label>
      <label>API URL<input name="url" type="url" value="${escapeHtml(model.url || "")}" placeholder="Optional"></label>
      <label class="wide">API key<input name="apiKey" type="password" value="${escapeHtml(model.apiKey || "")}" placeholder="Optional"></label>
    </div>
    <div class="model-editor-actions"><button class="action-button secondary" type="button" data-action="model-edit-cancel">Cancel</button><button class="action-button primary" type="submit">Save changes</button></div>
  </form>`;
}

export function customCompletionLineNumbers(value = "") {
  const lineCount = Math.max(1, String(value ?? "").split("\n").length);
  return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
}

function customCompletionCountLabel(value = "") {
  const count = Math.max(1, String(value ?? "").split("\n").length);
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function renderPermissionRow(permission, label, status) {
  const value = String(status || "unknown");
  const allowed = value === "authorized";
  const unavailable = value === "unavailable";
  const statusLabel = allowed
    ? "Allowed"
    : value === "notDetermined" || value === "unknown"
      ? "Not requested"
      : value === "restricted"
        ? "Restricted"
        : unavailable
          ? "Unavailable"
          : "Not allowed";
  const actionLabel = value === "notDetermined" || value === "unknown" ? "Request" : "Open Settings";
  return `<div class="permission-row" data-permission="${permission}">
    <span class="permission-copy"><strong>${label}</strong><small>${statusLabel}</small></span>
    ${allowed
      ? '<span class="permission-check" aria-label="Allowed" title="Allowed">✓</span>'
      : unavailable
        ? '<span class="permission-unavailable">Unavailable</span>'
        : `<button class="action-button secondary permission-action" type="button" data-action="permission-request" data-permission="${permission}">${actionLabel}</button>`}
  </div>`;
}

function renderMediaPermissions(state) {
  const permissions = state.permissions || {};
  return `<section class="setting-section permission-section">
    <div class="section-copy"><h3>Privacy permissions</h3><p>Auri needs these macOS permissions for voice, screenshots, and system-audio capture.</p></div>
    <div class="permission-card">
      ${renderPermissionRow("microphone", "Microphone", permissions.microphone)}
      ${renderPermissionRow("screenRecording", "Screen &amp; System Audio Recording", permissions.screenRecording)}
    </div>
  </section>`;
}

export function renderSettings(state) {
  const editingModel = state.models.find((model) => model.id === state.ui.editingModelId);
  const models = state.models.length
    ? state.models.map((model) => {
      const isDefault = model.id === state.selectedModelId;
      const menuOpen = state.ui.modelMenuId === model.id;
      const rowClass = ["model-row", isDefault ? "is-default" : "", menuOpen ? "is-menu-open" : ""].filter(Boolean).join(" ");
      return `<article class="${rowClass}">
        <div class="model-row-copy">
          <div class="model-row-title">
            <strong>${escapeHtml(model.name)}</strong>
            ${isDefault ? `<span class="model-default-badge">Default</span>` : ""}
          </div>
          <small>${escapeHtml(modelTypeLabel(model.type))} · ${escapeHtml(model.model || "Model not set")}</small>
        </div>
        <div class="model-row-actions">
          <button class="model-more" type="button" data-action="model-menu" data-id="${model.id}" aria-label="Model actions for ${escapeHtml(model.name)}" aria-haspopup="menu" aria-expanded="${menuOpen}" title="Model actions">⋯</button>
          ${menuOpen ? `<div class="model-menu" role="menu" aria-label="Actions for ${escapeHtml(model.name)}">
            <button type="button" role="menuitem" data-action="model-select" data-id="${model.id}" ${isDefault ? "disabled" : ""}>Set default</button>
            <button type="button" role="menuitem" data-action="model-edit" data-id="${model.id}">Edit settings</button>
            <span class="model-menu-separator" role="separator"></span>
            <button type="button" role="menuitem" data-action="model-delete" data-id="${model.id}">Delete model</button>
          </div>` : ""}
        </div>
      </article>`;
    }).join("")
    : `<div class="model-empty"><strong>No assistant models</strong><p>Add a model to start using Auri's assistant features.</p></div>`;

  return `<section class="settings-panel"><header class="panel-title"><div><span>⚙</span><h2>Settings</h2></div></header>
    <div class="settings-scroll">
      ${renderMediaPermissions(state)}
      <section class="setting-section"><div class="section-copy"><h3>Assistant models</h3><p>Keys stay in your local Auri configuration.</p></div><div><div class="model-list">${models}</div>${renderModelEditor(editingModel)}
      <details class="add-model"><summary>＋ Add AI model</summary><form id="model-form"><div class="form-grid"><label>Display name<input name="name" required placeholder="My assistant"></label><label>API type<select name="type">${renderModelTypeOptions("gemini")}</select></label><label>Model name<input name="model" required placeholder="model-name"></label><label>API URL<input name="url" type="url" placeholder="Optional"></label><label class="wide">API key<input name="apiKey" type="password" placeholder="Optional"></label></div><button class="action-button primary" type="submit"><span>＋</span>Add model</button></form></details></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Appearance</h3><p>Adjust Auri for comfortable reading.</p></div><div class="settings-card"><label><span>Interface font size<small>Pixels · 14–30</small></span><input data-setting="fontSize" type="number" min="14" max="30" step="1" value="${state.settings.fontSize}"></label><label><span>Terminal retained lines<small>Oldest lines are discarded · 100–100,000</small></span><input data-setting="terminalMaxLines" type="number" min="100" max="100000" step="100" value="${state.settings.terminalMaxLines}"></label></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Terminal completion</h3><p>Recent shell commands are loaded from zsh and bash history.</p></div><div class="settings-card terminal-completion-card"><div class="settings-textarea-row"><label class="settings-field-heading" for="custom-completions"><span>Custom commands<small>One command per line · available in every workspace</small></span></label><div class="custom-completions-shell"><div class="custom-completions-gutter" id="custom-completions-lines" aria-hidden="true">${customCompletionLineNumbers(state.settings.customCompletions)}</div><textarea id="custom-completions" rows="8" spellcheck="false" placeholder="git status&#10;npm test">${escapeHtml(state.settings.customCompletions || "")}</textarea></div><div class="custom-completions-footer"><small id="custom-completions-count">${customCompletionCountLabel(state.settings.customCompletions)}</small><button class="action-button secondary settings-save-button" type="button" data-action="custom-completions-save">Save commands</button></div></div></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Wake & live session</h3><p>Hold the shortcut to reveal Auri and begin recording.</p></div><div class="settings-card"><label><span>Wake shortcut<small>Press the shortcut you want to use</small></span><input id="wake-shortcut-input" class="shortcut-capture" data-setting="wakeShortcut" type="text" readonly autocomplete="off" spellcheck="false" aria-label="Wake shortcut. Focus this field and press a key combination." value="${escapeHtml(state.settings.wakeShortcut)}"></label><label><span>Hold duration<small>Seconds</small></span><input data-setting="wakeHoldSeconds" type="number" min="1" max="8" value="${state.settings.wakeHoldSeconds}"></label><label><span>No-reply disconnect<small>Seconds after audio input stops or reply activity</small></span><input data-setting="liveDisconnectSeconds" type="number" min="1" max="3600" value="${state.settings.liveDisconnectSeconds}"></label></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Context & media</h3><p>Control what Auri attaches to assistant requests.</p></div><div class="settings-card"><label><span>Always attach screenshot<small>Compressed JPEG</small></span><input data-setting="alwaysAttachScreenshot" type="checkbox" ${state.settings.alwaysAttachScreenshot ? "checked" : ""}></label><label><span>Audio bitrate<small>M4A target</small></span><input data-setting="audioBitrateKbps" type="number" min="32" max="320" value="${state.settings.audioBitrateKbps}"></label></div></section>
    </div>
  </section>`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number >= 10 ? 0 : 1)}%` : "—";
}

function byteDisplayUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { value: 0, unit: "MB" };
  const megabytes = number / 1_000_000;
  return Math.abs(megabytes) >= 1000
    ? { value: megabytes / 1000, unit: "GB" }
    : { value: megabytes, unit: "MB" };
}

function formatMegabytes(value, suffix = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const display = byteDisplayUnit(number);
  return `${display.value.toFixed(2)} ${display.unit}${suffix}`;
}

function formatCompactMegabytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const display = byteDisplayUnit(number);
  const absolute = Math.abs(display.value);
  const precision = absolute < 10 ? 2 : absolute < 100 ? 1 : 0;
  return `${display.value.toFixed(precision)}${display.unit}`;
}

function formatMegabyteRate(value) {
  return formatMegabytes(value, "/s");
}

function formatNetPair(upload, download, suffix = "") {
  return `${formatMegabytes(upload || 0, suffix)} | ${formatMegabytes(download || 0, suffix)}`;
}

function formatCompactNetRate(upload, download) {
  const up = Number(upload || 0);
  const down = Number(download || 0);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return "—";
  const upDisplay = byteDisplayUnit(up);
  const downDisplay = byteDisplayUnit(down);
  const unit = upDisplay.unit === "GB" || downDisplay.unit === "GB" ? "GB" : "MB";
  const divisor = unit === "GB" ? 1_000_000_000 : 1_000_000;
  return `${(up / divisor).toFixed(2)} | ${(down / divisor).toFixed(2)} ${unit}/s`;
}

function processNetTotal(process) {
  return Number(process?.downloadBytes || 0) + Number(process?.uploadBytes || 0);
}

function selectedSystemProcess(state, processes) {
  const selectedPid = Number(state.system.selectedProcessPid);
  return Number.isFinite(selectedPid) ? processes.find((process) => Number(process.pid) === selectedPid) || null : null;
}

function formatUptime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "—";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function processSortButton(label, sort, activeSort) {
  return `<button type="button" class="system-sort ${activeSort === sort ? "is-active" : ""}" data-action="system-sort" data-sort="${sort}" aria-pressed="${activeSort === sort}">${label}${activeSort === sort ? " ↓" : ""}</button>`;
}

function renderSystemMetric(label, value, detail = "") {
  return `<article class="system-metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</article>`;
}

function processOpenTarget(process) {
  if (!process) return "";
  const workingDirectory = String(process.workingDirectory || "").trim();
  if (workingDirectory && workingDirectory !== "/") return workingDirectory;
  return String(process.path || "").trim();
}

function renderProcessDetailMetric(label, value) {
  return `<article><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></article>`;
}

function formatDetailMegabyteValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return (number / 1_000_000).toFixed(2);
}


function renderProcessDetailPorts(state, process) {
  const ports = Array.isArray(process?.ports) ? process.ports : [];
  const tunnels = state.system?.tunnels || {};
  const tunnelStatus = state.system?.tunnelStatus || {};
  const tunnelUrlMenuPort = state.ui?.tunnelUrlMenuPort ?? null;
  const shellStyle = "min-width:0;margin-top:8px;display:grid;gap:6px;";
  const headStyle = "display:block;color:#7f8ba0;font-size:9px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;";
  const emptyStyle = "padding:7px 8px;border:1px dashed #d7e0eb;border-radius:9px;color:#7f8ba0;background:#fff;font-size:11px;";
  const rowStyle = "min-width:0;display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:8px;padding:6px;border:1px solid #d7e0eb;border-radius:9px;background:#fff;position:relative;";
  const portStyle = "padding:2px 6px;border-radius:7px;color:#56647b;background:rgba(112,137,248,.08);font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;";
  const urlWrapStyle = "position:relative;min-width:0;";
  const urlStyle = "min-width:0;width:100%;overflow:hidden;border:0;background:transparent;color:#2f6fed;font:700 11px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;";
  const mutedStyle = "min-width:0;overflow:hidden;color:#9aa6b9;font-size:11px;font-weight:700;text-overflow:ellipsis;white-space:nowrap;";
  const openButtonStyle = "height:24px;width:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid #d7e0eb;border-radius:8px;color:#53617a;background:#edf2f7;font-size:11px;cursor:pointer;";
  const buttonStyle = "height:24px;padding:0 8px;border:1px solid #d7e0eb;border-radius:8px;color:#53617a;background:#edf2f7;font-size:10px;font-weight:800;cursor:pointer;";
  const menuStyle = "position:absolute;z-index:40;top:calc(100% + 4px);left:0;display:grid;gap:2px;padding:4px;border:1px solid #d7e0eb;border-radius:10px;background:#fff;box-shadow:0 10px 28px rgba(28,39,61,.18);min-width:152px;";
  const menuItemStyle = "display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#2c3a52;font:700 11px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:left;cursor:pointer;white-space:nowrap;";
  const rows = ports.length
    ? ports.map((port) => {
        const tunnel = tunnels?.[port];
        const pending = tunnelStatus?.[port];
        const url = String(tunnel?.url || "");
        const statusLabel = pending?.status === "stopping" ? "Stopping tunnel…" : "Starting tunnel…";
        const menuOpen = url && Number(tunnelUrlMenuPort) === Number(port);
        return `<div class="process-detail-port-row" style="${rowStyle}">
          <code style="${portStyle}">${escapeHtml(port)}</code>
          ${url
            ? `<div class="process-detail-port-url-wrap" style="${urlWrapStyle}">
                <button type="button" class="process-detail-port-url" style="${urlStyle}" data-action="system-process-tunnel-url-menu-toggle" data-port="${escapeHtml(port)}" data-value="${escapeHtml(url)}" title="${escapeHtml(url)}" aria-haspopup="menu" aria-expanded="${menuOpen}">${escapeHtml(url.replace(/^https?:\/\//, ""))}</button>
                ${menuOpen
                  ? `<div class="process-detail-port-url-menu" role="menu" aria-label="Tunnel URL actions" style="${menuStyle}">
                      <button type="button" role="menuitem" style="${menuItemStyle}" data-action="system-process-tunnel-url-menu-open" data-value="${escapeHtml(url)}">Open in browser</button>
                      <button type="button" role="menuitem" style="${menuItemStyle}" data-action="system-process-tunnel-url-menu-copy" data-value="${escapeHtml(url)}">Copy URL</button>
                    </div>`
                  : ""}
              </div>`
            : pending
              ? `<span class="muted" style="${mutedStyle}">${statusLabel}</span>`
              : `<span class="muted" style="${mutedStyle}">No public tunnel</span>`}
          ${url ? `<button type="button" class="process-detail-port-open" style="${openButtonStyle}" data-action="system-process-tunnel-open" data-value="${escapeHtml(url)}" title="Open in browser" aria-label="Open tunnel URL in browser">↗</button>` : `<span></span>`}
          <button type="button" class="process-detail-tunnel-button" style="${buttonStyle}" data-action="system-process-tunnel-toggle" data-port="${escapeHtml(port)}" ${pending ? "disabled" : ""}>${pending ? "Working…" : url ? "Stop tunnel" : "Enable HTTPS tunnel"}</button>
        </div>`;
      }).join("")
    : `<div class="process-detail-port-empty" style="${emptyStyle}">No listening ports detected for this process.</div>`;
  return `<div class="process-detail-ports" style="${shellStyle}"><small style="${headStyle}">Ports</small>${rows}</div>`;
}

function renderProcessDetailDialog(state, processes) {
  const selected = selectedSystemProcess(state, processes);
  if (!selected) return "";
  const pid = String(selected.pid || "");
  const appName = String(selected.name || "Process");
  const commandOrPath = String(selected.commandLine || selected.path || selected.name || "Command line unavailable");
  const openTarget = processOpenTarget(selected);
  const processActionLabel = "Kill " + "process";
  const backdropStyle = "position:absolute;inset:0;z-index:780;display:flex;align-items:center;justify-content:center;padding:14px;pointer-events:none;background:transparent;";
  const dialogStyle = "position:relative;width:min(680px,calc(100% - 28px));max-height:min(430px,calc(100% - 28px));padding:12px;border:1px solid #dce4ee;border-radius:16px;display:grid;gap:8px;overflow:hidden;background:#fff;color:#17243a;box-shadow:0 22px 60px rgba(28,39,61,.24);pointer-events:auto;";
  const headerStyle = "min-width:0;height:38px;padding:0 10px;border-radius:11px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#f2f5f9;";
  const titleStyle = "min-width:0;display:flex;align-items:center;gap:8px;";
  const nameStyle = "min-width:0;overflow:hidden;color:#17243a;font-size:14px;font-weight:850;line-height:1;text-overflow:ellipsis;white-space:nowrap;";
  const pidStyle = "flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;color:#69768a;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;";
  const pidCodeStyle = "color:#17243a;background:transparent;font:850 13px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0;text-transform:none;";
  const statRowStyle = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;";
  const statStyle = "min-width:0;min-height:66px;padding:7px;border-radius:10px;background:#f2f5f9;display:grid;grid-template-rows:auto minmax(0,1fr);gap:5px;";
  const statHeadStyle = "min-width:0;display:flex;align-items:center;justify-content:space-between;gap:6px;color:#7f8ba0;font-size:9px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;";
  const statUnitStyle = "color:#9aa6b9;font-size:9px;font-weight:850;letter-spacing:.08em;";
  const singleValueStyle = "align-self:center;display:block;min-width:0;overflow:hidden;color:#17243a;font-size:16px;font-weight:850;line-height:1.05;text-overflow:ellipsis;white-space:nowrap;";
  const rowListStyle = "display:grid;gap:3px;align-content:center;";
  const rowStyle = "min-width:0;display:flex;align-items:center;justify-content:space-between;gap:6px;color:#5d6a80;font-size:10px;font-weight:750;line-height:1.15;";
  const rowValueStyle = "min-width:0;overflow:hidden;color:#17243a;font-size:12px;font-weight:850;text-overflow:ellipsis;white-space:nowrap;";
  const pathWrapStyle = "min-width:0;padding:8px;border-radius:11px;background:#f4f7fb;";
  const pathHeadStyle = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;";
  const pathLabelStyle = "display:block;color:#7f8ba0;font-size:9px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;";
  const pathFieldStyle = "width:100%;height:74px;min-height:74px;max-height:74px;padding:7px 8px;border:1px solid #d7e0eb;border-radius:9px;display:block;resize:none;overflow:auto;color:#17243a;background:#fff;font:500 11px/14px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;";
  return `<div class="system-process-detail-backdrop" role="presentation" style="${backdropStyle}">
    <section class="system-process-detail" role="dialog" style="${dialogStyle}" aria-modal="true" aria-label="Process detail">
      <header class="process-detail-header" style="${headerStyle}">
        <div class="process-detail-title" style="${titleStyle}">
          <strong style="${nameStyle}" title="${escapeHtml(appName)}">${escapeHtml(appName)}</strong>
          <span class="process-detail-pid" style="${pidStyle}">PID <code style="${pidCodeStyle}">${escapeHtml(pid)}</code></span>
        </div>
        <button type="button" class="icon-copy-button" data-action="system-process-copy-value" data-value="${escapeHtml(pid)}" aria-label="Copy process PID" title="Copy PID">⧉</button>
      </header>
      <div class="process-detail-stat-row" style="${statRowStyle}">
        <article class="process-detail-stat" style="${statStyle}"><div class="process-detail-stat-head" style="${statHeadStyle}"><small>CPU</small></div><strong style="${singleValueStyle}">${escapeHtml(formatPercent(selected.cpuPercent))}</strong></article>
        <article class="process-detail-stat" style="${statStyle}"><div class="process-detail-stat-head" style="${statHeadStyle}"><small>RAM</small><span style="${statUnitStyle}">MB</span></div><div style="${rowListStyle}"><span style="${rowStyle}"><b>Memory</b><strong style="${rowValueStyle}">${escapeHtml(formatDetailMegabyteValue(selected.memoryBytes || 0))}</strong></span></div></article>
        <article class="process-detail-stat" style="${statStyle}"><div class="process-detail-stat-head" style="${statHeadStyle}"><small>Net</small><span style="${statUnitStyle}">MB</span></div><div style="${rowListStyle}"><span style="${rowStyle}"><b>Upload</b><strong style="${rowValueStyle}">${escapeHtml(formatDetailMegabyteValue(selected.uploadBytes || 0))}</strong></span><span style="${rowStyle}"><b>Download</b><strong style="${rowValueStyle}">${escapeHtml(formatDetailMegabyteValue(selected.downloadBytes || 0))}</strong></span></div></article>
        <article class="process-detail-stat" style="${statStyle}"><div class="process-detail-stat-head" style="${statHeadStyle}"><small>Disk</small><span style="${statUnitStyle}">MB</span></div><div style="${rowListStyle}"><span style="${rowStyle}"><b>Read</b><strong style="${rowValueStyle}">${escapeHtml(formatDetailMegabyteValue(selected.diskReadBytes || 0))}</strong></span><span style="${rowStyle}"><b>Write</b><strong style="${rowValueStyle}">${escapeHtml(formatDetailMegabyteValue(selected.diskWriteBytes || 0))}</strong></span></div></article>
      </div>
      <div class="process-detail-path" style="${pathWrapStyle}">
        <div class="process-detail-path-head" style="${pathHeadStyle}">
          <small style="${pathLabelStyle}">Path</small>
          <button type="button" class="icon-copy-button" data-action="system-process-copy-value" data-value="${escapeHtml(commandOrPath)}" aria-label="Copy process path" title="Copy path">⧉</button>
        </div>
        <textarea class="process-detail-path-field" readonly rows="5" spellcheck="false" style="${pathFieldStyle}">${escapeHtml(commandOrPath)}</textarea>
        ${renderProcessDetailPorts(state, selected)}
      </div>
      <footer>
        <button type="button" class="action-button secondary" data-action="system-process-open-path" ${openTarget ? "" : "disabled"}>Open path</button>
        <button type="button" class="action-button secondary danger" data-action="system-process-kill">${processActionLabel}</button>
      </footer>
    </section>
  </div>`;
}

function renderProcessTable(state, processes, { showDisk = false, showNet = true } = {}) {
  const sortBy = state.system.sortBy || "cpu";
  const selectedPid = Number(state.system.selectedProcessPid);
  return `<div class="process-table" role="table" aria-label="System processes">
    <div class="process-row process-heading ${showDisk ? "is-disk" : ""}" role="row">
      <span role="columnheader">${processSortButton("Name", "name", sortBy)}</span>
      <span role="columnheader">${processSortButton("Port", "port", sortBy)}</span>
      <span role="columnheader">${processSortButton("RAM", "ram", sortBy)}</span>
      <span role="columnheader">${processSortButton("CPU", "cpu", sortBy)}</span>
      ${showDisk ? `<span role="columnheader">Disk read | write</span>` : ""}
      ${showNet ? `<span role="columnheader">${processSortButton("Net up | down", "net", sortBy)}</span>` : ""}
      <span role="columnheader">PID</span>
    </div>
    ${processes.length ? processes.map((process) => `<div class="process-row ${showDisk ? "is-disk" : ""} ${Number(process.pid) === selectedPid ? "is-selected" : ""}" role="row" data-action="system-process-select" data-pid="${escapeHtml(process.pid)}">
      <span role="cell" title="${escapeHtml(process.commandLine || process.path || process.name)}">${escapeHtml(process.name)}</span>
      <span role="cell">${process.ports?.length ? process.ports.map((port) => `<code>${escapeHtml(port)}</code>`).join(" ") : `<span class="muted">No port</span>`}</span>
      <span role="cell">${formatCompactMegabytes(process.memoryBytes || 0)}</span>
      <span role="cell">${formatPercent(process.cpuPercent)}</span>
      ${showDisk ? `<span role="cell">${formatNetPair(process.diskReadBytes || 0, process.diskWriteBytes || 0)}</span>` : ""}
      ${showNet ? `<span role="cell">${formatNetPair(process.uploadBytes || 0, process.downloadBytes || 0)}</span>` : ""}
      <span role="cell"><code>${escapeHtml(process.pid)}</code></span>
    </div>`).join("") : `<div class="empty-state"><span>◬</span><h2>No process data</h2><p>Native process monitoring is available in the Tauri build.</p></div>`}
  </div>`;
}

function renderSystem(state) {
  const snapshot = state.system.snapshot || emptySystemSnapshot;
  const sortBy = state.system.sortBy || "cpu";
  const processes = sortSystemProcesses(snapshot.processes || [], sortBy).slice(0, 120);
  const updated = snapshot.capturedAt ? new Date(snapshot.capturedAt).toLocaleTimeString() : "Not loaded";
  const memoryDetail = `${formatMegabytes(snapshot.memory?.usedBytes || 0)} / ${formatMegabytes(snapshot.memory?.totalBytes || 0)}`;
  const swapTotal = Number(snapshot.memory?.swapTotalBytes || 0);
  const swapDetail = swapTotal > 0
    ? `${formatMegabytes(snapshot.memory?.swapUsedBytes || 0)} / ${formatMegabytes(swapTotal)}`
    : "Swap off";
  const swapValue = swapTotal > 0 ? formatPercent(snapshot.memory?.swapUsagePercent) : "Off";
  const cpuDetail = `${snapshot.cpu?.cores || 0} cores · ${snapshot.cpu?.brand || "Unknown CPU"}`;
  const hostName = snapshot.host?.hostname || "—";
  const statusCopy = state.system.status === "loading"
    ? "Refreshing…"
    : state.system.status === "error"
      ? state.system.error || "System monitor refresh failed."
      : `Updated ${updated} · refreshes every 5s while open`;

  return `<section class="system-panel"><header class="panel-title system-title"><div><span>◬</span><div><h2>System <em>${escapeHtml(hostName)}</em></h2></div></div>${button("↻", "Refresh system monitor", "system-refresh")}</header>
    <div class="system-status ${state.system.status === "error" ? "is-error" : ""}" role="status">${escapeHtml(statusCopy)}</div>
    <div class="system-grid">
      ${renderSystemMetric("CPU", formatPercent(snapshot.cpu?.usagePercent), cpuDetail)}
      ${renderSystemMetric("Memory", formatPercent(snapshot.memory?.usagePercent), memoryDetail)}
      ${renderSystemMetric("Network", formatCompactNetRate(snapshot.network?.uploadBytesPerSecond || 0, snapshot.network?.downloadBytesPerSecond || 0), "Upload | download")}
      ${renderSystemMetric("Disk", formatPercent(snapshot.disk?.usagePercent), `${formatMegabytes(snapshot.disk?.usedBytes || 0)} / ${formatMegabytes(snapshot.disk?.totalBytes || 0)}`)}
      ${renderSystemMetric("Swap", swapValue, swapDetail)}
      ${renderSystemMetric("Uptime", formatUptime(snapshot.host?.uptimeSeconds), `${(snapshot.network?.interfaces || []).filter((iface) => iface.status === "up" || iface.ip).length} interfaces`)}
    </div>
    <section class="process-monitor">
      ${renderProcessTable(state, processes, { showNet: true })}
    </section>
    ${renderProcessDetailDialog(state, processes)}
  </section>`;
}

function renderDisk(state) {
  const snapshot = state.system.snapshot || emptySystemSnapshot;
  const processes = sortSystemProcesses(snapshot.processes || [], "ram").slice(0, 120);
  const mounts = Array.isArray(snapshot.disk?.mounts) && snapshot.disk.mounts.length
    ? snapshot.disk.mounts
    : [{ mountPoint: "/", name: "Disk", totalBytes: snapshot.disk?.totalBytes || 0, usedBytes: snapshot.disk?.usedBytes || 0, freeBytes: snapshot.disk?.freeBytes || 0, usagePercent: snapshot.disk?.usagePercent }];
  return `<section class="system-panel system-panel-with-detail"><header class="panel-title"><div><span>▤</span><div><small>MONITOR</small><h2>Disk monitor</h2></div></div>${button("↻", "Refresh system monitor", "system-refresh")}</header>
    <div class="system-status" role="status">Disk capacity, free space, and process read | write counters use MB.</div>
    <div class="system-grid disk-grid">
      ${renderSystemMetric("Disk used", formatPercent(snapshot.disk?.usagePercent), `${formatMegabytes(snapshot.disk?.usedBytes || 0)} / ${formatMegabytes(snapshot.disk?.totalBytes || 0)}`)}
      ${renderSystemMetric("Free", formatMegabytes(snapshot.disk?.freeBytes || 0), "Available space")}
      ${renderSystemMetric("Read | write", formatNetPair(snapshot.disk?.readBytesPerSecond || 0, snapshot.disk?.writeBytesPerSecond || 0, "/s"), "Disk throughput")}
    </div>
    <section class="system-network-card system-detail-card"><h3>Common disk info</h3>
      <div class="system-interface-list">${mounts.map((mount) => `<article><strong>${escapeHtml(mount.mountPoint || mount.name || "Disk")}</strong><span>${formatPercent(mount.usagePercent)}</span><code>${formatMegabytes(mount.usedBytes || 0)} / ${formatMegabytes(mount.totalBytes || 0)}</code><small>Free ${formatMegabytes(mount.freeBytes || 0)}</small></article>`).join("")}</div>
    </section>
    <section class="process-monitor"><div class="process-monitor-head"><div><h3>Process disk read | write</h3><p>Per-process disk counters are reported when the OS exposes them.</p></div><span>${processes.length} shown</span></div>${renderProcessTable(state, processes, { showDisk: true, showNet: false })}</section>
    ${renderProcessDetailDialog(state, processes)}
  </section>`;
}

function renderNet(state) {
  const snapshot = state.system.snapshot || emptySystemSnapshot;
  const interfaces = Array.isArray(snapshot.network?.interfaces) ? snapshot.network.interfaces : [];
  const processes = sortSystemProcesses(snapshot.processes || [], "port").slice(0, 120);
  return `<section class="system-panel system-panel-with-detail"><header class="panel-title"><div><span>⇄</span><div><small>MONITOR</small><h2>Network monitor</h2></div></div>${button("↻", "Refresh system monitor", "system-refresh")}</header>
    <div class="system-status" role="status">Interfaces with IP, upload | download status, process network usage, and port status.</div>
    <div class="system-grid disk-grid">
      ${renderSystemMetric("Upload | download", formatCompactNetRate(snapshot.network?.uploadBytesPerSecond || 0, snapshot.network?.downloadBytesPerSecond || 0), "Current network speed")}
      ${renderSystemMetric("Total up | down", formatNetPair(snapshot.network?.totalTxBytes || 0, snapshot.network?.totalRxBytes || 0), "Interface counters")}
      ${renderSystemMetric("Interfaces", String(interfaces.length), `${interfaces.filter((iface) => iface.status === "up" || iface.ip).length} active`)}
    </div>
    <section class="system-network-card system-detail-card"><h3>Network devices / IP</h3>
      <div class="system-interface-list">${interfaces.length ? interfaces.map((iface) => `<article><strong>${escapeHtml(iface.name)}</strong><span>${escapeHtml(iface.status || "unknown")}</span><code>${escapeHtml(iface.ip || "No IP")}</code><small>${formatNetPair(iface.txBytes || 0, iface.rxBytes || 0)}</small></article>`).join("") : `<div class="empty-small"><span>◇</span><p>No network interfaces reported.</p></div>`}</div>
    </section>
    <section class="process-monitor"><div class="process-monitor-head"><div><h3>Process network and port status</h3><p>Processes using ports are listed first by default.</p></div><span>${processes.length} shown</span></div>${renderProcessTable(state, processes, { showNet: true })}</section>
    ${renderProcessDetailDialog(state, processes)}
  </section>`;
}

export function renderRecorder(state, kind) {
  const isVideo = kind === "video";
  const recording = state.media.status === "recording" && state.media.kind === kind;
  return `<section class="record-panel"><header class="panel-title"><div><span>${isVideo ? "▷" : "♪"}</span><div><small>CAPTURE</small><h2>${isVideo ? "Video recording" : "Audio recording"}</h2></div></div></header>
    <div class="record-layout"><div class="record-preview ${recording ? "is-recording" : ""}">${state.media.previewUrl ? (isVideo ? `<video controls src="${state.media.previewUrl}"></video>` : `<audio controls src="${state.media.previewUrl}"></audio>`) : `<div class="record-orb"><span>${isVideo ? "▷" : "♪"}</span><i></i><i></i></div>`}</div>
    <aside class="record-controls"><label>Source<select id="record-source">${isVideo ? `<option value="screen">Screen + system audio</option><option value="camera">Camera</option>` : `<option value="microphone">Microphone</option><option value="screen-audio">System audio</option>`}</select></label>${isVideo ? `<label class="toggle-row"><span>Include microphone</span><input id="record-mic" type="checkbox" checked></label>` : ""}<div class="record-note"><span>i</span><p>Native Auri saves captures under <code>~/auri/media/${isVideo ? "video" : "audio"}</code>. Browser preview uses the best codec available.</p></div>${recording ? `<button class="record-button stop" type="button" data-action="record-stop"><span>■</span>Stop</button>` : `<button class="record-button" type="button" data-action="record-start" data-kind="${kind}"><span>●</span>Record</button>`}${state.media.previewUrl ? `<button class="action-button secondary" type="button" data-action="media-attach" data-kind="${kind}"><span>＋</span>Add to prompt</button>` : ""}</aside></div>
  </section>`;
}

function renderEmptyPanel(icon, title, copy) {
  return `<div class="empty-state"><span>${icon}</span><h2>${title}</h2><p>${copy}</p></div>`;
}

export function renderActivePanel(state, options = {}) {
  const subtab = activeSubtab(state);
  if (subtab.type === "terminal") return renderTerminal(state);
  if (subtab.type === "viewer") return renderViewer(state);
  if (subtab.type === "webview") return renderWebview(state, options);
  if (subtab.type === "clipboard") return renderClipboard(state);
  if (subtab.type === "settings") return renderSettings(state);
  if (subtab.type === "system") return renderSystem(state);
  if (subtab.type === "disk") return renderDisk(state);
  if (subtab.type === "net") return renderNet(state);
  if (subtab.type === "info") return renderInfo(state);
  if (subtab.type === "audio" || subtab.type === "video") return renderRecorder(state, subtab.type);
  return renderEmptyPanel("◇", "Not available", "This panel type is not registered.");
}
