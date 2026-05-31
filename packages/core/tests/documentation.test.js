import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addDoc,
  loadDoc,
  listDocs,
  updateDoc,
  renameDoc,
  removeDoc,
  parseDocFile,
  serializeDocFile,
  validateDocFrontMatter,
  DocAlreadyExistsError,
  DocNotFoundError,
  DocReferenceValidationError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-doc-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

test("validateDocFrontMatter requires source/docId/title", () => {
  const r = validateDocFrontMatter({ source: "", docId: "x", title: "T", createdAt: "t", updatedAt: "t" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.source"));
});

test("serialize → parse round-trips incl. owner", () => {
  const now = "2026-05-31T00:00:00.000Z";
  const text = serializeDocFile({
    source: "notion",
    docId: "prd-1",
    title: "Onboarding PRD",
    overview: "Sign-up flow",
    classification: "prd",
    link: "https://notion.so/x",
    owner: "sarah-chen",
    createdAt: now,
    updatedAt: now,
    body: "# PRD\n\nbody\n",
  });
  const doc = parseDocFile(text, "/x.md");
  assert.equal(doc.classification, "prd");
  assert.equal(doc.owner, "sarah-chen");
  assert.match(doc.body, /body/);
});

test("addDoc writes summary.md under documentation/<source>/", async () => {
  const { workspaceRoot } = await workspace();
  const doc = await addDoc(workspaceRoot, {
    source: "notion",
    docId: "prd-1",
    title: "Onboarding PRD",
    classification: "prd",
    owner: "sarah-chen",
    skipSourceValidation: true,
  });
  assert.equal(doc.docId, "prd-1");
  const paths = workspacePaths(workspaceRoot);
  const file = path.join(paths.documentation, "notion", "prd-1", "summary.md");
  assert.match(await fs.readFile(file, "utf8"), /classification: prd/);
});

test("addDoc validates source unless skipped", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(
    () => addDoc(workspaceRoot, { source: "ghost", docId: "d", title: "T" }),
    DocReferenceValidationError
  );
});

test("addDoc rejects duplicates", async () => {
  const { workspaceRoot } = await workspace();
  await addDoc(workspaceRoot, { source: "notion", docId: "d", title: "T", skipSourceValidation: true });
  await assert.rejects(
    () => addDoc(workspaceRoot, { source: "notion", docId: "d", title: "T", skipSourceValidation: true }),
    DocAlreadyExistsError
  );
});

test("listDocs enumerates across sources; loadDoc throws on unknown", async () => {
  const { workspaceRoot } = await workspace();
  await addDoc(workspaceRoot, { source: "notion", docId: "a", title: "A", skipSourceValidation: true });
  await addDoc(workspaceRoot, { source: "gdocs", docId: "b", title: "B", skipSourceValidation: true });
  const { docs } = await listDocs(workspaceRoot);
  assert.equal(docs.length, 2);
  await assert.rejects(() => loadDoc(workspaceRoot, "notion", "ghost"), DocNotFoundError);
});

test("updateDoc patches + clears; renameDoc moves the folder", async () => {
  const { workspaceRoot } = await workspace();
  await addDoc(workspaceRoot, { source: "notion", docId: "a", title: "A", classification: "prd", owner: "x", skipSourceValidation: true });
  const up = await updateDoc(workspaceRoot, "notion", "a", { title: "A2", "clear-owner": undefined, owner: null });
  assert.equal(up.title, "A2");
  assert.equal(up.owner, undefined);
  const renamed = await renameDoc(workspaceRoot, "notion", "a", "a-prd");
  assert.equal(renamed.docId, "a-prd");
  await assert.rejects(() => loadDoc(workspaceRoot, "notion", "a"), DocNotFoundError);
});

test("removeDoc deletes the folder", async () => {
  const { workspaceRoot } = await workspace();
  await addDoc(workspaceRoot, { source: "notion", docId: "a", title: "A", skipSourceValidation: true });
  await removeDoc(workspaceRoot, "notion", "a");
  await assert.rejects(() => loadDoc(workspaceRoot, "notion", "a"), DocNotFoundError);
});

test("initWorkspace creates the documentation folder", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  assert.ok((await fs.stat(paths.documentation)).isDirectory());
});
