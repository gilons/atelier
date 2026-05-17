import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  FetchedDoc,
  RemoteDocMetadata,
  SourceAdapter,
  AdapterAvailability,
} from "./source-adapters.js";
import type { Source } from "./types.js";

/**
 * Source adapter that reads markdown files out of a local directory.
 *
 * Why ship this in v1?
 *   - It's a useful source in its own right: a repo with a `docs/`
 *     tree, the Atelier workspace's own pinned notes, or any folder
 *     of design docs.
 *   - It's a complete, testable reference for the adapter contract
 *     before we ship MCP-backed adapters. The sync engine has a real
 *     concrete adapter to talk to from day one.
 *
 * docId = the file's path relative to the folder root (with forward
 * slashes for cross-platform stability). Title comes from the first
 * H1 in the file, falling back to the filename without extension.
 */

export interface LocalFolderScope {
  /** Root directory to walk. Absolute or relative-to-cwd. */
  root: string;
  /**
   * File extensions to include (without leading dot). Defaults to
   * `["md", "markdown"]`.
   */
  extensions?: string[];
  /** Optional regex patterns (matched against the relative docId) to skip. */
  exclude?: RegExp[];
}

export class LocalFolderAdapter implements SourceAdapter {
  readonly kind = "local-folder";

  constructor(public readonly scope: LocalFolderScope) {}

  /**
   * Resolve the scope from a registered {@link Source}. The Source's
   * `scope` field must contain a `root` key (string). When the root
   * is relative, it resolves against `workspaceRoot` — that matches
   * the convention used by repo paths (`../api`).
   *
   * Optional `extensions` (string array) and `exclude` (string array
   * of regex sources) are honored.
   */
  static fromSource(source: Source, workspaceRoot?: string): LocalFolderAdapter {
    if (source.kind !== "local-folder") {
      throw new Error(
        `LocalFolderAdapter received source of kind "${source.kind}" (expected "local-folder")`
      );
    }
    const scope = source.scope ?? {};
    const root = scope.root;
    if (typeof root !== "string" || root.length === 0) {
      throw new Error(
        `Source "${source.id}" of kind local-folder requires scope.root (e.g. \`atelier source add local-folder --name docs --scope-json '{"root":"../docs"}'\`).`
      );
    }
    const resolvedRoot = path.isAbsolute(root)
      ? root
      : workspaceRoot
        ? path.resolve(workspaceRoot, root)
        : path.resolve(root);
    const extensions = Array.isArray(scope.extensions)
      ? (scope.extensions as string[]).filter((s) => typeof s === "string")
      : undefined;
    const exclude = Array.isArray(scope.exclude)
      ? (scope.exclude as string[]).map((s) => new RegExp(s))
      : undefined;
    return new LocalFolderAdapter({ root: resolvedRoot, extensions, exclude });
  }

  async checkAvailability(): Promise<AdapterAvailability> {
    try {
      const stat = await fs.stat(this.scope.root);
      if (!stat.isDirectory()) {
        return {
          available: false,
          reason: `local-folder source root is not a directory: ${this.scope.root}`,
        };
      }
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `local-folder source root not found: ${this.scope.root} (${(err as Error).message})`,
      };
    }
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const exts = (this.scope.extensions ?? ["md", "markdown"]).map((e) =>
      e.startsWith(".") ? e.slice(1) : e
    );
    const all = await this.walk(this.scope.root, exts);
    const out: RemoteDocMetadata[] = [];
    for (const abs of all) {
      const rel = path.relative(this.scope.root, abs).split(path.sep).join("/");
      if (this.scope.exclude && this.scope.exclude.some((re) => re.test(rel))) {
        continue;
      }
      // Read just enough of the file to pull the title without loading
      // huge bodies unnecessarily — but markdown files are usually small,
      // so we just read the whole thing.
      const body = await fs.readFile(abs, "utf8");
      const title = extractTitle(body) ?? path.basename(rel, path.extname(rel));
      out.push({
        docId: rel,
        title,
        url: pathToFileURL(abs).toString(),
        lastModified: (await fs.stat(abs)).mtime.toISOString(),
      });
    }
    // Sort for deterministic ordering.
    return out.sort((a, b) => a.docId.localeCompare(b.docId));
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    const abs = path.join(this.scope.root, docId);
    const body = await fs.readFile(abs, "utf8");
    const title = extractTitle(body) ?? path.basename(docId, path.extname(docId));
    return {
      docId,
      title,
      body,
      url: pathToFileURL(abs).toString(),
    };
  }

  /** Recursively walk `dir`, returning absolute paths of files with `exts`. */
  private async walk(dir: string, exts: string[]): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(current, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).slice(1).toLowerCase();
          if (exts.includes(ext)) out.push(full);
        }
      }
    }
    return out;
  }
}

/**
 * Pull a title from the first H1 heading in a markdown document.
 * Tolerant of YAML front-matter (skipped) and common variants:
 *   - `# Title` style
 *   - Setext-style underlined H1 (`Title\n====`)
 */
function extractTitle(text: string): string | null {
  let body = text;
  // Skip YAML front-matter if present.
  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    const closing = body.indexOf("\n---", 4);
    if (closing !== -1) {
      const after = body.indexOf("\n", closing + 4);
      if (after !== -1) body = body.slice(after + 1);
    }
  }
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) return atx[1].trim();
    if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1]) && line.trim().length > 0) {
      return line.trim();
    }
    if (line.trim().length > 0 && !line.startsWith("#")) {
      // First non-blank, non-heading line — no H1 above it.
      // Keep scanning a few more lines in case the file starts with
      // a short blurb, but limit so we don't read huge files.
      if (i > 30) break;
    }
  }
  return null;
}
