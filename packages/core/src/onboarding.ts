import type { SourceAdapter } from "./source-adapters.js";
import type { Source, SourceKind, SourceTransport } from "./types.js";

/**
 * Source onboarding framework.
 *
 * Every officially-supported source kind ships with an
 * {@link OnboardingFlow}: a declarative description of the transports
 * it supports, the questions to ask the user, and how to translate
 * the answers into a {@link Source} entry that the registry can store.
 *
 * Why declarative rather than a single `async run()` function?
 *   - The CLI drives the prompts. Tests drive the same flow by
 *     supplying answers programmatically. Separating "what to ask"
 *     from "how to ask" makes both possible without forking logic.
 *   - Third-party adapters (loaded via `external` transport) plug
 *     into the same shape — no special-casing.
 */

/**
 * Available transports for a given source. Discovered at runtime: we
 * actually check whether the user has an MCP server registered, a
 * required CLI on PATH, etc. The result is shown to the user as
 * "Detected: …".
 */
export interface TransportOption {
  transport: SourceTransport;
  /** Short label shown in the CLI menu (e.g. "Use Claude Code's MCP server"). */
  label: string;
  /** True when the prerequisite (token / CLI binary / config) is present. */
  ready: boolean;
  /** Short human note: why it's ready, or what's missing. */
  note?: string;
  /** Recommended pick (one option per flow). The CLI highlights it. */
  recommended?: boolean;
}

/**
 * One option in a dynamic-choice step. `value` is what we store in
 * `answers.values[step.key]`; `label` is what's shown in the picker.
 * Used by {@link OnboardingStep.discoverChoices}.
 */
export interface OnboardingChoice {
  label: string;
  /** The string that ends up in `answers.values[step.key]`. */
  value: string;
  /** Dimmed annotation shown next to the label (e.g. "12 discussions"). */
  note?: string;
  /**
   * Visually present but unselectable. The intended use is to show
   * items that are already covered by another registered source —
   * the user sees them in the list (so they understand the state of
   * the world) but can't accidentally pick them again. The `note`
   * usually explains why ("already linked to <source-id>").
   */
  disabled?: boolean;
}

/**
 * Context handed to dynamic-choice discovery. Lets adapters look at
 * the workspace (orgs already registered, locally-cloned repos
 * nearby) without having to plumb cwd/workspaceRoot through ad-hoc.
 *
 * Built once per onboarding run by the CLI and passed into every
 * step's `discoverChoices`.
 */
export interface OnboardingContext {
  /** Absolute path to `.planning/`'s parent. */
  workspaceRoot: string;
  /** The user's cwd when onboarding started — for nearby-repo scans. */
  cwd: string;
  /**
   * Distinct GitHub orgs we know about: the org persisted in
   * repos.yaml plus any orgs detected from sibling-directory git
   * clones. Most-relevant-first. Empty when nothing was found.
   */
  orgs: string[];
  /**
   * Sources already registered in this workspace. Adapters use
   * this to hide items that are already covered — e.g. a repo
   * that's already in another github-discussions source's
   * scope.repos, or a discussion that's already pinned via
   * scope.discussionIds. Prevents the picker from offering
   * duplicates of work the user has already done.
   *
   * Same-kind sources are the typical signal, but adapters can
   * also consult other kinds (e.g. a Notion adapter inspecting
   * SharePoint sources for the same root). Keeping it
   * heterogeneous makes future cross-source rules cheap.
   */
  existingSources: Source[];
}

/** A single question shown to the user during onboarding. */
export interface OnboardingStep {
  /** Stable key used to retrieve the answer. */
  key: string;
  /** Prompt shown to the user. */
  prompt: string;
  /** Optional default if the user just presses enter. */
  default?: string;
  /** Marks this answer as a secret — CLI should mask input. */
  secret?: boolean;
  /** Optional regex for client-side validation. */
  validate?: RegExp;
  /**
   * Should this step run? Lets steps gate on prior answers
   * (e.g. only ask "API token" when transport === "rest").
   */
  applies?(answers: OnboardingAnswers): boolean;
  /** Free-form help shown above the prompt. */
  help?: string;
  /**
   * Apply the step's `default` automatically without prompting the
   * user. Used for fields where the default is virtually always
   * what the user wants (e.g. "Source id" derived from the kind
   * slug, "Display name" derived from the adapter's displayName) —
   * removes Enter-through friction in the onboarding flow. The
   * applied value still appears in the summary so the user sees
   * what's about to be persisted.
   *
   * Overridable in non-interactive mode via `--answer key=value`.
   */
  auto?: boolean;
  /**
   * Render as a multi-select picker (when used with
   * {@link discoverChoices}). The selected values are joined into a
   * comma-separated string and stored under `step.key` so the rest
   * of the adapter pipeline (CSV parsing, persistence) doesn't have
   * to change.
   *
   * Ignored when `discoverChoices` is undefined.
   */
  multiSelect?: boolean;
  /**
   * Dynamic-choice resolver. When present, the CLI calls this to
   * fetch candidate values (e.g. "every repo in the user's orgs
   * that has Discussions enabled") and shows a picker instead of a
   * free-text prompt.
   *
   * If the function throws OR returns an empty list, the CLI falls
   * back to the regular text prompt (with the step's `default` and
   * `validate` rules). That way an adapter can offer discovery as a
   * convenience without making it the only path.
   *
   * Called after transport selection, so `answers.transport` is
   * always set when this runs.
   */
  discoverChoices?(
    ctx: OnboardingContext,
    answers: OnboardingAnswers
  ): Promise<OnboardingChoice[]>;
}

