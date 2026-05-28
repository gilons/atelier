import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  registerSource,
  addItem,
  loadItem,
  listItems,
  removeItem,
  renameItem,
  updateItem,
  encodeItemFilenameStem,
  decodeItemFilenameStem,
  parseItemFile,
  serializeItemFile,
  ItemNotFoundError,
  ItemAlreadyExistsError,
  ItemFileError,
  ItemReferenceValidationError,
} from "../dist/index.js";

/**
 * Tests for the agent-curated doc map.
 *
 * Each doc is one folder under `.atelier/items/<source>/<encoded-docId>/`
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
// encodeItemFilenameStem
// ============================================================

test("encodeItemFilenameStem keeps safe chars verbatim", () => {
  assert.equal(encodeItemFilenameStem("abc-123_foo.bar"), "abc-123_foo.bar");
});

test("encodeItemFilenameStem percent-encodes slashes, spaces, colons", () => {
  assert.equal(encodeItemFilenameStem("a/b c:d"), "a%2Fb%20c%3Ad");
});

test("encodeItemFilenameStem rejects an empty string", () => {
  assert.throws(() => encodeItemFilenameStem(""));
});

test("encode/decode round-trip for ASCII ids (the common case)", () => {
  // Unicode round-trips via UTF-8 byte-level escapes; the
  // single-character decode helper is sufficient for the
  // common-case ASCII ids docIds tend to be (Notion UUIDs,
  // GitHub owner/repo#N, file paths).
  for (const id of ["a/b", "owner/repo#42", "uuid-with-dashes", "foo bar:baz"]) {
    assert.equal(decodeItemFilenameStem(encodeItemFilenameStem(id)), id);
  }
});

// ============================================================
// parseItemFile / serializeItemFile
// ============================================================

test("serializeItemFile + parseItemFile round-trip the new front-matter shape", () => {
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
  const text = serializeItemFile(doc);
  const parsed = parseItemFile(text, "/tmp/test.md");
  assert.deepEqual(parsed, doc);
});

test("parseItemFile rejects a file with no front-matter", () => {
  assert.throws(
    () => parseItemFile("no front matter here", "/tmp/x.md"),
    ItemFileError
  );
});

// ============================================================
// addItem / loadItem
// ============================================================

test("addItem creates a folder with summary.md under .atelier/items/<source>/", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "notion", name: "Notion" });
    const doc = await addItem(root, {
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
      "items",
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

test("addItem rejects an unknown source unless skipSourceValidation is set", async () => {
  const { umbrella, root } = await workspace();
  try {
    await assert.rejects(
      () =>
        addItem(root, {
          source: "ghost",
          docId: "x",
          title: "x",
        }),
      ItemReferenceValidationError
    );
    // Same call with skipSourceValidation succeeds — used for tests
    // and for synthetic source ids like "manual".
    const doc = await addItem(root, {
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

test("addItem rejects duplicate docIds within the same source", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, { source: "s", docId: "x", title: "X" });
    await assert.rejects(
      () => addItem(root, { source: "s", docId: "x", title: "X again" }),
      ItemAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadItem reads back what addItem wrote", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "one-liner",
      link: "https://example.com",
      body: "body content",
    });
    const doc = await loadItem(root, "s", "x");
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

test("loadItem throws ItemNotFoundError on a missing id", async () => {
  const { umbrella, root } = await workspace();
  try {
    await assert.rejects(() => loadItem(root, "s", "ghost"), ItemNotFoundError);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// listItems
// ============================================================

test("listItems walks every source folder, skipping non-doc subdirectories", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "a", name: "A" });
    await registerSource(root, { id: "b", name: "B" });
    await addItem(root, { source: "a", docId: "one", title: "One" });
    await addItem(root, { source: "a", docId: "two", title: "Two" });
    await addItem(root, { source: "b", docId: "three", title: "Three" });
    // Drop an unrelated folder to make sure we don't crash on it.
    await fs.mkdir(path.join(root, ".atelier", "items", "a", "scratch"), {
      recursive: true,
    });
    const { items, errors } = await listItems(root);
    assert.equal(errors.length, 0);
    assert.equal(items.length, 3);
    const titles = items.map((d) => d.item.title).sort();
    assert.deepEqual(titles, ["One", "Three", "Two"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listItems with a source filter only returns that source's docs", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "a", name: "A" });
    await registerSource(root, { id: "b", name: "B" });
    await addItem(root, { source: "a", docId: "one", title: "One" });
    await addItem(root, { source: "b", docId: "two", title: "Two" });
    const { items } = await listItems(root, "a");
    assert.equal(items.length, 1);
    assert.equal(items[0].item.title, "One");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// updateItem
// ============================================================

test("updateItem patches selected fields + bumps updatedAt", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    const before = await addItem(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "first",
    });
    await new Promise((r) => setTimeout(r, 5));
    const after = await updateItem(root, "s", "x", {
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

test("updateItem clears optional fields when passed empty string / null", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, {
      source: "s",
      docId: "x",
      title: "X",
      overview: "to clear",
      classification: "prd",
      link: "https://to.clear",
    });
    const after = await updateItem(root, "s", "x", {
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
// renameItem
// ============================================================

test("renameItem moves the folder + rewrites front-matter", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "manual", name: "Manual" });
    await addItem(root, {
      source: "manual",
      docId: "untitled-1",
      title: "Cloud Services Contract",
      body: "## Overview\n\nA cloud contract.\n",
    });
    const renamed = await renameItem(
      root,
      "manual",
      "untitled-1",
      "cloud-services-contract"
    );
    assert.equal(renamed.docId, "cloud-services-contract");
    // Folder moved.
    await assert.rejects(() =>
      fs.access(path.join(root, ".atelier", "items", "manual", "untitled-1"))
    );
    const text = await fs.readFile(
      path.join(
        root,
        ".atelier",
        "items",
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

test("renameItem refuses to clobber an existing doc at the target", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, { source: "s", docId: "a", title: "A" });
    await addItem(root, { source: "s", docId: "b", title: "B" });
    await assert.rejects(
      () => renameItem(root, "s", "a", "b"),
      ItemAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("renameItem with the same id is a no-op", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, { source: "s", docId: "x", title: "X" });
    const result = await renameItem(root, "s", "x", "x");
    assert.equal(result.docId, "x");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// removeItem
// ============================================================

test("removeItem nukes the whole folder (summary.md + any sidecars)", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await addItem(root, { source: "s", docId: "x", title: "X" });
    // Drop a sidecar to make sure the folder rm takes it too.
    await fs.writeFile(
      path.join(root, ".atelier", "items", "s", "x", "anchors.json"),
      "[]",
      "utf8"
    );
    await removeItem(root, "s", "x");
    await assert.rejects(() =>
      fs.access(path.join(root, ".atelier", "items", "s", "x"))
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeItem on a missing id throws ItemNotFoundError", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "s", name: "S" });
    await assert.rejects(
      () => removeItem(root, "s", "ghost"),
      ItemNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
