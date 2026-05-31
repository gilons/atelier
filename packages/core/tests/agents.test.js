import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addAgent,
  loadAgent,
  listAgents,
  updateAgent,
  updateInstructions,
  appendLearning,
  removeAgent,
  installAgent,
  uninstallAgent,
  materializeBuiltin,
  renderClaudeCommand,
  renderClaudeSubagent,
  slugifyAgentId,
  validateAgentFrontMatter,
  writeInstructionTree,
  composeInstructions,
  listInstructionUnits,
  addInstructionUnit,
  BUILTIN_AGENTS,
  findBuiltinAgent,
  AgentAlreadyExistsError,
  AgentNotFoundError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-agents-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

// ============================================================
// slug + validation
// ============================================================

test("slugifyAgentId slugifies a display name", () => {
  assert.equal(slugifyAgentId("System Design"), "system-design");
  assert.equal(slugifyAgentId("  Discovery  "), "discovery");
});

test("validateAgentFrontMatter rejects bad ids + bad model", () => {
  const r1 = validateAgentFrontMatter({
    id: "Bad Id",
    name: "X",
    purpose: "p",
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.path === "$.id"));

  const r2 = validateAgentFrontMatter({
    id: "ok",
    name: "X",
    purpose: "p",
    model: "gpt-4",
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.path === "$.model"));
});

test("validateAgentFrontMatter accepts a minimal valid def", () => {
  const r = validateAgentFrontMatter({
    id: "discovery",
    name: "Discovery",
    purpose: "Onboard a workspace.",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.id, "discovery");
});

// ============================================================
// CRUD
// ============================================================

test("addAgent writes agent.yaml + instructions.md + learnings.md", async () => {
  const { workspaceRoot } = await workspace();
  const a = await addAgent(workspaceRoot, {
    name: "System Design",
    purpose: "Design the system.",
    instructions: "# Playbook\n\nDo the thing.\n",
  });
  assert.equal(a.id, "system-design");
  assert.equal(a.version, 1);
  const paths = workspacePaths(workspaceRoot);
  const dir = path.join(paths.agents, "system-design");
  assert.match(await fs.readFile(path.join(dir, "agent.yaml"), "utf8"), /id: system-design/);
  assert.match(await fs.readFile(path.join(dir, "instructions.md"), "utf8"), /Do the thing/);
  // learnings.md exists (empty)
  await fs.access(path.join(dir, "learnings.md"));
});

test("addAgent rejects duplicates", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "Dup", purpose: "p" });
  await assert.rejects(
    () => addAgent(workspaceRoot, { id: "dup", name: "Dup", purpose: "p" }),
    AgentAlreadyExistsError
  );
});

test("loadAgent round-trips metadata + bodies", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, {
    name: "Round Trip",
    kind: "custom",
    purpose: "p",
    description: "delegate here",
    argumentHint: "[x]",
    tools: ["Bash", "Read"],
    model: "sonnet",
    instructions: "body\n",
  });
  const a = await loadAgent(workspaceRoot, "round-trip");
  assert.equal(a.kind, "custom");
  assert.equal(a.description, "delegate here");
  assert.deepEqual(a.tools, ["Bash", "Read"]);
  assert.equal(a.model, "sonnet");
  assert.match(a.instructions, /body/);
});

test("loadAgent throws on unknown id", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(() => loadAgent(workspaceRoot, "ghost"), AgentNotFoundError);
});

test("updateAgent patches fields + bumps version", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "Up", purpose: "old" });
  const a = await updateAgent(workspaceRoot, "up", { purpose: "new", model: "opus" });
  assert.equal(a.purpose, "new");
  assert.equal(a.model, "opus");
  assert.equal(a.version, 2);
});

test("updateInstructions replaces the playbook body", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "Up", purpose: "p", instructions: "old\n" });
  const a = await updateInstructions(workspaceRoot, "up", "new playbook\n");
  assert.match(a.instructions, /new playbook/);
  const paths = workspacePaths(workspaceRoot);
  const onDisk = await fs.readFile(path.join(paths.agents, "up", "instructions.md"), "utf8");
  assert.match(onDisk, /new playbook/);
});

// ============================================================
// learnings (self-improvement)
// ============================================================

test("appendLearning accumulates timestamped entries", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "L", purpose: "p" });
  await appendLearning(workspaceRoot, "l", "Planning lives in Linear.");
  const a = await appendLearning(workspaceRoot, "l", "Design is Figma file X.");
  assert.match(a.learnings, /Planning lives in Linear/);
  assert.match(a.learnings, /Design is Figma file X/);
  // two headed sections
  assert.equal((a.learnings.match(/^## /gm) || []).length, 2);
});

test("appendLearning rejects empty notes + unknown agents", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "L", purpose: "p" });
  await assert.rejects(() => appendLearning(workspaceRoot, "l", "   "));
  await assert.rejects(() => appendLearning(workspaceRoot, "ghost", "x"), AgentNotFoundError);
});

