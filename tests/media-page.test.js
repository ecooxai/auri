import test from "node:test";
import assert from "node:assert/strict";
import { mediaPageHtml } from "../src/services/backend.js";

test("audio files are hosted inside a simple HTML media page", () => {
  const html = mediaPageHtml({
    mediaUrl: "blob:audio-resource",
    mime: "audio/mp4",
    title: "test.m4a"
  });
  assert.match(html, /<audio/);
  assert.match(html, /controls/);
  assert.match(html, /type="audio\/mp4"/);
  assert.match(html, /blob:audio-resource/);
  assert.doesNotMatch(html, /autoplay/);
});

test("video files use a video element and escaped labels", () => {
  const html = mediaPageHtml({
    mediaUrl: "blob:video-resource",
    mime: "video/mp4",
    title: "<clip>"
  });
  assert.match(html, /<video/);
  assert.match(html, /&lt;clip&gt;/);
});
