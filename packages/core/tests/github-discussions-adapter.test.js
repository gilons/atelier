import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GitHubDiscussionsAdapter,
  githubDiscussionsOnboarding,
} from "../dist/index.js";

/**
 * Build a fake `gh` spawn that returns canned JSON per call. The
 * matcher function gets the args list; it should return a `{stdout,
 * stderr, code}` or `undefined` to fall through.
 */
function ghSpawn(matchers) {
  let calls = 0;
  const log = [];
  const fn = async (command, args, _opts) => {
    log.push({ command, args });
    calls++;
    for (const m of matchers) {
      const r = await m(command, args, calls);
      if (r !== undefined) return r;
    }
    throw new Error(`No matcher for gh call #${calls}: gh ${args.join(" ")}`);
  };
  fn.log = log;
  return fn;
}

function stdout(body) {
  return { stdout: body, stderr: "", code: 0 };
}

function makeDiscussion(repo, number, title, opts = {}) {
  return {
    id: `D_${repo}_${number}`,
    number,
    title,
    url: `https://github.com/${repo}/discussions/${number}`,
    updatedAt: "2026-05-17T10:00:00Z",
    body: opts.body ?? `Body for ${title}`,
    category: { name: opts.category ?? "Ideas" },
    author: { login: opts.author ?? "alice" },
    labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) },
  };
}

// ============================================================
// listDocs
// ============================================================

test("GitHubDiscussionsAdapter.listDocs queries each configured repo", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      const ownerArg = args.find((a) => a.startsWith("owner="));
      const nameArg = args.find((a) => a.startsWith("name="));
      const owner = ownerArg.slice("owner=".length);
      const name = nameArg.slice("name=".length);
      const repo = `${owner}/${name}`;
      return stdout(
        JSON.stringify({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [makeDiscussion(repo, 1, `${repo} discussion #1`)],
              },
            },
          },
        })
      );
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web", "acme/api"] },
    spawnImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map((d) => d.docId).sort(),
    ["acme/api#1", "acme/web#1"]
  );
  assert.equal(docs[0].classification, "discussion");
});

test("GitHubDiscussionsAdapter.listDocs reclassifies roadmap-labeled discussions", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      return stdout(
        JSON.stringify({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  makeDiscussion("acme/web", 7, "Q3 things", {
                    labels: ["roadmap", "platform"],
                  }),
                ],
              },
            },
          },
        })
      );
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs[0].classification, "roadmap");
});

test("GitHubDiscussionsAdapter.listDocs paginates until hasNextPage is false", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args, calls) => {
      if (args[0] !== "api") return;
      const hasAfter = args.some((a) => a.startsWith("after=") && !a.endsWith("=null"));
      if (!hasAfter) {
        return stdout(
          JSON.stringify({
            data: {
              repository: {
                discussions: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  nodes: [makeDiscussion("acme/web", calls, `p${calls}`)],
                },
              },
            },
          })
        );
      }
      return stdout(
        JSON.stringify({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [makeDiscussion("acme/web", calls, `p${calls}`)],
              },
            },
          },
        })
      );
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
});

test("GitHubDiscussionsAdapter.listDocs filters by category", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      return stdout(
        JSON.stringify({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  makeDiscussion("acme/web", 1, "Idea A", { category: "Ideas" }),
                  makeDiscussion("acme/web", 2, "Question A", { category: "Q&A" }),
                  makeDiscussion("acme/web", 3, "Idea B", { category: "Ideas" }),
                ],
              },
            },
          },
        })
      );
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"], categories: ["Ideas"] },
    spawnImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.docId), ["acme/web#1", "acme/web#3"]);
});

// ============================================================
// fetchDoc
// ============================================================

