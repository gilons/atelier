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

async function setupWorkspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-map-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "Acme Planning"], workspaceRoot);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  return { umbrella, workspaceRoot };
}

test("atelier map renders the workspace section tree", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["feature", "add", "CSV Export"], workspaceRoot);
    const result = runCli(["map"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Acme Planning/);
    assert.match(result.stdout, /Agents/);
    assert.match(result.stdout, /Features/);
    assert.match(result.stdout, /CSV Export/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier map --json emits a parseable tree", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["map", "--json", "--depth", "1"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const tree = JSON.parse(result.stdout);
    assert.equal(tree.kind, "workspace");
    assert.ok(Array.isArray(tree.children));
    assert.ok(tree.children.some((c) => c.name === "Agents"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier map --rebuild materializes index.yaml sidecars", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "discovery"], workspaceRoot);
    const result = runCli(["map", "--rebuild"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Wrote \d+ index\.yaml/);

    const rootIdx = path.join(workspaceRoot, ".atelier", "index.yaml");
    const agentIdx = path.join(workspaceRoot, ".atelier", "agents", "discovery", "index.yaml");
    assert.match(await fs.readFile(rootIdx, "utf8"), /kind: workspace/);
    assert.match(await fs.readFile(agentIdx, "utf8"), /kind: agent/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier map <path> drills into a branch", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "discovery"], workspaceRoot);
    const result = runCli(["map", "agents/discovery"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Discovery/);
    assert.match(result.stdout, /Playbook/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
