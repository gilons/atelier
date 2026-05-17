import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addSource,
  addDoc,
  listDocs,
  loadDoc,
  syncWorkspace,
  LocalFolderAdapter,
  McpSourceAdapter,
  buildFakeMcpClient,
  normalizeMcpServersConfig,
  hashBody,
  MCP_TRANSPORT_READY,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-sync-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

async function writeFile(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

// ============================================================
// LocalFolderAdapter
// ============================================================

test("LocalFolderAdapter listDocs walks recursively and finds markdown", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-folder-"));
  try {
    await writeFile(path.join(dir, "intro.md"), "# Intro\n\nHi.\n");
    await writeFile(path.join(dir, "guide/setup.md"), "# Setup\n\nStuff.\n");
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    await writeFile(path.join(dir, ".hidden/secret.md"), "hidden");
    const adapter = new LocalFolderAdapter({ root: dir });
    const docs = await adapter.listDocs();
    const ids = docs.map((d) => d.docId).sort();
    assert.deepEqual(ids, ["guide/setup.md", "intro.md"]);
    const intro = docs.find((d) => d.docId === "intro.md");
    assert.equal(intro.title, "Intro");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalFolderAdapter fetchDoc returns body and title", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-folder-"));
  try {
    await writeFile(path.join(dir, "a.md"), "# Page A\n\nBody text.\n");
    const adapter = new LocalFolderAdapter({ root: dir });
    const fetched = await adapter.fetchDoc("a.md");
    assert.equal(fetched.title, "Page A");
    assert.match(fetched.body, /Body text\./);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalFolderAdapter falls back to filename when no H1 present", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-folder-"));
  try {
    await writeFile(path.join(dir, "no-heading.md"), "Just plain text.\n");
    const adapter = new LocalFolderAdapter({ root: dir });
    const fetched = await adapter.fetchDoc("no-heading.md");
    assert.equal(fetched.title, "no-heading");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalFolderAdapter applies exclude regex", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-folder-"));
  try {
    await writeFile(path.join(dir, "keep.md"), "# K");
    await writeFile(path.join(dir, "drafts/draft.md"), "# D");
    const adapter = new LocalFolderAdapter({ root: dir, exclude: [/^drafts\//] });
    const docs = await adapter.listDocs();
    assert.deepEqual(
      docs.map((d) => d.docId),
      ["keep.md"]
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalFolderAdapter.fromSource resolves relative root against workspaceRoot", async () => {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-rel-"));
  try {
    const ws = path.join(umbrella, "planning");
    const docs = path.join(umbrella, "shared-docs");
    await fs.mkdir(ws, { recursive: true });
    await writeFile(path.join(docs, "a.md"), "# A");
    const adapter = LocalFolderAdapter.fromSource(
      {
        id: "shared",
        kind: "local-folder",
        name: "Shared",
        scope: { root: "../shared-docs" },
        enabled: true,
      },
      ws
    );
    const list = await adapter.listDocs();
    assert.equal(list.length, 1);
    assert.equal(list[0].docId, "a.md");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("LocalFolderAdapter.checkAvailability detects missing root", async () => {
  const adapter = new LocalFolderAdapter({ root: "/no/such/path/here" });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, false);
});

// ============================================================
// syncWorkspace with LocalFolderAdapter
// ============================================================

test("syncWorkspace creates doc entries for newly discovered files", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "intro.md"), "# Intro\n\nHello.\n");
    await writeFile(path.join(docsDir, "guide/usage.md"), "# Usage\n\nDo X.\n");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "Local Docs",
      scope: { root: docsDir },
    });
    const report = await syncWorkspace(workspaceRoot);
    assert.equal(report.sources.length, 1);
    const s = report.sources[0];
    assert.equal(s.actions.filter((a) => a.action === "created").length, 2);
    assert.equal(s.localAfter, 2);
    // The docs landed on disk.
    const { docs } = await listDocs(workspaceRoot);
    assert.equal(docs.length, 2);
    const intro = docs.find((d) => d.doc.docId === "intro.md");
    assert.match(intro.doc.body, /Hello\./);
    assert.equal(intro.doc.contentHash, hashBody("# Intro\n\nHello.\n"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace updates docs when their bodies change", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "x.md"), "# X\n\nOld body.\n");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "L",
      scope: { root: docsDir },
    });
    await syncWorkspace(workspaceRoot);
    await writeFile(path.join(docsDir, "x.md"), "# X\n\nNew body.\n");
    const second = await syncWorkspace(workspaceRoot);
    const action = second.sources[0].actions.find((a) => a.docId === "x.md");
    assert.equal(action.action, "updated");
    const loaded = await loadDoc(workspaceRoot, "local", "x.md");
    assert.match(loaded.body, /New body\./);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace marks orphans by default and removes them with removeOrphans", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "keep.md"), "# K");
    await writeFile(path.join(docsDir, "gone.md"), "# G");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "L",
      scope: { root: docsDir },
    });
    await syncWorkspace(workspaceRoot);
    // Delete one file on disk.
    await fs.unlink(path.join(docsDir, "gone.md"));

    const preserved = await syncWorkspace(workspaceRoot);
    const orphan = preserved.sources[0].actions.find((a) => a.docId === "gone.md");
    assert.equal(orphan.action, "orphaned");
    const { docs: stillThere } = await listDocs(workspaceRoot);
    assert.equal(stillThere.length, 2);

    const cleaned = await syncWorkspace(workspaceRoot, { removeOrphans: true });
    const removed = cleaned.sources[0].actions.find((a) => a.docId === "gone.md");
    assert.equal(removed.action, "removed");
    const { docs: after } = await listDocs(workspaceRoot);
    assert.equal(after.length, 1);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace honors dryRun (no writes)", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "x.md"), "# X");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "L",
      scope: { root: docsDir },
    });
    const report = await syncWorkspace(workspaceRoot, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.sources[0].actions[0].action, "created");
    const { docs } = await listDocs(workspaceRoot);
    assert.equal(docs.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace skips disabled sources", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "x.md"), "# X");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "L",
      scope: { root: docsDir },
      enabled: false,
    });
    const report = await syncWorkspace(workspaceRoot);
    assert.equal(report.sources.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /disabled/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace --source filters to one source", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const a = path.join(umbrella, "a");
  const b = path.join(umbrella, "b");
  try {
    await writeFile(path.join(a, "x.md"), "# X");
    await writeFile(path.join(b, "y.md"), "# Y");
    await addSource(workspaceRoot, {
      id: "a",
      kind: "local-folder",
      name: "A",
      scope: { root: a },
    });
    await addSource(workspaceRoot, {
      id: "b",
      kind: "local-folder",
      name: "B",
      scope: { root: b },
    });
    const report = await syncWorkspace(workspaceRoot, { source: "a" });
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].source, "a");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("syncWorkspace marks unchanged docs (same contentHash)", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  const docsDir = path.join(umbrella, "docs");
  try {
    await writeFile(path.join(docsDir, "x.md"), "# X\n\nBody.\n");
    await addSource(workspaceRoot, {
      id: "local",
      kind: "local-folder",
      name: "L",
      scope: { root: docsDir },
    });
    await syncWorkspace(workspaceRoot);
    const second = await syncWorkspace(workspaceRoot);
    const action = second.sources[0].actions.find((a) => a.docId === "x.md");
    assert.equal(action.action, "unchanged");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// MCP adapter (with fake client)
// ============================================================

test("McpSourceAdapter with fake client passes availability check", async () => {
  const client = buildFakeMcpClient({
    callTool: async () => ({ docs: [] }),
  });
  const adapter = new McpSourceAdapter({
    serverId: "fake",
    server: { command: "echo" },
    client,
  });
  const avail = await adapter.checkAvailability();
  assert.equal(avail.available, true);
});

test("McpSourceAdapter calls custom tool names from server config", async () => {
  const calls = [];
  const client = buildFakeMcpClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "my.list") return { docs: [{ docId: "a", title: "A" }] };
      if (name === "my.fetch") return { docId: "a", title: "A", body: "Body" };
      throw new Error("unexpected tool");
    },
  });
  const adapter = new McpSourceAdapter({
    serverId: "fake",
    server: { command: "echo", tools: { list: "my.list", fetch: "my.fetch" } },
    client,
  });
  const list = await adapter.listDocs();
  assert.equal(list[0].docId, "a");
  const f = await adapter.fetchDoc("a");
  assert.equal(f.body, "Body");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["my.list", "my.fetch"]
  );
});

