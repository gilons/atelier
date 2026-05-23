import type {
  Source,
  SourceCategory,
  SourcesConfig,
  RegisteredRepo,
  ReposConfig,
  WorkspaceConfig,
  FeatureFrontMatter,
  FeatureStatus,
  FeatureCodeRef,
  FeatureItemRef,
  ItemFrontMatter,
  Discrepancy,
  DiscrepancyLog,
  DiscrepancySeverity,
  DiscrepancyStatus,
  DiscrepancyDocRef,
  DiscrepancyCodeRef,
  SpecManifest,
  SpecChangeType,
  SpecStatus,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

/**
 * Hand-rolled validators for the core config files.
 *
 * Why not a runtime schema library (zod, ajv)?
 *   - Zero external dependencies for the deterministic layer.
 *   - The configs are small and stable; the cost of maintaining
 *     these validators is lower than the cost of an extra dep.
 *   - Error messages can be tuned for Atelier's conventions.
 *
 * Each validator returns a `ValidationResult<T>` rather than throwing,
 * so command code can render rich error reports instead of stack traces.
 */

// ============================================================
// Small helpers
// ============================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function pushIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

// ============================================================
// Source / SourcesConfig
// ============================================================

function validateSource(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): Source | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }

  const { id, name, category, config, setupFile, enabled } = raw;
  let valid = true;

  if (!isNonEmptyString(id)) {
    pushIssue(issues, `${basePath}.id`, "must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(name)) {
    pushIssue(issues, `${basePath}.name`, "must be a non-empty string");
    valid = false;
  }
  const validCategory =
    typeof category === "string" &&
    (category === "docs" || category === "design" || category === "pm");
  if (!validCategory) {
    pushIssue(
      issues,
      `${basePath}.category`,
      'must be one of: "docs", "design", "pm"'
    );
    valid = false;
  }
  if (config !== undefined && !isObject(config)) {
    pushIssue(
      issues,
      `${basePath}.config`,
      "if present, must be an object (free-form key/value blob used by the agent)"
    );
    valid = false;
  }
  if (setupFile !== undefined && !isNonEmptyString(setupFile)) {
    pushIssue(
      issues,
      `${basePath}.setupFile`,
      "if present, must be a non-empty string (workspace-relative path)"
    );
    valid = false;
  }
  if (typeof enabled !== "boolean") {
    pushIssue(issues, `${basePath}.enabled`, "must be a boolean");
    valid = false;
  }

  if (!valid) return null;
  const result: Source = {
    id: id as string,
    name: name as string,
    category: category as SourceCategory,
    enabled: enabled as boolean,
  };
  if (config !== undefined) result.config = config as Record<string, unknown>;
  if (setupFile !== undefined) result.setupFile = setupFile as string;
  return result;
}

