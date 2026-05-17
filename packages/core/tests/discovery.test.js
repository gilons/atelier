import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  discoverRepos,
  suggestedAddCommand,
} from "../dist/index.js";

// Build a fake host adapter that returns canned data.
function fakeHost(repos) {
  return {
    id: "fake",
    displayName: "Fake",
    async checkAvailability() {
      return { available: true };
    },
    async listOrgRepos() {
      return repos;
    },
  };
}

async function setupCanonical() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-discover-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "TestWorkspace" });
  return { umbrella, workspaceRoot };
}

async function makeSiblingRepo(umbrella, name, sshUrl) {
  const dir = path.join(umbrella, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".git", "config"),
    `[remote "origin"]\n\turl = ${sshUrl}\n`,
    "utf8"
  );
  return dir;
}

test("discoverRepos categorizes registered, unregistered, and missing-locally", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    // Create three local repos as siblings.
    await makeSiblingRepo(umbrella, "api", "git@github.com:myorg/api.git");
    await makeSiblingRepo(umbrella, "web", "git@github.com:myorg/web.git");
    await makeSiblingRepo(umbrella, "internal", "git@github.com:myorg/internal.git");

    // Register only `api`.
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

    // The host claims four repos exist: api, web, internal, mobile.
    // `mobile` isn't cloned locally.
    const host = fakeHost([
      {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        httpsUrl: "https://github.com/myorg/api",
        description: "Backend",
        isPrivate: true,
      },
      {
        name: "web",
        sshUrl: "git@github.com:myorg/web.git",
        httpsUrl: "https://github.com/myorg/web",
        description: null,
        isPrivate: false,
      },
      {
        name: "internal",
        sshUrl: "git@github.com:myorg/internal.git",
        httpsUrl: "https://github.com/myorg/internal",
        description: "Internal tools",
        isPrivate: true,
      },
      {
        name: "mobile",
        sshUrl: "git@github.com:myorg/mobile.git",
        httpsUrl: "https://github.com/myorg/mobile",
        description: null,
        isPrivate: false,
      },
    ]);

    const result = await discoverRepos(workspaceRoot, "myorg", host);
    assert.equal(result.organization, "myorg");
    assert.equal(result.repos.length, 4);
    assert.equal(result.unregistered.length, 3); // web, internal, mobile

    const byName = Object.fromEntries(result.repos.map((r) => [r.remote.name, r]));
    assert.equal(byName.api.registered, true);
    assert.equal(byName.api.localPath?.endsWith("/api"), true);
    assert.equal(byName.web.registered, false);
    assert.equal(byName.web.localPath?.endsWith("/web"), true);
    assert.equal(byName.mobile.registered, false);
    assert.equal(byName.mobile.localPath, null);

    // missingLocally only contains repos that ARE registered but missing.
    assert.equal(result.missingLocally.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("discoverRepos flags registered-but-missing-locally", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await makeSiblingRepo(umbrella, "api", "git@github.com:myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

    // Now remove the local clone — registered but missing locally.
    await fs.rm(path.join(umbrella, "api"), { recursive: true, force: true });

    const host = fakeHost([
      {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        httpsUrl: "https://github.com/myorg/api",
        description: null,
        isPrivate: true,
      },
    ]);

    const result = await discoverRepos(workspaceRoot, "myorg", host);
    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].registered, true);
    assert.equal(result.repos[0].localPath, null);
    assert.equal(result.missingLocally.length, 1);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("suggestedAddCommand uses local path when present", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await makeSiblingRepo(umbrella, "api", "git@github.com:myorg/api.git");
    const localPath = path.join(umbrella, "api");
    const repo = {
      remote: {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        httpsUrl: "",
        description: null,
        isPrivate: false,
      },
      registered: false,
      localPath,
    };
    const cmd = suggestedAddCommand(repo, workspaceRoot);
    assert.match(cmd, /atelier repo add \.\.\/api/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("suggestedAddCommand suggests clone+add when not cloned", async () => {
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    const repo = {
      remote: {
        name: "mobile",
        sshUrl: "git@github.com:myorg/mobile.git",
        httpsUrl: "",
        description: null,
        isPrivate: false,
      },
      registered: false,
      localPath: null,
    };
    const cmd = suggestedAddCommand(repo, workspaceRoot);
    assert.match(cmd, /gh repo clone mobile/);
    assert.match(cmd, /atelier repo add \.\.\/mobile/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("discoverRepos matches when gh reports httpsUrl without .git suffix", async () => {
  // Real `gh repo list --json url` returns the HTTPS URL WITHOUT a `.git`
  // suffix (e.g. `https://github.com/org/api`), but `.git/config` stores
  // it WITH the suffix. The matcher must normalize trailing `.git` to
  // see these as the same repo.
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await makeSiblingRepo(umbrella, "api", "https://github.com/myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

    const host = fakeHost([
      {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        httpsUrl: "https://github.com/myorg/api", // no .git, as gh returns
        description: null,
        isPrivate: true,
      },
    ]);

    const result = await discoverRepos(workspaceRoot, "myorg", host);
    assert.equal(result.repos[0].registered, true);
    assert.equal(result.unregistered.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("discoverRepos matches HTTPS-registered repo with SSH-only candidate", async () => {
  // A repo registered with the HTTPS URL should still match a host that
  // reports both URLs. We compare against both sshUrl and httpsUrl.
  const { umbrella, workspaceRoot } = await setupCanonical();
  try {
    await makeSiblingRepo(umbrella, "api", "https://github.com/myorg/api.git");
    await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

    const host = fakeHost([
      {
        name: "api",
        sshUrl: "git@github.com:myorg/api.git",
        httpsUrl: "https://github.com/myorg/api.git",
        description: null,
        isPrivate: false,
      },
    ]);

    const result = await discoverRepos(workspaceRoot, "myorg", host);
    assert.equal(result.repos[0].registered, true);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
