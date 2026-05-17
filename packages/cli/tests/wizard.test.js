import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLeaf } from "../dist/wizard.js";

/**
 * `resolveLeaf` is the pure pre-wizard step — figure out which leaf
 * command the user invoked, and what args they passed. The
 * prompt-runner half needs a real stdin/stdout to exercise, so we
 * cover it via the end-to-end REPL smoke test rather than unit tests
 * (would require non-trivial stream plumbing).
 */

function makeRegistry() {
  return {
    commands: [
      {
        name: "init",
        summary: "init",
        prompts: [{ key: "name", question: "Workspace name" }],
      },
      {
        name: "repo",
        summary: "repo",
        subcommands: [
          {
            name: "add",
            summary: "add",
            positionals: ["path"],
            prompts: [
              {
                key: "path",
                question: "Path",
                positionalIndex: 0,
              },
            ],
          },
          { name: "list", summary: "list" },
        ],
      },
      {
        name: "feature",
        summary: "feature",
        subcommands: [
          {
            name: "add",
            summary: "add",
            positionals: ["name?"],
            prompts: [{ key: "name", question: "Name", positionalIndex: 0 }],
          },
        ],
      },
    ],
  };
}

test("resolveLeaf returns null for empty argv", () => {
  assert.equal(resolveLeaf(makeRegistry(), []), null);
});

test("resolveLeaf returns null for unknown command", () => {
  assert.equal(resolveLeaf(makeRegistry(), ["unicorn"]), null);
});

test("resolveLeaf walks into subcommands", () => {
  const r = resolveLeaf(makeRegistry(), ["repo", "add", "../api"]);
  assert.ok(r);
  assert.equal(r.command.name, "add");
  assert.deepEqual(r.trail, ["repo", "add"]);
  assert.deepEqual(r.supplied, ["../api"]);
});

test("resolveLeaf returns the group command itself when no matching subcommand follows", () => {
  const r = resolveLeaf(makeRegistry(), ["repo"]);
  assert.ok(r);
  assert.equal(r.command.name, "repo");
  assert.deepEqual(r.trail, ["repo"]);
  assert.deepEqual(r.supplied, []);
});

test("resolveLeaf stops at an unknown subcommand and treats the rest as supplied args", () => {
  const r = resolveLeaf(makeRegistry(), ["repo", "unknown", "blah"]);
  assert.ok(r);
  // We stopped at `repo` because `unknown` isn't a subcommand.
  assert.equal(r.command.name, "repo");
  assert.deepEqual(r.supplied, ["unknown", "blah"]);
});

test("resolveLeaf with a leaf that has no subcommands keeps the user's args", () => {
  const r = resolveLeaf(makeRegistry(), ["init", "--name", "MyOrg"]);
  assert.ok(r);
  assert.equal(r.command.name, "init");
  assert.deepEqual(r.trail, ["init"]);
  assert.deepEqual(r.supplied, ["--name", "MyOrg"]);
});

test("resolveLeaf returns the deepest matching command with prompts", () => {
  const r = resolveLeaf(makeRegistry(), ["feature", "add"]);
  assert.ok(r);
  assert.equal(r.command.name, "add");
  assert.deepEqual(r.command.prompts[0].key, "name");
});
