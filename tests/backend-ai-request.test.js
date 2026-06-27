import test from "node:test";
import assert from "node:assert/strict";
import { Backend } from "../src/services/backend.js";

test("Backend reports the exact prepared AI request without exposing binary data or credentials", async () => {
  const backend = new Backend();
  backend.captureScreenshot = async () => ({
    name: "screen.jpg",
    path: "/tmp/screen.jpg",
    mime: "image/jpeg",
    base64: "aW1hZ2U="
  });
  backend.prepareAttachments = async () => [{
    id: "voice-1",
    name: "voice.wav",
    kind: "audio",
    mime: "audio/wav",
    base64: "YXVkaW8=",
    url: "blob:voice"
  }];
  backend.askGemini = async () => ({ text: "done" });
  const requests = [];

  const result = await backend.askAi({
    prompt: "Describe this",
    model: { name: "Test Gemini", type: "gemini", model: "gemini-test", apiKey: "secret" },
    attachScreenshot: true,
    attachments: [{ id: "voice-1" }],
    onRequest: (request) => requests.push(request)
  });

  assert.equal(result.text, "done");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, "Describe this");
  assert.equal(requests[0].modelName, "Test Gemini");
  assert.deepEqual(requests[0].media.map((item) => item.kind), ["image", "audio"]);
  assert.equal(requests[0].media[0].path, "/tmp/screen.jpg");
  assert.match(requests[0].media[0].url, /^blob:/);
  assert.equal(requests[0].media[1].url, "blob:voice");
  assert.equal("base64" in requests[0].media[0], false);
  assert.equal("apiKey" in requests[0], false);
  URL.revokeObjectURL(requests[0].media[0].url);
});
