import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseRemotes, githubOrgFromRemote, repoNameFromRemote } from "./git.js";

/**
 * Scan the filesystem for candidate git repos near a starting
 * directory. Pure complement to `git-hosts.ts` (which queries GitHub):
 * this answers "what does the user already have cloned?" so the REPL
 * can suggest registrations without needing network access.
 *
 * Two scan modes:
 *
 *   - `scanSiblings(dir)`     — for an umbrella dir like
 *                               `~/workspace/myorg/`, returns every
 *                               immediate child that's a git repo.
 *   - `inferRepoContext(dir)` — for the current dir, walk up to find
 *                               the nearest `.git/` and return the
 *                               repo root + remote.
 */

export interface LocalRepoCandidate {
  /** Absolute path to the repo root. */
  absPath: string;
  /** Directory basename (often equals the repo name). */
  dirName: string;
  /** Best-guess remote URL, if `.git/config` had one. */
  remote: string | null;
  /** Derived repo name from the remote (or dirName as fallback). */
  repoName: string;
  /** Derived GitHub org from the remote (or null). */
  org: string | null;
}

/**
 * Look in the parent of `dir` (the "umbrella") for sibling directories
 * that are git repos. Excludes `dir` itself.
 */
export async function scanSiblings(dir: string): Promise<LocalRepoCandidate[]> {
  const umbrella = path.dirname(dir);
  return scanChildren(umbrella, [path.basename(dir)]);
}

/**
 * Look in `dir` itself for immediate children that are git repos.
 * Used when the user runs atelier in an umbrella dir directly.
 */
