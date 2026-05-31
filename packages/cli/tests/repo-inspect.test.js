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

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

async function setup() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repoinspect-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "Test"], workspaceRoot);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);

  // A go service and a node/python monorepo.
  await write(path.join(umbrella, "api", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  await write(path.join(umbrella, "api", "go.mod"), "module github.com/acme/api\n");
  await write(path.join(umbrella, "platform", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
  await write(path.join(umbrella, "platform", "package.json"), '{"name":"platform","workspaces":["services/*"]}\n');
  await write(path.join(umbrella, "platform", "services", "worker", "pyproject.toml"), "name = 'worker'\n");

  assert.equal(runCli(["repo", "add", "../api"], workspaceRoot).status, 0);
  assert.equal(runCli(["repo", "add", "../platform"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("atelier repo inspect summarizes ecosystems + monorepo packages", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["repo", "inspect"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /api/);
    assert.match(result.stdout, /go/);
    assert.match(result.stdout, /platform/);
    assert.match(result.stdout, /monorepo/);
    assert.match(result.stdout, /services\/worker/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier repo inspect --json emits a parseable inventory", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["repo", "inspect", "platform", "--json"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.repos.length, 1);
    assert.equal(data.repos[0].repo, "platform");
    assert.equal(data.repos[0].monorepo, true);
    assert.ok(data.repos[0].ecosystems.includes("node"));
    assert.ok(data.repos[0].ecosystems.includes("python"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
