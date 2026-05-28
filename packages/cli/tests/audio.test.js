import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  detectRecorder,
  detectTranscriber,
  recorderArgs,
  ffmpegInputArgs,
  startRecording,
  measureAudioLevel,
  analyseWindow,
  amplitudeToDb,
  diagnoseRecorderExit,
  pickDefaultAudioInput,
  isLikelyVirtualDevice,
  isLoopbackInputDevice,
  detectSystemAudioSource,
  recommendedWhisperModel,
  resolveWhisperModelPath,
  WHISPER_MODELS,
  WHISPER_MODELS_DIR,
  DEFAULT_WHISPER_MODEL_PATH,
  SILENT_AUDIO_THRESHOLD_DB,
} from "../dist/audio.js";

const hasFfmpeg = spawnSync("which", ["ffmpeg"]).status === 0;

/**
 * Tests for the audio helpers used by `atelier session record`.
 *
 * The detection + argv builders are pure — we test them by injecting
 * fake probes. The recording lifecycle is exercised against a tiny
 * fake "recorder" (sh script) so we don't need a real microphone.
 */

// ============================================================
// recorderArgs / ffmpegInputArgs
// ============================================================

test("recorderArgs(sox) builds a 16kHz mono PCM capture argv", () => {
  const args = recorderArgs("sox", "/tmp/out.wav");
  assert.deepEqual(args, [
    "-d",
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "wav",
    "/tmp/out.wav",
  ]);
});

test("recorderArgs(ffmpeg) on darwin uses avfoundation :0 by default", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", { platform: "darwin" });
  assert.ok(args.includes("avfoundation"));
  assert.ok(args.includes(":0"));
  assert.ok(args.includes("-ar"));
  assert.ok(args.includes("16000"));
  assert.equal(args[args.length - 1], "/tmp/out.wav");
});

test("recorderArgs(ffmpeg) on linux uses alsa default device", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", { platform: "linux" });
  assert.ok(args.includes("alsa"));
  assert.ok(args.includes("default"));
});

test("recorderArgs(ffmpeg) on win32 uses dshow", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", { platform: "win32" });
  assert.ok(args.includes("dshow"));
});

test("recorderArgs(ffmpeg) honors --device override", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", {
    platform: "darwin",
    device: ":2",
  });
  assert.ok(args.includes(":2"));
  assert.ok(!args.includes(":0"));
});

test("recorderArgs(ffmpeg, chunkSeconds) routes through segment muxer", () => {
  const args = recorderArgs("ffmpeg", "/tmp/chunks/%04d.wav", {
    platform: "darwin",
    chunkSeconds: 30,
  });
  assert.ok(args.includes("-f"));
  assert.ok(args.includes("segment"));
  assert.ok(args.includes("-segment_time"));
  assert.ok(args.includes("30"));
  assert.ok(args.includes("-reset_timestamps"));
  // The output template should still be the last arg.
  assert.equal(args[args.length - 1], "/tmp/chunks/%04d.wav");
});

// ============================================================
// System-audio capture (cross-platform)
// ============================================================

test("isLoopbackInputDevice catches the Windows dshow loopback names", () => {
  for (const name of [
    "virtual-audio-capturer",
    "Stereo Mix (Realtek HD Audio)",
    "CABLE Output (VB-Audio Cable)",
    "What U Hear (Sound Blaster X-Fi)",
  ]) {
    assert.ok(
      isLoopbackInputDevice(name),
      `"${name}" should be classified as loopback`
    );
  }
});

test("isLoopbackInputDevice does NOT flag real mic names", () => {
  for (const name of [
    "MacBook Pro Microphone",
    "External USB Microphone",
    "Shure SM7B",
    "AirPods Pro",
    "Realtek Microphone Array",
    // BlackHole + Soundflower used to be loopback markers but
    // ScreenCaptureKit replaced that path — these names should not
    // be flagged by the Windows-only loopback list.
    "BlackHole 2ch",
    "Soundflower (2ch)",
  ]) {
    assert.equal(
      isLoopbackInputDevice(name),
      false,
      `"${name}" should NOT be flagged as loopback`
    );
  }
});

