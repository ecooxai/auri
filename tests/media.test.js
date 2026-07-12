import test from "node:test";
import assert from "node:assert/strict";
import { recorderMimeCandidates, recordingExtension, recordingTimeslice } from "../src/services/media-recorder.js";

test("prefers MP4 capture with WebM fallback", () => {
  assert.deepEqual(recorderMimeCandidates("audio").slice(0, 2), ["audio/mp4", "audio/webm;codecs=opus"]);
  assert.deepEqual(recorderMimeCandidates("video").slice(0, 2), ["video/mp4", "video/webm;codecs=vp9,opus"]);
});

test("uses m4a for MP4 audio and webm for fallback", () => {
  assert.equal(recordingExtension("audio", "audio/mp4"), "m4a");
  assert.equal(recordingExtension("video", "video/mp4"), "mp4");
  assert.equal(recordingExtension("audio", "audio/webm"), "webm");
});


test("MP4 recordings finalize as one playable file instead of timed fragments", () => {
  assert.equal(recordingTimeslice("audio/mp4"), undefined);
  assert.equal(recordingTimeslice("video/mp4"), undefined);
  assert.equal(recordingTimeslice("audio/webm"), 250);
});

test("device lists split enumerated inputs with fallback labels", async () => {
  const { pickRecordingDevices } = await import("../src/services/media-recorder.js");
  const { audioInputs, videoInputs } = pickRecordingDevices([
    { kind: "audioinput", deviceId: "mic-1", label: "USB Mic" },
    { kind: "audioinput", deviceId: "mic-2", label: "" },
    { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD" },
    { kind: "audiooutput", deviceId: "speaker", label: "Speakers" }
  ]);
  assert.deepEqual(audioInputs, [
    { id: "mic-1", label: "USB Mic" },
    { id: "mic-2", label: "Microphone 2" }
  ]);
  assert.deepEqual(videoInputs, [{ id: "cam-1", label: "FaceTime HD" }]);
});

test("auto-zoom engages after cursor dwell and releases on sustained movement", async () => {
  const { cursorDwellStep } = await import("../src/services/media-recorder.js");
  let state = null;
  state = cursorDwellStep(state, { x: 100, y: 100, at: 0 });
  assert.equal(state.zoomedIn, false);
  state = cursorDwellStep(state, { x: 102, y: 101, at: 600 });
  assert.equal(state.zoomedIn, true, "resting cursor zooms in");
  state = cursorDwellStep(state, { x: 400, y: 400, at: 700 });
  state = cursorDwellStep(state, { x: 700, y: 100, at: 1000 });
  assert.equal(state.zoomedIn, false, "fast movement zooms back out");
});

test("zoomed frames keep the cursor at the center of the video", async () => {
  const { zoomDrawRects } = await import("../src/services/media-recorder.js");
  const centered = zoomDrawRects({ width: 1000, height: 600, zoom: 2, cursorX: 500, cursorY: 300 });
  assert.deepEqual(centered.source, { x: 250, y: 150, width: 500, height: 300 });
  assert.deepEqual(centered.dest, { x: 0, y: 0, width: 1000, height: 600 });

  // Near an edge the crop is clipped instead of shifted, so the cursor's
  // screen point still maps to the exact middle of the canvas.
  const cornered = zoomDrawRects({ width: 1000, height: 600, zoom: 2, cursorX: 50, cursorY: 40 });
  assert.deepEqual(cornered.source, { x: 0, y: 0, width: 300, height: 190 });
  assert.deepEqual(cornered.dest, { x: 400, y: 220, width: 600, height: 380 });
  const cursorCanvasX = (50 - cornered.crop.x) * 2;
  const cursorCanvasY = (40 - cornered.crop.y) * 2;
  assert.equal(cursorCanvasX, 500);
  assert.equal(cursorCanvasY, 300);

  const unzoomed = zoomDrawRects({ width: 1000, height: 600, zoom: 1, cursorX: 990, cursorY: 590 });
  assert.deepEqual(unzoomed.source, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(unzoomed.dest, { x: 0, y: 0, width: 1000, height: 600 });
});

test("cursor halo draws a light-blue inner circle inside a light-green outer circle", async () => {
  const { cursorHaloCircles } = await import("../src/services/media-recorder.js");
  const circles = cursorHaloCircles();
  assert.equal(circles.length, 2);
  const [outer, inner] = circles;
  assert.ok(outer.radius > inner.radius);
  assert.match(outer.stroke, /rgba\(\s*13[0-9]/); // light green
  assert.match(inner.stroke, /rgba\(\s*9[0-9]/); // light blue
  for (const circle of circles) {
    assert.ok(circle.lineWidth > 0);
  }
});

test("holding Ctrl for two seconds toggles auto zoom during a screen recording", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.capture.compositor = { stop() {} };
  controller.state.media.status = "recording";
  controller.state.media.autoZoom = true;

  await controller.handleGlobalKeydown({ key: "Control", code: "ControlLeft", ctrlKey: true, preventDefault() {} });
  t.mock.timers.tick(1999);
  assert.equal(controller.state.media.autoZoom, true);
  t.mock.timers.tick(1);
  assert.equal(controller.state.media.autoZoom, false);

  controller.handleGlobalKeyup({ key: "Control", code: "ControlLeft" });
  await controller.handleGlobalKeydown({ key: "Control", code: "ControlLeft", ctrlKey: true, preventDefault() {} });
  t.mock.timers.tick(2000);
  assert.equal(controller.state.media.autoZoom, true);
});

test("releasing Ctrl before two seconds leaves auto zoom unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { AppController } = await import("../src/controllers/app-controller.js");
  const view = {
    root: { querySelector: () => null },
    render() {},
    getTerminalInputValue: () => "",
    showToast() {}
  };
  const controller = new AppController({
    view,
    backend: { isNative: false },
    terminalSessionFactory: () => ({ initialize: async () => {} })
  });
  controller.capture.compositor = { stop() {} };
  controller.state.media.status = "recording";
  controller.state.media.autoZoom = true;

  await controller.handleGlobalKeydown({ key: "Control", code: "ControlLeft", ctrlKey: true, preventDefault() {} });
  t.mock.timers.tick(1500);
  controller.handleGlobalKeyup({ key: "Control", code: "ControlLeft" });
  t.mock.timers.tick(1000);
  assert.equal(controller.state.media.autoZoom, true);
});

test("the cursor highlight option renders in Settings and in the screen recorder controls", async () => {
  const { createInitialState } = await import("../src/model/state.js");
  const { renderRecorder, renderSettings } = await import("../src/views/panels.js");
  const state = createInitialState();
  state.media.mode = "screen";

  assert.match(renderSettings(state), /data-setting="cursorHighlight"/);
  assert.match(renderRecorder(state, "video"), /data-setting="cursorHighlight"/);
  assert.match(renderRecorder(state, "video"), /Circle around cursor/);
});

test("zoom animation smoothly approaches and snaps to its target", async () => {
  const { nextZoomValue } = await import("../src/services/media-recorder.js");
  const first = nextZoomValue(1, 2);
  assert.ok(first > 1 && first < 2);
  assert.equal(nextZoomValue(1.999, 2), 2);
});

test("recorder panels expose modes, device pickers, and pause controls", async () => {
  const { renderRecorder } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, { type: "MEDIA_SET", payload: { audioInputs: [{ id: "mic-1", label: "USB Mic" }], videoInputs: [{ id: "cam-1", label: "Cam" }] } });

  const audio = renderRecorder(state, "audio");
  assert.match(audio, /id="audio-waveform"/);
  assert.match(audio, /id="record-audio-device"/);
  assert.match(audio, /USB Mic/);

  let video = renderRecorder(state, "video");
  assert.match(video, /data-action="record-mode" data-mode="photo"/);
  assert.match(video, /data-action="record-mode" data-mode="screen"/);
  assert.match(video, /id="camera-preview"/);

  state = reduceState(state, { type: "MEDIA_SET", payload: { mode: "photo" } });
  video = renderRecorder(state, "video");
  assert.match(video, /data-action="record-photo"/);

  state = reduceState(state, { type: "MEDIA_SET", payload: { mode: "screen" } });
  video = renderRecorder(state, "video");
  assert.match(video, /Auto zoom to cursor/);
  assert.match(video, /Camera bubble/);

  state = reduceState(state, { type: "MEDIA_SET", payload: { status: "recording", kind: "audio" } });
  const live = renderRecorder(state, "audio");
  assert.match(live, /data-action="record-pause"/);
  assert.match(live, /data-action="record-stop"/);

  state = reduceState(state, { type: "MEDIA_SET", payload: { paused: true } });
  assert.match(renderRecorder(state, "audio"), /data-action="record-resume"/);
});

test("record commands cover pause, resume, photo, mic switching, and modes", async () => {
  const { executeCommand } = await import("../src/controllers/command-controller.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  const calls = [];
  const context = {
    getState: () => state,
    dispatch: (action) => { state = reduceState(state, action); },
    backend: {},
    actions: {
      pauseRecording: () => calls.push("pause"),
      resumeRecording: () => calls.push("resume"),
      capturePhoto: () => calls.push("photo"),
      switchMicrophone: (id) => calls.push(["mic", id])
    }
  };
  await executeCommand("record mode screen", context);
  assert.equal(state.media.mode, "screen");
  await executeCommand("record photo", context);
  assert.deepEqual(calls, ["photo"]);
  await executeCommand("record pause", context);
  assert.equal(state.media.paused, true);
  await executeCommand("record resume", context);
  assert.equal(state.media.paused, false);
  // Not recording: mic switch only records the selection.
  await executeCommand("record mic mic-2", context);
  assert.equal(state.media.audioDeviceId, "mic-2");
  assert.deepEqual(calls, ["photo", "pause", "resume"]);
  // While recording it also swaps the live source.
  state = reduceState(state, { type: "MEDIA_SET", payload: { status: "recording", kind: "audio" } });
  await executeCommand("record mic default", context);
  assert.deepEqual(calls.at(-1), ["mic", null]);
  assert.equal(state.media.audioDeviceId, null);
});

test("the folder viewer offers attaching the selected file to the AI prompt", async () => {
  const { renderFolder, renderViewer } = await import("../src/views/panels.js");
  const { createInitialState, reduceState } = await import("../src/model/state.js");
  let state = createInitialState();
  state = reduceState(state, { type: "FOLDER_ENTRIES_SET", payload: { entries: [{ name: "clip.mp4", path: "/tmp/clip.mp4", kind: "video" }] } });
  state = reduceState(state, { type: "FOLDER_ENTRY_SELECT", payload: { path: "/tmp/clip.mp4" } });
  const folderHtml = renderFolder(state);
  assert.match(folderHtml, /data-action="file-attach-ai" data-path="\/tmp\/clip\.mp4"/);

  state = reduceState(state, { type: "FILE_SELECT", payload: { path: "/tmp/clip.mp4", metadata: { name: "clip.mp4", kind: "video" }, open: false } });
  state = reduceState(state, { type: "SUBTAB_NEW", payload: { type: "viewer" } });
  const viewerHtml = renderViewer(state);
  assert.match(viewerHtml, /data-action="file-attach-ai"/);
  assert.match(viewerHtml, /data-action="file-serve"/);
});
