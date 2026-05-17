import { test } from "node:test";
import assert from "node:assert/strict";
import { completeLine, REPL_BUILTINS } from "../dist/repl-completer.js";

/**
 * Build a small synthetic command registry so tests don't depend
 * on the real adapters/commands shipping at any given moment.
 */
function makeRegistry() {
  return {
    commands: [
      {
        name: "init",
        summary: "Initialize a workspace",
        options: { name: { type: "string" }, force: { type: "boolean" } },
      },
      {
        name: "repo",
        summary: "Manage repos",
        subcommands: [
          { name: "list", summary: "List registered repos" },
          { name: "add", summary: "Register a repo", options: { name: { type: "string" } } },
          { name: "discover", summary: "Discover repos via gh" },
        ],
      },
      {
        name: "source",
        summary: "Manage sources",
        subcommands: [
          { name: "list", summary: "List sources" },
          {
            name: "onboard",
            summary: "Onboard a source",
            positionals: ["kind"],
            options: {
              transport: { type: "string" },
              "non-interactive": { type: "boolean" },
            },
            complete(priorArgs, partial) {
              if (priorArgs.length === 0) {
                return [
                  { value: "notion ", display: "notion", description: "Notion" },
                  { value: "sharepoint ", display: "sharepoint", description: "SharePoint" },
                  {
                    value: "github-discussions ",
                    display: "github-discussions",
                    description: "GitHub Discussions",
                  },
                ].filter((s) => s.display.startsWith(partial.toLowerCase()));
              }
              return [];
            },
          },
        ],
      },
    ],
  };
}

function values(result) {
  return result.items.map((s) => s.value);
}

function displays(result) {
  return result.items.map((s) => s.display ?? s.value);
}

// ============================================================
// Empty / non-slash input
// ============================================================

test("completeLine: empty input returns no suggestions (clean prompt)", () => {
  // The menu only opens once the user starts typing — keeps the
  // welcome banner uncluttered and avoids pushing the visual
  // cursor off-screen on short terminals.
  const r = completeLine(makeRegistry(), "");
  assert.deepEqual(r.items, []);
  assert.equal(r.span, "");
});

test("completeLine: '/' (just the slash) lists every top-level command", () => {
  const r = completeLine(makeRegistry(), "/");
  const displayed = displays(r);
  for (const b of REPL_BUILTINS) {
    assert.ok(displayed.includes(`/${b}`), `missing /${b}`);
  }
  for (const c of ["/init", "/repo", "/source"]) {
    assert.ok(displayed.includes(c), `missing ${c}`);
  }
});

test("completeLine: every top-level suggestion carries its summary as description", () => {
  const r = completeLine(makeRegistry(), "/");
  const init = r.items.find((s) => s.display === "/init");
  assert.equal(init.description, "Initialize a workspace");
  const repo = r.items.find((s) => s.display === "/repo");
  assert.equal(repo.description, "Manage repos");
});

test("completeLine: non-slash text returns no suggestions", () => {
  const r = completeLine(makeRegistry(), "hello");
  assert.deepEqual(r.items, []);
});

// ============================================================
// Top-level partial matching
// ============================================================

test("completeLine: '/r' matches /repo only", () => {
  const r = completeLine(makeRegistry(), "/r");
  assert.deepEqual(displays(r), ["/repo"]);
  assert.equal(r.span, "/r");
});

test("completeLine: '/s' matches /source and /status (built-in)", () => {
  const r = completeLine(makeRegistry(), "/s");
  const d = displays(r);
  assert.ok(d.includes("/source"));
  assert.ok(d.includes("/status"));
});

test("completeLine: '/notarealcmd' returns nothing", () => {
  const r = completeLine(makeRegistry(), "/notarealcmd");
  assert.deepEqual(r.items, []);
});

// ============================================================
// Subcommand completion
// ============================================================

test("completeLine: '/repo ' lists subcommands with summaries", () => {
  const r = completeLine(makeRegistry(), "/repo ");
  const d = displays(r);
  assert.deepEqual(d.sort(), ["add", "discover", "list"]);
  const list = r.items.find((s) => s.display === "list");
  assert.equal(list.description, "List registered repos");
});

test("completeLine: '/repo a' filters to add", () => {
  const r = completeLine(makeRegistry(), "/repo a");
  assert.deepEqual(displays(r), ["add"]);
  assert.equal(r.span, "a");
});

test("completeLine: '/repo di' completes to discover", () => {
  const r = completeLine(makeRegistry(), "/repo di");
  assert.deepEqual(displays(r), ["discover"]);
});

// ============================================================
// Per-command positional completion
// ============================================================

test("completeLine: '/source onboard ' suggests source kinds with display names as descriptions", () => {
  const r = completeLine(makeRegistry(), "/source onboard ");
  const notion = r.items.find((s) => s.display === "notion");
  assert.ok(notion);
  assert.equal(notion.description, "Notion");
  const gh = r.items.find((s) => s.display === "github-discussions");
  assert.equal(gh.description, "GitHub Discussions");
  // Option flags follow.
  assert.ok(values(r).includes("--transport "));
});

test("completeLine: '/source onboard not' filters kinds by prefix", () => {
  const r = completeLine(makeRegistry(), "/source onboard not");
  assert.deepEqual(displays(r), ["notion"]);
  assert.equal(r.span, "not");
});

test("completeLine: '/source onboard github' completes to github-discussions", () => {
  const r = completeLine(makeRegistry(), "/source onboard github");
  assert.deepEqual(displays(r), ["github-discussions"]);
});

// ============================================================
// Option flag completion
// ============================================================

test("completeLine: '/source onboard notion --' lists option flags", () => {
  const r = completeLine(makeRegistry(), "/source onboard notion --");
  const v = values(r);
  assert.ok(v.includes("--transport "));
  assert.ok(v.includes("--non-interactive "));
  assert.equal(r.span, "--");
});

test("completeLine: '/source onboard notion --tr' completes --transport", () => {
  const r = completeLine(makeRegistry(), "/source onboard notion --tr");
  assert.deepEqual(values(r), ["--transport "]);
  assert.equal(r.span, "--tr");
});

test("completeLine: option type hint surfaces as description", () => {
  const r = completeLine(makeRegistry(), "/init --");
  const name = r.items.find((s) => s.display === "--name");
  assert.equal(name.description, "<value>");
  const force = r.items.find((s) => s.display === "--force");
  assert.equal(force.description, "flag");
});

// ============================================================
// Leaf with no extras
// ============================================================

test("completeLine: a leaf with no options and no complete hook returns nothing", () => {
  const r = completeLine({ commands: [{ name: "ping", summary: "ping" }] }, "/ping ");
  assert.deepEqual(r.items, []);
});
