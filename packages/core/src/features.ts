import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateFeatureFrontMatter, formatIssues } from "./validation.js";
import { loadReposConfig } from "./repos.js";
import { loadSourcesConfig } from "./sources.js";
import { WorkspaceValidationError } from "./workspace.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type {
  Feature,
  FeatureCodeRef,
  FeatureDocRef,
  FeatureFrontMatter,
  FeatureStatus,
  ValidationIssue,
} from "./types.js";

/**
 * Feature map: one markdown file per feature under
 * `.planning/features/<id>.md`. Each file has a YAML front-matter
 * block holding structured fields (id, name, status, codeRefs,
 * docRefs, timestamps) and a free-form prose body below where the
 * user describes states, journeys, edge cases.
 *
 * Why one file per feature (vs. a single index)?
 *   - Markdown bodies stay diff-friendly when edited by humans or
 *     agents.
 *   - The set of features in a healthy product is small enough that
 *     directory listing is fine.
 *   - Each feature can be referenced by path in specs and prompts.
 */

// ============================================================
// Errors
// ============================================================

export class FeatureNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No feature with id "${id}".`);
    this.name = "FeatureNotFoundError";
  }
}

export class FeatureAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A feature with id "${id}" already exists.`);
    this.name = "FeatureAlreadyExistsError";
  }
}

export class FeatureFileError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly detail: string
  ) {
    super(`Invalid feature file at ${filePath}:\n${detail}`);
    this.name = "FeatureFileError";
  }
}

// ============================================================
// Front-matter parse/serialize
// ============================================================

/**
 * Parse a feature file's text into a {@link Feature}. Throws
 * {@link FeatureFileError} when the front-matter is missing or invalid.
 *
 * `filePath` is used only for error messages — the function itself is
 * pure with respect to the filesystem.
 */
export function parseFeatureFile(text: string, filePath: string): Feature {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new FeatureFileError(
      filePath,
      "missing YAML front-matter (file must start with `---` on its first line)"
    );
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new FeatureFileError(
      filePath,
      `YAML parse error: ${(err as Error).message}`
    );
  }
  const result = validateFeatureFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new FeatureFileError(filePath, formatIssues(result.issues));
  }
  return { ...result.value, body: split.body };
}

/**
 * Serialize a {@link Feature} back to file text with front-matter +
 * markdown body. Omits absent optional fields and empty ref arrays.
 */
export function serializeFeatureFile(feature: Feature): string {
  const fm: Record<string, unknown> = {
    id: feature.id,
    name: feature.name,
  };
  if (feature.description !== undefined && feature.description !== "") {
    fm.description = feature.description;
  }
  fm.status = feature.status;
  if (feature.codeRefs.length > 0) fm.codeRefs = feature.codeRefs;
  if (feature.docRefs.length > 0) fm.docRefs = feature.docRefs;
  fm.createdAt = feature.createdAt;
  fm.updatedAt = feature.updatedAt;
  return buildFrontMatterFile(fm, feature.body);
}

// ============================================================
// Slug derivation
// ============================================================

/**
 * Derive a slug-style feature id from a human name. Same scheme as
 * sources.ts so the look-and-feel is consistent across artifacts.
 */
export function deriveFeatureId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug;
}

// ============================================================
// Disk operations
// ============================================================

function featureFilePath(workspaceRoot: string, id: string): string {
  return path.join(workspacePaths(workspaceRoot).features, `${id}.md`);
}

