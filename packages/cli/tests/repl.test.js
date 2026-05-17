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

function runRepl(input, cwd, extraArgs = []) {
  return spawnSync(process.execPath, [CLI_ENTRY, "--repl", ...extraArgs], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    input,
  });
}

async function workspace(name = "Test") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repl-"));
  const init = spawnSync(
    process.execPath,
    [CLI_ENTRY, "init", "--name", name],
    { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }
  );
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

test("atelier with no args + non-TTY stdin falls back to one-shot help", async () => {
  const result = spawnSync(process.execPath, [CLI_ENTRY], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    input: "",
  });
  assert.equal(result.status, 0);
  // Old behavior preserved for piped/CI contexts.
  assert.match(result.stdout, /Commands:/);
  assert.doesNotMatch(result.stdout, /atelier ❯/);
});

test("atelier --repl shows the REPL banner with workspace context", async () => {
  const ws = await workspace("My Workspace");
  try {
    const result = runRepl("/quit\n", ws);
    assert.equal(result.status, 0, result.stderr);
    // ASCII logo: pick a unique fragment of the figlet "A" + tagline.
    assert.match(result.stdout, /\/_\/   \\_\\/);
    assert.match(result.stdout, /planning companion/);
    assert.match(result.stdout, /v\d+\.\d+\.\d+/);
    assert.match(result.stdout, /Workspace: My Workspace/);
    assert.match(result.stdout, /Inventory: 0 repo/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("atelier --repl /help lists slash commands", async () => {
  const ws = await workspace();
  try {
    const result = runRepl("/help\n/quit\n", ws);
    assert.equal(result.status, 0, result.stderr);
    for (const expected of ["/help", "/status", "/init", "/repo", "/source", "/sync", "/spec"]) {
      assert.match(result.stdout, new RegExp(expected.replace("/", "\\/")));
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("REPL dispatches /feature add to the underlying CLI", async () => {
  const ws = await workspace();
  try {
    const result = runRepl(
      '/feature add "CSV Export"\n/feature list\n/quit\n',
      ws
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Added feature/);
    assert.match(result.stdout, /csv-export/);
    // Verify on disk too.
    const yaml = await fs.readFile(
      path.join(ws, ".planning", "features", "csv-export.md"),
      "utf8"
    );
    assert.match(yaml, /name: CSV Export/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("REPL ignores plain (non-slash) lines with a hint", async () => {
  const ws = await workspace();
  try {
    const result = runRepl("hello\n/quit\n", ws);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Commands start with/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("REPL detects 'no workspace' context and suggests /init", async () => {
  // Two-level nesting so the sibling-scan in findNearbyWorkspace has
  // no neighbors from other test fixtures in /var/folders/.../T/.
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repl-empty-"));
  try {
    const empty = path.join(outer, "isolated");
    await fs.mkdir(empty);
    const result = runRepl("/quit\n", empty);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No workspace found/);
    assert.match(result.stdout, /\/init/);
  } finally {
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test("REPL suggests a nearby workspace when run inside a code repo next to one", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repl-near-"));
  try {
    const planning = path.join(umbrella, "planning");
    await fs.mkdir(planning);
    const init = spawnSync(
      process.execPath,
      [CLI_ENTRY, "init", "--name", "WS"],
      { cwd: planning, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }
    );
    assert.equal(init.status, 0, init.stderr);
    // Make a sibling code repo, no remote.
    const apiDir = path.join(umbrella, "api");
    await fs.mkdir(path.join(apiDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(apiDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/api.git\n`,
      "utf8"
    );
    // Run REPL from inside the api repo. Decline the auto-register.
    const result = runRepl("n\n/quit\n", apiDir);
    assert.equal(result.status, 0, result.stderr);
    // Either the welcome surfaced the nearby workspace, or it triggered
    // the auto-register offer (it found one). Both prove the detection
    // worked.
    assert.ok(
      /Nearby workspace/.test(result.stdout) ||
        /you're inside a git repo at/i.test(result.stdout),
      `expected nearby-workspace cue, got:\n${result.stdout}`
    );
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("REPL auto-register flow registers the current repo on y", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repl-auto-"));
  try {
    const planning = path.join(umbrella, "planning");
    await fs.mkdir(planning);
    spawnSync(process.execPath, [CLI_ENTRY, "init", "--name", "WS"], {
      cwd: planning,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const apiDir = path.join(umbrella, "api");
    await fs.mkdir(path.join(apiDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(apiDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/api.git\n`,
      "utf8"
    );
    // Run REPL from planning/ (so workspace is there), but the user
    // is inside a git repo there too. Actually, that's a sibling case.
    // Test the auto-register from being inside the api repo with a
    // sibling planning. Note: when stdin is piped (non-TTY), the
    // confirm prompt accepts y/n from the stream.
    const result = runRepl("y\n/quit\n", apiDir);
    assert.equal(result.status, 0, result.stderr);
    // The api repo should now be registered in the planning workspace.
    const reposYaml = await fs.readFile(
      path.join(planning, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.match(reposYaml, /name: api/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("REPL /quit and /exit and 'quit' all exit cleanly", async () => {
  const ws = await workspace();
  try {
    for (const quitCmd of ["/quit", "/exit", "quit", "exit"]) {
      const result = runRepl(`${quitCmd}\n`, ws);
      assert.equal(result.status, 0, `${quitCmd} failed: ${result.stderr}`);
      assert.match(result.stdout, /Bye\./);
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("REPL handles input stream ending cleanly (Ctrl-D equivalent)", async () => {
  const ws = await workspace();
  try {
    // Empty input → stream EOFs immediately after the banner.
    const result = runRepl("", ws);
    assert.equal(result.status, 0);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
