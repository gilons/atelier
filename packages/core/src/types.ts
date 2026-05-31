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

// ============================================================
// Documentation — knowledge artifacts (PRDs, RFCs, runbooks, …)
// ============================================================

/**
 * A piece of documentation atelier has indexed — the first of the
 * typed surfaces that replace the generic "item". One entry per
 * knowledge artifact (a PRD, an RFC, a runbook, a transcript). As
 * with the old item model, atelier stores an agent-curated summary +
 * a `link` back to the source, not the source content itself.
 *
 * Storage: `.atelier/documentation/<source>/<encoded-docId>/summary.md`.
 */
export interface DocFrontMatter {
  /** Source id (must exist in sources.yaml; typically a `docs` source). */
  source: string;
  /** Stable, source-side id. Opaque to atelier. */
  docId: string;
  /** Display title. */
  title: string;
  /** One-line elevator summary (full summary lives in the body). */
  overview?: string;
  /**
   * Free-form classification: "prd" | "rfc" | "runbook" | "transcript"
   * | "policy" | "reference" | … Atelier doesn't enforce a vocabulary.
   */
  classification?: string;
  /** Pointer the agent follows to re-read the full document. */
  link?: string;
  /**
   * Who owns / maintains this doc — a stakeholder id or free-form name.
   * Documentation-specific: lets the docs surface answer "who keeps
   * this current?".
   */
  owner?: string;
  /** Session id this doc was captured from, when applicable. */
  fromSession?: string;
  /** ISO timestamp when first indexed. */
  createdAt: string;
  /** ISO timestamp of the most recent structural change. */
  updatedAt: string;
}

/** A loaded documentation entry: front-matter + the summary body. */
export interface Documentation extends DocFrontMatter {
  /** Markdown body — the agent-curated summary. May be empty. */
  body: string;
}

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
  /**
   * Length of each audio chunk (in seconds) when the session was
   * recorded in chunked mode. Absent for non-chunked sessions
   * (single recording.wav) or transcript-only sessions (import).
   * Used by `atelier session check` to tell the agent how often to
   * poll for new chunks.
   */
  chunkSeconds?: number;
  /**
   * Language code (e.g. "en", "de", "auto") to use when transcribing
   * this session's audio. Overrides the workspace-level
   * `audio.yaml#whisper.language`. Surfaced to the agent via
   * `session check` so it knows which `--language` to pass to its STT.
   */
  language?: string;
}

/** A loaded session: metadata + the raw transcript text. */
export interface Session extends SessionFrontMatter {
  /** Contents of transcript.md verbatim. May be empty for new sessions. */
  transcript: string;
}


// ============================================================
// Stakeholders — people involved in the workspace's product
// ============================================================

/**
 * What atelier knows about a single person who shows up in the
 * workspace's product world: a PM, an engineer, a customer, an
 * advisor, an exec sponsor. Anyone the agent / user wants to track
 * context about.
 *
 * Storage shape (folder per stakeholder):
 *
 *   .atelier/stakeholders/<id>/
 *     profile.md      — front-matter (these fields) + shared narrative.
 *                       Tracked by git. The team's collective view of
 *                       this person.
 *     private.md      — optional, free-form. Gitignored. Personal
 *                       notes ("prefers async", "reports to X",
 *                       sensitive history). atelier exposes it via
 *                       `stakeholder note --private` and `show --private`
 *                       so the user can take notes without leaking
 *                       them through the shared repo.
 *
 * The split is deliberate: a team wants to share "Sarah Chen — PM,
 * Payments squad" but typically NOT "Sarah doesn't like long
 * meetings." atelier models both layers as one stakeholder so the
 * UX feels unified; git treats them as separate files.
 */
export interface StakeholderFrontMatter {
  /** Slug id, unique within the workspace. Folder name on disk. */
  id: string;
  /** Display name. The person's preferred form, free-form. */
  name: string;
  /**
   * One-line role label, e.g. "PM", "Senior Engineer", "Design
   * Director", "Customer (Acme Corp)", "Advisor". Free-form — atelier
   * doesn't validate against an enum so teams can use their own
   * vocabulary.
   */
  role?: string;
  /**
   * Organisation / company / team the person belongs to. Used to
   * group stakeholders by org in list views. Free-form.
   */
  organization?: string;
  /**
   * Optional email — the canonical handle for the person. Not used
   * for sending anything; atelier never reaches out. Stored so the
   * agent can correlate stakeholders with external systems
   * (calendar invites, ticket assignees, PR reviewers).
   */
  email?: string;
  /**
   * Free-form handles keyed by where they're useful: slack, github,
   * linear, x, linkedin, … The agent fills these in as it
   * encounters them; atelier stores the dictionary opaquely.
   */
  handles?: Record<string, string>;
  /**
   * What this person owns in the workspace. Free-form list of
   * pointers: feature ids ("checkout"), source:itemId pairs
   * ("notion:abc123"), repo names ("api"), spec ids. atelier
   * doesn't enforce the format — the agent picks the convention
   * that matches what it indexed.
   */
  ownerships?: string[];
  /**
   * One-line elevator summary (the long-form narrative lives in
   * profile.md's body). Shown in `stakeholder list`.
   */
  summary?: string;
  /**
   * Optional session ids this stakeholder was first surfaced from
   * (e.g. extracted from a recorded conversation by the agent).
   * Lets `session show` enumerate "who showed up in this call"
   * later.
   */
  fromSessions?: string[];
  /** ISO timestamp — when atelier first registered this person. */
  createdAt: string;
  /** ISO timestamp — most recent structural change. */
  updatedAt: string;
}

