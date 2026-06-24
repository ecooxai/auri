import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_LIVE_DEFAULT_MODEL,
  GEMINI_LIVE_DEFAULT_URL,
  createLiveAccumulator,
  defaultApiUrlForType,
  geminiLiveClientOptions,
  normalizeGeminiLiveModel,
  pcm16ChunksToWav,
  runGeminiLiveTurn
} from "../src/services/gemini-live.js";

test("Gemini Live defaults use the current Live model and WebSocket endpoint", () => {
  assert.equal(GEMINI_LIVE_DEFAULT_MODEL, "gemini-3.1-flash-live-preview");
  assert.match(GEMINI_LIVE_DEFAULT_URL, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//);
  assert.equal(defaultApiUrlForType("gemini-live"), GEMINI_LIVE_DEFAULT_URL);
  assert.equal(defaultApiUrlForType("gemini"), "https://generativelanguage.googleapis.com/v1beta");
});

test("Gemini Live client leaves endpoint selection to the SDK", () => {
  assert.deepEqual(geminiLiveClientOptions({ apiKey: "test", url: GEMINI_LIVE_DEFAULT_URL }), { apiKey: "test" });
});

test("legacy native-audio model names migrate to the current Live model", () => {
  assert.equal(normalizeGeminiLiveModel("gemini-2.5-flash-native-audio"), GEMINI_LIVE_DEFAULT_MODEL);
  assert.equal(normalizeGeminiLiveModel("gemini-live-2.5-flash-preview"), "gemini-live-2.5-flash-preview");
});

test("Live messages collect transcription and PCM audio", () => {
  const accumulator = createLiveAccumulator();
  accumulator.accept({
    serverContent: {
      outputTranscription: { text: "Hello" },
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AQI=" } }] }
    }
  });
  const result = accumulator.finish();
  assert.equal(result.text, "Hello");
  assert.deepEqual(result.audioChunks, ["AQI="]);
});

test("PCM chunks become a playable 24 kHz mono WAV", () => {
  const wav = pcm16ChunksToWav(["AQI=", "AwQ="], 24000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true), 24000);
  assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4]);
});

test("Gemini Live uses client content for text and current realtime media fields", async () => {
  let connectedModel = "";
  let clientContent;
  const realtimeInputs = [];
  let closed = false;
  let callbacks;
  const client = {
    live: {
      connect: async (params) => {
        connectedModel = params.model;
        callbacks = params.callbacks;
        return {
          sendRealtimeInput: (input) => { realtimeInputs.push(input); },
          sendClientContent: (input) => {
            clientContent = input;
            queueMicrotask(() => callbacks.onmessage({
              serverContent: {
                outputTranscription: { text: "Live response" },
                turnComplete: true
              }
            }));
          },
          close: () => { closed = true; }
        };
      }
    }
  };

  const result = await runGeminiLiveTurn({
    prompt: "hello",
    model: { model: "gemini-2.5-flash-native-audio", apiKey: "test", url: GEMINI_LIVE_DEFAULT_URL },
    systemPrompt: "Be useful.",
    media: [
      { base64: "aW1hZ2U=", mime: "image/jpeg" },
      { base64: "YXVkaW8=", mime: "audio/pcm;rate=16000" }
    ],
    timeoutMs: 1000,
    createClient: () => client
  });

  assert.equal(connectedModel, GEMINI_LIVE_DEFAULT_MODEL);
  assert.deepEqual(realtimeInputs, [
    { video: { data: "aW1hZ2U=", mimeType: "image/jpeg" } },
    { audio: { data: "YXVkaW8=", mimeType: "audio/pcm;rate=16000" } }
  ]);
  assert.equal("media" in realtimeInputs[0], false);
  assert.deepEqual(clientContent, {
    turns: [{ role: "user", parts: [{ text: "hello" }] }],
    turnComplete: true
  });
  assert.equal(result.text, "Live response");
  assert.equal(closed, true);
});
