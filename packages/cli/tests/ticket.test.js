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
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-ticket-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("atelier ticket add + list + update status round-trips", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const add = runCli(
      ["ticket", "add", "linear:ENG-1421", "--title", "Add SSO", "--status", "open", "--assignee", "sarah-chen", "--link", "https://linear.app/x", "--no-validate-source"],
      workspaceRoot
    );
    assert.equal(add.status, 0, `stderr: ${add.stderr}\nstdout: ${add.stdout}`);
    assert.match(add.stdout, /Indexed ticket linear:ENG-1421/);

    const list = runCli(["ticket", "list"], workspaceRoot);
    assert.match(list.stdout, /linear:ENG-1421/);
    assert.match(list.stdout, /\[open\]/);

    const up = runCli(["ticket", "update", "linear:ENG-1421", "--status", "in-progress"], workspaceRoot);
    assert.match(up.stdout, /\[in-progress\]/);

    const file = path.join(workspaceRoot, ".atelier", "tickets", "linear", "ENG-1421", "summary.md");
    assert.match(await fs.readFile(file, "utf8"), /status: in-progress/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier ticket shows in the map", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["ticket", "add", "linear:ENG-1", "--title", "Add SSO", "--no-validate-source"], workspaceRoot);
    const map = runCli(["map"], workspaceRoot);
    assert.equal(map.status, 0, `stderr: ${map.stderr}`);
    assert.match(map.stdout, /Tickets/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
