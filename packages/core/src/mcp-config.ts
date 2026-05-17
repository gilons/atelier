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
   * Conventional tool names used by Atelier when this server backs a
   * source. The adapter calls `tools.list` for enumeration and
   * `tools.fetch` for a single doc's content. Users can override per
   * server if their server names tools differently.
   */
  tools?: {
    list?: string;
    fetch?: string;
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
        if (typeof t.list !== "string") {
          throw new Error(`${contextPath}: servers.${id}.tools.list must be a string`);
        }
        out.tools.list = t.list;
      }
      if (t.fetch !== undefined) {
        if (typeof t.fetch !== "string") {
          throw new Error(`${contextPath}: servers.${id}.tools.fetch must be a string`);
        }
        out.tools.fetch = t.fetch;
      }
    }
    servers[id] = out;
  }
  return { version: 1, servers };
}