// ============================================================
// rendering
// ============================================================

test("renderClaudeSubagent emits valid frontmatter with required name + description", () => {
  const agent = {
    id: "discovery",
    name: "Discovery",
    purpose: "Onboard.",
    description: "Use to onboard a workspace.",
    tools: ["Bash", "Read"],
    model: "inherit",
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    instructions: "# Discovery\n\nDo it.\n",
    learnings: "",
  };
  const out = renderClaudeSubagent(agent);
  assert.ok(out.startsWith("---\n"));
  assert.match(out, /^name: atelier-discovery$/m);
  assert.match(out, /^description: Use to onboard a workspace\.$/m);
  assert.match(out, /^tools: Bash, Read$/m);
  assert.match(out, /^model: inherit$/m);
  assert.match(out, /# Discovery/);
});

test("renderClaudeCommand uses purpose as description + passes through instructions", () => {
  const agent = {
    id: "discovery",
    name: "Discovery",
    purpose: "Onboard a workspace.",
    argumentHint: "[surface]",
    tools: ["Bash"],
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    instructions: "Step 1. $ARGUMENTS\n",
    learnings: "",
  };
  const out = renderClaudeCommand(agent);
  assert.match(out, /^description: Onboard a workspace\.$/m);
  // `[surface]` must be quoted in YAML or it parses as a flow sequence.
  assert.match(out, /^argument-hint: "\[surface\]"$/m);
  assert.match(out, /^allowed-tools: Bash$/m);
  assert.match(out, /\$ARGUMENTS/);
});

test("learnings get folded into the rendered body", () => {
  const agent = {
    id: "discovery",
    name: "Discovery",
    purpose: "p",
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    instructions: "playbook\n",
    learnings: "## 2026\n\nPlanning is Linear.\n",
  };
  const sub = renderClaudeSubagent(agent);
  const cmd = renderClaudeCommand(agent);
  assert.match(sub, /What I've learned about this workspace/);
  assert.match(sub, /Planning is Linear/);
  assert.match(cmd, /Planning is Linear/);
});

// ============================================================
// built-ins + install
// ============================================================

test("discovery ships as a built-in", () => {
  assert.ok(findBuiltinAgent("discovery"));
  assert.ok(BUILTIN_AGENTS.some((b) => b.meta.id === "discovery"));
});

test("listAgents shows discovery as available before install", async () => {
  const { workspaceRoot } = await workspace();
  const { agents, available } = await listAgents(workspaceRoot);
  assert.equal(agents.length, 0);
  assert.ok(available.some((b) => b.id === "discovery"));
});

test("materializeBuiltin writes the discovery template into .atelier/agents", async () => {
  const { workspaceRoot } = await workspace();
  const a = await materializeBuiltin(workspaceRoot, "discovery");
  assert.equal(a.id, "discovery");
  assert.equal(a.builtin, true);
  assert.match(a.instructions, /discovery agent/i);
  // idempotent — second call returns existing, no throw
  const again = await materializeBuiltin(workspaceRoot, "discovery");
  assert.equal(again.id, "discovery");
});

test("installAgent materializes a built-in + writes .claude/ files", async () => {
  const { workspaceRoot } = await workspace();
  const result = await installAgent(workspaceRoot, "discovery");
  assert.equal(result.invocation, "/atelier:discovery");
  const paths = workspacePaths(workspaceRoot);
  const cmd = path.join(paths.claudeDir, "commands", "atelier", "discovery.md");
  const sub = path.join(paths.claudeDir, "agents", "atelier-discovery.md");
  assert.match(await fs.readFile(cmd, "utf8"), /^description: /m);
  assert.match(await fs.readFile(sub, "utf8"), /^name: atelier-discovery$/m);
  // now listed as installed
  const { agents } = await listAgents(workspaceRoot);
  assert.equal(agents.find((a) => a.agent.id === "discovery")?.installed, true);
});

test("installing then learning re-render carries the learning into .claude/", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  await appendLearning(workspaceRoot, "discovery", "Repos live under acme-org.");
  await installAgent(workspaceRoot, "discovery"); // re-render
  const paths = workspacePaths(workspaceRoot);
  const sub = await fs.readFile(
    path.join(paths.claudeDir, "agents", "atelier-discovery.md"),
    "utf8"
  );
  assert.match(sub, /Repos live under acme-org/);
});

test("uninstallAgent removes .claude/ files but keeps the canonical def", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  await uninstallAgent(workspaceRoot, "discovery");
  const paths = workspacePaths(workspaceRoot);
  await assert.rejects(
    () => fs.access(path.join(paths.claudeDir, "agents", "atelier-discovery.md")),
    /ENOENT/
  );
  // canonical def still loads
  const a = await loadAgent(workspaceRoot, "discovery");
  assert.equal(a.id, "discovery");
});

