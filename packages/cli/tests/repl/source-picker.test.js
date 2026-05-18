import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchAtelier } from "./harness.js";

/**
 * Tests for the source-picker UX added to /sync and /doc list.
 *
 * Scenario shape (all): pre-create a workspace with N sources
 * declared in sources.yaml, then drive the command and look for
 * either the picker or the default-all behavior depending on N.
 *
 * We hand-write sources.yaml here instead of going through
 * /source onboard — that flow is exercised in
 * source-onboard-sharepoint.test.js. Skipping it keeps these
 * tests fast and focused on picker behavior.
 */

async function makeWorkspace(opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-picker-"));
  const a = await launchAtelier({ cwd: root, args: ["init", "--name", "ReplTest"] });
  await a.waitForExit({ timeout: 10000 });
  if (opts.sources) {
    const sourcesYaml = [
      "# Test fixture",
      "version: 1",
      "sources:",
    ];
    for (const s of opts.sources) {
      sourcesYaml.push(`  - id: ${s.id}`);
      sourcesYaml.push(`    kind: ${s.kind}`);
      sourcesYaml.push(`    name: "${s.name ?? s.id}"`);
      sourcesYaml.push(`    enabled: true`);
      if (s.scope) {
        sourcesYaml.push(`    scope:`);
        for (const [k, v] of Object.entries(s.scope)) {
          sourcesYaml.push(`      ${k}: ${typeof v === "string" ? `"${v}"` : v}`);
        }
      }
    }
    await fs.writeFile(
      path.join(root, ".atelier", "sources.yaml"),
      sourcesYaml.join("\n") + "\n",
      "utf8"
    );
  }
  return root;
}

async function rm(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// ============================================================
// /sync with two sources: should show the picker.
// ============================================================

test("REPL: /sync with multiple sources shows the source picker (All + each source)", async () => {
  const root = await makeWorkspace({
    sources: [
      { id: "team-notes", kind: "local-folder", scope: { rootPath: "/tmp/notes" } },
      { id: "specs-folder", kind: "local-folder", scope: { rootPath: "/tmp/specs" } },
    ],
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/sync\r");
    // Picker should appear with both source ids + "All sources" at top.
    await a.expectPicker(["All sources", "team-notes", "specs-folder"], {
      timeout: 7000,
    });
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /sync with one source: skip the picker (theater).
// ============================================================

test("REPL: /sync with a single source skips the picker (no source to choose between)", async () => {
  const root = await makeWorkspace({
    sources: [{ id: "only-one", kind: "local-folder", scope: { rootPath: "/tmp/x" } }],
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/sync\r");
    // The picker should NOT appear. Sync should run (and probably
    // fail because the rootPath doesn't exist — that's fine, we
    // just need to confirm the picker didn't show).
    const r = await a.expectAny(
      [
        /Source:|Total:|No enabled sources/, // sync ran (any output)
        "All sources", // picker showed up (bad)
      ],
      { timeout: 5000 }
    );
    assert.equal(
      r.index,
      0,
      "single-source workspaces should sync immediately, not show a picker"
    );
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /sync --source <id>: skip the picker (explicit value wins).
// ============================================================

test("REPL: /sync --source <id> skips the picker (explicit value bypasses)", async () => {
  const root = await makeWorkspace({
    sources: [
      { id: "team-notes", kind: "local-folder", scope: { rootPath: "/tmp/notes" } },
      { id: "specs-folder", kind: "local-folder", scope: { rootPath: "/tmp/specs" } },
    ],
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/sync --source team-notes\r");
    const r = await a.expectAny(
      [/Source:|Total:|No enabled sources/, "All sources"],
      { timeout: 5000 }
    );
    assert.equal(r.index, 0, "explicit --source should skip the picker");
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc list with multiple sources: same picker.
// ============================================================

test("REPL: /doc list with multiple sources shows the same source picker", async () => {
  const root = await makeWorkspace({
    sources: [
      { id: "a-source", kind: "local-folder", scope: { rootPath: "/tmp/a" } },
      { id: "b-source", kind: "local-folder", scope: { rootPath: "/tmp/b" } },
    ],
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/doc list\r");
    await a.expectPicker(["All sources", "a-source", "b-source"], {
      timeout: 7000,
    });
  } finally {
    await a.close();
    await rm(root);
  }
});
