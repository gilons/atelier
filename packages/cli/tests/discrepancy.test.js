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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-disc-cli-"));
  const init = runCli(["init", "--name", "Test"], root);
  assert.equal(init.status, 0, `init: ${init.stderr}`);
  return root;
}

test("atelier discrepancy --help lists subcommands", () => {
  const result = runCli(["discrepancy", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /show/);
  assert.match(result.stdout, /resolve/);
  assert.match(result.stdout, /remove/);
});

test("atelier discrepancy add logs an entry", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "discrepancy",
        "add",
        "--feature",
        "auth",
        "--claim",
        "Tokens last 24h",
        "--observed",
        "Tokens last 1h",
        "--severity",
        "high",
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Logged discrepancy/);
    const yaml = await fs.readFile(
      path.join(root, ".planning", "discrepancies.yaml"),
      "utf8"
    );
    assert.match(yaml, /severity: high/);
    assert.match(yaml, /Tokens last 24h/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy add validates --severity and --status", async () => {
  const root = await workspace();
  try {
    const sev = runCli(
      [
        "discrepancy",
        "add",
        "--claim",
        "c",
        "--observed",
        "o",
        "--severity",
        "extreme",
      ],
      root
    );
    assert.notEqual(sev.status, 0);
    assert.match(sev.stderr, /Invalid --severity/);
    const status = runCli(
      ["discrepancy", "add", "--claim", "c", "--observed", "o", "--status", "weird"],
      root
    );
    assert.notEqual(status.status, 0);
    assert.match(status.stderr, /Invalid --status/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy add records doc-ref and code-ref", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "discrepancy",
        "add",
        "--id",
        "x",
        "--claim",
        "c",
        "--observed",
        "o",
        "--doc-ref",
        "notion:page-123",
        "--code-ref",
        "api:src/auth/",
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const show = runCli(["discrepancy", "show", "x"], root);
    assert.match(show.stdout, /notion:page-123/);
    assert.match(show.stdout, /api:src\/auth\//);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy list filters by --severity", async () => {
  const root = await workspace();
  try {
    runCli(
      ["discrepancy", "add", "--id", "a", "--claim", "c", "--observed", "o", "--severity", "low"],
      root
    );
    runCli(
      [
        "discrepancy",
        "add",
        "--id",
        "b",
        "--claim",
        "c",
        "--observed",
        "o",
        "--severity",
        "critical",
      ],
      root
    );
    const result = runCli(["discrepancy", "list", "--severity", "critical"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\bb\b/);
    assert.doesNotMatch(result.stdout, /·\s+a\s+low/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy resolve marks as resolved with appended note", async () => {
  const root = await workspace();
  try {
    runCli(
      ["discrepancy", "add", "--id", "x", "--claim", "c", "--observed", "o"],
      root
    );
    const result = runCli(
      ["discrepancy", "resolve", "x", "--note", "Fixed in v1.2"],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const show = runCli(["discrepancy", "show", "x"], root);
    assert.match(show.stdout, /status:\s+resolved/);
    assert.match(show.stdout, /Fixed in v1\.2/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy remove deletes entry", async () => {
  const root = await workspace();
  try {
    runCli(["discrepancy", "add", "--id", "x", "--claim", "c", "--observed", "o"], root);
    const result = runCli(["discrepancy", "remove", "x"], root);
    assert.equal(result.status, 0);
    const show = runCli(["discrepancy", "show", "x"], root);
    assert.notEqual(show.status, 0);
    assert.match(show.stderr, /No discrepancy with id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier discrepancy list with no entries shows hint", async () => {
  const root = await workspace();
  try {
    const result = runCli(["discrepancy", "list"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No discrepancies/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
