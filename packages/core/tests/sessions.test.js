import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  registerSource,
  addItem,
  listItems,
  startSession,
  appendToSession,
  endSession,
  loadSession,
  listSessions,
  removeSession,
  deriveSessionId,
  SessionNotFoundError,
  SessionAlreadyExistsError,
} from "../dist/index.js";

/**
 * Tests for the speaking-module session record + the fromSession
 * link from items back to their birth conversation.
 */

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-sessions-test-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

// ============================================================
// id derivation
// ============================================================

test("deriveSessionId slugifies the title + date + random suffix", () => {
  const d = new Date("2026-05-25T12:00:00Z");
  const id = deriveSessionId("Q3 Planning Session", d);
  assert.match(id, /^q3-planning-session-2026-05-25-[0-9a-f]{4}$/);
});

test("deriveSessionId falls back when the title slug is empty", () => {
  const id = deriveSessionId("!@#$", new Date("2026-05-25T12:00:00Z"));
  assert.match(id, /^session-2026-05-25-[0-9a-f]{4}$/);
});

// ============================================================
// startSession
// ============================================================

test("startSession creates the folder + session.yaml + empty transcript.md", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Q3 Planning" });
  assert.equal(s.status, "active");
  assert.match(s.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.transcript, "");

  const yamlPath = path.join(root, ".atelier", "sessions", s.id, "session.yaml");
  const transcriptPath = path.join(
    root,
    ".atelier",
    "sessions",
    s.id,
    "transcript.md"
  );
  const yamlText = await fs.readFile(yamlPath, "utf8");
  assert.match(yamlText, /status: active/);
  assert.match(yamlText, /title: Q3 Planning/);
  const transcript = await fs.readFile(transcriptPath, "utf8");
  assert.equal(transcript, "");
});

test("startSession records participants and explicit id when provided", async () => {
  const root = await workspace();
  const s = await startSession(root, {
    title: "Brainstorm",
    participants: ["alice", "bob"],
    id: "brainstorm-2026",
  });
  assert.equal(s.id, "brainstorm-2026");
  assert.deepEqual(s.participants, ["alice", "bob"]);
});

test("startSession refuses duplicate ids", async () => {
  const root = await workspace();
  await startSession(root, { title: "X", id: "dup" });
  await assert.rejects(
    () => startSession(root, { title: "Y", id: "dup" }),
    SessionAlreadyExistsError
  );
});

// ============================================================
// appendToSession
// ============================================================

test("appendToSession appends chunks to transcript.md with trailing newlines", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Notes" });
  await appendToSession(root, s.id, "alice: hello");
  await appendToSession(root, s.id, "bob: hi there");
  const reloaded = await loadSession(root, s.id);
  assert.equal(reloaded.transcript, "alice: hello\nbob: hi there\n");
});

test("appendToSession preserves an explicit trailing newline (no doubling)", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Notes" });
  await appendToSession(root, s.id, "line one\n");
  await appendToSession(root, s.id, "line two\n");
  const reloaded = await loadSession(root, s.id);
  assert.equal(reloaded.transcript, "line one\nline two\n");
});

test("appendToSession rejects when the session is already ended", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Notes" });
  await endSession(root, s.id);
  await assert.rejects(
    () => appendToSession(root, s.id, "too late"),
    /is ended/
  );
});

// ============================================================
// endSession
// ============================================================

test("endSession sets status=ended + stamps endedAt", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "X" });
  const ended = await endSession(root, s.id);
  assert.equal(ended.status, "ended");
  assert.match(ended.endedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("endSession is idempotent — ending an already-ended session keeps the original endedAt", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "X" });
  const first = await endSession(root, s.id);
  await new Promise((r) => setTimeout(r, 5));
  const second = await endSession(root, s.id);
  assert.equal(second.endedAt, first.endedAt);
});

// ============================================================
// loadSession + listSessions
// ============================================================

test("loadSession returns front-matter + transcript text", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Notes" });
  await appendToSession(root, s.id, "first chunk");
  const reloaded = await loadSession(root, s.id);
  assert.equal(reloaded.title, "Notes");
  assert.equal(reloaded.transcript, "first chunk\n");
});

test("loadSession throws SessionNotFoundError when the folder is missing", async () => {
  const root = await workspace();
  await assert.rejects(
    () => loadSession(root, "ghost"),
    SessionNotFoundError
  );
});

