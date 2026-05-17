import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths, type WorkspacePaths, PLANNING_DIR } from "./paths.js";
import { writeYamlFile, readYamlFile } from "./yaml-io.js";
import {
  validateSourcesConfig,
  validateReposConfig,
  validateWorkspaceConfig,
  formatIssues,
} from "./validation.js";
import type { SourcesConfig, ReposConfig, WorkspaceConfig } from "./types.js";
import { ATELIER_VERSION } from "./version.js";

/**
 * Workspace lifecycle operations: initialize, detect, read configs.
 *
 * Kept in core (not cli) so other entry points (a future MCP server,
 * editor extensions, tests) can drive the same primitives.
 */

export class WorkspaceAlreadyInitializedError extends Error {
  constructor(public readonly planningDir: string) {
    super(`Planning workspace already initialized at ${planningDir}`);
    this.name = "WorkspaceAlreadyInitializedError";
  }
}

export class WorkspaceNotInitializedError extends Error {
  constructor(public readonly root: string) {
    super(`No planning workspace found at ${root} (expected ${PLANNING_DIR}/)`);
    this.name = "WorkspaceNotInitializedError";
  }
}

export class WorkspaceValidationError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}:\n${message}`);
    this.name = "WorkspaceValidationError";
  }
}

export interface InitOptions {
  /** Display name for the workspace. */
  name: string;
  /** Optional description. */
  description?: string;
  /** If true, overwrite an existing workspace. */
  force?: boolean;
}

export interface InitResult {
  paths: WorkspacePaths;
  createdFiles: string[];
}

/**
 * Check whether a planning workspace already exists at the given root.
 */
export async function workspaceExists(root: string): Promise<boolean> {
  const paths = workspacePaths(root);
  try {
    const stat = await fs.stat(paths.planning);
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Initialize a new planning workspace at `root`.
 *
 * Creates `.planning/` and all canonical subdirectories, plus the
 * starter config files. Refuses to overwrite an existing workspace
 * unless `force: true`.
 */
export async function initWorkspace(
  root: string,
  opts: InitOptions
): Promise<InitResult> {
  const paths = workspacePaths(root);

  if (!opts.force && (await workspaceExists(root))) {
    throw new WorkspaceAlreadyInitializedError(paths.planning);
  }

  // Create directory tree
  await fs.mkdir(paths.planning, { recursive: true });
  await fs.mkdir(paths.features, { recursive: true });
  await fs.mkdir(paths.docs, { recursive: true });
  await fs.mkdir(paths.issues, { recursive: true });
  await fs.mkdir(paths.ui, { recursive: true });
  await fs.mkdir(paths.cache, { recursive: true });

  // Build starter configs
  const now = new Date().toISOString();

  const workspace: WorkspaceConfig = {
    version: 1,
    name: opts.name,
    description: opts.description,
    createdAt: now,
    atelierVersion: ATELIER_VERSION,
  };

  const sources: SourcesConfig = { version: 1, sources: [] };
  const repos: ReposConfig = { version: 1, repos: [] };

  const created: string[] = [];

  await writeYamlFile(
    paths.workspaceConfig,
    workspace,
    "Atelier workspace metadata.\nDo not edit `version` or `createdAt` by hand."
  );
  created.push(paths.workspaceConfig);

  await writeYamlFile(
    paths.sourcesConfig,
    sources,
    "Documentation sources Atelier reads from (Notion, Confluence, GDocs, …).\nUse `atelier source add` to register new sources rather than editing by hand."
  );
  created.push(paths.sourcesConfig);

  await writeYamlFile(
    paths.reposConfig,
    repos,
    "Code repositories registered with this planning workspace.\nUse `atelier repo add <path>` to register a sibling repo."
  );
  created.push(paths.reposConfig);

  // Write the human-facing README that lives at .planning/README.md
  const readmeBody = renderWorkspaceReadme(opts.name, opts.description);
  await fs.writeFile(paths.readme, readmeBody, "utf8");
  created.push(paths.readme);

  // Write a local .gitignore inside .planning/ so the cache stays out of git
  // even if the parent repo doesn't have a .gitignore.
  const gitignore = "# Local cache — every developer rebuilds from sources.\ncache/\n";
  await fs.writeFile(path.join(paths.planning, ".gitignore"), gitignore, "utf8");
  created.push(path.join(paths.planning, ".gitignore"));

  return { paths, createdFiles: created };
}

/**
 * Load and validate all configs from an existing workspace.
 * Throws WorkspaceNotInitializedError if `.planning/` is missing.
 * Throws WorkspaceValidationError if any config file is malformed.
 */
export async function loadWorkspace(root: string): Promise<{
  paths: WorkspacePaths;
  workspace: WorkspaceConfig;
  sources: SourcesConfig;
  repos: ReposConfig;
}> {
  const paths = workspacePaths(root);
  if (!(await workspaceExists(root))) {
    throw new WorkspaceNotInitializedError(root);
  }

  const rawWorkspace = await readYamlFile(paths.workspaceConfig);
  const ws = validateWorkspaceConfig(rawWorkspace);
  if (!ws.ok || !ws.value) {
    throw new WorkspaceValidationError(paths.workspaceConfig, formatIssues(ws.issues));
  }

  const rawSources = (await readYamlFile(paths.sourcesConfig)) ?? { version: 1, sources: [] };
  const sources = validateSourcesConfig(rawSources);
  if (!sources.ok || !sources.value) {
    throw new WorkspaceValidationError(paths.sourcesConfig, formatIssues(sources.issues));
  }

  const rawRepos = (await readYamlFile(paths.reposConfig)) ?? { version: 1, repos: [] };
  const repos = validateReposConfig(rawRepos);
  if (!repos.ok || !repos.value) {
    throw new WorkspaceValidationError(paths.reposConfig, formatIssues(repos.issues));
  }

  return {
    paths,
    workspace: ws.value,
    sources: sources.value,
    repos: repos.value,
  };
}

function renderWorkspaceReadme(name: string, description?: string): string {
  const lines: string[] = [];
  lines.push(`# ${name} — planning workspace`);
  lines.push("");
  if (description) {
    lines.push(description);
    lines.push("");
  }
  lines.push("This directory is managed by [Atelier](https://atelier.dev).");
  lines.push("");
  lines.push("## Layout");
  lines.push("");
  lines.push("- `workspace.yaml` — workspace metadata");
  lines.push("- `sources.yaml` — documentation sources Atelier reads from");
  lines.push("- `repos.yaml` — code repositories registered with this workspace");
  lines.push("- `features/` — the feature map (one markdown file per feature)");
  lines.push("- `docs/` — the doc map (one markdown file per indexed document, nested by source)");
  lines.push("- `discrepancies.yaml` — log of doc-vs-code mismatches");
  lines.push("- `ui/` — the page map and per-page layout descriptions");
  lines.push("- `issues/` — issue folders, one per planned change");
  lines.push("- `cache/` — local cache (gitignored)");
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push("Register your sibling repos:");
  lines.push("");
  lines.push("```sh");
  lines.push("atelier repo add ../api");
  lines.push("atelier repo add ../web");
  lines.push("```");
  lines.push("");
  lines.push("Add a documentation source:");
  lines.push("");
  lines.push("```sh");
  lines.push("atelier source add notion");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
