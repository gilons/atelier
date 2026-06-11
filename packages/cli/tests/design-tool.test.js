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
    assert.match(result.stdout, /No tool set for/);
    assert.match(result.stdout, /system-design/);
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
    assert.match(show.stdout, /No tool set for/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design tool scopes per project: active pin + global fallback (issue #1)", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    assert.equal(runCli(["project", "add", "Trivision", "--id", "trivision"], workspaceRoot).status, 0);
    assert.equal(runCli(["project", "add", "Farm", "--id", "fourfarm"], workspaceRoot).status, 0);

    // Global default for ui-design.
    assert.equal(
      runCli(["design", "tool", "set", "excalidraw", "--discipline", "ui-design", "--project", "global"], workspaceRoot).status,
      0
    );
    // Pin trivision; set figma there (respects the active pin).
    assert.equal(runCli(["project", "use", "trivision"], workspaceRoot).status, 0);
    const set = runCli(["design", "tool", "set", "figma", "--discipline", "ui-design", "--note", "trivision-only"], workspaceRoot);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /for project .*trivision/);

    // Show under trivision -> figma (project scope).
    const triv = runCli(["design", "tool", "show", "--discipline", "ui-design"], workspaceRoot);
    assert.match(triv.stdout, /figma/);
    assert.match(triv.stdout, /trivision/);

    // Switch to fourfarm -> falls back to the global excalidraw.
    assert.equal(runCli(["project", "use", "fourfarm"], workspaceRoot).status, 0);
    const farm = runCli(["design", "tool", "show", "--discipline", "ui-design"], workspaceRoot);
    assert.match(farm.stdout, /excalidraw/);
    assert.match(farm.stdout, /global default/);

    // Clearing trivision's override leaves the global default intact.
    assert.equal(
      runCli(["design", "tool", "clear", "--discipline", "ui-design", "--project", "trivision"], workspaceRoot).status,
      0
    );
    const trivAfter = runCli(["design", "tool", "show", "--discipline", "ui-design", "--project", "trivision"], workspaceRoot);
    assert.match(trivAfter.stdout, /excalidraw/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design tool set --project with an unknown id errors", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const r = runCli(["design", "tool", "set", "figma", "--project", "ghost"], workspaceRoot);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /No project with id/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
