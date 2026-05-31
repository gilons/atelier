import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";

/**
 * Per-discipline design configuration (`.atelier/design.yaml`).
 *
 * "design" is an umbrella over disciplines (system-design, ui-design,
 * and any the team adds). Each discipline picks its own tool and tunes
 * its own live companion — UI design might use Figma while system
 * design uses Excalidraw — so the config is keyed by discipline.
 *
 * Back-compat: the original flat shape ({ tool, live, … } at the top)
 * is read as the `system-design` discipline, so existing workspaces
 * keep working and `atelier design tool set <tool>` (no --discipline)
 * targets system-design by default.
 */

/** The discipline targeted when --discipline is omitted. */
export const DEFAULT_DISCIPLINE = "system-design";

/** Tuning for a discipline's live companion (two-track latency design). */
export interface DesignLiveConfig {
  /** Chunks a topic must stay stable before the slow track renders (agent default ~2). */
  stabilityChunks?: number;
  /** Fast STT model used on the live hot path (e.g. "tiny", "base"). */
  model?: string;
}

/** One discipline's settings. */
export interface DisciplineConfig {
  /** The platform driving this discipline ("figma", "excalidraw", "markdown", …). */
  tool?: string;
  /** Id of the registered `design` source backing the tool. */
  sourceId?: string;
  /** Free-form note (how it's driven, key file ids). */
  notes?: string;
  /** Live-companion tuning. */
  live?: DesignLiveConfig;
}

export interface DesignConfig {
  version: 1;
  /** Settings keyed by discipline id. */
  disciplines: Record<string, DisciplineConfig>;
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

// ============================================================
// Validation + migration
// ============================================================

function validateLive(raw: unknown, where: string): DesignLiveConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${where}.live, if present, must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const live: DesignLiveConfig = {};
  if (r.stabilityChunks !== undefined) {
    if (typeof r.stabilityChunks !== "number" || !Number.isInteger(r.stabilityChunks) || r.stabilityChunks < 1) {
      throw new DesignConfigError(`${where}.live.stabilityChunks must be a positive integer`);
    }
    live.stabilityChunks = r.stabilityChunks;
  }
  if (r.model !== undefined) {
    if (typeof r.model !== "string" || !r.model) {
      throw new DesignConfigError(`${where}.live.model, if present, must be a non-empty string`);
    }
    live.model = r.model;
  }
  return Object.keys(live).length > 0 ? live : undefined;
}

function validateDiscipline(raw: unknown, where: string): DisciplineConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${where} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.tool !== undefined && (typeof r.tool !== "string" || !r.tool)) {
    throw new DesignConfigError(`${where}.tool, if present, must be a non-empty string`);
  }
  if (r.sourceId !== undefined && (typeof r.sourceId !== "string" || !r.sourceId)) {
    throw new DesignConfigError(`${where}.sourceId, if present, must be a non-empty string`);
  }
  if (r.notes !== undefined && typeof r.notes !== "string") {
    throw new DesignConfigError(`${where}.notes, if present, must be a string`);
  }
  const out: DisciplineConfig = {};
  if (typeof r.tool === "string") out.tool = r.tool;
  if (typeof r.sourceId === "string") out.sourceId = r.sourceId;
  if (typeof r.notes === "string") out.notes = r.notes;
  const live = validateLive(r.live, where);
  if (live) out.live = live;
  return out;
}

function validate(raw: unknown, file: string): DesignConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${file}: expected a YAML object`);
  }
  const r = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const disciplines: Record<string, DisciplineConfig> = {};

  if (r.disciplines !== undefined) {
    if (typeof r.disciplines !== "object" || r.disciplines === null || Array.isArray(r.disciplines)) {
      throw new DesignConfigError(`${file}: \`disciplines\` must be a map`);
    }
    for (const [id, dRaw] of Object.entries(r.disciplines as Record<string, unknown>)) {
      disciplines[id] = validateDiscipline(dRaw, `${file}: disciplines.${id}`);
    }
  } else if (r.tool !== undefined || r.live !== undefined || r.sourceId !== undefined || r.notes !== undefined) {
    // Back-compat: the old flat shape is the system-design discipline.
    disciplines[DEFAULT_DISCIPLINE] = validateDiscipline(r, file);
  }

  return {
    version: 1,
    disciplines,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
}

// ============================================================
// Load
// ============================================================

/** Load the full per-discipline design config. Null when unset. */
export async function loadDesignConfig(workspaceRoot: string): Promise<DesignConfig | null> {
  const file = designConfigPath(workspaceRoot);
  const raw = await readYamlFile(file);
  if (raw === null) return null;
  return validate(raw, file);
}