// macOS detectSystemAudioSource is now exercised end-to-end against
// the bundled Swift helper rather than mocked device-list probes, so
// there are no synthetic darwin tests here. The dist/macos-helper/
// systemaudio binary either exists (returns available=true with the
// SCK ffmpegInput) or it doesn't (returns available=false with the
// "run npm run build:macos-helper" hint).

test("detectSystemAudioSource(linux) picks the default sink's .monitor source", async () => {
  const src = await detectSystemAudioSource("linux", {
    binaryOnPath: async (cmd) => cmd === "pactl",
    pulseDefaultSink: async () => "alsa_output.pci-0000_00_1f.3.analog-stereo",
    pulseSources: async () => [
      "alsa_input.pci-0000_00_1f.3.analog-stereo",
      "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
      "bluez_sink.AB_CD_EF.a2dp_sink.monitor",
    ],
  });
  assert.equal(src.available, true);
  assert.match(src.label, /analog-stereo\.monitor$/);
  assert.deepEqual(src.ffmpegInput, [
    "-f",
    "pulse",
    "-i",
    "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
  ]);
});

test("detectSystemAudioSource(linux) falls back to any .monitor when the default sink doesn't have one", async () => {
  const src = await detectSystemAudioSource("linux", {
    binaryOnPath: async (cmd) => cmd === "pactl",
    pulseDefaultSink: async () => "some-renamed-default",
    pulseSources: async () => [
      "alsa_input.something",
      "bluez_sink.headphones.a2dp_sink.monitor",
    ],
  });
  assert.equal(src.available, true);
  assert.match(src.label, /\.monitor$/);
});

test("detectSystemAudioSource(linux) surfaces install hint when pactl is missing", async () => {
  const src = await detectSystemAudioSource("linux", {
    binaryOnPath: async () => false,
  });
  assert.equal(src.available, false);
  assert.match(src.setupHint, /pulseaudio-utils/);
});

test("detectSystemAudioSource(win32) picks a known loopback device when present", async () => {
  const src = await detectSystemAudioSource("win32", {
    dshowDevices: async () => [
      "Microphone (Realtek HD Audio)",
      "virtual-audio-capturer",
    ],
  });
  assert.equal(src.available, true);
  assert.equal(src.label, "virtual-audio-capturer");
  assert.deepEqual(src.ffmpegInput, [
    "-f",
    "dshow",
    "-i",
    "audio=virtual-audio-capturer",
  ]);
});

test("detectSystemAudioSource(win32) surfaces install hint when no loopback driver is on dshow", async () => {
  const src = await detectSystemAudioSource("win32", {
    dshowDevices: async () => ["Microphone (Realtek HD Audio)"],
  });
  assert.equal(src.available, false);
  assert.match(src.setupHint, /screen-capture-recorder/);
});

test("detectSystemAudioSource(unsupported platform) reports unavailable cleanly", async () => {
  const src = await detectSystemAudioSource("freebsd");
  assert.equal(src.available, false);
  assert.match(src.setupHint, /isn't implemented for platform/);
});

// ============================================================
// recorderArgs(ffmpeg, systemAudioInput) — dual-input + amix
// ============================================================

test("recorderArgs(ffmpeg, systemAudioInput) builds a dual-input amix pipeline", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", {
    platform: "darwin",
    systemAudioInput: ["-f", "avfoundation", "-i", ":BlackHole 2ch"],
  });
  // Both inputs should appear in order: mic input first, system input second.
  const firstI = args.indexOf("-i");
  const secondI = args.indexOf("-i", firstI + 1);
  assert.ok(secondI > 0, "should have two -i flags");
  assert.equal(args[secondI + 1], ":BlackHole 2ch");
  // amix filter_complex should be present.
  const fcIdx = args.indexOf("-filter_complex");
  assert.ok(fcIdx > 0);
  assert.match(args[fcIdx + 1], /amix=inputs=2/);
  // Primary output gets -map [mixed] (no meter, single output).
  assert.ok(args.includes("-map"));
  assert.ok(args.includes("[mixed]"));
  assert.equal(args[args.length - 1], "/tmp/out.wav");
});

