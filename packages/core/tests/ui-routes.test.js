import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, extractRoutes, detectNavigation } from "../dist/index.js";

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
async function write(p, c = "") {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}
function routeSet(routes) {
  return routes.map((r) => r.route).sort();
}

test("extractRoutes: Next.js app router (groups + dynamic)", async () => {
  const dir = await tmp("atelier-next-app-");
  await write(path.join(dir, "app", "page.tsx"));
  await write(path.join(dir, "app", "(marketing)", "about", "page.tsx"));
  await write(path.join(dir, "app", "blog", "[slug]", "page.tsx"));
  await write(path.join(dir, "app", "layout.tsx")); // not a page
  const routes = await extractRoutes(dir, "Next.js");
  assert.deepEqual(routeSet(routes), ["/", "/about", "/blog/[slug]"]);
  assert.ok(routes.find((r) => r.route === "/blog/[slug]").dynamic);
});

test("extractRoutes: Next.js pages router (index collapses, api excluded)", async () => {
  const dir = await tmp("atelier-next-pages-");
  await write(path.join(dir, "pages", "index.tsx"));
  await write(path.join(dir, "pages", "blog", "index.tsx"));
  await write(path.join(dir, "pages", "blog", "[slug].tsx"));
  await write(path.join(dir, "pages", "_app.tsx")); // excluded
  await write(path.join(dir, "pages", "api", "hello.ts")); // excluded
  const routes = await extractRoutes(dir, "Next.js");
  assert.deepEqual(routeSet(routes), ["/", "/blog", "/blog/[slug]"]);
});

test("extractRoutes: SvelteKit", async () => {
  const dir = await tmp("atelier-sveltekit-");
  await write(path.join(dir, "src", "routes", "+page.svelte"));
  await write(path.join(dir, "src", "routes", "about", "+page.svelte"));
  await write(path.join(dir, "src", "routes", "blog", "[id]", "+page.svelte"));
  const routes = await extractRoutes(dir, "SvelteKit");
  assert.deepEqual(routeSet(routes), ["/", "/about", "/blog/[id]"]);
});

test("extractRoutes: Astro file routes", async () => {
  const dir = await tmp("atelier-astro-");
  await write(path.join(dir, "src", "pages", "index.astro"));
  await write(path.join(dir, "src", "pages", "posts", "[id].astro"));
  const routes = await extractRoutes(dir, "Astro");
  assert.deepEqual(routeSet(routes), ["/", "/posts/[id]"]);
});

test("extractRoutes: Remix flat routes (best-effort)", async () => {
  const dir = await tmp("atelier-remix-");
  await write(path.join(dir, "app", "routes", "_index.tsx"));
  await write(path.join(dir, "app", "routes", "blog._index.tsx"));
  await write(path.join(dir, "app", "routes", "blog.$slug.tsx"));
  const routes = await extractRoutes(dir, "Remix");
  const set = routeSet(routes);
  assert.ok(set.includes("/"));
  assert.ok(set.includes("/blog"));
  assert.ok(set.includes("/blog/[slug]"));
});

test("extractRoutes returns [] for code-routed frameworks", async () => {
  const dir = await tmp("atelier-react-");
  await write(path.join(dir, "src", "App.tsx"));
  assert.deepEqual(await extractRoutes(dir, "React"), []);
});

test("detectNavigation maps routes per app across the workspace", async () => {
  const umbrella = await tmp("atelier-nav-");
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });

  const web = path.join(umbrella, "web");
  await write(path.join(web, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
  await write(path.join(web, "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
  await write(path.join(web, "app", "page.tsx"));
  await write(path.join(web, "app", "settings", "page.tsx"));
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const navs = await detectNavigation(workspaceRoot);
  assert.equal(navs.length, 1);
  assert.equal(navs[0].app.ref, "app:web");
  assert.equal(navs[0].fileBased, true);
  assert.deepEqual(routeSet(navs[0].routes), ["/", "/settings"]);
});
