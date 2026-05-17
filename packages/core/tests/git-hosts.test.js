import { test } from "node:test";
import assert from "node:assert/strict";
import { GhAdapter } from "../dist/index.js";

// Build a fake exec for injecting into GhAdapter.
function fakeExec(scenario) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const entry = scenario[key];
    if (!entry) {
      throw new Error(`No fake exec registered for: ${key}`);
    }
    return { stdout: entry.stdout ?? "", stderr: entry.stderr ?? "", code: entry.code ?? 0 };
  };
}

test("GhAdapter.checkAvailability returns available when version+auth succeed", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh --version": { stdout: "gh version 2.40.0\n", code: 0 },
    "gh auth status": { stdout: "logged in", code: 0 },
  }));
  const result = await adapter.checkAvailability();
  assert.equal(result.available, true);
});

test("GhAdapter.checkAvailability reports missing binary", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh --version": { stderr: "command not found", code: 127 },
    "gh auth status": { stderr: "n/a", code: 1 },
  }));
  const result = await adapter.checkAvailability();
  assert.equal(result.available, false);
  assert.match(result.reason, /not found/);
});

test("GhAdapter.checkAvailability reports missing auth", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh --version": { stdout: "gh version 2.40.0", code: 0 },
    "gh auth status": { stderr: "not logged in", code: 1 },
  }));
  const result = await adapter.checkAvailability();
  assert.equal(result.available, false);
  assert.match(result.reason, /not authenticated/);
});

test("GhAdapter.listOrgRepos parses gh JSON output", async () => {
  const sample = JSON.stringify([
    {
      name: "api",
      description: "Backend service",
      sshUrl: "git@github.com:myorg/api.git",
      url: "https://github.com/myorg/api",
      isPrivate: true,
    },
    {
      name: "web",
      description: "",
      sshUrl: "git@github.com:myorg/web.git",
      url: "https://github.com/myorg/web",
      isPrivate: false,
    },
  ]);
  const adapter = new GhAdapter(fakeExec({
    "gh repo list myorg --json name,description,sshUrl,url,isPrivate --limit 1000": {
      stdout: sample,
      code: 0,
    },
  }));
  const repos = await adapter.listOrgRepos("myorg");
  assert.equal(repos.length, 2);
  assert.equal(repos[0].name, "api");
  assert.equal(repos[0].sshUrl, "git@github.com:myorg/api.git");
  assert.equal(repos[0].description, "Backend service");
  assert.equal(repos[0].isPrivate, true);
  // Empty description normalized to null.
  assert.equal(repos[1].description, null);
});

test("GhAdapter.listOrgRepos throws on non-zero exit", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh repo list myorg --json name,description,sshUrl,url,isPrivate --limit 1000": {
      stderr: "API rate limit exceeded",
      code: 1,
    },
  }));
  await assert.rejects(() => adapter.listOrgRepos("myorg"), (e) => /API rate limit/.test(e.message));
});

test("GhAdapter.listOrgRepos throws on invalid JSON", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh repo list myorg --json name,description,sshUrl,url,isPrivate --limit 1000": {
      stdout: "not json {{{",
      code: 0,
    },
  }));
  await assert.rejects(() => adapter.listOrgRepos("myorg"), (e) => /JSON/i.test(e.message));
});

test("GhAdapter.listOrgRepos throws on non-array JSON", async () => {
  const adapter = new GhAdapter(fakeExec({
    "gh repo list myorg --json name,description,sshUrl,url,isPrivate --limit 1000": {
      stdout: `{"oops": true}`,
      code: 0,
    },
  }));
  await assert.rejects(() => adapter.listOrgRepos("myorg"), (e) => /array/i.test(e.message));
});