test("recorderArgs(ffmpeg, systemAudioInput + meterPipe) splits via asplit + emits two -map's", () => {
  const args = recorderArgs("ffmpeg", "/tmp/chunks/%04d.wav", {
    platform: "darwin",
    chunkSeconds: 30,
    systemAudioInput: ["-f", "avfoundation", "-i", ":BlackHole 2ch"],
    meterPipe: true,
  });
  const fcIdx = args.indexOf("-filter_complex");
  assert.match(args[fcIdx + 1], /asplit=2\[main\]\[meter\]/);
  // Both [main] and [meter] should appear as -map targets.
  assert.ok(args.includes("[main]"));
  assert.ok(args.includes("[meter]"));
  // Segment muxer should still be wired up for the primary output.
  assert.ok(args.includes("-segment_time"));
  assert.ok(args.includes("30"));
});

test("recorderArgs(ffmpeg) without systemAudioInput uses the single-input path (no -filter_complex)", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", { platform: "darwin" });
  assert.equal(args.indexOf("-filter_complex"), -1);
  assert.equal(args.indexOf("-map"), -1);
});


test("recorderArgs(sox, chunkSeconds) throws — sox can't segment", () => {
  assert.throws(
    () => recorderArgs("sox", "/tmp/out.wav", { chunkSeconds: 30 }),
    /Chunked recording isn't supported with sox/
  );
});

test("recorderArgs(ffmpeg, chunkStartNumber) sets -segment_start_number for resumes", () => {
  const args = recorderArgs("ffmpeg", "/tmp/chunks/%04d.wav", {
    chunkSeconds: 30,
    chunkStartNumber: 17,
  });
  const idx = args.indexOf("-segment_start_number");
  assert.ok(idx > 0, "should include -segment_start_number flag");
  assert.equal(args[idx + 1], "17");
});

test("recorderArgs(ffmpeg, chunkStartNumber=0) omits -segment_start_number (first attempt)", () => {
  const args = recorderArgs("ffmpeg", "/tmp/chunks/%04d.wav", {
    chunkSeconds: 30,
    chunkStartNumber: 0,
  });
  assert.equal(args.indexOf("-segment_start_number"), -1);
});

test("recorderArgs(ffmpeg, meterPipe) appends an s16le pipe:1 output", () => {
  const args = recorderArgs("ffmpeg", "/tmp/out.wav", { meterPipe: true });
  // The primary output (out.wav) should still be there.
  assert.ok(args.includes("/tmp/out.wav"));
  // And a second output to pipe:1 with raw s16le PCM.
  assert.ok(args.includes("pipe:1"));
  // The s16le format flag comes right before pipe:1.
  const pipeIdx = args.indexOf("pipe:1");
  assert.equal(args[pipeIdx - 1], "s16le");
  assert.equal(args[pipeIdx - 2], "-f");
});

// ============================================================
// analyseWindow / amplitudeToDb
// ============================================================

test("amplitudeToDb maps 1.0 → 0 dB and 0 → floor (-90)", () => {
  assert.equal(amplitudeToDb(1.0), 0);
  assert.equal(amplitudeToDb(0), -90);
});

test("amplitudeToDb is monotonic — quieter inputs map to lower dB", () => {
  assert.ok(amplitudeToDb(0.5) > amplitudeToDb(0.1));
  assert.ok(amplitudeToDb(0.1) > amplitudeToDb(0.01));
});

test("analyseWindow reports near-floor dB for an all-zero PCM buffer", () => {
  // 800 samples of silence at s16le = 1600 bytes of zeros.
  const silent = Buffer.alloc(1600);
  const f = analyseWindow(silent, 0);
  assert.equal(f.peak, 0);
  assert.ok(f.peakDb <= -89);
  assert.ok(f.rmsDb <= -89);
});

