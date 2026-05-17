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
// Source connections (where documentation lives)
// ============================================================

/** Kinds of documentation sources Atelier can consume. */
export type SourceKind =
  | "notion"
  | "confluence"
  | "google-drive"
  | "onedrive"
  | "sharepoint"
  | "jira"
  | "linear"
  | "github-issues"
  | "github-discussions"
  | "github-repo-docs"
  | "local-folder";

/**
 * How Atelier talks to the underlying source.
 *
 *   - `local-folder` — implied by `kind: "local-folder"`; no auth/network.
 *   - `mcp`          — call an MCP server defined in
 *                      `~/.atelier/mcp-servers.json`.
 *   - `rest`         — direct HTTPS to the source's REST API
 *                      (e.g. api.notion.com).
 *   - `cli`          — shell out to a CLI tool the user has installed
 *                      (e.g. `gh`, `acli`).
 *   - `external`     — a third-party adapter loaded from a node module.
 */
export type SourceTransport = "local-folder" | "mcp" | "rest" | "cli" | "external";

export const SOURCE_TRANSPORTS: ReadonlyArray<SourceTransport> = [
  "local-folder",
  "mcp",
  "rest",
  "cli",
  "external",
];

/** A single configured documentation source. */
export interface Source {
  /** Stable identifier used for citations and the document index. */
  id: string;
  /** The kind of source (Notion, Confluence, ...). */
  kind: SourceKind;
  /** Human-readable name shown in the UI. */
  name: string;
  /**
   * How Atelier reaches this source. Defaults are inferred from the
   * source's kind for back-compat (`local-folder` → `local-folder`;
   * anything with `mcpServer` set → `mcp`). New sources should be
   * explicit.
   */
  transport?: SourceTransport;
  /** The MCP server identifier providing this source's tools, if any. */
  mcpServer?: string;
  /**
   * Credential reference for REST/CLI transports. Two shapes:
   *
   *   - `{ envVar: "NOTION_TOKEN" }` — Atelier reads a static
   *     bearer token from the named env var at sync time. Used
   *     for Notion API tokens and (legacy) SharePoint bearer
   *     tokens.
   *
   *   - `{ kind: "azureClientCredentials", tenantId, clientId,
   *     clientSecretEnvVar }` — Atelier mints fresh Graph tokens
   *     via the OAuth client_credentials flow. Tenant + client
   *     IDs sit in source.yaml (they're not secrets — they
   *     identify the app, not authenticate it); the secret is
   *     read from `$clientSecretEnvVar` at sync time. Used by
   *     SharePoint to avoid hourly token re-paste.
   *
   * Atelier never stores secret values in source.yaml; secrets
   * always come from the user's environment at sync time.
   */
  credentials?:
    | { envVar: string }
    | {
        kind: "azureClientCredentials";
        tenantId: string;
        clientId: string;
        clientSecretEnvVar: string;
        scope?: string;
      };
  /**
   * For `external` transport: the npm module name that exports the
   * adapter. Module must default-export
   * `{ adapter: SourceAdapterFactory, onboarding?: OnboardingFlow }`.
   */
  adapterModule?: string;
  /** Optional scope hints (workspace IDs, paths, etc.) — opaque per kind. */
  scope?: Record<string, unknown>;
  /** Whether this source is currently included in syncs. */
  enabled: boolean;
}

/** Top-level shape of `.planning/sources.yaml`. */
export interface SourcesConfig {
  /** Schema version for future migrations. */
  version: 1;
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
 * Structured fields from a doc entry's YAML front-matter. The doc
 * content body lives in `DocEntry.body` (markdown), kept verbatim.
 */
export interface DocEntryFrontMatter {
  /** Source id (must exist in sources.yaml). */
  source: string;
  /**
   * The source-side document id. Opaque to Atelier — Notion page id,
   * Confluence content id, file path for local sources, etc.
   */
  docId: string;
  /** Display title. */
  title: string;
  /** Optional one-line summary. */
  summary?: string;
  /** Optional classification hint. */
  classification?: DocClassification;
  /** Optional URL pointing back at the canonical source. */
  url?: string;
  /** ISO timestamp of the last successful fetch from the source. */
  lastFetched?: string;
  /** Hash of the fetched body. Used by Slice 8 to detect changes. */
  contentHash?: string;
  /** ISO timestamp when first registered. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

/** A loaded doc entry: front-matter + body. */
export interface DocEntry extends DocEntryFrontMatter {
  /** Markdown body — the fetched doc content. May be empty. */
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
