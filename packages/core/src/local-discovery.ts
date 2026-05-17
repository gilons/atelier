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
 * starting from `dir` and walking up, then sibling-by-sibling. Returns
 * the workspace root or null.
 *
 * Sibling lookup: if `dir` itself isn't inside a workspace, we check
 * each sibling of `dir` for a `.planning/`. This is the common case
 * for "user is in `api/` next to `planning/`".
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
  // 2. Siblings of `dir`.
  const umbrella = path.dirname(path.resolve(dir));
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(umbrella, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = path.join(umbrella, e.name);
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
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.org) continue;
    counts.set(c.org, (counts.get(c.org) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [org, count] of counts) {
    if (count > bestCount) {
      best = org;
      bestCount = count;
    }
  }
  return best;
}
