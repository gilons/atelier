import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PLANNING_DIR } from "./paths.js";

/**
 * Walk up from `start` looking for a directory containing `.planning/`.
 * Returns the absolute path to the workspace root, or `null` if none found
 * before reaching the filesystem root.
 *
 * Every command except `init` should call this to locate the workspace
 * the user is operating against, so they can be run from anywhere inside it.
 */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  // Walk until we hit the filesystem root (parent === self).
  while (true) {
    const candidate = path.join(current, PLANNING_DIR);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class NotInsideWorkspaceError extends Error {
  constructor(public readonly start: string) {
    super(
      `Not inside an Atelier workspace (no ${PLANNING_DIR}/ found in ${start} or any parent). ` +
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
