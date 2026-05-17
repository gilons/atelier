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

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "atelier-cli-test-"));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("atelier --version prints a version", () => {
  const result = runCli(["--version"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test("atelier --help prints usage and exits 0", () => {
  const result = runCli(["--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /init/);
});

test("atelier with no args prints help", () => {
  const result = runCli([], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("atelier <unknown> exits non-zero", () => {
  const result = runCli(["nope"], process.cwd());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command/);
});

test("atelier init creates a planning workspace", async () => {
  const root = await makeTempDir();
  try {
    const result = runCli(["init", "--name", "MyProduct"], root);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const planning = path.join(root, ".planning");
    const stat = await fs.stat(planning);
    assert.ok(stat.isDirectory());
    // workspace.yaml exists and contains the name
    const ws = await fs.readFile(path.join(planning, "workspace.yaml"), "utf8");
    assert.match(ws, /name: MyProduct/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier init refuses to overwrite existing workspace", async () => {
  const root = await makeTempDir();
  try {
    let result = runCli(["init", "--name", "First"], root);
    assert.equal(result.status, 0);
    result = runCli(["init", "--name", "Second"], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier init --force overwrites existing workspace", async () => {
  const root = await makeTempDir();
  try {
    let result = runCli(["init", "--name", "First"], root);
    assert.equal(result.status, 0);
    result = runCli(["init", "--name", "Second", "--force"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const ws = await fs.readFile(path.join(root, ".planning", "workspace.yaml"), "utf8");
    assert.match(ws, /name: Second/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier init defaults workspace name to directory basename", async () => {
  const parent = await makeTempDir();
  const root = path.join(parent, "MyOrg");
  await fs.mkdir(root);
  try {
    const result = runCli(["init"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const ws = await fs.readFile(path.join(root, ".planning", "workspace.yaml"), "utf8");
    assert.match(ws, /name: MyOrg/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("atelier init --help shows command-specific help", () => {
  const result = runCli(["init", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /atelier init/);
  assert.match(result.stdout, /--force/);
});
