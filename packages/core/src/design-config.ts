import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";

/**
 * The workspace's chosen system-design tool.
 *
 * The system-design agent needs to know which platform drives the
 * design work (Figma / Excalidraw / Lucidchart / … or "markdown" when
 * the team uses none). It can infer this from registered `design`
 * sources + its own learnings, but an explicit, queryable setting
 * makes detection deterministic — and gives the user a single place
 * to declare "this is our design tool."
 *
 * Stored at `.atelier/design.yaml`. Optional: when absent, the agent
 * falls back to inferring from sources, then to Markdown.
 */
/**
 * Tuning for the system-design agent's live companion mode — the
 * knobs behind the two-track latency design.
 */
export interface DesignLiveConfig {
  /**
   * How many consecutive chunks a topic must stay stable before the
   * slow track renders a diagram. Higher = calmer on volatile calls,
   * laggier on steady ones. The agent's default is ~2.
   */
  stabilityChunks?: number;
  /**
   * STT model to use on the live hot path (e.g. "tiny", "base") —
   * traded for speed; the durable record is re-transcribed accurately
   * at finalize.
   */
  model?: string;
}

export interface DesignToolConfig {
  version: 1;
  /**
   * The platform. Free-form so teams can name any AI-drivable tool;
   * common values: "figma", "excalidraw", "lucidchart", "markdown".
   * Optional: a config may carry only `live` tuning with no tool yet.
   */
  tool?: string;
  /**
   * Optional id of the registered `design` source that backs this
   * tool (where its connection runbook lives). Omitted for the
   * "markdown" tool, which needs no source.
   */
  sourceId?: string;
  /** Optional free-form note — how it's driven, key file ids, etc. */
  notes?: string;
  /** Optional live-companion tuning (stability gate, live STT model). */
  live?: DesignLiveConfig;
  createdAt: string;
  updatedAt: string;
}

const DESIGN_CONFIG_FILE = "design.yaml";

function designConfigPath(workspaceRoot: string): string {
  return path.join(workspacePaths(workspaceRoot).atelier, DESIGN_CONFIG_FILE);
}

export class DesignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignConfigError";
  }
}

function validateLive(raw: unknown, file: string): DesignLiveConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${file}: \`live\`, if present, must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const live: DesignLiveConfig = {};
  if (r.stabilityChunks !== undefined) {
    if (
      typeof r.stabilityChunks !== "number" ||
      !Number.isInteger(r.stabilityChunks) ||
      r.stabilityChunks < 1
    ) {
      throw new DesignConfigError(`${file}: \`live.stabilityChunks\` must be a positive integer`);
    }
    live.stabilityChunks = r.stabilityChunks;
  }
  if (r.model !== undefined) {
    if (typeof r.model !== "string" || !r.model) {
      throw new DesignConfigError(`${file}: \`live.model\`, if present, must be a non-empty string`);
    }
    live.model = r.model;
  }
  return Object.keys(live).length > 0 ? live : undefined;
}

function validate(raw: unknown, file: string): DesignToolConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${file}: expected a YAML object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.tool !== undefined && (typeof r.tool !== "string" || r.tool.length === 0)) {
    throw new DesignConfigError(`${file}: \`tool\`, if present, must be a non-empty string`);
  }
  if (r.sourceId !== undefined && (typeof r.sourceId !== "string" || !r.sourceId)) {
    throw new DesignConfigError(`${file}: \`sourceId\`, if present, must be a non-empty string`);
  }
  if (r.notes !== undefined && typeof r.notes !== "string") {
    throw new DesignConfigError(`${file}: \`notes\`, if present, must be a string`);
  }
  const live = validateLive(r.live, file);
  const now = new Date().toISOString();
  return {
    version: 1,
    tool: typeof r.tool === "string" ? r.tool : undefined,
    sourceId: typeof r.sourceId === "string" ? r.sourceId : undefined,
    notes: typeof r.notes === "string" ? r.notes : undefined,
    live,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
}

