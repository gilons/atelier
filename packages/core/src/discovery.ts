import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GitHostAdapter, RemoteRepoInfo } from "./git-hosts.js";
import { loadReposConfig } from "./repos.js";
import { repoNameFromRemote } from "./git.js";

/**
 * Canonicalize a clone URL so two forms that point at the same repo
 * compare equal. `gh repo list` returns `url` without a `.git` suffix
 * (e.g. `https://github.com/org/api`) but git's own `.git/config`
 * records the suffix (`https://github.com/org/api.git`). Without
 * normalization, discovery shows already-registered repos as
 * unregistered.
 *
 * Also lowercases the host portion (GitHub URLs are case-insensitive
 * on the org/repo, but only the host is reliably safe to lowercase).
 */
function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  return s;
}

/**
 * High-level discovery: given an org and an authenticated host adapter,
 * compute what's already registered, what's locally cloned but not
 * registered, and what's available on the host but not present locally.
 *
 * Returns categorized lists rather than rendering them — keeps the
 * function pure and lets the CLI choose how to present.
 */

export interface DiscoveredRepo {
  /** Repo info from the host (gh, glab, ...). */
  remote: RemoteRepoInfo;
  /** True if a registered entry in repos.yaml already references this remote. */
  registered: boolean;
  /** Absolute path on disk if a sibling directory exists with this remote, else null. */
  localPath: string | null;
}

export interface DiscoveryResult {
  /** Org queried. */
  organization: string;
  /** Every repo discovered, with status. */
  repos: DiscoveredRepo[];
  /** Subset: in the org but not yet registered. Useful for "candidates" UI. */
  unregistered: DiscoveredRepo[];
  /** Subset: registered, but no local clone present. */
  missingLocally: DiscoveredRepo[];
}

/**
 * For each remote URL the host reports, check whether a local sibling
 * directory near the workspace has the matching remote in its .git/config.
 *
 * We don't require the directory name to match — the remote URL is what
 * ties registration to disk. This handles users who renamed local dirs.
 */
async function findLocalCloneFor(
  workspaceRoot: string,
  remote: RemoteRepoInfo
): Promise<string | null> {
  // Look in the parent of the workspace root (the umbrella) and within it.
  const umbrella = path.dirname(workspaceRoot);
  const candidates: string[] = [];

  // All sibling directories of workspaceRoot.
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(umbrella, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory()) candidates.push(path.join(umbrella, e.name));
  }
  // Also check inside the workspace root itself.
  try {
    const inside = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const e of inside) {
      if (e.isDirectory()) candidates.push(path.join(workspaceRoot, e.name));
    }
  } catch {
    // ignore
  }

  for (const dir of candidates) {
    const configPath = path.join(dir, ".git", "config");
    let configContent: string;
    try {
      configContent = await fs.readFile(configPath, "utf8");
    } catch {
      continue;
    }
    // Cheap match: look for either the ssh or https URL anywhere in config.
    const ssh = remote.sshUrl;
    const https = remote.httpsUrl;
    if (
      (ssh && configContent.includes(ssh)) ||
      (https && configContent.includes(https))
    ) {
      return dir;
    }
  }
  return null;
}

/**
 * Run discovery against the host and the workspace.
 */
export async function discoverRepos(
  workspaceRoot: string,
  organization: string,
  host: GitHostAdapter
): Promise<DiscoveryResult> {
  const remoteRepos = await host.listOrgRepos(organization);
  const cfg = await loadReposConfig(workspaceRoot);
  const registeredRemotes = new Set<string>(
    cfg.repos.map((r) => normalizeRemoteUrl(r.remote))
  );

  const repos: DiscoveredRepo[] = [];
  for (const remote of remoteRepos) {
    const registered =
      registeredRemotes.has(normalizeRemoteUrl(remote.sshUrl)) ||
      registeredRemotes.has(normalizeRemoteUrl(remote.httpsUrl));
    const localPath = await findLocalCloneFor(workspaceRoot, remote);
    repos.push({ remote, registered, localPath });
  }

  return {
    organization,
    repos,
    unregistered: repos.filter((r) => !r.registered),
    missingLocally: repos.filter((r) => r.registered && r.localPath === null),
  };
}

/**
 * Convenience: derive a sensible "next step" hint for a discovered repo
 * that isn't yet registered. The CLI uses this when listing candidates.
 */
export function suggestedAddCommand(repo: DiscoveredRepo, workspaceRoot: string): string {
  if (repo.localPath) {
    const rel = path.relative(workspaceRoot, repo.localPath);
    const display = rel === "" ? "." : rel.split(path.sep).join("/");
    return `atelier repo add ${display}`;
  }
  // Not cloned — suggest cloning first.
  return `gh repo clone ${repoNameFromRemoteOrUrl(repo.remote.sshUrl)}  &&  atelier repo add ../${repoNameFromRemoteOrUrl(repo.remote.sshUrl)}`;
}

function repoNameFromRemoteOrUrl(url: string): string {
  return repoNameFromRemote(url);
}
