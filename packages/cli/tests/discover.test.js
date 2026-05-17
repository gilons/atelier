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
const FAKE_GH_SOURCE = path.resolve(__dirname, "fixtures/fake-gh.mjs");

/**
 * Build a shim directory containing an executable `gh` that delegates
 * to our fake-gh.mjs. Prepending this to PATH makes the CLI's
 * GhAdapter find our fake instead of the real one.
 */
async function makeFakeGhDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-fakegh-"));
  const ghPath = path.join(dir, "gh");
  // Use a shell wrapper so it's executable + delegates to node.
  const shim = `#!/bin/sh\nexec ${process.execPath} ${FAKE_GH_SOURCE} "$@"\n`;
  await fs.writeFile(ghPath, shim, { mode: 0o755 });
  return dir;
}

function runCli(args, cwd, extraEnv = {}) {
  const fakeGhDir = extraEnv.__fakeGhDir;
  const env = { ...process.env, NO_COLOR: "1", ...extraEnv };
  delete env.__fakeGhDir;
  if (fakeGhDir) {
    env.PATH = `${fakeGhDir}${path.delimiter}${env.PATH}`;
  }
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

async function setupCanonicalWithApi() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-discover-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  let result = runCli(["init", "--name", "TestWS"], workspaceRoot);
  assert.equal(result.status, 0, `init failed: ${result.stderr}`);

  // Build a sibling `api` repo and register it (which also sets organization).
  const apiDir = path.join(umbrella, "api");
  await fs.mkdir(path.join(apiDir, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(apiDir, ".git", "config"),
    `[remote "origin"]\n\turl = git@github.com:myorg/api.git\n`,
    "utf8"
  );
  result = runCli(["repo", "add", "../api"], workspaceRoot);
  assert.equal(result.status, 0, `repo add failed: ${result.stderr}`);

  return { umbrella, workspaceRoot };
}

test("repo discover errors when no organization is set", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-noorg-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  runCli(["init", "--name", "Test"], workspaceRoot);
  try {
    const result = runCli(["repo", "discover"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No organization/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("repo discover errors when gh is not installed", async () => {
  const { umbrella, workspaceRoot } = await setupCanonicalWithApi();
  const fakeGhDir = await makeFakeGhDir();
  try {
    const result = runCli(["repo", "discover"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_AVAILABLE: "0",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not found|cli\.github\.com/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo discover errors when gh is not authenticated", async () => {
  const { umbrella, workspaceRoot } = await setupCanonicalWithApi();
  const fakeGhDir = await makeFakeGhDir();
  try {
    const result = runCli(["repo", "discover"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_AUTHED: "0",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not authenticated|auth login/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo discover lists candidates with status hints", async () => {
  const { umbrella, workspaceRoot } = await setupCanonicalWithApi();
  const fakeGhDir = await makeFakeGhDir();
  try {
    // Build a sibling `web` cloned locally but NOT registered.
    const webDir = path.join(umbrella, "web");
    await fs.mkdir(path.join(webDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(webDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:myorg/web.git\n`,
      "utf8"
    );

    const reposJson = JSON.stringify([
      {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        url: "https://github.com/myorg/api",
        description: "Backend",
        isPrivate: true,
      },
      {
        name: "web",
        sshUrl: "git@github.com:myorg/web.git",
        url: "https://github.com/myorg/web",
        description: "Web frontend",
        isPrivate: false,
      },
      {
        name: "mobile",
        sshUrl: "git@github.com:myorg/mobile.git",
        url: "https://github.com/myorg/mobile",
        description: null,
        isPrivate: false,
      },
    ]);

    const result = runCli(["repo", "discover"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_REPOS_JSON: reposJson,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Found:\s+3 repos/);
    assert.match(result.stdout, /Registered:\s+1/);
    assert.match(result.stdout, /Unregistered:\s+2/);
    assert.match(result.stdout, /web.*cloned locally/);
    assert.match(result.stdout, /mobile.*not cloned/);
    // The suggested add command for web (cloned locally).
    assert.match(result.stdout, /atelier repo add \.\.\/web/);
    // The suggested clone+add hint for mobile (not cloned).
    assert.match(result.stdout, /gh repo clone.*mobile/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo discover --add-cloned registers locally-cloned candidates", async () => {
  const { umbrella, workspaceRoot } = await setupCanonicalWithApi();
  const fakeGhDir = await makeFakeGhDir();
  try {
    // Two siblings cloned, neither registered (api is already registered above).
    const webDir = path.join(umbrella, "web");
    await fs.mkdir(path.join(webDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(webDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:myorg/web.git\n`,
      "utf8"
    );
    const mobDir = path.join(umbrella, "mobile");
    await fs.mkdir(path.join(mobDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(mobDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:myorg/mobile.git\n`,
      "utf8"
    );

    const reposJson = JSON.stringify([
      { name: "api", sshUrl: "git@github.com:myorg/api.git", url: "https://github.com/myorg/api", description: null, isPrivate: false },
      { name: "web", sshUrl: "git@github.com:myorg/web.git", url: "https://github.com/myorg/web", description: "Frontend", isPrivate: false },
      { name: "mobile", sshUrl: "git@github.com:myorg/mobile.git", url: "https://github.com/myorg/mobile", description: null, isPrivate: false },
      { name: "internal", sshUrl: "git@github.com:myorg/internal.git", url: "https://github.com/myorg/internal", description: null, isPrivate: true },
    ]);

    const result = runCli(["repo", "discover", "--add-cloned"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_REPOS_JSON: reposJson,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Added:.*2/);
    assert.match(result.stdout, /web/);
    assert.match(result.stdout, /mobile/);

    // Verify they're in repos.yaml now.
    const repos = await fs.readFile(
      path.join(workspaceRoot, ".planning", "repos.yaml"),
      "utf8"
    );
    assert.match(repos, /name: web/);
    assert.match(repos, /name: mobile/);
    // `internal` not cloned, should NOT have been added.
    assert.doesNotMatch(repos, /name: internal/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo discover accepts --org override", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-orgflag-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  runCli(["init", "--name", "Test"], workspaceRoot);
  const fakeGhDir = await makeFakeGhDir();
  try {
    const result = runCli(["repo", "discover", "--org", "explicitorg"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_REPOS_JSON: "[]",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /explicitorg/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo discover errors when gh repo list fails", async () => {
  const { umbrella, workspaceRoot } = await setupCanonicalWithApi();
  const fakeGhDir = await makeFakeGhDir();
  try {
    const result = runCli(["repo", "discover"], workspaceRoot, {
      __fakeGhDir: fakeGhDir,
      ATELIER_FAKE_GH_LIST_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gh repo list|API rate limit/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
    await fs.rm(fakeGhDir, { recursive: true, force: true });
  }
});
