import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addSource,
  removeSource,
  setSourceEnabled,
  listSources,
  loadSourcesConfig,
  SourceAlreadyRegisteredError,
  SourceNotFoundError,
  InvalidSourceKindError,
  SOURCE_KINDS_LIST,
} from "../dist/index.js";

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-sources-test-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

test("SOURCE_KINDS_LIST exposes the canonical kinds", () => {
  assert.ok(SOURCE_KINDS_LIST.includes("notion"));
  assert.ok(SOURCE_KINDS_LIST.includes("confluence"));
  assert.ok(SOURCE_KINDS_LIST.length >= 8);
});

test("addSource registers a basic notion source", async () => {
  const root = await workspace();
  try {
    const source = await addSource(root, {
      kind: "notion",
      name: "Company Notion",
      mcpServer: "company-notion",
    });
    assert.equal(source.kind, "notion");
    assert.equal(source.name, "Company Notion");
    assert.equal(source.mcpServer, "company-notion");
    assert.equal(source.enabled, true);
    // id auto-derived from name
    assert.equal(source.id, "company-notion");

    const cfg = await loadSourcesConfig(root);
    assert.equal(cfg.sources.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addSource refuses unknown kind", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      () => addSource(root, { kind: "tiktok", name: "TikTok" }),
      (e) => e instanceof InvalidSourceKindError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addSource auto-disambiguates duplicate derived ids", async () => {
  const root = await workspace();
  try {
    const s1 = await addSource(root, { kind: "notion", name: "Workspace" });
    const s2 = await addSource(root, { kind: "notion", name: "Workspace" });
    assert.equal(s1.id, "workspace");
    assert.equal(s2.id, "workspace-2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addSource refuses explicit duplicate id", async () => {
  const root = await workspace();
  try {
    await addSource(root, { kind: "notion", id: "main", name: "Main" });
    await assert.rejects(
      () => addSource(root, { kind: "confluence", id: "main", name: "Other" }),
      (e) => e instanceof SourceAlreadyRegisteredError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addSource accepts scope object", async () => {
  const root = await workspace();
  try {
    const source = await addSource(root, {
      kind: "confluence",
      name: "Eng wiki",
      scope: { spaceKey: "ENG", baseUrl: "https://example.atlassian.net/wiki" },
    });
    assert.deepEqual(source.scope, {
      spaceKey: "ENG",
      baseUrl: "https://example.atlassian.net/wiki",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("addSource respects enabled=false", async () => {
  const root = await workspace();
  try {
    const source = await addSource(root, {
      kind: "linear",
      name: "Linear",
      enabled: false,
    });
    assert.equal(source.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeSource unregisters by id", async () => {
  const root = await workspace();
  try {
    await addSource(root, { kind: "notion", name: "Main", id: "main" });
    const removed = await removeSource(root, "main");
    assert.equal(removed.id, "main");
    const cfg = await loadSourcesConfig(root);
    assert.equal(cfg.sources.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removeSource throws when id not found", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      () => removeSource(root, "ghost"),
      (e) => e instanceof SourceNotFoundError
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("setSourceEnabled toggles the flag", async () => {
  const root = await workspace();
  try {
    await addSource(root, { kind: "notion", name: "Main", id: "main" });
    const disabled = await setSourceEnabled(root, "main", false);
    assert.equal(disabled.enabled, false);
    const enabled = await setSourceEnabled(root, "main", true);
    assert.equal(enabled.enabled, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listSources returns all registered entries", async () => {
  const root = await workspace();
  try {
    await addSource(root, { kind: "notion", name: "Notion" });
    await addSource(root, { kind: "confluence", name: "Confluence" });
    await addSource(root, { kind: "linear", name: "Linear" });
    const all = await listSources(root);
    assert.equal(all.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("derived ids strip diacritics and lowercase", async () => {
  const root = await workspace();
  try {
    const s = await addSource(root, { kind: "notion", name: "Société Générale Notion" });
    // diacritics stripped, hyphens between words
    assert.match(s.id, /^societe-generale-notion$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sources.yaml round-trips with header comment", async () => {
  const root = await workspace();
  try {
    await addSource(root, {
      kind: "notion",
      name: "Main",
      mcpServer: "main-notion",
      scope: { workspaceId: "abc123" },
    });
    const file = await fs.readFile(
      path.join(root, ".atelier", "sources.yaml"),
      "utf8"
    );
    assert.match(file, /^# Documentation sources/m);
    assert.match(file, /kind: notion/);
    assert.match(file, /mcpServer: main-notion/);
    assert.match(file, /workspaceId: abc123/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