test("GitHubDiscussionsAdapter.fetchDoc returns rendered markdown for a discussion", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      // Single-discussion query has a `number=…` arg.
      if (args.some((a) => a.startsWith("number="))) {
        return stdout(
          JSON.stringify({
            data: {
              repository: {
                discussion: makeDiscussion("acme/web", 42, "Naming the feature", {
                  body: "We should call it Atelier.",
                  category: "Ideas",
                  author: "alice",
                  labels: ["design"],
                }),
              },
            },
          })
        );
      }
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  const fetched = await adapter.fetchDoc("acme/web#42");
  assert.equal(fetched.title, "Naming the feature");
  assert.match(fetched.body, /^# Naming the feature/);
  assert.match(fetched.body, /acme\/web discussion #42 · Ideas · by @alice/);
  assert.match(fetched.body, /labels: design/);
  assert.match(fetched.body, /We should call it Atelier\./);
});

test("GitHubDiscussionsAdapter.fetchDoc throws on a missing discussion", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      return stdout(JSON.stringify({ data: { repository: { discussion: null } } }));
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  await assert.rejects(
    () => adapter.fetchDoc("acme/web#999"),
    /not found/
  );
});

test("GitHubDiscussionsAdapter.fetchDoc rejects malformed docIds", async () => {
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  await assert.rejects(
    () => adapter.fetchDoc("not-a-valid-id"),
    /Invalid GitHub discussion docId/
  );
});

test("GitHubDiscussionsAdapter surfaces GraphQL errors from gh", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] !== "api") return;
      return stdout(
        JSON.stringify({
          errors: [{ message: "Field 'discussions' is private" }],
        })
      );
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  await assert.rejects(
    () => adapter.listDocs(),
    /GitHub GraphQL error.*private/
  );
});

// ============================================================
// Availability
// ============================================================

test("GitHubDiscussionsAdapter.checkAvailability requires gh + auth status", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] === "--version") return stdout("gh version 2.x");
      if (args[0] === "auth" && args[1] === "status") return stdout("Logged in");
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, true);
});

test("GitHubDiscussionsAdapter.checkAvailability surfaces gh-auth failure", async () => {
  const spawnImpl = ghSpawn([
    async (_cmd, args) => {
      if (args[0] === "--version") return stdout("gh version 2.x");
      if (args[0] === "auth")
        return { stdout: "", stderr: "Not logged in. Run `gh auth login`", code: 1 };
    },
  ]);
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: ["acme/web"] },
    spawnImpl,
  });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, false);
  assert.match(a.reason, /not authenticated/);
});

// ============================================================
// Constructor + onboarding
// ============================================================

test("GitHubDiscussionsAdapter constructor accepts an empty repos list (freshly onboarded)", () => {
  // Onboarding registers a github-discussions source with no repos
  // yet. `/doc add <url>` is what fills scope.repos and
  // scope.discussionIds. The old "at least one repo" guard
  // prevented this credentials-first flow.
  const adapter = new GitHubDiscussionsAdapter({ scope: { repos: [] } });
  assert.equal(adapter.kind, "github-discussions");
});

test("GitHubDiscussionsAdapter.listDocs returns [] when scope has no repos", async () => {
  // No gh calls expected — listDocs short-circuits on an empty
  // repos list. We pass a spawn that throws so any accidental
  // call would surface as a test failure.
  const adapter = new GitHubDiscussionsAdapter({
    scope: { repos: [] },
    spawnImpl: () => {
      throw new Error("spawn should not be called for empty-scope listDocs");
    },
  });
  const docs = await adapter.listDocs();
  assert.deepEqual(docs, []);
});

test("githubDiscussionsOnboarding.toRegistryEntry persists a credentials-only source with empty repos", () => {
  // Onboarding no longer asks for repos / categories / maxPerRepo.
  // The wizard collects id + name; everything else lands in scope
  // later via /doc add <url>.
  const entry = githubDiscussionsOnboarding.toRegistryEntry({
    transport: "cli",
    values: {
      id: "gh-discussions",
      name: "GH Discussions",
    },
  });
  assert.equal(entry.source.kind, "github-discussions");
  assert.equal(entry.source.transport, "cli");
  assert.deepEqual(entry.source.scope, { repos: [] });
});

test("githubDiscussionsOnboarding.availableTransports lists only cli", async () => {
  const opts = await githubDiscussionsOnboarding.availableTransports();
  assert.equal(opts.length, 1);
  assert.equal(opts[0].transport, "cli");
});
