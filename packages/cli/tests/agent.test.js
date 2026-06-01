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
  // --no-agents: these tests exercise installing agents explicitly, so
  // start from a workspace where none are installed yet. (Plain `init`
  // now installs the whole suite by default — covered by its own test.)
  const init = runCli(["init", "--name", "Test", "--no-agents"], workspaceRoot);
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

test("atelier init installs the whole agent suite by default (single-command setup)", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-init-agents-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  try {
    const init = runCli(["init", "--name", "Test"], workspaceRoot);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);
    // Reports the installed agents + their invocations.
    assert.match(init.stdout, /Agents installed/);
    assert.match(init.stdout, /\/atelier:discovery/);
    // The built-in suite is rendered into .claude/ — no extra commands.
    for (const id of ["discovery", "system-design", "ui-design", "spec", "planning"]) {
      const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", `${id}.md`);
      const sub = path.join(workspaceRoot, ".claude", "agents", `atelier-${id}.md`);
      assert.ok((await fs.stat(cmd)).isFile(), `${id} slash command missing`);
      assert.ok((await fs.stat(sub)).isFile(), `${id} subagent missing`);
    }
    // And `agent list` shows them installed.
    const list = runCli(["agent", "list"], workspaceRoot);
    assert.match(list.stdout, /discovery\s+yes/);
    assert.match(list.stdout, /ui-design\s+yes/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent install spec renders the spec-authoring playbook", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "install", "spec"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Installed agent spec/);
    assert.match(result.stdout, /\/atelier:spec/);

    const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", "spec.md");
    const sub = path.join(workspaceRoot, ".claude", "agents", "atelier-spec.md");
    const cmdText = await fs.readFile(cmd, "utf8");
    const subText = await fs.readFile(sub, "utf8");
    assert.match(subText, /^name: atelier-spec$/m);
    // The playbook is grounded + spec-authoring oriented.
    assert.match(cmdText, /non-goals/i);
    assert.match(cmdText, /spec new .*--feature/);
    assert.match(cmdText, /breakdown|decompose|slices|spec/i);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent install planning renders the build-order playbook", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "install", "planning"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Installed agent planning/);
    assert.match(result.stdout, /\/atelier:planning/);

    const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", "planning.md");
    const sub = path.join(workspaceRoot, ".claude", "agents", "atelier-planning.md");
    const cmdText = await fs.readFile(cmd, "utf8");
    const subText = await fs.readFile(sub, "utf8");
    assert.match(subText, /^name: atelier-planning$/m);
    // The playbook is HOW + build-order oriented.
    assert.match(cmdText, /plan\.md/);
    assert.match(cmdText, /spec deps/);
    assert.match(cmdText, /set-status .*ready|ready/i);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("every built-in agent ships a confirm-first self-improvement unit", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    runCli(["agent", "install", "--all"], workspaceRoot);
    for (const id of ["discovery", "system-design", "ui-design", "spec", "planning"]) {
      const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", `${id}.md`);
      const text = await fs.readFile(cmd, "utf8");
      // It records via the agent's own learn command…
      assert.match(text, new RegExp(`agent learn ${id}`), `${id} missing self-improve learn`);
      // …but only after asking the user (never silently).
      assert.match(text, /Ask before recording|never silently|on their yes/i, `${id} not confirm-first`);
    }
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier agent install --all installs every built-in", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    // setupWorkspace used --no-agents, so none are installed yet.
    const result = runCli(["agent", "install", "--all"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Installed 5 agents/);
    assert.match(result.stdout, /\/atelier:system-design/);
    assert.match(result.stdout, /\/atelier:spec/);
    assert.match(result.stdout, /\/atelier:planning/);
    for (const id of ["discovery", "system-design", "ui-design", "spec", "planning"]) {
      const cmd = path.join(workspaceRoot, ".claude", "commands", "atelier", `${id}.md`);
      assert.ok((await fs.stat(cmd)).isFile(), `${id} not installed`);
    }
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
    assert.match(learn.stdout, /Recorded a personal .* learning/);

    // Default is the personal layer (gitignored), and the installed
    // agent auto-re-renders so the learning is live in .claude/.
    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-discovery.md"),
      "utf8"
    );
    assert.match(sub, /What I've learned about this workspace/);
    assert.match(sub, /Planning lives in Linear/);
    assert.match(sub, /personal/i);

    // It went to learnings.local.md, not the committed learnings.md.
    const local = await fs.readFile(
      path.join(workspaceRoot, ".atelier", "agents", "discovery", "learnings.local.md"),
      "utf8"
    );
    assert.match(local, /Planning lives in Linear/);
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

test("atelier agent install system-design renders the tool-aware playbook", async () => {
  const { umbrella, workspaceRoot } = await setupWorkspace();
  try {
    const result = runCli(["agent", "install", "system-design"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-system-design.md"),
      "utf8"
    );
    assert.match(sub, /## Onboard a design tool/);
    assert.match(sub, /### Figma/);
    assert.match(sub, /## Markdown fallback/);
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
