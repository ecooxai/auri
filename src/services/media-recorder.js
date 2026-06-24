export function recorderMimeCandidates(kind) {
  return kind === "video"
    ? ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
}

export function recordingTimeslice(mimeType) {
  return String(mimeType).includes("mp4") ? undefined : 250;
}

export function recordingExtension(kind, mimeType) {
  if (mimeType.includes("mp4")) return kind === "audio" ? "m4a" : "mp4";
  return "webm";
}

export class MediaCapture {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.extraStreams = [];
    this.chunks = [];
    this.onReady = null;
  }

  async start({ kind, source, includeMicrophone = false, onReady }) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      throw new Error("Recording is not supported by this runtime.");
    }

    let stream;
    if (kind === "video" && source === "screen") {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (includeMicrophone) {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.extraStreams.push(microphone);
        microphone.getAudioTracks().forEach((track) => stream.addTrack(track));
      }
    } else if (kind === "video") {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } else if (source === "screen-audio") {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.extraStreams.push(display);
      stream = new MediaStream(display.getAudioTracks());
      if (!stream.getAudioTracks().length) {
        display.getTracks().forEach((track) => track.stop());
        throw new Error("The selected screen did not provide a system-audio track.");
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const mimeType = recorderMimeCandidates(kind)
      .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
    this.stream = stream;
    this.chunks = [];
    this.onReady = onReady;
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) this.chunks.push(event.data);
    });
    this.recorder.addEventListener("stop", () => this.finish(kind, mimeType || this.recorder.mimeType));
    const timeslice = recordingTimeslice(mimeType || this.recorder.mimeType);
    if (timeslice === undefined) this.recorder.start();
    else this.recorder.start(timeslice);
  }

  stop() {
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  finish(kind, mimeType) {
    const blob = new Blob(this.chunks, { type: mimeType });
    const previewUrl = URL.createObjectURL(blob);
    const extension = recordingExtension(kind, mimeType);
    const fileName = `auri-${kind}-${new Date().toISOString().replaceAll(":", "-")}.${extension}`;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.extraStreams.forEach((item) => item.getTracks().forEach((track) => track.stop()));
    this.stream = null;
    this.extraStreams = [];
    this.onReady?.({ kind, mime: mimeType, blob, previewUrl, fileName });
    this.recorder = null;
  }
}
