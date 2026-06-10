import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-scope-cli-"));
  assert.equal(runCli(["init", "--name", "WS"], root).status, 0);
  assert.equal(runCli(["project", "add", "Acme", "--id", "acme"], root).status, 0);
  assert.equal(runCli(["project", "add", "Beta", "--id", "beta"], root).status, 0);
  return root;
}

test("feature new defaults to the active project; list scopes to it", async () => {
  const root = await setup();
  try {
    // Pin acme; a new feature should default into it.
    assert.equal(runCli(["project", "use", "acme"], root).status, 0);
    assert.equal(
      runCli(["feature", "add", "Acme Thing", "--id", "acme-thing", "--no-validate-refs"], root).status,
      0
    );
    // A global feature via --project global.
    assert.equal(
      runCli(["feature", "add", "Shared Thing", "--id", "shared-thing", "--project", "global", "--no-validate-refs"], root).status,
      0
    );
    // A beta feature via explicit override.
    assert.equal(
      runCli(["feature", "add", "Beta Thing", "--id", "beta-thing", "--project", "beta", "--no-validate-refs"], root).status,
      0
    );

    // Active scope (acme): shows acme + global, not beta.
    const scoped = runCli(["feature", "list"], root);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /acme-thing/);
    assert.match(scoped.stdout, /shared-thing/);
    assert.doesNotMatch(scoped.stdout, /beta-thing/);
    assert.match(scoped.stdout, /Project scope:/);

    // All scope.
    const all = runCli(["feature", "list", "--project", "all"], root);
    assert.match(all.stdout, /acme-thing/);
    assert.match(all.stdout, /beta-thing/);
    assert.match(all.stdout, /shared-thing/);

    // Beta scope: beta + global, not acme.
    const beta = runCli(["feature", "list", "--project", "beta"], root);
    assert.match(beta.stdout, /beta-thing/);
    assert.match(beta.stdout, /shared-thing/);
    assert.doesNotMatch(beta.stdout, /acme-thing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("feature new --project with an unknown id errors", async () => {
  const root = await setup();
  try {
    const r = runCli(["feature", "add", "X", "--id", "x", "--project", "ghost", "--no-validate-refs"], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /No project with id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source list scopes to active project; docs inherit source project", async () => {
  const root = await setup();
  try {
    assert.equal(runCli(["project", "use", "acme"], root).status, 0);
    // Active pin -> source defaults into acme.
    assert.equal(runCli(["source", "register", "acme-src", "--name", "Acme Source"], root).status, 0);
    // Global source.
    assert.equal(
      runCli(["source", "register", "glob-src", "--name", "Global Source", "--project", "global"], root).status,
      0
    );
    // Beta source.
    assert.equal(
      runCli(["source", "register", "beta-src", "--name", "Beta Source", "--project", "beta"], root).status,
      0
    );

    // acme scope: acme-src + glob-src, not beta-src.
    const acme = runCli(["source", "list"], root);
    assert.match(acme.stdout, /acme-src/);
    assert.match(acme.stdout, /glob-src/);
    assert.doesNotMatch(acme.stdout, /beta-src/);

    // Docs inherit project from their source.
    assert.equal(runCli(["doc", "add", "acme-src:d1", "--title", "Acme Doc"], root).status, 0);
    assert.equal(runCli(["doc", "add", "beta-src:d2", "--title", "Beta Doc"], root).status, 0);
    const docs = runCli(["doc", "list"], root); // acme scope
    assert.match(docs.stdout, /acme-src:d1/);
    assert.doesNotMatch(docs.stdout, /beta-src:d2/);
    const allDocs = runCli(["doc", "list", "--project", "all"], root);
    assert.match(allDocs.stdout, /beta-src:d2/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stakeholder add defaults to active project; --project global stays global", async () => {
  const root = await setup();
  try {
    assert.equal(runCli(["project", "use", "acme"], root).status, 0);
    assert.equal(runCli(["stakeholder", "add", "Acme PM", "--id", "acme-pm"], root).status, 0);
    assert.equal(
      runCli(["stakeholder", "add", "Internal Eng", "--id", "internal-eng", "--project", "global"], root).status,
      0
    );
    assert.equal(
      runCli(["stakeholder", "add", "Beta PM", "--id", "beta-pm", "--project", "beta"], root).status,
      0
    );
    // acme scope: acme PM + global internal eng, not beta.
    const acme = runCli(["stakeholder", "list"], root);
    assert.match(acme.stdout, /acme-pm/);
    assert.match(acme.stdout, /internal-eng/);
    assert.doesNotMatch(acme.stdout, /beta-pm/);
    // all scope.
    const all = runCli(["stakeholder", "list", "--project", "all"], root);
    assert.match(all.stdout, /beta-pm/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ticket --project override scopes a shared source's entry", async () => {
  const root = await setup();
  try {
    // A shared (global) source.
    assert.equal(runCli(["source", "register", "jira", "--name", "Jira", "--project", "global"], root).status, 0);
    // One ticket overridden to acme, one inheriting (global).
    assert.equal(runCli(["ticket", "add", "jira:ACME-1", "--title", "Acme ticket", "--project", "acme"], root).status, 0);
    assert.equal(runCli(["ticket", "add", "jira:GEN-1", "--title", "General ticket"], root).status, 0);

    // acme scope: both (the override + the global one).
    const acme = runCli(["ticket", "list", "--project", "acme"], root);
    assert.match(acme.stdout, /ACME-1/);
    assert.match(acme.stdout, /GEN-1/);
    // beta scope: only the global one, the acme override is excluded.
    const beta = runCli(["ticket", "list", "--project", "beta"], root);
    assert.doesNotMatch(beta.stdout, /ACME-1/);
    assert.match(beta.stdout, /GEN-1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("in-place reassign: feature update --project moves it, --project global clears", async () => {
  const root = await setup();
  try {
    assert.equal(runCli(["feature", "add", "Thing", "--id", "thing", "--project", "acme", "--no-validate-refs"], root).status, 0);
    // Move acme -> beta in place.
    const moved = runCli(["feature", "update", "thing", "--project", "beta"], root);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /Project: beta/);
    // Now visible in beta scope, not acme.
    assert.match(runCli(["feature", "list", "--project", "beta"], root).stdout, /thing/);
    assert.doesNotMatch(runCli(["feature", "list", "--project", "acme"], root).stdout, /thing/);
    // Clear to global.
    const cleared = runCli(["feature", "update", "thing", "--project", "global"], root);
    assert.match(cleared.stdout, /Project: global/);
    // Global shows in every scope.
    assert.match(runCli(["feature", "list", "--project", "acme"], root).stdout, /thing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("in-place reassign: design artifact update --project and unknown id errors", async () => {
  const root = await setup();
  try {
    runCli(["design", "artifact", "add", "ui-design:home", "--title", "Home", "--project", "acme"], root);
    const moved = runCli(["design", "artifact", "update", "ui-design:home", "--project", "beta"], root);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(runCli(["design", "artifact", "list", "--project", "beta"], root).stdout, /ui-design:home/);
    // Unknown project id is rejected.
    const bad = runCli(["design", "artifact", "update", "ui-design:home", "--project", "ghost"], root);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /No project with id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("in-place reassign: source update --project re-scopes its docs", async () => {
  const root = await setup();
  try {
    runCli(["source", "register", "kb", "--name", "KB", "--project", "acme"], root);
    runCli(["doc", "add", "kb:d1", "--title", "Doc one"], root); // inherits acme
    assert.match(runCli(["doc", "list", "--project", "acme"], root).stdout, /kb:d1/);
    // Re-scope the source to beta; the doc follows.
    const moved = runCli(["source", "update", "kb", "--project", "beta"], root);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(runCli(["doc", "list", "--project", "beta"], root).stdout, /kb:d1/);
    assert.doesNotMatch(runCli(["doc", "list", "--project", "acme"], root).stdout, /kb:d1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("map scopes to the active project", async () => {
  const root = await setup();
  try {
    assert.equal(runCli(["project", "use", "acme"], root).status, 0);
    runCli(["feature", "add", "Acme Map Feat", "--id", "acme-map", "--no-validate-refs"], root);
    runCli(["feature", "add", "Beta Map Feat", "--id", "beta-map", "--project", "beta", "--no-validate-refs"], root);

    const acme = runCli(["map", "features"], root);
    assert.equal(acme.status, 0, acme.stderr);
    assert.match(acme.stdout, /Acme Map Feat/);
    assert.doesNotMatch(acme.stdout, /Beta Map Feat/);

    const all = runCli(["map", "features", "--project", "all"], root);
    assert.match(all.stdout, /Beta Map Feat/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
