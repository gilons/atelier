import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  startSession,
  endSession,
  listSessionChunks,
  markChunkConsumed,
  appendChunkTranscript,
  loadSession,
} from "../dist/index.js";

/**
 * Tests for the chunked-recording bookkeeping in core/sessions.ts.
 *
 *   - chunkSeconds round-trips through session.yaml
 *   - listSessionChunks walks the chunks/ folder and flags pending vs consumed
 *   - markChunkConsumed appends to consumed.txt and is idempotent
 *   - safety: a chunk name containing a path separator is rejected
 */

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-chunks-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

async function stageChunks(root, sessionId, names, bytesEach = 4096) {
  const dir = path.join(root, ".atelier", "sessions", sessionId, "chunks");
  await fs.mkdir(dir, { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(bytesEach), "utf8");
  }
}

// ============================================================
// chunkSeconds round-trip
// ============================================================

test("startSession persists chunkSeconds in session.yaml", async () => {
  const root = await workspace();
  const s = await startSession(root, {
    title: "Chunked test",
    chunkSeconds: 60,
  });
  const loaded = await loadSession(root, s.id);
  assert.equal(loaded.chunkSeconds, 60);
  const text = await fs.readFile(
    path.join(root, ".atelier", "sessions", s.id, "session.yaml"),
    "utf8"
  );
  assert.match(text, /chunkSeconds: 60/);
});

test("non-chunked sessions don't carry chunkSeconds", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Plain" });
  const loaded = await loadSession(root, s.id);
  assert.equal(loaded.chunkSeconds, undefined);
});

// ============================================================
// listSessionChunks
// ============================================================

test("listSessionChunks returns [] for sessions without a chunks/ folder", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "No chunks" });
  const chunks = await listSessionChunks(root, s.id);
  assert.deepEqual(chunks, []);
});

test("listSessionChunks discovers wavs and flags them pending until consumed", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Chunky", chunkSeconds: 30 });
  await stageChunks(root, s.id, ["0001.wav", "0002.wav", "0003.wav"]);

  let chunks = await listSessionChunks(root, s.id);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.name),
    ["0001.wav", "0002.wav", "0003.wav"]
  );
  assert.ok(chunks.every((c) => c.pending), "all should be pending initially");
  assert.ok(chunks.every((c) => c.bytes === 4096), "byte sizes should be reported");

  await markChunkConsumed(root, s.id, "0001.wav");
  chunks = await listSessionChunks(root, s.id);
  const byName = Object.fromEntries(chunks.map((c) => [c.name, c]));
  assert.equal(byName["0001.wav"].pending, false);
  assert.equal(byName["0002.wav"].pending, true);
  assert.equal(byName["0003.wav"].pending, true);
});

test("listSessionChunks ignores non-audio files (sidecars don't pollute the list)", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Sidecars", chunkSeconds: 30 });
  await stageChunks(root, s.id, ["0001.wav"]);
  // Drop an unrelated sidecar to make sure listing doesn't surface it.
  await fs.writeFile(
    path.join(root, ".atelier", "sessions", s.id, "chunks", "0001.json"),
    "{}",
    "utf8"
  );
  const chunks = await listSessionChunks(root, s.id);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].name, "0001.wav");
});

// ============================================================
// markChunkConsumed
// ============================================================

test("markChunkConsumed is idempotent — re-marking is a no-op", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Idem", chunkSeconds: 30 });
  await stageChunks(root, s.id, ["0001.wav"]);
  await markChunkConsumed(root, s.id, "0001.wav");
  await markChunkConsumed(root, s.id, "0001.wav");
  const consumed = await fs.readFile(
    path.join(root, ".atelier", "sessions", s.id, "consumed.txt"),
    "utf8"
  );
  // Re-marking shouldn't double-write.
  assert.equal(
    consumed.split("\n").filter((l) => l.trim()).length,
    1
  );
});

test("markChunkConsumed rejects path traversal in chunk names", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Safety", chunkSeconds: 30 });
  await assert.rejects(
    () => markChunkConsumed(root, s.id, "../escape.wav"),
    /Invalid chunk name/
  );
  await assert.rejects(
    () => markChunkConsumed(root, s.id, "sub/dir/0001.wav"),
    /Invalid chunk name/
  );
});

test("markChunkConsumed surfaces SessionNotFoundError for unknown ids", async () => {
  const root = await workspace();
  await assert.rejects(
    () => markChunkConsumed(root, "ghost", "0001.wav"),
    /No session with id "ghost"/
  );
});

// ============================================================
// appendChunkTranscript — post-recording draining
// ============================================================

test("appendChunkTranscript writes to transcript.md and marks the chunk consumed", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Drain me", chunkSeconds: 30 });
  await stageChunks(root, s.id, ["0000.wav"]);

  await appendChunkTranscript(root, s.id, "0000.wav", "Hello world.");

  const txt = await fs.readFile(
    path.join(root, ".atelier", "sessions", s.id, "transcript.md"),
    "utf8"
  );
  assert.match(txt, /Hello world\./);
  const consumed = await fs.readFile(
    path.join(root, ".atelier", "sessions", s.id, "consumed.txt"),
    "utf8"
  );
  assert.match(consumed, /^0000\.wav$/m);
});

test("appendChunkTranscript works on ENDED sessions (the chunked-drain use case)", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Post-end drain", chunkSeconds: 30 });
  await stageChunks(root, s.id, ["0000.wav", "0001.wav"]);
  await endSession(root, s.id);

  // appendToSession would reject here. appendChunkTranscript should NOT —
  // chunked workflow expects post-end transcription.
  await appendChunkTranscript(root, s.id, "0000.wav", "transcript of chunk zero");
  await appendChunkTranscript(root, s.id, "0001.wav", "transcript of chunk one");

  const loaded = await loadSession(root, s.id);
  assert.equal(loaded.status, "ended"); // status unchanged
  assert.match(loaded.transcript, /chunk zero/);
  assert.match(loaded.transcript, /chunk one/);
});

test("appendChunkTranscript rejects a chunk name that isn't actually on disk", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Fake-chunk attempt", chunkSeconds: 30 });
  // No chunks staged — claiming "0099.wav" should be rejected so the
  // ended-session bypass can't be abused to drop fake notes.
  await assert.rejects(
    () => appendChunkTranscript(root, s.id, "0099.wav", "fake note"),
    /No chunk named "0099\.wav"/
  );
});

test("appendChunkTranscript rejects chunk names with path traversal", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Safety", chunkSeconds: 30 });
  await assert.rejects(
    () => appendChunkTranscript(root, s.id, "../escape.wav", "x"),
    /Invalid chunk name/
  );
});
