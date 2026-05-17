import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient, HttpError, resolveCredential } from "../dist/index.js";

/**
 * A scripted fetch impl. Each call asserts the request matches what
 * we expect, then returns a canned Response. Keeps tests offline
 * and deterministic.
 */
function scriptedFetch(script) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (i >= script.length) {
      throw new Error(`unexpected extra call to fetch: ${url}`);
    }
    const step = script[i++];
    if (step.assert) step.assert({ url, init });
    return new Response(step.body ?? "", {
      status: step.status ?? 200,
      headers: step.headers ?? { "Content-Type": "application/json" },
    });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

test("HttpClient.request applies auth headers and parses JSON", async () => {
  const fetchImpl = scriptedFetch([
    {
      assert: ({ url, init }) => {
        assert.equal(url, "https://api.example.com/v1/me");
        assert.equal(init.method, "GET");
        assert.equal(init.headers.Authorization, "Bearer test");
        assert.equal(init.headers["User-Agent"], "atelier-test");
      },
      body: JSON.stringify({ id: "u1", name: "Test" }),
    },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com/v1",
    authHeaders: () => ({ Authorization: "Bearer test" }),
    userAgent: "atelier-test",
    fetchImpl,
    sleepImpl: noSleep,
  });
  const result = await client.request({ path: "/me" });
  assert.deepEqual(result, { id: "u1", name: "Test" });
});

test("HttpClient.request POSTs JSON body and sets Content-Type", async () => {
  const fetchImpl = scriptedFetch([
    {
      assert: ({ init }) => {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["Content-Type"], "application/json");
        assert.equal(init.body, JSON.stringify({ query: "x" }));
      },
      body: JSON.stringify({ ok: true }),
    },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: noSleep,
  });
  await client.request({ method: "POST", path: "/search", body: { query: "x" } });
});

test("HttpClient.request retries on 429 with Retry-After honored", async () => {
  const sleeps = [];
  const fetchImpl = scriptedFetch([
    { status: 429, headers: { "Retry-After": "2" }, body: "rate limit" },
    { body: JSON.stringify({ ok: true }) },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
    retryBaseMs: 1, // ensure we'd notice the wrong delay if used
  });
  await client.request({ path: "/x" });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("HttpClient.request retries on 503 with exponential backoff when no Retry-After", async () => {
  const sleeps = [];
  const fetchImpl = scriptedFetch([
    { status: 503, body: "bad" },
    { status: 503, body: "still bad" },
    { body: JSON.stringify({ ok: true }) },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
    retryBaseMs: 100,
  });
  await client.request({ path: "/x" });
  // 100, then 200 (exponential base 100, doubled each time)
  assert.deepEqual(sleeps, [100, 200]);
});

test("HttpClient.request gives up after maxRetries and throws HttpError", async () => {
  const fetchImpl = scriptedFetch([
    { status: 500, body: "error 1" },
    { status: 500, body: "error 2" },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: noSleep,
    maxRetries: 1,
  });
  await assert.rejects(
    () => client.request({ path: "/x" }),
    (err) => err instanceof HttpError && err.status === 500
  );
});

test("HttpClient.request does not retry on 4xx (other than 429)", async () => {
  const fetchImpl = scriptedFetch([
    { status: 401, body: '{"message":"unauthorized"}' },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () => client.request({ path: "/me" }),
    (err) => err instanceof HttpError && err.status === 401
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("HttpClient.request encodes query parameters", async () => {
  const fetchImpl = scriptedFetch([
    {
      assert: ({ url }) =>
        assert.ok(
          url.includes("filter=feature") && url.includes("limit=5"),
          `bad url: ${url}`
        ),
      body: "{}",
    },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: noSleep,
  });
  await client.request({
    path: "/x",
    query: { filter: "feature", limit: 5, skip: undefined },
  });
});

test("HttpClient.paginate collects items across pages", async () => {
  const fetchImpl = scriptedFetch([
    {
      body: JSON.stringify({
        results: [{ id: 1 }, { id: 2 }],
        has_more: true,
        next_cursor: "abc",
      }),
    },
    {
      assert: ({ url }) => assert.ok(url.includes("cursor=abc")),
      body: JSON.stringify({
        results: [{ id: 3 }],
        has_more: false,
        next_cursor: null,
      }),
    },
  ]);
  const client = new HttpClient({
    baseUrl: "https://api.example.com",
    authHeaders: () => ({}),
    fetchImpl,
    sleepImpl: noSleep,
  });
  const items = await client.paginate(
    { path: "/list" },
    ["results"],
    (resp) => (resp.has_more ? { path: "/list", query: { cursor: resp.next_cursor } } : null)
  );
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("resolveCredential reads envVar from process.env", async () => {
  process.env.__ATELIER_TEST_TOKEN = "shhh";
  try {
    const v = await resolveCredential(
      { envVar: "__ATELIER_TEST_TOKEN" },
      { sourceId: "x" }
    );
    assert.equal(v, "shhh");
  } finally {
    delete process.env.__ATELIER_TEST_TOKEN;
  }
});

test("resolveCredential errors when env var is missing or empty", async () => {
  delete process.env.__ATELIER_TEST_MISSING;
  await assert.rejects(
    () => resolveCredential({ envVar: "__ATELIER_TEST_MISSING" }, { sourceId: "x" }),
    /empty/
  );
  await assert.rejects(
    () => resolveCredential(undefined, { sourceId: "x" }),
    /missing credentials/
  );
});