test("removeAgent deletes canonical def + rendered files", async () => {
  const { workspaceRoot } = await workspace();
  await installAgent(workspaceRoot, "discovery");
  await removeAgent(workspaceRoot, "discovery");
  await assert.rejects(() => loadAgent(workspaceRoot, "discovery"), AgentNotFoundError);
  const paths = workspacePaths(workspaceRoot);
  await assert.rejects(
    () => fs.access(path.join(paths.claudeDir, "commands", "atelier", "discovery.md")),
    /ENOENT/
  );
});

// ============================================================
// recursive instruction tree
// ============================================================

test("writeInstructionTree → composeInstructions round-trips as a flattened playbook", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, { name: "Tree", purpose: "p" });
  await writeInstructionTree(
    workspaceRoot,
    "tree",
    [
      { slug: "intro", title: "Intro", description: "start here", detail: "Do the setup.\n" },
      {
        slug: "deep",
        title: "Deep",
        description: "nested",
        detail: "Top of deep.\n",
        children: [{ slug: "sub", title: "Sub-step", detail: "A nested instruction.\n" }],
      },
    ],
    { description: "The playbook." }
  );
  const composed = await composeInstructions(workspaceRoot, "tree");
  assert.match(composed, /The playbook\./);
  assert.match(composed, /## Intro/);
  assert.match(composed, /Do the setup\./);
  assert.match(composed, /## Deep/);
  // sub-unit rendered at a deeper heading level
  assert.match(composed, /### Sub-step/);
  assert.match(composed, /A nested instruction\./);
});

test("addAgent with instructionUnits writes the tree, not a flat instructions.md", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, {
    name: "Treed",
    purpose: "p",
    instructionUnits: [{ slug: "a", title: "A", detail: "alpha\n" }],
  });
  const paths = workspacePaths(workspaceRoot);
  const dir = path.join(paths.agents, "treed");
  // instructions/ tree exists; flat instructions.md does not.
  await fs.access(path.join(dir, "instructions", "index.yaml"));
  await fs.access(path.join(dir, "instructions", "a", "detail.md"));
  await assert.rejects(() => fs.access(path.join(dir, "instructions.md")), /ENOENT/);
  // loadAgent composes from the tree transparently.
  const a = await loadAgent(workspaceRoot, "treed");
  assert.match(a.instructions, /## A/);
  assert.match(a.instructions, /alpha/);
});

test("listInstructionUnits returns the top-level units", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, {
    name: "Treed",
    purpose: "p",
    instructionUnits: [
      { slug: "a", title: "A", description: "aa", detail: "x" },
      { slug: "b", title: "B", detail: "y" },
    ],
  });
  const units = await listInstructionUnits(workspaceRoot, "treed");
  assert.deepEqual(units.map((u) => u.slug), ["a", "b"]);
  assert.equal(units[0].description, "aa");
});

test("addInstructionUnit migrates a flat playbook into an overview unit", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, {
    name: "Flat",
    purpose: "p",
    instructions: "# Flat playbook\n\nThe original body.\n",
  });
  // no tree yet
  assert.equal((await listInstructionUnits(workspaceRoot, "flat")).length, 0);

  await addInstructionUnit(workspaceRoot, "flat", {
    slug: "extra",
    title: "Extra step",
    description: "added later",
    detail: "Do the extra thing.\n",
  });

  const units = await listInstructionUnits(workspaceRoot, "flat");
  const slugs = units.map((u) => u.slug);
  assert.ok(slugs.includes("overview"), "flat body migrated into an overview unit");
  assert.ok(slugs.includes("extra"));

  // The original flat instructions.md is gone; content preserved in the tree.
  const paths = workspacePaths(workspaceRoot);
  await assert.rejects(
    () => fs.access(path.join(paths.agents, "flat", "instructions.md")),
    /ENOENT/
  );
  const composed = await composeInstructions(workspaceRoot, "flat");
  assert.match(composed, /The original body\./);
  assert.match(composed, /Do the extra thing\./);
});