test("analyseWindow reports near 0 dB for a full-scale square wave", () => {
  // Alternating max-positive / max-negative samples = a saturating
  // signal — peak should hit 1.0 and dB should be at the ceiling.
  const samples = 800;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // 32767 max-positive (alternated with -32768 max-negative).
    const v = i % 2 === 0 ? 32767 : -32768;
    buf.writeInt16LE(v, i * 2);
  }
  const f = analyseWindow(buf, 250);
  assert.ok(f.peak > 0.999);
  assert.ok(f.peakDb > -0.01);
  assert.equal(f.elapsedMs, 250);
});

test("analyseWindow with an empty buffer yields silence cleanly (no NaN)", () => {
  const f = analyseWindow(Buffer.alloc(0), 0);
  assert.equal(f.peak, 0);
  assert.equal(f.peakDb, -90);
  assert.equal(f.rmsDb, -90);
  // New arrays present even for mono — length 1.
  assert.deepEqual(f.peaks, [0]);
  assert.deepEqual(f.peakDbs, [-90]);
});

test("analyseWindow with channels=2 deinterleaves and computes per-channel stats", () => {
  // Build an interleaved stereo buffer: left channel loud, right channel silent.
  // Each int16 sample is 2 bytes; interleaved as L0 R0 L1 R1 ...
  const samples = 64;
  const buf = Buffer.alloc(samples * 2 * 2); // 64 frames, 2ch, 2 bytes/sample
  for (let i = 0; i < samples; i++) {
    // Left = ±10000 alternating (loud-ish), Right = 0 (silent).
    buf.writeInt16LE(i % 2 === 0 ? 10000 : -10000, (i * 2) * 2);
    buf.writeInt16LE(0, (i * 2 + 1) * 2);
  }
  const f = analyseWindow(buf, 0, 2);
  assert.equal(f.peakDbs.length, 2);
  // Left channel has signal → above -20 dB; right channel pure silence → -90.
  assert.ok(f.peakDbs[0] > -20, `expected left channel > -20 dB, got ${f.peakDbs[0]}`);
  assert.equal(f.peakDbs[1], -90);
  // Scalar peakDb = max across channels = the loud left channel.
  assert.equal(f.peakDb, f.peakDbs[0]);
});

test("analyseWindow with channels=2 — right channel loud, left silent (verifies channel order)", () => {
  const samples = 64;
  const buf = Buffer.alloc(samples * 2 * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(0, (i * 2) * 2); // left silent
    buf.writeInt16LE(i % 2 === 0 ? 15000 : -15000, (i * 2 + 1) * 2); // right loud
  }
  const f = analyseWindow(buf, 0, 2);
  assert.equal(f.peakDbs[0], -90);
  assert.ok(f.peakDbs[1] > -10);
});

// ============================================================
// diagnoseRecorderExit — classify why ffmpeg / sox crashed
// ============================================================

test("diagnoseRecorderExit recognises avfoundation 'Failed to capture frame'", () => {
  const d = diagnoseRecorderExit(
    "[avfoundation @ 0x150e0e0a0] Failed to capture frame\n",
    1
  );
  assert.equal(d.cause, "device-changed");
  assert.match(d.summary, /lost the audio device/i);
  assert.match(d.hint, /System Settings|change inputs|swap headphones/i);
});

test("diagnoseRecorderExit recognises I/O errors as device-changed", () => {
  const d = diagnoseRecorderExit(
    "av_interleaved_write_frame(): Input/output error\n",
    1
  );
  assert.equal(d.cause, "device-changed");
});

test("diagnoseRecorderExit catches permission-denied wording", () => {
  const d = diagnoseRecorderExit(
    "AVFoundation: Permission to access microphone not granted\n",
    1
  );
  assert.equal(d.cause, "permission-denied");
  assert.match(d.hint, /System Settings/);
});