/** Serialize a config to the ordered object we persist (+ write it). */
async function writeDesignConfig(
  workspaceRoot: string,
  cfg: DesignToolConfig
): Promise<void> {
  const file = designConfigPath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: Record<string, unknown> = { version: 1 };
  if (cfg.tool) out.tool = cfg.tool;
  if (cfg.sourceId) out.sourceId = cfg.sourceId;
  if (cfg.notes) out.notes = cfg.notes;
  if (cfg.live && Object.keys(cfg.live).length > 0) {
    const live: Record<string, unknown> = {};
    if (cfg.live.stabilityChunks !== undefined) live.stabilityChunks = cfg.live.stabilityChunks;
    if (cfg.live.model !== undefined) live.model = cfg.live.model;
    out.live = live;
  }
  out.createdAt = cfg.createdAt;
  out.updatedAt = cfg.updatedAt;
  await writeYamlFile(
    file,
    out,
    "Atelier system-design config for this workspace.\n" +
      "`tool` is what drives the design work; `live` tunes the live\n" +
      "companion (stability gate, live STT model). Manage with\n" +
      "`atelier design-tool …` and `atelier design live …`."
  );
}

/** Load the design-tool setting. Returns null when unset. */
export async function loadDesignConfig(
  workspaceRoot: string
): Promise<DesignToolConfig | null> {
  const file = designConfigPath(workspaceRoot);
  const raw = await readYamlFile(file);
  if (raw === null) return null;
  return validate(raw, file);
}

export interface SetDesignToolOptions {
  tool: string;
  sourceId?: string;
  notes?: string;
}

/**
 * Set (or replace) the workspace's design-tool setting. Preserves the
 * original createdAt when one already exists.
 */
export async function setDesignTool(
  workspaceRoot: string,
  opts: SetDesignToolOptions
): Promise<DesignToolConfig> {
  if (!opts.tool || !opts.tool.trim()) {
    throw new DesignConfigError("tool is required");
  }
  const existing = await loadDesignConfig(workspaceRoot).catch(() => null);
  const now = new Date().toISOString();
  const cfg: DesignToolConfig = {
    version: 1,
    tool: opts.tool.trim(),
    sourceId: opts.sourceId?.trim() || undefined,
    notes: opts.notes?.trim() || undefined,
    live: existing?.live, // preserve live tuning across tool changes
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeDesignConfig(workspaceRoot, cfg);
  return cfg;
}

export interface SetLiveConfigOptions {
  stabilityChunks?: number;
  model?: string;
}

/**
 * Set (or merge) the live-companion tuning, preserving the tool
 * config. Works even when no tool has been chosen yet — the config
 * may carry only `live`. Pass a field as null to clear just it.
 */
export async function setLiveConfig(
  workspaceRoot: string,
  opts: { stabilityChunks?: number | null; model?: string | null }
): Promise<DesignToolConfig> {
  const existing = await loadDesignConfig(workspaceRoot).catch(() => null);
  const now = new Date().toISOString();
  const live: DesignLiveConfig = { ...(existing?.live ?? {}) };
  if (opts.stabilityChunks !== undefined) {
    if (opts.stabilityChunks === null) {
      delete live.stabilityChunks;
    } else {
      if (!Number.isInteger(opts.stabilityChunks) || opts.stabilityChunks < 1) {
        throw new DesignConfigError("stabilityChunks must be a positive integer");
      }
      live.stabilityChunks = opts.stabilityChunks;
    }
  }
  if (opts.model !== undefined) {
    if (opts.model === null || !opts.model.trim()) delete live.model;
    else live.model = opts.model.trim();
  }
  const cfg: DesignToolConfig = {
    version: 1,
    tool: existing?.tool,
    sourceId: existing?.sourceId,
    notes: existing?.notes,
    live: Object.keys(live).length > 0 ? live : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeDesignConfig(workspaceRoot, cfg);
  return cfg;
}

/** Remove the design-tool setting. Returns true when a file was deleted. */
export async function clearDesignTool(workspaceRoot: string): Promise<boolean> {
  const file = designConfigPath(workspaceRoot);
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
