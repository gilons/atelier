import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  registerSource,
  addDoc,
  loadDoc,
  listDocs,
  removeDoc,
  renameDoc,
  updateDoc,
  encodeDocFilenameStem,
  decodeDocFilenameStem,
  parseDocFile,
  serializeDocFile,
  DocNotFoundError,
  DocAlreadyExistsError,
  DocFileError,
  DocReferenceValidationError,
} from "../dist/index.js";

/**
 * Tests for the agent-curated doc map.
 *
 * Each doc is one folder under `.atelier/docs/<source>/<encoded-docId>/`
 * containing a `summary.md` (front-matter + agent-written summary).
 * Atelier stores no body — the agent fetches the underlying document
 * via `link` using its own integrations.
 */

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-docs-test-"));
  const root = path.join(umbrella, "planning");
  await fs.mkdir(root);
  await initWorkspace(root, { name: "Test" });
  return { umbrella, root };
}

// ============================================================
// encodeDocFilenameStem
// ============================================================

test("encodeDocFilenameStem keeps safe chars verbatim", () => {
  assert.equal(encodeDocFilenameStem("abc-123_foo.bar"), "abc-123_foo.bar");
});

test("encodeDocFilenameStem percent-encodes slashes, spaces, colons", () => {
  assert.equal(encodeDocFilenameStem("a/b c:d"), "a%2Fb%20c%3Ad");
});

test("encodeDocFilenameStem rejects an empty string", () => {
  assert.throws(() => encodeDocFilenameStem(""));
});

test("encode/decode round-trip for ASCII ids (the common case)", () => {
  // Unicode round-trips via UTF-8 byte-level escapes; the
  // single-character decode helper is sufficient for the
  // common-case ASCII ids docIds tend to be (Notion UUIDs,
  // GitHub owner/repo#N, file paths).
  for (const id of ["a/b", "owner/repo#42", "uuid-with-dashes", "foo bar:baz"]) {
    assert.equal(decodeDocFilenameStem(encodeDocFilenameStem(id)), id);
  }
});

// ============================================================
// parseDocFile / serializeDocFile
// ============================================================

test("serializeDocFile + parseDocFile round-trip the new front-matter shape", () => {
  const doc = {
    source: "notion",
    docId: "page-abc",
    title: "Q3 Roadmap",
    overview: "Plans for shipping the doc-map MVP.",
    classification: "prd",
    link: "https://notion.so/page-abc",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    body: "# Q3 Roadmap\n\n## Overview\n\nShipping the MVP.\n",
  };
  const text = serializeDocFile(doc);
  const parsed = parseDocFile(text, "/tmp/test.md");
  assert.deepEqual(parsed, doc);
});

test("parseDocFile rejects a file with no front-matter", () => {
  assert.throws(
    () => parseDocFile("no front matter here", "/tmp/x.md"),
    DocFileError
  );
});

// ============================================================
// addDoc / loadDoc
// ============================================================

