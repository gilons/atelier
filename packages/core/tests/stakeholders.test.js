import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addStakeholder,
  listStakeholders,
  loadStakeholder,
  removeStakeholder,
  renameStakeholder,
  updateStakeholder,
  addStakeholderOwnership,
  removeStakeholderOwnership,
  setStakeholderHandle,
  appendPrivateNote,
  appendProfileNote,
  readPrivateBody,
  slugifyStakeholderId,
  parseProfileFile,
  serializeProfileFile,
  validateStakeholderFrontMatter,
  StakeholderAlreadyExistsError,
  StakeholderNotFoundError,
  StakeholderFileError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-stakeholders-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

// ============================================================
// slugifyStakeholderId
// ============================================================

test("slugifyStakeholderId slugifies a display name", () => {
  assert.equal(slugifyStakeholderId("Sarah Chen"), "sarah-chen");
  assert.equal(slugifyStakeholderId("  Multi   Space  "), "multi-space");
  assert.equal(slugifyStakeholderId("Café Léon"), "cafe-leon");
});

test("slugifyStakeholderId returns empty when nothing survives", () => {
  assert.equal(slugifyStakeholderId("!!!"), "");
});

// ============================================================
// validation
// ============================================================

test("validateStakeholderFrontMatter rejects bad slug ids", () => {
  const result = validateStakeholderFrontMatter({
    id: "Bad ID",
    name: "Sarah",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "$.id"));
});

test("validateStakeholderFrontMatter accepts the minimum set", () => {
  const result = validateStakeholderFrontMatter({
    id: "sarah-chen",
    name: "Sarah Chen",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.id, "sarah-chen");
});

test("validateStakeholderFrontMatter rejects non-string handle values", () => {
  const result = validateStakeholderFrontMatter({
    id: "x",
    name: "X",
    handles: { slack: 123 },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "$.handles.slack"));
});

// ============================================================
// parse / serialize round-trip
// ============================================================

test("serialize → parse round-trips the front-matter", () => {
  const now = "2026-05-28T00:00:00.000Z";
  const s = {
    id: "sarah-chen",
    name: "Sarah Chen",
    role: "PM",
    organization: "Acme",
    email: "sarah@acme.example",
    handles: { slack: "@sarah", github: "schen" },
    ownerships: ["checkout", "notion:abc-123"],
    summary: "Owns payments squad.",
    fromSessions: ["s_2026_05_28_kickoff"],
    createdAt: now,
    updatedAt: now,
    profileBody: "# Sarah\n\nLeads payments.\n",
  };
  const text = serializeProfileFile(s);
  const { frontMatter, body } = parseProfileFile(text, "/x.md");
  assert.equal(frontMatter.id, "sarah-chen");
  assert.equal(frontMatter.role, "PM");
  assert.deepEqual(frontMatter.handles, { slack: "@sarah", github: "schen" });
  assert.deepEqual(frontMatter.ownerships, ["checkout", "notion:abc-123"]);
  assert.deepEqual(frontMatter.fromSessions, ["s_2026_05_28_kickoff"]);
  assert.match(body, /Leads payments/);
});

test("parseProfileFile rejects files without front-matter", () => {
  assert.throws(
    () => parseProfileFile("no frontmatter\n", "/x.md"),
    StakeholderFileError
  );
});

// ============================================================
// CRUD
// ============================================================

test("addStakeholder writes profile.md with derived slug id", async () => {
  const { workspaceRoot } = await workspace();
  const s = await addStakeholder(workspaceRoot, { name: "Sarah Chen", role: "PM" });
  assert.equal(s.id, "sarah-chen");
  const paths = workspacePaths(workspaceRoot);
  const profile = path.join(paths.stakeholders, "sarah-chen", "profile.md");
  const text = await fs.readFile(profile, "utf8");
  assert.match(text, /name: Sarah Chen/);
  assert.match(text, /role: PM/);
});

test("addStakeholder rejects a duplicate id", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah Chen" });
  await assert.rejects(
    () => addStakeholder(workspaceRoot, { name: "Sarah Chen" }),
    StakeholderAlreadyExistsError
  );
});

test("addStakeholder honors explicit --id", async () => {
  const { workspaceRoot } = await workspace();
  const s = await addStakeholder(workspaceRoot, { id: "schen", name: "Sarah Chen" });
  assert.equal(s.id, "schen");
});

test("addStakeholder writes private.md when privateBody is supplied", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Sarah",
    privateBody: "She prefers async updates.\n",
  });
  const priv = await readPrivateBody(workspaceRoot, "sarah");
  assert.match(priv, /async updates/);
});

test("loadStakeholder defaults to NOT including private.md", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Sarah",
    privateBody: "secret notes\n",
  });
  const s = await loadStakeholder(workspaceRoot, "sarah");
  assert.equal(s.privateBody, undefined);
});

test("loadStakeholder includes private.md when asked", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Sarah",
    privateBody: "secret notes\n",
  });
  const s = await loadStakeholder(workspaceRoot, "sarah", { includePrivate: true });
  assert.match(s.privateBody, /secret notes/);
});

test("loadStakeholder throws on unknown id", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(
    () => loadStakeholder(workspaceRoot, "ghost"),
    StakeholderNotFoundError
  );
});

test("listStakeholders enumerates each folder + flags private layer", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Alice" });
  await addStakeholder(workspaceRoot, {
    name: "Bob",
    privateBody: "private notes\n",
  });
  const { stakeholders, errors } = await listStakeholders(workspaceRoot);
  assert.equal(errors.length, 0);
  assert.equal(stakeholders.length, 2);
  const byId = Object.fromEntries(stakeholders.map((s) => [s.stakeholder.id, s]));
  assert.equal(byId["alice"].hasPrivate, false);
  assert.equal(byId["bob"].hasPrivate, true);
  // includePrivate=false by default → privateBody not attached even when hasPrivate
  assert.equal(byId["bob"].stakeholder.privateBody, undefined);
});