test("diagnoseRecorderExit catches device-busy wording", () => {
  const d = diagnoseRecorderExit(
    "Could not open input device — already in use by another process\n",
    1
  );
  assert.equal(d.cause, "device-busy");
});

test("diagnoseRecorderExit catches no-such-device wording", () => {
  const d = diagnoseRecorderExit(
    "No such input device at index :5\n",
    1
  );
  assert.equal(d.cause, "device-not-found");
});

test("diagnoseRecorderExit falls back to 'unknown' for unfamiliar stderr", () => {
  const d = diagnoseRecorderExit("some unrelated error happened\n", 42);
  assert.equal(d.cause, "unknown");
  assert.match(d.summary, /code 42/);
});

test("diagnoseRecorderExit handles empty stderr (no diagnostics emitted)", () => {
  const d = diagnoseRecorderExit("", 137);
  assert.equal(d.cause, "unknown");
  assert.match(d.hint, /No stderr/);
});

// ============================================================
// pickDefaultAudioInput + isLikelyVirtualDevice
// ============================================================

test("isLikelyVirtualDevice catches the common loopback / virtual names", () => {
  for (const name of [
    "Voxal Virtual Device",
    "BlackHole 2ch",
    "Soundflower (2ch)",
    "Loopback Audio",
    "Microsoft Teams Audio",
    "Zoom Audio Device",
    "Krisp Microphone",
    "VB-Cable",
    "Aggregate Device",
  ]) {
    assert.ok(
      isLikelyVirtualDevice(name),
      `"${name}" should be classified as virtual`
    );
  }
});

test("isLikelyVirtualDevice does NOT flag real hardware mic names", () => {
  for (const name of [
    "MacBook Pro Microphone",
    "Built-in Microphone",
    "iMac Microphone",
    "Studio Display Microphone",
    "External USB Microphone",
    "Shure SM7B",
    "AirPods Pro",
  ]) {
    assert.equal(
      isLikelyVirtualDevice(name),
      false,
      `"${name}" should NOT be classified as virtual`
    );
  }
});

test("pickDefaultAudioInput skips virtual devices and prefers built-in mics", () => {
  // Simulates the user's actual machine that motivated this feature.
  const pick = pickDefaultAudioInput([
    { index: 0, name: "Voxal Virtual Device" },
    { index: 1, name: "MacBook Pro Microphone" },
    { index: 2, name: "Microsoft Teams Audio" },
  ]);
  assert.equal(pick?.index, 1);
  assert.equal(pick?.name, "MacBook Pro Microphone");
});

test("pickDefaultAudioInput prefers built-in mic over other real devices", () => {
  const pick = pickDefaultAudioInput([
    { index: 0, name: "External USB Microphone" },
    { index: 1, name: "MacBook Pro Microphone" },
  ]);
  assert.equal(pick?.name, "MacBook Pro Microphone");
});

test("pickDefaultAudioInput falls back to first real device when no built-in is present", () => {
  const pick = pickDefaultAudioInput([
    { index: 0, name: "BlackHole 2ch" },
    { index: 1, name: "External USB Microphone" },
    { index: 2, name: "AirPods" },
  ]);
  assert.equal(pick?.name, "External USB Microphone");
});

test("pickDefaultAudioInput returns the first device when ALL look virtual (last resort)", () => {
  const pick = pickDefaultAudioInput([
    { index: 0, name: "Voxal Virtual Device" },
    { index: 1, name: "BlackHole 2ch" },
  ]);
  assert.equal(pick?.index, 0);
});

test("pickDefaultAudioInput returns null for an empty device list", () => {
  assert.equal(pickDefaultAudioInput([]), null);
});

// ============================================================
// ffmpegInputArgs accepts bare device names (auto-prefixes :)
// ============================================================

test("ffmpegInputArgs(darwin) accepts a bare device name and adds the ': prefix", () => {
  const args = ffmpegInputArgs("darwin", "MacBook Pro Microphone");
  assert.deepEqual(args, ["-f", "avfoundation", "-i", ":MacBook Pro Microphone"]);
});

