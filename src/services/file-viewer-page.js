function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function extension(path) {
  const name = String(path || "").split(/[\\/]/).pop() || "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

export function isEditableTextFile(path, mime = "") {
  const ext = extension(path);
  return String(mime).startsWith("text/") || [
    "txt", "md", "markdown", "json", "jsonl", "js", "jsx", "ts", "tsx", "mjs", "cjs",
    "html", "htm", "css", "scss", "sass", "less", "xml", "svg", "csv", "tsv", "yaml", "yml",
    "toml", "ini", "env", "log", "rs", "py", "rb", "go", "java", "c", "h", "cpp", "hpp",
    "cs", "php", "sh", "bash", "zsh", "fish", "sql", "lock", "gitignore"
  ].includes(ext);
}

export function viewerKindForFile(path, mime = "") {
  const ext = extension(path);
  const type = String(mime || "").toLowerCase();
  if (isEditableTextFile(path, type)) return "text";
  if (type.startsWith("model/") || ["glb", "gltf", "stl", "obj", "ply", "3mf", "blend", "step", "stp", "iges", "igs"].includes(ext)) return "model3d";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (["docx", "doc", "rtf", "odt"].includes(ext)) return "document";
  return "file";
}

export function fileViewerPageHtml({ resourceUrl = "", mime = "application/octet-stream", title = "File", path = "", text = null, autoplay = false, codemirrorModuleUrl = "", threeModuleUrl = "" }) {
  const kind = viewerKindForFile(path || title, mime);
  const safeTitle = escapeHtml(title);
  const data = safeJson({ resourceUrl, mime, title, path, text, kind, extension: extension(path || title), autoplay, codemirrorModuleUrl, threeModuleUrl });
  const mediaMenu = kind === "audio" || kind === "video"
    ? `<button id="more-button" class="icon-button" type="button" aria-haspopup="menu" aria-expanded="false" title="More">⋮</button>
       <div id="convert-menu" class="convert-menu" hidden>
        <button data-format="mp3">Convert to MP3</button>
        <button data-format="wav">Convert to WAV</button>
        <button data-format="m4a">Convert to M4A</button>
        <button data-format="mp4_h264">Convert to MP4 H.264</button>
        <button data-format="mp4_h265">Convert to MP4 H.265</button>
       </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{color-scheme:light;--bg:#f6f8fb;--panel:rgba(255,255,255,.88);--panel-strong:#fff;--line:rgba(25,34,51,.1);--text:#182033;--muted:#687284;--soft:#eef2f7;--accent:#2f6fed;--shadow:0 18px 60px rgba(24,32,51,.12)}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:radial-gradient(circle at top left,#fff 0,#f6f8fb 46%,#eef3f8 100%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;overflow:hidden}.app{height:100%;display:grid;grid-template-rows:auto 1fr}.topbar{height:52px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.75);backdrop-filter:blur(18px);position:relative;z-index:5}.file-dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#95b8ff,#dfe8ff);box-shadow:0 0 0 4px #eef4ff}.title{min-width:0;flex:1}.title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.title small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.pill{font-size:11px;color:#41516c;background:var(--soft);border:1px solid var(--line);padding:5px 8px;border-radius:999px}.icon-button,.clean-button{border:1px solid var(--line);background:var(--panel-strong);color:var(--text);border-radius:10px;min-height:32px;padding:0 11px;font:inherit;box-shadow:0 1px 0 rgba(255,255,255,.9);cursor:pointer}.icon-button{width:32px;padding:0;font-size:18px;line-height:1}.icon-button:hover,.clean-button:hover,.convert-menu button:hover{background:#f9fbff}.stage{min-height:0;overflow:auto;display:grid;place-items:center;padding:24px}.card{width:min(980px,calc(100vw - 48px));background:var(--panel);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);overflow:hidden}.message-card{padding:34px;text-align:center;display:grid;gap:12px}.message-card span{font-size:38px}.message-card p{margin:0;color:var(--muted)}.message-card .clean-button{justify-self:center}.image-viewer{display:block;width:auto;height:auto;max-width:100vw;max-height:calc(100vh - 92px);object-fit:contain;border-radius:16px;box-shadow:var(--shadow)}.video-viewer{display:block;width:auto;height:auto;max-width:100vw;max-height:calc(100vh - 132px);background:#0f172a;border-radius:16px;box-shadow:var(--shadow)}.pdf-shell,.doc-shell{width:min(1100px,calc(100vw - 48px));height:calc(100vh - 100px);display:grid;grid-template-rows:auto 1fr;background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.viewer-toolbar{display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 10px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.7)}.viewer-toolbar small{color:var(--muted);margin-left:auto}.pdf-pages,.doc-content{overflow:auto;padding:18px}.pdf-pages canvas{display:block;max-width:100%;height:auto;margin:0 auto 18px;background:white;border-radius:12px;box-shadow:0 10px 28px rgba(24,32,51,.1)}.doc-content{background:white}.doc-content article{max-width:760px;margin:0 auto;color:#172033}.editor-shell{width:min(1200px,calc(100vw - 36px));height:calc(100vh - 88px);display:grid;grid-template-rows:auto 1fr;background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.editor-status{margin-left:auto;color:var(--muted);font-size:12px}.editor-host,.cm-editor,.cm-scroller{min-height:0;height:100%}.cm-editor{font-size:13px;background:#fbfcff}.fallback-editor{width:100%;height:100%;border:0;resize:none;padding:18px;background:#fbfcff;color:var(--text);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}.audio-card{width:min(860px,calc(100vw - 48px));display:grid;gap:18px;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}.audio-hero{display:flex;align-items:center;gap:14px}.audio-badge{width:48px;height:48px;border-radius:16px;display:grid;place-items:center;background:#edf3ff;color:var(--accent);font-size:24px}.muted{color:var(--muted);margin:.1rem 0 0}.wave-wrap{position:relative;padding:10px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,#fbfdff,#f1f5fb)}#waveform{display:block;width:100%;height:148px;touch-action:none;cursor:crosshair}.loop-pill{position:absolute;right:18px;bottom:16px;padding:5px 9px;border-radius:999px;background:rgba(47,111,237,.1);color:#2457bc;font-size:12px}.media-controls{display:grid;grid-template-columns:auto auto auto 1fr auto auto;gap:10px;align-items:center}.media-controls input[type=range]{width:100%}.time-readout{color:var(--muted);font-variant-numeric:tabular-nums;min-width:112px;text-align:right}.speed-select{border:1px solid var(--line);background:white;border-radius:10px;height:32px;padding:0 8px}.convert-menu{position:absolute;right:12px;top:46px;display:grid;gap:4px;width:210px;padding:8px;background:white;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.convert-menu[hidden],.convert-panel[hidden]{display:none!important}.convert-menu button{border:0;background:white;text-align:left;padding:9px 10px;border-radius:10px;color:var(--text);font:inherit;cursor:pointer}.convert-panel{position:fixed;right:18px;top:66px;width:min(360px,calc(100vw - 36px));display:grid;gap:12px;padding:14px;background:white;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);z-index:10}.convert-panel h2{font-size:14px;margin:0}.convert-status{display:grid;gap:8px;color:var(--muted);font-size:12px}.convert-panel label{display:grid;gap:5px;color:var(--muted);font-size:12px}.convert-panel input,.convert-panel select{height:34px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:#fbfcff;color:var(--text)}.convert-actions{display:flex;gap:8px;justify-content:flex-end}.progress{height:8px;border-radius:999px;background:#edf1f6;overflow:hidden}.progress i{display:block;height:100%;width:0;background:var(--accent)}.result-link{color:var(--accent);text-decoration:none;font-weight:600}.result-path{display:block;color:var(--text);overflow-wrap:anywhere;margin-top:4px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:760px){.stage{padding:12px}.media-controls{grid-template-columns:1fr 1fr 1fr}.time-readout{text-align:left}.pill{display:none}}
.model-shell{width:calc(100vw - 36px);height:calc(100vh - 88px);display:grid;grid-template-rows:auto 1fr;background:linear-gradient(160deg,#fafdff,#e9eef8);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.model-stage{position:relative;min-height:0}.model-stage canvas{display:block;width:100%;height:100%}.model-help{position:absolute;left:14px;bottom:12px;padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.78);color:var(--muted);font-size:11px;backdrop-filter:blur(10px)}
</style>
</head>
<body>
<div class="app">
  <header class="topbar"><i class="file-dot"></i><div class="title"><strong>${safeTitle}</strong><small>${escapeHtml(path)}</small></div><span class="pill">${escapeHtml(kind)}</span>${mediaMenu}</header>
  <main id="stage" class="stage" aria-live="polite"></main>
</div>
<script>window.__AURI_FILE__=${data};</script>
<script type="module">
const file = window.__AURI_FILE__;
const stage = document.getElementById('stage');
const pendingConversions = new Map();
const formatTime = (value) => {
  if (!Number.isFinite(value)) return '0:00';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return minutes + ':' + seconds;
};
function escapeText(value){return String(value ?? '').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));}
function setStage(html){stage.innerHTML = html;}
function sourceTag(){return '<source src="' + file.resourceUrl + '" type="' + file.mime + '">';}
function postToAuri(message){ parent.postMessage({ source: 'auri-file-viewer', path: file.path, ...message }, '*'); }
function showUnsupported(message){
  setStage('<section class="card message-card"><span>◇</span><strong>' + escapeText(file.title) + '</strong><p id="unsupported-message">' + escapeText(message) + '</p><button id="open-as-text" class="clean-button" type="button">Open as text</button></section>');
  document.getElementById('open-as-text')?.addEventListener('click', () => {
    document.getElementById('unsupported-message').textContent = 'Trying to decode this file as text…';
    postToAuri({ type: 'open-as-text' });
  });
}
async function renderText(){
  setStage('<section class="editor-shell"><div class="viewer-toolbar"><button id="save-text" class="clean-button" type="button">Save</button><small class="editor-status" id="editor-status">Editable text · CodeMirror</small></div><div id="editor" class="editor-host"></div></section>');
  const host = document.getElementById('editor');
  let getContent = () => file.text || '';
  try {
    if (!file.codemirrorModuleUrl) throw new Error('Missing local CodeMirror module.');
    const editorModule = await import(file.codemirrorModuleUrl);
    const editor = editorModule.createTextEditor(host, file.text || '');
    getContent = () => editor.getContent();
  } catch (error) {
    host.innerHTML = '<textarea class="fallback-editor" spellcheck="false"></textarea>';
    host.firstElementChild.value = file.text || '';
    getContent = () => host.firstElementChild.value;
    document.getElementById('editor-status').textContent = 'Editable text · fallback editor';
  }
  document.getElementById('save-text').addEventListener('click', () => {
    const status = document.getElementById('editor-status');
    status.textContent = 'Saving…';
    postToAuri({ type: 'save-text', content: getContent() });
  });
}
window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.source !== 'auri-host') return;
  if (data.type === 'save-result') {
    const status = document.getElementById('editor-status');
    if (status) status.textContent = data.ok ? 'Saved' : ('Save failed: ' + (data.error || 'Unknown error'));
  }
  if (data.type === 'open-as-text-result' && !data.ok) {
    const message = document.getElementById('unsupported-message');
    if (message) message.textContent = 'Could not decode as text: ' + (data.error || 'Unknown error');
  }
  if (data.type === 'convert-started') {
    const pending = pendingConversions.get(data.id);
    if (pending) pending.status.textContent = 'Converting with native ffmpeg…';
  }
  if (data.type === 'convert-result') {
    const pending = pendingConversions.get(data.id);
    if (!pending) return;
    if (data.ok) {
      pending.bar.style.width = '100%';
      showConvertedSaveUi(pending, data.result || {});
    } else {
      pending.button.disabled = false;
      pendingConversions.delete(data.id);
      pending.bar.style.width = '0';
      pending.status.innerHTML = 'Native conversion failed: ' + escapeText(data.error || 'Unknown error') + '<br><button id="wasm-fallback" class="clean-button" type="button">Try ffmpeg.wasm fallback</button>';
      document.getElementById('wasm-fallback')?.addEventListener('click', () => runWasmConversion(pending));
    }
  }
  if (data.type === 'save-converted-result') {
    const pending = pendingConversions.get(data.id);
    if (!pending) return;
    if (data.ok) {
      pendingConversions.delete(data.id);
      const result = data.result || {};
      pending.status.innerHTML = 'Saved.<span class="result-path">' + escapeText(result.path || result.name || 'Done') + '</span>';
      pending.bar.style.width = '100%';
    } else {
      pending.status.textContent = 'Save failed: ' + (data.error || 'Unknown error');
    }
  }
});
async function renderPdf(){
  setStage('<section class="pdf-shell"><div class="viewer-toolbar"><strong>PDF</strong><small id="pdf-status">Loading PDF.js…</small></div><div id="pdf-pages" class="pdf-pages"></div></section>');
  const status = document.getElementById('pdf-status');
  const pages = document.getElementById('pdf-pages');
  try {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/+esm');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument(file.resourceUrl).promise;
    status.textContent = pdf.numPages + ' page' + (pdf.numPages === 1 ? '' : 's');
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: Math.min(1.5, Math.max(1, (stage.clientWidth - 72) / page.getViewport({ scale: 1 }).width)) });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      pages.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  } catch (error) {
    status.textContent = 'Using browser PDF fallback';
    pages.innerHTML = '<object data="' + file.resourceUrl + '" type="application/pdf" style="width:100%;height:100%;min-height:70vh"><p>PDF preview is unavailable.</p></object>';
  }
}
async function renderDocument(){
  setStage('<section class="doc-shell"><div class="viewer-toolbar"><strong>Document</strong><small id="doc-status">Loading…</small></div><div class="doc-content"><article id="doc-body"></article></div></section>');
  const status = document.getElementById('doc-status');
  const body = document.getElementById('doc-body');
  if (file.extension !== 'docx') {
    status.textContent = 'Preview not available';
    body.innerHTML = '<p>This document format can be opened externally. DOCX preview is supported in the in-app viewer.</p>';
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.1/mammoth.browser.min.js';
      script.onload = resolve; script.onerror = reject; document.head.appendChild(script);
    });
    const buffer = await fetch(file.resourceUrl).then((response) => response.arrayBuffer());
    const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
    body.innerHTML = result.value || '<p>No document content was extracted.</p>';
    status.textContent = 'DOCX preview';
  } catch (error) {
    status.textContent = 'Preview failed';
    body.innerHTML = '<p>Could not render this document in the web viewer.</p>';
  }
}
function drawBars(canvas, peaks = [], progress = 0, selection = null) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 760;
  const height = canvas.clientHeight || 148;
  canvas.width = Math.floor(width * ratio); canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0,0,width,height);
  const bars = peaks.length ? peaks : Array.from({length:96},(_,index)=>.18 + .34 * Math.abs(Math.sin(index*.45)));
  const gap = 3; const barWidth = Math.max(2, (width - gap * (bars.length - 1)) / bars.length);
  if (selection) { ctx.fillStyle = 'rgba(47,111,237,.12)'; ctx.fillRect(selection.start * width, 0, Math.max(1, (selection.end - selection.start) * width), height); }
  bars.forEach((peak,index)=>{ const x = index * (barWidth + gap); const h = Math.max(5, peak * (height - 18)); const y = (height - h) / 2; ctx.fillStyle = x / width <= progress ? 'rgba(47,111,237,.72)' : 'rgba(160,176,204,.42)'; ctx.fillRect(x, y, barWidth, h); });
}
async function audioPeaks(url, count = 128) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return [];
    const buffer = await fetch(url).then((response) => response.arrayBuffer());
    const context = new AudioContextClass();
    const decoded = await context.decodeAudioData(buffer.slice(0));
    await context.close?.();
    const data = decoded.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / count));
    return Array.from({ length: count }, (_, index) => {
      let sum = 0;
      for (let offset = 0; offset < block; offset += 1) sum += Math.abs(data[index * block + offset] || 0);
      return Math.min(1, Math.max(.04, sum / block * 4));
    });
  } catch { return []; }
}
function attachMediaMenu(mediaElement) {
  const more = document.getElementById('more-button');
  const menu = document.getElementById('convert-menu');
  if (!more || !menu) return;
  more.addEventListener('click', () => { const open = menu.hidden; menu.hidden = !open; more.setAttribute('aria-expanded', String(open)); });
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-format]'); if (!button) return;
    menu.hidden = true; more.setAttribute('aria-expanded', 'false'); showConvertPanel(button.dataset.format, mediaElement);
  });
}
function showMediaError(error){
  const message = document.getElementById('media-error');
  if (!message) return;
  message.textContent = 'Playback is not supported by this WebView codec stack. Use More to convert the file, or open it externally.';
}
function playMedia(mediaElement){
  try {
    mediaElement.play()?.catch((error) => showMediaError(error));
  } catch (error) {
    showMediaError(error);
  }
}
function renderAudio(){
  setStage('<section class="audio-card"><div class="audio-hero"><span class="audio-badge">♪</span><div><strong>' + escapeText(file.title) + '</strong><p class="muted">Drag across the waveform to loop a range.</p><p id="media-error" class="muted" role="status"></p></div></div><audio id="audio" preload="metadata" src="' + file.resourceUrl + '"></audio><div class="wave-wrap"><canvas id="waveform" aria-label="Audio waveform"></canvas><span id="loop-pill" class="loop-pill" hidden></span></div><div class="media-controls"><button id="play" class="clean-button" type="button">Play</button><button id="back5" class="clean-button" type="button">−5s</button><button id="forward5" class="clean-button" type="button">+5s</button><input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume"><select id="speed" class="speed-select" aria-label="Speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><span id="time" class="time-readout">0:00 / 0:00</span></div></section>');
  const audio = document.getElementById('audio'); const canvas = document.getElementById('waveform'); const play = document.getElementById('play'); const time = document.getElementById('time'); const loopPill = document.getElementById('loop-pill');
  let peaks = []; let loop = null; let dragStart = null; let pointerDown = false; let selection = null;
  const positionForEvent = (event) => Math.min(1, Math.max(0, (event.clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width));
  const secondsForEvent = (event) => positionForEvent(event) * (audio.duration || 0);
  const refresh = () => { const duration = audio.duration || 0; const progress = duration ? audio.currentTime / duration : 0; drawBars(canvas, peaks, progress, selection); time.textContent = formatTime(audio.currentTime || 0) + ' / ' + formatTime(duration); play.textContent = audio.paused ? 'Play' : 'Pause'; };
  audioPeaks(file.resourceUrl).then((value)=>{ peaks = value; refresh(); });
  audio.addEventListener('loadedmetadata', () => { refresh(); if (file.autoplay) playMedia(audio); }, { once: true });
  audio.addEventListener('timeupdate', () => { if (loop && audio.currentTime >= loop.end) audio.currentTime = loop.start; refresh(); }); audio.addEventListener('play', refresh); audio.addEventListener('pause', refresh);
  window.addEventListener('resize', refresh);
  play.addEventListener('click', () => audio.paused ? playMedia(audio) : audio.pause());
  document.getElementById('back5').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); refresh(); });
  document.getElementById('forward5').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); refresh(); });
  document.getElementById('volume').addEventListener('input', (event) => { audio.volume = Number(event.target.value); });
  document.getElementById('speed').addEventListener('change', (event) => { audio.playbackRate = Number(event.target.value) || 1; });
  canvas.addEventListener('pointerdown', (event) => { pointerDown = true; dragStart = secondsForEvent(event); loop = null; loopPill.hidden = true; canvas.setPointerCapture?.(event.pointerId); audio.currentTime = dragStart; playMedia(audio); refresh(); });
  canvas.addEventListener('pointermove', (event) => { if (!pointerDown) return; const now = secondsForEvent(event); const start = Math.min(dragStart, now); const end = Math.max(dragStart, now); selection = audio.duration ? { start: start / audio.duration, end: end / audio.duration } : null; refresh(); });
  canvas.addEventListener('pointerup', (event) => { if (!pointerDown) return; pointerDown = false; const endTime = secondsForEvent(event); const start = Math.min(dragStart, endTime); const end = Math.max(dragStart, endTime); selection = null; if (end - start > .25) { loop = { start, end }; audio.currentTime = start; loopPill.textContent = 'Loop ' + formatTime(start) + '–' + formatTime(end); loopPill.hidden = false; playMedia(audio); } else { audio.currentTime = endTime; playMedia(audio); } refresh(); });
  attachMediaMenu(audio);
}
function renderVideo(){
  setStage('<video id="video" class="video-viewer" controls preload="metadata">' + sourceTag() + 'This video format is not supported.</video>');
  const video = document.getElementById('video');
  if (file.autoplay) video.addEventListener('loadedmetadata', () => playMedia(video), { once: true });
  attachMediaMenu(video);
}
function renderImage(){ setStage('<img class="image-viewer" src="' + file.resourceUrl + '" alt="' + escapeText(file.title) + '">'); }
async function renderModel3d(){
  if (file.extension === 'blend') {
    showUnsupported('Blender files need to be exported as GLB or glTF before a browser can render them. Auri can preview the exported model here.');
    return;
  }
  if (['step','stp','iges','igs'].includes(file.extension)) {
    showUnsupported('This CAD exchange format needs native geometry conversion. Export it as GLB, STL, OBJ, PLY, or 3MF for an interactive preview.');
    return;
  }
  setStage('<section class="model-shell"><div class="viewer-toolbar"><strong>3D preview</strong><button id="model-reset" class="clean-button" type="button">Frame model</button><button id="model-wireframe" class="clean-button" type="button" aria-pressed="false">Wireframe</button><small id="model-status">Loading Three.js…</small></div><div id="model-stage" class="model-stage"><span class="model-help">Drag to orbit · scroll to zoom · right-drag to pan</span></div></section>');
  const host = document.getElementById('model-stage');
  const status = document.getElementById('model-status');
  try {
    if (!file.threeModuleUrl) throw new Error('The bundled 3D renderer is unavailable.');
    const { THREE, OrbitControls, GLTFLoader, STLLoader, OBJLoader, PLYLoader, ThreeMFLoader } = await import(file.threeModuleUrl);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5fb);
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.prepend(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x71809c, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(4, 7, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9bb7ff, 1.5); fill.position.set(-5, 2, -3); scene.add(fill);
    const Loader = file.extension === 'glb' || file.extension === 'gltf' ? GLTFLoader
      : file.extension === 'stl' ? STLLoader
        : file.extension === 'obj' ? OBJLoader
          : file.extension === 'ply' ? PLYLoader
            : ThreeMFLoader;
    const loaded = await new Loader().loadAsync(file.resourceUrl);
    let model = loaded.scene || loaded;
    if (loaded.isBufferGeometry) {
      loaded.computeVertexNormals?.();
      model = new THREE.Mesh(loaded, new THREE.MeshStandardMaterial({ color: 0x91aef4, roughness: .55, metalness: .12 }));
    }
    scene.add(model);
    const frameModel = () => {
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = Math.max(.01, box.getSize(new THREE.Vector3()).length());
      controls.target.copy(center);
      camera.near = Math.max(.001, size / 1000); camera.far = Math.max(1000, size * 100); camera.updateProjectionMatrix();
      camera.position.copy(center).add(new THREE.Vector3(size * .7, size * .45, size * .7)); controls.update();
    };
    const resize = () => { const width = host.clientWidth || 800; const height = host.clientHeight || 600; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    frameModel(); resize(); status.textContent = file.extension.toUpperCase() + ' · interactive';
    new ResizeObserver(resize).observe(host);
    document.getElementById('model-reset').addEventListener('click', frameModel);
    document.getElementById('model-wireframe').addEventListener('click', (event) => {
      const enabled = event.currentTarget.getAttribute('aria-pressed') !== 'true';
      event.currentTarget.setAttribute('aria-pressed', String(enabled));
      model.traverse((child) => { if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => { material.wireframe = enabled; material.needsUpdate = true; }); });
    });
    const animate = () => { controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); }; animate();
  } catch (error) {
    status.textContent = 'Preview failed';
    host.innerHTML = '<section class="card message-card"><span>◇</span><strong>Could not render this 3D model</strong><p>' + escapeText(error?.message || error) + '</p></section>';
  }
}
function outputExtension(format){ return format === 'mp4_h264' || format === 'mp4_h265' ? 'mp4' : format; }
function originalBaseName(){ return (file.title || 'media').replace(/\.[^.]+$/, '') || 'media'; }
function defaultConvertedName(format){ const base = originalBaseName(); return 'converted_' + base + '.' + outputExtension(format); }
function outputName(format){ return defaultConvertedName(format); }
function isAudioTargetFormat(format){ return format === 'mp3' || format === 'wav' || format === 'm4a'; }
function audioRateArgs(value){ return value && value !== 'original' ? ['-ar', value] : []; }
function resolutionArgs(value){ if (value === 'native') return []; const height = Number(value) || 720; return ['-vf', 'scale=-2:' + height]; }
function waveformSizeForResolution(value){ if (value === '480' || value === '480p') return '854x480'; if (value === '1080' || value === '1080p') return '1920x1080'; if (value === '1440' || value === '2k' || value === '2K') return '2560x1440'; return '1280x720'; }
function conversionArgs(format, bitrate, resolution, sampleRate, isAudioOnly){
  const output = outputName(format);
  if (format === 'mp3') return { output, args: ['-i','input','-vn','-b:a', bitrate + 'k',...audioRateArgs(sampleRate),output] };
  if (format === 'wav') return { output, args: ['-i','input','-vn',...audioRateArgs(sampleRate),output] };
  if (format === 'm4a') return { output, args: ['-i','input','-vn','-c:a','aac','-b:a', bitrate + 'k',...audioRateArgs(sampleRate),output] };
  const videoCodec = format === 'mp4_h265' ? 'libx265' : 'libx264';
  if (isAudioOnly) return { output, args: ['-i','input','-filter_complex','[0:a]showwaves=s=' + waveformSizeForResolution(resolution) + ':mode=cline:colors=white,format=yuv420p[v]','-map','[v]','-map','0:a:0','-c:v',videoCodec,'-b:v',bitrate + 'k','-c:a','aac','-b:a','128k','-shortest',output] };
  return { output, args: ['-i','input',...resolutionArgs(resolution),'-c:v',videoCodec,'-b:v',bitrate + 'k','-c:a','aac','-b:a','128k',output] };
}
function sampleRateField(){
  return '<label>Sample rate<select id="convert-sample-rate"><option value="original" selected>Original</option><option value="16000">16k</option><option value="24000">24k (CD)</option><option value="48000">48k</option></select></label>';
}
function resolutionField(){
  return '<label>Resolution<select id="convert-resolution"><option value="native" selected>Native</option><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option><option value="1440">2K</option></select></label>';
}
function audioBitrateField(){
  return '<label>Audio bitrate<select id="convert-bitrate"><option value="96">96 kbps</option><option value="128" selected>128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option></select></label>';
}
function videoBitrateField(){
  return '<label>Video bitrate<select id="convert-bitrate"><option value="500">500 kbps</option><option value="1000" selected>1 Mbps</option><option value="2500">2.5 Mbps</option><option value="5000">5 Mbps</option><option value="8000">8 Mbps</option></select></label>';
}
function showConvertedSaveUi(pending, result){
  const tempPath = result.path || result.tempPath || '';
  const defaultName = result.name || defaultConvertedName(pending.format);
  pending.result = result;
  pending.status.innerHTML = '<label>Save converted file<input id="converted-name" value="' + escapeText(defaultName) + '" aria-label="Converted file name"></label><span class="result-path">Ready to save: ' + escapeText(defaultName) + '</span><div class="convert-actions"><button id="converted-save" class="clean-button" type="button">OK</button></div>';
  const input = document.getElementById('converted-name');
  const button = document.getElementById('converted-save');
  input?.focus(); input?.select?.();
  button?.addEventListener('click', () => {
    const name = (input?.value || defaultName).trim() || defaultName;
    button.disabled = true;
    pending.button.disabled = true;
    pending.status.querySelector('.result-path').textContent = 'Saving…';
    postToAuri({ type: 'save-converted-media', id: pending.id, tempPath, name });
  });
}
function showConvertPanel(format, mediaElement){
  document.getElementById('convert-panel')?.remove();
  const panel = document.createElement('section'); panel.id = 'convert-panel'; panel.className = 'convert-panel';
  panel.innerHTML = '<h2>Convert to ' + escapeText(format.replace("_", " ").toUpperCase()) + '</h2>' + (isAudioTargetFormat(format) ? audioBitrateField() : videoBitrateField()) + (isAudioTargetFormat(format) ? sampleRateField() : resolutionField()) + '<div class="progress"><i id="convert-progress"></i></div><div id="convert-status" class="convert-status">Ready</div><div class="convert-actions"><button id="convert-cancel" class="clean-button" type="button">Cancel</button><button id="convert-start" class="clean-button" type="button">Convert</button></div>';
  document.body.appendChild(panel);
  document.getElementById('convert-cancel').addEventListener('click', () => panel.remove());
  document.getElementById('convert-start').addEventListener('click', () => {
    const status = document.getElementById('convert-status'); const bar = document.getElementById('convert-progress'); const button = document.getElementById('convert-start');
    const bitrate = document.getElementById('convert-bitrate').value;
    const sampleRate = document.getElementById('convert-sample-rate')?.value || 'original';
    const resolution = document.getElementById('convert-resolution')?.value || 'native';
    const id = 'convert-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    button.disabled = true; bar.style.width = '12%'; status.textContent = 'Sending conversion to Auri…';
    pendingConversions.set(id, { id, status, bar, button, format, bitrate, sampleRate, resolution });
    postToAuri({ type: 'convert-media', id, format, bitrateKbps: Number(bitrate), sampleRate, resolution });
  });
}
function withTimeout(promise, label, ms = 20000){
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))]);
}
async function runWasmConversion(pending){
  try {
    pending.status.textContent = 'Loading ffmpeg.wasm fallback…';
    pending.bar.style.width = '8%';
    const [{ FFmpeg }, { fetchFile, toBlobURL }] = await withTimeout(Promise.all([
      import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js'),
      import('https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js')
    ]), 'ffmpeg.wasm module load');
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => { pending.bar.style.width = Math.max(8, Math.min(100, progress * 100)) + '%'; });
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
    await withTimeout(ffmpeg.load({ coreURL: await toBlobURL(baseURL + '/ffmpeg-core.js', 'text/javascript'), wasmURL: await toBlobURL(baseURL + '/ffmpeg-core.wasm', 'application/wasm') }), 'ffmpeg.wasm core load');
    pending.status.textContent = 'Converting in the viewer…';
    await ffmpeg.writeFile('input', await fetchFile(file.resourceUrl));
    const { output, args } = conversionArgs(pending.format, pending.bitrate, pending.resolution, pending.sampleRate, file.kind === 'audio');
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile(output);
    const blob = new Blob([data.buffer], { type: output.endsWith('.mp4') ? 'video/mp4' : output.endsWith('.wav') ? 'audio/wav' : output.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    pending.status.innerHTML = '<label>Save converted file<input id="converted-name" value="' + escapeText(output) + '" aria-label="Converted file name"></label><div class="convert-actions"><button id="converted-save" class="clean-button" type="button">OK</button></div>';
    document.getElementById('converted-save')?.addEventListener('click', () => {
      const name = (document.getElementById('converted-name')?.value || output).trim() || output;
      pending.status.innerHTML = '<a class="result-link" download="' + escapeText(name) + '" href="' + url + '">Download ' + escapeText(name) + '</a>';
    });
    pending.bar.style.width = '100%';
  } catch (error) {
    pending.status.textContent = 'ffmpeg.wasm fallback failed: ' + (error?.message || error || 'unknown error');
    pending.bar.style.width = '0';
  }
}
if (file.kind === 'text') renderText();
else if (file.kind === 'pdf') renderPdf();
else if (file.kind === 'document') renderDocument();
else if (file.kind === 'image') renderImage();
else if (file.kind === 'audio') renderAudio();
else if (file.kind === 'video') renderVideo();
else if (file.kind === 'model3d') renderModel3d();
else showUnsupported('Preview is not available for this file type yet. You can try opening it as UTF-8 text.');
</script>
</body>
</html>`;
}
