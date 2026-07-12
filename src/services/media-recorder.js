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

// Split an `enumerateDevices` result into labelled input lists.
export function pickRecordingDevices(devices = []) {
  const label = (device, index, fallback) => device.label || `${fallback} ${index + 1}`;
  const audioInputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({ id: device.deviceId, label: label(device, index, "Microphone") }));
  const videoInputs = devices
    .filter((device) => device.kind === "videoinput")
    .map((device, index) => ({ id: device.deviceId, label: label(device, index, "Camera") }));
  return { audioInputs, videoInputs };
}

// Exponential smoothing used for the Screen-Studio style zoom animation.
export function nextZoomValue(current, target, factor = 0.12) {
  const value = current + (target - current) * factor;
  return Math.abs(value - target) < 0.002 ? target : value;
}

// Track cursor dwell to decide when auto-zoom should engage. Returns the new
// tracker state; `zoomedIn` flips after the cursor rests for `dwellMs` and
// releases after fast movement lasting `releaseMs`.
export function cursorDwellStep(previous, sample, options = {}) {
  const { dwellMs = 550, releaseMs = 250, moveThreshold = 14 } = options;
  const state = previous || { x: sample.x, y: sample.y, restingSince: sample.at, movingSince: null, zoomedIn: false };
  const distance = Math.hypot(sample.x - state.x, sample.y - state.y);
  const moving = distance > moveThreshold;
  const next = { ...state, x: sample.x, y: sample.y };
  if (moving) {
    next.restingSince = sample.at;
    next.movingSince = state.movingSince ?? sample.at;
    if (next.zoomedIn && sample.at - next.movingSince >= releaseMs) next.zoomedIn = false;
  } else {
    next.movingSince = null;
    if (!next.zoomedIn && sample.at - next.restingSince >= dwellMs) next.zoomedIn = true;
  }
  return next;
}

// Source and destination rectangles for a zoomed frame that keeps the cursor
// at the exact center of the canvas. Near the screen edges the source is
// clipped (never shifted), so the uncovered canvas area shows the backdrop
// instead of the cursor drifting away from the middle.
export function zoomDrawRects({ width, height, zoom, cursorX, cursorY }) {
  const scale = Math.max(1, Number(zoom) || 1);
  if (scale === 1) {
    const full = { x: 0, y: 0, width, height };
    return { crop: { ...full }, zoom: 1, source: { ...full }, dest: { ...full } };
  }
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const cropX = cursorX - cropWidth / 2;
  const cropY = cursorY - cropHeight / 2;
  const sourceX = Math.min(width, Math.max(0, cropX));
  const sourceY = Math.min(height, Math.max(0, cropY));
  const sourceWidth = Math.max(0, Math.min(width, cropX + cropWidth) - sourceX);
  const sourceHeight = Math.max(0, Math.min(height, cropY + cropHeight) - sourceY);
  return {
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    zoom: scale,
    source: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
    dest: {
      x: (sourceX - cropX) * scale,
      y: (sourceY - cropY) * scale,
      width: sourceWidth * scale,
      height: sourceHeight * scale
    }
  };
}

// Concentric rings drawn around the cursor when the highlight option is on:
// a light-green outer circle with a light-blue inner circle, kept thin and
// translucent so the marker stays clean over any page content.
export function cursorHaloCircles() {
  return [
    { radius: 26, stroke: "rgba(134, 239, 172, .85)", lineWidth: 3 },
    { radius: 16, stroke: "rgba(96, 165, 250, .9)", lineWidth: 3 }
  ];
}

export function recordingFileName(kind, mimeType) {
  const extension = kind === "photo" ? "png" : recordingExtension(kind, mimeType);
  return `auri-${kind}-${new Date().toISOString().replaceAll(":", "-")}.${extension}`;
}

