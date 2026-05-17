import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addDiscrepancy,
  listDiscrepancies,
  loadDiscrepancy,
  updateDiscrepancy,
  removeDiscrepancy,
  loadDiscrepancyLog,
  deriveDiscrepancyId,
  DiscrepancyNotFoundError,
  DiscrepancyAlreadyExistsError,
  validateDiscrepancyLog,
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_STATUSES,
} from "../dist/index.js";

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-discrepancies-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

// ============================================================
// deriveDiscrepancyId
// ============================================================

test("deriveDiscrepancyId slugifies a phrase", () => {
  assert.equal(deriveDiscrepancyId("Auth Token Expiry Mismatch"), "auth-token-expiry-mismatch");
  assert.equal(deriveDiscrepancyId("CSV Export!!"), "csv-export");
});

// ============================================================
// validateDiscrepancyLog
// ============================================================

test("validateDiscrepancyLog accepts empty log", () => {
  const result = validateDiscrepancyLog({ version: 1, discrepancies: [] });
  assert.equal(result.ok, true);
});

test("validateDiscrepancyLog rejects bad severity", () => {
  const result = validateDiscrepancyLog({
    version: 1,
    discrepancies: [
      {
        id: "x",
        claim: "c",
        observed: "o",
        severity: "extreme",
        status: "open",
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  });
  assert.equal(result.ok, false);
});

test("validateDiscrepancyLog rejects duplicate ids", () => {
  const entry = {
    id: "dup",
    claim: "c",
    observed: "o",
    severity: "low",
    status: "open",
    createdAt: "t",
    updatedAt: "t",
  };
  const result = validateDiscrepancyLog({
    version: 1,
    discrepancies: [entry, { ...entry }],
  });
  assert.equal(result.ok, false);
});

// ============================================================
// addDiscrepancy
// ============================================================

test("addDiscrepancy derives id from claim/feature", async () => {
  const root = await workspace();
  try {
    const entry = await addDiscrepancy(root, {
      feature: "Auth Flow",
      claim: "Tokens expire after 24h",
      observed: "Tokens expire after 1h",
    });
    assert.equal(entry.id, "auth-flow");
    assert.equal(entry.feature, "Auth Flow");
    assert.equal(entry.severity, "medium");
    assert.equal(entry.status, "open");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addDiscrepancy de-duplicates auto-derived ids with -2, -3", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { claim: "X claim", observed: "Y" });
    const second = await addDiscrepancy(root, { claim: "X claim", observed: "Z" });
    assert.equal(second.id, "x-claim-2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addDiscrepancy refuses duplicate explicit ids", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "foo", claim: "C", observed: "O" });
    await assert.rejects(
      () => addDiscrepancy(root, { id: "foo", claim: "C2", observed: "O2" }),
      (err) => err instanceof DiscrepancyAlreadyExistsError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addDiscrepancy persists docRef and codeRef", async () => {
  const root = await workspace();
  try {
    const entry = await addDiscrepancy(root, {
      id: "x",
      claim: "C",
      observed: "O",
      severity: "high",
      docRef: { source: "notion", docId: "page-123" },
      codeRef: { repo: "api", path: "src/auth/" },
    });
    assert.deepEqual(entry.docRef, { source: "notion", docId: "page-123" });
    assert.deepEqual(entry.codeRef, { repo: "api", path: "src/auth/" });
    // Round-trip through load.
    const log = await loadDiscrepancyLog(root);
    assert.deepEqual(log.discrepancies[0].docRef, { source: "notion", docId: "page-123" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ============================================================
// listDiscrepancies
// ============================================================

test("listDiscrepancies orders by severity then createdAt", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "a", claim: "c", observed: "o", severity: "low" });
    await addDiscrepancy(root, { id: "b", claim: "c", observed: "o", severity: "critical" });
    await addDiscrepancy(root, { id: "c", claim: "c", observed: "o", severity: "medium" });
    const entries = await listDiscrepancies(root);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["b", "c", "a"]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listDiscrepancies filters by status", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "a", claim: "c", observed: "o" });
    await addDiscrepancy(root, {
      id: "b",
      claim: "c",
      observed: "o",
      status: "resolved",
    });
    const open = await listDiscrepancies(root, { status: "open" });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, "a");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listDiscrepancies filters by feature", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "a", feature: "auth", claim: "c", observed: "o" });
    await addDiscrepancy(root, {
      id: "b",
      feature: "billing",
      claim: "c",
      observed: "o",
    });
    const auth = await listDiscrepancies(root, { feature: "auth" });
    assert.equal(auth.length, 1);
    assert.equal(auth[0].id, "a");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ============================================================
// loadDiscrepancy / updateDiscrepancy / removeDiscrepancy
// ============================================================

test("loadDiscrepancy throws on missing", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      () => loadDiscrepancy(root, "ghost"),
      (err) => err instanceof DiscrepancyNotFoundError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("updateDiscrepancy changes status and bumps updatedAt", async () => {
  const root = await workspace();
  try {
    const entry = await addDiscrepancy(root, { id: "x", claim: "c", observed: "o" });
    const originalUpdated = entry.updatedAt;
    // Force a small delay so the timestamp differs.
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateDiscrepancy(root, "x", { status: "resolved" });
    assert.equal(updated.status, "resolved");
    assert.notEqual(updated.updatedAt, originalUpdated);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("updateDiscrepancy appends notes with separating newline", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "x", claim: "c", observed: "o", notes: "first" });
    const updated = await updateDiscrepancy(root, "x", { appendNotes: "second" });
    assert.equal(updated.notes, "first\nsecond");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("updateDiscrepancy appendNotes on empty starts cleanly", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "x", claim: "c", observed: "o" });
    const updated = await updateDiscrepancy(root, "x", { appendNotes: "hello" });
    assert.equal(updated.notes, "hello");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeDiscrepancy deletes entry and returns it", async () => {
  const root = await workspace();
  try {
    await addDiscrepancy(root, { id: "x", claim: "c", observed: "o" });
    const removed = await removeDiscrepancy(root, "x");
    assert.equal(removed.id, "x");
    await assert.rejects(
      () => loadDiscrepancy(root, "x"),
      (err) => err instanceof DiscrepancyNotFoundError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DISCREPANCY_SEVERITIES and DISCREPANCY_STATUSES are non-empty arrays", () => {
  assert.ok(DISCREPANCY_SEVERITIES.length >= 4);
  assert.ok(DISCREPANCY_STATUSES.length >= 4);
});
