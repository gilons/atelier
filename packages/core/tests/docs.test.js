import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addSource,
  addDoc,
  loadDoc,
  listDocs,
  removeDoc,
  updateDoc,
  encodeDocFilenameStem,
  decodeDocFilenameStem,
  hashBody,
  parseDocFile,
  serializeDocFile,
  DocNotFoundError,
  DocAlreadyExistsError,
  DocFileError,
  DocReferenceValidationError,
  validateDocEntryFrontMatter,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-docs-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

// ============================================================
// encodeDocFilenameStem
// ============================================================

test("encodeDocFilenameStem passes safe chars through", () => {
  assert.equal(encodeDocFilenameStem("abc-123_foo.bar"), "abc-123_foo.bar");
});

test("encodeDocFilenameStem percent-encodes slashes, spaces, colons", () => {
  assert.equal(encodeDocFilenameStem("docs/intro page"), "docs%2Fintro%20page");
  assert.equal(encodeDocFilenameStem("notion:abc"), "notion%3Aabc");
});

test("encodeDocFilenameStem handles non-ASCII as UTF-8 bytes", () => {
  // é is U+00E9 → UTF-8 bytes 0xC3 0xA9 → %C3%A9
  assert.equal(encodeDocFilenameStem("café"), "caf%C3%A9");
});

test("encodeDocFilenameStem rejects empty string", () => {
  assert.throws(() => encodeDocFilenameStem(""), /non-empty/);
});

test("encodeDocFilenameStem keeps long ids short with hash suffix", () => {
  const long = "a".repeat(300);
  const encoded = encodeDocFilenameStem(long);
  assert.ok(encoded.length <= 210, `expected ≤210, got ${encoded.length}`);
  assert.match(encoded, /_[0-9a-f]{8}$/);
});

test("encodeDocFilenameStem / decodeDocFilenameStem round-trip for common ids", () => {
  for (const id of ["plain-id", "with space", "path/to/doc", "uuid:abc-123"]) {
    assert.equal(decodeDocFilenameStem(encodeDocFilenameStem(id)), id);
  }
});

// ============================================================
// hashBody
// ============================================================

test("hashBody is deterministic and version-tagged", () => {
  assert.equal(hashBody("hello"), hashBody("hello"));
  assert.notEqual(hashBody("hello"), hashBody("world"));
  assert.match(hashBody("x"), /^sha256:[0-9a-f]{64}$/);
});

// ============================================================
// Parse / serialize round-trip
// ============================================================

