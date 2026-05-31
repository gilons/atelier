import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadDesignConfig,
  setDesignTool,
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

test("loadDesignConfig returns null when unset", async () => {
  const { workspaceRoot } = await workspace();
  assert.equal(await loadDesignConfig(workspaceRoot), null);
});

test("setDesignTool persists + loadDesignConfig round-trips", async () => {
  const { workspaceRoot } = await workspace();
  const cfg = await setDesignTool(workspaceRoot, {
    tool: "figma",
    sourceId: "acme-figma",
    notes: "file key ABC, MCP server figma",
  });
  assert.equal(cfg.tool, "figma");
  const loaded = await loadDesignConfig(workspaceRoot);
  assert.equal(loaded.tool, "figma");
  assert.equal(loaded.sourceId, "acme-figma");
  assert.match(loaded.notes, /file key ABC/);
  // Lands at .atelier/design.yaml
  const paths = workspacePaths(workspaceRoot);
  await fs.access(path.join(paths.atelier, "design.yaml"));
});

test("setDesignTool preserves createdAt across updates, bumps updatedAt", async () => {
  const { workspaceRoot } = await workspace();
  const a = await setDesignTool(workspaceRoot, { tool: "excalidraw" });
  await new Promise((r) => setTimeout(r, 5));
  const b = await setDesignTool(workspaceRoot, { tool: "figma" });
  assert.equal(b.createdAt, a.createdAt);
  assert.notEqual(b.updatedAt, a.updatedAt);
  assert.equal(b.tool, "figma");
});

test("setDesignTool rejects an empty tool", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(() => setDesignTool(workspaceRoot, { tool: "  " }), DesignConfigError);
});

test("clearDesignTool removes the setting", async () => {
  const { workspaceRoot } = await workspace();
  await setDesignTool(workspaceRoot, { tool: "lucidchart" });
  assert.equal(await clearDesignTool(workspaceRoot), true);
  assert.equal(await loadDesignConfig(workspaceRoot), null);
  // Clearing again is a no-op (false).
  assert.equal(await clearDesignTool(workspaceRoot), false);
});

test("loadDesignConfig throws on a malformed file", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  await fs.writeFile(path.join(paths.atelier, "design.yaml"), "tool: 123\n", "utf8");
  // tool must be a string — surfaced as a DesignConfigError.
  await assert.rejects(() => loadDesignConfig(workspaceRoot), DesignConfigError);
});