test("listStakeholders attaches private body when includePrivate=true", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Bob",
    privateBody: "private notes\n",
  });
  const { stakeholders } = await listStakeholders(workspaceRoot, { includePrivate: true });
  assert.match(stakeholders[0].stakeholder.privateBody, /private notes/);
});

test("updateStakeholder patches fields + bumps updatedAt", async () => {
  const { workspaceRoot } = await workspace();
  const a = await addStakeholder(workspaceRoot, { name: "Sarah", role: "PM" });
  // Ensure updatedAt actually changes — wait a tick.
  await new Promise((r) => setTimeout(r, 5));
  const b = await updateStakeholder(workspaceRoot, "sarah", {
    role: "Director",
    organization: "Acme",
  });
  assert.equal(b.role, "Director");
  assert.equal(b.organization, "Acme");
  assert.notEqual(b.updatedAt, a.updatedAt);
});

test("updateStakeholder can clear optional fields", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah", role: "PM", email: "s@x.com" });
  const b = await updateStakeholder(workspaceRoot, "sarah", {
    role: null,
    email: null,
  });
  assert.equal(b.role, undefined);
  assert.equal(b.email, undefined);
});

test("setStakeholderHandle adds and clears one entry at a time", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah" });
  let s = await setStakeholderHandle(workspaceRoot, "sarah", "slack", "@sarah");
  assert.deepEqual(s.handles, { slack: "@sarah" });
  s = await setStakeholderHandle(workspaceRoot, "sarah", "github", "schen");
  assert.deepEqual(s.handles, { slack: "@sarah", github: "schen" });
  s = await setStakeholderHandle(workspaceRoot, "sarah", "slack", null);
  assert.deepEqual(s.handles, { github: "schen" });
});

test("addStakeholderOwnership dedupes", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah" });
  await addStakeholderOwnership(workspaceRoot, "sarah", "checkout");
  await addStakeholderOwnership(workspaceRoot, "sarah", "checkout");
  const s = await addStakeholderOwnership(workspaceRoot, "sarah", "billing");
  assert.deepEqual(s.ownerships.sort(), ["billing", "checkout"]);
});

test("removeStakeholderOwnership drops the matching entry", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Sarah",
    ownerships: ["a", "b", "c"],
  });
  const s = await removeStakeholderOwnership(workspaceRoot, "sarah", "b");
  assert.deepEqual(s.ownerships, ["a", "c"]);
});

test("appendPrivateNote creates private.md when absent", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah" });
  await appendPrivateNote(workspaceRoot, "sarah", "Prefers async updates.");
  const body = await readPrivateBody(workspaceRoot, "sarah");
  assert.match(body, /Prefers async updates\./);
});

test("appendPrivateNote refuses to write for an unknown stakeholder", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(
    () => appendPrivateNote(workspaceRoot, "ghost", "x"),
    StakeholderNotFoundError
  );
});

test("appendPrivateNote appends — second call doesn't overwrite first", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah" });
  await appendPrivateNote(workspaceRoot, "sarah", "first note");
  await appendPrivateNote(workspaceRoot, "sarah", "second note");
  const body = await readPrivateBody(workspaceRoot, "sarah");
  assert.match(body, /first note/);
  assert.match(body, /second note/);
});

test("appendProfileNote appends to the shared profile body", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah" });
  await appendProfileNote(workspaceRoot, "sarah", "Leads payments squad.");
  const s = await loadStakeholder(workspaceRoot, "sarah");
  assert.match(s.profileBody, /Leads payments squad/);
});

test("removeStakeholder deletes the entire folder (including private.md)", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, {
    name: "Sarah",
    privateBody: "secret\n",
  });
  await removeStakeholder(workspaceRoot, "sarah");
  await assert.rejects(
    () => loadStakeholder(workspaceRoot, "sarah"),
    StakeholderNotFoundError
  );
  // Folder is gone, including private.md.
  const paths = workspacePaths(workspaceRoot);
  await assert.rejects(
    () => fs.access(path.join(paths.stakeholders, "sarah")),
    /ENOENT/
  );
});

test("renameStakeholder moves the folder and updates the id", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Sarah", role: "PM" });
  await appendPrivateNote(workspaceRoot, "sarah", "personal note");
  const renamed = await renameStakeholder(workspaceRoot, "sarah", "sarah-c");
  assert.equal(renamed.id, "sarah-c");
  // Private notes follow the rename (we move the folder, not just the profile).
  const priv = await readPrivateBody(workspaceRoot, "sarah-c");
  assert.match(priv, /personal note/);
});

test("renameStakeholder refuses to overwrite an existing id", async () => {
  const { workspaceRoot } = await workspace();
  await addStakeholder(workspaceRoot, { name: "Alice" });
  await addStakeholder(workspaceRoot, { name: "Bob" });
  await assert.rejects(
    () => renameStakeholder(workspaceRoot, "alice", "bob"),
    StakeholderAlreadyExistsError
  );
});

// ============================================================
// Workspace integration
// ============================================================

test("initWorkspace creates the stakeholders folder", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  const stat = await fs.stat(paths.stakeholders);
  assert.ok(stat.isDirectory());
});

test("initWorkspace adds the private.md gitignore line", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  const gi = await fs.readFile(path.join(paths.atelier, ".gitignore"), "utf8");
  assert.match(gi, /stakeholders\/\*\*\/private\.md/);
});
