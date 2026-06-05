import * as fs from "node:fs/promises";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { validateProjectsConfig, formatIssues } from "./validation.js";
import { workspacePaths } from "./paths.js";
import { WorkspaceValidationError } from "./workspace.js";
import type { Project, ProjectsConfig } from "./types.js";

/**
 * Projects: scoping a workspace into multiple realities.
 *
 * One workspace (one `.atelier/`, one git repo) can hold several
 * projects: an agency's clients, a company's product lines. Each
 * project scopes its own sources, repos, features, designs, specs, and
 * sessions. Docs and tickets inherit their project from their source.
 *
 * An entry with no `project` is GLOBAL: it shows up in every project
 * (a shared component library, an internal standards doc, the agency's
 * own people). The effective view inside a project is "that project's
 * entries + the global ones".
 *
 * The project *registry* (`projects.yaml`) is committed and shared. The
 * *active* project is pinned locally (`.atelier/.active-project`,
 * gitignored): which project a developer is working in is personal, not
 * a shared decision. A per-command `--project` flag overrides the pin.
 */

const PROJECT_HEADER =
  "Projects scope this workspace into separate realities (e.g. an\n" +
  "agency's clients). Each project owns its sources, repos, features,\n" +
  "designs, specs, and sessions. Use `atelier project` rather than\n" +
  "editing by hand. Entries with no project are global (shared).";

/** Lowercase slug, no edge dashes. Same shape as feature / source ids. */
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Sentinels that can never be a project id (used as scope keywords). */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set(["all", "global", "none"]);

export class ProjectAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A project with id "${id}" already exists.`);
    this.name = "ProjectAlreadyExistsError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No project with id "${id}".`);
    this.name = "ProjectNotFoundError";
  }
}

/** Slug-style id derived from a name. */
export function deriveProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "project";
}

export async function loadProjectsConfig(workspaceRoot: string): Promise<ProjectsConfig> {
  const p = workspacePaths(workspaceRoot);
  const raw = (await readYamlFile(p.projectsConfig)) ?? { version: 1, projects: [] };
  const result = validateProjectsConfig(raw);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(p.projectsConfig, formatIssues(result.issues));
  }
  return result.value;
}

export async function saveProjectsConfig(
  workspaceRoot: string,
  cfg: ProjectsConfig
): Promise<void> {
  const p = workspacePaths(workspaceRoot);
  const result = validateProjectsConfig(cfg);
  if (!result.ok) {
    throw new WorkspaceValidationError(p.projectsConfig, formatIssues(result.issues));
  }
  await writeYamlFile(p.projectsConfig, cfg, PROJECT_HEADER);
}

export async function listProjects(workspaceRoot: string): Promise<Project[]> {
  return (await loadProjectsConfig(workspaceRoot)).projects;
}

export async function loadProject(workspaceRoot: string, id: string): Promise<Project> {
  const cfg = await loadProjectsConfig(workspaceRoot);
  const found = cfg.projects.find((p) => p.id === id);
  if (!found) throw new ProjectNotFoundError(id);
  return found;
}

export interface AddProjectOptions {
  id?: string;
  name: string;
  client?: string;
  status?: string;
  now?: Date;
}

export async function addProject(
  workspaceRoot: string,
  opts: AddProjectOptions
): Promise<Project> {
  if (!opts.name) throw new Error("AddProjectOptions.name is required");
  const id = (opts.id ?? deriveProjectId(opts.name)).trim();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid project id "${id}" (lowercase letters, digits, hyphens; no edge dashes).`);
  }
  if (RESERVED_PROJECT_IDS.has(id)) {
    throw new Error(`"${id}" is a reserved keyword and cannot be a project id.`);
  }
  const cfg = await loadProjectsConfig(workspaceRoot);
  if (cfg.projects.some((p) => p.id === id)) throw new ProjectAlreadyExistsError(id);

  const now = (opts.now ?? new Date()).toISOString();
  const project: Project = { id, name: opts.name, createdAt: now, updatedAt: now };
  if (opts.client) project.client = opts.client;
  if (opts.status) project.status = opts.status;
  cfg.projects.push(project);
  cfg.projects.sort((a, b) => a.id.localeCompare(b.id));
  await saveProjectsConfig(workspaceRoot, cfg);
  return project;
}

export async function removeProject(workspaceRoot: string, id: string): Promise<Project> {
  const cfg = await loadProjectsConfig(workspaceRoot);
  const idx = cfg.projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new ProjectNotFoundError(id);
  const [removed] = cfg.projects.splice(idx, 1);
  await saveProjectsConfig(workspaceRoot, cfg);
  // If the removed project was the active pin, clear it.
  if ((await getActiveProject(workspaceRoot)) === id) {
    await setActiveProject(workspaceRoot, null);
  }
  return removed;
}

// ============================================================
// Active project (local, gitignored pin)
// ============================================================

/** The locally pinned active project id, or null if none. */
export async function getActiveProject(workspaceRoot: string): Promise<string | null> {
  const file = workspacePaths(workspaceRoot).activeProjectFile;
  try {
    const v = (await fs.readFile(file, "utf8")).trim();
    return v.length > 0 ? v : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Pin (or clear, with null) the active project. */
export async function setActiveProject(
  workspaceRoot: string,
  id: string | null
): Promise<void> {
  const file = workspacePaths(workspaceRoot).activeProjectFile;
  if (id === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.writeFile(file, id + "\n", "utf8");
}

/** Throw if `id` is not a registered project. */
export async function assertProjectExists(workspaceRoot: string, id: string): Promise<void> {
  const cfg = await loadProjectsConfig(workspaceRoot);
  if (!cfg.projects.some((p) => p.id === id)) throw new ProjectNotFoundError(id);
}

// ============================================================
// Scope resolution
// ============================================================

/** The effective scope a command/agent operates in. */
export type ProjectScope = { kind: "all" } | { kind: "project"; id: string };

/**
 * Resolve the scope for a read/list operation:
 *   --project all                -> everything
 *   --project <id>               -> that project (+ global)
 *   no flag, active pinned       -> the active project (+ global)
 *   no flag, nothing pinned      -> everything (backward compatible)
 */
export async function resolveProjectScope(
  workspaceRoot: string,
  opts: { project?: string } = {}
): Promise<ProjectScope> {
  const explicit = opts.project?.trim();
  if (explicit === "all") return { kind: "all" };
  if (explicit && !RESERVED_PROJECT_IDS.has(explicit)) return { kind: "project", id: explicit };
  const active = await getActiveProject(workspaceRoot);
  if (active) return { kind: "project", id: active };
  return { kind: "all" };
}

/** Is an entry (with the given project, undefined = global) in scope? */
export function inProjectScope(entryProject: string | undefined | null, scope: ProjectScope): boolean {
  if (scope.kind === "all") return true;
  return !entryProject || entryProject === scope.id;
}

/**
 * The project a newly-created entry should be tagged with:
 *   --project global   -> undefined (explicitly global)
 *   --project <id>     -> that project
 *   no flag, active    -> the active project
 *   no flag, nothing   -> undefined (global)
 */
export async function defaultProjectForNew(
  workspaceRoot: string,
  opts: { project?: string } = {}
): Promise<string | undefined> {
  const explicit = opts.project?.trim();
  if (explicit === "global" || explicit === "none") return undefined;
  if (explicit && explicit !== "all") return explicit;
  const active = await getActiveProject(workspaceRoot);
  return active ?? undefined;
}
