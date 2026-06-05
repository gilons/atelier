import {
  resolveProjectScope,
  defaultProjectForNew,
  assertProjectExists,
  inProjectScope,
  type ProjectScope,
} from "@atelier/core";
import { ui } from "./ui.js";

/**
 * Shared project-scoping helpers for CLI commands.
 *
 * Read commands (`list`) call {@link readScope} to get the active scope
 * from the `--project` flag (or the locally pinned active project), then
 * filter their entries with {@link inProjectScope} (re-exported from
 * core). Create commands (`add`/`new`) call {@link newEntryProject} to
 * decide which project a fresh entry lands in.
 */

export { inProjectScope };
export type { ProjectScope };

/** Standard `--project <id>` flag definition for parseArgs options. */
export const PROJECT_OPTION = { project: { type: "string" as const } };

/**
 * Resolve the read scope for a list/map command from its parsed flags.
 *   --project all  -> everything
 *   --project <id> -> that project (+ global)
 *   (no flag)      -> the pinned active project (+ global), else everything
 */
export function readScope(
  workspaceRoot: string,
  values: Record<string, unknown>
): Promise<ProjectScope> {
  return resolveProjectScope(workspaceRoot, { project: values.project as string | undefined });
}

/**
 * Decide which project a newly-created entry should carry, and verify it
 * exists. Returns the project id, or undefined for a global entry.
 * Throws (via assertProjectExists) when an explicit `--project <id>`
 * names a project that isn't registered.
 */
export async function newEntryProject(
  workspaceRoot: string,
  values: Record<string, unknown>
): Promise<string | undefined> {
  const project = await defaultProjectForNew(workspaceRoot, {
    project: values.project as string | undefined,
  });
  if (project) await assertProjectExists(workspaceRoot, project);
  return project;
}

/**
 * A short dim tag for an entry's project, e.g. " (acme)" or " (global)".
 * Returns "" when not worth showing (scope is a single project and the
 * entry is in it). Used to annotate list rows.
 */
export function projectTag(project: string | undefined | null): string {
  return project ? ui.dim(` (${project})`) : ui.dim(" (global)");
}

/** One-line scope banner for the top of a list, or "" for the all-scope. */
export function scopeBanner(scope: ProjectScope): string {
  if (scope.kind === "all") return "";
  return `${ui.dim("Project scope:")} ${ui.bold(scope.id)} ${ui.dim("(+ global)")}`;
}
