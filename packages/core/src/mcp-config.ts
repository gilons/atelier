import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * MCP-server configuration that lives at `~/.atelier/mcp-servers.json`.
 *
 * Design choice (Slice 8): explicit config file the user populates
 * once. We considered:
 *   A) Auto-discover from Claude Desktop's config — brittle, varies
 *      across OSes, locks users into one client.
 *   B) Require Atelier to run inside an MCP-aware host — constrains
 *      where the CLI can be invoked.
 *   C) Explicit ~/.atelier/mcp-servers.json — chosen.
 *
 * (C) keeps the user in control, makes the wiring observable, and
 * matches how dev tools like Claude Desktop and Cursor already model
 * MCP servers. The file is sibling to the registered sources but
 * lives at the user level rather than per-workspace because the same
 * MCP server typically serves many workspaces.
 */

export const ATELIER_HOME_DIR = path.join(os.homedir(), ".atelier");
export const MCP_SERVERS_FILE = path.join(ATELIER_HOME_DIR, "mcp-servers.json");

/**
 * A field-mapping spec for adapting an arbitrary MCP tool's
 * response into the shape Atelier's source adapter expects.
 * Each value is a dot-path applied to the tool's raw response (or,
 * inside `docId/title/...` for list, applied to each docs-array
 * item). Paths may start with the optional sentinel `$.` (JSONPath-
 * style root marker, accepted for familiarity).
 *
 * Used when the configured MCP server doesn't natively return
 * Atelier's expected shape — common when wrapping a SharePoint /
 * Confluence / etc. MCP server built for general use.
 */
export interface McpListMapping {
  /**
   * Path to the array of doc-like items in the raw response.
   * Defaults to the response root if omitted (the tool already
   * returns an array, or already a `{docs: [...]}` shape).
   */
  docs?: string;
  /** Path inside each item that yields the docId (required when mapping). */
  docId?: string;
  /** Path inside each item for the title. */
  title?: string;
  /** Path inside each item for the URL. */
  url?: string;
  /** Path inside each item for the last-modified timestamp. */
  lastModified?: string;
  /** Path inside each item for an optional short summary. */
  summary?: string;
  /** Path inside each item for an opaque content hash, when the server exposes one. */
  contentHash?: string;
}

export interface McpFetchMapping {
  /** Path to the doc body (markdown / text). Required when mapping. */
  body?: string;
  /** Path to the title in the response. */
  title?: string;
  /** Path to the URL. */
  url?: string;
  /** Path to the doc summary. */
  summary?: string;
  /** Path to the content hash. */
  contentHash?: string;
}

export interface McpToolBinding {
  /** Tool name on the server. */
  name: string;
  /**
   * Static arguments to pass through to the tool on every call,
   * merged with the request-time arguments (scope for list, docId
   * for fetch). Used for things like `{ siteUrl, listTitle }` that
   * never change.
   */
  args?: Record<string, unknown>;
  /**
   * For fetch only: the parameter name the tool expects the docId
   * under. Defaults to `"docId"`. Common alternatives:
   * `"fileRelativeUrl"`, `"itemId"`, `"path"`.
   */
  argKey?: string;
  /** Optional response-shape mapping. */
  map?: McpListMapping | McpFetchMapping;
}

/**
 * Definition of a single MCP server. Mirrors the conventional shape
 * Claude Desktop and others use, with extras for Atelier's wiring.
 */
export interface McpServerDef {
  /**
   * The shell command to spawn the server. The default transport is
   * stdio; we don't model SSE in v1 because nothing we ship needs it.
   */
  command: string;
  /** Arguments passed verbatim to `command`. */
  args?: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Optional human description. */
  description?: string;
  /**
   * How Atelier reaches the list-docs and fetch-doc capabilities on
   * this server. Each value is either:
   *
   *   - a string (just the tool name; response shape must already
   *     match Atelier's expected `{docs: [...]}` / `{body, ...}` form), or
   *
   *   - a {@link McpToolBinding} (tool name + static args + an
   *     optional response-shape mapping). Use the binding form when
   *     plugging in a third-party MCP server whose tools return a
   *     different shape from Atelier's native one.
   */
  tools?: {
    list?: string | McpToolBinding;
    fetch?: string | McpToolBinding;
  };
}

export interface McpServersConfig {
  /** Schema version for future migrations. */
  version: 1;
  /** Map from server id (free choice) to definition. */
  servers: Record<string, McpServerDef>;
}

const EMPTY: McpServersConfig = { version: 1, servers: {} };

/**
 * Add (or overwrite) one server in the user-level config, creating
 * the file if missing. Used by `atelier source onboard` when the
 * user picks the MCP transport.
 */
export async function upsertMcpServer(
  id: string,
  def: McpServerDef
): Promise<McpServersConfig> {
  const current = await loadMcpServersConfig();
  current.servers[id] = def;
  await writeMcpServersConfig(current);
  return current;
}

