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

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-source-cli-"));
  const result = runCli(["init", "--name", "Test"], root);
  assert.equal(result.status, 0, `init failed: ${result.stderr}`);
  return root;
}

test("atelier source --help lists subcommands", () => {
  const result = runCli(["source", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /remove/);
  assert.match(result.stdout, /enable/);
  assert.match(result.stdout, /disable/);
});

test("atelier source add registers a notion source", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      ["source", "add", "notion", "--name", "Company Notion", "--mcp", "company-notion"],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Registered source/);
    assert.match(result.stdout, /company-notion/);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /kind: notion/);
    assert.match(yaml, /name: Company Notion/);
    assert.match(yaml, /mcpServer: company-notion/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add with --scope-json stores scope", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "add",
        "confluence",
        "--name",
        "Eng Wiki",
        "--scope-json",
        '{"spaceKey":"ENG","baseUrl":"https://example.atlassian.net/wiki"}',
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /spaceKey: ENG/);
    assert.match(yaml, /baseUrl: https:\/\/example\.atlassian\.net\/wiki/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add rejects invalid kind", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      ["source", "add", "tiktok", "--name", "TT"],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown source kind/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add rejects missing name", async () => {
  const root = await workspace();
  try {
    const result = runCli(["source", "add", "notion"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing --name/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add rejects missing kind", async () => {
  const root = await workspace();
  try {
    const result = runCli(["source", "add"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing <kind>/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add rejects invalid scope JSON", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "add",
        "notion",
        "--name",
        "X",
        "--scope-json",
        "not json {{",
      ],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be valid JSON/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source list with no sources shows hint", async () => {
  const root = await workspace();
  try {
    const result = runCli(["source", "list"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No documentation sources/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source list shows registered sources", async () => {
  const root = await workspace();
  try {
    runCli(["source", "add", "notion", "--name", "Main", "--mcp", "notion-mcp"], root);
    runCli(["source", "add", "confluence", "--name", "Wiki"], root);
    const result = runCli(["source", "list"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /ID/);
    assert.match(result.stdout, /KIND/);
    assert.match(result.stdout, /main/);
    assert.match(result.stdout, /wiki/);
    assert.match(result.stdout, /notion-mcp/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source remove unregisters by id", async () => {
  const root = await workspace();
  try {
    runCli(["source", "add", "notion", "--name", "X", "--id", "x"], root);
    const result = runCli(["source", "remove", "x"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Unregistered/);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.doesNotMatch(yaml, /id: x/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source remove errors on unknown id", async () => {
  const root = await workspace();
  try {
    const result = runCli(["source", "remove", "ghost"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No registered source/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source disable then enable toggles status", async () => {
  const root = await workspace();
  try {
    runCli(["source", "add", "notion", "--name", "X", "--id", "x"], root);
    let result = runCli(["source", "disable", "x"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Disabled/);
    let yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /enabled: false/);

    result = runCli(["source", "enable", "x"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /enabled: true/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source add outside workspace errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-nows-"));
  try {
    const result = runCli(["source", "add", "notion", "--name", "X"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not inside an Atelier workspace/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source list shows enabled vs disabled marker", async () => {
  const root = await workspace();
  try {
    runCli(["source", "add", "notion", "--name", "On", "--id", "on"], root);
    runCli(["source", "add", "confluence", "--name", "Off", "--id", "off"], root);
    runCli(["source", "disable", "off"], root);

    const result = runCli(["source", "list"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /off.*disabled/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
