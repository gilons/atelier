/**
 * Core domain types for Atelier.
 *
 * These describe the persistent artifacts that live in `.planning/`
 * and the in-memory representations of the configured workspace.
 *
 * Convention: every artifact is markdown or YAML, version-controlled
 * in the planning repo. Cache contents live separately under
 * `.planning/cache/` and are gitignored.
 */

// ============================================================
// Source connections (where the agent fetches documents from)
// ============================================================

/**
 * A configured documentation source.
 *
 * Atelier doesn't talk to source systems directly — the user's
 * agent does (via MCP servers, browser extensions, whatever
 * integrations are already wired up). A "source" in atelier's
 * model is just:
 *
 *   - A stable identifier the agent uses when adding documents.
 *   - A human-readable name.
 *   - An opaque `config` blob the agent reads at fetch time. Atelier
 *     never interprets it. Typical contents: MCP server name,
 *     workspace ids, hostnames — whatever the agent needs to make
 *     calls.
 *   - A `setupFile` pointer to a markdown runbook the agent reads
 *     to GET CONNECTED for the first time (install browser ext,
 *     authorize, add MCP server entry, etc.). Stored on disk at
 *     `.atelier/sources/<id>/setup.md` by convention.
 *
 * No `kind`, no `transport`, no `credentials`. Atelier holds no
 * source-system auth state — that's the agent's department.
 */
export interface Source {
  /** Stable identifier used for citations and the document index. */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /**
   * Free-form parameters the agent reads at fetch time. Atelier
   * round-trips this verbatim — keys and values are opaque to us.
   * Typical: `{mcp_server, workspace_id, hostname}` etc.
   */
  config?: Record<string, unknown>;
  /**
   * Workspace-relative path (from `.atelier/`) to a markdown file
   * containing the connection runbook for this source. By
   * convention, `sources/<id>/setup.md`. The agent reads this when
   * it needs to bring the source online (install MCP server,
   * authorize a workspace, etc.).
   */
  setupFile?: string;
  /**
   * Whether this source is currently active. Disabled sources are
   * still listed (so the user remembers they exist) but don't show
   * up in default `/doc list` filters or agent-bootstrap output.
   */
  enabled: boolean;
}

/** Top-level shape of `.atelier/sources.yaml`. */
export interface SourcesConfig {
  /** Schema version for future migrations. */
  version: 2;
  /** All configured documentation sources. */
  sources: Source[];
}

// ============================================================
// Repo registry (which code repos belong to this workspace)
// ============================================================

/** A code repository registered with this planning workspace. */
export interface RegisteredRepo {
  /** Local directory name (relative to workspace root). */
  name: string;
  /** Git remote URL — the authoritative identifier. */
  remote: string;
  /** Optional path override if the directory name differs from the repo name. */
  localPath?: string;
  /** Free-text description of what this repo is. */
  description?: string;
  /** Whether this repo is currently included in syncs. */
  enabled: boolean;
}

/** Top-level shape of `.planning/repos.yaml`. */
export interface ReposConfig {
  /** Schema version for future migrations. */
  version: 1;
  /** Organization or owner this workspace belongs to (e.g. GitHub org). */
  organization?: string;
  /** All registered repositories. */
  repos: RegisteredRepo[];
}

// ============================================================
// Workspace metadata
// ============================================================

/** Top-level shape of `.planning/workspace.yaml`. */
export interface WorkspaceConfig {
  version: 1;
  /** Display name of this planning workspace. */
  name: string;
  /** Description of what this workspace is for. */
  description?: string;
  /** ISO timestamp when the workspace was initialized. */
  createdAt: string;
  /** Atelier version that initialized this workspace. */
  atelierVersion: string;
}

// ============================================================
// Feature map (what the product does, conceptually)
// ============================================================

/**
 * Where in the codebase a feature is implemented. A feature can point
 * at one or more repos; within each repo the path is optional — a
 * feature may sprawl across many files and the user may prefer to
 * pin only the repo.
 */
