import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, buildScreens } from "../dist/index.js";

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-screens-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c = "") {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}

test("buildScreens groups an app's routes into sections", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const web = path.join(umbrella, "web");
  await write(path.join(web, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
  await write(path.join(web, "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
  await write(path.join(web, "app", "page.tsx"));
  await write(path.join(web, "app", "blog", "page.tsx"));
  await write(path.join(web, "app", "blog", "[slug]", "page.tsx"));
  await write(path.join(web, "app", "settings", "page.tsx"));
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const [app] = await buildScreens(workspaceRoot);
  assert.equal(app.app.ref, "app:web");
  assert.equal(app.fileBased, true);
  assert.equal(app.total, 4);

  const sectionNames = app.sections.map((s) => s.section);
  // "(root)" first, then alphabetical.
  assert.equal(sectionNames[0], "(root)");
  assert.ok(sectionNames.includes("blog"));
  assert.ok(sectionNames.includes("settings"));

  const root = app.sections.find((s) => s.section === "(root)");
  assert.equal(root.screens[0].label, "Home");
  const blog = app.sections.find((s) => s.section === "blog");
  const dyn = blog.screens.find((s) => s.route === "/blog/[slug]");
  assert.ok(dyn.dynamic);
  assert.equal(dyn.label, "blog / [slug]");
});

test("buildScreens reports fileBased:false for code-routed apps", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const web = path.join(umbrella, "spa");
  await write(path.join(web, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/spa.git\n');
  await write(path.join(web, "package.json"), '{"name":"spa","dependencies":{"react":"18","react-dom":"18"}}');
  await addRepo(workspaceRoot, { pathInput: "../spa", cwd: workspaceRoot });

  const [app] = await buildScreens(workspaceRoot);
  assert.equal(app.app.framework, "React");
  assert.equal(app.fileBased, false);
  assert.equal(app.total, 0);
});