export function validateSourcesConfig(raw: unknown): ValidationResult<SourcesConfig> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "expected an object at the top level" }] };
  }
  // The schema bumped from 1 → 2 when the adapter model went away.
  // Old version-1 files (with kind/transport/credentials) can be
  // hand-migrated; the validator refuses them so the user sees a
  // clear error rather than silently dropping fields.
  if (raw.version !== 3) {
    pushIssue(
      issues,
      "$.version",
      "must be the integer 3 (atelier dropped the kind/transport/credentials model in v2; old files need to be re-registered)"
    );
  }
  if (!Array.isArray(raw.sources)) {
    pushIssue(issues, "$.sources", "must be an array (may be empty)");
    return { ok: false, issues };
  }

  const ids = new Set<string>();
  const sources: Source[] = [];
  raw.sources.forEach((entry, idx) => {
    const src = validateSource(entry, `$.sources[${idx}]`, issues);
    if (src) {
      if (ids.has(src.id)) {
        pushIssue(issues, `$.sources[${idx}].id`, `duplicate id "${src.id}"`);
      } else {
        ids.add(src.id);
        sources.push(src);
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { version: 3, sources }, issues: [] };
}

// ============================================================
// RegisteredRepo / ReposConfig
// ============================================================

function validateRepo(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): RegisteredRepo | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }

  const { name, remote, localPath, description, enabled } = raw;
  let valid = true;

  if (!isNonEmptyString(name)) {
    pushIssue(issues, `${basePath}.name`, "must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(remote)) {
    pushIssue(issues, `${basePath}.remote`, "must be a non-empty string");
    valid = false;
  }
  if (localPath !== undefined && !isNonEmptyString(localPath)) {
    pushIssue(issues, `${basePath}.localPath`, "if present, must be a non-empty string");
    valid = false;
  }
  if (description !== undefined && typeof description !== "string") {
    pushIssue(issues, `${basePath}.description`, "if present, must be a string");
    valid = false;
  }
  if (typeof enabled !== "boolean") {
    pushIssue(issues, `${basePath}.enabled`, "must be a boolean");
    valid = false;
  }

  if (!valid) return null;
  return {
    name: name as string,
    remote: remote as string,
    localPath: localPath as string | undefined,
    description: description as string | undefined,
    enabled: enabled as boolean,
  };
}

export function validateReposConfig(raw: unknown): ValidationResult<ReposConfig> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "expected an object at the top level" }] };
  }
  if (raw.version !== 1) {
    pushIssue(issues, "$.version", "must be the integer 1");
  }
  if (raw.organization !== undefined && !isNonEmptyString(raw.organization)) {
    pushIssue(issues, "$.organization", "if present, must be a non-empty string");
  }
  if (!Array.isArray(raw.repos)) {
    pushIssue(issues, "$.repos", "must be an array (may be empty)");
    return { ok: false, issues };
  }

  const remotes = new Set<string>();
  const repos: RegisteredRepo[] = [];
  raw.repos.forEach((entry, idx) => {
    const repo = validateRepo(entry, `$.repos[${idx}]`, issues);
    if (repo) {
      if (remotes.has(repo.remote)) {
        pushIssue(issues, `$.repos[${idx}].remote`, `duplicate remote "${repo.remote}"`);
      } else {
        remotes.add(repo.remote);
        repos.push(repo);
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: 1,
      organization: raw.organization as string | undefined,
      repos,
    },
    issues: [],
  };
}

// ============================================================
// WorkspaceConfig
// ============================================================

export function validateWorkspaceConfig(raw: unknown): ValidationResult<WorkspaceConfig> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "expected an object at the top level" }] };
  }
  if (raw.version !== 1) {
    pushIssue(issues, "$.version", "must be the integer 1");
  }
  if (!isNonEmptyString(raw.name)) {
    pushIssue(issues, "$.name", "must be a non-empty string");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    pushIssue(issues, "$.description", "if present, must be a string");
  }
  if (!isNonEmptyString(raw.createdAt)) {
    pushIssue(issues, "$.createdAt", "must be a non-empty ISO timestamp string");
  }
  if (!isNonEmptyString(raw.atelierVersion)) {
    pushIssue(issues, "$.atelierVersion", "must be a non-empty string");
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: 1,
      name: raw.name as string,
      description: raw.description as string | undefined,
      createdAt: raw.createdAt as string,
      atelierVersion: raw.atelierVersion as string,
    },
    issues: [],
  };
}

// ============================================================
// Feature front-matter
// ============================================================

const VALID_FEATURE_STATUSES: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>([
  "planned",
  "in-progress",
  "shipped",
  "deprecated",
]);

/**
 * Slug pattern shared with addFeature's auto-derivation. Single
 * character is fine (`/^[a-z0-9]$/`); longer ids must start and end
 * with an alphanumeric and may contain hyphens in between.
 */
const FEATURE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateCodeRef(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): FeatureCodeRef | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }
  const { repo, path: refPath } = raw;
  let valid = true;
  if (!isNonEmptyString(repo)) {
    pushIssue(issues, `${basePath}.repo`, "must be a non-empty string");
    valid = false;
  }
  if (refPath !== undefined && !isNonEmptyString(refPath)) {
    pushIssue(issues, `${basePath}.path`, "if present, must be a non-empty string");
    valid = false;
  }
  if (!valid) return null;
  const result: FeatureCodeRef = { repo: repo as string };
  if (refPath !== undefined) result.path = refPath as string;
  return result;
}

