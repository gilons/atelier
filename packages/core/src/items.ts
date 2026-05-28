import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { workspacePaths } from "./paths.js";
import { validateItemFrontMatter, formatIssues } from "./validation.js";
import { loadSourcesConfig } from "./sources.js";
import { WorkspaceValidationError } from "./workspace.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type {
  Item,
  ItemFrontMatter,
  ValidationIssue,
} from "./types.js";

/**
 * Item map.
 *
 * Each tracked item is a folder under
 * `.atelier/items/<source>/<encoded-itemId>/` containing one file —
 * `summary.md` — with YAML front-matter (source, docId, title,
 * link, classification, dates) and a markdown body that holds the
 * agent-curated summary (overview + keywords + anchors).
 *
 * Atelier does NOT store the full source artefact. The agent that
 * registered the item fetched it via its own integrations (MCP /
 * browser ext / REST / whatever) and produced the summary. To
 * re-read the full content, the agent follows `link` again with
 * the same integration.
 *
 * Why folders rather than flat files? Future agent-generated sidecars
 * (anchors.json, embeddings.bin, …) get a natural home. `removeItem`
 * becomes "rm -rf the folder" — atelier doesn't have to enumerate
 * what an agent put there.
 *
 * Why filename encoding for the folder name? Source-side itemIds can
 * be Notion UUIDs, GitHub `owner/repo#42`, URLs, Figma node ids etc.
 * We need a deterministic mapping to a filesystem-safe folder name.
 */

// ============================================================
// Errors
// ============================================================

export class ItemNotFoundError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`No item with id "${docId}" in source "${source}".`);
    this.name = "ItemNotFoundError";
  }
}

export class ItemAlreadyExistsError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`An item with id "${docId}" already exists in source "${source}".`);
    this.name = "ItemAlreadyExistsError";
  }
}

export class ItemFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid item file at ${filePath}:\n${detail}`);
    this.name = "ItemFileError";
  }
}

export class ItemReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Item references invalid:\n${formatIssues(issues)}`);
    this.name = "ItemReferenceValidationError";
  }
}

// ============================================================
// itemId ↔ filename encoding
// ============================================================

/**
 * Encode a source-side itemId into a safe filename stem. Reversible
 * for typical inputs. Atelier keeps [A-Za-z0-9._-] verbatim and
 * percent-encodes everything else (UTF-8 byte by UTF-8 byte). When
 * the result would exceed 200 chars, the tail is replaced with a
 * short sha1 prefix so we stay under macOS/Linux's 255-byte cap.
 */