export interface FeatureCodeRef {
  /** Name of a registered repository (must exist in repos.yaml). */
  repo: string;
  /** Optional path within that repo (file or directory). */
  path?: string;
}

/**
 * Where in the documentation map a feature is described. References
 * point at entries in the document index (Phase 2, slice 6 establishes
 * the doc map). For now we just record the pointer.
 */
export interface FeatureDocRef {
  /** Source id (must exist in sources.yaml). */
  source: string;
  /** The source-side document id (opaque to Atelier — Notion page id, …). */
  docId: string;
  /** Optional cached title for display before the doc map is synced. */
  title?: string;
}

/** Lifecycle of a feature. */
export type FeatureStatus =
  | "planned"
  | "in-progress"
  | "shipped"
  | "deprecated";

export const FEATURE_STATUSES: ReadonlyArray<FeatureStatus> = [
  "planned",
  "in-progress",
  "shipped",
  "deprecated",
];

/**
 * Structured fields from a feature file's YAML front-matter. Free-form
 * prose lives in `Feature.body` and is intentionally not parsed.
 */
export interface FeatureFrontMatter {
  /** Stable slug-style identifier, unique within the workspace. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line summary (front-matter). Long-form lives in body. */
  description?: string;
  /** Lifecycle stage. */
  status: FeatureStatus;
  /** Code locations implementing this feature. */
  codeRefs: FeatureCodeRef[];
  /** Documentation describing this feature. */
  docRefs: FeatureDocRef[];
  /** ISO timestamp when first created. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

/**
 * A loaded feature file: front-matter + the markdown body below it.
 * The body is the human-readable narrative (states, journeys, …)
 * and is preserved verbatim across loads.
 */
export interface Feature extends FeatureFrontMatter {
  /** Markdown body after the front-matter block (may be empty). */
  body: string;
}

// ============================================================
// Doc map (the documentation index — Slice 6)
// ============================================================

/**
 * Classification of what kind of document this is, from the agent's
 * perspective. Used during spec curation to decide which docs to pull
 * into a session. Initially populated manually; Slice 8's synthesis
 * pass will assign these automatically.
 */
export type DocClassification =
  | "prd"
  | "rfc"
  | "design"
  | "runbook"
  | "policy"
  | "reference"
  | "meeting-notes"
  | "transcript"
  | "discussion"
  | "roadmap"
  | "other";

export const DOC_CLASSIFICATIONS: ReadonlyArray<DocClassification> = [
  "prd",
  "rfc",
  "design",
  "runbook",
  "policy",
  "reference",
  "meeting-notes",
  "transcript",
  "discussion",
  "roadmap",
  "other",
];

/**
 * Structured fields from a doc entry's YAML front-matter.
 *
 * In the new model atelier doesn't store source content — the
 * doc entry's markdown body IS the agent-curated summary
 * (overview + keywords + anchors). To read the actual document,
 * the agent follows `link` using its own integrations.
 */
export interface DocEntryFrontMatter {
  /** Source id (must exist in sources.yaml). */
  source: string;
  /**
   * Stable, source-side identifier. Opaque to atelier — the agent
   * picks a meaningful slug when it adds the doc.
   */
  docId: string;
  /** Display title. */
  title: string;
  /** Optional one-line elevator summary (front-matter; full summary is in body). */
  overview?: string;
  /** Optional classification hint. */
  classification?: DocClassification;
  /**
   * Pointer to the underlying document the agent can use to fetch
   * the full content. Format is up to the source: URL for web docs,
   * MCP page id, file path, etc. Atelier doesn't dereference it.
   */
  link?: string;
  /** ISO timestamp when first registered. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

/**
 * A loaded doc entry: front-matter + the summary markdown body.
 * The body is whatever shape the agent wrote — typically a 1-2
 * sentence overview, a `## Keywords` list, and a `## Anchors`
 * list of section pointers. Atelier doesn't enforce structure;
 * the printSummaryRequestForAgent block in the CLI suggests one.
 */
export interface DocEntry extends DocEntryFrontMatter {
  /** Markdown body — the agent-written summary. May be empty. */
  body: string;
}

// ============================================================
// Discrepancy log (Slice 7 — schema only, detection in Phase 3)
// ============================================================

/** How serious is a documented mismatch. */
export type DiscrepancySeverity = "low" | "medium" | "high" | "critical";

export const DISCREPANCY_SEVERITIES: ReadonlyArray<DiscrepancySeverity> = [
  "low",
  "medium",
  "high",
  "critical",
];

/** Workflow state for a discrepancy entry. */
export type DiscrepancyStatus = "open" | "acknowledged" | "resolved" | "wontfix";

export const DISCREPANCY_STATUSES: ReadonlyArray<DiscrepancyStatus> = [
  "open",
  "acknowledged",
  "resolved",
  "wontfix",
];

/** Pointer to the doc making the claim. */
export interface DiscrepancyDocRef {
  source: string;
  docId: string;
}

/** Pointer to the code that contradicts the claim. */
export interface DiscrepancyCodeRef {
  repo: string;
  path?: string;
}

/** A single discrepancy entry. */
export interface Discrepancy {
  /** Stable slug-style identifier, unique within the workspace. */
  id: string;
  /** Optional feature this discrepancy is associated with. */
  feature?: string;
  /** What the doc claims (free text, one line). */
  claim: string;
  /** What the code actually does (free text, one line). */
  observed: string;
  /** Severity. */
  severity: DiscrepancySeverity;
  /** Lifecycle status. */
  status: DiscrepancyStatus;
  /** Pointer to the asserting doc. */
  docRef?: DiscrepancyDocRef;
  /** Pointer to the contradicting code. */
  codeRef?: DiscrepancyCodeRef;
  /** Free-form notes (history, follow-ups). */
  notes?: string;
  /** ISO timestamp when first logged. */
  createdAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

/** Top-level shape of `.planning/discrepancies.yaml`. */
export interface DiscrepancyLog {
  version: 1;
  discrepancies: Discrepancy[];
}

// ============================================================
// Spec workflow (Slice 9 — `atelier spec`)
// ============================================================

/**
 * Each change type drives a different spec.md template — different
 * sections, different prompts. The taxonomy is small and stable;
 * adding a kind is intentional, not a free-form string.
 */
export type SpecChangeType =
  | "new-feature"
  | "modification"
  | "ui"
  | "refactor"
  | "bug"
  | "integration";

export const SPEC_CHANGE_TYPES: ReadonlyArray<SpecChangeType> = [
  "new-feature",
  "modification",
  "ui",
  "refactor",
  "bug",
  "integration",
];

/** Lifecycle of a spec / issue folder. */
export type SpecStatus =
  | "drafting"
  | "ready"
  | "in-progress"
  | "completed"
  | "abandoned";

export const SPEC_STATUSES: ReadonlyArray<SpecStatus> = [
  "drafting",
  "ready",
  "in-progress",
  "completed",
  "abandoned",
];

/**
 * Structured fields in a spec's README.md front-matter. The detailed
 * narrative lives in spec.md (free-form, templated per type).
 */
export interface SpecManifest {
  /** Stable slug: `<YYYY-MM-DD>-<slug>`. */
  id: string;
  /** The one-line description the user typed. */
  title: string;
  /** Change type — controls which template renders. */
  type: SpecChangeType;
  /** Lifecycle status. */
  status: SpecStatus;
  /** Feature ids this spec touches (must exist in features/). */
  features: string[];
  /** Direct code references (in addition to those pulled via features). */
  codeRefs: FeatureCodeRef[];
  /** Direct doc references (in addition to those pulled via features). */
  docRefs: FeatureDocRef[];
  /** ISO timestamp when first created. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

// ============================================================
// Validation result type (used by schema validators)
// ============================================================

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}
