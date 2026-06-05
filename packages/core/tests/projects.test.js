import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addProject,
  removeProject,
  listProjects,
  loadProject,
  loadProjectsConfig,
  getActiveProject,
  setActiveProject,
  assertProjectExists,
  resolveProjectScope,
  inProjectScope,
  defaultProjectForNew,
  deriveProjectId,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
} from "../dist/index.js";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-projects-test-"));
  await initWorkspace(root, { name: "TestWorkspace" });
  return root;
}

test("init writes an empty projects registry", async () => {
  const root = await setup();
  try {
    const cfg = await loadProjectsConfig(root);
    assert.deepEqual(cfg, { version: 1, projects: [] });
    // projects.yaml exists on disk
    const stat = await fs.stat(path.join(root, ".atelier", "projects.yaml"));
    assert.ok(stat.isFile());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("init gitignores the active-project pin", async () => {
  const root = await setup();
  try {
    const gi = await fs.readFile(path.join(root, ".atelier", ".gitignore"), "utf8");
    assert.match(gi, /\.active-project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deriveProjectId slugifies a name", () => {
  assert.equal(deriveProjectId("Acme Corp"), "acme-corp");
  assert.equal(deriveProjectId("  Big  Bank!! "), "big-bank");
  assert.equal(deriveProjectId("ACME"), "acme");
  assert.equal(deriveProjectId("!!!"), "project");
});

test("addProject derives id, sorts, and persists", async () => {
  const root = await setup();
  try {
    const a = await addProject(root, { name: "Beta Client" });
    assert.equal(a.id, "beta-client");
    assert.equal(a.name, "Beta Client");
    assert.ok(a.createdAt);
    assert.ok(a.updatedAt);

    await addProject(root, { name: "Acme", client: "Acme Inc", status: "active" });
    const projects = await listProjects(root);
    // sorted by id: acme before beta-client
    assert.deepEqual(projects.map((p) => p.id), ["acme", "beta-client"]);
    const acme = projects.find((p) => p.id === "acme");
    assert.equal(acme.client, "Acme Inc");
    assert.equal(acme.status, "active");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addProject honors an explicit id", async () => {
  const root = await setup();
  try {
    const p = await addProject(root, { name: "Long Marketing Name", id: "mktg" });
    assert.equal(p.id, "mktg");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addProject rejects duplicate ids", async () => {
  const root = await setup();
  try {
    await addProject(root, { name: "Acme" });
    await assert.rejects(() => addProject(root, { name: "Acme" }), ProjectAlreadyExistsError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addProject rejects reserved ids and bad slugs", async () => {
  const root = await setup();
  try {
    await assert.rejects(() => addProject(root, { name: "All", id: "all" }), /reserved/);
    await assert.rejects(() => addProject(root, { name: "Global", id: "global" }), /reserved/);
    await assert.rejects(() => addProject(root, { name: "Bad", id: "-bad-" }), /Invalid project id/);
    await assert.rejects(() => addProject(root, { name: "Bad", id: "Has Space" }), /Invalid project id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadProject / assertProjectExists throw when missing", async () => {
  const root = await setup();
  try {
    await assert.rejects(() => loadProject(root, "nope"), ProjectNotFoundError);
    await assert.rejects(() => assertProjectExists(root, "nope"), ProjectNotFoundError);
    await addProject(root, { name: "Acme" });
    await assertProjectExists(root, "acme"); // resolves
    assert.equal((await loadProject(root, "acme")).name, "Acme");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("active project pin: get/set/clear", async () => {
  const root = await setup();
  try {
    assert.equal(await getActiveProject(root), null);
    await addProject(root, { name: "Acme" });
    await setActiveProject(root, "acme");
    assert.equal(await getActiveProject(root), "acme");
    // pin file exists
    const pin = await fs.readFile(path.join(root, ".atelier", ".active-project"), "utf8");
    assert.equal(pin.trim(), "acme");
    await setActiveProject(root, null);
    assert.equal(await getActiveProject(root), null);
    // file removed
    await assert.rejects(() => fs.stat(path.join(root, ".atelier", ".active-project")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeProject clears the active pin when it was active", async () => {
  const root = await setup();
  try {
    await addProject(root, { name: "Acme" });
    await addProject(root, { name: "Beta" });
    await setActiveProject(root, "acme");
    const removed = await removeProject(root, "acme");
    assert.equal(removed.id, "acme");
    assert.equal(await getActiveProject(root), null);
    // beta still there, beta pin untouched
    assert.deepEqual((await listProjects(root)).map((p) => p.id), ["beta"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeProject keeps a different active pin", async () => {
  const root = await setup();
  try {
    await addProject(root, { name: "Acme" });
    await addProject(root, { name: "Beta" });
    await setActiveProject(root, "beta");
    await removeProject(root, "acme");
    assert.equal(await getActiveProject(root), "beta");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeProject throws when missing", async () => {
  const root = await setup();
  try {
    await assert.rejects(() => removeProject(root, "nope"), ProjectNotFoundError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectScope honors flag, pin, fallback", async () => {
  const root = await setup();
  try {
    // nothing pinned, no flag -> all
    assert.deepEqual(await resolveProjectScope(root, {}), { kind: "all" });
    // explicit --project all -> all
    assert.deepEqual(await resolveProjectScope(root, { project: "all" }), { kind: "all" });
    // explicit --project acme -> that project
    assert.deepEqual(await resolveProjectScope(root, { project: "acme" }), {
      kind: "project",
      id: "acme",
    });
    // pin acme, no flag -> that project
    await addProject(root, { name: "Acme" });
    await setActiveProject(root, "acme");
    assert.deepEqual(await resolveProjectScope(root, {}), { kind: "project", id: "acme" });
    // flag overrides pin
    assert.deepEqual(await resolveProjectScope(root, { project: "beta" }), {
      kind: "project",
      id: "beta",
    });
    // --project all overrides pin -> everything
    assert.deepEqual(await resolveProjectScope(root, { project: "all" }), { kind: "all" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inProjectScope: global entries always in scope", () => {
  const all = { kind: "all" };
  const acme = { kind: "project", id: "acme" };
  // all scope: everything
  assert.equal(inProjectScope("acme", all), true);
  assert.equal(inProjectScope(undefined, all), true);
  // project scope: matching project or global
  assert.equal(inProjectScope("acme", acme), true);
  assert.equal(inProjectScope(undefined, acme), true); // global
  assert.equal(inProjectScope(null, acme), true); // global
  assert.equal(inProjectScope("", acme), true); // global
  assert.equal(inProjectScope("beta", acme), false); // other project
});

test("defaultProjectForNew: flag > pin > global", async () => {
  const root = await setup();
  try {
    // nothing -> undefined (global)
    assert.equal(await defaultProjectForNew(root, {}), undefined);
    // explicit global -> undefined
    assert.equal(await defaultProjectForNew(root, { project: "global" }), undefined);
    assert.equal(await defaultProjectForNew(root, { project: "none" }), undefined);
    // explicit project -> that project
    assert.equal(await defaultProjectForNew(root, { project: "acme" }), "acme");
    // pin, no flag -> pin
    await addProject(root, { name: "Acme" });
    await setActiveProject(root, "acme");
    assert.equal(await defaultProjectForNew(root, {}), "acme");
    // explicit global overrides pin -> undefined
    assert.equal(await defaultProjectForNew(root, { project: "global" }), undefined);
    // explicit project overrides pin
    assert.equal(await defaultProjectForNew(root, { project: "beta" }), "beta");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
