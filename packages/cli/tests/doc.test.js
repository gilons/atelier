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

async function workspaceWithNotion() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-doc-cli-"));
  const init = runCli(["init", "--name", "Test"], root);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  const addSource = runCli(
    ["source", "add", "notion", "--name", "Company Notion"],
    root
  );
  assert.equal(addSource.status, 0, `source add failed: ${addSource.stderr}`);
  return root;
}

test("atelier doc --help lists subcommands", () => {
  const result = runCli(["doc", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Subcommands:/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /show/);
  assert.match(result.stdout, /update/);
  assert.match(result.stdout, /remove/);
});

test("atelier doc add registers an entry", async () => {
  const root = await workspaceWithNotion();
  try {
    const result = runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "page-abc",
        "--title",
        "Onboarding PRD",
        "--classification",
        "prd",
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Indexed doc/);
    const filePath = path.join(
      root,
      ".planning",
      "docs",
      "company-notion",
      "page-abc.md"
    );
    const text = await fs.readFile(filePath, "utf8");
    assert.match(text, /source: company-notion/);
    assert.match(text, /classification: prd/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc add rejects unregistered source", async () => {
  const root = await workspaceWithNotion();
  try {
    const result = runCli(
      ["doc", "add", "--source", "ghost", "--doc-id", "x", "--title", "X"],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not registered/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc add --no-validate-source bypasses source check", async () => {
  const root = await workspaceWithNotion();
  try {
    const result = runCli(
      [
        "doc",
        "add",
        "--source",
        "ghost",
        "--doc-id",
        "x",
        "--title",
        "X",
        "--no-validate-source",
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc add --body-file reads body from disk", async () => {
  const root = await workspaceWithNotion();
  const bodyPath = path.join(root, "body.md");
  try {
    await fs.writeFile(bodyPath, "# Doc Body\n\nLorem ipsum.\n", "utf8");
    const result = runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "page-1",
        "--title",
        "Page 1",
        "--body-file",
        bodyPath,
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const stored = await fs.readFile(
      path.join(root, ".planning", "docs", "company-notion", "page-1.md"),
      "utf8"
    );
    assert.match(stored, /# Doc Body/);
    assert.match(stored, /Lorem ipsum/);
    assert.match(stored, /contentHash: sha256:/);
    assert.match(stored, /lastFetched: /);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc list shows registered docs", async () => {
  const root = await workspaceWithNotion();
  try {
    runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "a",
        "--title",
        "A",
      ],
      root
    );
    runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "b",
        "--title",
        "B",
        "--classification",
        "prd",
      ],
      root
    );
    const result = runCli(["doc", "list"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /company-notion/);
    assert.match(result.stdout, /\ba\b/);
    assert.match(result.stdout, /\bb\b/);
    assert.match(result.stdout, /prd/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc list --classification filters", async () => {
  const root = await workspaceWithNotion();
  try {
    runCli(
      ["doc", "add", "--source", "company-notion", "--doc-id", "a", "--title", "A"],
      root
    );
    runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "b",
        "--title",
        "B",
        "--classification",
        "prd",
      ],
      root
    );
    const result = runCli(["doc", "list", "--classification", "prd"], root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\bb\b/);
    assert.doesNotMatch(result.stdout, /·\s+company-notion\s+a\s/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc show prints metadata and body", async () => {
  const root = await workspaceWithNotion();
  try {
    runCli(
      [
        "doc",
        "add",
        "--source",
        "company-notion",
        "--doc-id",
        "p",
        "--title",
        "Title",
        "--summary",
        "Summary line",
      ],
      root
    );
    const result = runCli(["doc", "show", "company-notion", "p"], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Title/);
    assert.match(result.stdout, /Summary line/);
    assert.match(result.stdout, /docId:\s+p/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc update changes the title", async () => {
  const root = await workspaceWithNotion();
  try {
    runCli(
      ["doc", "add", "--source", "company-notion", "--doc-id", "x", "--title", "Old"],
      root
    );
    const update = runCli(
      ["doc", "update", "company-notion", "x", "--title", "New"],
      root
    );
    assert.equal(update.status, 0, `stderr: ${update.stderr}`);
    const show = runCli(["doc", "show", "company-notion", "x"], root);
    assert.match(show.stdout, /^New\b/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier doc remove deletes the file", async () => {
  const root = await workspaceWithNotion();
  try {
    runCli(
      ["doc", "add", "--source", "company-notion", "--doc-id", "x", "--title", "X"],
      root
    );
    const result = runCli(["doc", "remove", "company-notion", "x"], root);
    assert.equal(result.status, 0);
    const exists = await fs
      .access(path.join(root, ".planning", "docs", "company-notion", "x.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
