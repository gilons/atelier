import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadAudioConfig,
  saveAudioConfig,
} from "../dist/index.js";

/**
 * Tests for `.atelier/audio.yaml` — the persisted preference file
 * that `session record` / `session setup` write so the wizard
 * doesn't have to ask every time.
 */

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-audio-cfg-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

test("loadAudioConfig returns null when audio.yaml hasn't been created", async () => {
  const root = await workspace();
  const cfg = await loadAudioConfig(root);
  assert.equal(cfg, null);
});

test("saveAudioConfig writes a valid file that loadAudioConfig round-trips", async () => {
  const root = await workspace();
  await saveAudioConfig(root, {
    version: 1,
    recorder: "sox",
    transcriber: "agent",
  });
  const cfg = await loadAudioConfig(root);
  assert.deepEqual(cfg, { version: 1, recorder: "sox", transcriber: "agent" });
});

test("audio.yaml is human-readable with the management header", async () => {
  const root = await workspace();
  await saveAudioConfig(root, {
    version: 1,
    recorder: "ffmpeg",
    transcriber: "whisper",
  });
  const text = await fs.readFile(
    path.join(root, ".atelier", "audio.yaml"),
    "utf8"
  );
  assert.match(text, /Atelier audio preferences/);
  assert.match(text, /recorder: ffmpeg/);
  assert.match(text, /transcriber: whisper/);
});

test("loadAudioConfig rejects an unknown recorder kind", async () => {
  const root = await workspace();
  // Hand-write a malformed file to simulate a user typo.
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    "version: 1\nrecorder: garageband\ntranscriber: agent\n",
    "utf8"
  );
  await assert.rejects(() => loadAudioConfig(root), /recorder must be one of/);
});

test("loadAudioConfig rejects an unknown transcriber kind", async () => {
  const root = await workspace();
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    "version: 1\nrecorder: sox\ntranscriber: telegraph\n",
    "utf8"
  );
  await assert.rejects(() => loadAudioConfig(root), /transcriber must be one of/);
});

test("loadAudioConfig rejects an unknown version (forward-compat guard)", async () => {
  const root = await workspace();
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    "version: 99\nrecorder: sox\ntranscriber: agent\n",
    "utf8"
  );
  await assert.rejects(() => loadAudioConfig(root), /unknown audio.yaml version/);
});

// ============================================================
// whisper preferences (multi-language support)
// ============================================================

test("audio.yaml round-trips a whisper.language + whisper.model block", async () => {
  const root = await workspace();
  await saveAudioConfig(root, {
    version: 1,
    recorder: "ffmpeg",
    transcriber: "whisper",
    whisper: { model: "ggml-tiny.bin", language: "de" },
  });
  const cfg = await loadAudioConfig(root);
  assert.deepEqual(cfg, {
    version: 1,
    recorder: "ffmpeg",
    transcriber: "whisper",
    whisper: { model: "ggml-tiny.bin", language: "de" },
  });
  const text = await fs.readFile(
    path.join(root, ".atelier", "audio.yaml"),
    "utf8"
  );
  assert.match(text, /whisper:/);
  assert.match(text, /model: ggml-tiny\.bin/);
  assert.match(text, /language: de/);
});

test("loadAudioConfig accepts a v1 file with no whisper block (backward compat)", async () => {
  const root = await workspace();
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    "version: 1\nrecorder: ffmpeg\ntranscriber: whisper\n",
    "utf8"
  );
  const cfg = await loadAudioConfig(root);
  assert.equal(cfg.whisper, undefined);
});

test("saveAudioConfig omits the whisper block when nothing is set", async () => {
  const root = await workspace();
  await saveAudioConfig(root, {
    version: 1,
    recorder: "ffmpeg",
    transcriber: "agent",
  });
  const text = await fs.readFile(
    path.join(root, ".atelier", "audio.yaml"),
    "utf8"
  );
  assert.doesNotMatch(text, /^whisper:/m);
});

test("loadAudioConfig rejects whisper.model with a path separator (traversal guard)", async () => {
  const root = await workspace();
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    "version: 1\nrecorder: ffmpeg\ntranscriber: whisper\nwhisper:\n  model: ../escape/ggml.bin\n",
    "utf8"
  );
  await assert.rejects(() => loadAudioConfig(root), /must be a bare filename/);
});

test("loadAudioConfig rejects an empty whisper.language string", async () => {
  const root = await workspace();
  await fs.writeFile(
    path.join(root, ".atelier", "audio.yaml"),
    'version: 1\nrecorder: ffmpeg\ntranscriber: whisper\nwhisper:\n  language: ""\n',
    "utf8"
  );
  await assert.rejects(() => loadAudioConfig(root), /must be a non-empty string/);
});
