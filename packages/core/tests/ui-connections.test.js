import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, detectConnections } from "../dist/index.js";

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-conn-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}

test("detectConnections finds apps sharing an internal design-system package", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const mono = path.join(umbrella, "platform");
  await write(path.join(mono, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
  await write(path.join(mono, "package.json"), '{"name":"platform","workspaces":["apps/*","packages/*"]}');
  // shared internal package (design system)
  await write(path.join(mono, "packages", "ui", "package.json"), '{"name":"@acme/ui"}');
  // two apps both depending on @acme/ui + a shared api client
  await write(path.join(mono, "apps", "web", "package.json"), '{"name":"@acme/web","dependencies":{"next":"14","@acme/ui":"workspace:*","@acme/api":"workspace:*"}}');
  await write(path.join(mono, "apps", "admin", "package.json"), '{"name":"@acme/admin","dependencies":{"react":"18","@acme/ui":"workspace:*"}}');
  await write(path.join(mono, "packages", "api", "package.json"), '{"name":"@acme/api"}');
  await addRepo(workspaceRoot, { pathInput: "../platform", cwd: workspaceRoot });

  const graph = await detectConnections(workspaceRoot);
  // both apps detected
  const appRefs = graph.apps.map((a) => a.ref).sort();
  assert.ok(appRefs.includes("app:platform/apps/web"));
  assert.ok(appRefs.includes("app:platform/apps/admin"));

  // @acme/ui is a shared edge across both apps, flagged design system
  const uiEdge = graph.edges.find((e) => e.package === "@acme/ui");
  assert.ok(uiEdge, "expected @acme/ui connection edge");
  assert.equal(uiEdge.designSystem, true);
  assert.deepEqual(uiEdge.apps.sort(), ["app:platform/apps/admin", "app:platform/apps/web"]);

  // @acme/api is internal to web only → not an edge (used by 1 app)
  assert.ok(!graph.edges.some((e) => e.package === "@acme/api"));
});

test("detectConnections returns no edges when apps share no internal code", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const a = path.join(umbrella, "web");
  await write(path.join(a, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
  await write(path.join(a, "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const graph = await detectConnections(workspaceRoot);
  assert.equal(graph.apps.length, 1);
  assert.deepEqual(graph.edges, []);
});