/** Persist the MCP servers config (creates `~/.atelier/` if needed). */
export async function writeMcpServersConfig(cfg: McpServersConfig): Promise<void> {
  await fs.mkdir(ATELIER_HOME_DIR, { recursive: true });
  await fs.writeFile(MCP_SERVERS_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Load the MCP servers config. Returns an empty config (no servers
 * declared) when the file is missing — that's the expected state for
 * a fresh install.
 */
export async function loadMcpServersConfig(): Promise<McpServersConfig> {
  let text: string;
  try {
    text = await fs.readFile(MCP_SERVERS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${MCP_SERVERS_FILE}: invalid JSON — ${(err as Error).message}`
    );
  }
  return normalizeMcpServersConfig(parsed, MCP_SERVERS_FILE);
}

/** Validate-and-normalize an arbitrary JS value into a config. */
export function normalizeMcpServersConfig(
  raw: unknown,
  contextPath: string
): McpServersConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${contextPath}: expected a top-level JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`${contextPath}: "version" must be the integer 1`);
  }
  const serversRaw = obj.servers;
  if (typeof serversRaw !== "object" || serversRaw === null || Array.isArray(serversRaw)) {
    throw new Error(`${contextPath}: "servers" must be an object`);
  }
  const servers: Record<string, McpServerDef> = {};
  for (const [id, defRaw] of Object.entries(serversRaw)) {
    if (typeof defRaw !== "object" || defRaw === null || Array.isArray(defRaw)) {
      throw new Error(`${contextPath}: servers.${id} must be an object`);
    }
    const def = defRaw as Record<string, unknown>;
    if (typeof def.command !== "string" || def.command.length === 0) {
      throw new Error(`${contextPath}: servers.${id}.command must be a non-empty string`);
    }
    const out: McpServerDef = { command: def.command };
    if (def.args !== undefined) {
      if (!Array.isArray(def.args) || def.args.some((a) => typeof a !== "string")) {
        throw new Error(`${contextPath}: servers.${id}.args must be an array of strings`);
      }
      out.args = def.args as string[];
    }
    if (def.env !== undefined) {
      if (typeof def.env !== "object" || def.env === null || Array.isArray(def.env)) {
        throw new Error(`${contextPath}: servers.${id}.env must be an object`);
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(def.env)) {
        if (typeof v !== "string") {
          throw new Error(
            `${contextPath}: servers.${id}.env.${k} must be a string`
          );
        }
        env[k] = v;
      }
      out.env = env;
    }
    if (def.description !== undefined) {
      if (typeof def.description !== "string") {
        throw new Error(`${contextPath}: servers.${id}.description must be a string`);
      }
      out.description = def.description;
    }
    if (def.tools !== undefined) {
      if (typeof def.tools !== "object" || def.tools === null || Array.isArray(def.tools)) {
        throw new Error(`${contextPath}: servers.${id}.tools must be an object`);
      }
      const t = def.tools as Record<string, unknown>;
      out.tools = {};
      if (t.list !== undefined) {
        out.tools.list = normalizeToolBinding(
          t.list,
          `${contextPath}: servers.${id}.tools.list`
        );
      }
      if (t.fetch !== undefined) {
        out.tools.fetch = normalizeToolBinding(
          t.fetch,
          `${contextPath}: servers.${id}.tools.fetch`
        );
      }
    }
    servers[id] = out;
  }
  return { version: 1, servers };
}

/**
 * Accept either a bare string ("just the tool name") or a binding
 * object ({ name, args?, argKey?, map? }). Returns the same shape
 * Atelier consumes downstream. Throws with the surrounding path
 * baked into the message so users can locate the bad field
 * quickly.
 */
function normalizeToolBinding(
  raw: unknown,
  ctxPath: string
): string | McpToolBinding {
  if (typeof raw === "string") {
    if (raw.length === 0) throw new Error(`${ctxPath} must be a non-empty string`);
    return raw;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${ctxPath} must be a string or an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error(`${ctxPath}.name must be a non-empty string`);
  }
  const out: McpToolBinding = { name: obj.name };
  if (obj.args !== undefined) {
    if (typeof obj.args !== "object" || obj.args === null || Array.isArray(obj.args)) {
      throw new Error(`${ctxPath}.args must be an object`);
    }
    out.args = obj.args as Record<string, unknown>;
  }
  if (obj.argKey !== undefined) {
    if (typeof obj.argKey !== "string" || obj.argKey.length === 0) {
      throw new Error(`${ctxPath}.argKey must be a non-empty string`);
    }
    out.argKey = obj.argKey;
  }
  if (obj.map !== undefined) {
    if (typeof obj.map !== "object" || obj.map === null || Array.isArray(obj.map)) {
      throw new Error(`${ctxPath}.map must be an object`);
    }
    const mapRaw = obj.map as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapRaw)) {
      if (typeof v !== "string") {
        throw new Error(`${ctxPath}.map.${k} must be a string (dot-path)`);
      }
      map[k] = v;
    }
    out.map = map as McpListMapping | McpFetchMapping;
  }
  return out;
}