/**
 * A loaded stakeholder: front-matter + the shared profile narrative
 * + (when present + requested) the private side.
 *
 * `profileBody` is what got read from profile.md after the
 * front-matter block. `privateBody` is undefined unless the loader
 * was asked to include it AND private.md exists. Callers that
 * shouldn't surface private notes (anything that exports to git,
 * the public `list` output, …) just keep `privateBody` undefined.
 */
export interface Stakeholder extends StakeholderFrontMatter {
  /** Markdown body of profile.md (after the front-matter). May be empty. */
  profileBody: string;
  /**
   * Optional markdown body of private.md. Always undefined unless
   * the loader was explicitly told to include private notes —
   * callers default to omitting it so the file stays private by
   * construction, not by remembering to scrub.
   */
  privateBody?: string;
}


// ============================================================
// Agents — atelier-authored playbooks that AI tools discover + run
// ============================================================

/**
 * An agent atelier produces for a connected AI tool (Claude Code,
 * …) to discover and run. Atelier itself never calls an LLM — it's
 * the *author and registry* of agents; the AI tool is the runtime.
 *
 * Storage shape (folder per agent):
 *
 *   .atelier/agents/<id>/
 *     agent.yaml        — these metadata fields.
 *     instructions.md   — the agent's playbook / system prompt. This
 *                         is the part that "self-improves": the agent
 *                         (via the AI tool) refines it over time.
 *     learnings.md      — append-only log of durable facts the agent
 *                         discovered about THIS workspace ("planning
 *                         lives in Linear", "design is Figma file X").
 *                         Folded into the rendered artifact so the
 *                         agent carries accumulated context next run.
 *
 * `atelier agent install <id>` renders the canonical def into
 * Claude-discoverable files under `.claude/` (a slash command + a
 * subagent). The canonical `.atelier/agents/` copy is the source of
 * truth; the `.claude/` files are generated and re-rendered whenever
 * instructions or learnings change.
 */
export interface AgentFrontMatter {
  /** Slug id, unique within the workspace. Folder name on disk. */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Optional classification — "discovery", "system-design", or any
   * free-form label. Lets list views group agents by what they do.
   */
  kind?: string;
  /**
   * One-line statement of what the agent is for. Rendered as the
   * slash command's `description` frontmatter (what shows in the
   * `/` menu).
   */
  purpose: string;
  /**
   * Richer "when should the AI delegate to this agent" text. Rendered
   * as the subagent's `description` frontmatter, which drives Claude's
   * auto-delegation. Falls back to {@link AgentFrontMatter.purpose}
   * when empty.
   */
  description?: string;
  /**
   * Optional argument hint for the slash command (e.g. "[surface to
   * focus on]"). Rendered as the command's `argument-hint`.
   */
  argumentHint?: string;
  /**
   * Tools the rendered artifacts are allowed to use (e.g. ["Bash",
   * "Read"]). Rendered as `allowed-tools` (command) / `tools`
   * (subagent). Omit to inherit all tools.
   */
  tools?: string[];
  /**
   * Model override for the rendered subagent ("sonnet" | "opus" |
   * "haiku" | "inherit"). Omit to inherit the session model.
   */
  model?: string;
  /**
   * True for agents atelier ships as built-in templates (discovery,
   * system-design). User-authored agents have this false/absent.
   * Informational — lets list views badge built-ins.
   */
  builtin?: boolean;
  /** Bumped each time the canonical def changes structurally. */
  version: number;
  /** ISO timestamp — when atelier first wrote this agent. */
  createdAt: string;
  /** ISO timestamp — most recent change to instructions/learnings/meta. */
  updatedAt: string;
}

/** A loaded agent: metadata + playbook body + accumulated learnings. */
export interface Agent extends AgentFrontMatter {
  /** Body of instructions.md (the self-improving playbook). */
  instructions: string;
  /** Body of learnings.md (append-only workspace facts). May be empty. */
  learnings: string;
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
  /**
   * Optional session id this spec was born from — e.g. a planning call
   * where the system-design agent's live companion mode surfaced the
   * change and the user chose "create a new spec". Lets `session show`
   * enumerate what a conversation produced. Mirrors the item /
   * stakeholder `fromSession` convention.
   */
  fromSession?: string;
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
