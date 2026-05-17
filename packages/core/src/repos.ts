import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { validateReposConfig, formatIssues } from "./validation.js";
import { workspacePaths } from "./paths.js";
import {
  inspectGitRepo,
  repoNameFromRemote,
  githubOrgFromRemote,
  NotAGitRepoError,
  MissingRemoteError,
} from "./git.js";
import type { ReposConfig, RegisteredRepo } from "./types.js";
import { WorkspaceValidationError } from "./workspace.js";

/**
 * High-level operations on the repo registry (`.planning/repos.yaml`).
 *
 * All mutations go through these helpers so:
 *   - YAML formatting and header comments stay consistent
 *   - Schema validation runs on every write
 *   - Duplicates are caught at the source
 */

const REPOS_HEADER =
  "Code repositories registered with this planning workspace.\n" +
  "Use `atelier repo add <path>` to register a sibling repo.";

export class RepoAlreadyRegisteredError extends Error {
  constructor(public readonly remote: string) {
    super(`A repository with remote ${remote} is already registered.`);
    this.name = "RepoAlreadyRegisteredError";
  }
}

export class RepoNameNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`No registered repository named "${name}".`);
    this.name = "RepoNameNotFoundError";
  }
}

/**
 * Reserved for future stricter checks (e.g. opt-in mode that refuses
 * registrations far away from the workspace root). Not thrown today —
 * the canonical layout has code repos as siblings of the workspace
 * root, so paths like `../api` are valid and stored as `../api`.
 */
export class RepoOutsideWorkspaceError extends Error {
  constructor(public readonly absPath: string, public readonly workspaceRoot: string) {
    super(
      `Repository at ${absPath} is outside the workspace root ${workspaceRoot}.`
    );
    this.name = "RepoOutsideWorkspaceError";
  }
}

/** Load and validate the repo registry from a workspace. */
export async function loadReposConfig(workspaceRoot: string): Promise<ReposConfig> {
  const p = workspacePaths(workspaceRoot);
  const raw = (await readYamlFile(p.reposConfig)) ?? { version: 1, repos: [] };
  const result = validateReposConfig(raw);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(p.reposConfig, formatIssues(result.issues));
  }
  return result.value;
}

/** Write the repo registry back to disk (idempotent + validated). */
export async function saveReposConfig(
  workspaceRoot: string,
  cfg: ReposConfig
): Promise<void> {
  const p = workspacePaths(workspaceRoot);
  const result = validateReposConfig(cfg);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(p.reposConfig, formatIssues(result.issues));
  }
  await writeYamlFile(p.reposConfig, result.value, REPOS_HEADER);
}

export interface AddRepoOptions {
  /** Path to the repo on disk. Absolute or relative to `cwd`. */
  pathInput: string;
  /** Resolved cwd of the caller (for relative paths). */
  cwd: string;
  /** Optional override for the registered name. */
  name?: string;
  /** Optional description stored in repos.yaml. */
  description?: string;
}

export interface AddRepoResult {
  repo: RegisteredRepo;
  /** If this repo's GitHub org was detected and set as workspace org. */
  organizationSet?: string;
}

/**
 * Register a repository with the workspace.
 *
 * Process:
 *   1. Resolve the path against cwd, verify it exists and is inside the workspace
 *   2. Inspect via `.git/config` to confirm it's a git repo with a usable remote
 *   3. Refuse duplicates by remote URL
 *   4. Derive a name (caller override > basename > repo-name-from-remote)
 *   5. Store path as relative-to-workspace so it travels across machines
 *   6. If this is the first repo and a GitHub org is detected, persist it
 */