export function encodeItemFilenameStem(itemId: string): string {
  if (!itemId) throw new Error("itemId must be a non-empty string");
  let out = "";
  for (const ch of itemId) {
    const code = ch.charCodeAt(0);
    const safe =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      ch === "." ||
      ch === "_" ||
      ch === "-";
    if (safe) {
      out += ch;
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  if (out.length > 200) {
    const hash = crypto.createHash("sha1").update(itemId).digest("hex").slice(0, 8);
    out = out.slice(0, 200) + "_" + hash;
  }
  return out;
}

/** Inverse of {@link encodeItemFilenameStem} for the common-case mapping. */
export function decodeItemFilenameStem(stem: string): string {
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// ============================================================
// Path helpers
// ============================================================

/** Folder for one item: `.atelier/items/<source>/<encoded-itemId>/`. */
function itemFolderPath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).items;
  return path.join(root, source, encodeItemFilenameStem(docId));
}

/** Path to summary.md inside the item folder. */
function itemSummaryPath(workspaceRoot: string, source: string, docId: string): string {
  return path.join(itemFolderPath(workspaceRoot, source, docId), "summary.md");
}

async function ensureSourceDir(workspaceRoot: string, source: string): Promise<string> {
  const dir = path.join(workspacePaths(workspaceRoot).items, source);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureItemFolder(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<string> {
  const dir = itemFolderPath(workspaceRoot, source, docId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// Parse / serialize
// ============================================================

export function parseItemFile(text: string, filePath: string): Item {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new ItemFileError(
      filePath,
      "missing YAML front-matter (file must start with `---` on its first line)"
    );
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new ItemFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateItemFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new ItemFileError(filePath, formatIssues(result.issues));
  }
  return { ...result.value, body: split.body };
}

export function serializeItemFile(item: Item): string {
  const fm: Record<string, unknown> = {
    source: item.source,
    docId: item.docId,
    title: item.title,
  };
  if (item.overview !== undefined && item.overview !== "") fm.overview = item.overview;
  if (item.classification !== undefined) fm.classification = item.classification;
  if (item.link !== undefined) fm.link = item.link;
  if (item.parent !== undefined) fm.parent = item.parent;
  if (item.fromSession !== undefined) fm.fromSession = item.fromSession;
  fm.createdAt = item.createdAt;
  fm.updatedAt = item.updatedAt;
  return buildFrontMatterFile(fm, item.body);
}

function toFrontMatter(item: Item): ItemFrontMatter {
  return {
    source: item.source,
    docId: item.docId,
    title: item.title,
    overview: item.overview,
    classification: item.classification,
    link: item.link,
    parent: item.parent,
    fromSession: item.fromSession,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ============================================================
// CRUD
// ============================================================

export interface AddItemOptions {
  source: string;
  docId: string;
  title: string;
  /** Optional one-line elevator summary (front-matter). */
  overview?: string;
  classification?: string;
  /** Pointer the agent uses to fetch the full content. */
  link?: string;
  /** Optional parent itemId for hierarchy (initiative → ticket, file → frame). */
  parent?: string;
  /**
   * Optional session id this item was born from. Set by the agent
   * after extracting items from a recorded conversation.
   */
  fromSession?: string;
  /** Markdown body — the agent-curated summary. */
  body?: string;
  /**
   * If true, skip the check that `source` is registered in
   * sources.yaml. Useful for tests and for the "manual" source
   * convention used by `/item add` without arguments.
   */
  skipSourceValidation?: boolean;
}

export async function addItem(
  workspaceRoot: string,
  opts: AddItemOptions
): Promise<Item> {
  if (!opts.source) throw new Error("source is required");
  if (!opts.docId) throw new Error("docId is required");
  if (!opts.title) throw new Error("title is required");

  if (!opts.skipSourceValidation) {
    const cfg = await loadSourcesConfig(workspaceRoot);
    if (!cfg.sources.some((s) => s.id === opts.source)) {
      throw new ItemReferenceValidationError([
        {
          path: "source",
          message: `source "${opts.source}" is not registered (run \`atelier source list\` to see registered sources)`,
        },
      ]);
    }
  }

  await ensureSourceDir(workspaceRoot, opts.source);
  const filePath = itemSummaryPath(workspaceRoot, opts.source, opts.docId);
  try {
    await fs.access(filePath);
    throw new ItemAlreadyExistsError(opts.source, opts.docId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const item: Item = {
    source: opts.source,
    docId: opts.docId,
    title: opts.title,
    overview: opts.overview,
    classification: opts.classification,
    link: opts.link,
    parent: opts.parent,
    fromSession: opts.fromSession,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? "",
  };

  const fmCheck = validateItemFrontMatter(toFrontMatter(item));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(filePath, formatIssues(fmCheck.issues));
  }

  await ensureItemFolder(workspaceRoot, opts.source, opts.docId);
  await fs.writeFile(filePath, serializeItemFile(item), "utf8");
  return item;
}

export async function loadItem(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<Item> {
  const filePath = itemSummaryPath(workspaceRoot, source, docId);
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseItemFile(text, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ItemNotFoundError(source, docId);
    }
    throw err;
  }
}

export interface ItemListing {
  item: Item;
  filePath: string;
}

/**
 * List items across the workspace. Without `source`, walks every
 * source folder under `.atelier/items/`. Subdirectories that don't
 * contain a `summary.md` are skipped silently — agents may drop
 * unrelated state in there and that shouldn't crash listing.
 *
 * Parse errors are returned in `errors` rather than thrown so a
 * single broken file doesn't block the rest.
 */
export async function listItems(
  workspaceRoot: string,
  source?: string
): Promise<{
  items: ItemListing[];
  errors: { filePath: string; error: Error }[];
}> {
  const itemsRoot = workspacePaths(workspaceRoot).items;
  const errors: { filePath: string; error: Error }[] = [];
  const items: ItemListing[] = [];

  let sourceDirs: string[];
  if (source) {
    sourceDirs = [path.join(itemsRoot, source)];
  } else {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(itemsRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { items: [], errors: [] };
      }
      throw err;
    }
    sourceDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(itemsRoot, e.name))
      .sort();
  }

  for (const dir of sourceDirs) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const filePath = path.join(dir, e.name, "summary.md");
      try {
        const text = await fs.readFile(filePath, "utf8");
        items.push({ item: parseItemFile(text, filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        errors.push({ filePath, error: err as Error });
      }
    }
  }
  return { items, errors };
}

export async function removeItem(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<Item> {
  const item = await loadItem(workspaceRoot, source, docId);
  const folder = itemFolderPath(workspaceRoot, source, docId);
  await fs.rm(folder, { recursive: true, force: true });
  return item;
}

export interface UpdateItemOptions {
  title?: string;
  /** Pass `""` to clear the overview field. */
  overview?: string;
  /** Pass `null` to clear the classification. */
  classification?: string | null;
  /** Pass `""` to clear the link. */
  link?: string;
  /** Replacement markdown summary body. */
  body?: string;
}

export async function updateItem(
  workspaceRoot: string,
  source: string,
  docId: string,
  patch: UpdateItemOptions
): Promise<Item> {
  const existing = await loadItem(workspaceRoot, source, docId);
  const next: Item = { ...existing };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.overview !== undefined) {
    next.overview = patch.overview === "" ? undefined : patch.overview;
  }
  if (patch.classification !== undefined) {
    next.classification = patch.classification === null ? undefined : patch.classification;
  }
  if (patch.link !== undefined) {
    next.link = patch.link === "" ? undefined : patch.link;
  }
  if (patch.body !== undefined) next.body = patch.body;
  next.updatedAt = new Date().toISOString();

  await ensureItemFolder(workspaceRoot, source, docId);
  const filePath = itemSummaryPath(workspaceRoot, source, docId);
  await fs.writeFile(filePath, serializeItemFile(next), "utf8");
  return next;
}

/**
 * Rename an item — change its docId. Used by `/item rename`, which
 * the agent suggests after a manual /item add when the file's
 * folder name should reflect its body better.
 */
export async function renameItem(
  workspaceRoot: string,
  source: string,
  oldDocId: string,
  newDocId: string
): Promise<Item> {
  if (!oldDocId) throw new Error("oldDocId is required");
  if (!newDocId) throw new Error("newDocId is required");
  if (oldDocId === newDocId) {
    return await loadItem(workspaceRoot, source, oldDocId);
  }
  const existing = await loadItem(workspaceRoot, source, oldDocId);

  const targetFolder = itemFolderPath(workspaceRoot, source, newDocId);
  try {
    await fs.access(targetFolder);
    throw new ItemAlreadyExistsError(source, newDocId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next: Item = {
    ...existing,
    docId: newDocId,
    updatedAt: new Date().toISOString(),
  };
  const oldFolder = itemFolderPath(workspaceRoot, source, oldDocId);
  await fs.rename(oldFolder, targetFolder);
  await fs.writeFile(
    itemSummaryPath(workspaceRoot, source, newDocId),
    serializeItemFile(next),
    "utf8"
  );
  return next;
}
