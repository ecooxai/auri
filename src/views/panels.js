import { escapeHtml } from "../model/assistant.js";
import { formatBytes, iconForEntry, workspaceLabel } from "../model/presentation.js";
import { previewClipboardText } from "../model/clipboard.js";
import { activeSubtab, activeWorkspace } from "../model/state.js";
import { sortFolderEntries } from "../model/folder.js";
import { defaultBookmarkName, normalizeWebUrl, webZoomPercent } from "../model/browser.js";

const subtabIcons = {
  terminal: "⌘",
  webview: "◎",
  viewer: "◈",
  clipboard: "▣",
  audio: "♪",
  video: "▷",
  settings: "⚙",
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
    ["settings", "⚙", "Settings"], ["info", "ⓘ", "Info"]
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
  if (subtab.type === "info") return renderInfo(state);
  if (subtab.type === "audio" || subtab.type === "video") return renderRecorder(state, subtab.type);
  return renderEmptyPanel("◇", "Not available", "This panel type is not registered.");
}