export async function addRepo(
  workspaceRoot: string,
  opts: AddRepoOptions
): Promise<AddRepoResult> {
  const absPath = path.resolve(opts.cwd, opts.pathInput);

  // Verify the directory exists.
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Path does not exist: ${absPath}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absPath}`);
  }

  // Compute the path relative to the workspace root. Resolve symlinks
  // on both sides first — on macOS, `/var/folders/...` (the form
  // `os.tmpdir()` returns) is a symlink to `/private/var/folders/...`
  // (the form `process.cwd()` returns), so without canonicalizing we
  // can end up with `../../../../private/var/...` for paths that are
  // physically siblings. May start with `..` for the canonical sibling
  // layout — that's expected and OK.
  const realWorkspace = await fs.realpath(workspaceRoot);
  const realAbs = await fs.realpath(absPath);
  const relPath = path.relative(realWorkspace, realAbs);

  // Inspect git config.
  const info = await inspectGitRepo(absPath);

  // Pick the remote — prefer "origin", fall back to the single remote if any.
  let remote = info.remotes.get("origin");
  if (!remote) {
    if (info.remotes.size === 1) {
      remote = [...info.remotes.values()][0];
    } else if (info.remotes.size === 0) {
      throw new MissingRemoteError(absPath, "origin");
    } else {
      throw new MissingRemoteError(absPath, "origin");
    }
  }

  // Load current registry.
  const cfg = await loadReposConfig(workspaceRoot);

  // Refuse duplicate.
  if (cfg.repos.some((r) => r.remote === remote)) {
    throw new RepoAlreadyRegisteredError(remote);
  }

  // Derive name.
  const derivedFromRemote = repoNameFromRemote(remote);
  const dirBase = path.basename(absPath);
  const name = opts.name ?? derivedFromRemote ?? dirBase;

  // Refuse duplicate names (different repos can't share a name).
  if (cfg.repos.some((r) => r.name === name)) {
    throw new Error(
      `A repository named "${name}" is already registered. Use --name to choose a different name.`
    );
  }

  // Build the entry. Store localPath relative to workspace root, with
  // forward slashes for cross-platform stability.
  const localPath = relPath === "" ? "." : relPath.split(path.sep).join("/");
  const repo: RegisteredRepo = {
    name,
    remote,
    localPath,
    description: opts.description,
    enabled: true,
  };

  // If this is the first repo and we can derive an org, set it on the config.
  let organizationSet: string | undefined;
  if (cfg.repos.length === 0 && !cfg.organization) {
    const org = githubOrgFromRemote(remote);
    if (org) {
      cfg.organization = org;
      organizationSet = org;
    }
  }

  cfg.repos.push(repo);
  await saveReposConfig(workspaceRoot, cfg);

  return { repo, organizationSet };
}

/** Remove a registered repo by name. Returns the removed entry. */
export async function removeRepo(
  workspaceRoot: string,
  name: string
): Promise<RegisteredRepo> {
  const cfg = await loadReposConfig(workspaceRoot);
  const idx = cfg.repos.findIndex((r) => r.name === name);
  if (idx === -1) throw new RepoNameNotFoundError(name);
  const [removed] = cfg.repos.splice(idx, 1);
  await saveReposConfig(workspaceRoot, cfg);
  return removed;
}

export interface RepoListing {
  repo: RegisteredRepo;
  /** Absolute path on this machine. */
  absPath: string;
  /** Whether the local directory currently exists. */
  exists: boolean;
}

/**
 * List all registered repos with their on-disk status. The workspace's
 * organization (if any) is returned alongside.
 */
export async function listRepos(workspaceRoot: string): Promise<{
  organization?: string;
  repos: RepoListing[];
}> {
  const cfg = await loadReposConfig(workspaceRoot);
  const listings: RepoListing[] = [];
  for (const repo of cfg.repos) {
    const absPath = path.resolve(workspaceRoot, repo.localPath ?? repo.name);
    let exists = false;
    try {
      const stat = await fs.stat(absPath);
      exists = stat.isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    listings.push({ repo, absPath, exists });
  }
  return { organization: cfg.organization, repos: listings };
}

// Re-export the surfaced error types for convenience
export { NotAGitRepoError, MissingRemoteError };
