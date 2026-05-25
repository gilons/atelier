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
// Source connections (where the agent fetches things from)
// ============================================================

/**
 * What kind of workspace artifacts this source feeds.
 *
 *   - `docs` — knowledge: PRDs, RFCs, runbooks, transcripts.
 *   - `design` — UI / system design: Figma frames, Excalidraw
 *     canvases, Whimsical flows.
 *   - `pm` — product management: Linear/Jira/Asana initiatives,
 *     milestones, epics, tickets.
 *
 * The category influences which command the agent uses to add
 * items (`atelier item add --category <c>`) and how atelier
 * filters them in list views. The source's underlying integration
 * (MCP server, browser ext, REST) is still the agent's problem;
 * atelier just tags the source so items can be grouped sensibly.
 */
export type SourceCategory = "docs" | "design" | "pm";

export const SOURCE_CATEGORIES: ReadonlyArray<SourceCategory> = [
  "docs",
  "design",
  "pm",
];

/**
 * A configured workspace source.
 *
 * Atelier doesn't talk to source systems directly — the user's
 * agent does (via MCP servers, browser extensions, whatever
 * integrations are already wired up). A "source" in atelier's
 * model is just:
 *
 *   - A stable identifier the agent uses when adding items.
 *   - A human-readable name.
 *   - A `category` (docs / design / pm) so atelier knows which
 *     bucket items belong to.
 *   - An opaque `config` blob the agent reads at fetch time. Atelier
 *     never interprets it. Typical contents: MCP server name,
 *     workspace ids, hostnames — whatever the agent needs to make
 *     calls.
 *   - A `setupFile` pointer to a markdown runbook the agent reads
 *     to GET CONNECTED for the first time (install browser ext,
 *     authorize, add MCP server entry, etc.). Stored on disk at
 *     `.atelier/sources/<id>/setup.md` by convention.
 */
export interface Source {
  /** Stable identifier used for citations and the item index. */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /**
   * What kind of artifacts live under this source. Defaults to
   * `docs` for back-compat with workspaces that pre-date the
   * three-category model.
   */
  category: SourceCategory;
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
   * up in default `/item list` filters or agent-bootstrap output.
   */
  enabled: boolean;
}

