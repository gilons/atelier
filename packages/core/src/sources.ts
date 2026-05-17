import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { validateSourcesConfig, formatIssues } from "./validation.js";
import { workspacePaths } from "./paths.js";
import { WorkspaceValidationError } from "./workspace.js";
import type { SourcesConfig, Source, SourceKind } from "./types.js";

/**
 * High-level operations on the documentation source registry
 * (`.planning/sources.yaml`). Atelier doesn't fetch from these sources
 * here — Phase 2 adds the doc-map sync layer. Registration just tells
 * the tool *what* to read from later.
 */

const SOURCES_HEADER =
  "Documentation sources Atelier reads from (Notion, Confluence, GDocs, …).\n" +
  "Use `atelier source add` to register new sources rather than editing by hand.";

export const SOURCE_KINDS_LIST: ReadonlyArray<SourceKind> = [
  "notion",
  "confluence",
  "google-drive",
  "onedrive",
  "sharepoint",
  "jira",
  "linear",
  "github-issues",
  "github-discussions",
  "github-repo-docs",
  "local-folder",
];

export class SourceAlreadyRegisteredError extends Error {
  constructor(public readonly id: string) {
    super(`A source with id "${id}" is already registered.`);
    this.name = "SourceAlreadyRegisteredError";
  }
}

export class SourceNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No registered source with id "${id}".`);
    this.name = "SourceNotFoundError";
  }
}

export class InvalidSourceKindError extends Error {
  constructor(public readonly kind: string) {
    super(
      `Unknown source kind "${kind}". Valid kinds: ${SOURCE_KINDS_LIST.join(", ")}.`
    );
    this.name = "InvalidSourceKindError";
  }
}

/** Load and validate the source registry. */
export async function loadSourcesConfig(workspaceRoot: string): Promise<SourcesConfig> {
  const p = workspacePaths(workspaceRoot);
  const raw = (await readYamlFile(p.sourcesConfig)) ?? { version: 1, sources: [] };
  const result = validateSourcesConfig(raw);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(p.sourcesConfig, formatIssues(result.issues));
  }
  return result.value;
}

/** Persist the source registry (with validation). */
export async function saveSourcesConfig(
  workspaceRoot: string,
  cfg: SourcesConfig
): Promise<void> {
  const p = workspacePaths(workspaceRoot);
  const result = validateSourcesConfig(cfg);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(p.sourcesConfig, formatIssues(result.issues));
  }
  await writeYamlFile(p.sourcesConfig, result.value, SOURCES_HEADER);
}

export interface AddSourceOptions {
  kind: string;
  /** Stable identifier. Auto-derived from kind + name if omitted. */
  id?: string;
  name: string;
  /** How Atelier reaches this source (mcp / rest / cli / external). */
  transport?: import("./types.js").SourceTransport;
  mcpServer?: string;
  /** Credential reference (env var holding the secret). */
  credentials?: { envVar: string };
  /** For `external` transport: npm module name that exports the adapter. */
  adapterModule?: string;
  /** Free-form per-kind metadata (workspace ids, paths, etc.). */
  scope?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Derive a slug-style id from a name. Lowercase, alphanumeric+hyphens.
 * Falls back to the source kind if name is unusable.
 */
function deriveId(kind: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (slug) return slug;
  return kind;
}

/** Register a new documentation source. */
export async function addSource(
  workspaceRoot: string,
  opts: AddSourceOptions
): Promise<Source> {
  if (!SOURCE_KINDS_LIST.includes(opts.kind as SourceKind)) {
    throw new InvalidSourceKindError(opts.kind);
  }
  const cfg = await loadSourcesConfig(workspaceRoot);

  let id = opts.id ?? deriveId(opts.kind, opts.name);
  // De-duplicate the id by appending -2, -3, ... if needed.
  if (cfg.sources.some((s) => s.id === id)) {
    if (opts.id !== undefined) {
      throw new SourceAlreadyRegisteredError(id);
    }
    let suffix = 2;
    while (cfg.sources.some((s) => s.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const source: Source = {
    id,
    kind: opts.kind as SourceKind,
    name: opts.name,
    enabled: opts.enabled ?? true,
  };
  if (opts.transport !== undefined) source.transport = opts.transport;
  if (opts.mcpServer !== undefined) source.mcpServer = opts.mcpServer;
  if (opts.credentials !== undefined) source.credentials = opts.credentials;
  if (opts.adapterModule !== undefined) source.adapterModule = opts.adapterModule;
  if (opts.scope !== undefined) source.scope = opts.scope;

  cfg.sources.push(source);
  await saveSourcesConfig(workspaceRoot, cfg);
  return source;
}

/** Remove a source by id. Returns the removed entry. */
export async function removeSource(workspaceRoot: string, id: string): Promise<Source> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx === -1) throw new SourceNotFoundError(id);
  const [removed] = cfg.sources.splice(idx, 1);
  await saveSourcesConfig(workspaceRoot, cfg);
  return removed;
}

/** Toggle a source's enabled flag. Returns the updated entry. */
export async function setSourceEnabled(
  workspaceRoot: string,
  id: string,
  enabled: boolean
): Promise<Source> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const source = cfg.sources.find((s) => s.id === id);
  if (!source) throw new SourceNotFoundError(id);
  source.enabled = enabled;
  await saveSourcesConfig(workspaceRoot, cfg);
  return source;
}

/** List all registered sources. */
export async function listSources(workspaceRoot: string): Promise<Source[]> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  return cfg.sources;
}
