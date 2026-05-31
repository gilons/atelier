import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addDesign,
  loadDesign,
  listDesigns,
  updateDesign,
  removeDesign,
  validateDesignArtifactFrontMatter,
  DesignAlreadyExistsError,
  DesignNotFoundError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-designs-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

test("validateDesignArtifactFrontMatter requires discipline/id/title", () => {
  const r = validateDesignArtifactFrontMatter({ discipline: "Bad Disc", id: "x", title: "T", createdAt: "t", updatedAt: "t" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.discipline"));
});

test("addDesign writes under designs/<discipline>/ keyed by discipline", async () => {
  const { workspaceRoot } = await workspace();
  const d = await addDesign(workspaceRoot, {
    discipline: "system-design",
    id: "overview",
    title: "Workspace architecture",
    kind: "context",
    link: "https://excalidraw.com/x",
  });
  assert.equal(d.discipline, "system-design");
  const paths = workspacePaths(workspaceRoot);
  const file = path.join(paths.designs, "system-design", "overview", "summary.md");
  assert.match(await fs.readFile(file, "utf8"), /kind: context/);
});

test("addDesign rejects duplicates within a discipline", async () => {
  const { workspaceRoot } = await workspace();
  await addDesign(workspaceRoot, { discipline: "ui-design", id: "login", title: "Login" });
  await assert.rejects(
    () => addDesign(workspaceRoot, { discipline: "ui-design", id: "login", title: "Login" }),
    DesignAlreadyExistsError
  );
});

test("listDesigns spans disciplines + can scope to one", async () => {
  const { workspaceRoot } = await workspace();
  await addDesign(workspaceRoot, { discipline: "system-design", id: "a", title: "A" });
  await addDesign(workspaceRoot, { discipline: "ui-design", id: "b", title: "B" });
  const all = await listDesigns(workspaceRoot);
  assert.equal(all.designs.length, 2);
  const ui = await listDesigns(workspaceRoot, "ui-design");
  assert.equal(ui.designs.length, 1);
  assert.equal(ui.designs[0].design.id, "b");
});

test("updateDesign patches; removeDesign deletes", async () => {
  const { workspaceRoot } = await workspace();
  await addDesign(workspaceRoot, { discipline: "ui-design", id: "login", title: "Login", app: "app:web" });
  const up = await updateDesign(workspaceRoot, "ui-design", "login", { title: "Login v2", "clear-app": undefined, app: null });
  assert.equal(up.title, "Login v2");
  assert.equal(up.app, undefined);
  await removeDesign(workspaceRoot, "ui-design", "login");
  await assert.rejects(() => loadDesign(workspaceRoot, "ui-design", "login"), DesignNotFoundError);
});

test("initWorkspace creates the designs folder", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  assert.ok((await fs.stat(paths.designs)).isDirectory());
});
