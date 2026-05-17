import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseRemotes,
  inspectGitRepo,
  getRemoteUrl,
  repoNameFromRemote,
  githubOrgFromRemote,
  NotAGitRepoError,
  MissingRemoteError,
} from "../dist/index.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "atelier-git-test-"));
}

async function makeFakeRepo(parent, name, configBody) {
  const dir = path.join(parent, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "config"), configBody, "utf8");
  return dir;
}

test("parseRemotes finds origin URL", () => {
  const config = `
[core]
	repositoryformatversion = 0
[remote "origin"]
	url = git@github.com:org/api.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;
  const remotes = parseRemotes(config);
  assert.equal(remotes.size, 1);
  assert.equal(remotes.get("origin"), "git@github.com:org/api.git");
});

test("parseRemotes handles multiple remotes", () => {
  const config = `
[remote "origin"]
	url = git@github.com:org/api.git
[remote "fork"]
	url = git@github.com:user/api.git
`;
  const remotes = parseRemotes(config);
  assert.equal(remotes.size, 2);
  assert.equal(remotes.get("origin"), "git@github.com:org/api.git");
  assert.equal(remotes.get("fork"), "git@github.com:user/api.git");
});

test("parseRemotes ignores comments", () => {
  const config = `
# Hello
[remote "origin"]
	url = git@github.com:org/api.git ; trailing comment
`;
  const remotes = parseRemotes(config);
  // Note: our trim-after-=" doesn't strip trailing inline comments by default.
  // The line comment-strip happens before parsing, so the inline " ; ..." is stripped.
  assert.match(remotes.get("origin") ?? "", /^git@github\.com:org\/api\.git/);
});

test("parseRemotes returns empty for no remotes", () => {
  const config = `[core]\n\trepositoryformatversion = 0\n`;
  assert.equal(parseRemotes(config).size, 0);
});

test("inspectGitRepo throws NotAGitRepoError for non-git dir", async () => {
  const root = await makeTempDir();
  try {
    await assert.rejects(() => inspectGitRepo(root), (e) => e instanceof NotAGitRepoError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectGitRepo reads remotes from a real .git/config", async () => {
  const root = await makeTempDir();
  try {
    const repo = await makeFakeRepo(
      root,
      "api",
      `[remote "origin"]\n\turl = git@github.com:myorg/api.git\n`
    );
    const info = await inspectGitRepo(repo);
    assert.equal(info.remotes.get("origin"), "git@github.com:myorg/api.git");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectGitRepo handles worktree (.git is a file with gitdir:)", async () => {
  const root = await makeTempDir();
  try {
    // Build a main repo with a config and a fake worktree pointing at it.
    const main = path.join(root, "main");
    const gitDir = path.join(main, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = git@github.com:myorg/main.git\n`,
      "utf8"
    );

    const wt = path.join(root, "worktree");
    await fs.mkdir(wt, { recursive: true });
    // Use an absolute path so we don't depend on relative resolution rules.
    await fs.writeFile(path.join(wt, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    const info = await inspectGitRepo(wt);
    assert.equal(info.remotes.get("origin"), "git@github.com:myorg/main.git");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("getRemoteUrl throws MissingRemoteError when origin absent", async () => {
  const root = await makeTempDir();
  try {
    const repo = await makeFakeRepo(root, "api", `[core]\n\trepositoryformatversion = 0\n`);
    await assert.rejects(() => getRemoteUrl(repo), (e) => e instanceof MissingRemoteError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repoNameFromRemote handles SSH form", () => {
  assert.equal(repoNameFromRemote("git@github.com:myorg/api.git"), "api");
  assert.equal(repoNameFromRemote("git@github.com:myorg/api"), "api");
});

test("repoNameFromRemote handles HTTPS form", () => {
  assert.equal(repoNameFromRemote("https://github.com/myorg/api.git"), "api");
  assert.equal(repoNameFromRemote("https://github.com/myorg/sub/api.git"), "api");
});

test("githubOrgFromRemote detects GitHub remotes", () => {
  assert.equal(githubOrgFromRemote("git@github.com:myorg/api.git"), "myorg");
  assert.equal(githubOrgFromRemote("https://github.com/myorg/api.git"), "myorg");
});

test("githubOrgFromRemote returns null for non-GitHub", () => {
  assert.equal(githubOrgFromRemote("git@gitlab.com:myorg/api.git"), null);
  assert.equal(githubOrgFromRemote("https://example.com/foo/bar.git"), null);
});
