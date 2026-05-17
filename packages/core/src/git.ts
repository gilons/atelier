import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Minimal git config reader.
 *
 * We do NOT shell out to `git` for this — reading `.git/config` directly
 * avoids the git binary as a runtime dependency and is deterministic
 * (no flags, no locale, no version drift).
 *
 * If we later need git operations that require the binary (fetch, clone,
 * status), those go in a separate module and are explicit about the
 * external dependency.
 */

export class NotAGitRepoError extends Error {
  constructor(public readonly dirPath: string) {
    super(`Not a git repository: ${dirPath} (no .git directory found).`);
    this.name = "NotAGitRepoError";
  }
}

export class MissingRemoteError extends Error {
  constructor(
    public readonly dirPath: string,
    public readonly remoteName: string
  ) {
    super(`Git repository at ${dirPath} has no "${remoteName}" remote.`);
    this.name = "MissingRemoteError";
  }
}

export interface GitRepoInfo {
  /** Absolute path of the repository working tree. */
  path: string;
  /** Path to the `.git` directory. */
  gitDir: string;
  /** All configured remotes, name → url. */
  remotes: Map<string, string>;
}

/**
 * Inspect a directory and confirm it's a git repository. Returns its
 * configured remotes parsed from `.git/config`.
 *
 * Note: also handles git worktrees, where `.git` is a file pointing
 * elsewhere with `gitdir: ...`. The remotes still live in the original
 * `.git/config` of the main worktree.
 */
export async function inspectGitRepo(dirPath: string): Promise<GitRepoInfo> {
  const resolved = path.resolve(dirPath);
  const gitPath = path.join(resolved, ".git");

  let gitDir: string;
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      gitDir = gitPath;
    } else if (stat.isFile()) {
      // Worktree: `.git` is a file with `gitdir: <path>`.
      const content = await fs.readFile(gitPath, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) throw new NotAGitRepoError(resolved);
      gitDir = path.isAbsolute(match[1])
        ? match[1].trim()
        : path.resolve(resolved, match[1].trim());
    } else {
      throw new NotAGitRepoError(resolved);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotAGitRepoError(resolved);
    }
    throw err;
  }

  const configPath = path.join(gitDir, "config");
  let configContent: string;
  try {
    configContent = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // .git exists but no config — unusual but handle as "no remotes".
      return { path: resolved, gitDir, remotes: new Map() };
    }
    throw err;
  }

  const remotes = parseRemotes(configContent);
  return { path: resolved, gitDir, remotes };
}

/**
 * Parse the `[remote "name"]` sections from a git config file.
 * Exported for testing.
 */
export function parseRemotes(configContent: string): Map<string, string> {
  const remotes = new Map<string, string>();
  const lines = configContent.split(/\r?\n/);
  let currentRemote: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (line === "") continue;
    const sectionMatch = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/);
    if (sectionMatch) {
      currentRemote = sectionMatch[1];
      continue;
    }
    // Any other section header ends the remote block.
    if (line.startsWith("[")) {
      currentRemote = null;
      continue;
    }
    if (currentRemote) {
      const kv = line.match(/^([A-Za-z][\w-]*)\s*=\s*(.+)$/);
      if (kv && kv[1].toLowerCase() === "url") {
        remotes.set(currentRemote, kv[2].trim());
      }
    }
  }
  return remotes;
}

/**
 * Convenience: get the URL of a specific remote (default "origin").
 * Throws MissingRemoteError if absent.
 */
export async function getRemoteUrl(
  dirPath: string,
  remoteName = "origin"
): Promise<string> {
  const info = await inspectGitRepo(dirPath);
  const url = info.remotes.get(remoteName);
  if (!url) throw new MissingRemoteError(info.path, remoteName);
  return url;
}

/**
 * Derive a reasonable repo "name" from a git remote URL.
 * Handles SSH (`git@host:org/name.git`) and HTTPS (`https://host/org/name.git`)
 * forms. Returns the bare repo name without the `.git` suffix.
 */
export function repoNameFromRemote(remote: string): string {
  // Strip protocol or SSH user@host: prefix.
  let s = remote.trim();
  s = s.replace(/^[a-z]+:\/\//i, ""); // protocol://
  s = s.replace(/^[^@\s]+@/, ""); // ssh user@
  // Replace first ":" (SSH host separator) with "/".
  s = s.replace(":", "/");
  // Take the last segment.
  const segments = s.split("/").filter(Boolean);
  let last = segments[segments.length - 1] ?? s;
  // Strip trailing .git
  last = last.replace(/\.git$/i, "");
  return last;
}

/**
 * Derive the GitHub organization from a github.com remote URL.
 * Returns null for non-GitHub remotes.
 */
export function githubOrgFromRemote(remote: string): string | null {
  // Normalize to host/path form.
  let s = remote.trim();
  s = s.replace(/^[a-z]+:\/\//i, "");
  s = s.replace(/^[^@\s]+@/, "");
  s = s.replace(":", "/");
  const segments = s.split("/").filter(Boolean);
  // Expect: github.com / org / repo[.git]
  if (segments.length < 3) return null;
  if (segments[0].toLowerCase() !== "github.com") return null;
  return segments[1];
}
