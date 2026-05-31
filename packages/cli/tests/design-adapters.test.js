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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-adapters-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("design adapters list shows the built-in set incl. Flutter", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const r = runCli(["design", "adapters", "list"], workspaceRoot);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /UI framework adapters/);
    assert.match(r.stdout, /next/);
    assert.match(r.stdout, /flutter/);
    assert.match(r.stdout, /built-in/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design adapters list --json is parseable and sorted by priority", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const r = runCli(["design", "adapters", "list", "--json"], workspaceRoot);
    assert.equal(r.status, 0, r.stderr);
    const { adapters } = JSON.parse(r.stdout);
    assert.ok(Array.isArray(adapters));
    assert.equal(adapters[0].id, "next");
    assert.ok(adapters.some((a) => a.id === "flutter"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design adapters scaffold writes a manifest that then shows + validates", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const r = runCli(["design", "adapters", "scaffold", "qt", "--framework", "Qt Quick"], workspaceRoot);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Scaffolded/);
    const file = path.join(workspaceRoot, ".atelier", "ui-adapters", "qt.yaml");
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /id: qt/);
    assert.match(text, /framework: Qt Quick/);

    // It loads + shows (the template is valid as-authored).
    const show = runCli(["design", "adapters", "show", "qt"], workspaceRoot);
    assert.equal(show.status, 0, `stderr: ${show.stderr}`);
    assert.match(show.stdout, /Qt Quick/);
    assert.match(show.stdout, /user/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design adapters scaffold refuses to overwrite without --force", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    assert.equal(runCli(["design", "adapters", "scaffold", "qt"], workspaceRoot).status, 0);
    const again = runCli(["design", "adapters", "scaffold", "qt"], workspaceRoot);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(runCli(["design", "adapters", "scaffold", "qt", "--force"], workspaceRoot).status, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design adapters scaffold rejects a non-slug id", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const r = runCli(["design", "adapters", "scaffold", "Qt Quick"], workspaceRoot);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a valid adapter id/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