test("ffmpegInputArgs(darwin) leaves names that already start with : alone", () => {
  const args = ffmpegInputArgs("darwin", ":MacBook Pro Microphone");
  assert.deepEqual(args, ["-f", "avfoundation", "-i", ":MacBook Pro Microphone"]);
});

test("ffmpegInputArgs(darwin) handles legacy :N index form", () => {
  const args = ffmpegInputArgs("darwin", ":2");
  assert.deepEqual(args, ["-f", "avfoundation", "-i", ":2"]);
});

// ============================================================
// recommendedWhisperModel + resolveWhisperModelPath + WHISPER_MODELS
// ============================================================

test("WHISPER_MODELS registry includes the canonical English-only and multilingual variants", () => {
  const files = WHISPER_MODELS.map((m) => m.file);
  // Sanity: tiny + base + small + medium covered, both .en and multilingual
  // where they exist upstream.
  assert.ok(files.includes("ggml-tiny.en.bin"));
  assert.ok(files.includes("ggml-tiny.bin"));
  assert.ok(files.includes("ggml-base.en.bin"));
  assert.ok(files.includes("ggml-base.bin"));
  assert.ok(files.includes("ggml-small.bin"));
  assert.ok(files.includes("ggml-medium.en.bin"));
  assert.ok(files.includes("ggml-medium.bin"));
  // English-only variants have multilingual=false; multilingual=true otherwise.
  for (const m of WHISPER_MODELS) {
    assert.equal(m.multilingual, !m.file.endsWith(".en.bin"), `${m.file} multilingual flag mismatch`);
  }
});

test("recommendedWhisperModel returns medium.en for English (best quality default)", () => {
  for (const code of ["en", "EN", "english", "English"]) {
    assert.equal(recommendedWhisperModel(code).file, "ggml-medium.en.bin");
  }
});

test("recommendedWhisperModel returns medium multilingual for non-English / auto", () => {
  for (const code of ["de", "fr", "es", "ja", "auto", "multi"]) {
    const m = recommendedWhisperModel(code);
    assert.equal(m.file, "ggml-medium.bin");
    assert.equal(m.multilingual, true);
  }
});

test("resolveWhisperModelPath defaults to ~/.atelier-models/ggml-medium.bin", () => {
  const p = resolveWhisperModelPath({});
  assert.equal(p, DEFAULT_WHISPER_MODEL_PATH);
  // Belt-and-braces — make sure the constant itself didn't regress.
  assert.match(p, /ggml-medium\.bin$/);
});

test("resolveWhisperModelPath honors an explicit bare filename via the models dir", () => {
  const p = resolveWhisperModelPath({}, "ggml-base.bin");
  assert.equal(p, WHISPER_MODELS_DIR + "/ggml-base.bin");
});

test("resolveWhisperModelPath leaves absolute paths alone (legacy escape hatch)", () => {
  const p = resolveWhisperModelPath({}, "/opt/models/ggml-large.bin");
  assert.equal(p, "/opt/models/ggml-large.bin");
});

test("resolveWhisperModelPath honors $ATELIER_WHISPER_MODEL when no explicit override", () => {
  const p = resolveWhisperModelPath(
    { ATELIER_WHISPER_MODEL: "/custom/path.bin" }
  );
  assert.equal(p, "/custom/path.bin");
});

test("resolveWhisperModelPath: explicit override beats env var (so per-session wins)", () => {
  const p = resolveWhisperModelPath(
    { ATELIER_WHISPER_MODEL: "/env/path.bin" },
    "ggml-tiny.bin"
  );
  assert.match(p, /ggml-tiny\.bin$/);
  assert.doesNotMatch(p, /env/);
});

test("ffmpegInputArgs is independent of recorderArgs", () => {
  // Direct unit on the helper — useful if recorderArgs grows knobs.
  assert.deepEqual(
    ffmpegInputArgs("darwin"),
    ["-f", "avfoundation", "-i", ":0"]
  );
});

// ============================================================
// detectRecorder
// ============================================================

