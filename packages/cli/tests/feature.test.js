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

async function setupCanonical(repos = []) {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-feature-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "Test"], workspaceRoot);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  for (const { name, remote } of repos) {
    const dir = path.join(umbrella, name);
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = ${remote}\n`,
      "utf8"
    );
    const add = runCli(["repo", "add", `../${name}`], workspaceRoot);
    assert.equal(add.status, 0, `repo add ${name} failed: ${add.stderr}`);
  }
  return { umbrella, workspaceRoot };
}

test("atelier feature --help lists subcommands", () => {
  const result = runCli(["feature", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /show/);
  assert.match(result.stdout, /remove/);
});

test("atelier feature with no subcommand shows help", () => {
  const result = runCli(["feature"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
});

test("atelier feature add creates a feature with a derived id", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["feature", "add", "CSV Export"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Added feature/);
    assert.match(result.stdout, /csv-export/);
    const filePath = path.join(workspaceRoot, ".planning", "features", "csv-export.md");
    const text = await fs.readFile(filePath, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /id: csv-export/);
    assert.match(text, /status: planned/);
    assert.match(text, /# CSV Export/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add accepts --name flag in place of positional", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(
      ["feature", "add", "--name", "Reports", "--status", "in-progress"],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /reports/);
    const text = await fs.readFile(
      path.join(workspaceRoot, ".planning", "features", "reports.md"),
      "utf8"
    );
    assert.match(text, /status: in-progress/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add rejects bad --status", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(
      ["feature", "add", "Reports", "--status", "maybe"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid status/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add --code references a registered repo", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical([
    { name: "api", remote: "git@github.com:myorg/api.git" },
  ]);
  try {
    const result = runCli(
      [
        "feature",
        "add",
        "Reports",
        "--code",
        "api:src/reports/",
        "--code",
        "api:src/exports/",
      ],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const text = await fs.readFile(
      path.join(workspaceRoot, ".planning", "features", "reports.md"),
      "utf8"
    );
    assert.match(text, /repo: api/);
    assert.match(text, /path: src\/reports\//);
    assert.match(text, /path: src\/exports\//);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add --code rejects unregistered repo", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(
      ["feature", "add", "Reports", "--code", "ghost"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not registered/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add --no-validate-refs bypasses repo checks", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(
      ["feature", "add", "Reports", "--code", "ghost", "--no-validate-refs"],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature add refuses duplicate ids", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    runCli(["feature", "add", "Search"], workspaceRoot);
    const second = runCli(["feature", "add", "Search"], workspaceRoot);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature list shows registered features", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    runCli(["feature", "add", "Search"], workspaceRoot);
    runCli(["feature", "add", "Onboarding", "--status", "shipped"], workspaceRoot);
    const result = runCli(["feature", "list"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /search/);
    assert.match(result.stdout, /onboarding/);
    assert.match(result.stdout, /shipped/);
    assert.match(result.stdout, /planned/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature list --status filters by status", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    runCli(["feature", "add", "A"], workspaceRoot);
    runCli(["feature", "add", "B", "--status", "shipped"], workspaceRoot);
    const result = runCli(["feature", "list", "--status", "shipped"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^[\s\S]*b[\s\S]*shipped/);
    assert.doesNotMatch(result.stdout, /^\s*·\s+a\s/m);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature list with no features shows hint", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["feature", "list"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No features yet/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature show prints details and body", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    runCli(
      ["feature", "add", "Reports", "--description", "Reporting layer"],
      workspaceRoot
    );
    const result = runCli(["feature", "show", "reports"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Reports/);
    assert.match(result.stdout, /id:\s+reports/);
    assert.match(result.stdout, /status:\s+planned/);
    assert.match(result.stdout, /Reporting layer/);
    assert.match(result.stdout, /# Reports/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature show errors on missing id", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const result = runCli(["feature", "show", "ghost"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No feature with id/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature remove deletes the file", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    runCli(["feature", "add", "Search"], workspaceRoot);
    const result = runCli(["feature", "remove", "search"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Removed feature/);
    const exists = await fs
      .access(path.join(workspaceRoot, ".planning", "features", "search.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier feature commands error outside a workspace", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-feature-outside-"));
  try {
    const result = runCli(["feature", "list"], outside);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not inside an Atelier workspace/);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});
