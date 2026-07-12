import test from "node:test";
import assert from "node:assert/strict";
import { fileViewerPageHtml, viewerKindForFile } from "../src/services/file-viewer-page.js";
import { mediaPageHtml } from "../src/services/backend.js";

test("audio files render as a rich waveform viewer with custom controls", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:audio-resource",
    mime: "audio/mp4",
    title: "test.m4a",
    path: "/tmp/test.m4a"
  });

  assert.match(html, /id="waveform"/);
  assert.match(html, /−5s/);
  assert.match(html, /\+5s/);
  assert.match(html, /aria-label="Volume"/);
  assert.match(html, /aria-label="Speed"/);
  assert.match(html, /pointerdown/);
  assert.match(html, /loop = \{ start, end \}/);
});

test("media conversion menu is hidden by default and uses the host conversion bridge", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:video-resource",
    mime: "video/mp4",
    title: "clip.mp4",
    path: "/tmp/clip.mp4"
  });

  assert.match(html, /id="more-button"/);
  assert.match(html, /id="convert-menu" class="convert-menu" hidden/);
  assert.match(html, /\.convert-menu\[hidden\]/);
  assert.match(html, /Convert to MP3/);
  assert.match(html, /Convert to MP4 H\.264/);
  assert.match(html, /Convert to MP4 H\.265/);
  assert.match(html, /type: 'convert-media'/);
  assert.match(html, /Converting with native ffmpeg/);
  assert.match(html, /480p/);
  assert.match(html, /720p/);
  assert.match(html, /1080p/);
  assert.match(html, /2K/);
  assert.match(html, /Native/);
});

test("conversion options follow the target format instead of the source media kind", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:audio-resource",
    mime: "audio/wav",
    title: "voice.wav",
    path: "/tmp/voice.wav"
  });

  assert.match(html, /function isAudioTargetFormat\(format\)/);
  assert.match(html, /isAudioTargetFormat\(format\) \? sampleRateField\(\) : resolutionField\(\)/);
  assert.match(html, /isAudioTargetFormat\(format\) \? audioBitrateField\(\) : videoBitrateField\(\)/);
  assert.doesNotMatch(html, /isAudioSource \? sampleRateField\(\) : resolutionField\(\)/);
  assert.match(html, /Sample rate/);
  assert.match(html, /Resolution/);
  assert.match(html, /Audio bitrate/);
  assert.match(html, /Video bitrate/);
  assert.match(html, /value="1000" selected>1 Mbps/);
  assert.match(html, /showwaves=s=' \+ waveformSizeForResolution\(resolution\) \+ '/);
  assert.match(html, /value="1080">1080p/);
  assert.match(html, /value="1440">2K/);
  assert.match(html, /value === '1080' \|\| value === '1080p'/);
  assert.match(html, /value === '1440' \|\| value === '2k'/);
});

test("target video conversion sends video bitrate defaults instead of audio bitrate labels", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:audio-resource",
    mime: "audio/wav",
    title: "voice.wav",
    path: "/tmp/voice.wav"
  });

  assert.match(html, /function videoBitrateField\(\)/);
  assert.match(html, /const bitrate = document.getElementById\('convert-bitrate'\)\.value/);
  assert.match(html, /postToAuri\(\{ type: 'convert-media', id, format, bitrateKbps: Number\(bitrate\), sampleRate, resolution \}\)/);
  assert.doesNotMatch(html, /showwaves=s=.*'-b:a',bitrate \+ 'k'/);
});

test("successful conversion shows a save-as UI before finalizing the converted file", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:audio-resource",
    mime: "audio/wav",
    title: "voice.wav",
    path: "/tmp/voice.wav"
  });

  assert.match(html, /Save converted file/);
  assert.match(html, /id="converted-name"/);
  assert.match(html, /defaultConvertedName\(pending\.format\)/);
  assert.match(html, /converted_' \+ base \+ '\.' \+ outputExtension\(format\)/);
  assert.match(html, /type: 'save-converted-media'/);
  assert.match(html, /Save failed:/);
});


