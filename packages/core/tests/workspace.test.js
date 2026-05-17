import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadWorkspace,
  workspaceExists,
  workspacePaths,
  WorkspaceAlreadyInitializedError,
  WorkspaceNotInitializedError,
  ATELIER_VERSION,
} from "../dist/index.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "atelier-test-"));
}

test("workspaceExists returns false for unintialized directory", async () => {
  const root = await makeTempDir();
  try {
    assert.equal(await workspaceExists(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("initWorkspace creates the expected file tree", async () => {
  const root = await makeTempDir();
  try {
    const result = await initWorkspace(root, { name: "TestProject", description: "A test." });
    const p = workspacePaths(root);

    // Directory tree exists
    for (const dir of [p.planning, p.features, p.issues, p.ui, p.cache]) {
      const stat = await fs.stat(dir);
      assert.ok(stat.isDirectory(), `${dir} should be a directory`);
    }

    // Config files exist
    for (const f of [p.workspaceConfig, p.sourcesConfig, p.reposConfig, p.readme]) {
      const stat = await fs.stat(f);
      assert.ok(stat.isFile(), `${f} should be a file`);
    }

    // Internal .gitignore created
    const gitignoreStat = await fs.stat(path.join(p.planning, ".gitignore"));
    assert.ok(gitignoreStat.isFile());

    // workspaceExists now returns true
    assert.equal(await workspaceExists(root), true);

    // Result reports created files
    assert.ok(result.createdFiles.length >= 5, "should report at least 5 created files");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("initWorkspace refuses to overwrite without --force", async () => {
  const root = await makeTempDir();
  try {
    await initWorkspace(root, { name: "First" });
    await assert.rejects(
      () => initWorkspace(root, { name: "Second" }),
      (err) => err instanceof WorkspaceAlreadyInitializedError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("initWorkspace overwrites with force=true", async () => {
  const root = await makeTempDir();
  try {
    await initWorkspace(root, { name: "First" });
    await initWorkspace(root, { name: "Second", force: true });
    const loaded = await loadWorkspace(root);
    assert.equal(loaded.workspace.name, "Second");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadWorkspace reads back what initWorkspace wrote", async () => {
  const root = await makeTempDir();
  try {
    await initWorkspace(root, { name: "MyProduct", description: "Hello world." });
    const loaded = await loadWorkspace(root);
    assert.equal(loaded.workspace.name, "MyProduct");
    assert.equal(loaded.workspace.description, "Hello world.");
    assert.equal(loaded.workspace.version, 1);
    assert.equal(loaded.workspace.atelierVersion, ATELIER_VERSION);
    assert.ok(loaded.workspace.createdAt.length > 0);
    assert.deepEqual(loaded.sources.sources, []);
    assert.deepEqual(loaded.repos.repos, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadWorkspace throws WorkspaceNotInitializedError on missing workspace", async () => {
  const root = await makeTempDir();
  try {
    await assert.rejects(
      () => loadWorkspace(root),
      (err) => err instanceof WorkspaceNotInitializedError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace.yaml is human-readable YAML with header comment", async () => {
  const root = await makeTempDir();
  try {
    await initWorkspace(root, { name: "Readable" });
    const content = await fs.readFile(workspacePaths(root).workspaceConfig, "utf8");
    assert.match(content, /^# Atelier workspace metadata/m);
    assert.match(content, /name: Readable/);
    assert.match(content, /version: 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
