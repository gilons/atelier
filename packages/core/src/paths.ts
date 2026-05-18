import * as path from "node:path";

/**
 * Canonical paths inside an Atelier workspace.
 *
 * Centralized here so command code never hard-codes filenames.
 * If a path convention changes later, this file is the single
 * point of edit.
 *
 * Note on naming: this directory was `.planning/` in v0. Switched
 * to `.atelier/` so workspace state lines up with the product
 * brand instead of describing the activity. `findWorkspaceRoot`
 * still recognises the old name on disk (compat shim) so existing
 * workspaces keep loading; new ones always init the new name.
 */

/**
 * Canonical workspace directory name. Atelier creates and looks
 * for this directory; everything else lives under it.
 */
export const ATELIER_DIR = ".atelier";
/**
 * Pre-rename name. Recognised by {@link findWorkspaceRoot} so
 * users coming from v0 don't have to manually migrate their
 * `.planning/` directory before commands start working — they
 * can `mv .planning .atelier` whenever it's convenient. New code
 * never writes this name.
 */
export const LEGACY_PLANNING_DIR = ".planning";

export interface WorkspacePaths {
  /** Absolute path to the workspace root (parent of `.atelier/`). */
  root: string;
  /** Absolute path to the `.atelier/` directory itself. */
  atelier: string;
  /** `.atelier/workspace.yaml` */
  workspaceConfig: string;
  /** `.atelier/sources.yaml` */
  sourcesConfig: string;
  /** `.atelier/repos.yaml` */
  reposConfig: string;
  /** `.atelier/features/` — feature map entries */
  features: string;
  /** `.atelier/docs/` — doc map entries (nested by source id) */
  docs: string;
  /** `.atelier/discrepancies.yaml` — running discrepancy log */
  discrepanciesLog: string;
  /** `.atelier/issues/` — issue folders */
  issues: string;
  /** `.atelier/ui/` — UI map (page graphs, page descriptions) */
  ui: string;
  /** `.atelier/cache/` — gitignored local cache */
  cache: string;
  /** `.atelier/README.md` — human entry-point */
  readme: string;
}

/**
 * Compute all canonical paths for a workspace rooted at the given
 * directory. When the workspace was init'd before the rename, the
 * directory on disk is `.planning/` — pass `legacy: true` to point
 * at that instead of `.atelier/`. (Default is `.atelier/` which is
 * the current name for every new workspace.)
 */
export function workspacePaths(
  root: string,
  opts: { legacy?: boolean } = {}
): WorkspacePaths {
  const dirName = opts.legacy ? LEGACY_PLANNING_DIR : ATELIER_DIR;
  const atelier = path.join(root, dirName);
  return {
    root,
    atelier,
    workspaceConfig: path.join(atelier, "workspace.yaml"),
    sourcesConfig: path.join(atelier, "sources.yaml"),
    reposConfig: path.join(atelier, "repos.yaml"),
    features: path.join(atelier, "features"),
    docs: path.join(atelier, "docs"),
    discrepanciesLog: path.join(atelier, "discrepancies.yaml"),
    issues: path.join(atelier, "issues"),
    ui: path.join(atelier, "ui"),
    cache: path.join(atelier, "cache"),
    readme: path.join(atelier, "README.md"),
  };
}
