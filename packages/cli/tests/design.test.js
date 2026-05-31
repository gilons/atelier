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

test("atelier design live show reports the default gate before tuning", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "live", "show"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /stability gate:\s*2 chunk/);
    assert.match(result.stdout, /default/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design live set tunes the gate + model and persists", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const set = runCli(
      ["design", "live", "set", "--stability-chunks", "3", "--model", "base"],
      workspaceRoot
    );
    assert.equal(set.status, 0, `stderr: ${set.stderr}\nstdout: ${set.stdout}`);
    const show = runCli(["design", "live", "show"], workspaceRoot);
    assert.match(show.stdout, /stability gate:\s*3 chunk/);
    assert.match(show.stdout, /live STT model:\s*base/);
    const cfg = await fs.readFile(path.join(workspaceRoot, ".atelier", "design.yaml"), "utf8");
    assert.match(cfg, /stabilityChunks: 3/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design live set rejects a bad gate", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "live", "set", "--stability-chunks", "0"], workspaceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, /positive integer/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design discipline list shows built-in disciplines", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "discipline", "list"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /system-design/);
    assert.match(result.stdout, /ui-design/);
    assert.match(result.stdout, /built-in/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("tools are per-discipline (ui-design vs system-design)", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["design", "tool", "set", "excalidraw"], workspaceRoot); // system-design (default)
    runCli(["design", "tool", "set", "figma", "--discipline", "ui-design"], workspaceRoot);
    const sys = runCli(["design", "tool", "show"], workspaceRoot);
    assert.match(sys.stdout, /excalidraw/);
    const ui = runCli(["design", "tool", "show", "--discipline", "ui-design"], workspaceRoot);
    assert.match(ui.stdout, /figma/);
    assert.match(ui.stdout, /ui-design/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design discipline add scaffolds a custom discipline + its agent", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const add = runCli(
      ["design", "discipline", "add", "service-design", "--name", "Service Design", "--designs", "service blueprints"],
      workspaceRoot
    );
    assert.equal(add.status, 0, `stderr: ${add.stderr}\nstdout: ${add.stdout}`);
    assert.match(add.stdout, /Added design discipline service-design/);
    // The agent was generated from the shared template.
    const list = runCli(["agent", "list"], workspaceRoot);
    assert.match(list.stdout, /service-design/);
    // And it carries the engine (install + check a unit).
    runCli(["agent", "install", "service-design"], workspaceRoot);
    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-service-design.md"),
      "utf8"
    );
    assert.match(sub, /Live companion mode/);
    assert.match(sub, /service blueprints/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