/** Load one discipline's config (default system-design). Null when unset. */
export async function loadDisciplineConfig(
  workspaceRoot: string,
  discipline: string = DEFAULT_DISCIPLINE
): Promise<DisciplineConfig | null> {
  const cfg = await loadDesignConfig(workspaceRoot);
  if (!cfg) return null;
  return cfg.disciplines[discipline] ?? null;
}

// ============================================================
// Write
// ============================================================

function isEmptyDiscipline(d: DisciplineConfig): boolean {
  return !d.tool && !d.sourceId && !d.notes && (!d.live || Object.keys(d.live).length === 0);
}

async function writeDesignConfig(workspaceRoot: string, cfg: DesignConfig): Promise<void> {
  const file = designConfigPath(workspaceRoot);
  // Drop empty discipline entries.
  const disciplines: Record<string, DisciplineConfig> = {};
  for (const [id, d] of Object.entries(cfg.disciplines)) {
    if (!isEmptyDiscipline(d)) disciplines[id] = d;
  }
  // Nothing left → remove the file entirely.
  if (Object.keys(disciplines).length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const outDisciplines: Record<string, unknown> = {};
  for (const [id, d] of Object.entries(disciplines)) {
    const o: Record<string, unknown> = {};
    if (d.tool) o.tool = d.tool;
    if (d.sourceId) o.sourceId = d.sourceId;
    if (d.notes) o.notes = d.notes;
    if (d.live && Object.keys(d.live).length > 0) {
      const live: Record<string, unknown> = {};
      if (d.live.stabilityChunks !== undefined) live.stabilityChunks = d.live.stabilityChunks;
      if (d.live.model !== undefined) live.model = d.live.model;
      o.live = live;
    }
    outDisciplines[id] = o;
  }
  await writeYamlFile(
    file,
    { version: 1, disciplines: outDisciplines, createdAt: cfg.createdAt, updatedAt: cfg.updatedAt },
    "Atelier design config — per discipline (system-design, ui-design, …).\n" +
      "Each discipline picks its tool + tunes its live companion. Manage\n" +
      "with `atelier design tool …` / `atelier design live …` (pass\n" +
      "--discipline to target one; defaults to system-design)."
  );
}

async function mutate(
  workspaceRoot: string,
  discipline: string,
  fn: (d: DisciplineConfig) => void
): Promise<DisciplineConfig> {
  const existing = (await loadDesignConfig(workspaceRoot).catch(() => null)) ?? {
    version: 1 as const,
    disciplines: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const d: DisciplineConfig = { ...(existing.disciplines[discipline] ?? {}) };
  fn(d);
  const next: DesignConfig = {
    version: 1,
    disciplines: { ...existing.disciplines, [discipline]: d },
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeDesignConfig(workspaceRoot, next);
  return d;
}

// ============================================================
// Mutators
// ============================================================

export interface SetDesignToolOptions {
  tool: string;
  sourceId?: string;
  notes?: string;
  /** Discipline to target. Defaults to system-design. */
  discipline?: string;
}

export async function setDesignTool(
  workspaceRoot: string,
  opts: SetDesignToolOptions
): Promise<DisciplineConfig> {
  if (!opts.tool || !opts.tool.trim()) {
    throw new DesignConfigError("tool is required");
  }
  return mutate(workspaceRoot, opts.discipline ?? DEFAULT_DISCIPLINE, (d) => {
    d.tool = opts.tool.trim();
    d.sourceId = opts.sourceId?.trim() || undefined;
    d.notes = opts.notes?.trim() || undefined;
  });
}

export interface SetLiveConfigOptions {
  discipline?: string;
  stabilityChunks?: number | null;
  model?: string | null;
}

export async function setLiveConfig(
  workspaceRoot: string,
  opts: SetLiveConfigOptions
): Promise<DisciplineConfig> {
  return mutate(workspaceRoot, opts.discipline ?? DEFAULT_DISCIPLINE, (d) => {
    const live: DesignLiveConfig = { ...(d.live ?? {}) };
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
    d.live = Object.keys(live).length > 0 ? live : undefined;
  });
}

/**
 * Clear a discipline's settings (default system-design). Returns true
 * when something was removed. If no disciplines remain, the file is
 * deleted.
 */
export async function clearDesignTool(
  workspaceRoot: string,
  discipline: string = DEFAULT_DISCIPLINE
): Promise<boolean> {
  const existing = await loadDesignConfig(workspaceRoot).catch(() => null);
  if (!existing || !existing.disciplines[discipline]) return false;
  const disciplines = { ...existing.disciplines };
  delete disciplines[discipline];
  await writeDesignConfig(workspaceRoot, { ...existing, disciplines, updatedAt: new Date().toISOString() });
  return true;
}
