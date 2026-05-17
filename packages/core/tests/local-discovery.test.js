import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanChildren,
  scanSiblings,
  inferRepoContext,
  findNearbyWorkspace,
  inferOrg,
  initWorkspace,
} from "../dist/index.js";

async function makeRepo(parent, name, remote) {
  const dir = path.join(parent, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".git", "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8"
  );
  return dir;
}

async function umbrella() {
  return fs.mkdtemp(path.join(os.tmpdir(), "atelier-localdisc-"));
}

// ============================================================
// scanChildren / scanSiblings
// ============================================================

test("scanChildren finds immediate-child git repos and skips non-repos", async () => {
  const dir = await umbrella();
  try {
    await makeRepo(dir, "api", "git@github.com:acme/api.git");
    await makeRepo(dir, "web", "git@github.com:acme/web.git");
    await fs.mkdir(path.join(dir, "not-a-repo"));
    const result = await scanChildren(dir);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.dirName).sort(),
      ["api", "web"]
    );
    const api = result.find((r) => r.dirName === "api");
    assert.equal(api.org, "acme");
    assert.equal(api.repoName, "api");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scanChildren skips dot-directories (e.g. .planning)", async () => {
  const dir = await umbrella();
  try {
    await makeRepo(dir, "api", "git@github.com:acme/api.git");
    await fs.mkdir(path.join(dir, ".planning"), { recursive: true });
    await fs.mkdir(path.join(dir, ".cache"), { recursive: true });
    const result = await scanChildren(dir);
    assert.deepEqual(result.map((r) => r.dirName), ["api"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scanChildren handles missing directory gracefully", async () => {
  const result = await scanChildren("/no/such/dir/here");
  assert.deepEqual(result, []);
});

test("scanSiblings excludes the starting directory itself", async () => {
  const dir = await umbrella();
  try {
    const planning = path.join(dir, "planning");
    await fs.mkdir(planning);
    await makeRepo(dir, "api", "git@github.com:acme/api.git");
    await makeRepo(dir, "web", "git@github.com:acme/web.git");
    const result = await scanSiblings(planning);
    assert.deepEqual(
      result.map((r) => r.dirName).sort(),
      ["api", "web"]
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// inferRepoContext
// ============================================================

test("inferRepoContext walks up to find the nearest .git/", async () => {
  const dir = await umbrella();
  try {
    const repo = await makeRepo(dir, "api", "git@github.com:acme/api.git");
    const subdir = path.join(repo, "src", "auth");
    await fs.mkdir(subdir, { recursive: true });
    const ctx = await inferRepoContext(subdir);
    assert.ok(ctx);
    assert.equal(ctx.dirName, "api");
    assert.equal(ctx.org, "acme");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("inferRepoContext returns null when no .git/ ancestor exists", async () => {
  const dir = await umbrella();
  try {
    const result = await inferRepoContext(dir);
    assert.equal(result, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// findNearbyWorkspace
// ============================================================

test("findNearbyWorkspace finds an ancestor workspace", async () => {
  const dir = await umbrella();
  try {
    const planning = path.join(dir, "planning");
    await fs.mkdir(planning);
    await initWorkspace(planning, { name: "Test" });
    const child = path.join(planning, "sub", "deep");
    await fs.mkdir(child, { recursive: true });
    const result = await findNearbyWorkspace(child);
    assert.equal(result, planning);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("findNearbyWorkspace finds a sibling workspace", async () => {
  const dir = await umbrella();
  try {
    const planning = path.join(dir, "planning");
    await fs.mkdir(planning);
    await initWorkspace(planning, { name: "Test" });
    const repo = await makeRepo(dir, "api", "git@github.com:acme/api.git");
    const result = await findNearbyWorkspace(repo);
    assert.equal(result, planning);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("findNearbyWorkspace returns null when nothing is nearby", async () => {
  // Use a nested isolated dir so the sibling-search has no neighbors
  // — `/var/folders/.../T/` is shared with other test fixtures.
  const outer = await umbrella();
  try {
    const isolated = path.join(outer, "isolated", "inner");
    await fs.mkdir(isolated, { recursive: true });
    const result = await findNearbyWorkspace(isolated);
    assert.equal(result, null);
  } finally {
    await fs.rm(outer, { recursive: true, force: true });
  }
});

// ============================================================
// inferOrg
// ============================================================

test("inferOrg returns the majority org", () => {
  const result = inferOrg([
    { absPath: "x", dirName: "a", remote: "x", repoName: "a", org: "acme" },
    { absPath: "y", dirName: "b", remote: "y", repoName: "b", org: "acme" },
    { absPath: "z", dirName: "c", remote: "z", repoName: "c", org: "other" },
  ]);
  assert.equal(result, "acme");
});

test("inferOrg returns null when no org information", () => {
  assert.equal(
    inferOrg([
      { absPath: "x", dirName: "a", remote: null, repoName: "a", org: null },
    ]),
    null
  );
});

test("inferOrg handles an empty list", () => {
  assert.equal(inferOrg([]), null);
});
