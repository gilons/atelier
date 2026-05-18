import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ATELIER_DIR, LEGACY_PLANNING_DIR } from "./paths.js";

/**
 * Walk up from `start` looking for a directory containing
 * `.atelier/` (or the legacy `.planning/`). Returns the absolute
 * path to the workspace root, or `null` if neither is found
 * before reaching the filesystem root.
 *
 * Every command except `init` should call this to locate the
 * workspace the user is operating against, so they can be run
 * from anywhere inside it.
 *
 * Legacy compat: pre-rename workspaces use `.planning/`; we still
 * find them so a `git pull` of someone else's existing workspace
 * doesn't immediately break. The user can `mv .planning .atelier`
 * at their leisure; the new name is preferred when both exist.
 */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  while (true) {
    if (await isWorkspaceDir(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * True when `dir` is itself a workspace root (i.e. contains
 * `.atelier/` or, for legacy workspaces, `.planning/`). New name
 * wins when both exist.
 */
async function isWorkspaceDir(dir: string): Promise<boolean> {
  for (const candidate of [ATELIER_DIR, LEGACY_PLANNING_DIR]) {
    try {
      const stat = await fs.stat(path.join(dir, candidate));
      if (stat.isDirectory()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
}

/**
 * Pick the workspace directory name that's actually on disk
 * under `root`. Returns `ATELIER_DIR` when neither exists (so a
 * fresh init uses the new name). Used by `loadWorkspace` to read
 * configs from the correct path regardless of which name was
 * persisted.
 */
export async function detectWorkspaceDirName(root: string): Promise<string> {
  // Prefer the new name when both exist.
  try {
    const stat = await fs.stat(path.join(root, ATELIER_DIR));
    if (stat.isDirectory()) return ATELIER_DIR;
  } catch {
    /* fall through */
  }
  try {
    const stat = await fs.stat(path.join(root, LEGACY_PLANNING_DIR));
    if (stat.isDirectory()) return LEGACY_PLANNING_DIR;
  } catch {
    /* fall through */
  }
  return ATELIER_DIR;
}

export class NotInsideWorkspaceError extends Error {
  constructor(public readonly start: string) {
    super(
      `Not inside an Atelier workspace (no ${ATELIER_DIR}/ found in ${start} or any parent). ` +
        `Run \`atelier init\` to create one.`
    );
    this.name = "NotInsideWorkspaceError";
  }
}

/** Like findWorkspaceRoot but throws when not found. */
export async function requireWorkspaceRoot(start: string): Promise<string> {
  const root = await findWorkspaceRoot(start);
  if (!root) throw new NotInsideWorkspaceError(start);
  return root;
}
