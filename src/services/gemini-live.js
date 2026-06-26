import { GoogleGenAI, Modality } from "@google/genai";

export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
export const GEMINI_LIVE_DEFAULT_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_LIVE_DEFAULT_URL = "wss://api.openai.com/v1/realtime";

export function defaultApiUrlForType(type) {
  if (type === "gemini-live") return GEMINI_LIVE_DEFAULT_URL;
  if (type === "gemini") return GEMINI_DEFAULT_URL;
  if (type === "openai-live") return OPENAI_LIVE_DEFAULT_URL;
  if (type === "openai") return OPENAI_DEFAULT_URL;
  return "";
}

export function defaultModelForType(type) {
  if (type === "gemini-live") return GEMINI_LIVE_DEFAULT_MODEL;
  if (type === "gemini") return "gemini-2.5-flash";
  return "";
}

export function normalizeGeminiLiveModel(model) {
  const value = String(model || "").replace(/^models\//, "").trim();
  if (!value || value === "gemini-2.5-flash-native-audio") return GEMINI_LIVE_DEFAULT_MODEL;
  if (value === "gemini-live-2.5-flash-preview-04-09") return "gemini-live-2.5-flash-preview";
  return value;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(chunks) {
  const decoded = chunks.map(decodeBase64);
  const output = new Uint8Array(decoded.reduce((total, item) => total + item.length, 0));
  let offset = 0;
  for (const item of decoded) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

export function pcm16ChunksToWav(chunks, sampleRate = 24000) {
  const pcm = concatBytes(chunks);
  const output = new Uint8Array(44 + pcm.length);
  const view = new DataView(output.buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index);
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, pcm.length, true);
  output.set(pcm, 44);
  return output;
}

function appendIncremental(parts, value) {
  if (!value) return;
  const text = String(value);
  const previous = parts.at(-1) || "";
  if (text === previous) return;
  if (previous && text.startsWith(previous)) parts[parts.length - 1] = text;
  else parts.push(text);
}

export function createLiveAccumulator() {
  const transcriptions = [];
  const textParts = [];
  const audioChunks = [];
  let audioMime = "audio/pcm;rate=24000";
  return {
    accept(message) {
      const content = message?.serverContent;
      appendIncremental(transcriptions, content?.outputTranscription?.text);
      appendIncremental(textParts, message?.text);
      for (const part of content?.modelTurn?.parts || []) {
        appendIncremental(textParts, part.text);
        if (part.inlineData?.data) {
          audioChunks.push(part.inlineData.data);
          audioMime = part.inlineData.mimeType || audioMime;
        }
      }
    },
    finish() {
      return {
        text: transcriptions.join("").trim() || textParts.join("").trim(),
        audioChunks: [...audioChunks],
        audioMime
      };
    }
  };
}

export function geminiLiveClientOptions(model) {
  // Let @google/genai choose its Live API WebSocket endpoint. A Live WSS URL is
  // not an HTTP baseUrl; passing it through httpOptions can route the SDK to a
  // normal generateContent endpoint instead of BidiGenerateContent.
  return { apiKey: model.apiKey };
}

function describeEvent(value, fallback) {
  if (value?.error?.message) return value.error.message;
  if (value?.message) return value.message;
  if (value?.reason) return value.reason;
  return fallback;
}

function liveConfig(systemPrompt) {
  return {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {})
  };
}

function resultFromAccumulator(accumulator, modelName) {
  const result = accumulator.finish();
  let audioBlob = null;
  if (result.audioChunks.length) {
    const wavBytes = pcm16ChunksToWav(result.audioChunks, 24000);
    audioBlob = new Blob([wavBytes], { type: "audio/wav" });
  }
  return {
    text: result.text || (audioBlob ? "Gemini returned an audio response." : "Gemini Live returned no content."),
    audioBlob,
    audioMime: audioBlob ? "audio/wav" : null,
    model: modelName
  };
}

export async function runGeminiLiveTurn({
  prompt,
  model,
  systemPrompt,
  media = [],
  timeoutMs = 60000,
  createClient = (options) => new GoogleGenAI(options)
}) {
  if (!model?.apiKey) throw new Error("Add a Gemini API key in Settings.");

  const modelName = normalizeGeminiLiveModel(model.model);
  const client = createClient(geminiLiveClientOptions(model));
  const accumulator = createLiveAccumulator();
  let session = null;
  let settled = false;
  let resolveTurn;
  let rejectTurn;

  const turn = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    if (error) rejectTurn(error instanceof Error ? error : new Error(String(error)));
    else resolveTurn(resultFromAccumulator(accumulator, modelName));
  };

  const timer = setTimeout(() => {
    finish(new Error(`Gemini Live did not complete within ${Math.round(timeoutMs / 1000)} seconds.`));
  }, timeoutMs);

  try {
    session = await client.live.connect({
      model: modelName,
      config: liveConfig(systemPrompt),
      callbacks: {
        onopen: () => {},
        onmessage: (message) => {
          accumulator.accept(message);
          if (message?.serverContent?.turnComplete) finish();
        },
        onerror: (event) => finish(new Error(describeEvent(event, "Gemini Live connection failed."))),
        onclose: (event) => {
          if (!settled) finish(new Error(describeEvent(event, "Gemini Live connection closed before completing the response.")));
        }
      }
    });

    const contentParts = [];
    for (const item of media) {
      if (!item?.base64 || !item?.mime) continue;
      const blob = { data: item.base64, mimeType: item.mime };
      if (item.mime.startsWith("audio/")) {
        session.sendRealtimeInput({ audio: blob });
      } else if (item.mime.startsWith("image/") || item.mime.startsWith("video/")) {
        // The Live API accepts image frames through the `video` field. The old
        // generic `media` field is translated by the SDK to deprecated
        // realtime_input.media_chunks.
        session.sendRealtimeInput({ video: blob });
      } else {
        contentParts.push({ inlineData: blob });
      }
    }

    contentParts.unshift({ text: String(prompt || "") });
    session.sendClientContent({
      turns: [{ role: "user", parts: contentParts }],
      turnComplete: true
    });

    return await turn;
  } catch (error) {
    finish(error);
    return await turn;
  } finally {
    clearTimeout(timer);
    try { session?.close(); } catch {}
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function floatToPcm16(input, inputRate, outputRate = 16000) {
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, count ? sum / count : input[start] || 0));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
}

class PcmStreamPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.context = null;
    this.nextStartTime = 0;
  }

  async ensureContext() {
    if (this.context) return this.context;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio playback is unavailable.");
    this.context = new AudioContextClass({ sampleRate: this.sampleRate });
    if (this.context.state === "suspended") await this.context.resume();
    this.nextStartTime = this.context.currentTime;
    return this.context;
  }

  async enqueue(base64) {
    if (!base64) return;
    const context = await this.ensureContext();
    const bytes = decodeBase64(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
    const buffer = context.createBuffer(1, sampleCount, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = pcm[index] / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  async close() {
    try { await this.context?.close(); } catch {}
    this.context = null;
    this.nextStartTime = 0;
  }
}

export class GeminiWakeSession {
  constructor({ model, systemPrompt, screenshot = null, inactivitySeconds = 60, onStatus, onText, onResult, onError, createClient = (options) => new GoogleGenAI(options) }) {
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.screenshot = screenshot;
    this.onStatus = onStatus;
    this.onText = onText;
    this.onResult = onResult;
    this.onError = onError;
    this.createClient = createClient;
    this.audioQueue = [];
    this.session = null;
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.silenceNode = null;
    this.accumulator = createLiveAccumulator();
    this.player = new PcmStreamPlayer(24000);
    this.responseTimeoutMs = Math.max(10, Number(inactivitySeconds) || 60) * 1000;
    this.responseTimer = null;
    this.stopped = false;
    this.completed = false;
  }

  armResponseTimeout() {
    clearTimeout(this.responseTimer);
    if (this.completed || !this.stopped) return;
    this.responseTimer = setTimeout(() => {
      this.onStatus?.("disconnecting");
      this.cancel("timeout").catch(() => {});
    }, this.responseTimeoutMs);
  }

  async start() {
    if (!this.model?.apiKey) throw new Error("Add a Gemini API key in Settings.");
    this.onStatus?.("recording");
    await this.player.ensureContext();
    await this.startMicrophone();
    this.connect().catch((error) => this.fail(error));
    return this;
  }

  async startMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is unavailable.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is unavailable.");
    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silenceNode = this.audioContext.createGain();
    this.silenceNode.gain.value = 0;
    this.processorNode.onaudioprocess = (event) => {
      if (this.stopped) return;
      const floatSamples = event.inputBuffer.getChannelData(0);
      let energy = 0;
      for (let index = 0; index < floatSamples.length; index += 1) energy += floatSamples[index] * floatSamples[index];
      const pcmBytes = floatToPcm16(floatSamples, this.audioContext.sampleRate, 16000);
      const chunk = { data: bytesToBase64(pcmBytes), mimeType: "audio/pcm;rate=16000" };
      if (this.session) this.session.sendRealtimeInput({ audio: chunk });
      else this.audioQueue.push(chunk);
    };
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silenceNode);
    this.silenceNode.connect(this.audioContext.destination);
  }

  async connect() {
    this.onStatus?.("connecting");
    const client = this.createClient(geminiLiveClientOptions(this.model));
    const modelName = normalizeGeminiLiveModel(this.model.model);
    this.session = await client.live.connect({
      model: modelName,
      config: liveConfig(this.systemPrompt),
      callbacks: {
        onopen: () => {
          this.onStatus?.(this.stopped ? "processing" : "connected");
        },
        onmessage: (message) => {
          this.armResponseTimeout();
          this.accumulator.accept(message);
          const partial = this.accumulator.finish();
          if (partial.text) this.onText?.(partial.text);
          for (const part of message?.serverContent?.modelTurn?.parts || []) {
            if (part.inlineData?.data) this.player.enqueue(part.inlineData.data).catch((error) => this.fail(error));
          }
          if (message?.serverContent?.turnComplete) this.finishTurn(modelName);
        },
        onerror: (event) => this.fail(new Error(describeEvent(event, "Gemini Live connection failed."))),
        onclose: (event) => {
          if (!this.completed && !this.stopped) this.fail(new Error(describeEvent(event, "Gemini Live connection closed.")));
        }
      }
    });

    if (this.screenshot?.base64) {
      this.session.sendRealtimeInput({
        video: {
          data: this.screenshot.base64,
          mimeType: this.screenshot.mime || "image/jpeg"
        }
      });
    }

    for (const chunk of this.audioQueue.splice(0)) this.session.sendRealtimeInput({ audio: chunk });
    if (this.stopped) this.endAudioInput();
  }

  endAudioInput() {
    try { this.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    await this.stopMicrophone();
    this.endAudioInput();
    this.onStatus?.("processing");
    this.armResponseTimeout();
  }

  async cancel(reason = "cancelled") {
    if (this.completed) return;
    this.stopped = true;
    this.completed = true;
    clearTimeout(this.responseTimer);
    await this.stopMicrophone();
    await this.player.close();
    try { this.session?.close(); } catch {}
    this.onStatus?.(reason === "timeout" ? "disconnected-timeout" : reason === "idle" ? "disconnected-idle" : "disconnected");
  }

  async stopMicrophone() {
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.silenceNode?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    try { await this.audioContext?.close(); } catch {}
    this.processorNode = null;
    this.sourceNode = null;
    this.silenceNode = null;
    this.stream = null;
    this.audioContext = null;
  }

  finishTurn(modelName) {
    if (this.completed) return;
    const result = resultFromAccumulator(this.accumulator, modelName);
    this.accumulator = createLiveAccumulator();
    this.onResult?.({ ...result, streamedAudio: true });
    this.armResponseTimeout();
  }

  async fail(error) {
    if (this.completed) return;
    this.completed = true;
    this.stopped = true;
    clearTimeout(this.responseTimer);
    await this.stopMicrophone();
    await this.player.close();
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
    try { this.session?.close(); } catch {}
  }
}
