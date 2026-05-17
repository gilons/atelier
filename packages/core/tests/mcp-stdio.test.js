import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  StdioMcpClient,
  McpSourceAdapter,
  syncWorkspace,
  initWorkspace,
  addSource,
  listDocs,
  MCP_TRANSPORT_READY,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "mcp-fake-server.mjs");

function fakeServer(scenario) {
  return {
    command: process.execPath,
    args: [FIXTURE],
    env: scenario ? { FIXTURE_SCENARIO: scenario } : undefined,
  };
}

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-mcp-stdio-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

// ============================================================
// MCP_TRANSPORT_READY flag
// ============================================================

test("MCP_TRANSPORT_READY is true once stdio transport ships", () => {
  assert.equal(MCP_TRANSPORT_READY, true);
});

// ============================================================
// Lifecycle: spawn → initialize → tool call → dispose
// ============================================================

test("StdioMcpClient completes initialize handshake against the fixture", async () => {
  const client = new StdioMcpClient(fakeServer());
  try {
    await client.whenReady();
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient.callTool returns structuredContent for happy path", async () => {
  const client = new StdioMcpClient(fakeServer());
  try {
    const list = await client.callTool("atelier_list_docs", {});
    assert.ok(Array.isArray(list.docs));
    assert.equal(list.docs.length, 2);
    const fetched = await client.callTool("atelier_fetch_doc", { docId: "intro" });
    assert.equal(fetched.docId, "intro");
    assert.match(fetched.body, /Welcome to the test fixture/);
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient falls back to text content blocks when structuredContent absent", async () => {
  const client = new StdioMcpClient(fakeServer("text-content"));
  try {
    const list = await client.callTool("atelier_list_docs", {});
    assert.equal(list.docs.length, 2);
    const fetched = await client.callTool("atelier_fetch_doc", { docId: "spec" });
    assert.match(fetched.body, /This is the product spec/);
  } finally {
    await client.dispose();
  }
});

// ============================================================
// Error paths
// ============================================================

test("StdioMcpClient.callTool surfaces isError tool results", async () => {
  const client = new StdioMcpClient(fakeServer("tool-error"));
  try {
    await assert.rejects(
      () => client.callTool("atelier_list_docs", {}),
      (err) => /Fixture failure/.test(err.message)
    );
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient surfaces a server-side initialize error", async () => {
  const client = new StdioMcpClient(fakeServer("bad-init"));
  try {
    await assert.rejects(
      () => client.whenReady(),
      (err) => /refused initialize/.test(err.message)
    );
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient rejects pending requests if the server crashes", async () => {
  const client = new StdioMcpClient(fakeServer("crash-after-init"));
  try {
    await client.whenReady();
    await assert.rejects(
      () => client.callTool("atelier_list_docs", {}),
      (err) => /exited|in flight|exit code/i.test(err.message)
    );
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient surfaces spawn errors", async () => {
  const client = new StdioMcpClient({
    command: "/no/such/binary/atelier-test",
    args: [],
  });
  try {
    await assert.rejects(
      () => client.whenReady(),
      (err) => /ENOENT|spawn/i.test(err.message)
    );
  } finally {
    await client.dispose();
  }
});

// ============================================================
// McpSourceAdapter availability check
// ============================================================

test("McpSourceAdapter checkAvailability waits for whenReady and returns ok", async () => {
  const client = new StdioMcpClient(fakeServer());
  try {
    const adapter = new McpSourceAdapter({
      serverId: "fake",
      server: fakeServer(),
      client,
    });
    const a = await adapter.checkAvailability();
    assert.equal(a.available, true);
  } finally {
    await client.dispose();
  }
});

test("McpSourceAdapter checkAvailability surfaces init failure", async () => {
  const client = new StdioMcpClient(fakeServer("bad-init"));
  try {
    const adapter = new McpSourceAdapter({
      serverId: "broken",
      server: fakeServer("bad-init"),
      client,
    });
    const a = await adapter.checkAvailability();
    assert.equal(a.available, false);
    assert.match(a.reason, /refused initialize/);
  } finally {
    await client.dispose();
  }
});

// ============================================================
// End-to-end sync against the real subprocess
// ============================================================

test("syncWorkspace can pull docs from a real spawned MCP server", async () => {
  const { umbrella, workspaceRoot } = await workspace();
  try {
    await addSource(workspaceRoot, {
      id: "fake-notion",
      kind: "notion",
      name: "Fake Notion",
      mcpServer: "fake",
    });
    const report = await syncWorkspace(workspaceRoot, {
      adapterFactory: async (source) => {
        const client = new StdioMcpClient(fakeServer());
        return Object.assign(
          new McpSourceAdapter({
            serverId: "fake",
            server: fakeServer(),
            client,
          }),
          { dispose: () => client.dispose() }
        );
      },
    });
    assert.equal(report.sources.length, 1);
    const s = report.sources[0];
    assert.equal(s.actions.filter((a) => a.action === "created").length, 2);
    const { docs } = await listDocs(workspaceRoot, "fake-notion");
    const intro = docs.find((d) => d.doc.docId === "intro");
    assert.match(intro.doc.body, /Welcome to the test fixture/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// Tool-shape mapping — adapts a server returning a non-Atelier
// shape (e.g. a generic SharePoint MCP server) into the
// adapter's expected RemoteDocMetadata / FetchedDoc form.
// ============================================================

function fakeMappingClient(map) {
  const calls = [];
  return {
    calls,
    callTool(name, args) {
      calls.push({ name, args });
      return Promise.resolve(map[name]);
    },
    dispose() {
      return Promise.resolve();
    },
  };
}

test("McpSourceAdapter.listDocs honors a tool-shape mapping", async () => {
  // Simulate a SharePoint-style server returning { value: [...] }
  // with field names that don't match Atelier's native shape.
  const client = fakeMappingClient({
    spo_list_files: {
      value: [
        {
          id: "01ABC",
          name: "spec.md",
          webUrl: "https://contoso.sharepoint.com/.../spec.md",
          lastModifiedDateTime: "2026-05-10T09:00:00Z",
        },
        {
          id: "01DEF",
          name: "notes.md",
          webUrl: "https://contoso.sharepoint.com/.../notes.md",
          lastModifiedDateTime: "2026-05-11T12:00:00Z",
        },
      ],
    },
  });
  const adapter = new McpSourceAdapter({
    serverId: "fake-sharepoint",
    server: {
      command: "irrelevant",
      tools: {
        list: {
          name: "spo_list_files",
          args: { siteUrl: "https://contoso.sharepoint.com" },
          map: {
            docs: "value",
            docId: "id",
            title: "name",
            url: "webUrl",
            lastModified: "lastModifiedDateTime",
          },
        },
      },
    },
    client,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[0], {
    docId: "01ABC",
    title: "spec.md",
    summary: undefined,
    url: "https://contoso.sharepoint.com/.../spec.md",
    contentHash: undefined,
    lastModified: "2026-05-10T09:00:00Z",
  });
  // The static args should have been forwarded to the tool call.
  assert.deepEqual(client.calls[0].args.siteUrl, "https://contoso.sharepoint.com");
});

test("McpSourceAdapter.fetchDoc honors mapping + custom argKey", async () => {
  const client = fakeMappingClient({
    spo_get_file: {
      name: "spec.md",
      webUrl: "https://contoso.sharepoint.com/.../spec.md",
      contents: "# Spec\n\nThe body.",
    },
  });
  const adapter = new McpSourceAdapter({
    serverId: "fake-sharepoint",
    server: {
      command: "irrelevant",
      tools: {
        fetch: {
          name: "spo_get_file",
          argKey: "fileId",
          args: { siteUrl: "https://contoso.sharepoint.com" },
          map: {
            body: "contents",
            title: "name",
            url: "webUrl",
          },
        },
      },
    },
    client,
  });
  const fetched = await adapter.fetchDoc("01ABC");
  assert.equal(fetched.docId, "01ABC");
  assert.equal(fetched.title, "spec.md");
  assert.match(fetched.body, /# Spec/);
  // The docId should have been forwarded under the custom arg key.
  assert.equal(client.calls[0].args.fileId, "01ABC");
  // Static args still merged in.
  assert.equal(
    client.calls[0].args.siteUrl,
    "https://contoso.sharepoint.com"
  );
});

test("McpSourceAdapter.listDocs without a mapping still validates the native shape", async () => {
  const client = fakeMappingClient({
    atelier_list_docs: { docs: [{ docId: "a", title: "A" }] },
  });
  const adapter = new McpSourceAdapter({
    serverId: "native",
    server: { command: "irrelevant" }, // no tools override
    client,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].docId, "a");
});
