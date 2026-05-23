import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  registerSource,
  removeSource,
  setSourceEnabled,
  listSources,
  loadSourcesConfig,
  readSourceSetup,
  updateSourceSetup,
  deriveSourceId,
  SourceAlreadyRegisteredError,
  SourceNotFoundError,
} from "../dist/index.js";

/**
 * Tests for the agent-driven source registry.
 *
 * A source in the new model is just an id + name + free-form
 * config + optional setup.md runbook. Atelier never talks to
 * source systems; the agent does, using whatever's in `config`.
 */

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-sources-test-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

test("deriveSourceId slugifies a human name", () => {
  assert.equal(deriveSourceId("Company Notion"), "company-notion");
  assert.equal(deriveSourceId("Stephan's OneDrive"), "stephan-s-onedrive");
  assert.equal(deriveSourceId(""), "source");
});

test("registerSource persists id + name + enabled", async () => {
  const root = await workspace();
  const source = await registerSource(root, {
    id: "company-notion",
    name: "Company Notion",
  });
  assert.equal(source.id, "company-notion");
  assert.equal(source.name, "Company Notion");
  assert.equal(source.enabled, true);

  const cfg = await loadSourcesConfig(root);
  assert.equal(cfg.version, 2);
  assert.equal(cfg.sources.length, 1);
  assert.equal(cfg.sources[0].id, "company-notion");
});

test("registerSource stores the free-form config blob verbatim", async () => {
  const root = await workspace();
  const source = await registerSource(root, {
    id: "gh",
    name: "GitHub",
    config: {
      mcp_server: "github-mcp",
      org: "acme",
      arbitrary: { nested: [1, 2, 3] },
    },
  });
  assert.deepEqual(source.config, {
    mcp_server: "github-mcp",
    org: "acme",
    arbitrary: { nested: [1, 2, 3] },
  });
});

test("registerSource writes setup.md sidecar when setupInstructions provided", async () => {
  const root = await workspace();
  const runbook = "# Notion setup\n\n1. Install Notion MCP\n2. Authorize\n";
  const source = await registerSource(root, {
    id: "notion",
    name: "Notion",
    setupInstructions: runbook,
  });
  assert.equal(source.setupFile, "sources/notion/setup.md");
  const onDisk = await fs.readFile(
    path.join(root, ".atelier", "sources", "notion", "setup.md"),
    "utf8"
  );
  assert.equal(onDisk, runbook);
});

test("registerSource without setupInstructions leaves setupFile unset", async () => {
  const root = await workspace();
  const source = await registerSource(root, { id: "x", name: "X" });
  assert.equal(source.setupFile, undefined);
});

test("registerSource rejects a duplicate id", async () => {
  const root = await workspace();
  await registerSource(root, { id: "dup", name: "First" });
  await assert.rejects(
    () => registerSource(root, { id: "dup", name: "Second" }),
    SourceAlreadyRegisteredError
  );
});

test("readSourceSetup returns the runbook text or null when missing", async () => {
  const root = await workspace();
  await registerSource(root, {
    id: "with-setup",
    name: "With Setup",
    setupInstructions: "# Steps\n\nDo the thing.\n",
  });
  await registerSource(root, { id: "no-setup", name: "No Setup" });
  assert.match(await readSourceSetup(root, "with-setup"), /Do the thing/);
  assert.equal(await readSourceSetup(root, "no-setup"), null);
  assert.equal(await readSourceSetup(root, "ghost"), null);
});

test("updateSourceSetup writes a new runbook for an existing source", async () => {
  const root = await workspace();
  await registerSource(root, { id: "s", name: "S" });
  const updated = await updateSourceSetup(root, "s", "# New steps\n");
  assert.equal(updated.setupFile, "sources/s/setup.md");
  assert.match(await readSourceSetup(root, "s"), /New steps/);
});

test("updateSourceSetup with null removes the runbook + clears setupFile", async () => {
  const root = await workspace();
  await registerSource(root, {
    id: "s",
    name: "S",
    setupInstructions: "first\n",
  });
  const updated = await updateSourceSetup(root, "s", null);
  assert.equal(updated.setupFile, undefined);
  assert.equal(await readSourceSetup(root, "s"), null);
});

test("removeSource takes the source entry + nukes its sidecar folder", async () => {
  const root = await workspace();
  await registerSource(root, {
    id: "doomed",
    name: "Doomed",
    setupInstructions: "bye\n",
  });
  await removeSource(root, "doomed");
  const sources = await listSources(root);
  assert.equal(sources.length, 0);
  await assert.rejects(
    () => fs.access(path.join(root, ".atelier", "sources", "doomed"))
  );
});

test("removeSource on a missing id throws SourceNotFoundError", async () => {
  const root = await workspace();
  await assert.rejects(() => removeSource(root, "ghost"), SourceNotFoundError);
});

test("setSourceEnabled toggles the flag and persists it", async () => {
  const root = await workspace();
  await registerSource(root, { id: "s", name: "S" });
  await setSourceEnabled(root, "s", false);
  const cfg = await loadSourcesConfig(root);
  assert.equal(cfg.sources[0].enabled, false);
  await setSourceEnabled(root, "s", true);
  const cfg2 = await loadSourcesConfig(root);
  assert.equal(cfg2.sources[0].enabled, true);
});