async function ensureFeaturesDir(workspaceRoot: string): Promise<string> {
  const dir = workspacePaths(workspaceRoot).features;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export interface AddFeatureOptions {
  /** Display name. Required. */
  name: string;
  /** Stable id. Auto-derived from `name` when omitted. */
  id?: string;
  /** Initial status. Defaults to "planned". */
  status?: FeatureStatus;
  /** One-line summary stored in front-matter. */
  description?: string;
  /** Code references — repos must exist in repos.yaml. */
  codeRefs?: FeatureCodeRef[];
  /** Doc references — sources must exist in sources.yaml. */
  docRefs?: FeatureDocRef[];
  /** Initial markdown body. Defaults to a stub heading. */
  body?: string;
  /**
   * If true, skip the check that code-ref repos and doc-ref sources
   * are registered. Useful for tests and for bulk-import flows that
   * register dependencies in a different order.
   */
  skipReferenceValidation?: boolean;
}

/**
 * Cross-check ref pointers against the repo and source registries.
 *
 * Why: a feature whose `codeRefs[].repo` doesn't match any registered
 * repo is silently useless — Atelier can't navigate to it during a
 * spec session. We surface that at write time so the user can fix it
 * immediately.
 */
async function validateFeatureReferences(
  workspaceRoot: string,
  codeRefs: FeatureCodeRef[],
  docRefs: FeatureDocRef[]
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (codeRefs.length > 0) {
    const repoCfg = await loadReposConfig(workspaceRoot);
    const known = new Set(repoCfg.repos.map((r) => r.name));
    codeRefs.forEach((ref, idx) => {
      if (!known.has(ref.repo)) {
        issues.push({
          path: `codeRefs[${idx}].repo`,
          message: `repo "${ref.repo}" is not registered (run \`atelier repo list\` to see registered repos)`,
        });
      }
    });
  }
  if (docRefs.length > 0) {
    const sourceCfg = await loadSourcesConfig(workspaceRoot);
    const known = new Set(sourceCfg.sources.map((s) => s.id));
    docRefs.forEach((ref, idx) => {
      if (!known.has(ref.source)) {
        issues.push({
          path: `docRefs[${idx}].source`,
          message: `source "${ref.source}" is not registered`,
        });
      }
    });
  }
  return issues;
}

export class FeatureReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Feature references invalid:\n${formatIssues(issues)}`);
    this.name = "FeatureReferenceValidationError";
  }
}

/**
 * Create a new feature file. Refuses duplicates and validates
 * cross-references against the repo and source registries unless
 * `skipReferenceValidation` is set.
 */
export async function addFeature(
  workspaceRoot: string,
  opts: AddFeatureOptions
): Promise<Feature> {
  if (!opts.name || opts.name.trim().length === 0) {
    throw new Error("Feature name is required.");
  }

  const id = opts.id ?? deriveFeatureId(opts.name);
  if (!id) {
    throw new Error(
      `Could not derive a slug id from name "${opts.name}". Pass --id explicitly.`
    );
  }

  await ensureFeaturesDir(workspaceRoot);

  const filePath = featureFilePath(workspaceRoot, id);
  try {
    await fs.access(filePath);
    throw new FeatureAlreadyExistsError(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // FeatureAlreadyExistsError or another fs error — rethrow.
      throw err;
    }
  }

  const codeRefs = opts.codeRefs ?? [];
  const docRefs = opts.docRefs ?? [];

  if (!opts.skipReferenceValidation) {
    const issues = await validateFeatureReferences(workspaceRoot, codeRefs, docRefs);
    if (issues.length > 0) throw new FeatureReferenceValidationError(issues);
  }

  const now = new Date().toISOString();
  const feature: Feature = {
    id,
    name: opts.name,
    description: opts.description,
    status: opts.status ?? "planned",
    codeRefs,
    docRefs,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? `# ${opts.name}\n\nDescribe the feature here.\n`,
  };

  // Validate the whole front-matter once more to catch malformed
  // caller input early (e.g. an unrecognized status).
  const fmCheck = validateFeatureFrontMatter(toFrontMatter(feature));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(filePath, formatIssues(fmCheck.issues));
  }

  await fs.writeFile(filePath, serializeFeatureFile(feature), "utf8");
  return feature;
}

function toFrontMatter(feature: Feature): FeatureFrontMatter {
  return {
    id: feature.id,
    name: feature.name,
    description: feature.description,
    status: feature.status,
    codeRefs: feature.codeRefs,
    docRefs: feature.docRefs,
    createdAt: feature.createdAt,
    updatedAt: feature.updatedAt,
  };
}

/** Load a single feature by id. Throws if missing. */
export async function loadFeature(
  workspaceRoot: string,
  id: string
): Promise<Feature> {
  const filePath = featureFilePath(workspaceRoot, id);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FeatureNotFoundError(id);
    }
    throw err;
  }
  return parseFeatureFile(text, filePath);
}

export interface FeatureListing {
  feature: Feature;
  /** Absolute path to the feature file on disk. */
  filePath: string;
}

/**
 * List all features in the workspace. Files that fail to parse are
 * returned in `errors` rather than thrown — so a single broken file
 * doesn't block listing the rest.
 */
export async function listFeatures(workspaceRoot: string): Promise<{
  features: FeatureListing[];
  errors: { filePath: string; error: Error }[];
}> {
  const dir = workspacePaths(workspaceRoot).features;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { features: [], errors: [] };
    }
    throw err;
  }

  const features: FeatureListing[] = [];
  const errors: { filePath: string; error: Error }[] = [];
  // Sort for deterministic listing.
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  for (const name of mdFiles) {
    const filePath = path.join(dir, name);
    try {
      const text = await fs.readFile(filePath, "utf8");
      features.push({ feature: parseFeatureFile(text, filePath), filePath });
    } catch (err) {
      errors.push({ filePath, error: err as Error });
    }
  }
  return { features, errors };
}

/** Remove a feature by id. Returns the loaded entry that was removed. */
export async function removeFeature(
  workspaceRoot: string,
  id: string
): Promise<Feature> {
  const feature = await loadFeature(workspaceRoot, id);
  await fs.unlink(featureFilePath(workspaceRoot, id));
  return feature;
}