export interface OnboardingAnswers {
  /** The chosen transport. Set after the transport-pick step. */
  transport?: SourceTransport;
  /** Free-form bag of step answers, keyed by `OnboardingStep.key`. */
  values: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  /** When `!ok`: human-readable error for the CLI to show. */
  error?: string;
  /** When `ok`: short message ("Found 47 pages.") to confirm to the user. */
  message?: string;
}

/**
 * Output of an onboarding flow: ready to hand to `addSource` and (if
 * the chosen transport is `mcp`) to add to the MCP servers config.
 */
export interface OnboardingResult {
  /** The Source entry to register in sources.yaml. */
  source: Omit<Source, "id" | "name" | "enabled"> & {
    id?: string;
    name: string;
  };
  /**
   * If onboarding produced an MCP server definition the user should
   * persist, it's here. The CLI writes it into
   * `~/.atelier/mcp-servers.json`.
   */
  mcpServer?: {
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    tools?: { list?: string; fetch?: string };
    description?: string;
  };
  /**
   * Environment variables the user should set in their shell rc
   * (e.g. `NOTION_TOKEN=...`). The CLI surfaces these — Atelier does
   * NOT write to ~/.bashrc/.zshrc automatically.
   */
  envVarsToSet?: Array<{ name: string; value: string; description?: string }>;
}

/**
 * The contract every onboarding flow implements. Both built-in
 * adapters and third-party (`external` transport) adapters use this
 * exact shape.
 */
export interface OnboardingFlow {
  /** Matches the {@link SourceKind} this flow registers. */
  kind: SourceKind | "external";
  /** Display name in the CLI menu (e.g. "Notion"). */
  displayName: string;
  /** Short description shown above the transport menu. */
  description: string;

  /** Detect which transports the current machine can do. */
  availableTransports(): Promise<TransportOption[]>;

  /** Questions to ask, given the chosen transport. */
  steps(transport: SourceTransport): OnboardingStep[];

  /** Try the connection live; tells the user if their answers work. */
  verify(answers: OnboardingAnswers): Promise<VerifyResult>;

  /** Translate final answers into a registry entry. */
  toRegistryEntry(answers: OnboardingAnswers): OnboardingResult;

  /**
   * Optional: combine the new onboarding answers with an already-
   * registered source. Called by the CLI when the user re-runs
   * /source onboard, points at the same id, and confirms the
   * "add to existing" prompt — typical scenario is incrementally
   * adding more discussions to a github-discussions source they
   * already onboarded.
   *
   * Returns a fresh {@link OnboardingResult} whose `source` is the
   * merged entry. The CLI rewrites the existing entry with this
   * value (no second addition of any MCP server / env vars; those
   * stay as-is on the existing entry).
   *
   * Adapters that don't override this fall back to a "create new
   * id" flow.
   */
  merge?(existing: Source, answers: OnboardingAnswers): OnboardingResult;
}

// ============================================================
// Adapter registry
// ============================================================

export interface AdapterRegistration {
  kind: SourceKind;
  onboarding: OnboardingFlow;
  /**
   * Build a working SourceAdapter from a registered Source. The sync
   * engine resolves to this via the factory.
   */
  build(source: Source): Promise<SourceAdapter & { dispose?(): Promise<void> }>;
}

const builtins = new Map<SourceKind, AdapterRegistration>();

/**
 * Register a built-in adapter. Called once at module load time from
 * each adapter module. Third-party adapters register via the same
 * function when loaded by the `external` transport resolver.
 */
export function registerAdapter(reg: AdapterRegistration): void {
  builtins.set(reg.kind, reg);
}

export function getAdapter(kind: SourceKind): AdapterRegistration | undefined {
  return builtins.get(kind);
}

export function listAdapters(): AdapterRegistration[] {
  return [...builtins.values()];
}