function validateDocRef(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): FeatureItemRef | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }
  const { source, docId, title } = raw;
  let valid = true;
  if (!isNonEmptyString(source)) {
    pushIssue(issues, `${basePath}.source`, "must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(docId)) {
    pushIssue(issues, `${basePath}.docId`, "must be a non-empty string");
    valid = false;
  }
  if (title !== undefined && typeof title !== "string") {
    pushIssue(issues, `${basePath}.title`, "if present, must be a string");
    valid = false;
  }
  if (!valid) return null;
  const result: FeatureItemRef = {
    source: source as string,
    docId: docId as string,
  };
  if (title !== undefined) result.title = title as string;
  return result;
}

/**
 * Validate the front-matter of a feature file. The free-form body
 * below the front-matter is not parsed or validated.
 */
export function validateFeatureFrontMatter(
  raw: unknown
): ValidationResult<FeatureFrontMatter> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "expected an object at the top level" }],
    };
  }

  const { id, name, description, status, codeRefs, docRefs, createdAt, updatedAt } = raw;

  if (!isNonEmptyString(id)) {
    pushIssue(issues, "$.id", "must be a non-empty string");
  } else if (!FEATURE_ID_PATTERN.test(id)) {
    pushIssue(
      issues,
      "$.id",
      "must be a slug (lowercase letters, digits, and hyphens; starting with a letter or digit)"
    );
  }
  if (!isNonEmptyString(name)) {
    pushIssue(issues, "$.name", "must be a non-empty string");
  }
  if (description !== undefined && typeof description !== "string") {
    pushIssue(issues, "$.description", "if present, must be a string");
  }
  if (typeof status !== "string" || !VALID_FEATURE_STATUSES.has(status as FeatureStatus)) {
    pushIssue(
      issues,
      "$.status",
      `must be one of: ${[...VALID_FEATURE_STATUSES].join(", ")}`
    );
  }
  if (!isNonEmptyString(createdAt)) {
    pushIssue(issues, "$.createdAt", "must be a non-empty ISO timestamp string");
  }
  if (!isNonEmptyString(updatedAt)) {
    pushIssue(issues, "$.updatedAt", "must be a non-empty ISO timestamp string");
  }

  // codeRefs and docRefs are arrays (may be empty).
  const codeRefsArr: FeatureCodeRef[] = [];
  if (codeRefs === undefined) {
    // Tolerate absent — treat as empty.
  } else if (!Array.isArray(codeRefs)) {
    pushIssue(issues, "$.codeRefs", "must be an array (may be empty)");
  } else {
    codeRefs.forEach((entry, idx) => {
      const ref = validateCodeRef(entry, `$.codeRefs[${idx}]`, issues);
      if (ref) codeRefsArr.push(ref);
    });
  }

  const docRefsArr: FeatureItemRef[] = [];
  if (docRefs === undefined) {
    // Tolerate absent — treat as empty.
  } else if (!Array.isArray(docRefs)) {
    pushIssue(issues, "$.docRefs", "must be an array (may be empty)");
  } else {
    docRefs.forEach((entry, idx) => {
      const ref = validateDocRef(entry, `$.docRefs[${idx}]`, issues);
      if (ref) docRefsArr.push(ref);
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  const value: FeatureFrontMatter = {
    id: id as string,
    name: name as string,
    status: status as FeatureStatus,
    codeRefs: codeRefsArr,
    docRefs: docRefsArr,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
  if (description !== undefined) value.description = description as string;
  return { ok: true, value, issues: [] };
}

// ============================================================
// Item front-matter
// ============================================================

export function validateDocEntryFrontMatter(
  raw: unknown
): ValidationResult<ItemFrontMatter> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "expected an object at the top level" }],
    };
  }
  const {
    source,
    docId,
    title,
    overview,
    classification,
    link,
    parent,
    createdAt,
    updatedAt,
  } = raw;

  if (!isNonEmptyString(source)) {
    pushIssue(issues, "$.source", "must be a non-empty string");
  }
  if (!isNonEmptyString(docId)) {
    pushIssue(issues, "$.docId", "must be a non-empty string");
  }
  if (!isNonEmptyString(title)) {
    pushIssue(issues, "$.title", "must be a non-empty string");
  }
  if (overview !== undefined && typeof overview !== "string") {
    pushIssue(issues, "$.overview", "if present, must be a string");
  }
  // Classification is free-form text now (a PM ticket isn't a doc
  // PRD); the vocabulary depends on the source's category and we
  // don't enforce it.
  if (classification !== undefined && typeof classification !== "string") {
    pushIssue(issues, "$.classification", "if present, must be a string");
  }
  if (link !== undefined && !isNonEmptyString(link)) {
    pushIssue(issues, "$.link", "if present, must be a non-empty string");
  }
  if (parent !== undefined && !isNonEmptyString(parent)) {
    pushIssue(issues, "$.parent", "if present, must be a non-empty string (itemId of the parent item in the same source)");
  }
  if (!isNonEmptyString(createdAt)) {
    pushIssue(issues, "$.createdAt", "must be a non-empty ISO timestamp string");
  }
  if (!isNonEmptyString(updatedAt)) {
    pushIssue(issues, "$.updatedAt", "must be a non-empty ISO timestamp string");
  }

  if (issues.length > 0) return { ok: false, issues };
  const value: ItemFrontMatter = {
    source: source as string,
    docId: docId as string,
    title: title as string,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
  if (overview !== undefined) value.overview = overview as string;
  if (classification !== undefined) value.classification = classification as string;
  if (link !== undefined) value.link = link as string;
  if (parent !== undefined) value.parent = parent as string;
  return { ok: true, value, issues: [] };
}

