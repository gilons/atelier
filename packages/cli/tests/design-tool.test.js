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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-designtool-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("design tool show reports 'none' before anything is set", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "tool", "show"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /No system-design tool set/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design tool set then show round-trips", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const set = runCli(["design", "tool", "set", "figma", "--note", "file key ABC"], workspaceRoot);
    assert.equal(set.status, 0, `stderr: ${set.stderr}\nstdout: ${set.stdout}`);
    assert.match(set.stdout, /set to figma/);

    const show = runCli(["design", "tool", "show"], workspaceRoot);
    assert.match(show.stdout, /figma/);
    assert.match(show.stdout, /file key ABC/);

    // Lands on disk.
    const cfg = await fs.readFile(path.join(workspaceRoot, ".atelier", "design.yaml"), "utf8");
    assert.match(cfg, /tool: figma/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design tool clear removes the setting", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["design", "tool", "set", "excalidraw"], workspaceRoot);
    const clear = runCli(["design", "tool", "clear"], workspaceRoot);
    assert.equal(clear.status, 0);
    assert.match(clear.stdout, /Cleared/);
    const show = runCli(["design", "tool", "show"], workspaceRoot);
    assert.match(show.stdout, /No system-design tool set/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
