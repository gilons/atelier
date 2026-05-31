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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-doc-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("atelier doc add + list + show round-trips", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const add = runCli(
      ["doc", "add", "notion:prd-1", "--title", "Onboarding PRD", "--class", "prd", "--owner", "sarah-chen", "--link", "https://notion.so/x", "--body-text", "The sign-up flow.", "--no-validate-source"],
      workspaceRoot
    );
    assert.equal(add.status, 0, `stderr: ${add.stderr}\nstdout: ${add.stdout}`);
    assert.match(add.stdout, /Indexed documentation notion:prd-1/);

    const list = runCli(["doc", "list"], workspaceRoot);
    assert.match(list.stdout, /notion:prd-1/);
    assert.match(list.stdout, /\[prd\]/);

    const show = runCli(["doc", "show", "notion:prd-1"], workspaceRoot);
    assert.match(show.stdout, /Onboarding PRD/);
    assert.match(show.stdout, /sarah-chen/);
    assert.match(show.stdout, /The sign-up flow\./);

    // Lands at documentation/notion/prd-1/summary.md
    const file = path.join(workspaceRoot, ".atelier", "documentation", "notion", "prd-1", "summary.md");
    assert.match(await fs.readFile(file, "utf8"), /classification: prd/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier doc shows in the map", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["doc", "add", "notion:prd-1", "--title", "Onboarding PRD", "--no-validate-source"], workspaceRoot);
    const map = runCli(["map"], workspaceRoot);
    assert.equal(map.status, 0, `stderr: ${map.stderr}`);
    assert.match(map.stdout, /Documentation/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