// ============================================================
// Discrepancy log
// ============================================================

const VALID_DISCREPANCY_SEVERITIES: ReadonlySet<DiscrepancySeverity> =
  new Set<DiscrepancySeverity>(["low", "medium", "high", "critical"]);

const VALID_DISCREPANCY_STATUSES: ReadonlySet<DiscrepancyStatus> =
  new Set<DiscrepancyStatus>(["open", "acknowledged", "resolved", "wontfix"]);

const DISCREPANCY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateDiscrepancyDocRef(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): DiscrepancyDocRef | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }
  const { source, docId } = raw;
  let valid = true;
  if (!isNonEmptyString(source)) {
    pushIssue(issues, `${basePath}.source`, "must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(docId)) {
    pushIssue(issues, `${basePath}.docId`, "must be a non-empty string");
    valid = false;
  }
  if (!valid) return null;
  return { source: source as string, docId: docId as string };
}

function validateDiscrepancyCodeRef(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): DiscrepancyCodeRef | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }
  const { repo, path: refPath } = raw;
  let valid = true;
  if (!isNonEmptyString(repo)) {
    pushIssue(issues, `${basePath}.repo`, "must be a non-empty string");
    valid = false;
  }
  if (refPath !== undefined && !isNonEmptyString(refPath)) {
    pushIssue(issues, `${basePath}.path`, "if present, must be a non-empty string");
    valid = false;
  }
  if (!valid) return null;
  const result: DiscrepancyCodeRef = { repo: repo as string };
  if (refPath !== undefined) result.path = refPath as string;
  return result;
}

