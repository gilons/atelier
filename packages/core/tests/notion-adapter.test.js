import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionAdapter, notionOnboarding, hashBody } from "../dist/index.js";

/**
 * Scripted fetch impl tailored for Notion. The script is a list of
 * matchers: each accepts the request URL/init and returns a Response
 * if it matches, or throws "no matcher".
 */
function notionFetch(matchers) {
  return async (url, init) => {
    for (const m of matchers) {
      const resp = await m(url, init);
      if (resp !== undefined) return resp;
    }
    throw new Error(`No matcher for ${init?.method ?? "GET"} ${url}`);
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fixturePage = {
  id: "page-1",
  object: "page",
  url: "https://www.notion.so/page-1",
  last_edited_time: "2026-05-17T12:00:00.000Z",
  properties: {
    Name: {
      type: "title",
      title: [{ plain_text: "Onboarding PRD" }],
    },
  },
};

const fixturePageNoTitle = {
  id: "page-2",
  object: "page",
  url: "https://www.notion.so/page-2",
  last_edited_time: "2026-05-17T13:00:00.000Z",
  properties: {
    Name: { type: "title", title: [] },
  },
};

// ============================================================
// listDocs
// ============================================================

test("NotionAdapter.listDocs paginates through /v1/search results", async () => {
  let searchCalls = 0;
  const fetchImpl = notionFetch([
    async (url, init) => {
      if (!url.includes("/search")) return;
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer test");
      assert.equal(init.headers["Notion-Version"], "2022-06-28");
      const body = JSON.parse(init.body);
      searchCalls++;
      if (searchCalls === 1) {
        assert.equal(body.start_cursor, undefined);
        return json(200, {
          results: [fixturePage],
          has_more: true,
          next_cursor: "cursor-1",
        });
      }
      assert.equal(body.start_cursor, "cursor-1");
      return json(200, {
        results: [fixturePageNoTitle],
        has_more: false,
        next_cursor: null,
      });
    },
  ]);
  const adapter = new NotionAdapter({ token: "test", fetchImpl });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
  assert.equal(docs[0].docId, "page-1");
  assert.equal(docs[0].title, "Onboarding PRD");
  assert.equal(docs[0].classification, "prd");
  assert.equal(docs[1].title, "(Untitled)");
});

test("NotionAdapter.listDocs honors scope.titleContains", async () => {
  const fetchImpl = notionFetch([
    async (url) => {
      if (!url.includes("/search")) return;
      return json(200, {
        results: [
          fixturePage,
          {
            ...fixturePage,
            id: "page-other",
            properties: { Name: { type: "title", title: [{ plain_text: "Sales notes" }] } },
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    },
  ]);
  const adapter = new NotionAdapter({
    token: "test",
    fetchImpl,
    scope: { titleContains: "prd" },
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].docId, "page-1");
});

test("NotionAdapter.listDocs respects scope.maxPages", async () => {
  let calls = 0;
  const fetchImpl = notionFetch([
    async (url, init) => {
      if (!url.includes("/search")) return;
      calls++;
      return json(200, {
        results: [{ ...fixturePage, id: `page-${calls}` }],
        has_more: true,
        next_cursor: `c${calls}`,
      });
    },
  ]);
  const adapter = new NotionAdapter({
    token: "test",
    fetchImpl,
    scope: { maxPages: 3 },
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 3);
  assert.equal(calls, 3);
});

// ============================================================
// fetchDoc + block rendering
// ============================================================

test("NotionAdapter.fetchDoc renders common block types as markdown", async () => {
  const fetchImpl = notionFetch([
    async (url) => {
      if (url.endsWith("/pages/page-1")) {
        return json(200, fixturePage);
      }
      if (url.includes("/blocks/page-1/children")) {
        return json(200, {
          results: [
            {
              id: "b1",
              type: "heading_1",
              has_children: false,
              heading_1: { rich_text: [{ plain_text: "Section A" }] },
            },
            {
              id: "b2",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "Hello world." }] },
            },
            {
              id: "b3",
              type: "bulleted_list_item",
              has_children: false,
              bulleted_list_item: { rich_text: [{ plain_text: "First bullet" }] },
            },
            {
              id: "b4",
              type: "to_do",
              has_children: false,
              to_do: { rich_text: [{ plain_text: "Do the thing" }], checked: true },
            },
            {
              id: "b5",
              type: "code",
              has_children: false,
              code: { rich_text: [{ plain_text: "let x = 1;" }], language: "javascript" },
            },
            {
              id: "b6",
              type: "divider",
              has_children: false,
              divider: {},
            },
            {
              id: "b7",
              type: "video",
              has_children: false,
              video: {},
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
    },
  ]);
  const adapter = new NotionAdapter({ token: "test", fetchImpl });
  const fetched = await adapter.fetchDoc("page-1");
  assert.equal(fetched.docId, "page-1");
  assert.equal(fetched.title, "Onboarding PRD");
  const body = fetched.body;
  assert.match(body, /^# Onboarding PRD/);
  assert.match(body, /^## Section A/m);
  assert.match(body, /Hello world\./);
  assert.match(body, /^- First bullet$/m);
  assert.match(body, /^- \[x\] Do the thing$/m);
  assert.match(body, /```javascript/);
  assert.match(body, /let x = 1;/);
  assert.match(body, /^---$/m);
  assert.match(body, /<!-- video block omitted -->/);
});

test("NotionAdapter.fetchDoc walks nested children up to depth limit", async () => {
  const fetchImpl = notionFetch([
    async (url) => {
      if (url.endsWith("/pages/page-1")) return json(200, fixturePage);
      if (url.includes("/blocks/page-1/children")) {
        return json(200, {
          results: [
            {
              id: "outer",
              type: "bulleted_list_item",
              has_children: true,
              bulleted_list_item: { rich_text: [{ plain_text: "Outer" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (url.includes("/blocks/outer/children")) {
        return json(200, {
          results: [
            {
              id: "inner",
              type: "bulleted_list_item",
              has_children: false,
              bulleted_list_item: { rich_text: [{ plain_text: "Inner" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
    },
  ]);
  const adapter = new NotionAdapter({ token: "test", fetchImpl });
  const fetched = await adapter.fetchDoc("page-1");
  assert.match(fetched.body, /- Outer/);
  // Nested should be indented two spaces.
  assert.match(fetched.body, /^  - Inner$/m);
});

// ============================================================
// availability
// ============================================================

test("NotionAdapter.checkAvailability returns ok on 200 from /users/me", async () => {
  const fetchImpl = notionFetch([
    async (url) => {
      if (url.endsWith("/users/me")) return json(200, { id: "bot-1" });
    },
  ]);
  const adapter = new NotionAdapter({ token: "test", fetchImpl });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, true);
});

test("NotionAdapter.checkAvailability surfaces 401 cleanly", async () => {
  const fetchImpl = notionFetch([
    async (url) => {
      if (url.endsWith("/users/me")) return json(401, { message: "unauthorized" });
    },
  ]);
  const adapter = new NotionAdapter({ token: "test", fetchImpl });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, false);
  assert.match(a.reason, /401/);
});

test("NotionAdapter constructor rejects empty token", () => {
  assert.throws(() => new NotionAdapter({ token: "" }), /requires a token/);
});

// ============================================================
// Onboarding flow shape
// ============================================================

test("notionOnboarding.availableTransports lists rest + mcp", async () => {
  const opts = await notionOnboarding.availableTransports();
  const t = opts.map((o) => o.transport).sort();
  assert.deepEqual(t, ["mcp", "rest"]);
});

test("notionOnboarding.toRegistryEntry produces a rest source + env var hint", () => {
  const entry = notionOnboarding.toRegistryEntry({
    transport: "rest",
    values: {
      id: "company-notion",
      name: "Company Notion",
      envVar: "NOTION_TOKEN",
      token: "secret_xxx",
      titleContains: "PRD",
    },
  });
  assert.equal(entry.source.id, "company-notion");
  assert.equal(entry.source.transport, "rest");
  assert.deepEqual(entry.source.credentials, { envVar: "NOTION_TOKEN" });
  assert.deepEqual(entry.source.scope, { titleContains: "PRD" });
  assert.deepEqual(entry.envVarsToSet, [
    { name: "NOTION_TOKEN", value: "secret_xxx", description: "Notion integration token (do not commit)" },
  ]);
});

test("notionOnboarding.toRegistryEntry mcp path skips envVarsToSet", () => {
  const entry = notionOnboarding.toRegistryEntry({
    transport: "mcp",
    values: { id: "n", name: "Notion", mcpServer: "company-notion" },
  });
  assert.equal(entry.source.transport, "mcp");
  assert.equal(entry.source.mcpServer, "company-notion");
  assert.equal(entry.envVarsToSet, undefined);
});

test("notionOnboarding.verify rejects bad token via mocked adapter", async () => {
  // Don't actually call out — the real `verify` uses fetch internally.
  // We rely on the constructor rejecting an empty token to exercise
  // the error path without network.
  const result = await notionOnboarding.verify({
    transport: "rest",
    values: { token: "" },
  });
  assert.equal(result.ok, false);
});