test("syncWorkspace works with injected MCP adapter via factory", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addSource(workspaceRoot, {
      id: "fake-notion",
      kind: "notion",
      name: "Fake Notion",
      mcpServer: "fake",
    });
    const client = buildFakeMcpClient({
      callTool: async (name) => {
        if (name === "atelier_list_docs")
          return { docs: [{ docId: "p1", title: "Page One" }] };
        if (name === "atelier_fetch_doc")
          return { docId: "p1", title: "Page One", body: "# Page One\n\nBody.\n" };
        throw new Error("unknown tool: " + name);
      },
    });
    const report = await syncWorkspace(workspaceRoot, {
      adapterFactory: async (source) =>
        new McpSourceAdapter({
          serverId: "fake",
          server: { command: "echo" },
          client,
        }),
    });
    assert.equal(report.sources.length, 1);
    const created = report.sources[0].actions.find((a) => a.action === "created");
    assert.equal(created.docId, "p1");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("MCP transport flag is true once stdio transport ships", () => {
  assert.equal(MCP_TRANSPORT_READY, true);
});

// ============================================================
// mcp-config
// ============================================================

test("normalizeMcpServersConfig accepts a minimal config", () => {
  const cfg = normalizeMcpServersConfig(
    { version: 1, servers: { notion: { command: "npx", args: ["@notion/mcp"] } } },
    "test.json"
  );
  assert.deepEqual(cfg.servers.notion.args, ["@notion/mcp"]);
});

test("normalizeMcpServersConfig rejects missing command", () => {
  assert.throws(
    () =>
      normalizeMcpServersConfig({ version: 1, servers: { x: {} } }, "test.json"),
    /command must be a non-empty string/
  );
});

test("normalizeMcpServersConfig rejects wrong version", () => {
  assert.throws(
    () => normalizeMcpServersConfig({ version: 2, servers: {} }, "test.json"),
    /version/
  );
});

test("normalizeMcpServersConfig parses tools override", () => {
  const cfg = normalizeMcpServersConfig(
    {
      version: 1,
      servers: {
        x: { command: "x", tools: { list: "x.list", fetch: "x.fetch" } },
      },
    },
    "test.json"
  );
  assert.deepEqual(cfg.servers.x.tools, { list: "x.list", fetch: "x.fetch" });
});
