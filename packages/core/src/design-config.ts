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
export interface DesignToolConfig {
  version: 1;
  /**
   * The platform. Free-form so teams can name any AI-drivable tool;
   * common values: "figma", "excalidraw", "lucidchart", "markdown".
   */
  tool: string;
  /**
   * Optional id of the registered `design` source that backs this
   * tool (where its connection runbook lives). Omitted for the
   * "markdown" tool, which needs no source.
   */
  sourceId?: string;
  /** Optional free-form note — how it's driven, key file ids, etc. */
  notes?: string;
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

function validate(raw: unknown, file: string): DesignToolConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignConfigError(`${file}: expected a YAML object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.tool !== "string" || r.tool.length === 0) {
    throw new DesignConfigError(`${file}: \`tool\` must be a non-empty string`);
  }
  if (r.sourceId !== undefined && (typeof r.sourceId !== "string" || !r.sourceId)) {
    throw new DesignConfigError(`${file}: \`sourceId\`, if present, must be a non-empty string`);
  }
  if (r.notes !== undefined && typeof r.notes !== "string") {
    throw new DesignConfigError(`${file}: \`notes\`, if present, must be a string`);
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    tool: r.tool,
    sourceId: typeof r.sourceId === "string" ? r.sourceId : undefined,
    notes: typeof r.notes === "string" ? r.notes : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
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
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const file = designConfigPath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: Record<string, unknown> = { version: 1, tool: cfg.tool };
  if (cfg.sourceId) out.sourceId = cfg.sourceId;
  if (cfg.notes) out.notes = cfg.notes;
  out.createdAt = cfg.createdAt;
  out.updatedAt = cfg.updatedAt;
  await writeYamlFile(
    file,
    out,
    "Atelier system-design tool for this workspace.\n" +
      "Read by the system-design agent to know what drives the design\n" +
      "work. Set with `atelier design-tool set <tool>`; clear with\n" +
      "`atelier design-tool clear`."
  );
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
