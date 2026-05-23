import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { validateSourcesConfig, formatIssues } from "./validation.js";
import { workspacePaths } from "./paths.js";
import { WorkspaceValidationError } from "./workspace.js";
import type { SourcesConfig, Source } from "./types.js";

/**
 * High-level operations on the documentation source registry
 * (`.atelier/sources.yaml`).
 *
 * A "source" in atelier's model is just a named bucket with a
 * free-form `config` blob and an optional connection runbook
 * (`setupFile` pointing at `.atelier/sources/<id>/setup.md`).
 * Atelier never talks to source systems — the agent does, using
 * whatever's in `config` to drive its own MCP / browser-ext /
 * REST integrations. So this module is purely about CRUD on the
 * registry + the sidecar setup.md files; no auth, no fetching.
 */

const SOURCES_HEADER =
  "Documentation sources the agent uses (Notion, SharePoint, GDocs, …).\n" +
  "Each source records the config the agent needs at fetch time + a\n" +
  "pointer to a setup runbook the agent reads to connect for the\n" +
  "first time. Use `atelier source register` rather than editing by\n" +
  "hand so the setup file gets created alongside this registry.";

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

/** Load and validate the source registry. */
export async function loadSourcesConfig(workspaceRoot: string): Promise<SourcesConfig> {
  const p = workspacePaths(workspaceRoot);
  const raw = (await readYamlFile(p.sourcesConfig)) ?? { version: 2, sources: [] };
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

export interface RegisterSourceOptions {
  /** Stable identifier. Required — the agent uses this when adding docs. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /**
   * Free-form parameters the agent reads at fetch time. Atelier
   * stores this verbatim; we don't interpret any keys.
   */
  config?: Record<string, unknown>;
  /**
   * Markdown connection runbook content. When provided, we write it
   * to `.atelier/sources/<id>/setup.md` and persist the relative
   * path in the source's `setupFile` field. Pass `null` (or omit)
   * to skip — useful when the source needs no setup (an existing
   * MCP server that's already wired up tenant-wide, for instance).
   */
  setupInstructions?: string;
  /** Whether the source is active. Defaults to true. */
  enabled?: boolean;
}

/**
 * Slug-style id derived from a name. Lowercase, alphanumeric+hyphens.
 * Exposed so the CLI can suggest a default id from `--name` when the
 * user doesn't pass one.
 */
export function deriveSourceId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "source";
}

/**
 * Register a new documentation source. Writes (a) the entry in
 * sources.yaml and (b) the optional setup.md runbook under
 * `.atelier/sources/<id>/setup.md`. Both writes happen together
 * so a partial state never lands on disk.
 *
 * Throws SourceAlreadyRegisteredError when the id collides.
 */
export async function registerSource(
  workspaceRoot: string,
  opts: RegisterSourceOptions
): Promise<Source> {
  if (!opts.id) throw new Error("RegisterSourceOptions.id is required");
  if (!opts.name) throw new Error("RegisterSourceOptions.name is required");
  const cfg = await loadSourcesConfig(workspaceRoot);
  if (cfg.sources.some((s) => s.id === opts.id)) {
    throw new SourceAlreadyRegisteredError(opts.id);
  }

  const source: Source = {
    id: opts.id,
    name: opts.name,
    enabled: opts.enabled ?? true,
  };
  if (opts.config !== undefined) source.config = opts.config;

  // Write the setup runbook first so an interrupted register call
  // doesn't leave a source pointing at a file that doesn't exist.
  // If the YAML write later fails, an orphan setup.md is harmless —
  // it's just markdown sitting in a workspace folder.
  if (opts.setupInstructions !== undefined && opts.setupInstructions.length > 0) {
    const rel = path.posix.join("sources", opts.id, "setup.md");
    const abs = path.join(workspacePaths(workspaceRoot).atelier, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, opts.setupInstructions, "utf8");
    source.setupFile = rel;
  }

  cfg.sources.push(source);
  await saveSourcesConfig(workspaceRoot, cfg);
  return source;
}

/**
 * Read the contents of a source's setup.md, if any. Returns null
 * when the source isn't registered or has no setupFile, OR when
 * the referenced file doesn't exist on disk (e.g. it was deleted
 * manually). The agent uses this to read its connection runbook.
 */
export async function readSourceSetup(
  workspaceRoot: string,
  id: string
): Promise<string | null> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const source = cfg.sources.find((s) => s.id === id);
  if (!source || !source.setupFile) return null;
  const abs = path.join(workspacePaths(workspaceRoot).atelier, source.setupFile);
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Replace an existing source's metadata. The caller passes the full
 * next shape; we force the persisted id to match the lookup id so
 * accidental renames don't slip through.
 */
export async function updateSource(
  workspaceRoot: string,
  id: string,
  next: Source
): Promise<Source> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx === -1) throw new SourceNotFoundError(id);
  cfg.sources[idx] = { ...next, id };
  await saveSourcesConfig(workspaceRoot, cfg);
  return cfg.sources[idx];
}

/**
 * Replace just the setup.md runbook for an existing source. The
 * source entry's setupFile pointer is added if it was previously
 * unset. Pass null to remove the runbook entirely.
 */
export async function updateSourceSetup(
  workspaceRoot: string,
  id: string,
  setupInstructions: string | null
): Promise<Source> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx === -1) throw new SourceNotFoundError(id);
  const source = cfg.sources[idx];
  const rel = path.posix.join("sources", id, "setup.md");
  const abs = path.join(workspacePaths(workspaceRoot).atelier, rel);
  if (setupInstructions === null) {
    if (source.setupFile) {
      const oldAbs = path.join(workspacePaths(workspaceRoot).atelier, source.setupFile);
      try {
        await fs.unlink(oldAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      delete source.setupFile;
    }
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, setupInstructions, "utf8");
    source.setupFile = rel;
  }
  await saveSourcesConfig(workspaceRoot, cfg);
  return source;
}

/**
 * Remove a source by id. Also deletes its sidecar setup runbook
 * (best-effort — a missing file is fine). Returns the removed
 * entry so callers can show "removed `<name>`" to the user.
 */
export async function removeSource(workspaceRoot: string, id: string): Promise<Source> {
  const cfg = await loadSourcesConfig(workspaceRoot);
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx === -1) throw new SourceNotFoundError(id);
  const [removed] = cfg.sources.splice(idx, 1);
  await saveSourcesConfig(workspaceRoot, cfg);
  // Best-effort cleanup of the source's directory (which holds
  // setup.md and possibly future agent-curated sidecars).
  const dir = path.join(workspacePaths(workspaceRoot).atelier, "sources", id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* harmless — agents may have put unrelated files there */
  }
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
