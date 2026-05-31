import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  inspectProjects,
  inspectRepoDir,
} from "../dist/index.js";

async function workspaceWithRepos() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-inspect-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

async function makeGitRepo(umbrella, name, remote) {
  const dir = path.join(umbrella, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  return dir;
}

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

// ============================================================
// inspectRepoDir (pure, no workspace needed)
// ============================================================

test("inspectRepoDir reports exists:false for a missing clone", async () => {
  const r = await inspectRepoDir("ghost", "/nope/does/not/exist", false);
  assert.equal(r.exists, false);
  assert.deepEqual(r.ecosystems, []);
  assert.deepEqual(r.packages, []);
});

test("inspectRepoDir detects a single-ecosystem repo + container hint", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-inspect-go-"));
  const dir = path.join(umbrella, "api");
  await write(path.join(dir, "go.mod"), "module github.com/acme/api\n");
  await write(path.join(dir, "Dockerfile"), "FROM golang:1.22\n");
  const r = await inspectRepoDir("api", dir, true);
  assert.deepEqual(r.ecosystems, ["go"]);
  assert.equal(r.containerized, true);
  assert.equal(r.monorepo, false);
  assert.equal(r.packages[0].path, ".");
});

test("inspectRepoDir enumerates monorepo packages under services/", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-inspect-mono-"));
  const dir = path.join(umbrella, "platform");
  await write(path.join(dir, "package.json"), '{"name":"platform","workspaces":["services/*"]}\n');
  await write(path.join(dir, "services", "web", "package.json"), '{"name":"@acme/web"}\n');
  await write(path.join(dir, "services", "worker", "pyproject.toml"), "name = 'worker'\n");
  const r = await inspectRepoDir("platform", dir, true);
  assert.equal(r.monorepo, true);
  assert.deepEqual(r.ecosystems, ["node", "python"]);
  const paths = r.packages.map((p) => p.path).sort();
  assert.deepEqual(paths, [".", "services/web", "services/worker"]);
  const web = r.packages.find((p) => p.path === "services/web");
  assert.equal(web.name, "@acme/web");
  assert.deepEqual(web.ecosystems, ["node"]);
});

test("inspectRepoDir ignores node_modules / vendor / .git", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-inspect-ignore-"));
  const dir = path.join(umbrella, "app");
  await write(path.join(dir, "package.json"), '{"name":"app"}\n');
  // A package.json buried in node_modules must NOT be reported.
  await write(path.join(dir, "node_modules", "left-pad", "package.json"), '{"name":"left-pad"}\n');
  const r = await inspectRepoDir("app", dir, true);
  assert.ok(!r.packages.some((p) => p.name === "left-pad"), "node_modules leaked into inspection");
});

// ============================================================
// inspectProjects (workspace-level)
// ============================================================

test("inspectProjects walks every registered repo", async () => {
  const { umbrella, workspaceRoot } = await workspaceWithRepos();
  const api = await makeGitRepo(umbrella, "api", "git@github.com:acme/api.git");
  await write(path.join(api, "go.mod"), "module github.com/acme/api\n");
  const web = await makeGitRepo(umbrella, "web", "git@github.com:acme/web.git");
  await write(path.join(web, "package.json"), '{"name":"web"}\n');
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const result = await inspectProjects(workspaceRoot);
  assert.equal(result.repos.length, 2);
  const byName = Object.fromEntries(result.repos.map((r) => [r.repo, r]));
  assert.deepEqual(byName.api.ecosystems, ["go"]);
  assert.deepEqual(byName.web.ecosystems, ["node"]);
});

test("inspectProjects can target a single repo by name", async () => {
  const { umbrella, workspaceRoot } = await workspaceWithRepos();
  const api = await makeGitRepo(umbrella, "api", "git@github.com:acme/api.git");
  await write(path.join(api, "go.mod"), "module x\n");
  const web = await makeGitRepo(umbrella, "web", "git@github.com:acme/web.git");
  await write(path.join(web, "package.json"), '{"name":"web"}\n');
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const result = await inspectProjects(workspaceRoot, { repo: "web" });
  assert.equal(result.repos.length, 1);
  assert.equal(result.repos[0].repo, "web");
});
