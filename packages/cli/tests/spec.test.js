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

async function setup(repos = []) {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-spec-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "T"], workspaceRoot);
  assert.equal(init.status, 0, init.stderr);
  for (const { name, remote } of repos) {
    const dir = path.join(umbrella, name);
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = ${remote}\n`,
      "utf8"
    );
    const add = runCli(["repo", "add", `../${name}`], workspaceRoot);
    assert.equal(add.status, 0, add.stderr);
  }
  return { umbrella, workspaceRoot };
}

test("atelier spec --help shows subcommands", () => {
  const result = runCli(["spec", "--help"], process.cwd());
  assert.equal(result.status, 0);
  for (const sub of ["new", "list", "show", "set-status", "remove"]) {
    assert.match(result.stdout, new RegExp(sub));
  }
});

test("atelier spec new requires --type", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["spec", "new", "Add stuff"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--type/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new scaffolds an issue folder", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "Add CSV export", "--type", "new-feature"],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Scaffolded spec/);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".planning", "issues"));
    assert.equal(dirs.length, 1);
    const dir = path.join(workspaceRoot, ".planning", "issues", dirs[0]);
    for (const f of ["README.md", "spec.md", "context.md", "prompt.md"]) {
      const stat = await fs.stat(path.join(dir, f));
      assert.ok(stat.isFile(), `${f} missing`);
    }
    const spec = await fs.readFile(path.join(dir, "spec.md"), "utf8");
    assert.match(spec, /## Goal/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new rejects bad --type", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "x", "--type", "wishlist"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Valid:/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new --feature pulls feature refs", async () => {
  const { umbrella, workspaceRoot } = await setup([
    { name: "api", remote: "git@github.com:org/api.git" },
  ]);
  try {
    runCli(
      ["feature", "add", "Reports", "--code", "api:src/reports/"],
      workspaceRoot
    );
    const result = runCli(
      ["spec", "new", "Add CSV", "--type", "new-feature", "--feature", "reports"],
      workspaceRoot
    );
    assert.equal(result.status, 0, result.stderr);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".planning", "issues"));
    const context = await fs.readFile(
      path.join(workspaceRoot, ".planning", "issues", dirs[0], "context.md"),
      "utf8"
    );
    assert.match(context, /### `reports`/);
    assert.match(context, /api:src\/reports\//);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new --feature ghost errors", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "x", "--type", "bug", "--feature", "ghost"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not registered/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec list shows registered specs", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "Alpha", "--type", "bug"], workspaceRoot);
    runCli(["spec", "new", "Beta", "--type", "ui"], workspaceRoot);
    const result = runCli(["spec", "list"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /alpha/);
    assert.match(result.stdout, /beta/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec set-status changes status", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "X", "--type", "bug"], workspaceRoot);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".planning", "issues"));
    const id = dirs[0];
    const result = runCli(["spec", "set-status", id, "ready"], workspaceRoot);
    assert.equal(result.status, 0, result.stderr);
    const show = runCli(["spec", "show", id], workspaceRoot);
    assert.match(show.stdout, /status:\s+ready/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec remove deletes the folder", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "X", "--type", "bug"], workspaceRoot);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".planning", "issues"));
    const id = dirs[0];
    const result = runCli(["spec", "remove", id], workspaceRoot);
    assert.equal(result.status, 0);
    const after = await fs.readdir(path.join(workspaceRoot, ".planning", "issues"));
    assert.equal(after.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