test("detectRecorder only returns ffmpeg (sox is back-compat-only)", async () => {
  const probe = async (cmd) =>
    cmd === "sox" ? "/fake/sox" : cmd === "ffmpeg" ? "/fake/ffmpeg" : null;
  const r = await detectRecorder(probe);
  assert.equal(r?.kind, "ffmpeg");
  assert.equal(r?.binary, "/fake/ffmpeg");
});

test("detectRecorder ignores sox even when ffmpeg is missing", async () => {
  // ffmpeg is the only supported recorder now. If sox is the only
  // thing on PATH, detectRecorder returns null and the wizard offers
  // to install ffmpeg.
  const probe = async (cmd) => (cmd === "sox" ? "/fake/sox" : null);
  const r = await detectRecorder(probe);
  assert.equal(r, null);
});

test("detectRecorder returns null when ffmpeg isn't on PATH", async () => {
  const r = await detectRecorder(async () => null);
  assert.equal(r, null);
});

// ============================================================
// detectTranscriber
// ============================================================

test("detectTranscriber returns env handle when ATELIER_TRANSCRIBER is set", async () => {
  const t = await detectTranscriber(
    { ATELIER_TRANSCRIBER: "my-stt --opt" },
    async () => null
  );
  assert.equal(t?.kind, "env");
  assert.match(t?.label ?? "", /ATELIER_TRANSCRIBER/);
});

test("detectTranscriber blank env falls through to whisper detection", async () => {
  const probe = async (cmd) => (cmd === "whisper" ? "/usr/local/bin/whisper" : null);
  const t = await detectTranscriber({ ATELIER_TRANSCRIBER: "   " }, probe);
  assert.equal(t?.kind, "whisper");
});

test("detectTranscriber returns null when nothing is configured", async () => {
  const t = await detectTranscriber({}, async () => null);
  assert.equal(t, null);
});

test("env transcriber runs sh -c with wav as $1 and captures stdout", async () => {
  // The transcriber contract is: $1 = wav path, stdout = transcript.
  // We stub the command with `echo` so we don't need a real STT.
  const t = await detectTranscriber(
    { ATELIER_TRANSCRIBER: 'echo "transcript of $1"' },
    async () => null
  );
  const text = await t.transcribe("/path/to/clip.wav");
  assert.equal(text.trim(), "transcript of /path/to/clip.wav");
});

// ============================================================
// startRecording — lifecycle, using a fake recorder
// ============================================================

/**
 * Build a fake "recorder" that we control: a tiny sh script that
 * writes a wav header + a few sample bytes, then sleeps until killed.
 * This lets us exercise the start → stop → exit pipeline without a
 * microphone.
 */
