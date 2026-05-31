import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateAgentFrontMatter, formatIssues } from "./validation.js";
import { WorkspaceValidationError } from "./workspace.js";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { readFolderIndex, writeFolderIndex } from "./folder-index.js";
import { BUILTIN_AGENTS, findBuiltinAgent } from "./agent-builtins.js";
import type { Agent, AgentFrontMatter } from "./types.js";
import type { InstructionUnit } from "./agent-builtins.js";

/**
 * Agent registry.
 *
 * Atelier authors agents for a connected AI tool (Claude Code) to
 * discover and run; atelier itself never calls an LLM. Each agent is
 * a folder:
 *
 *   .atelier/agents/<id>/
 *     agent.yaml        — metadata (AgentFrontMatter)
 *     instructions.md   — the self-improving playbook / system prompt
 *     learnings.md      — append-only durable facts about this workspace
 *
 * `installAgent` renders the canonical def into Claude-discoverable
 * files under `<root>/.claude/`:
 *
 *   .claude/commands/atelier/<id>.md   — slash command (/atelier:<id>)
 *   .claude/agents/atelier-<id>.md     — subagent Claude can delegate to
 *
 * The `.atelier/` copy is the source of truth. The `.claude/` files
 * are generated; re-render whenever instructions or learnings change.
 */

// ============================================================
// Errors
// ============================================================

export class AgentNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No agent with id "${id}".`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`An agent with id "${id}" already exists.`);
    this.name = "AgentAlreadyExistsError";
  }
}

export class AgentFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid agent file at ${filePath}:\n${detail}`);
    this.name = "AgentFileError";
  }
}

// ============================================================
// Slug helper
// ============================================================

