import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_LIVE_DEFAULT_MODEL,
  GEMINI_LIVE_DEFAULT_URL,
  GeminiWakeSession,
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


test("wake session disconnects when no reply arrives for the configured seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [];
  let closed = false;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    inactivitySeconds: 10,
    onStatus: (status) => statuses.push(status)
  });
  session.stopMicrophone = async () => {};
  session.player.close = async () => {};
  session.session = {
    sendRealtimeInput() {},
    close() { closed = true; }
  };

  await session.stop();
  t.mock.timers.tick(5000);
  session.armResponseTimeout();
  t.mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(closed, false);

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(closed, true);
  assert.deepEqual(statuses.slice(-2), ["disconnecting", "disconnected-timeout"]);
});

test("persistent Live input activity starts the configured no-reply disconnect deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [];
  let closed = false;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    inactivitySeconds: 5,
    onStatus: (status) => statuses.push(status)
  });
  session.stopMicrophone = async () => {};
  session.player.close = async () => {};
  session.session = {
    sendRealtimeInput() {},
    close() { closed = true; }
  };

  assert.equal(session.noteInputActivity(new Float32Array([0, 0, 0, 0])), false);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(closed, false);

  assert.equal(session.noteInputActivity(new Float32Array([0.02, -0.02, 0.015, -0.015])), true);
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(closed, false);

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(closed, true);
  assert.deepEqual(statuses.slice(-2), ["disconnecting", "disconnected-timeout"]);
});


test("wake session primes reply audio playback before asynchronous microphone setup", async () => {
  const order = [];
  const session = new GeminiWakeSession({ model: { apiKey: "test" } });
  session.player = {
    ensureContext: async () => { order.push("player"); },
    close: async () => {}
  };
  session.startMicrophone = async () => { order.push("microphone"); };
  session.connect = async () => { order.push("connect"); };

  await session.start();

  assert.deepEqual(order, ["player", "microphone", "connect"]);
});

test("wake session honors configured disconnect values below the old ten-second floor", () => {
  const session = new GeminiWakeSession({ model: { apiKey: "test" }, inactivitySeconds: 3 });
  assert.equal(session.responseTimeoutMs, 3000);
});

test("wake session restart applies the latest configured no-reply timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [];
  let closed = false;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    inactivitySeconds: 60,
    onStatus: (status) => statuses.push(status)
  });
  session.session = {
    sendRealtimeInput() {},
    close() { closed = true; }
  };
  session.stopped = true;
  session.player.ensureContext = async () => {};
  session.player.close = async () => {};
  session.startMicrophone = async () => { session.stream = {}; };
  session.stopMicrophone = async () => { session.stream = null; };

  await session.restart({ inactivitySeconds: 5 });
  await session.stop();
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(closed, false);

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(closed, true);
  assert.equal(session.responseTimeoutMs, 5000);
  assert.deepEqual(statuses.slice(-2), ["disconnecting", "disconnected-timeout"]);
});


test("changing the no-reply setting updates an already pending deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = false;
  const session = new GeminiWakeSession({ model: { apiKey: "test" }, inactivitySeconds: 60 });
  session.session = { sendRealtimeInput() {}, close() { closed = true; } };
  session.stopMicrophone = async () => {};
  session.player.close = async () => {};

  await session.stop();
  session.responseActivityAt = Date.now() - 4000;
  session.setInactivitySeconds(5);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(closed, false);

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, true);
});


test("wake session reuses its connection and sends a fresh screenshot for a new turn", async () => {
  const statuses = [];
  const inputs = [];
  let microphoneStarts = 0;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    onStatus: (status) => statuses.push(status)
  });
  const connectedSession = {
    sendRealtimeInput: (input) => inputs.push(input),
    close() {}
  };
  session.session = connectedSession;
  session.stopped = true;
  session.player.ensureContext = async () => {};
  session.startMicrophone = async () => { microphoneStarts += 1; session.stream = {}; };

  await session.restart({
    screenshot: { name: "fresh.jpg", path: "/tmp/fresh.jpg", base64: "ZnJlc2g=", mime: "image/jpeg" }
  });

  assert.equal(session.session, connectedSession);
  assert.equal(session.stopped, false);
  assert.equal(microphoneStarts, 1);
  assert.deepEqual(inputs, [{ video: { data: "ZnJlc2g=", mimeType: "image/jpeg" } }]);
  assert.equal(statuses.at(-1), "recording");
});