export async function scanChildren(
  dir: string,
  exclude: string[] = []
): Promise<LocalRepoCandidate[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LocalRepoCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (exclude.includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    const candidate = await inspectAsRepo(abs);
    if (candidate) out.push(candidate);
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/**
 * Walk up from `dir` to find the nearest ancestor that has a `.git/`
 * directory. Returns the resolved candidate, or null. Useful when the
 * user runs atelier from inside a repo's subdirectory.
 */
export async function inferRepoContext(
  dir: string
): Promise<LocalRepoCandidate | null> {
  let current = path.resolve(dir);
  while (true) {
    const candidate = await inspectAsRepo(current);
    if (candidate) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Look for the nearest workspace (a directory containing `.planning/`)
 * starting from `dir` and probing in three directions:
 *
 *   1. **Ancestors.** Walk up from `dir` until we hit one that contains
 *      `.planning/`. Covers the common case of running atelier from a
 *      subdirectory of the workspace itself.
 *   2. **Immediate children.** Look one level into `dir` for a child
 *      that is a workspace. Covers the case of running atelier from
 *      an umbrella dir (e.g. `~/workspace/myorg/`) when the workspace
 *      lives at `myorg/planning/`.
 *   3. **Siblings.** Look one level into the parent of `dir`. Covers
 *      the case of running atelier from inside a code repo that sits
 *      next to a `planning/` workspace.
 *
 * Returns the workspace root (the directory *containing* `.planning/`)
 * or null when nothing is found. We do NOT recursively scan past one
 * level in any direction — workspaces are conventionally placed at a
 * predictable layer, and unbounded scanning would surprise the user.
 */
export async function findNearbyWorkspace(dir: string): Promise<string | null> {
  // 1. Up the tree.
  let current = path.resolve(dir);
  while (true) {
    if (await hasPlanningDir(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 2. Children of `dir` (one level deep).
  const childMatch = await scanForWorkspaceIn(path.resolve(dir));
  if (childMatch) return childMatch;
  // 3. Siblings of `dir` (children of `dir`'s parent).
  const umbrella = path.dirname(path.resolve(dir));
  return await scanForWorkspaceIn(umbrella);
}

async function scanForWorkspaceIn(parent: string): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const cand = path.join(parent, e.name);
    if (await hasPlanningDir(cand)) return cand;
  }
  return null;
}

async function hasPlanningDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, ".planning"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function inspectAsRepo(absPath: string): Promise<LocalRepoCandidate | null> {
  const configPath = path.join(absPath, ".git", "config");
  let configText: string;
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const remotes = parseRemotes(configText);
  const origin = remotes.get("origin") ?? null;
  const fallback = origin ?? (remotes.size > 0 ? [...remotes.values()][0] : null);
  const dirName = path.basename(absPath);
  return {
    absPath,
    dirName,
    remote: fallback,
    repoName: fallback ? (repoNameFromRemote(fallback) ?? dirName) : dirName,
    org: fallback ? githubOrgFromRemote(fallback) : null,
  };
}

/**
 * Given a set of candidates, return the most common GitHub org
 * (majority vote). Useful for deducing "this looks like the `acme`
 * org" when several siblings share an org.
 */
export function inferOrg(candidates: LocalRepoCandidate[]): string | null {
  const orgs = extractDistinctOrgs(candidates);
  return orgs[0] ?? null;
}

/**
 * Every distinct GitHub org found across `candidates`' remotes,
 * ordered by frequency (most-common first). Lets the REPL query gh
 * for *every* relevant org, not just the majority — important when a
 * user's working directory spans multiple orgs (e.g. `acme` +
 * `acme-frontend`).
 */
export function extractDistinctOrgs(candidates: LocalRepoCandidate[]): string[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.org) continue;
    counts.set(c.org, (counts.get(c.org) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([org]) => org);
}

// ============================================================
// Aggregate discovery — used by the REPL welcome banner
// ============================================================

export interface LocalDiscovery {
  /** Every local git repo we found, deduped by absolute path. */
  localRepos: LocalRepoCandidate[];
  /** Distinct GitHub orgs across those repos. Most-common first. */
  orgs: string[];
  /**
   * Human-readable list of the directories we actually scanned, so
   * the welcome banner can tell the user where it looked. (Helps
   * with "wait, why didn't it find X?" debugging.)
   */
  scannedPaths: string[];
}

/**
 * Walk every plausible location near `cwd` for git repos. This is
 * the "look around me" half of repo discovery; the gh-org-listing
 * half lives in {@link discovery.ts}'s GhAdapter + discoverRepos.
 *
 * What we scan (deduping, never recursive past depth 1):
 *
 *   1. The children of `cwd` itself — covers "user is in the umbrella
 *      directory".
 *   2. The children of `cwd`'s parent — covers "user is in a code repo
 *      whose siblings are other code repos".
 *   3. The children of `workspaceRoot`'s parent, if a workspace is
 *      nearby and isn't already covered by (1) or (2) — covers "user
 *      is in some other dir but a workspace lives in a sibling tree".
 *
 * No network IO. Cheap and safe to call eagerly on REPL startup.
 */
export async function discoverLocal(
  cwd: string,
  workspaceRoot?: string | null
): Promise<LocalDiscovery> {
  const seen = new Map<string, LocalRepoCandidate>();
  const scannedPaths: string[] = [];

  async function ingest(parent: string): Promise<void> {
    const repos = await scanChildren(parent);
    if (repos.length === 0) return;
    scannedPaths.push(parent);
    for (const r of repos) {
      // Dedupe by absolute path so the same repo found via two scan
      // paths only counts once.
      if (!seen.has(r.absPath)) seen.set(r.absPath, r);
    }
  }

  const cwdResolved = path.resolve(cwd);
  await ingest(cwdResolved);
  await ingest(path.dirname(cwdResolved));
  if (workspaceRoot) {
    const wsParent = path.dirname(path.resolve(workspaceRoot));
    if (!scannedPaths.includes(wsParent)) {
      await ingest(wsParent);
    }
  }

  const localRepos = [...seen.values()].sort((a, b) =>
    a.dirName.localeCompare(b.dirName)
  );
  return { localRepos, orgs: extractDistinctOrgs(localRepos), scannedPaths };
}
