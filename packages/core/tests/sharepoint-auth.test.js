import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BearerTokenProvider,
  AzureClientCredentialsProvider,
  buildTokenProviderFromCredentials,
} from "../dist/index.js";

// ============================================================
// BearerTokenProvider
// ============================================================

test("BearerTokenProvider returns the static token", async () => {
  const p = new BearerTokenProvider("abc.def.ghi");
  assert.equal(await p.getToken(), "abc.def.ghi");
  // Subsequent calls return the same token (no refresh).
  assert.equal(await p.getToken(), "abc.def.ghi");
});

test("BearerTokenProvider rejects an empty token at construction", () => {
  assert.throws(() => new BearerTokenProvider(""), /non-empty token/);
});

// ============================================================
// AzureClientCredentialsProvider
// ============================================================

function makeFakeFetch(responses) {
  // `responses` is an array of {body, status?} — each call shifts
  // the next one off the queue so tests can simulate ordered
  // exchanges (mint → cached-hit → expiry → re-mint).
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        statusText: next.statusText ?? "OK",
        text: async () => next.body,
        json: async () => JSON.parse(next.body),
      };
    },
  };
}

test("AzureClientCredentialsProvider mints, caches, and re-mints after expiry", async () => {
  let now = 1_000_000_000_000;
  const f = makeFakeFetch([
    { body: JSON.stringify({ access_token: "first-token", expires_in: 3600 }) },
    { body: JSON.stringify({ access_token: "second-token", expires_in: 3600 }) },
  ]);
  const p = new AzureClientCredentialsProvider({
    tenantId: "tenant-guid",
    clientId: "client-guid",
    clientSecret: "secret-value",
    fetchImpl: f.fetchImpl,
    now: () => now,
  });

  // First call mints.
  assert.equal(await p.getToken(), "first-token");
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/tenant-guid\/oauth2\/v2\.0\/token$/);
  // Second call within TTL → cache hit, no new fetch.
  assert.equal(await p.getToken(), "first-token");
  assert.equal(f.calls.length, 1);

  // Advance to just before refresh skew — still cached.
  now += (3600 - 90) * 1000;
  assert.equal(await p.getToken(), "first-token");
  assert.equal(f.calls.length, 1);

  // Advance past the skew — provider re-mints.
  now += 60 * 1000;
  assert.equal(await p.getToken(), "second-token");
  assert.equal(f.calls.length, 2);
});

test("AzureClientCredentialsProvider serializes concurrent cold-start calls into one mint", async () => {
  const f = makeFakeFetch([
    { body: JSON.stringify({ access_token: "shared-token", expires_in: 3600 }) },
  ]);
  const p = new AzureClientCredentialsProvider({
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    fetchImpl: f.fetchImpl,
  });
  // 5 concurrent callers during cold start should produce ONE fetch,
  // not 5. Without the in-flight de-dupe we'd burn 5 mints against
  // Microsoft per process start.
  const tokens = await Promise.all([
    p.getToken(),
    p.getToken(),
    p.getToken(),
    p.getToken(),
    p.getToken(),
  ]);
  assert.deepEqual(tokens, [
    "shared-token",
    "shared-token",
    "shared-token",
    "shared-token",
    "shared-token",
  ]);
  assert.equal(f.calls.length, 1);
});

test("AzureClientCredentialsProvider surfaces Microsoft's error_description", async () => {
  const f = makeFakeFetch([
    {
      status: 401,
      body: JSON.stringify({
        error: "invalid_client",
        error_description: "Client secret is invalid.",
      }),
    },
  ]);
  const p = new AzureClientCredentialsProvider({
    tenantId: "t",
    clientId: "c",
    clientSecret: "bad",
    fetchImpl: f.fetchImpl,
  });
  await assert.rejects(() => p.getToken(), /Client secret is invalid/);
});

test("AzureClientCredentialsProvider sends the right form-encoded body", async () => {
  const f = makeFakeFetch([
    { body: JSON.stringify({ access_token: "tok", expires_in: 3600 }) },
  ]);
  const p = new AzureClientCredentialsProvider({
    tenantId: "ten",
    clientId: "cli",
    clientSecret: "sek",
    fetchImpl: f.fetchImpl,
  });
  await p.getToken();
  const body = f.calls[0].body;
  // Compact assertions — the body contains every required field.
  assert.match(body, /client_id=cli/);
  assert.match(body, /client_secret=sek/);
  assert.match(body, /grant_type=client_credentials/);
  assert.match(body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
});

// ============================================================
// buildTokenProviderFromCredentials
// ============================================================

test("buildTokenProviderFromCredentials returns BearerTokenProvider for envVar shape", async () => {
  const p = buildTokenProviderFromCredentials(
    { envVar: "TEST_TOKEN" },
    { sourceId: "x", env: { TEST_TOKEN: "static-token" } }
  );
  assert.equal(await p.getToken(), "static-token");
});

test("buildTokenProviderFromCredentials returns AzureClientCredentialsProvider for the azure shape", () => {
  const p = buildTokenProviderFromCredentials(
    {
      kind: "azureClientCredentials",
      tenantId: "t-guid",
      clientId: "c-guid",
      clientSecretEnvVar: "S",
    },
    { sourceId: "x", env: { S: "secret-value" } }
  );
  assert.equal(p instanceof AzureClientCredentialsProvider, true);
});

test("buildTokenProviderFromCredentials errors when the bearer env var is empty", () => {
  assert.throws(
    () =>
      buildTokenProviderFromCredentials(
        { envVar: "MISSING" },
        { sourceId: "x", env: {} }
      ),
    /MISSING/
  );
});

test("buildTokenProviderFromCredentials errors when the azure secret env var is empty", () => {
  assert.throws(
    () =>
      buildTokenProviderFromCredentials(
        {
          kind: "azureClientCredentials",
          tenantId: "t",
          clientId: "c",
          clientSecretEnvVar: "MISSING_SECRET",
        },
        { sourceId: "x", env: {} }
      ),
    /MISSING_SECRET/
  );
});
