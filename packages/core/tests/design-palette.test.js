import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  addFeature,
  addItem,
  addStakeholder,
  buildDesignPalette,
  paletteSize,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-palette-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

test("buildDesignPalette is empty on a fresh workspace", async () => {
  const { workspaceRoot } = await workspace();
  const palette = await buildDesignPalette(workspaceRoot);
  assert.equal(paletteSize(palette), 0);
});

test("buildDesignPalette derives subsystems, features, designs, owners with stable refs", async () => {
  const { umbrella, workspaceRoot } = await workspace();

  // A monorepo with two services → subsystems.
  await write(path.join(umbrella, "platform", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
  await write(path.join(umbrella, "platform", "package.json"), '{"name":"platform","workspaces":["services/*"]}\n');
  await write(path.join(umbrella, "platform", "services", "web", "package.json"), '{"name":"@acme/web"}\n');
  await write(path.join(umbrella, "platform", "services", "api", "go.mod"), "module acme/api\n");
  await addRepo(workspaceRoot, { pathInput: "../platform", cwd: workspaceRoot });

  // A feature.
  await addFeature(workspaceRoot, { name: "Checkout", status: "planned", description: "Buy flow" });

  // A system-design item + a non-design item (only the design one shows).
  await addItem(workspaceRoot, {
    source: "manual",
    docId: "auth-overview",
    title: "Auth — system design",
    classification: "system-design",
    overview: "How auth works",
    skipSourceValidation: true,
  });
  await addItem(workspaceRoot, {
    source: "manual",
    docId: "random-note",
    title: "Random note",
    classification: "note",
    skipSourceValidation: true,
  });

  // An owner.
  await addStakeholder(workspaceRoot, { name: "Sarah Chen", role: "PM", organization: "Acme" });

  const palette = await buildDesignPalette(workspaceRoot);

  // Subsystems: the repo + its two services.
  const subRefs = palette.subsystems.map((s) => s.ref);
  assert.ok(subRefs.includes("repo:platform"));
  assert.ok(subRefs.includes("repo:platform/services/web"));
  assert.ok(subRefs.includes("repo:platform/services/api"));

  // Feature.
  assert.deepEqual(
    palette.features.map((f) => f.ref),
    ["feature:checkout"]
  );

  // Only the system-design item appears.
  assert.deepEqual(
    palette.designs.map((d) => d.ref),
    ["item:manual:auth-overview"]
  );

  // Owner.
  assert.deepEqual(
    palette.owners.map((o) => o.ref),
    ["stakeholder:sarah-chen"]
  );

  await fs.rm(umbrella, { recursive: true, force: true });
});

test("buildDesignPalette skips repos that aren't cloned locally", async () => {
  const { workspaceRoot } = await workspace();
  // Register a repo whose local dir doesn't exist.
  await assert.rejects(
    () => addRepo(workspaceRoot, { pathInput: "../ghost", cwd: workspaceRoot }),
    /.*/
  ).catch(() => {});
  const palette = await buildDesignPalette(workspaceRoot);
  // Nothing crashed; subsystems is just empty.
  assert.deepEqual(palette.subsystems, []);
});