export class MediaCapture {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.extraStreams = [];
    this.chunks = [];
    this.onReady = null;
    this.audioContext = null;
    this.audioSource = null;
    this.audioDestination = null;
    this.analyser = null;
    this.compositor = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
  }

  get state() {
    return this.recorder?.state || "inactive";
  }

  elapsedMs(now = Date.now()) {
    if (!this.startedAt) return 0;
    const pausedExtra = this.pausedAt ? now - this.pausedAt : 0;
    return Math.max(0, now - this.startedAt - this.pausedTotal - pausedExtra);
  }

  async start({
    kind,
    source,
    includeMicrophone = false,
    audioDeviceId = null,
    videoDeviceId = null,
    effects = null,
    onReady
  }) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      throw new Error("Recording is not supported by this runtime.");
    }
    const audioConstraint = audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true;
    const videoConstraint = videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true;

    let stream;
    if (kind === "video" && source === "screen") {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.extraStreams.push(display);
      // Screen captures always run through the canvas compositor when effects
      // are configured, so auto zoom and the cursor highlight can be toggled
      // while the recording is running.
      if (effects) {
        stream = await this.composeScreenStream(display, { ...effects, includeMicrophone, audioConstraint, videoDeviceId });
      } else {
        stream = new MediaStream(display.getTracks());
        if (includeMicrophone) {
          const microphone = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
          this.extraStreams.push(microphone);
          microphone.getAudioTracks().forEach((track) => stream.addTrack(track));
        }
      }
    } else if (kind === "video") {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: audioConstraint });
    } else if (source === "screen-audio") {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.extraStreams.push(display);
      stream = new MediaStream(display.getAudioTracks());
      if (!stream.getAudioTracks().length) {
        display.getTracks().forEach((track) => track.stop());
        throw new Error("The selected screen did not provide a system-audio track.");
      }
    } else {
      // Microphone audio is routed through an AudioContext graph so the input
      // device can be switched mid-recording without restarting the recorder.
      stream = await this.buildSwitchableAudioStream(audioConstraint);
    }

    const mimeType = recorderMimeCandidates(kind === "photo" ? "video" : kind)
      .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
    this.stream = stream;
    this.chunks = [];
    this.onReady = onReady;
    this.startedAt = Date.now();
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) this.chunks.push(event.data);
    });
    this.recorder.addEventListener("stop", () => this.finish(kind, mimeType || this.recorder.mimeType));
    const timeslice = recordingTimeslice(mimeType || this.recorder.mimeType);
    if (timeslice === undefined) this.recorder.start();
    else this.recorder.start(timeslice);
  }

  async buildSwitchableAudioStream(audioConstraint) {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    this.extraStreams.push(microphone);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return microphone;
    this.audioContext = new AudioContextClass();
    this.audioDestination = this.audioContext.createMediaStreamDestination();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.audioSource = this.audioContext.createMediaStreamSource(microphone);
    this.audioSource.connect(this.analyser);
    this.audioSource.connect(this.audioDestination);
    this.microphoneStream = microphone;
    return this.audioDestination.stream;
  }

  // Swap the microphone feeding the recorder. Works while recording because
  // the MediaRecorder consumes the constant AudioContext destination stream.
  async switchMicrophone(deviceId) {
    if (!this.audioContext || !this.audioDestination) {
      throw new Error("Microphone switching is available for audio recordings.");
    }
    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    });
    const previousSource = this.audioSource;
    const previousStream = this.microphoneStream;
    this.audioSource = this.audioContext.createMediaStreamSource(microphone);
    this.audioSource.connect(this.analyser);
    this.audioSource.connect(this.audioDestination);
    previousSource?.disconnect();
    if (previousStream) {
      previousStream.getTracks().forEach((track) => track.stop());
      this.extraStreams = this.extraStreams.filter((item) => item !== previousStream);
    }
    this.microphoneStream = microphone;
    this.extraStreams.push(microphone);
  }

  // Compose the display stream through a canvas so the recording gets the
  // Screen-Studio style treatment: smooth auto-zoom toward the resting
  // cursor and an optional webcam bubble in the corner.
  async composeScreenStream(display, effects) {
    const displayVideo = document.createElement("video");
    displayVideo.srcObject = display;
    displayVideo.muted = true;
    await displayVideo.play();
    const width = displayVideo.videoWidth || 1920;
    const height = displayVideo.videoHeight || 1080;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");

    let cameraVideo = null;
    if (effects.cameraBubble) {
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          video: effects.videoDeviceId ? { deviceId: { exact: effects.videoDeviceId } } : true
        });
        this.extraStreams.push(camera);
        cameraVideo = document.createElement("video");
        cameraVideo.srcObject = camera;
        cameraVideo.muted = true;
        await cameraVideo.play();
      } catch {
        cameraVideo = null;
      }
    }

    let zoom = 1;
    let dwell = null;
    let running = true;
    const getCursor = typeof effects.getCursor === "function" ? effects.getCursor : () => null;
    const draw = () => {
      if (!running) return;
      const cursor = getCursor();
      const autoZoom = typeof effects.getAutoZoom === "function" ? effects.getAutoZoom() : effects.autoZoom;
      const highlight = typeof effects.getCursorHighlight === "function" ? effects.getCursorHighlight() : effects.cursorHighlight;
      const hasCursor = Boolean(cursor && cursor.x >= 0 && cursor.y >= 0);
      let targetZoom = 1;
      let focusX = width / 2;
      let focusY = height / 2;
      if (autoZoom && hasCursor) {
        dwell = cursorDwellStep(dwell, { x: cursor.x, y: cursor.y, at: Date.now() });
        targetZoom = dwell.zoomedIn ? Number(effects.zoomLevel) || 1.9 : 1;
        focusX = cursor.x;
        focusY = cursor.y;
      } else {
        dwell = null;
      }
      zoom = nextZoomValue(zoom, targetZoom);
      const rects = zoomDrawRects({ width, height, zoom, cursorX: focusX, cursorY: focusY });
      context.fillStyle = "#11151a";
      context.fillRect(0, 0, width, height);
      if (rects.source.width > 0 && rects.source.height > 0) {
        context.drawImage(
          displayVideo,
          rects.source.x, rects.source.y, rects.source.width, rects.source.height,
          rects.dest.x, rects.dest.y, rects.dest.width, rects.dest.height
        );
      }
      if (highlight && hasCursor) {
        const haloX = (cursor.x - rects.crop.x) * rects.zoom;
        const haloY = (cursor.y - rects.crop.y) * rects.zoom;
        for (const circle of cursorHaloCircles()) {
          context.beginPath();
          context.arc(haloX, haloY, circle.radius, 0, Math.PI * 2);
          context.lineWidth = circle.lineWidth;
          context.strokeStyle = circle.stroke;
          context.stroke();
        }
      }
      if (cameraVideo) {
        const radius = Math.round(Math.min(width, height) * 0.11);
        const cx = radius + 32;
        const cy = height - radius - 32;
        context.save();
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.closePath();
        context.clip();
        const side = Math.min(cameraVideo.videoWidth, cameraVideo.videoHeight) || 1;
        context.drawImage(
          cameraVideo,
          (cameraVideo.videoWidth - side) / 2,
          (cameraVideo.videoHeight - side) / 2,
          side,
          side,
          cx - radius,
          cy - radius,
          radius * 2,
          radius * 2
        );
        context.restore();
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.lineWidth = 6;
        context.strokeStyle = "rgba(255,255,255,.85)";
        context.stroke();
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    this.compositor = { stop: () => { running = false; displayVideo.srcObject = null; if (cameraVideo) cameraVideo.srcObject = null; } };

    const stream = canvas.captureStream(30);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      this.audioContext = new AudioContextClass();
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      if (display.getAudioTracks().length) {
        const systemSource = this.audioContext.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
        systemSource.connect(this.audioDestination);
      }
      if (effects.includeMicrophone) {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: effects.audioConstraint || true });
        this.extraStreams.push(microphone);
        this.microphoneStream = microphone;
        this.audioSource = this.audioContext.createMediaStreamSource(microphone);
        this.audioSource.connect(this.analyser);
        this.audioSource.connect(this.audioDestination);
      }
      this.audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    }
    return stream;
  }

  async capturePhoto({ videoDeviceId = null, previewElement = null, mirror = false } = {}) {
    let video = previewElement;
    let ownedStream = null;
    if (!video || !video.videoWidth) {
      ownedStream = await navigator.mediaDevices.getUserMedia({
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true
      });
      video = document.createElement("video");
      video.srcObject = ownedStream;
      video.muted = true;
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext("2d");
    if (mirror) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (ownedStream) {
      ownedStream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Photo capture failed."))), "image/png");
    });
    return {
      kind: "photo",
      mime: "image/png",
      blob,
      previewUrl: URL.createObjectURL(blob),
      fileName: recordingFileName("photo", "image/png")
    };
  }

  pause() {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedAt = Date.now();
    }
  }

  resume() {
    if (this.recorder?.state === "paused") {
      this.recorder.resume();
      if (this.pausedAt) {
        this.pausedTotal += Date.now() - this.pausedAt;
        this.pausedAt = 0;
      }
    }
  }

  stop() {
    if (this.recorder?.state === "recording" || this.recorder?.state === "paused") this.recorder.stop();
  }

  finish(kind, mimeType) {
    const blob = new Blob(this.chunks, { type: mimeType });
    const previewUrl = URL.createObjectURL(blob);
    const fileName = recordingFileName(kind, mimeType);
    this.compositor?.stop();
    this.compositor = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.extraStreams.forEach((item) => item.getTracks().forEach((track) => track.stop()));
    this.stream = null;
    this.extraStreams = [];
    this.audioSource = null;
    this.audioDestination = null;
    this.analyser = null;
    this.microphoneStream = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.onReady?.({ kind, mime: mimeType, blob, previewUrl, fileName });
    this.recorder = null;
  }
}
