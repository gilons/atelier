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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-sync-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  const docsDir = path.join(umbrella, "docs");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "Test"], workspaceRoot);
  assert.equal(init.status, 0, init.stderr);
  await fs.mkdir(docsDir, { recursive: true });
  return { umbrella, workspaceRoot, docsDir };
}

test("atelier sync --help shows description", () => {
  const result = runCli(["sync", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Pull docs/);
});

test("atelier sync with no sources prints hint", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["sync"], workspaceRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No enabled sources/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier sync against a local-folder source creates docs", async () => {
  const { umbrella, workspaceRoot, docsDir } = await setup();
  try {
    await fs.writeFile(path.join(docsDir, "intro.md"), "# Intro\n\nHi.\n", "utf8");
    await fs.mkdir(path.join(docsDir, "guide"), { recursive: true });
    await fs.writeFile(path.join(docsDir, "guide/setup.md"), "# Setup\n", "utf8");
    const addSrc = runCli(
      [
        "source",
        "add",
        "local-folder",
        "--name",
        "Local Docs",
        "--scope-json",
        JSON.stringify({ root: "../docs" }),
      ],
      workspaceRoot
    );
    assert.equal(addSrc.status, 0, addSrc.stderr);

    const sync = runCli(["sync"], workspaceRoot);
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(sync.stdout, /Source: local-docs/);
    assert.match(sync.stdout, /2 created/);
    // Verify the docs landed.
    const list = runCli(["doc", "list"], workspaceRoot);
    assert.match(list.stdout, /intro\.md/);
    assert.match(list.stdout, /guide\/setup\.md/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier sync --dry-run announces no writes", async () => {
  const { umbrella, workspaceRoot, docsDir } = await setup();
  try {
    await fs.writeFile(path.join(docsDir, "x.md"), "# X", "utf8");
    runCli(
      [
        "source",
        "add",
        "local-folder",
        "--name",
        "L",
        "--scope-json",
        JSON.stringify({ root: "../docs" }),
      ],
      workspaceRoot
    );
    const result = runCli(["sync", "--dry-run"], workspaceRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run/);
    // No docs persisted.
    const list = runCli(["doc", "list"], workspaceRoot);
    assert.match(list.stdout, /No docs indexed yet/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier sync --verbose prints per-doc actions", async () => {
  const { umbrella, workspaceRoot, docsDir } = await setup();
  try {
    await fs.writeFile(path.join(docsDir, "x.md"), "# X", "utf8");
    runCli(
      [
        "source",
        "add",
        "local-folder",
        "--name",
        "L",
        "--scope-json",
        JSON.stringify({ root: "../docs" }),
      ],
      workspaceRoot
    );
    const result = runCli(["sync", "--verbose"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /x\.md/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier sync against an MCP source whose server is not configured is skipped", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    // Use a server id astronomically unlikely to exist in any user's
    // ~/.atelier/mcp-servers.json — keeps the test deterministic
    // regardless of the dev machine.
    runCli(
      [
        "source",
        "add",
        "notion",
        "--name",
        "Company Notion",
        "--mcp",
        "atelier-test-no-such-server-9c2f8",
      ],
      workspaceRoot
    );
    const result = runCli(["sync"], workspaceRoot);
    // The command itself exits 0 — failures are per-source in the report.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipped:/);
    assert.match(result.stdout, /company-notion/);
    assert.match(result.stdout, /no such server is defined/i);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