test("addInstructionUnit can nest under a parent unit", async () => {
  const { workspaceRoot } = await workspace();
  await addAgent(workspaceRoot, {
    name: "Treed",
    purpose: "p",
    instructionUnits: [{ slug: "parent", title: "Parent", detail: "parent body\n" }],
  });
  await addInstructionUnit(
    workspaceRoot,
    "treed",
    { slug: "child", title: "Child", detail: "child body\n" },
    { parentSlug: "parent" }
  );
  const composed = await composeInstructions(workspaceRoot, "treed");
  assert.match(composed, /## Parent/);
  assert.match(composed, /### Child/);
  assert.match(composed, /child body/);
});

test("the discovery built-in ships as an instruction tree", async () => {
  const { workspaceRoot } = await workspace();
  await materializeBuiltin(workspaceRoot, "discovery");
  const units = await listInstructionUnits(workspaceRoot, "discovery");
  const slugs = units.map((u) => u.slug);
  for (const expected of ["overview", "repos", "docs", "planning", "design", "people", "wrapup"]) {
    assert.ok(slugs.includes(expected), `missing discovery unit ${expected}`);
  }
  // Composed playbook still reads as one coherent prompt.
  const a = await loadAgent(workspaceRoot, "discovery");
  assert.match(a.instructions, /discovery agent/i);
  assert.match(a.instructions, /## Connect code repositories/);
});

test("the system-design built-in ships as a tool-aware tree with nested onboarding units", async () => {
  const { workspaceRoot } = await workspace();
  assert.ok(findBuiltinAgent("system-design"));
  await materializeBuiltin(workspaceRoot, "system-design");

  const units = await listInstructionUnits(workspaceRoot, "system-design");
  const slugs = units.map((u) => u.slug);
  for (const expected of [
    "overview",
    "detect-tool",
    "onboard-tool",
    "drive-tool",
    "markdown-fallback",
    "deliverables",
    "wrapup",
  ]) {
    assert.ok(slugs.includes(expected), `missing system-design unit ${expected}`);
  }

  // The composed playbook carries the three-branch model + the nested
  // per-platform onboarding units at a deeper heading level.
  const a = await loadAgent(workspaceRoot, "system-design");
  assert.match(a.instructions, /## Onboard a design tool/);
  assert.match(a.instructions, /### Excalidraw/);
  assert.match(a.instructions, /### Lucidchart/);
  assert.match(a.instructions, /### Figma/);
  assert.match(a.instructions, /## Markdown fallback/);

  // The nested onboarding sub-units exist on disk.
  const paths = workspacePaths(workspaceRoot);
  await fs.access(
    path.join(paths.agents, "system-design", "instructions", "onboard-tool", "figma", "detail.md")
  );
});

test("system-design carries the initial-workspace-design bootstrap sub-tree", async () => {
  const { workspaceRoot } = await workspace();
  await materializeBuiltin(workspaceRoot, "system-design");
  const units = await listInstructionUnits(workspaceRoot, "system-design");
  assert.ok(units.some((u) => u.slug === "workspace-design"));

  // The bootstrap unit's sub-units (enumerate → analyze → document →
  // diagram) compose at a deeper heading level + reference repo inspect.
  const a = await loadAgent(workspaceRoot, "system-design");
  assert.match(a.instructions, /## Initial workspace system design/);
  assert.match(a.instructions, /### Enumerate projects & subsystems/);
  assert.match(a.instructions, /### Analyze similarities/);
  assert.match(a.instructions, /### Analyze patterns/);
  assert.match(a.instructions, /### Diagram the workspace/);
  assert.match(a.instructions, /atelier repo inspect/);

  const paths = workspacePaths(workspaceRoot);
  await fs.access(
    path.join(
      paths.agents,
      "system-design",
      "instructions",
      "workspace-design",
      "enumerate-projects",
      "detail.md"
    )
  );
});

test("system-design carries the synthesize-map (design ⇄ code ⇄ docs ⇄ planning) sub-tree", async () => {
  const { workspaceRoot } = await workspace();
  await materializeBuiltin(workspaceRoot, "system-design");
  const units = await listInstructionUnits(workspaceRoot, "system-design");
  assert.ok(units.some((u) => u.slug === "synthesize-map"));

  const a = await loadAgent(workspaceRoot, "system-design");
  assert.match(a.instructions, /## Synthesize the deep workspace map/);
  assert.match(a.instructions, /### Pull existing design/);
  assert.match(a.instructions, /### Gather docs & planning/);
  assert.match(a.instructions, /### Map to code/);
  assert.match(a.instructions, /### Reconcile design vs code/);
  assert.match(a.instructions, /### Produce the detailed map/);
  // The reconcile step drives the discrepancy log.
  assert.match(a.instructions, /atelier discrepancy add/);

  const paths = workspacePaths(workspaceRoot);
  await fs.access(
    path.join(
      paths.agents,
      "system-design",
      "instructions",
      "synthesize-map",
      "reconcile",
      "detail.md"
    )
  );
});

// ============================================================
// workspace integration
// ============================================================

test("initWorkspace creates the agents folder", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  const stat = await fs.stat(paths.agents);
  assert.ok(stat.isDirectory());
});
