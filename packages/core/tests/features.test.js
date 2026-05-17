import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  addSource,
  addFeature,
  listFeatures,
  loadFeature,
  removeFeature,
  parseFeatureFile,
  serializeFeatureFile,
  deriveFeatureId,
  FeatureNotFoundError,
  FeatureAlreadyExistsError,
  FeatureFileError,
  FeatureReferenceValidationError,
  validateFeatureFrontMatter,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-features-"));
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
// deriveFeatureId
// ============================================================

test("deriveFeatureId slugifies a name", () => {
  assert.equal(deriveFeatureId("CSV Export"), "csv-export");
  assert.equal(deriveFeatureId("User Sign-Up Flow"), "user-sign-up-flow");
  assert.equal(deriveFeatureId("  Mixed  Spaces  "), "mixed-spaces");
});

test("deriveFeatureId strips diacritics and odd punctuation", () => {
  assert.equal(deriveFeatureId("Café Léon's menu!"), "cafe-leon-s-menu");
});

test("deriveFeatureId returns empty when no valid chars", () => {
  assert.equal(deriveFeatureId("!!!"), "");
});

// ============================================================
// parseFeatureFile / serializeFeatureFile (pure)
// ============================================================

test("parseFeatureFile reads front-matter and body", () => {
  const text = [
    "---",
    "id: csv-export",
    "name: CSV Export",
    "status: planned",
    "createdAt: 2026-05-16T12:00:00.000Z",
    "updatedAt: 2026-05-16T12:00:00.000Z",
    "---",
    "",
    "# CSV Export",
    "",
    "Body text here.",
    "",
  ].join("\n");
  const feature = parseFeatureFile(text, "/fake.md");
  assert.equal(feature.id, "csv-export");
  assert.equal(feature.name, "CSV Export");
  assert.equal(feature.status, "planned");
  assert.deepEqual(feature.codeRefs, []);
  assert.deepEqual(feature.docRefs, []);
  assert.match(feature.body, /# CSV Export/);
  assert.match(feature.body, /Body text here\./);
});

test("parseFeatureFile rejects files without front-matter", () => {
  assert.throws(
    () => parseFeatureFile("# Just a header\n\nNo front-matter.", "/fake.md"),
    (err) => err instanceof FeatureFileError && /front-matter/.test(err.message)
  );
});

test("parseFeatureFile reports validation issues with the file path", () => {
  const text = [
    "---",
    "id: Bad Id With Spaces",
    "name: ''",
    "status: weird",
    "---",
    "",
    "body",
  ].join("\n");
  assert.throws(
    () => parseFeatureFile(text, "/fake.md"),
    (err) => err instanceof FeatureFileError && /\$.id/.test(err.message)
  );
});

test("serializeFeatureFile + parseFeatureFile round-trip", () => {
  const original = {
    id: "user-onboarding",
    name: "User Onboarding",
    description: "Sign-up + first-run",
    status: "in-progress",
    codeRefs: [
      { repo: "api", path: "src/auth/" },
      { repo: "web" },
    ],
    docRefs: [{ source: "notion", docId: "abc", title: "Onboarding PRD" }],
    createdAt: "2026-05-16T12:00:00.000Z",
    updatedAt: "2026-05-16T12:30:00.000Z",
    body: "# User Onboarding\n\nNotes go here.\n",
  };
  const text = serializeFeatureFile(original);
  const round = parseFeatureFile(text, "/x.md");
  assert.equal(round.id, original.id);
  assert.equal(round.name, original.name);
  assert.equal(round.description, original.description);
  assert.equal(round.status, original.status);
  assert.deepEqual(round.codeRefs, original.codeRefs);
  assert.deepEqual(round.docRefs, original.docRefs);
  assert.equal(round.createdAt, original.createdAt);
  assert.equal(round.updatedAt, original.updatedAt);
  assert.equal(round.body, original.body);
});

test("serializeFeatureFile omits empty optional sections", () => {
  const minimal = {
    id: "x",
    name: "X",
    status: "planned",
    codeRefs: [],
    docRefs: [],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    body: "body\n",
  };
  const text = serializeFeatureFile(minimal);
  assert.doesNotMatch(text, /codeRefs:/);
  assert.doesNotMatch(text, /docRefs:/);
  assert.doesNotMatch(text, /description:/);
});

// ============================================================
// validateFeatureFrontMatter
// ============================================================

test("validateFeatureFrontMatter accepts a minimal valid object", () => {
  const result = validateFeatureFrontMatter({
    id: "feature-x",
    name: "Feature X",
    status: "planned",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.codeRefs, []);
  assert.deepEqual(result.value.docRefs, []);
});

test("validateFeatureFrontMatter rejects invalid slug ids", () => {
  for (const bad of ["Has Spaces", "UPPER", "trailing-", "with_underscore"]) {
    const result = validateFeatureFrontMatter({
      id: bad,
      name: "X",
      status: "planned",
      createdAt: "t",
      updatedAt: "t",
    });
    assert.equal(result.ok, false, `expected ${bad} to fail`);
  }
});

test("validateFeatureFrontMatter rejects unknown status", () => {
  const result = validateFeatureFrontMatter({
    id: "x",
    name: "X",
    status: "maybe",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(result.ok, false);
});

// ============================================================
// addFeature / loadFeature / listFeatures / removeFeature
// ============================================================

test("addFeature creates a file with a derived id", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const feature = await addFeature(workspaceRoot, { name: "CSV Export" });
    assert.equal(feature.id, "csv-export");
    assert.equal(feature.name, "CSV Export");
    assert.equal(feature.status, "planned");

    const filePath = path.join(workspaceRoot, ".planning", "features", "csv-export.md");
    const text = await fs.readFile(filePath, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /id: csv-export/);
    assert.match(text, /# CSV Export/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addFeature refuses duplicate ids", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addFeature(workspaceRoot, { name: "Search" });
    await assert.rejects(
      () => addFeature(workspaceRoot, { name: "Search" }),
      (err) => err instanceof FeatureAlreadyExistsError && err.id === "search"
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addFeature validates code refs against registered repos", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await makeRepo(umbrella, "api", "git@github.com:myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

    // Unregistered repo should be rejected.
    await assert.rejects(
      () =>
        addFeature(workspaceRoot, {
          name: "Reports",
          codeRefs: [{ repo: "ghost" }],
        }),
      (err) => err instanceof FeatureReferenceValidationError
    );

    // Registered repo should succeed.
    const f = await addFeature(workspaceRoot, {
      name: "Reports",
      codeRefs: [{ repo: "api", path: "src/reports/" }],
    });
    assert.equal(f.codeRefs.length, 1);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addFeature validates doc refs against registered sources", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () =>
        addFeature(workspaceRoot, {
          name: "Reports",
          docRefs: [{ source: "ghost-source", docId: "abc" }],
        }),
      (err) => err instanceof FeatureReferenceValidationError
    );

    await addSource(workspaceRoot, { kind: "notion", name: "Company Notion" });
    const f = await addFeature(workspaceRoot, {
      name: "Reports",
      docRefs: [{ source: "company-notion", docId: "abc", title: "Reports PRD" }],
    });
    assert.equal(f.docRefs.length, 1);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addFeature with skipReferenceValidation allows dangling refs", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    const f = await addFeature(workspaceRoot, {
      name: "Reports",
      codeRefs: [{ repo: "ghost" }],
      skipReferenceValidation: true,
    });
    assert.equal(f.codeRefs[0].repo, "ghost");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadFeature reads back what addFeature wrote", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addFeature(workspaceRoot, {
      name: "Onboarding",
      description: "Sign-up + first-run",
      body: "# Onboarding\n\nDetails.\n",
    });
    const loaded = await loadFeature(workspaceRoot, "onboarding");
    assert.equal(loaded.name, "Onboarding");
    assert.equal(loaded.description, "Sign-up + first-run");
    assert.match(loaded.body, /Details\./);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("loadFeature throws when missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => loadFeature(workspaceRoot, "ghost"),
      (err) => err instanceof FeatureNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listFeatures returns all features sorted by filename", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addFeature(workspaceRoot, { name: "Search" });
    await addFeature(workspaceRoot, { name: "Onboarding" });
    await addFeature(workspaceRoot, { name: "Billing" });
    const { features, errors } = await listFeatures(workspaceRoot);
    assert.equal(errors.length, 0);
    assert.deepEqual(
      features.map((f) => f.feature.id),
      ["billing", "onboarding", "search"]
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listFeatures returns empty list when features dir is missing", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    // Even though initWorkspace creates the dir, simulate its absence.
    await fs.rm(path.join(workspaceRoot, ".planning", "features"), {
      recursive: true,
      force: true,
    });
    const { features, errors } = await listFeatures(workspaceRoot);
    assert.equal(features.length, 0);
    assert.equal(errors.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listFeatures collects parse errors without stopping", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addFeature(workspaceRoot, { name: "Good One" });
    // Hand-write a broken feature file.
    const badPath = path.join(workspaceRoot, ".planning", "features", "broken.md");
    await fs.writeFile(badPath, "# no front-matter here\n", "utf8");
    const { features, errors } = await listFeatures(workspaceRoot);
    assert.equal(features.length, 1);
    assert.equal(features[0].feature.id, "good-one");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].filePath, badPath);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeFeature deletes the file and returns the entry", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addFeature(workspaceRoot, { name: "Search" });
    const removed = await removeFeature(workspaceRoot, "search");
    assert.equal(removed.id, "search");
    await assert.rejects(
      () => loadFeature(workspaceRoot, "search"),
      (err) => err instanceof FeatureNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeFeature throws when feature doesn't exist", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await assert.rejects(
      () => removeFeature(workspaceRoot, "ghost"),
      (err) => err instanceof FeatureNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