test("addDoc creates a folder with summary.md under .atelier/docs/<source>/", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "notion", name: "Notion" });
    const doc = await addDoc(root, {
      source: "notion",
      docId: "page-abc",
      title: "Onboarding PRD",
      classification: "prd",
      link: "https://notion.so/page-abc",
      body: "## Overview\n\nNew employee onboarding.\n",
    });
    assert.equal(doc.source, "notion");
    assert.equal(doc.docId, "page-abc");
    const filePath = path.join(
      root,
      ".atelier",
      "docs",
      "notion",
      "page-abc",
      "summary.md"
    );
    const text = await fs.readFile(filePath, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /classification: prd/);
    assert.match(text, /link: https:\/\/notion\.so/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc rejects an unknown source unless skipSourceValidation is set", async () => {
  const { umbrella, root } = await workspace();
  try {
    await assert.rejects(
      () =>
        addDoc(root, {
          source: "ghost",
          docId: "x",
          title: "x",
        }),
      DocReferenceValidationError
    );
    // Same call with skipSourceValidation succeeds — used for tests
    // and for synthetic source ids like "manual".
    const doc = await addDoc(root, {
      source: "manual",
      docId: "x",
      title: "x",
      skipSourceValidation: true,
    });
    assert.equal(doc.source, "manual");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addDoc rejects duplicate docIds within the same source", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, { source: "s", docId: "x", title: "X" });
    await assert.rejects(
      () => addDoc(root, { source: "s", docId: "x", title: "X again" }),
      DocAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadDoc reads back what addDoc wrote", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "one-liner",
      link: "https://example.com",
      body: "body content",
    });
    const doc = await loadDoc(root, "s", "x");
    assert.equal(doc.title, "X");
    assert.equal(doc.overview, "one-liner");
    assert.equal(doc.link, "https://example.com");
    // front-matter serializer always trails the body with a newline
    // for clean diffs — the body matches up to that.
    assert.match(doc.body, /^body content/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadDoc throws DocNotFoundError on a missing id", async () => {
  const { umbrella, root } = await workspace();
  try {
    await assert.rejects(() => loadDoc(root, "s", "ghost"), DocNotFoundError);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// listDocs
// ============================================================

test("listDocs walks every source folder, skipping non-doc subdirectories", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "a", name: "A" });
    await registerSource(root, { id: "b", name: "B" });
    await addDoc(root, { source: "a", docId: "one", title: "One" });
    await addDoc(root, { source: "a", docId: "two", title: "Two" });
    await addDoc(root, { source: "b", docId: "three", title: "Three" });
    // Drop an unrelated folder to make sure we don't crash on it.
    await fs.mkdir(path.join(root, ".atelier", "docs", "a", "scratch"), {
      recursive: true,
    });
    const { docs, errors } = await listDocs(root);
    assert.equal(errors.length, 0);
    assert.equal(docs.length, 3);
    const titles = docs.map((d) => d.doc.title).sort();
    assert.deepEqual(titles, ["One", "Three", "Two"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listDocs with a source filter only returns that source's docs", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "a", name: "A" });
    await registerSource(root, { id: "b", name: "B" });
    await addDoc(root, { source: "a", docId: "one", title: "One" });
    await addDoc(root, { source: "b", docId: "two", title: "Two" });
    const { docs } = await listDocs(root, "a");
    assert.equal(docs.length, 1);
    assert.equal(docs[0].doc.title, "One");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// updateDoc
// ============================================================

test("updateDoc patches selected fields + bumps updatedAt", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    const before = await addDoc(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "first",
    });
    await new Promise((r) => setTimeout(r, 5));
    const after = await updateDoc(root, "s", "x", {
      title: "X v2",
      overview: "second",
      link: "https://new.example.com",
    });
    assert.equal(after.title, "X v2");
    assert.equal(after.overview, "second");
    assert.equal(after.link, "https://new.example.com");
    assert.notEqual(after.updatedAt, before.updatedAt);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateDoc clears optional fields when passed empty string / null", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "to clear",
      classification: "prd",
      link: "https://to.clear",
    });
    const after = await updateDoc(root, "s", "x", {
      overview: "",
      classification: null,
      link: "",
    });
    assert.equal(after.overview, undefined);
    assert.equal(after.classification, undefined);
    assert.equal(after.link, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// renameDoc
// ============================================================

test("renameDoc moves the folder + rewrites front-matter", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "manual", name: "Manual" });
    await addDoc(root, {
      source: "manual",
      docId: "untitled-1",
      title: "Cloud Services Contract",
      body: "## Overview\n\nA cloud contract.\n",
    });
    const renamed = await renameDoc(
      root,
      "manual",
      "untitled-1",
      "cloud-services-contract"
    );
    assert.equal(renamed.docId, "cloud-services-contract");
    // Folder moved.
    await assert.rejects(() =>
      fs.access(path.join(root, ".atelier", "docs", "manual", "untitled-1"))
    );
    const text = await fs.readFile(
      path.join(
        root,
        ".atelier",
        "docs",
        "manual",
        "cloud-services-contract",
        "summary.md"
      ),
      "utf8"
    );
    assert.match(text, /docId: cloud-services-contract/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("renameDoc refuses to clobber an existing doc at the target", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, { source: "s", docId: "a", title: "A" });
    await addDoc(root, { source: "s", docId: "b", title: "B" });
    await assert.rejects(
      () => renameDoc(root, "s", "a", "b"),
      DocAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("renameDoc with the same id is a no-op", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, { source: "s", docId: "x", title: "X" });
    const result = await renameDoc(root, "s", "x", "x");
    assert.equal(result.docId, "x");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// removeDoc
// ============================================================

test("removeDoc nukes the whole folder (summary.md + any sidecars)", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addDoc(root, { source: "s", docId: "x", title: "X" });
    // Drop a sidecar to make sure the folder rm takes it too.
    await fs.writeFile(
      path.join(root, ".atelier", "docs", "s", "x", "anchors.json"),
      "[]",
      "utf8"
    );
    await removeDoc(root, "s", "x");
    await assert.rejects(() =>
      fs.access(path.join(root, ".atelier", "docs", "s", "x"))
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeDoc on a missing id throws DocNotFoundError", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await assert.rejects(
      () => removeDoc(root, "s", "ghost"),
      DocNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