test("parseDocFile reads front-matter and body", () => {
  const text = [
    "---",
    "source: notion",
    "docId: page-abc",
    "title: Onboarding PRD",
    "createdAt: 2026-05-16T00:00:00.000Z",
    "updatedAt: 2026-05-16T00:00:00.000Z",
    "---",
    "",
    "# Onboarding PRD",
    "",
    "Body.",
    "",
  ].join("\n");
  const doc = parseDocFile(text, "/x.md");
  assert.equal(doc.source, "notion");
  assert.equal(doc.docId, "page-abc");
  assert.equal(doc.title, "Onboarding PRD");
  assert.match(doc.body, /# Onboarding PRD/);
  assert.match(doc.body, /Body\./);
});

test("parseDocFile rejects missing front-matter", () => {
  assert.throws(
    () => parseDocFile("# Just markdown\n", "/x.md"),
    (err) => err instanceof DocFileError && /front-matter/.test(err.message)
  );
});

test("serializeDocFile + parseDocFile round-trip with full fields", () => {
  const original = {
    source: "notion",
    docId: "page-uuid",
    title: "Reports PRD",
    summary: "Reporting layer",
    classification: "prd",
    url: "https://notion.so/abc",
    lastFetched: "2026-05-16T12:00:00.000Z",
    contentHash: hashBody("body"),
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T12:00:00.000Z",
    body: "# Reports\n\nBody text.\n",
  };
  const text = serializeDocFile(original);
  const round = parseDocFile(text, "/x.md");
  assert.deepEqual(round, original);
});

test("serializeDocFile omits absent optional fields", () => {
  const minimal = {
    source: "notion",
    docId: "x",
    title: "X",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    body: "",
  };
  const text = serializeDocFile(minimal);
  assert.doesNotMatch(text, /summary:/);
  assert.doesNotMatch(text, /classification:/);
  assert.doesNotMatch(text, /url:/);
  assert.doesNotMatch(text, /lastFetched:/);
  assert.doesNotMatch(text, /contentHash:/);
});

// ============================================================
// validateDocEntryFrontMatter
// ============================================================

test("validateDocEntryFrontMatter accepts a minimal valid object", () => {
  const result = validateDocEntryFrontMatter({
    source: "notion",
    docId: "x",
    title: "X",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(result.ok, true);
});

test("validateDocEntryFrontMatter rejects unknown classification", () => {
  const result = validateDocEntryFrontMatter({
    source: "notion",
    docId: "x",
    title: "X",
    classification: "weird",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(result.ok, false);
});

// ============================================================
// addDoc / loadDoc / listDocs / removeDoc / updateDoc
// ============================================================

test("addDoc creates a file under .planning/docs/<source>/", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addSource(workspaceRoot, { kind: "notion", name: "Company Notion" });
    const doc = await addDoc(workspaceRoot, {
      source: "company-notion",
      docId: "page-abc",
      title: "Onboarding PRD",
      classification: "prd",
    });
    assert.equal(doc.source, "company-notion");
    assert.equal(doc.docId, "page-abc");
    const filePath = path.join(
      workspaceRoot,
      ".planning",
      "docs",
      "company-notion",
      "page-abc.md"
    );
    const text = await fs.readFile(filePath, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /source: company-notion/);
    assert.match(text, /classification: prd/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc encodes special chars in docId filenames", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "company-notion",
      docId: "path/to/doc with spaces",
      title: "X",
      skipSourceValidation: true,
    });
    const dir = path.join(workspaceRoot, ".planning", "docs", "company-notion");
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^path%2Fto%2Fdoc%20with%20spaces\.md$/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc refuses to overwrite an existing entry", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "x",
      title: "X",
      skipSourceValidation: true,
    });
    await assert.rejects(
      () =>
        addDoc(workspaceRoot, {
          source: "s",
          docId: "x",
          title: "X again",
          skipSourceValidation: true,
        }),
      (err) => err instanceof DocAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc validates source unless skipSourceValidation set", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => addDoc(workspaceRoot, { source: "ghost", docId: "x", title: "X" }),
      (err) => err instanceof DocReferenceValidationError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc with body records contentHash and lastFetched", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const doc = await addDoc(workspaceRoot, {
      source: "s",
      docId: "x",
      title: "X",
      body: "# Hello\n\nWorld\n",
      fetchedAt: "2026-05-16T10:00:00.000Z",
      skipSourceValidation: true,
    });
    assert.equal(doc.lastFetched, "2026-05-16T10:00:00.000Z");
    assert.equal(doc.contentHash, hashBody("# Hello\n\nWorld\n"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadDoc reads back what addDoc wrote", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "uuid:abc",
      title: "T",
      summary: "S",
      body: "B",
      skipSourceValidation: true,
    });
    const loaded = await loadDoc(workspaceRoot, "s", "uuid:abc");
    assert.equal(loaded.title, "T");
    assert.equal(loaded.summary, "S");
    assert.match(loaded.body, /^B/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadDoc throws on missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => loadDoc(workspaceRoot, "s", "ghost"),
      (err) => err instanceof DocNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listDocs lists across all sources", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "notion",
      docId: "a",
      title: "A",
      skipSourceValidation: true,
    });
    await addDoc(workspaceRoot, {
      source: "confluence",
      docId: "b",
      title: "B",
      skipSourceValidation: true,
    });
    const { docs, errors } = await listDocs(workspaceRoot);
    assert.equal(errors.length, 0);
    assert.equal(docs.length, 2);
    const sources = docs.map((d) => d.doc.source).sort();
    assert.deepEqual(sources, ["confluence", "notion"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listDocs filters by source", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "notion",
      docId: "a",
      title: "A",
      skipSourceValidation: true,
    });
    await addDoc(workspaceRoot, {
      source: "confluence",
      docId: "b",
      title: "B",
      skipSourceValidation: true,
    });
    const { docs } = await listDocs(workspaceRoot, "notion");
    assert.equal(docs.length, 1);
    assert.equal(docs[0].doc.docId, "a");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listDocs collects parse errors without stopping", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "good",
      title: "G",
      skipSourceValidation: true,
    });
    const broken = path.join(workspaceRoot, ".planning", "docs", "s", "broken.md");
    await fs.writeFile(broken, "no front-matter\n", "utf8");
    const { docs, errors } = await listDocs(workspaceRoot);
    assert.equal(docs.length, 1);
    assert.equal(errors.length, 1);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listDocs returns empty when docs dir missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await fs.rm(path.join(workspaceRoot, ".planning", "docs"), {
      recursive: true,
      force: true,
    });
    const { docs, errors } = await listDocs(workspaceRoot);
    assert.equal(docs.length, 0);
    assert.equal(errors.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeDoc deletes the file and returns the entry", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "x",
      title: "X",
      skipSourceValidation: true,
    });
    const removed = await removeDoc(workspaceRoot, "s", "x");
    assert.equal(removed.docId, "x");
    await assert.rejects(
      () => loadDoc(workspaceRoot, "s", "x"),
      (err) => err instanceof DocNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateDoc patches body and refreshes hash + lastFetched", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "x",
      title: "X",
      body: "original",
      fetchedAt: "2026-05-16T00:00:00.000Z",
      skipSourceValidation: true,
    });
    const updated = await updateDoc(workspaceRoot, "s", "x", { body: "new body" });
    assert.equal(updated.body, "new body");
    assert.equal(updated.contentHash, hashBody("new body"));
    assert.notEqual(updated.lastFetched, "2026-05-16T00:00:00.000Z");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateDoc clears summary when passed empty string", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addDoc(workspaceRoot, {
      source: "s",
      docId: "x",
      title: "X",
      summary: "old",
      skipSourceValidation: true,
    });
    const updated = await updateDoc(workspaceRoot, "s", "x", { summary: "" });
    assert.equal(updated.summary, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateDoc throws on missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => updateDoc(workspaceRoot, "s", "ghost", { title: "X" }),
      (err) => err instanceof DocNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
