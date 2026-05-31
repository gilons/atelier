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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-design-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  await write(path.join(umbrella, "api", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  await write(path.join(umbrella, "api", "go.mod"), "module acme/api\n");
  assert.equal(runCli(["repo", "add", "../api"], workspaceRoot).status, 0);
  assert.equal(runCli(["feature", "add", "Checkout"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("atelier design palette lists subsystems + features with refs", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "palette"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Subsystems/);
    assert.match(result.stdout, /repo:api/);
    assert.match(result.stdout, /Features/);
    assert.match(result.stdout, /feature:checkout/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design palette --json is parseable", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "palette", "--json"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const palette = JSON.parse(result.stdout);
    assert.ok(Array.isArray(palette.subsystems));
    assert.ok(palette.subsystems.some((s) => s.ref === "repo:api"));
    assert.ok(palette.features.some((f) => f.ref === "feature:checkout"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