function validateDiscrepancy(
  raw: unknown,
  basePath: string,
  issues: ValidationIssue[]
): Discrepancy | null {
  if (!isObject(raw)) {
    pushIssue(issues, basePath, "expected an object");
    return null;
  }
  const {
    id,
    feature,
    claim,
    observed,
    severity,
    status,
    docRef,
    codeRef,
    notes,
    createdAt,
    updatedAt,
  } = raw;
  let valid = true;

  if (!isNonEmptyString(id)) {
    pushIssue(issues, `${basePath}.id`, "must be a non-empty string");
    valid = false;
  } else if (!DISCREPANCY_ID_PATTERN.test(id)) {
    pushIssue(
      issues,
      `${basePath}.id`,
      "must be a slug (lowercase letters, digits, and hyphens)"
    );
    valid = false;
  }
  if (feature !== undefined && !isNonEmptyString(feature)) {
    pushIssue(issues, `${basePath}.feature`, "if present, must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(claim)) {
    pushIssue(issues, `${basePath}.claim`, "must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyString(observed)) {
    pushIssue(issues, `${basePath}.observed`, "must be a non-empty string");
    valid = false;
  }
  if (
    typeof severity !== "string" ||
    !VALID_DISCREPANCY_SEVERITIES.has(severity as DiscrepancySeverity)
  ) {
    pushIssue(
      issues,
      `${basePath}.severity`,
      `must be one of: ${[...VALID_DISCREPANCY_SEVERITIES].join(", ")}`
    );
    valid = false;
  }
  if (
    typeof status !== "string" ||
    !VALID_DISCREPANCY_STATUSES.has(status as DiscrepancyStatus)
  ) {
    pushIssue(
      issues,
      `${basePath}.status`,
      `must be one of: ${[...VALID_DISCREPANCY_STATUSES].join(", ")}`
    );
    valid = false;
  }
  if (notes !== undefined && typeof notes !== "string") {
    pushIssue(issues, `${basePath}.notes`, "if present, must be a string");
    valid = false;
  }
  if (!isNonEmptyString(createdAt)) {
    pushIssue(issues, `${basePath}.createdAt`, "must be a non-empty ISO timestamp string");
    valid = false;
  }
  if (!isNonEmptyString(updatedAt)) {
    pushIssue(issues, `${basePath}.updatedAt`, "must be a non-empty ISO timestamp string");
    valid = false;
  }

  let parsedDocRef: DiscrepancyDocRef | undefined;
  if (docRef !== undefined) {
    const parsed = validateDiscrepancyDocRef(docRef, `${basePath}.docRef`, issues);
    if (parsed) parsedDocRef = parsed;
    else valid = false;
  }
  let parsedCodeRef: DiscrepancyCodeRef | undefined;
  if (codeRef !== undefined) {
    const parsed = validateDiscrepancyCodeRef(codeRef, `${basePath}.codeRef`, issues);
    if (parsed) parsedCodeRef = parsed;
    else valid = false;
  }

  if (!valid) return null;
  const result: Discrepancy = {
    id: id as string,
    claim: claim as string,
    observed: observed as string,
    severity: severity as DiscrepancySeverity,
    status: status as DiscrepancyStatus,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
  if (feature !== undefined) result.feature = feature as string;
  if (parsedDocRef) result.docRef = parsedDocRef;
  if (parsedCodeRef) result.codeRef = parsedCodeRef;
  if (notes !== undefined) result.notes = notes as string;
  return result;
}

export function validateDiscrepancyLog(
  raw: unknown
): ValidationResult<DiscrepancyLog> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "expected an object at the top level" }],
    };
  }
  if (raw.version !== 1) {
    pushIssue(issues, "$.version", "must be the integer 1");
  }
  if (!Array.isArray(raw.discrepancies)) {
    pushIssue(issues, "$.discrepancies", "must be an array (may be empty)");
    return { ok: false, issues };
  }

  const ids = new Set<string>();
  const discrepancies: Discrepancy[] = [];
  raw.discrepancies.forEach((entry, idx) => {
    const d = validateDiscrepancy(entry, `$.discrepancies[${idx}]`, issues);
    if (d) {
      if (ids.has(d.id)) {
        pushIssue(issues, `$.discrepancies[${idx}].id`, `duplicate id "${d.id}"`);
      } else {
        ids.add(d.id);
        discrepancies.push(d);
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { version: 1, discrepancies },
    issues: [],
  };
}

// ============================================================
// Spec manifest
// ============================================================

const VALID_SPEC_CHANGE_TYPES: ReadonlySet<SpecChangeType> = new Set<SpecChangeType>([
  "new-feature",
  "modification",
  "ui",
  "refactor",
  "bug",
  "integration",
]);
const VALID_SPEC_STATUSES: ReadonlySet<SpecStatus> = new Set<SpecStatus>([
  "drafting",
  "ready",
  "in-progress",
  "completed",
  "abandoned",
]);

const SPEC_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function validateSpecManifest(
  raw: unknown
): ValidationResult<SpecManifest> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "expected an object at the top level" }],
    };
  }
  const {
    id,
    title,
    type,
    status,
    features,
    codeRefs,
    docRefs,
    createdAt,
    updatedAt,
  } = raw;

  if (!isNonEmptyString(id)) {
    pushIssue(issues, "$.id", "must be a non-empty string");
  } else if (!SPEC_ID_PATTERN.test(id)) {
    pushIssue(
      issues,
      "$.id",
      "must be of the form YYYY-MM-DD-<slug> (e.g. 2026-05-16-csv-export)"
    );
  }
  if (!isNonEmptyString(title)) {
    pushIssue(issues, "$.title", "must be a non-empty string");
  }
  if (typeof type !== "string" || !VALID_SPEC_CHANGE_TYPES.has(type as SpecChangeType)) {
    pushIssue(
      issues,
      "$.type",
      `must be one of: ${[...VALID_SPEC_CHANGE_TYPES].join(", ")}`
    );
  }
  if (typeof status !== "string" || !VALID_SPEC_STATUSES.has(status as SpecStatus)) {
    pushIssue(
      issues,
      "$.status",
      `must be one of: ${[...VALID_SPEC_STATUSES].join(", ")}`
    );
  }
  if (!isNonEmptyString(createdAt)) {
    pushIssue(issues, "$.createdAt", "must be a non-empty ISO timestamp string");
  }
  if (!isNonEmptyString(updatedAt)) {
    pushIssue(issues, "$.updatedAt", "must be a non-empty ISO timestamp string");
  }

  const featuresArr: string[] = [];
  if (features === undefined) {
    /* treat as empty */
  } else if (!Array.isArray(features)) {
    pushIssue(issues, "$.features", "must be an array of strings");
  } else {
    features.forEach((f, idx) => {
      if (!isNonEmptyString(f)) {
        pushIssue(issues, `$.features[${idx}]`, "must be a non-empty string");
      } else {
        featuresArr.push(f);
      }
    });
  }

  // Reuse feature ref shape — codeRefs/docRefs are the same structure.
  const codeRefsArr: SpecManifest["codeRefs"] = [];
  if (codeRefs === undefined) {
    /* treat as empty */
  } else if (!Array.isArray(codeRefs)) {
    pushIssue(issues, "$.codeRefs", "must be an array");
  } else {
    codeRefs.forEach((entry, idx) => {
      if (!isObject(entry)) {
        pushIssue(issues, `$.codeRefs[${idx}]`, "must be an object");
        return;
      }
      const { repo, path: refPath } = entry;
      if (!isNonEmptyString(repo)) {
        pushIssue(issues, `$.codeRefs[${idx}].repo`, "must be a non-empty string");
        return;
      }
      if (refPath !== undefined && !isNonEmptyString(refPath)) {
        pushIssue(issues, `$.codeRefs[${idx}].path`, "if present, must be a non-empty string");
        return;
      }
      const ref: SpecManifest["codeRefs"][number] = { repo: repo as string };
      if (refPath !== undefined) ref.path = refPath as string;
      codeRefsArr.push(ref);
    });
  }

  const docRefsArr: SpecManifest["docRefs"] = [];
  if (docRefs === undefined) {
    /* treat as empty */
  } else if (!Array.isArray(docRefs)) {
    pushIssue(issues, "$.docRefs", "must be an array");
  } else {
    docRefs.forEach((entry, idx) => {
      if (!isObject(entry)) {
        pushIssue(issues, `$.docRefs[${idx}]`, "must be an object");
        return;
      }
      const { source, docId, title: refTitle } = entry;
      if (!isNonEmptyString(source)) {
        pushIssue(issues, `$.docRefs[${idx}].source`, "must be a non-empty string");
        return;
      }
      if (!isNonEmptyString(docId)) {
        pushIssue(issues, `$.docRefs[${idx}].docId`, "must be a non-empty string");
        return;
      }
      if (refTitle !== undefined && typeof refTitle !== "string") {
        pushIssue(issues, `$.docRefs[${idx}].title`, "if present, must be a string");
        return;
      }
      const ref: SpecManifest["docRefs"][number] = {
        source: source as string,
        docId: docId as string,
      };
      if (refTitle !== undefined) ref.title = refTitle as string;
      docRefsArr.push(ref);
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      id: id as string,
      title: title as string,
      type: type as SpecChangeType,
      status: status as SpecStatus,
      features: featuresArr,
      codeRefs: codeRefsArr,
      docRefs: docRefsArr,
      createdAt: createdAt as string,
      updatedAt: updatedAt as string,
    },
    issues: [],
  };
}

/** Format validation issues into a multi-line human-readable string. */
export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "";
  return issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
}
