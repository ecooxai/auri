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
