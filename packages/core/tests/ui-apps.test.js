import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, detectApps } from "../dist/index.js";

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-uiapps-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}
async function gitRepo(umbrella, name) {
  await write(path.join(umbrella, name, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:acme/${name}.git\n`);
  return path.join(umbrella, name);
}

test("detectApps recognizes a Next.js app + a Go service is ignored", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const web = await gitRepo(umbrella, "web");
  await write(path.join(web, "package.json"), '{"name":"web","dependencies":{"next":"14","react":"18"}}');
  const api = await gitRepo(umbrella, "api");
  await write(path.join(api, "go.mod"), "module acme/api\n");
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });

  const apps = await detectApps(workspaceRoot);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].repo, "web");
  assert.equal(apps[0].framework, "Next.js");
  assert.equal(apps[0].ref, "app:web");
});

test("detectApps finds multiple apps inside a monorepo + picks meta-frameworks", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const mono = await gitRepo(umbrella, "platform");
  await write(path.join(mono, "package.json"), '{"name":"platform","workspaces":["apps/*"]}');
  await write(path.join(mono, "apps", "marketing", "package.json"), '{"name":"@acme/marketing","dependencies":{"astro":"4"}}');
  await write(path.join(mono, "apps", "dashboard", "package.json"), '{"name":"@acme/dashboard","dependencies":{"@sveltejs/kit":"2","svelte":"4"}}');
  await addRepo(workspaceRoot, { pathInput: "../platform", cwd: workspaceRoot });

  const apps = await detectApps(workspaceRoot);
  const byName = Object.fromEntries(apps.map((a) => [a.name, a]));
  assert.equal(byName["@acme/marketing"].framework, "Astro");
  // SvelteKit wins over plain Svelte.
  assert.equal(byName["@acme/dashboard"].framework, "SvelteKit");
  assert.ok(apps.some((a) => a.ref === "app:platform/apps/dashboard"));
});

test("detectApps returns nothing for a workspace with no UI", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const api = await gitRepo(umbrella, "api");
  await write(path.join(api, "go.mod"), "module acme/api\n");
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
  assert.deepEqual(await detectApps(workspaceRoot), []);
});
