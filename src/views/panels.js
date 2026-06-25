import { escapeHtml } from "../model/assistant.js";
import { formatBytes, iconForEntry } from "../model/presentation.js";
import { previewClipboardText } from "../model/clipboard.js";
import { activeSubtab, activeWorkspace } from "../model/state.js";
import { sortFolderEntries } from "../model/folder.js";

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

export function renderMainTabs(state) {
  return `
    <nav class="main-tabs" aria-label="Workspaces">
      <div class="main-tab-list">
        ${state.tabs.map((tab, index) => `
          <button type="button" class="main-tab ${tab.id === state.activeTabId ? "is-active" : ""}"
            data-action="tab-select" data-id="${tab.id}" title="${escapeHtml(tab.title)}">
            <span>${index + 1}</span>
            <small>${escapeHtml(tab.title.slice(0, 7))}</small>
          </button>
        `).join("")}
      </div>
      ${button("＋", "New workspace", "tab-new")}
      <div class="rail-spacer"></div>
      ${button(state.info.unread ? `ⓘ<b>${state.info.unread}</b>` : "ⓘ", "Info", "info-open")}
      ${button("⚙", "Settings", "settings-open")}
      ${button("×", "Close workspace", "tab-close")}
    </nav>`;
}

export function renderSubtabs(state) {
  const tab = activeWorkspace(state);
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
          ${state.ui.addSubtabMenuOpen ? renderSubtabMenu() : ""}
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

export function renderTerminal(state) {
  const tab = activeWorkspace(state);
  const model = state.models.find((item) => item.id === state.selectedModelId);
  return `
    <section class="terminal-panel">
      <div class="terminal-toolbar">
        <div class="cwd-pill"><span>⌂</span><strong>${escapeHtml(tab.terminal.cwd)}</strong></div>
        <div class="terminal-status"><span class="status-dot ${tab.terminal.running ? "is-busy" : ""}"></span>${tab.terminal.running ? "Working" : "Ready"}</div>
        ${button("⌫", "Clear terminal", "terminal-clear")}
      </div>
      <div class="terminal-history" id="terminal-history"><div id="terminal-emulator" class="terminal-emulator" data-workspace-id="${escapeHtml(tab.id)}"></div></div>
      <div class="terminal-input-zone">
      <div class="composer-wrap">
        ${state.media.attachments.length ? `<div class="attachment-row">${state.media.attachments.map((item) => `<span class="attachment-chip">${item.kind === "image" ? "◈" : item.kind === "audio" ? "♪" : "▷"} ${escapeHtml(item.name)}<button type="button" data-action="attachment-remove" data-id="${item.id}">×</button></span>`).join("")}</div>` : ""}
        <textarea id="terminal-input" rows="3" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" placeholder="Type a command or ask Auri…  Enter adds a line · ⌘/Ctrl + Enter runs"></textarea>
        <div class="composer-actions">
          <div class="model-strip">
            ${state.models.filter((item) => item.enabled).map((item) => `<button type="button" class="model-chip ${item.id === state.selectedModelId ? "is-active" : ""} ${item.id === state.selectedModelId && state.ui.liveConnected ? "is-live-connected" : ""}" data-action="model-select" data-id="${item.id}"><span>${item.type.includes("gemini") ? "✦" : "◌"}</span>${escapeHtml(item.name)}</button>`).join("")}
          </div>
          <div class="composer-buttons">
            <label class="icon-button attach-button" title="Attach files" aria-label="Attach files">＋<input id="file-attachment" type="file" multiple hidden></label>
            <button type="button" class="action-button secondary" data-action="terminal-run"><span>▶</span>Run</button>
            <button type="button" class="action-button primary" data-action="terminal-ask"><span>✦</span>Ask ${escapeHtml(model?.name || "AI")}</button>
          </div>
        </div>
      </div>
      </div>
    </section>`;
}

function metadataRows(meta) {
  if (!meta) return "";
  const values = [
    ["Type", meta.fileType || meta.kind], ["Size", formatBytes(meta.size)],
    ["Resolution", meta.width && meta.height ? `${meta.width} × ${meta.height}` : null],
    ["Codec", meta.codec], ["Bitrate", meta.bitrate ? `${Math.round(meta.bitrate / 1000)} kbps` : null],
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

export function renderWebview(state) {
  const subtab = activeSubtab(state);
  const url = subtab.url || "https://www.google.com/";
  const displayUrl = subtab.filePath || url;
  const content = subtab.filePath
    ? `<object class="file-web-object" data="${escapeHtml(url)}" type="${escapeHtml(subtab.fileMime || "application/octet-stream")}"><p>This file cannot be previewed here.</p></object>`
    : `<div id="native-webview-host" class="native-webview-host" data-webview-id="${escapeHtml(subtab.id)}" data-url="${escapeHtml(url)}"><div class="native-webview-fallback"><span>◎</span><p>Website content opens in the native Auri webview.</p><small>Browser preview cannot bypass site embedding restrictions.</small></div></div>`;
  return `<section class="web-panel">
    <div class="url-bar">${button("←", "Back", "web-back")}${button("→", "Forward", "web-forward")}${button("↻", "Reload", "web-reload")}<input id="web-url" value="${escapeHtml(displayUrl)}" aria-label="URL"><button type="button" class="go-button" data-action="web-go">Go</button>${button("↗", "Open externally", "web-external")}</div>
    <div class="web-frame-wrap">${content}</div>
  </section>`;
}

function renderInfoDetails(details) {
  if (!details) return "";
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

export function renderInfo(state) {
  return `<section class="info-panel"><header class="panel-title"><div><span>ⓘ</span><div><small>ACTIVITY</small><h2>Info</h2></div></div>${button("⌫", "Clear messages", "info-clear")}</header>
    <div class="info-list">${state.info.items.length ? state.info.items.map((item) => `<article class="info-item ${item.level || "info"}"><span>${item.level === "error" ? "!" : item.level === "success" ? "✓" : "i"}</span><div><div><strong>${escapeHtml(item.title || "Auri")}</strong><time>${new Date(item.at).toLocaleString()}</time></div><p>${escapeHtml(item.message)}</p>${renderInfoDetails(item.details)}</div></article>`).join("") : `<div class="empty-state"><span>✓</span><h2>All clear</h2><p>Errors, network notices, and rendering fallbacks appear here.</p></div>`}</div>
  </section>`;
}

export function renderClipboard(state) {
  return `<section class="clipboard-panel"><header class="panel-title"><div><span>▣</span><div><small>HISTORY</small><h2>Clipboard</h2></div></div>${button("↻", "Refresh clipboard", "clipboard-refresh")}</header>
    <div class="clipboard-grid">${state.clipboard.items.length ? state.clipboard.items.map((item) => `<article class="clipboard-card" data-action="clipboard-insert" data-id="${item.id}" tabindex="0"><div class="clipboard-card-head"><span>${item.kind === "image" ? "◈" : "≡"}</span><time>${new Date(item.createdAt).toLocaleTimeString()}</time></div>${item.kind === "image" && item.assetUrl ? `<img class="clipboard-image" src="${escapeHtml(item.assetUrl)}" alt="Clipboard image">` : `<pre>${escapeHtml(item.kind === "text" ? previewClipboardText(item.text) : item.path)}</pre>`}<div>${button("↙", "Paste into previous application", "clipboard-insert", `data-id="${item.id}"`)}</div></article>`).join("") : `<div class="empty-state"><span>▣</span><h2>No clipboard history</h2><p>Copied text and images appear here automatically.</p></div>`}</div>
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
      <section class="setting-section"><div class="section-copy"><h3>Assistant models</h3><p>Keys stay in your local Auri configuration.</p></div><div><div class="model-list">${models}</div>${renderModelEditor(editingModel)}
      <details class="add-model"><summary>＋ Add AI model</summary><form id="model-form"><div class="form-grid"><label>Display name<input name="name" required placeholder="My assistant"></label><label>API type<select name="type">${renderModelTypeOptions("gemini")}</select></label><label>Model name<input name="model" required placeholder="model-name"></label><label>API URL<input name="url" type="url" placeholder="Optional"></label><label class="wide">API key<input name="apiKey" type="password" placeholder="Optional"></label></div><button class="action-button primary" type="submit"><span>＋</span>Add model</button></form></details></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Appearance</h3><p>Adjust Auri for comfortable reading.</p></div><div class="settings-card"><label><span>Interface font size<small>Pixels · 14–30</small></span><input data-setting="fontSize" type="number" min="14" max="30" step="1" value="${state.settings.fontSize}"></label><label><span>Terminal retained lines<small>Oldest lines are discarded · 100–100,000</small></span><input data-setting="terminalMaxLines" type="number" min="100" max="100000" step="100" value="${state.settings.terminalMaxLines}"></label></div></section>
      <section class="setting-section"><div class="section-copy"><h3>Wake & live session</h3><p>Hold the shortcut to reveal Auri and begin recording.</p></div><div class="settings-card"><label><span>Wake shortcut<small>Long press to open</small></span><input data-setting="wakeShortcut" value="${escapeHtml(state.settings.wakeShortcut)}"></label><label><span>Hold duration<small>Seconds</small></span><input data-setting="wakeHoldSeconds" type="number" min="1" max="8" value="${state.settings.wakeHoldSeconds}"></label><label><span>Disconnect live API<small>Seconds</small></span><input data-setting="liveDisconnectSeconds" type="number" min="10" max="600" value="${state.settings.liveDisconnectSeconds}"></label></div></section>
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

export function renderActivePanel(state) {
  const subtab = activeSubtab(state);
  if (subtab.type === "terminal") return renderTerminal(state);
  if (subtab.type === "viewer") return renderViewer(state);
  if (subtab.type === "webview") return renderWebview(state);
  if (subtab.type === "clipboard") return renderClipboard(state);
  if (subtab.type === "settings") return renderSettings(state);
  if (subtab.type === "info") return renderInfo(state);
  if (subtab.type === "audio" || subtab.type === "video") return renderRecorder(state, subtab.type);
  return renderEmptyPanel("◇", "Not available", "This panel type is not registered.");
}
