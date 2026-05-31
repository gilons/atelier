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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-agent-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "Test"], workspaceRoot);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  return { umbrella, workspaceRoot };
}

test("atelier agent --help lists subcommands", () => {
  const result = runCli(["agent", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /install/);
  assert.match(result.stdout, /learn/);
  assert.match(result.stdout, /list/);
});

test("atelier agent list shows the discovery built-in before install", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "list"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Available built-ins/);
    assert.match(result.stdout, /discovery/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent install discovery renders .claude/ files", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "install", "discovery"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Installed agent discovery/);
    assert.match(result.stdout, /\/atelier:discovery/);

    const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", "discovery.md");
    const sub = path.join(workspaceRoot, ".claude", "agents", "atelier-discovery.md");
    const cmdText = await fs.readFile(cmd, "utf8");
    const subText = await fs.readFile(sub, "utf8");
    assert.match(cmdText, /^description: /m);
    assert.match(subText, /^name: atelier-discovery$/m);
    assert.match(subText, /^description: /m);

    // Canonical def materialized too.
    const canonical = path.join(workspaceRoot, ".atelier", "agents", "discovery", "agent.yaml");
    assert.match(await fs.readFile(canonical, "utf8"), /id: discovery/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent learn appends + re-renders into .claude/", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "discovery"], workspaceRoot);
    const learn = runCli(
      ["agent", "learn", "discovery", "Planning lives in Linear (team ENG)."],
      workspaceRoot
    );
    assert.equal(learn.status, 0, `stderr: ${learn.stderr}`);
    assert.match(learn.stdout, /Recorded a learning/);
    assert.match(learn.stdout, /Re-rendered/);

    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-discovery.md"),
      "utf8"
    );
    assert.match(sub, /What I've learned about this workspace/);
    assert.match(sub, /Planning lives in Linear/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent install of an unknown id errors cleanly", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "install", "nope"], workspaceRoot);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /No agent or built-in/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent instruction list shows the discovery playbook units", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "discovery"], workspaceRoot);
    const result = runCli(["agent", "instruction", "list", "discovery"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /overview/);
    assert.match(result.stdout, /repos/);
    assert.match(result.stdout, /wrapup/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent instruction add adds a unit and re-renders", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "discovery"], workspaceRoot);
    const add = runCli(
      [
        "agent",
        "instruction",
        "add",
        "discovery",
        "security",
        "--title",
        "Security review",
        "--detail-text",
        "Never store tokens in sources.yaml.",
      ],
      workspaceRoot
    );
    assert.equal(add.status, 0, `stderr: ${add.stderr}\nstdout: ${add.stdout}`);
    assert.match(add.stdout, /Added instruction unit security/);

    // Unit folder exists with detail + index.
    const unitDir = path.join(
      workspaceRoot,
      ".atelier",
      "agents",
      "discovery",
      "instructions",
      "security"
    );
    assert.match(await fs.readFile(path.join(unitDir, "detail.md"), "utf8"), /Never store tokens/);
    assert.match(await fs.readFile(path.join(unitDir, "index.yaml"), "utf8"), /kind: instruction/);

    // Re-rendered subagent includes the new unit heading.
    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-discovery.md"),
      "utf8"
    );
    assert.match(sub, /## Security review/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