test("wake session reports the screenshot and playable microphone audio actually sent", async () => {
  const requests = [];
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    onRequest: (request) => requests.push(request)
  });
  session.session = { sendRealtimeInput() {}, close() {} };
  session.stopMicrophone = async () => {};
  session.turnScreenshot = { name: "screen.jpg", path: "/tmp/screen.jpg", base64: "aW1hZ2U=", mime: "image/jpeg" };
  session.inputAudioChunks = ["AQI="];

  await session.stop();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, "");
  assert.equal(requests[0].media[0].kind, "image");
  assert.equal(requests[0].media[0].path, "/tmp/screen.jpg");
  assert.equal(requests[0].media[1].kind, "audio");
  assert.equal(requests[0].media[1].mime, "audio/wav");
  assert.ok(requests[0].media[1].blob instanceof Blob);
  await session.cancel();
});


test("wake session resumes suspended audio after the app regains focus", async () => {
  const calls = [];
  const session = new GeminiWakeSession({ model: { apiKey: "test" } });
  session.player.ensureContext = async () => { calls.push("reply"); };
  session.audioContext = {
    state: "suspended",
    resume: async () => { calls.push("microphone"); }
  };

  const resumed = await session.resume();

  assert.equal(resumed, true);
  assert.deepEqual(calls, ["reply", "microphone"]);
});


test("wake session resumes an existing suspended reply audio context after app switching", async () => {
  const calls = [];
  const session = new GeminiWakeSession({ model: { apiKey: "test" } });
  session.player.context = {
    state: "suspended",
    resume: async () => { calls.push("reply"); }
  };
  session.audioContext = {
    state: "suspended",
    resume: async () => { calls.push("microphone"); }
  };

  const resumed = await session.resume();

  assert.equal(resumed, true);
  assert.deepEqual(calls, ["reply", "microphone"]);
});


test("non-reply Live packets do not postpone the configured no-reply disconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [];
  let callbacks;
  let closed = false;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    inactivitySeconds: 10,
    onStatus: (status) => statuses.push(status),
    createClient: () => ({
      live: {
        connect: async (options) => {
          callbacks = options.callbacks;
          return {
            sendRealtimeInput() {},
            close() { closed = true; }
          };
        }
      }
    })
  });
  session.stopped = true;
  session.stopMicrophone = async () => {};
  session.player.close = async () => {};

  await session.connect();
  session.armResponseTimeout();
  t.mock.timers.tick(5000);
  callbacks.onmessage({ setupComplete: {} });
  t.mock.timers.tick(5000);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(closed, true);
  assert.deepEqual(statuses.slice(-2), ["disconnecting", "disconnected-timeout"]);
});


test("reply audio playback failures do not disconnect the Live API session", async () => {
  const warnings = [];
  let callbacks;
  let closed = false;
  const session = new GeminiWakeSession({
    model: { apiKey: "test" },
    onWarning: (error) => warnings.push(error.message),
    createClient: () => ({
      live: {
        connect: async (options) => {
          callbacks = options.callbacks;
          return {
            sendRealtimeInput() {},
            close() { closed = true; }
          };
        }
      }
    })
  });
  session.player.enqueue = async () => { throw new Error("Audio context suspended"); };

  await session.connect();
  callbacks.onmessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: "AQI=", mimeType: "audio/pcm;rate=24000" } }] }
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(session.completed, false);
  assert.equal(closed, false);
  assert.deepEqual(warnings, ["Audio context suspended"]);
  await session.cancel();
});
