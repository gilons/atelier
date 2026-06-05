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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-project-cli-"));
  const result = runCli(["init", "--name", "TestWS"], root);
  assert.equal(result.status, 0, `init failed: ${result.stderr}`);
  return root;
}

test("atelier project --help lists subcommands", () => {
  const result = runCli(["project", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /use/);
  assert.match(result.stdout, /show/);
  assert.match(result.stdout, /remove/);
});

test("project list on a fresh workspace says everything is global", async () => {
  const root = await setupWorkspace();
  try {
    const result = runCli(["project", "list"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /global/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project add registers and derives an id", async () => {
  const root = await setupWorkspace();
  try {
    const result = runCli(["project", "add", "Acme Corp"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered project/);
    assert.match(result.stdout, /acme-corp/);
    // appears in list
    const list = runCli(["project", "list"], root);
    assert.match(list.stdout, /acme-corp/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project add --use pins it as active", async () => {
  const root = await setupWorkspace();
  try {
    const result = runCli(["project", "add", "Acme", "--id", "acme", "--use"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /active project/i);
    // pin file written and gitignored content present
    const pin = await fs.readFile(path.join(root, ".atelier", ".active-project"), "utf8");
    assert.equal(pin.trim(), "acme");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project use pins, show reflects it, use --clear unpins", async () => {
  const root = await setupWorkspace();
  try {
    runCli(["project", "add", "Acme", "--id", "acme"], root);
    const use = runCli(["project", "use", "acme"], root);
    assert.equal(use.status, 0, use.stderr);
    assert.match(use.stdout, /Active project/);

    const show = runCli(["project", "show"], root);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /acme/);
    assert.match(show.stdout, /active/i);

    const clear = runCli(["project", "use", "--clear"], root);
    assert.equal(clear.status, 0, clear.stderr);
    assert.match(clear.stdout, /Cleared/);
    await assert.rejects(() => fs.stat(path.join(root, ".atelier", ".active-project")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project use on an unknown id errors", async () => {
  const root = await setupWorkspace();
  try {
    const result = runCli(["project", "use", "nope"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /No project with id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project remove unregisters and clears an active pin", async () => {
  const root = await setupWorkspace();
  try {
    runCli(["project", "add", "Acme", "--id", "acme", "--use"], root);
    const rm = runCli(["project", "remove", "acme"], root);
    assert.equal(rm.status, 0, rm.stderr);
    assert.match(rm.stdout, /Unregistered project/);
    await assert.rejects(() => fs.stat(path.join(root, ".atelier", ".active-project")));
    const list = runCli(["project", "list"], root);
    assert.doesNotMatch(list.stdout, /acme/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project add rejects a reserved id", async () => {
  const root = await setupWorkspace();
  try {
    const result = runCli(["project", "add", "All", "--id", "all"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /reserved/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
