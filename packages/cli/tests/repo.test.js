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

/**
 * Build the canonical layout:
 *   <umbrella>/
 *   ├── planning/        (workspace root)
 *   │   └── .planning/
 *   └── <siblings>/
 */
async function setupCanonical(repos = []) {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repo-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const result = runCli(["init", "--name", "TestWS"], workspaceRoot);
  assert.equal(result.status, 0, `init failed: ${result.stderr}`);
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

test("atelier repo --help lists subcommands", () => {
  const result = runCli(["repo", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /remove/);
});

test("atelier repo with no subcommand shows help", () => {
  const result = runCli(["repo"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
});

test("atelier repo unknown-sub errors", () => {
  const result = runCli(["repo", "nope"], process.cwd());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown subcommand/);
});

test("atelier repo add ../api registers a sibling repo", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = runCli(["repo", "add", "../api"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Registered/);
    assert.match(result.stdout, /myorg/);

    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.match(repos, /name: api/);
    assert.match(repos, /localPath:\s*['"]?\.\.\/api['"]?/);
    assert.match(repos, /organization: myorg/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add works from a subdirectory of the workspace", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const sub = path.join(workspaceRoot, "deep", "nested");
    await fs.mkdir(sub, { recursive: true });
    const result = runCli(["repo", "add", "../../../api"], sub);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.match(repos, /localPath:\s*['"]?\.\.\/api['"]?/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add accepts an absolute path", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = runCli(["repo", "add", path.join(umbrella, "api")], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    // Stored as relative even though input was absolute.
    assert.match(repos, /localPath:\s*['"]?\.\.\/api['"]?/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add refuses non-git directory", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  await fs.mkdir(path.join(umbrella, "junk"));
  try {
    const result = runCli(["repo", "add", "../junk"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not a git repository/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add refuses non-existent path", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["repo", "add", "../ghost"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add refuses duplicate remote", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
    { name: "api-clone", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    let result = runCli(["repo", "add", "../api"], workspaceRoot);
    assert.equal(result.status, 0);
    result = runCli(["repo", "add", "../api-clone"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already registered/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo list shows registered repos with status", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
    { name: "web", remote: "git@github.com:myorg/web.git" },
  ]);
  try {
    runCli(["repo", "add", "../api"], workspaceRoot);
    runCli(["repo", "add", "../web"], workspaceRoot);

    // Delete one to test the "not cloned locally" marker.
    await fs.rm(path.join(umbrella, "web"), { recursive: true, force: true });

    const result = runCli(["repo", "list"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Organization:.*myorg/);
    assert.match(result.stdout, /api/);
    assert.match(result.stdout, /web/);
    assert.match(result.stdout, /not cloned locally/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo list with no repos shows hint", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["repo", "list"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No repositories registered/);
    assert.match(result.stdout, /atelier repo add/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo remove unregisters by name", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    runCli(["repo", "add", "../api"], workspaceRoot);
    const result = runCli(["repo", "remove", "api"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Unregistered/);
    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.doesNotMatch(repos, /name: api/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo remove errors on unknown name", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["repo", "remove", "ghost"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No registered repository/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo add outside a workspace errors clearly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-nowork-"));
  try {
    const result = runCli(["repo", "add", "something"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not inside an Atelier workspace/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier repo add --name overrides the derived name", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = runCli(
      ["repo", "add", "../api", "--name", "backend-api"],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.match(repos, /name: backend-api/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