test("listSessions returns sessions sorted by startedAt descending (newest first)", async () => {
  const root = await workspace();
  await startSession(root, { title: "First", id: "first-2026-05-25-aaaa" });
  await new Promise((r) => setTimeout(r, 5));
  await startSession(root, { title: "Second", id: "second-2026-05-25-bbbb" });
  await new Promise((r) => setTimeout(r, 5));
  await startSession(root, { title: "Third", id: "third-2026-05-25-cccc" });
  const { sessions, errors } = await listSessions(root);
  assert.equal(errors.length, 0);
  assert.deepEqual(
    sessions.map((s) => s.session.id),
    [
      "third-2026-05-25-cccc",
      "second-2026-05-25-bbbb",
      "first-2026-05-25-aaaa",
    ]
  );
});

test("listSessions on a workspace with no sessions returns empty arrays (no crash)", async () => {
  const root = await workspace();
  const { sessions, errors } = await listSessions(root);
  assert.deepEqual(sessions, []);
  assert.deepEqual(errors, []);
});

// ============================================================
// removeSession
// ============================================================

test("removeSession deletes the whole folder + returns the removed front-matter", async () => {
  const root = await workspace();
  const s = await startSession(root, { title: "Doomed" });
  await appendToSession(root, s.id, "some notes");
  const removed = await removeSession(root, s.id);
  assert.equal(removed.title, "Doomed");
  await assert.rejects(() =>
    fs.access(path.join(root, ".atelier", "sessions", s.id))
  );
});

test("removeSession on a missing id throws SessionNotFoundError", async () => {
  const root = await workspace();
  await assert.rejects(() => removeSession(root, "ghost"), SessionNotFoundError);
});

// ============================================================
// fromSession item linkage
// ============================================================

test("addItem persists --from-session in the item's front-matter", async () => {
  const root = await workspace();
  await registerSource(root, { id: "notes", name: "Notes" });
  const s = await startSession(root, { title: "Brainstorm" });

  const item = await addItem(root, {
    source: "notes",
    docId: "redesign-idea",
    title: "Redesign idea",
    fromSession: s.id,
    body: "## Overview\n\nNew onboarding flow.\n",
  });
  assert.equal(item.fromSession, s.id);

  // Survives a round-trip through summary.md.
  const summaryPath = path.join(
    root,
    ".atelier",
    "items",
    "notes",
    "redesign-idea",
    "summary.md"
  );
  const text = await fs.readFile(summaryPath, "utf8");
  assert.match(text, new RegExp(`fromSession: ${s.id}`));
});

test("listItems surfaces fromSession so consumers can filter by session", async () => {
  const root = await workspace();
  await registerSource(root, { id: "notes", name: "Notes" });
  const sA = await startSession(root, { title: "Session A", id: "session-a" });
  const sB = await startSession(root, { title: "Session B", id: "session-b" });

  await addItem(root, {
    source: "notes",
    docId: "from-a-one",
    title: "From A 1",
    fromSession: sA.id,
  });
  await addItem(root, {
    source: "notes",
    docId: "from-a-two",
    title: "From A 2",
    fromSession: sA.id,
  });
  await addItem(root, {
    source: "notes",
    docId: "from-b",
    title: "From B",
    fromSession: sB.id,
  });
  await addItem(root, {
    source: "notes",
    docId: "no-session",
    title: "No session",
  });

  const { items } = await listItems(root);
  const fromA = items.filter((d) => d.item.fromSession === sA.id);
  assert.deepEqual(
    fromA.map((d) => d.item.docId).sort(),
    ["from-a-one", "from-a-two"]
  );
  const fromB = items.filter((d) => d.item.fromSession === sB.id);
  assert.equal(fromB.length, 1);
  assert.equal(fromB[0].item.docId, "from-b");
  const orphans = items.filter((d) => d.item.fromSession === undefined);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].item.docId, "no-session");
});

test("removeSession leaves linked items' fromSession references intact (deleted session as provenance)", async () => {
  // The agent or user can scrub orphaned references later if they
  // want — atelier doesn't auto-rewrite items because the deleted
  // session's id may still be useful provenance ("this came out of
  // a 2026-05-25 conversation, even if the transcript's gone").
  const root = await workspace();
  await registerSource(root, { id: "notes", name: "Notes" });
  const s = await startSession(root, { title: "Brainstorm" });
  await addItem(root, {
    source: "notes",
    docId: "linked",
    title: "Linked",
    fromSession: s.id,
  });
  await removeSession(root, s.id);
  const { items } = await listItems(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].item.fromSession, s.id);
});
