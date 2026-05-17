import * as path from "node:path";

/**
 * Canonical paths inside a planning workspace.
 *
 * Centralized here so command code never hard-codes filenames.
 * If a path convention changes later, this file is the single
 * point of edit.
 */

/** The root directory name for Atelier's artifacts inside a workspace. */
export const PLANNING_DIR = ".planning";

export interface WorkspacePaths {
  /** Absolute path to the planning workspace root (parent of .planning/). */
  root: string;
  /** Absolute path to the .planning/ directory itself. */
  planning: string;
  /** `.planning/workspace.yaml` */
  workspaceConfig: string;
  /** `.planning/sources.yaml` */
  sourcesConfig: string;
  /** `.planning/repos.yaml` */
  reposConfig: string;
  /** `.planning/features/` — feature map entries */
  features: string;
  /** `.planning/docs/` — doc map entries (nested by source id) */
  docs: string;
  /** `.planning/discrepancies.yaml` — running discrepancy log */
  discrepanciesLog: string;
  /** `.planning/issues/` — issue folders */
  issues: string;
  /** `.planning/ui/` — UI map (page graphs, page descriptions) */
  ui: string;
  /** `.planning/cache/` — gitignored local cache */
  cache: string;
  /** `.planning/README.md` — human entry-point */
  readme: string;
}

/**
 * Compute all canonical paths for a workspace rooted at the given directory.
 */
export function workspacePaths(root: string): WorkspacePaths {
  const planning = path.join(root, PLANNING_DIR);
  return {
    root,
    planning,
    workspaceConfig: path.join(planning, "workspace.yaml"),
    sourcesConfig: path.join(planning, "sources.yaml"),
    reposConfig: path.join(planning, "repos.yaml"),
    features: path.join(planning, "features"),
    docs: path.join(planning, "docs"),
    discrepanciesLog: path.join(planning, "discrepancies.yaml"),
    issues: path.join(planning, "issues"),
    ui: path.join(planning, "ui"),
    cache: path.join(planning, "cache"),
    readme: path.join(planning, "README.md"),
  };
}
