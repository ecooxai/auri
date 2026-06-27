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

test("media viewer includes ffmpeg.wasm conversion menu for audio and video", () => {
  const html = fileViewerPageHtml({
    resourceUrl: "blob:video-resource",
    mime: "video/mp4",
    title: "clip.mp4",
    path: "/tmp/clip.mp4"
  });

  assert.match(html, /id="more-button"/);
  assert.match(html, /Convert to MP3/);
  assert.match(html, /Convert to MP4 H\.264/);
  assert.match(html, /Convert to MP4 H\.265/);
  assert.match(html, /@ffmpeg\/ffmpeg/);
  assert.match(html, /@ffmpeg\/core/);
  assert.match(html, /showwaves=s=1280x720/);
  assert.match(html, /480p/);
  assert.match(html, /720p/);
  assert.match(html, /Native/);
});

test("text files render an editable CodeMirror-backed viewer", () => {
  const html = fileViewerPageHtml({
    mime: "text/plain",
    title: "notes.txt",
    path: "/tmp/notes.txt",
    text: "hello"
  });

  assert.match(html, /@codemirror\/state/);
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

test("legacy mediaPageHtml export now returns the same rich viewer shell", () => {
  const html = mediaPageHtml({
    mediaUrl: "blob:audio-resource",
    mime: "audio/mp4",
    title: "test.m4a"
  });

  assert.match(html, /id="waveform"/);
  assert.match(html, /blob:audio-resource/);
});