export function slugifyAgentId(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ============================================================
// Path helpers
// ============================================================

function agentsRoot(workspaceRoot: string): string {
  return workspacePaths(workspaceRoot).agents;
}

function agentFolderPath(workspaceRoot: string, id: string): string {
  return path.join(agentsRoot(workspaceRoot), id);
}

function agentYamlPath(workspaceRoot: string, id: string): string {
  return path.join(agentFolderPath(workspaceRoot, id), "agent.yaml");
}

function instructionsPath(workspaceRoot: string, id: string): string {
  return path.join(agentFolderPath(workspaceRoot, id), "instructions.md");
}

/**
 * `.atelier/agents/<id>/instructions/` — the recursive instruction
 * tree. When this directory exists it takes precedence over the flat
 * `instructions.md`: the playbook is composed by walking it.
 */
function instructionsTreeDir(workspaceRoot: string, id: string): string {
  return path.join(agentFolderPath(workspaceRoot, id), "instructions");
}

function learningsPath(workspaceRoot: string, id: string): string {
  return path.join(agentFolderPath(workspaceRoot, id), "learnings.md");
}

/** `.claude/commands/atelier/<id>.md` — the rendered slash command. */
function renderedCommandPath(workspaceRoot: string, id: string): string {
  return path.join(
    workspacePaths(workspaceRoot).claudeDir,
    "commands",
    "atelier",
    `${id}.md`
  );
}

/** `.claude/agents/atelier-<id>.md` — the rendered subagent. */
function renderedSubagentPath(workspaceRoot: string, id: string): string {
  return path.join(
    workspacePaths(workspaceRoot).claudeDir,
    "agents",
    `atelier-${id}.md`
  );
}

async function ensureFolder(workspaceRoot: string, id: string): Promise<string> {
  const dir = agentFolderPath(workspaceRoot, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const AGENT_YAML_HEADER =
  "Agent definition authored by atelier for AI tools (Claude Code) to\n" +
  "discover and run. Edit instructions.md to refine the playbook; use\n" +
  "`atelier agent learn <id> \"…\"` to append durable workspace facts.\n" +
  "Run `atelier agent install <id>` to re-render the .claude/ files.";

// ============================================================
// Serialize agent.yaml metadata
// ============================================================

function toFrontMatter(a: Agent | AgentFrontMatter): AgentFrontMatter {
  const fm: AgentFrontMatter = {
    id: a.id,
    name: a.name,
    purpose: a.purpose,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (a.kind !== undefined) fm.kind = a.kind;
  if (a.description !== undefined) fm.description = a.description;
  if (a.argumentHint !== undefined) fm.argumentHint = a.argumentHint;
  if (a.tools !== undefined) fm.tools = a.tools;
  if (a.model !== undefined) fm.model = a.model;
  if (a.builtin !== undefined) fm.builtin = a.builtin;
  return fm;
}

/** Serialize metadata into a stable, ordered object for agent.yaml. */
function orderedYaml(fm: AgentFrontMatter): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: fm.id,
    name: fm.name,
  };
  if (fm.kind !== undefined) out.kind = fm.kind;
  out.purpose = fm.purpose;
  if (fm.description !== undefined) out.description = fm.description;
  if (fm.argumentHint !== undefined) out.argumentHint = fm.argumentHint;
  if (fm.tools !== undefined) out.tools = fm.tools;
  if (fm.model !== undefined) out.model = fm.model;
  if (fm.builtin !== undefined) out.builtin = fm.builtin;
  out.version = fm.version;
  out.createdAt = fm.createdAt;
  out.updatedAt = fm.updatedAt;
  return out;
}

async function writeAgentYaml(workspaceRoot: string, fm: AgentFrontMatter): Promise<void> {
  const check = validateAgentFrontMatter(fm);
  if (!check.ok || !check.value) {
    throw new WorkspaceValidationError(
      agentYamlPath(workspaceRoot, fm.id),
      formatIssues(check.issues)
    );
  }
  await writeYamlFile(agentYamlPath(workspaceRoot, fm.id), orderedYaml(fm), AGENT_YAML_HEADER);
}

// ============================================================
// CRUD
// ============================================================

export interface AddAgentOptions {
  id?: string;
  name: string;
  kind?: string;
  purpose: string;
  description?: string;
  argumentHint?: string;
  tools?: string[];
  model?: string;
  builtin?: boolean;
  instructions?: string;
  /**
   * When provided, the playbook is written as a recursive instruction
   * tree under `instructions/` instead of a flat `instructions.md`.
   * Each unit is its own folder with an index.yaml (name + brief
   * description) and a detail.md — progressive disclosure, recursing
   * for sub-units. Takes precedence over {@link AddAgentOptions.instructions}.
   */
  instructionUnits?: InstructionUnit[];
  /** Optional top-level title/description for the instructions/ index. */
  instructionsName?: string;
  instructionsDescription?: string;
  learnings?: string;
}

export async function addAgent(
  workspaceRoot: string,
  opts: AddAgentOptions
): Promise<Agent> {
  if (!opts.name) throw new Error("name is required");
  if (!opts.purpose) throw new Error("purpose is required");
  const id = (opts.id ?? slugifyAgentId(opts.name)).trim();
  if (!id) {
    throw new Error(
      "Could not derive a slug id from name — pass an explicit id (lowercase, alphanumeric + hyphens)."
    );
  }

  const folder = agentFolderPath(workspaceRoot, id);
  try {
    await fs.access(folder);
    throw new AgentAlreadyExistsError(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const agent: Agent = {
    id,
    name: opts.name,
    kind: opts.kind,
    purpose: opts.purpose,
    description: opts.description,
    argumentHint: opts.argumentHint,
    tools: opts.tools,
    model: opts.model,
    builtin: opts.builtin,
    version: 1,
    createdAt: now,
    updatedAt: now,
    instructions: opts.instructions ?? "",
    learnings: opts.learnings ?? "",
  };

  await ensureFolder(workspaceRoot, id);
  await writeAgentYaml(workspaceRoot, toFrontMatter(agent));
  if (opts.instructionUnits && opts.instructionUnits.length > 0) {
    // Recursive instruction tree takes precedence over a flat file.
    await writeInstructionTree(workspaceRoot, id, opts.instructionUnits, {
      name: opts.instructionsName,
      description: opts.instructionsDescription ?? opts.purpose,
    });
    agent.instructions = await composeInstructions(workspaceRoot, id);
  } else {
    await fs.writeFile(instructionsPath(workspaceRoot, id), normalizeBody(agent.instructions), "utf8");
  }
  await fs.writeFile(learningsPath(workspaceRoot, id), normalizeBody(agent.learnings), "utf8");
  return agent;
}

function normalizeBody(body: string): string {
  if (body === "") return "";
  return body.endsWith("\n") ? body : body + "\n";
}

export async function loadAgent(workspaceRoot: string, id: string): Promise<Agent> {
  const yamlPath = agentYamlPath(workspaceRoot, id);
  const raw = await readYamlFile(yamlPath);
  if (raw === null) {
    throw new AgentNotFoundError(id);
  }
  const check = validateAgentFrontMatter(raw);
  if (!check.ok || !check.value) {
    throw new AgentFileError(yamlPath, formatIssues(check.issues));
  }
  // Prefer the recursive instruction tree when it exists; fall back
  // to the flat instructions.md. Either way `.instructions` holds the
  // fully-composed playbook so every downstream caller (show, render)
  // is oblivious to which storage shape the agent uses.
  let instructions: string;
  if (await isDirectory(instructionsTreeDir(workspaceRoot, id))) {
    instructions = await composeInstructions(workspaceRoot, id);
  } else {
    instructions = (await readMaybe(instructionsPath(workspaceRoot, id))) ?? "";
  }
  const learnings = await readMaybe(learningsPath(workspaceRoot, id));
  return { ...check.value, instructions, learnings: learnings ?? "" };
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

// ============================================================
// Recursive instruction tree
// ============================================================

/**
 * Write an agent's playbook as a recursive instruction tree under
 * `instructions/`. Each unit becomes its own folder:
 *
 *   instructions/
 *     index.yaml            kind: instructions, children: [<unit>/, …]
 *     <unit-slug>/
 *       index.yaml          kind: instruction, name/description
 *       detail.md           the detailed instruction text
 *       <sub-unit-slug>/    (recurses)
 *
 * This is the progressive-disclosure shape: an agent reads the
 * instructions/index.yaml to see what units exist (title + brief
 * description), then loads only the detail.md it needs.
 */
export async function writeInstructionTree(
  workspaceRoot: string,
  id: string,
  units: InstructionUnit[],
  opts: { name?: string; description?: string } = {}
): Promise<void> {
  const base = instructionsTreeDir(workspaceRoot, id);
  await writeFolderIndex(base, {
    name: opts.name ?? "Playbook",
    kind: "instructions",
    description: opts.description,
    children: units.map((u) => ({
      path: `${u.slug}/`,
      title: u.title,
      kind: "instruction",
      description: u.description,
    })),
  });
  for (const unit of units) {
    await writeInstructionUnit(path.join(base, unit.slug), unit);
  }
}

async function writeInstructionUnit(dir: string, unit: InstructionUnit): Promise<void> {
  const children = unit.children ?? [];
  await writeFolderIndex(dir, {
    name: unit.title,
    kind: "instruction",
    description: unit.description,
    children:
      children.length > 0
        ? children.map((c) => ({
            path: `${c.slug}/`,
            title: c.title,
            kind: "instruction",
            description: c.description,
          }))
        : undefined,
  });
  await fs.writeFile(path.join(dir, "detail.md"), normalizeBody(unit.detail ?? ""), "utf8");
  for (const child of children) {
    await writeInstructionUnit(path.join(dir, child.slug), child);
  }
}

/**
 * Compose an agent's full playbook from its instruction tree by
 * walking `instructions/index.yaml` in order: each unit contributes a
 * markdown heading (from its index title) followed by its detail.md,
 * recursing into sub-units at deeper heading levels. Returns "" when
 * there's no instructions/ tree.
 */
export async function composeInstructions(workspaceRoot: string, id: string): Promise<string> {
  const base = instructionsTreeDir(workspaceRoot, id);
  const top = await readFolderIndex(base);
  if (!top) return "";
  const parts: string[] = [];
  if (top.description) parts.push(top.description.trim());
  for (const child of top.children ?? []) {
    await composeUnit(base, child.path, 2, parts);
  }
  return parts.join("\n\n").trimEnd() + "\n";
}

async function composeUnit(
  parentDir: string,
  childPath: string,
  level: number,
  parts: string[]
): Promise<void> {
  const dir = path.join(parentDir, childPath.replace(/\/$/, ""));
  const idx = await readFolderIndex(dir);
  const title = idx?.name ?? childPath.replace(/\/$/, "");
  parts.push(`${"#".repeat(Math.min(level, 6))} ${title}`);
  const detail = await readMaybe(path.join(dir, "detail.md"));
  if (detail && detail.trim()) parts.push(detail.trim());
  for (const sub of idx?.children ?? []) {
    await composeUnit(dir, sub.path, level + 1, parts);
  }
}

/**
 * List the top-level instruction units of an agent (title +
 * description) for a quick overview, without composing the whole
 * playbook. Returns [] when the agent has no instruction tree.
 */
export async function listInstructionUnits(
  workspaceRoot: string,
  id: string
): Promise<{ slug: string; title: string; description?: string }[]> {
  const top = await readFolderIndex(instructionsTreeDir(workspaceRoot, id));
  if (!top) return [];
  return (top.children ?? []).map((c) => ({
    slug: c.path.replace(/\/$/, ""),
    title: c.title,
    description: c.description,
  }));
}

/**
 * Add (or replace) one instruction unit on an agent that already uses
 * a tree. Creates the instructions/ tree if the agent currently has a
 * flat instructions.md (migrating the flat body into an "overview"
 * unit first so nothing is lost). Bumps the agent's version/updatedAt.
 */
export async function addInstructionUnit(
  workspaceRoot: string,
  id: string,
  unit: InstructionUnit,
  opts: { parentSlug?: string } = {}
): Promise<Agent> {
  const existing = await loadAgent(workspaceRoot, id); // throws if unknown
  const base = instructionsTreeDir(workspaceRoot, id);

  if (!(await isDirectory(base))) {
    // Migrate a flat playbook into the tree as an "overview" unit so
    // the existing instructions aren't lost when we switch shapes.
    const flat = (await readMaybe(instructionsPath(workspaceRoot, id))) ?? "";
    const seed: InstructionUnit[] = [];
    if (flat.trim()) {
      seed.push({
        slug: "overview",
        title: "Overview",
        description: "The agent's original playbook.",
        detail: flat,
      });
    }
    await writeInstructionTree(workspaceRoot, id, seed, { description: existing.purpose });
    await fs.rm(instructionsPath(workspaceRoot, id), { force: true });
  }

  if (opts.parentSlug) {
    const parentDir = path.join(base, opts.parentSlug);
    if (!(await isDirectory(parentDir))) {
      throw new Error(`No instruction unit "${opts.parentSlug}" to nest under.`);
    }
    // Write the new unit's folder, then add it to the parent's index.
    await writeInstructionUnit(path.join(parentDir, unit.slug), unit);
    const parentIdx = (await readFolderIndex(parentDir))!;
    const children = (parentIdx.children ?? []).filter(
      (c) => c.path.replace(/\/$/, "") !== unit.slug
    );
    children.push({ path: `${unit.slug}/`, title: unit.title, kind: "instruction", description: unit.description });
    await writeFolderIndex(parentDir, { ...parentIdx, children });
  } else {
    await writeInstructionUnit(path.join(base, unit.slug), unit);
    const topIdx = (await readFolderIndex(base))!;
    const children = (topIdx.children ?? []).filter(
      (c) => c.path.replace(/\/$/, "") !== unit.slug
    );
    children.push({ path: `${unit.slug}/`, title: unit.title, kind: "instruction", description: unit.description });
    await writeFolderIndex(base, { ...topIdx, children });
  }

  return updateAgent(workspaceRoot, id, {}); // bump version/updatedAt, reload
}

export interface AgentListing {
  agent: Agent;
  /** True when the agent has been rendered into `.claude/`. */
  installed: boolean;
}

export interface BuiltinListing {
  id: string;
  name: string;
  kind?: string;
  purpose: string;
}

/**
 * List agents materialized under `.atelier/agents/`, plus the set of
 * built-in templates that have NOT yet been materialized (so the CLI
 * can show "available to install").
 */
export async function listAgents(workspaceRoot: string): Promise<{
  agents: AgentListing[];
  available: BuiltinListing[];
  errors: { filePath: string; error: Error }[];
}> {
  const root = agentsRoot(workspaceRoot);
  const errors: { filePath: string; error: Error }[] = [];
  const agents: AgentListing[] = [];
  const materialized = new Set<string>();

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    entries = [];
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const yamlPath = agentYamlPath(workspaceRoot, id);
    try {
      await fs.access(yamlPath);
    } catch {
      continue; // folder without agent.yaml — not ours
    }
    try {
      const agent = await loadAgent(workspaceRoot, id);
      materialized.add(id);
      agents.push({ agent, installed: await isInstalled(workspaceRoot, id) });
    } catch (err) {
      errors.push({ filePath: yamlPath, error: err as Error });
    }
  }

  const available: BuiltinListing[] = BUILTIN_AGENTS.filter(
    (b) => !materialized.has(b.meta.id)
  ).map((b) => ({
    id: b.meta.id,
    name: b.meta.name,
    kind: b.meta.kind,
    purpose: b.meta.purpose,
  }));

  return { agents, available, errors };
}

async function isInstalled(workspaceRoot: string, id: string): Promise<boolean> {
  try {
    await fs.access(renderedSubagentPath(workspaceRoot, id));
    return true;
  } catch {
    return false;
  }
}

export interface UpdateAgentOptions {
  name?: string;
  kind?: string | null;
  purpose?: string;
  description?: string | null;
  argumentHint?: string | null;
  tools?: string[] | null;
  model?: string | null;
  instructions?: string;
}

export async function updateAgent(
  workspaceRoot: string,
  id: string,
  patch: UpdateAgentOptions
): Promise<Agent> {
  const existing = await loadAgent(workspaceRoot, id);
  const next: Agent = { ...existing };
  if (patch.name !== undefined) {
    if (!patch.name) throw new Error("name cannot be cleared");
    next.name = patch.name;
  }
  if (patch.kind !== undefined) next.kind = patch.kind === null ? undefined : patch.kind;
  if (patch.purpose !== undefined) {
    if (!patch.purpose) throw new Error("purpose cannot be cleared");
    next.purpose = patch.purpose;
  }
  if (patch.description !== undefined) {
    next.description = patch.description === null ? undefined : patch.description;
  }
  if (patch.argumentHint !== undefined) {
    next.argumentHint = patch.argumentHint === null ? undefined : patch.argumentHint;
  }
  if (patch.tools !== undefined) {
    next.tools = patch.tools === null ? undefined : patch.tools;
  }
  if (patch.model !== undefined) {
    next.model = patch.model === null ? undefined : patch.model;
  }
  next.version = existing.version + 1;
  next.updatedAt = new Date().toISOString();

  await ensureFolder(workspaceRoot, id);
  await writeAgentYaml(workspaceRoot, toFrontMatter(next));
  if (patch.instructions !== undefined) {
    next.instructions = patch.instructions;
    await fs.writeFile(instructionsPath(workspaceRoot, id), normalizeBody(patch.instructions), "utf8");
  }
  return next;
}

/**
 * Replace the playbook body (instructions.md). Bumps version +
 * updatedAt. Re-render with `installAgent` to push the change to
 * `.claude/`.
 */
export async function updateInstructions(
  workspaceRoot: string,
  id: string,
  instructions: string
): Promise<Agent> {
  return updateAgent(workspaceRoot, id, { instructions });
}

/**
 * Append a durable learning to the agent's learnings.md, then bump
 * the agent's updatedAt. Each entry is timestamped so the file reads
 * as a running log. Returns the reloaded agent (with the new
 * learnings body) so callers can immediately re-render.
 */
export async function appendLearning(
  workspaceRoot: string,
  id: string,
  note: string,
  opts: { header?: string } = {}
): Promise<Agent> {
  if (!note.trim()) throw new Error("learning note cannot be empty");
  const existing = await loadAgent(workspaceRoot, id);
  await ensureFolder(workspaceRoot, id);
  const now = new Date().toISOString();
  const heading = opts.header ? `## ${opts.header} — ${now}` : `## ${now}`;
  const separator =
    existing.learnings.length > 0 && !existing.learnings.endsWith("\n\n") ? "\n\n" : "";
  const nextLearnings =
    existing.learnings + separator + `${heading}\n\n${note.trim()}\n`;
  await fs.writeFile(learningsPath(workspaceRoot, id), nextLearnings, "utf8");

  const next: Agent = {
    ...existing,
    learnings: nextLearnings,
    updatedAt: now,
  };
  await writeAgentYaml(workspaceRoot, toFrontMatter(next));
  return next;
}

export async function removeAgent(workspaceRoot: string, id: string): Promise<Agent> {
  const existing = await loadAgent(workspaceRoot, id);
  // Remove canonical folder + any rendered .claude/ artifacts.
  await fs.rm(agentFolderPath(workspaceRoot, id), { recursive: true, force: true });
  await uninstallAgent(workspaceRoot, id).catch(() => {});
  return existing;
}

// ============================================================
// Built-in materialization
// ============================================================

/**
 * Ensure a built-in agent exists under `.atelier/agents/`. If it's
 * already materialized, returns the existing one untouched. Otherwise
 * writes the template out with fresh timestamps + version 1.
 */
export async function materializeBuiltin(
  workspaceRoot: string,
  id: string
): Promise<Agent> {
  const builtin = findBuiltinAgent(id);
  if (!builtin) throw new AgentNotFoundError(id);
  try {
    return await loadAgent(workspaceRoot, id);
  } catch (err) {
    if (!(err instanceof AgentNotFoundError)) throw err;
  }
  return addAgent(workspaceRoot, {
    ...builtin.meta,
    builtin: true,
    instructions: builtin.instructions,
    instructionUnits: builtin.instructionUnits,
    instructionsDescription: builtin.meta.purpose,
  });
}

// ============================================================
// Rendering — canonical def → Claude-discoverable markdown
// ============================================================

/**
 * Fold an agent's learnings into a single markdown section appended
 * to the rendered body, so the AI tool carries accumulated workspace
 * context. Returns "" when there are no learnings.
 */
function renderLearningsSection(agent: Agent): string {
  if (!agent.learnings.trim()) return "";
  return (
    "\n\n---\n\n" +
    "## What I've learned about this workspace\n\n" +
    "_Accumulated by atelier across discovery runs. Treat as durable context._\n\n" +
    agent.learnings.trim() +
    "\n"
  );
}

function frontMatterBlock(fields: Array<[string, string | undefined]>): string {
  const lines = ["---"];
  for (const [k, v] of fields) {
    if (v === undefined || v === "") continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** YAML-escape a scalar that may contain colons/quotes for frontmatter. */
function yamlScalar(s: string): string {
  if (/[:#\[\]{}",&*!|>%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Render the slash command file body (.claude/commands/atelier/<id>.md).
 * The body is the agent's playbook prompt; `$ARGUMENTS` is passed
 * through so the user can focus the run.
 */
export function renderClaudeCommand(agent: Agent): string {
  const fm = frontMatterBlock([
    ["description", yamlScalar(agent.purpose)],
    ["argument-hint", agent.argumentHint ? yamlScalar(agent.argumentHint) : undefined],
    ["allowed-tools", agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : undefined],
    ["model", agent.model && agent.model !== "inherit" ? agent.model : undefined],
  ]);
  const body =
    agent.instructions.trimEnd() +
    renderLearningsSection(agent) +
    "\n\n---\n" +
    `_Generated by atelier from \`.atelier/agents/${agent.id}/\`. ` +
    "Edit the canonical files there and re-run `atelier agent install " +
    `${agent.id}\`, not this file._\n`;
  return `${fm}\n\n${body}`;
}

/**
 * Render the subagent file body (.claude/agents/atelier-<id>.md).
 * The body is the agent's system prompt; `description` drives Claude's
 * auto-delegation.
 */
export function renderClaudeSubagent(agent: Agent): string {
  const fm = frontMatterBlock([
    ["name", `atelier-${agent.id}`],
    ["description", yamlScalar(agent.description || agent.purpose)],
    ["tools", agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : undefined],
    ["model", agent.model ?? "inherit"],
  ]);
  const body =
    agent.instructions.trimEnd() +
    renderLearningsSection(agent) +
    "\n\n---\n" +
    `_Generated by atelier from \`.atelier/agents/${agent.id}/\`. ` +
    "Edit the canonical files there and re-run `atelier agent install " +
    `${agent.id}\`, not this file._\n`;
  return `${fm}\n\n${body}`;
}

// ============================================================
// Install / uninstall
// ============================================================

export interface InstallResult {
  agent: Agent;
  commandPath: string;
  subagentPath: string;
  /** What the user types in Claude Code to invoke the slash command. */
  invocation: string;
}

/**
 * Render an agent into `.claude/`. Materializes a built-in template
 * first when the id isn't yet under `.atelier/agents/`. Overwrites
 * any previously-rendered files (they're generated artifacts).
 */
export async function installAgent(
  workspaceRoot: string,
  id: string
): Promise<InstallResult> {
  let agent: Agent;
  try {
    agent = await loadAgent(workspaceRoot, id);
  } catch (err) {
    if (err instanceof AgentNotFoundError && findBuiltinAgent(id)) {
      agent = await materializeBuiltin(workspaceRoot, id);
    } else {
      throw err;
    }
  }

  const commandPath = renderedCommandPath(workspaceRoot, id);
  const subagentPath = renderedSubagentPath(workspaceRoot, id);
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.mkdir(path.dirname(subagentPath), { recursive: true });
  await fs.writeFile(commandPath, renderClaudeCommand(agent), "utf8");
  await fs.writeFile(subagentPath, renderClaudeSubagent(agent), "utf8");

  return {
    agent,
    commandPath,
    subagentPath,
    invocation: `/atelier:${id}`,
  };
}

/** Remove an agent's rendered `.claude/` artifacts (best-effort). */
export async function uninstallAgent(
  workspaceRoot: string,
  id: string
): Promise<{ commandPath: string; subagentPath: string }> {
  const commandPath = renderedCommandPath(workspaceRoot, id);
  const subagentPath = renderedSubagentPath(workspaceRoot, id);
  await fs.rm(commandPath, { force: true });
  await fs.rm(subagentPath, { force: true });
  return { commandPath, subagentPath };
}