/** Top-level shape of `.atelier/sources.yaml`. */
export interface SourcesConfig {
  /** Schema version for future migrations. */
  version: 3;
  /** All configured workspace sources. */
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
 * A reference from a feature or spec to a tracked item — could be a
 * doc, a design artifact, or a PM ticket depending on the source's
 * category. The `docId` field name predates the three-category
 * model; semantically it's "the id of the referenced item" — kept
 * as `docId` so existing features.yaml entries keep loading.
 */
export interface FeatureItemRef {
  /** Source id (must exist in sources.yaml). */
  source: string;
  /** The source-side item id (opaque to atelier — Notion page id, Linear ticket key, Figma node id, …). */
  docId: string;
  /** Optional cached title for display before the item is indexed. */
  title?: string;
}

/** @deprecated use FeatureItemRef — same shape, clearer name. */
export type FeatureDocRef = FeatureItemRef;

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
// Items (the workspace index — docs, design, PM, all unified)
// ============================================================

/**
 * Structured fields from an item's YAML front-matter.
 *
 * Items are atelier's unit of indexed knowledge — one per
 * tracked artifact (a PRD, a Figma frame, a Linear ticket, …).
 * Atelier doesn't store source content; the markdown body IS
 * the agent-curated summary. To re-read the underlying artifact,
 * the agent follows `link` via its own integrations.
 */
export interface ItemFrontMatter {
  /** Source id (must exist in sources.yaml). */
  source: string;
  /**
   * Stable, source-side identifier. Opaque to atelier — the agent
   * picks a slug meaningful within the source. Named `docId` for
   * back-compat with the prior model; semantically the id of any
   * indexed thing regardless of category.
   */
  docId: string;
  /** Display title. */
  title: string;
  /** Optional one-line elevator summary (full summary lives in body). */
  overview?: string;
  /**
   * Free-form classification string. The vocabulary depends on the
   * source's category:
   *
   *   - docs:   "prd" | "rfc" | "runbook" | "transcript" | "policy" | …
   *   - design: "frame" | "screen" | "component" | "flow" | "system" | …
   *   - pm:     "initiative" | "milestone" | "epic" | "ticket" | "story" | …
   *
   * Atelier doesn't enforce any of these — the agent picks
   * whatever its tool natively uses.
   */
  classification?: string;
  /**
   * Pointer to the underlying artifact the agent can use to fetch
   * the full content. Format is up to the source: URL for web docs,
   * MCP page id, file path, ticket id, frame node, etc. Atelier
   * doesn't dereference it.
   */
  link?: string;
  /**
   * Optional parent itemId. Used to express hierarchy within a
   * single source (initiative → milestone → ticket, design file →
   * frame, etc.). Atelier doesn't enforce that the parent exists or
   * is the right type — list views render the tree based on what
   * the agent wrote.
   */
  parent?: string;
  /**
   * Optional session id this item was born from. Set when the
   * agent creates an item out of a live conversation captured by
   * the speaking module (`atelier session start` → notes → end →
   * agent extracts items). Lets `/session show` enumerate items
   * that came out of a given conversation later.
   */
  fromSession?: string;
  /** ISO timestamp when first registered. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

/**
 * A loaded item: front-matter + the summary markdown body.
 * The body is whatever shape the agent wrote — typically a 1-2
 * sentence overview, a `## Keywords` list, and a `## Anchors`
 * list. Atelier doesn't enforce structure; the agent follow-up
 * block printed after `/item add` suggests one.
 */
export interface Item extends ItemFrontMatter {
  /** Markdown body — the agent-written summary. May be empty. */
  body: string;
}

/** @deprecated use Item — same shape, clearer name. */
export type DocEntry = Item;
/** @deprecated use ItemFrontMatter — same shape, clearer name. */
export type DocEntryFrontMatter = ItemFrontMatter;

// ============================================================
// Sessions — the speaking-module record of a conversation
// ============================================================

/** Workflow state of a recorded conversation. */
export type SessionStatus = "active" | "ended";

export const SESSION_STATUSES: ReadonlyArray<SessionStatus> = ["active", "ended"];

/**
 * Structured fields from a session's session.yaml.
 *
 * A session is one bounded conversation — a brainstorm, a stand-up,
 * a user interview. Atelier stores it as:
 *   .atelier/sessions/<id>/
 *     session.yaml      — these front-matter fields
 *     transcript.md     — the running transcript (appended via
 *                         `atelier session note`)
 *
 * Items created from the session set their `fromSession` field to
 * this session's id, so `atelier session show <id>` can enumerate
 * "what came out of this conversation" later.
 *
 * The transcription engine is the agent's department — atelier
 * doesn't bundle Whisper / mic capture. The agent (Claude voice
 * mode, Otter, a phone pipeline, whatever) feeds atelier transcript
 * chunks; atelier stores + organizes them.
 */
export interface SessionFrontMatter {
  /** Stable id (slug + short suffix). Used in folder name + URLs. */
  id: string;
  /** Display title. Free-form. */
  title: string;
  /**
   * Optional list of participants (free-form names — atelier doesn't
   * resolve them against any directory). The agent fills these in
   * when it's known who's in the room.
   */
  participants?: string[];
  /**
   * Workflow state. `active` means notes can still be appended;
   * `ended` means the conversation closed and the agent is now
   * doing post-extraction.
   */
  status: SessionStatus;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** ISO timestamp when the session ended (only when status='ended'). */
  endedAt?: string;
}

/** A loaded session: metadata + the raw transcript text. */
export interface Session extends SessionFrontMatter {
  /** Contents of transcript.md verbatim. May be empty for new sessions. */
  transcript: string;
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
