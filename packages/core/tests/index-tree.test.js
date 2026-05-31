import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addFeature,
  addStakeholder,
  installAgent,
  validateFolderIndex,
  readFolderIndex,
  writeFolderIndex,
  buildWorkspaceMap,
  refreshWorkspaceIndex,
  WORKSPACE_SECTIONS,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-index-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Acme Planning" });
  return { umbrella, workspaceRoot };
}

function findChild(node, name) {
  return (node.children ?? []).find((c) => c.name === name);
}

// ============================================================
// validation
// ============================================================

test("validateFolderIndex accepts a minimal index", () => {
  const r = validateFolderIndex({ name: "Agents", kind: "section" });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "Agents");
});

test("validateFolderIndex rejects missing name/kind", () => {
  const r = validateFolderIndex({ description: "x" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.name"));
  assert.ok(r.issues.some((i) => i.path === "$.kind"));
});

test("validateFolderIndex rejects malformed children", () => {
  const r = validateFolderIndex({
    name: "X",
    kind: "section",
    children: [{ title: "no path" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.children[0].path"));
});

// ============================================================
// write / read round-trip
// ============================================================

test("writeFolderIndex → readFolderIndex round-trips", async () => {
  const { workspaceRoot } = await workspace();
  const dir = path.join(workspaceRoot, ".atelier", "agents", "demo");
  await writeFolderIndex(dir, {
    name: "Demo",
    kind: "agent",
    description: "A demo agent.",
    children: [
      { path: "instructions.md", title: "Playbook", kind: "instructions", description: "How it works" },
    ],
  });
  const idx = await readFolderIndex(dir);
  assert.equal(idx.name, "Demo");
  assert.equal(idx.kind, "agent");
  assert.equal(idx.children.length, 1);
  assert.equal(idx.children[0].path, "instructions.md");
  assert.equal(idx.children[0].kind, "instructions");
});

test("readFolderIndex returns null when absent", async () => {
  const { workspaceRoot } = await workspace();
  const idx = await readFolderIndex(path.join(workspaceRoot, ".atelier", "nope"));
  assert.equal(idx, null);
});

// ============================================================
// buildWorkspaceMap — derivation
// ============================================================

test("buildWorkspaceMap derives the section tree on a fresh workspace", async () => {
  const { workspaceRoot } = await workspace();
  const root = await buildWorkspaceMap(workspaceRoot);
  assert.equal(root.kind, "workspace");
  assert.equal(root.name, "Acme Planning");
  // Every known section + sources + repos appears.
  for (const sec of WORKSPACE_SECTIONS) {
    assert.ok(findChild(root, sec.name), `missing section ${sec.name}`);
  }
  assert.ok(findChild(root, "Sources"));
  assert.ok(findChild(root, "Repos"));
});

test("buildWorkspaceMap surfaces content entries with descriptions", async () => {
  const { workspaceRoot } = await workspace();
  await addFeature(workspaceRoot, { name: "CSV Export", status: "planned" });
  await addStakeholder(workspaceRoot, { name: "Sarah Chen", role: "PM", organization: "Acme" });

  const root = await buildWorkspaceMap(workspaceRoot, { depth: 2 });
  const features = findChild(root, "Features");
  assert.ok(findChild(features, "CSV Export"));
  const stakeholders = findChild(root, "Stakeholders");
  const sarah = findChild(stakeholders, "Sarah Chen");
  assert.ok(sarah);
  assert.match(sarah.description, /PM/);
});

test("buildWorkspaceMap respects depth (depth 1 shows sections, not entries)", async () => {
  const { workspaceRoot } = await workspace();
  await addFeature(workspaceRoot, { name: "CSV Export", status: "planned" });
  const root = await buildWorkspaceMap(workspaceRoot, { depth: 1 });
  const features = findChild(root, "Features");
  assert.ok(features);
  // depth 1 → section node present but its entries not expanded
  assert.equal(features.children, undefined);
});

test("buildWorkspaceMap can start at a sub-path and recurse into an agent", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  const node = await buildWorkspaceMap(workspaceRoot, { path: "agents/discovery", depth: 1 });
  assert.equal(node.kind, "agent");
  assert.equal(node.name, "Discovery");
  assert.ok(findChild(node, "Playbook"));
});

// ============================================================
// refreshWorkspaceIndex — materialize sidecars
// ============================================================

test("refreshWorkspaceIndex writes root + section + agent index.yaml", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  await addFeature(workspaceRoot, { name: "CSV Export", status: "planned" });

  const { written } = await refreshWorkspaceIndex(workspaceRoot);
  const paths = workspacePaths(workspaceRoot);

  const rootIdx = path.join(paths.atelier, "index.yaml");
  const agentsIdx = path.join(paths.atelier, "agents", "index.yaml");
  const discoveryIdx = path.join(paths.atelier, "agents", "discovery", "index.yaml");
  for (const f of [rootIdx, agentsIdx, discoveryIdx]) {
    assert.ok(written.includes(f), `expected ${f} in written list`);
    await fs.access(f); // exists on disk
  }

  // After refresh, the map reads the sidecar (hasIndex true).
  const root = await buildWorkspaceMap(workspaceRoot, { depth: 1 });
  assert.equal(root.hasIndex, true);
});

test("buildWorkspaceMap stays fresh after a mutation without --rebuild", async () => {
  const { workspaceRoot } = await workspace();
  // Materialize a snapshot, THEN add content. The sidecar is now stale.
  await refreshWorkspaceIndex(workspaceRoot);
  await addFeature(workspaceRoot, { name: "Late Feature", status: "planned" });

  // Live derivation must surface the new feature even though the
  // on-disk root/section index.yaml predates it.
  const root = await buildWorkspaceMap(workspaceRoot, { depth: 2 });
  const features = findChild(root, "Features");
  assert.ok(findChild(features, "Late Feature"), "map went stale after a write");
});

test("refreshWorkspaceIndex is idempotent", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  const a = await refreshWorkspaceIndex(workspaceRoot);
  const b = await refreshWorkspaceIndex(workspaceRoot);
  assert.deepEqual(a.written.sort(), b.written.sort());
});

test("a materialized agent index lists its playbook + learnings (recursion)", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  await refreshWorkspaceIndex(workspaceRoot);
  const dir = path.join(workspaceRoot, ".atelier", "agents", "discovery");
  const idx = await readFolderIndex(dir);
  assert.equal(idx.kind, "agent");
  const titles = idx.children.map((c) => c.title);
  assert.ok(titles.includes("Playbook"));
  assert.ok(titles.includes("Learnings"));
});