async function makeFakeRecorder(dir) {
  const script = path.join(dir, "fake-recorder.sh");
  await fs.writeFile(
    script,
    [
      "#!/bin/sh",
      // Find the output path — the last argv element. POSIX-safe
      // (avoids the bash-only `${@: -1}` slice).
      'for OUT in "$@"; do :; done',
      // Write a minimal but plausible amount of bytes so wavBytes >=
      // 1024 in the recordCmd path.
      'dd if=/dev/zero of="$OUT" bs=1 count=2048 2>/dev/null',
      // Block on a pipe so the process sticks around until SIGTERM.
      'trap "exit 0" TERM INT',
      "while true; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(script, 0o755);
  return script;
}

/**
 * Build a fake recorder that exits with a NON-ZERO code on SIGTERM —
 * simulates ffmpeg's behavior when it receives 'q' on stdin and
 * returns 255 even though everything finalised cleanly. Regression
 * test for the bug where `session record` reported "Recording
 * failed: ffmpeg exited with code 255" after a clean Ctrl-C.
 */
async function makeFakeRecorderExitingNonZero(dir) {
  const script = path.join(dir, "fake-recorder-255.sh");
  await fs.writeFile(
    script,
    [
      "#!/bin/sh",
      'for OUT in "$@"; do :; done',
      'dd if=/dev/zero of="$OUT" bs=1 count=2048 2>/dev/null',
      // The key bit: on SIGTERM, finalize then exit with 255 to
      // mimic ffmpeg's 'q' shutdown.
      'trap "exit 255" TERM INT',
      "while true; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(script, 0o755);
  return script;
}

test("startRecording.exited resolves cleanly when recorder returns non-zero after stop()", async () => {
  // Regression: ffmpeg legitimately returns 255 after receiving 'q' on
  // stdin. We use kind: "sox" here so stop() sends SIGTERM (which the
  // fake script traps), but the assertion is the same — any non-zero
  // exit after stop() should be treated as graceful.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-audio-test-"));
  try {
    const fake = await makeFakeRecorderExitingNonZero(dir);
    const outPath = path.join(dir, "rec.wav");
    const handle = startRecording({ kind: "sox", binary: fake }, outPath);
    for (let i = 0; i < 50; i++) {
      try {
        const s = await fs.stat(outPath);
        if (s.size > 0) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await handle.stop();
    await handle.exited; // should NOT throw, even though child exited with 255
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startRecording.exited rejects when the recorder dies without us asking it to", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-audio-test-"));
  try {
    // Recorder that exits non-zero on its own (no stop() called).
    const script = path.join(dir, "crashy.sh");
    await fs.writeFile(
      script,
      "#!/bin/sh\nexit 42\n",
      "utf8"
    );
    await fs.chmod(script, 0o755);
    const handle = startRecording(
      { kind: "ffmpeg", binary: script },
      path.join(dir, "rec.wav")
    );
    await assert.rejects(() => handle.exited, /exited with code 42/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// measureAudioLevel — the silence guard
// ============================================================

test("measureAudioLevel returns null for missing or tiny files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-level-"));
  try {
    // Missing file → null
    assert.equal(await measureAudioLevel(path.join(dir, "ghost.wav")), null);
    // Too-small file → null (we treat <1KB as "nothing useful here")
    await fs.writeFile(path.join(dir, "tiny.wav"), "RIFF");
    assert.equal(await measureAudioLevel(path.join(dir, "tiny.wav")), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  "measureAudioLevel reports near -91 dB for synthesised silence",
  { skip: !hasFfmpeg },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-level-"));
    try {
      const wav = path.join(dir, "silent.wav");
      // 1 second of true silence via lavfi.
      spawnSync(
        "ffmpeg",
        ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", wav],
        { stdio: "ignore" }
      );
      const level = await measureAudioLevel(wav);
      assert.ok(level !== null, "should produce a measurement");
      assert.ok(
        level.mean < SILENT_AUDIO_THRESHOLD_DB,
        `synthetic silence should fall below ${SILENT_AUDIO_THRESHOLD_DB} dB, got ${level.mean}`
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "measureAudioLevel reports a loud level for a synthesised tone",
  { skip: !hasFfmpeg },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-level-"));
    try {
      const wav = path.join(dir, "tone.wav");
      // 1 second of a 440 Hz sine wave — well above the silence threshold.
      spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1:sample_rate=16000",
          wav,
        ],
        { stdio: "ignore" }
      );
      const level = await measureAudioLevel(wav);
      assert.ok(level !== null, "should produce a measurement");
      assert.ok(
        level.mean > SILENT_AUDIO_THRESHOLD_DB,
        `a 440Hz tone should sit above ${SILENT_AUDIO_THRESHOLD_DB} dB, got ${level.mean}`
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test("startRecording → stop() exits cleanly and the wav is on disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-audio-test-"));
  try {
    const fake = await makeFakeRecorder(dir);
    const outPath = path.join(dir, "rec.wav");
    const handle = startRecording(
      { kind: "sox", binary: fake },
      outPath
    );
    // Wait for the file to materialise rather than guessing a fixed
    // delay — spawn + sh startup is slow on CI under load.
    for (let i = 0; i < 50; i++) {
      try {
        const s = await fs.stat(outPath);
        if (s.size > 0) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await handle.stop();
    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, "wav file should have bytes written");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
