import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Local-only secret store for an Atelier workspace.
 *
 * Atelier never persists secret values to `sources.yaml` /
 * `repos.yaml` — those files are tracked by git and shared with
 * teammates. Secrets live in `.planning/.env` instead, which sits
 * next to those configs but is auto-added to `.planning/.gitignore`
 * so it stays on the developer's machine.
 *
 * Why a per-workspace store rather than a global keychain or a
 * shell rc:
 *
 *   - **Per-workspace.** One developer may have multiple Atelier
 *     workspaces (work tenant, side project, demo); each gets its
 *     own SharePoint app, Notion token, etc. Stuffing everything
 *     into `~/.zshrc` collides on env-var names.
 *
 *   - **Local-only.** The user explicitly opted into a "single
 *     machine, single user" setup by running `atelier init`. We
 *     match the model rather than dragging in an OS keychain
 *     dependency. (Keychain integration is a future option for
 *     teams that want sharable encrypted secrets.)
 *
 *   - **Familiar format.** `.env` files are well-understood;
 *     Atelier's writer + parser is intentionally tiny so users
 *     can hand-edit if they prefer.
 *
 * Load order at sync time: {@link loadIntoProcessEnv} reads the
 * file and copies each key into `process.env` only if the key is
 * NOT already set. That way an explicit `export FOO=bar` in CI
 * or shell rc always wins — useful for ephemeral overrides
 * during debugging.
 */

const ENV_FILE_BASENAME = ".env";

export class SecretStore {
  /** Absolute path to the workspace root (the directory CONTAINING `.planning/`). */
  readonly workspaceRoot: string;
  /** Absolute path to the secret file. */
  readonly envPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.envPath = path.join(workspaceRoot, ".planning", ENV_FILE_BASENAME);
  }

  /** Read one secret. Returns undefined when the file or key is missing. */
  async read(key: string): Promise<string | undefined> {
    const map = await this.readAll();
    return map.get(key);
  }

  /** Read every key. Returns an empty map if the file doesn't exist. */
  async readAll(): Promise<Map<string, string>> {
    let text: string;
    try {
      text = await fs.readFile(this.envPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw err;
    }
    return parseEnv(text);
  }

  /**
   * Add or replace one secret. Creates the file (and the
   * `.gitignore` entry that protects it) if neither exists.
   * Idempotent: rewriting the same value is a no-op.
   */
  async write(key: string, value: string): Promise<void> {
    if (!isValidEnvKey(key)) {
      throw new Error(
        `SecretStore.write: "${key}" isn't a valid env var name (must match /^[A-Z_][A-Z0-9_]*$/i).`
      );
    }
    const map = await this.readAll();
    map.set(key, value);
    await this.ensureFileShape();
    await fs.writeFile(this.envPath, formatEnv(map), "utf8");
  }

  /** Add or replace many secrets in one write. */
  async writeMany(entries: Array<{ name: string; value: string }>): Promise<void> {
    if (entries.length === 0) return;
    for (const e of entries) {
      if (!isValidEnvKey(e.name)) {
        throw new Error(
          `SecretStore.writeMany: "${e.name}" isn't a valid env var name.`
        );
      }
    }
    const map = await this.readAll();
    for (const e of entries) map.set(e.name, e.value);
    await this.ensureFileShape();
    await fs.writeFile(this.envPath, formatEnv(map), "utf8");
  }

  /** Remove a key. No-op when the key isn't present. */
  async delete(key: string): Promise<void> {
    const map = await this.readAll();
    if (!map.has(key)) return;
    map.delete(key);
    await fs.writeFile(this.envPath, formatEnv(map), "utf8");
  }

  /**
   * Copy every key from the store into `process.env` UNLESS the
   * key is already set (an explicit export from the shell or CI
   * always wins). Call this once at command bootstrap; everything
   * downstream — adapter credential resolvers, token providers,
   * `resolveCredential` — keeps reading from `process.env` and
   * gets the right value transparently.
   *
   * Returns the keys that were actually copied so callers can
   * log "loaded N secrets from .planning/.env" for diagnostics.
   */
  async loadIntoProcessEnv(
    env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
  ): Promise<string[]> {
    const map = await this.readAll();
    const loaded: string[] = [];
    for (const [k, v] of map) {
      if (env[k] === undefined || env[k] === "") {
        env[k] = v;
        loaded.push(k);
      }
    }
    return loaded;
  }

  /**
   * Ensure `.planning/.env` is in `.planning/.gitignore`. Idempotent;
   * appends one line if the entry is missing, leaves the file alone
   * otherwise. Creates `.gitignore` if it doesn't exist — newer
   * workspaces ship one (see workspace.ts) but very old ones may
   * predate it.
   */
  private async ensureFileShape(): Promise<void> {
    const dir = path.dirname(this.envPath);
    await fs.mkdir(dir, { recursive: true });
    const gitignorePath = path.join(dir, ".gitignore");
    let current = "";
    try {
      current = await fs.readFile(gitignorePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!hasEnvIgnoreEntry(current)) {
      const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      const addition =
        (current.length === 0 ? "" : sep) +
        "# Local secrets written by `atelier source onboard`. Never commit.\n" +
        ".env\n";
      await fs.writeFile(gitignorePath, current + addition, "utf8");
    }
  }
}

// ============================================================
// .env parser + writer — minimal, deliberately not a runtime dep
// ============================================================

/**
 * Parse `.env` text into a Map. Tolerant: ignores blank lines and
 * `#`-comments, trims whitespace, strips surrounding single/double
 * quotes from the value. Values may contain `=` (only the FIRST
 * `=` is the separator). Anything that doesn't match `KEY=VALUE`
 * is skipped quietly — same behavior as dotenv / docker-compose.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidEnvKey(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes — `KEY="value"`
    // and `KEY='value'` are both common in dotenv files. Double-
    // quoted values also support backslash escapes for embedded
    // quotes and backslashes so the writer can round-trip values
    // containing quotes (`A="has\"quote"` → `has"quote`).
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      // Single-quoted values are taken literally — same convention
      // as POSIX shells. No escape processing.
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Serialize a key→value map back into dotenv text. Values
 * containing whitespace, `#`, or `"` get double-quoted with
 * embedded quotes/backslashes escaped — round-trips cleanly
 * through {@link parseEnv}.
 */
export function formatEnv(map: Map<string, string>): string {
  const lines: string[] = [
    "# Managed by atelier — secrets and per-workspace config.",
    "# Edits are preserved; lines are key=value or # comments.",
    "",
  ];
  // Stable order: alphabetical. Keeps diffs minimal across writes.
  const keys = [...map.keys()].sort();
  for (const k of keys) {
    lines.push(`${k}=${formatValue(map.get(k)!)}`);
  }
  return lines.join("\n") + "\n";
}

function formatValue(v: string): string {
  // Quote when the value would be ambiguous without it.
  const needsQuote = /[\s#"'\\]/.test(v) || v.length === 0;
  if (!needsQuote) return v;
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/i.test(key);
}

function hasEnvIgnoreEntry(gitignore: string): boolean {
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === ".env" || line === "/.env" || line === "*.env") return true;
  }
  return false;
}
