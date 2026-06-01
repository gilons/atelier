import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  registerSource,
  addFeature,
  addDoc,
  addTicket,
  createSpec,
  listSpecs,
  loadSpec,
  updateSpec,
  removeSpec,
  deriveSpecId,
  specTemplate,
  sortSpecsByBuildOrder,
  validateSpecManifest,
  SPEC_CHANGE_TYPES,
  SpecAlreadyExistsError,
  SpecNotFoundError,
  SpecReferenceValidationError,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-specs-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

async function makeRepo(umbrella, name, remote) {
  const dir = path.join(umbrella, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".git", "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8"
  );
  return dir;
}

// ============================================================
// deriveSpecId + templates
// ============================================================

test("deriveSpecId combines date and slug", () => {
  const date = new Date("2026-05-16T12:00:00Z");
  assert.equal(deriveSpecId("CSV Export!", date), "2026-05-16-csv-export");
});

test("deriveSpecId throws when no usable slug", () => {
  assert.throws(() => deriveSpecId("!!!", new Date()));
});

test("specTemplate has a section for each change type", () => {
  for (const t of SPEC_CHANGE_TYPES) {
    const text = specTemplate(t, "Title");
    assert.match(text, /^# Title\n/);
    assert.ok(text.length > 50, `expected non-trivial template for ${t}`);
  }
});

test("createSpec scaffolds plan.md (the HOW) alongside spec.md", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { paths } = await createSpec(workspaceRoot, { title: "Add export", type: "new-feature" });
    const plan = await fs.readFile(paths.plan, "utf8");
    assert.match(plan, /^# Plan — Add export/m);
    assert.match(plan, /## Approach/);
    assert.match(plan, /## Steps/);
    assert.match(plan, /## Test strategy/);
    // README points at plan.md too.
    const readme = await fs.readFile(paths.readme, "utf8");
    assert.match(readme, /plan\.md/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec records dependsOn and it survives a round-trip", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "Invoices",
      type: "new-feature",
      dependsOn: ["2026-01-01-metering"],
    });
    assert.deepEqual(manifest.dependsOn, ["2026-01-01-metering"]);
    const readme = await fs.readFile(paths.readme, "utf8");
    assert.match(readme, /dependsOn:/);
    const loaded = await loadSpec(workspaceRoot, manifest.id);
    assert.deepEqual(loaded.dependsOn, ["2026-01-01-metering"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("sortSpecsByBuildOrder puts dependencies before dependents", () => {
  // c depends on b, b depends on a → order a, b, c regardless of input order.
  const { ordered, cycle } = sortSpecsByBuildOrder([
    { id: "c", dependsOn: ["b"] },
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
  ]);
  assert.deepEqual(ordered.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(cycle.length, 0);
});

test("sortSpecsByBuildOrder reports a cycle without dropping specs", () => {
  const { ordered, cycle } = sortSpecsByBuildOrder([
    { id: "x", dependsOn: ["y"] },
    { id: "y", dependsOn: ["x"] },
  ]);
  assert.equal(ordered.length, 2); // nothing dropped
  assert.ok(cycle.includes("x") || cycle.includes("y"));
});

test("every spec template carries an Open questions section", () => {
  for (const t of SPEC_CHANGE_TYPES) {
    assert.match(specTemplate(t, "Title"), /## Open questions/, `${t} missing Open questions`);
  }
});

test("createSpec records fromTicket provenance + resolves the ticket into context", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await registerSource(workspaceRoot, { id: "linear", name: "Linear" });
    await addTicket(workspaceRoot, {
      source: "linear",
      ticketId: "ENG-42",
      title: "Billing epic",
      overview: "Add metered billing across the product",
      status: "in-progress",
    });
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "Billing — usage metering",
      type: "new-feature",
      fromTicket: "linear:ENG-42",
    });
    assert.equal(manifest.fromTicket, "linear:ENG-42");
    // Survives a round-trip through the README front-matter.
    const readme = await fs.readFile(paths.readme, "utf8");
    assert.match(readme, /fromTicket: linear:ENG-42/);
    // context.md surfaces the originating ticket + its summary.
    const context = await fs.readFile(paths.context, "utf8");
    assert.match(context, /Originating ticket/);
    assert.match(context, /linear:ENG-42/);
    assert.match(context, /Billing epic/);
    assert.match(context, /metered billing/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec tolerates a fromTicket that isn't indexed", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "Orphan ticket spec",
      type: "modification",
      fromTicket: "jira:UNKNOWN-1",
    });
    assert.equal(manifest.fromTicket, "jira:UNKNOWN-1");
    const context = await fs.readFile(paths.context, "utf8");
    assert.match(context, /jira:UNKNOWN-1/);
    assert.match(context, /not indexed/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// validateSpecManifest
// ============================================================

test("validateSpecManifest accepts a minimal manifest", () => {
  const r = validateSpecManifest({
    id: "2026-05-16-x",
    title: "X",
    type: "new-feature",
    status: "drafting",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.features, []);
});

test("validateSpecManifest rejects bad id format", () => {
  const r = validateSpecManifest({
    id: "no-date-here",
    title: "X",
    type: "new-feature",
    status: "drafting",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(r.ok, false);
});

// ============================================================
// createSpec
// ============================================================

test("createSpec scaffolds the issue folder", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const now = new Date("2026-05-16T12:00:00Z");
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "Add CSV export",
      type: "new-feature",
      now,
    });
    assert.equal(manifest.id, "2026-05-16-add-csv-export");
    assert.equal(manifest.type, "new-feature");
    // All four files exist.
    for (const f of [paths.readme, paths.spec, paths.context, paths.prompt]) {
      const stat = await fs.stat(f);
      assert.ok(stat.isFile(), `expected ${f} to exist`);
    }
    const spec = await fs.readFile(paths.spec, "utf8");
    assert.match(spec, /## Goal/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec records fromSession provenance in the manifest + README", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const now = new Date("2026-05-31T12:00:00Z");
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "Add SSO",
      type: "new-feature",
      fromSession: "q3-planning-call-2026-05-31-ab12",
      now,
    });
    assert.equal(manifest.fromSession, "q3-planning-call-2026-05-31-ab12");
    const readme = await fs.readFile(paths.readme, "utf8");
    assert.match(readme, /fromSession: q3-planning-call-2026-05-31-ab12/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec validates feature ids against features/", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () =>
        createSpec(workspaceRoot, {
          title: "X",
          type: "new-feature",
          features: ["ghost"],
        }),
      (err) => err instanceof SpecReferenceValidationError
    );
    await addFeature(workspaceRoot, { name: "Reports" });
    const { manifest } = await createSpec(workspaceRoot, {
      title: "X",
      type: "new-feature",
      features: ["reports"],
    });
    assert.deepEqual(manifest.features, ["reports"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec validates code-ref repos against repos.yaml", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () =>
        createSpec(workspaceRoot, {
          title: "X",
          type: "modification",
          codeRefs: [{ repo: "ghost" }],
        }),
      (err) => err instanceof SpecReferenceValidationError
    );
    await makeRepo(umbrella, "api", "git@github.com:myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    const { manifest } = await createSpec(workspaceRoot, {
      title: "X",
      type: "modification",
      codeRefs: [{ repo: "api", path: "src/" }],
    });
    assert.equal(manifest.codeRefs[0].repo, "api");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec refuses duplicate ids", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const now = new Date("2026-05-16T12:00:00Z");
    await createSpec(workspaceRoot, { title: "x", type: "bug", now });
    await assert.rejects(
      () => createSpec(workspaceRoot, { title: "x", type: "bug", now }),
      (err) => err instanceof SpecAlreadyExistsError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec pulls feature codeRefs into context.md", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await makeRepo(umbrella, "api", "git@github.com:myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    await addFeature(workspaceRoot, {
      name: "Reports",
      codeRefs: [{ repo: "api", path: "src/reports/" }],
    });
    const { paths } = await createSpec(workspaceRoot, {
      title: "Add CSV export",
      type: "new-feature",
      features: ["reports"],
    });
    const context = await fs.readFile(paths.context, "utf8");
    assert.match(context, /### `reports`/);
    assert.match(context, /api:src\/reports\//);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec lists missing doc refs as not yet indexed", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await registerSource(workspaceRoot, { id: "notion", name: "Notion" });
    await addFeature(workspaceRoot, {
      name: "Reports",
      docRefs: [{ source: "notion", docId: "page-abc", title: "Reports PRD" }],
    });
    const { paths } = await createSpec(workspaceRoot, {
      title: "Spec",
      type: "new-feature",
      features: ["reports"],
    });
    const context = await fs.readFile(paths.context, "utf8");
    assert.match(context, /notion:page-abc/);
    assert.match(context, /not yet indexed/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec resolves doc refs that are indexed", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await registerSource(workspaceRoot, { id: "notion", name: "Notion" });
    await addDoc(workspaceRoot, {
      source: "notion",
      docId: "page-abc",
      title: "Reports PRD",
      overview: "Brief about reports",
      classification: "prd",
    });
    const { paths } = await createSpec(workspaceRoot, {
      title: "Spec",
      type: "new-feature",
      docRefs: [{ source: "notion", docId: "page-abc" }],
    });
    const context = await fs.readFile(paths.context, "utf8");
    assert.match(context, /Reports PRD/);
    assert.match(context, /Brief about reports/);
    assert.doesNotMatch(context, /not yet indexed/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("createSpec produces a prompt.md handoff", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { paths } = await createSpec(workspaceRoot, {
      title: "Add CSV export",
      type: "new-feature",
    });
    const prompt = await fs.readFile(paths.prompt, "utf8");
    assert.match(prompt, /Handoff prompt/);
    assert.match(prompt, /Add CSV export/);
    assert.match(prompt, /spec\.md/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// loadSpec, listSpecs, updateSpec, removeSpec
// ============================================================

test("loadSpec reads the manifest back", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { manifest } = await createSpec(workspaceRoot, {
      title: "Sample",
      type: "ui",
    });
    const loaded = await loadSpec(workspaceRoot, manifest.id);
    assert.equal(loaded.title, "Sample");
    assert.equal(loaded.type, "ui");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadSpec throws on missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => loadSpec(workspaceRoot, "ghost"),
      (err) => err instanceof SpecNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listSpecs returns all and is sorted by id", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await createSpec(workspaceRoot, {
      title: "Alpha",
      type: "bug",
      now: new Date("2026-05-10T00:00:00Z"),
    });
    await createSpec(workspaceRoot, {
      title: "Beta",
      type: "bug",
      now: new Date("2026-05-15T00:00:00Z"),
    });
    const { specs } = await listSpecs(workspaceRoot);
    assert.equal(specs.length, 2);
    assert.equal(specs[0].manifest.title, "Alpha");
    assert.equal(specs[1].manifest.title, "Beta");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateSpec changes status and bumps updatedAt", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { manifest } = await createSpec(workspaceRoot, {
      title: "x",
      type: "bug",
    });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateSpec(workspaceRoot, manifest.id, {
      status: "ready",
    });
    assert.equal(updated.status, "ready");
    assert.notEqual(updated.updatedAt, manifest.updatedAt);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeSpec deletes the folder", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const { manifest, paths } = await createSpec(workspaceRoot, {
      title: "x",
      type: "bug",
    });
    await removeSpec(workspaceRoot, manifest.id);
    const exists = await fs
      .access(paths.root)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
