import { test } from "node:test";
import assert from "node:assert/strict";
import { completeLine, REPL_BUILTINS } from "../dist/repl-completer.js";

/**
 * Build a small synthetic command registry so tests don't depend on
 * the real adapters / commands shipping at any given moment.
 */
function makeRegistry() {
  return {
    commands: [
      {
        name: "init",
        summary: "Init",
        options: { name: { type: "string" }, force: { type: "boolean" } },
      },
      {
        name: "repo",
        summary: "Manage repos",
        subcommands: [
          { name: "list", summary: "list" },
          { name: "add", summary: "add", options: { name: { type: "string" } } },
          { name: "discover", summary: "discover" },
        ],
      },
      {
        name: "source",
        summary: "Manage sources",
        subcommands: [
          { name: "list", summary: "list" },
          {
            name: "onboard",
            summary: "onboard",
            positionals: ["kind"],
            options: {
              transport: { type: "string" },
              "non-interactive": { type: "boolean" },
            },
            complete(priorArgs, partial) {
              if (priorArgs.length === 0) {
                return ["notion", "sharepoint", "github-discussions"].filter(
                  (k) => k.startsWith(partial.toLowerCase())
                );
              }
              return [];
            },
          },
        ],
      },
    ],
  };
}

// ============================================================
// Empty / non-slash input
// ============================================================

test("completeLine: empty input suggests the / prefix", () => {
  const [m, sub] = completeLine(makeRegistry(), "");
  assert.deepEqual(m, ["/"]);
  assert.equal(sub, "");
});

test("completeLine: non-slash input returns no completions", () => {
  const [m] = completeLine(makeRegistry(), "hello");
  assert.deepEqual(m, []);
});

// ============================================================
// Top-level command name
// ============================================================

test("completeLine: '/' returns all commands incl. REPL built-ins", () => {
  const [m, sub] = completeLine(makeRegistry(), "/");
  // Should be sorted alphabetically and include all built-ins + registry commands.
  for (const builtin of REPL_BUILTINS) {
    assert.ok(m.includes(`/${builtin}`), `missing /${builtin}`);
  }
  for (const cmd of ["/init", "/repo", "/source"]) {
    assert.ok(m.includes(cmd), `missing ${cmd}`);
  }
  assert.equal(sub, "/");
});

test("completeLine: '/r' completes to /repo (and nothing else)", () => {
  const [m, sub] = completeLine(makeRegistry(), "/r");
  assert.deepEqual(m, ["/repo"]);
  assert.equal(sub, "/r");
});

test("completeLine: '/s' has both /source and /status (built-in)", () => {
  const [m] = completeLine(makeRegistry(), "/s");
  assert.ok(m.includes("/source"));
  assert.ok(m.includes("/status"));
});

test("completeLine: '/notarealcmd' returns nothing", () => {
  const [m] = completeLine(makeRegistry(), "/notarealcmd");
  assert.deepEqual(m, []);
});

// ============================================================
// Subcommand completion
// ============================================================

test("completeLine: '/repo ' (trailing space) lists all subcommands", () => {
  const [m, sub] = completeLine(makeRegistry(), "/repo ");
  assert.deepEqual(m.sort(), ["add", "discover", "list"]);
  assert.equal(sub, "");
});

test("completeLine: '/repo a' completes to 'add'", () => {
  const [m, sub] = completeLine(makeRegistry(), "/repo a");
  assert.deepEqual(m, ["add"]);
  assert.equal(sub, "a");
});

test("completeLine: '/repo di' completes to 'discover'", () => {
  const [m] = completeLine(makeRegistry(), "/repo di");
  assert.deepEqual(m, ["discover"]);
});

test("completeLine: '/repo nope' returns no matches", () => {
  const [m] = completeLine(makeRegistry(), "/repo nope");
  assert.deepEqual(m, []);
});

// ============================================================
// Per-command positional completion (source onboard <kind>)
// ============================================================

test("completeLine: '/source onboard ' lists source kinds via complete() hook", () => {
  const [m] = completeLine(makeRegistry(), "/source onboard ");
  // The completer returns positional candidates AND option flags.
  for (const kind of ["notion", "sharepoint", "github-discussions"]) {
    assert.ok(m.includes(kind), `missing kind ${kind}`);
  }
  // Option flags follow.
  assert.ok(m.includes("--transport"));
  assert.ok(m.includes("--non-interactive"));
});

test("completeLine: '/source onboard not' filters kinds by prefix", () => {
  const [m, sub] = completeLine(makeRegistry(), "/source onboard not");
  assert.deepEqual(m, ["notion"]);
  assert.equal(sub, "not");
});

test("completeLine: '/source onboard github' completes to github-discussions", () => {
  const [m] = completeLine(makeRegistry(), "/source onboard github");
  assert.deepEqual(m, ["github-discussions"]);
});

// ============================================================
// Option flag completion
// ============================================================

test("completeLine: '/source onboard notion --' lists every option flag", () => {
  const [m, sub] = completeLine(makeRegistry(), "/source onboard notion --");
  assert.ok(m.includes("--transport"));
  assert.ok(m.includes("--non-interactive"));
  assert.equal(sub, "--");
});

test("completeLine: '/source onboard notion --tr' completes --transport", () => {
  const [m, sub] = completeLine(makeRegistry(), "/source onboard notion --tr");
  assert.deepEqual(m, ["--transport"]);
  assert.equal(sub, "--tr");
});

test("completeLine: '/init --' lists init options", () => {
  const [m] = completeLine(makeRegistry(), "/init --");
  assert.ok(m.includes("--name"));
  assert.ok(m.includes("--force"));
});

// ============================================================
// Group commands that have run() too — not in our synthetic registry,
// but a regression check: leaf with no subcommands still works.
// ============================================================

test("completeLine: a leaf with no options and no complete hook returns nothing", () => {
  const registry = {
    commands: [{ name: "ping", summary: "ping" }],
  };
  const [m] = completeLine(registry, "/ping ");
  assert.deepEqual(m, []);
});
