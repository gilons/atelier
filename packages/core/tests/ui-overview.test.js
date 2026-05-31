import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, buildUiOverview } from "../dist/index.js";

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-uiov-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c = "") {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}

test("buildUiOverview aggregates apps, screens, connections, and kit", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const mono = path.join(umbrella, "platform");
  await write(path.join(mono, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
  await write(path.join(mono, "package.json"), '{"name":"platform","workspaces":["apps/*","packages/*"]}');
  // shared design system
  await write(path.join(mono, "packages", "ui", "package.json"), '{"name":"@acme/ui"}');
  await write(path.join(mono, "packages", "ui", "src", "components", "Button.tsx"), "");
  await write(path.join(mono, "packages", "ui", "src", "components", "Card.tsx"), "");
  await write(path.join(mono, "packages", "ui", "tailwind.config.ts"), "");
  // two apps, both using @acme/ui, web with 2 screens
  await write(path.join(mono, "apps", "web", "package.json"), '{"name":"@acme/web","dependencies":{"next":"14","@acme/ui":"workspace:*"}}');
  await write(path.join(mono, "apps", "web", "app", "page.tsx"), "");
  await write(path.join(mono, "apps", "web", "app", "about", "page.tsx"), "");
  await write(path.join(mono, "apps", "admin", "package.json"), '{"name":"@acme/admin","dependencies":{"@sveltejs/kit":"2","svelte":"4","@acme/ui":"workspace:*"}}');
  await write(path.join(mono, "apps", "admin", "src", "routes", "+page.svelte"), "");
  await addRepo(workspaceRoot, { pathInput: "../platform", cwd: workspaceRoot });

  const o = await buildUiOverview(workspaceRoot);
  assert.equal(o.apps.length, 2);
  assert.equal(o.totalScreens, 3); // web: /, /about ; admin: /
  assert.equal(o.connections, 1); // @acme/ui shared by both
  assert.equal(o.designSystemConnections, 1);
  assert.equal(o.componentSources, 1);
  assert.equal(o.totalComponents, 2);
  assert.ok(o.tokenSources >= 1);

  const web = o.apps.find((a) => a.ref === "app:platform/apps/web");
  assert.equal(web.framework, "Next.js");
  assert.equal(web.screens, 2);
  assert.equal(web.fileBased, true);
});

test("buildUiOverview is empty-but-valid on a workspace with no UI", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const api = path.join(umbrella, "api");
  await write(path.join(api, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  await write(path.join(api, "go.mod"), "module acme/api\n");
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
  const o = await buildUiOverview(workspaceRoot);
  assert.deepEqual(o.apps, []);
  assert.equal(o.totalScreens, 0);
  assert.equal(o.connections, 0);
  assert.equal(o.componentSources, 0);
});