test("ffmpeg.wasm remains available only as a bounded fallback", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:audio-resource",
    mime: "audio/mp4",
    title: "test.m4a",
    path: "/tmp/test.m4a"
  });

  assert.match(html, /Try ffmpeg\.wasm fallback/);
  assert.match(html, /withTimeout/);
  assert.match(html, /@ffmpeg\/ffmpeg/);
  assert.match(html, /@ffmpeg\/core/);
  assert.match(html, /waveformSizeForResolution\(resolution\)/);
});

test("text files render an editable CodeMirror-backed viewer", () => {
  const html = fileViewerPageHtml({
    mime: "text/plain",
    title: "notes.txt",
    path: "/tmp/notes.txt",
    text: "hello",
    codemirrorModuleUrl: "app://local/codemirror-viewer.js"
  });

  assert.match(html, /app:\/\/local\/codemirror-viewer\.js/);
  assert.doesNotMatch(html, /esm\.sh/);
  assert.match(html, /CodeMirror/);
  assert.match(html, /save-text/);
  assert.match(html, /parent\.postMessage/);
  assert.match(html, /hello/);
});

test("pdf and docx viewers use mature browser rendering libraries", () => {
  const pdf = fileViewerPageHtml({ resourceUrl: "blob:pdf", mime: "application/pdf", title: "manual.pdf", path: "/tmp/manual.pdf" });
  const docx = fileViewerPageHtml({ resourceUrl: "blob:docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", title: "brief.docx", path: "/tmp/brief.docx" });

  assert.match(pdf, /pdfjs-dist/);
  assert.match(docx, /mammoth/);
  assert.equal(viewerKindForFile("/tmp/manual.pdf", "application/pdf"), "pdf");
  assert.equal(viewerKindForFile("/tmp/brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "document");
});

test("3D model files use a Three.js viewer with honest Blender and CAD fallbacks", () => {
  assert.equal(viewerKindForFile("/tmp/model.glb", "model/gltf-binary"), "model3d");
  assert.equal(viewerKindForFile("/tmp/part.stl", "application/octet-stream"), "model3d");
  assert.equal(viewerKindForFile("/tmp/scene.blend", "application/octet-stream"), "model3d");
  const html = fileViewerPageHtml({ resourceUrl: "asset://model.glb", title: "model.glb", path: "/tmp/model.glb", threeModuleUrl: "app://local/three-viewer.js" });
  assert.match(html, /app:\/\/local\/three-viewer\.js/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/three|unpkg\.com\/three/);
  assert.match(html, /GLTFLoader/);
  assert.match(html, /OrbitControls/);
  const blend = fileViewerPageHtml({ resourceUrl: "asset://scene.blend", title: "scene.blend", path: "/tmp/scene.blend" });
  assert.match(blend, /Blender files need to be exported/i);
});

test("unsupported files offer an open-as-text fallback", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:unknown",
    mime: "application/octet-stream",
    title: "data.bin",
    path: "/tmp/data.bin"
  });

  assert.match(html, /Open as text/);
  assert.match(html, /type: 'open-as-text'/);
  assert.match(html, /Could not decode as text/);
});

test("autoplay is passed into media viewers", () => {
  const audio = fileViewerPageHtml({ resourceUrl: "blob:audio", mime: "audio/mpeg", title: "song.mp3", path: "/tmp/song.mp3", autoplay: true });
  const video = fileViewerPageHtml({ resourceUrl: "blob:video", mime: "video/mp4", title: "clip.mp4", path: "/tmp/clip.mp4", autoplay: true });

  assert.match(audio, /"autoplay":true/);
  assert.match(audio, /playMedia\(audio\)/);
  assert.match(video, /playMedia\(video\)/);
});

test("legacy mediaPageHtml export now returns the same rich viewer shell", () => {
  const html = mediaPageHtml({
    mediaUrl: "blob:audio-resource",
    mime: "audio/mp4",
    title: "test.m4a"
  });

  assert.match(html, /id="waveform"/);
  assert.match(html, /blob:audio-resource/);
});
