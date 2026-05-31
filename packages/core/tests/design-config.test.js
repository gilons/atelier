import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadDesignConfig,
  loadDisciplineConfig,
  setDesignTool,
  setLiveConfig,
  clearDesignTool,
  DesignConfigError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-design-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

test("loadDesignConfig / loadDisciplineConfig return null when unset", async () => {
  const { workspaceRoot } = await workspace();
  assert.equal(await loadDesignConfig(workspaceRoot), null);
  assert.equal(await loadDisciplineConfig(workspaceRoot), null);
});

test("setDesignTool defaults to the system-design discipline", async () => {
  const { workspaceRoot } = await workspace();
  const d = await setDesignTool(workspaceRoot, {
    tool: "excalidraw",
    sourceId: "acme-ex",
    notes: "scenes in docs/",
  });
  assert.equal(d.tool, "excalidraw");
  const loaded = await loadDisciplineConfig(workspaceRoot, "system-design");
  assert.equal(loaded.tool, "excalidraw");
  assert.equal(loaded.sourceId, "acme-ex");
  const paths = workspacePaths(workspaceRoot);
  const text = await fs.readFile(path.join(paths.atelier, "design.yaml"), "utf8");
  assert.match(text, /disciplines:/);
  assert.match(text, /system-design:/);
});

test("tools are per-discipline — ui-design and system-design coexist", async () => {
  const { workspaceRoot } = await workspace();
  await setDesignTool(workspaceRoot, { tool: "excalidraw", discipline: "system-design" });
  await setDesignTool(workspaceRoot, { tool: "figma", discipline: "ui-design" });
  assert.equal((await loadDisciplineConfig(workspaceRoot, "system-design")).tool, "excalidraw");
  assert.equal((await loadDisciplineConfig(workspaceRoot, "ui-design")).tool, "figma");
});

test("setDesignTool preserves createdAt, bumps updatedAt (full config)", async () => {
  const { workspaceRoot } = await workspace();
  await setDesignTool(workspaceRoot, { tool: "excalidraw" });
  const a = await loadDesignConfig(workspaceRoot);
  await new Promise((r) => setTimeout(r, 5));
  await setDesignTool(workspaceRoot, { tool: "figma" });
  const b = await loadDesignConfig(workspaceRoot);
  assert.equal(b.createdAt, a.createdAt);
  assert.notEqual(b.updatedAt, a.updatedAt);
});

test("setDesignTool rejects an empty tool", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(() => setDesignTool(workspaceRoot, { tool: "  " }), DesignConfigError);
});

test("setLiveConfig tunes a discipline's gate + model, standalone (no tool)", async () => {
  const { workspaceRoot } = await workspace();
  const d = await setLiveConfig(workspaceRoot, {
    discipline: "ui-design",
    stabilityChunks: 3,
    model: "base",
  });
  assert.equal(d.tool, undefined);
  assert.equal(d.live.stabilityChunks, 3);
  assert.equal(d.live.model, "base");
  const loaded = await loadDisciplineConfig(workspaceRoot, "ui-design");
  assert.equal(loaded.live.stabilityChunks, 3);
});

test("setLiveConfig and setDesignTool preserve each other within a discipline", async () => {
  const { workspaceRoot } = await workspace();
  await setLiveConfig(workspaceRoot, { stabilityChunks: 4 });
  await setDesignTool(workspaceRoot, { tool: "figma" });
  let d = await loadDisciplineConfig(workspaceRoot, "system-design");
  assert.equal(d.tool, "figma");
  assert.equal(d.live.stabilityChunks, 4, "tool change wiped live tuning");
  await setLiveConfig(workspaceRoot, { model: "tiny" });
  d = await loadDisciplineConfig(workspaceRoot, "system-design");
  assert.equal(d.tool, "figma");
  assert.equal(d.live.stabilityChunks, 4);
  assert.equal(d.live.model, "tiny");
});

test("setLiveConfig rejects a non-positive gate", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(() => setLiveConfig(workspaceRoot, { stabilityChunks: 0 }), DesignConfigError);
});

test("clearDesignTool removes a discipline; clearing the last deletes the file", async () => {
  const { workspaceRoot } = await workspace();
  await setDesignTool(workspaceRoot, { tool: "figma", discipline: "ui-design" });
  await setDesignTool(workspaceRoot, { tool: "excalidraw", discipline: "system-design" });
  assert.equal(await clearDesignTool(workspaceRoot, "ui-design"), true);
  assert.equal(await loadDisciplineConfig(workspaceRoot, "ui-design"), null);
  assert.equal((await loadDisciplineConfig(workspaceRoot, "system-design")).tool, "excalidraw");
  // Clear the last → file gone → loadDesignConfig null.
  assert.equal(await clearDesignTool(workspaceRoot, "system-design"), true);
  assert.equal(await loadDesignConfig(workspaceRoot), null);
  // Clearing again is a no-op.
  assert.equal(await clearDesignTool(workspaceRoot), false);
});

test("back-compat: a flat design.yaml is read as the system-design discipline", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  await fs.writeFile(
    path.join(paths.atelier, "design.yaml"),
    "version: 1\ntool: figma\nsourceId: legacy\ncreatedAt: 2026-01-01T00:00:00Z\nupdatedAt: 2026-01-01T00:00:00Z\n",
    "utf8"
  );
  const d = await loadDisciplineConfig(workspaceRoot, "system-design");
  assert.equal(d.tool, "figma");
  assert.equal(d.sourceId, "legacy");
});
