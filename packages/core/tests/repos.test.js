import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  removeRepo,
  listRepos,
  loadReposConfig,
  RepoAlreadyRegisteredError,
  RepoNameNotFoundError,
  NotAGitRepoError,
  MissingRemoteError,
  findWorkspaceRoot,
  requireWorkspaceRoot,
  NotInsideWorkspaceError,
} from "../dist/index.js";

/**
 * Canonical layout these tests assume:
 *
 *   <umbrella>/
 *   ├── planning/        <- workspace root (has .planning/)
 *   └── <code repos>/    <- siblings of planning/
 *
 * Tests build a temp <umbrella>, init `planning/` as the workspace,
 * and create code repos as siblings.
 */
async function setupCanonical(repos = []) {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repos-test-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "TestWorkspace" });
  for (const { name, remote } of repos) {
    const repoDir = path.join(umbrella, name);
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, ".git", "config"),
      `[remote "origin"]\n\turl = ${remote}\n`,
      "utf8"
    );
  }
  return { umbrella, workspaceRoot };
}

test("findWorkspaceRoot walks up from a subdirectory", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const sub = path.join(workspaceRoot, "deep", "nested");
    await fs.mkdir(sub, { recursive: true });
    const found = await findWorkspaceRoot(sub);
    assert.equal(found, path.resolve(workspaceRoot));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("findWorkspaceRoot returns null when not inside a workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-nowork-"));
  try {
    const found = await findWorkspaceRoot(root);
    assert.equal(found, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("requireWorkspaceRoot throws NotInsideWorkspaceError", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-require-"));
  try {
    await assert.rejects(
      () => requireWorkspaceRoot(root),
      (e) => e instanceof NotInsideWorkspaceError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addRepo registers a sibling git repo using ../api", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = await addRepo(workspaceRoot, {
      pathInput: "../api",
      cwd: workspaceRoot,
    });
    assert.equal(result.repo.name, "api");
    assert.equal(result.repo.remote, "git@github.com:myorg/api.git");
    assert.equal(result.repo.localPath, "../api");
    assert.equal(result.organizationSet, "myorg");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo works when invoked from a subdirectory of the workspace", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const sub = path.join(workspaceRoot, "deep");
    await fs.mkdir(sub, { recursive: true });
    const result = await addRepo(workspaceRoot, {
      pathInput: "../../api",
      cwd: sub,
    });
    // Path stored relative to workspace root, not cwd.
    assert.equal(result.repo.localPath, "../api");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo accepts an absolute path and stores it relative", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const absPath = path.join(umbrella, "api");
    const result = await addRepo(workspaceRoot, {
      pathInput: absPath,
      cwd: workspaceRoot,
    });
    assert.equal(result.repo.localPath, "../api");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo refuses duplicate remote URLs", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
    { name: "api-copy", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    await assert.rejects(
      () => addRepo(workspaceRoot, { pathInput: "../api-copy", cwd: workspaceRoot }),
      (e) => e instanceof RepoAlreadyRegisteredError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo refuses non-existent paths", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await assert.rejects(
      () => addRepo(workspaceRoot, { pathInput: "../ghost", cwd: workspaceRoot }),
      (e) => /does not exist/.test(e.message)
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo refuses non-git directories", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  await fs.mkdir(path.join(umbrella, "not-a-repo"));
  try {
    await assert.rejects(
      () => addRepo(workspaceRoot, { pathInput: "../not-a-repo", cwd: workspaceRoot }),
      (e) => e instanceof NotAGitRepoError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo refuses git repo with no origin remote", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  const repo = path.join(umbrella, "no-remote");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(repo, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n`,
    "utf8"
  );
  try {
    await assert.rejects(
      () => addRepo(workspaceRoot, { pathInput: "../no-remote", cwd: workspaceRoot }),
      (e) => e instanceof MissingRemoteError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo uses --name override", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = await addRepo(workspaceRoot, {
      pathInput: "../api",
      cwd: workspaceRoot,
      name: "backend-api",
      description: "The backend service",
    });
    assert.equal(result.repo.name, "backend-api");
    assert.equal(result.repo.description, "The backend service");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("listRepos reports cloned vs missing siblings", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
    { name: "web", remote: "git@github.com:myorg/web.git" },
  ]);
  try {
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

    // Simulate "registered but not cloned" by removing the directory.
    await fs.rm(path.join(umbrella, "web"), { recursive: true, force: true });

    const result = await listRepos(workspaceRoot);
    assert.equal(result.organization, "myorg");
    assert.equal(result.repos.length, 2);
    const byName = Object.fromEntries(result.repos.map((r) => [r.repo.name, r]));
    assert.equal(byName.api.exists, true);
    assert.equal(byName.web.exists, false);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeRepo unregisters by name", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    const removed = await removeRepo(workspaceRoot, "api");
    assert.equal(removed.remote, "git@github.com:myorg/api.git");
    const cfg = await loadReposConfig(workspaceRoot);
    assert.equal(cfg.repos.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("removeRepo throws when name not found", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await assert.rejects(
      () => removeRepo(workspaceRoot, "ghost"),
      (e) => e instanceof RepoNameNotFoundError
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("workspace organization is set from first GitHub repo only", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:firstorg/api.git" },
    { name: "web", remote: "git@github.com:secondorg/web.git" },
  ]);
  try {
    const r1 = await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
    const r2 = await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });
    assert.equal(r1.organizationSet, "firstorg");
    assert.equal(r2.organizationSet, undefined);

    const cfg = await loadReposConfig(workspaceRoot);
    assert.equal(cfg.organization, "firstorg");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("localPath uses forward slashes even on nested sibling paths", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  const nested = path.join(umbrella, "services", "api");
  await fs.mkdir(path.join(nested, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(nested, ".git", "config"),
    `[remote "origin"]\n\turl = git@github.com:myorg/api.git\n`,
    "utf8"
  );
  try {
    const result = await addRepo(workspaceRoot, {
      pathInput: "../services/api",
      cwd: workspaceRoot,
    });
    assert.equal(result.repo.localPath, "../services/api");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("addRepo also accepts a repo inside the workspace (e.g. a monorepo subpackage)", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  // A repo nested directly inside the workspace root.
  const nested = path.join(workspaceRoot, "vendored");
  await fs.mkdir(path.join(nested, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(nested, ".git", "config"),
    `[remote "origin"]\n\turl = git@github.com:myorg/vendored.git\n`,
    "utf8"
  );
  try {
    const result = await addRepo(workspaceRoot, {
      pathInput: "vendored",
      cwd: workspaceRoot,
    });
    assert.equal(result.repo.localPath, "vendored");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
