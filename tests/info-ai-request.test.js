import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceState } from "../src/model/state.js";
import { renderInfo } from "../src/views/panels.js";

test("Info renders AI request text with clickable image and playable audio previews", () => {
  let state = createInitialState();
  state = reduceState(state, {
    type: "INFO_ADD",
    payload: {
      level: "info",
      title: "AI request · Gemini Live",
      message: "Describe these files",
      details: {
        type: "ai-request",
        text: "Describe these files",
        media: [
          { id: "image-1", name: "screen.jpg", kind: "image", mime: "image/jpeg", url: "asset://screen.jpg" },
          { id: "audio-1", name: "voice.wav", kind: "audio", mime: "audio/wav", url: "blob:voice" }
        ]
      }
    }
  });

  const html = renderInfo(state);
  assert.match(html, /class="ai-request-text"[^>]*>Describe these files</);
  assert.match(html, /data-action="info-media-open"/);
  assert.match(html, /<img[^>]*src="asset:\/\/screen\.jpg"/);
  assert.match(html, /<audio[^>]*controls[^>]*src="blob:voice"/);
  assert.match(html, /screen\.jpg/);
  assert.match(html, /voice\.wav/);
});

test("Info image click opens and closes an in-app media viewer", () => {
  let state = createInitialState();
  state.ui.infoMediaPreview = { name: "screen.jpg", kind: "image", mime: "image/jpeg", url: "asset://screen.jpg" };
  const html = renderInfo(state);
  assert.match(html, /class="info-media-viewer"/);
  assert.match(html, /data-action="info-media-close"/);
  assert.match(html, /<img[^>]*src="asset:\/\/screen\.jpg"/);
});
