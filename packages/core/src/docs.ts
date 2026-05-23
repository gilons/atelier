import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { workspacePaths } from "./paths.js";
import { validateDocEntryFrontMatter, formatIssues } from "./validation.js";
import { loadSourcesConfig } from "./sources.js";
import { WorkspaceValidationError } from "./workspace.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type {
  DocClassification,
  DocEntry,
  DocEntryFrontMatter,
  ValidationIssue,
} from "./types.js";

/**
 * Doc map.
 *
 * Each tracked document is a folder under
 * `.atelier/docs/<source>/<encoded-docId>/` containing one file —
 * `summary.md` — with YAML front-matter (source, docId, title,
 * link, classification, dates) and a markdown body that holds the
 * agent-curated summary (overview + keywords + anchors).
 *
 * Atelier does NOT store the full document. The agent that registered
 * the doc fetched it via its own integrations (MCP / browser ext /
 * REST / whatever) and produced the summary. To re-read the full
 * doc, the agent follows `link` again with the same integration.
 *
 * Why folders rather than flat files? Future agent-generated sidecars
 * (anchors.json, embeddings.bin, …) get a natural home. `removeDoc`
 * becomes "rm -rf the folder" — atelier doesn't have to enumerate
 * what an agent put there.
 *
 * Why filename encoding for the folder name? Source-side docIds can
 * be Notion UUIDs, GitHub `owner/repo#42`, URLs, etc. We need a
 * deterministic mapping to a filesystem-safe folder name.
 */

// ============================================================
// Errors
// ============================================================

export class DocNotFoundError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`No doc with id "${docId}" in source "${source}".`);
    this.name = "DocNotFoundError";
  }
}

export class DocAlreadyExistsError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`A doc with id "${docId}" already exists in source "${source}".`);
    this.name = "DocAlreadyExistsError";
  }
}

export class DocFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid doc file at ${filePath}:\n${detail}`);
    this.name = "DocFileError";
  }
}

export class DocReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Doc references invalid:\n${formatIssues(issues)}`);
    this.name = "DocReferenceValidationError";
  }
}

// ============================================================
// docId ↔ filename encoding
// ============================================================

/**
 * Encode a source-side docId into a safe filename stem. Reversible
 * for typical inputs. Atelier keeps [A-Za-z0-9._-] verbatim and
 * percent-encodes everything else (UTF-8 byte by UTF-8 byte). When
 * the result would exceed 200 chars, the tail is replaced with a
 * short sha1 prefix so we stay under macOS/Linux's 255-byte cap.
 */
export function encodeDocFilenameStem(docId: string): string {
  if (!docId) throw new Error("docId must be a non-empty string");
  let out = "";
  for (const ch of docId) {
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
    const hash = crypto.createHash("sha1").update(docId).digest("hex").slice(0, 8);
    out = out.slice(0, 200) + "_" + hash;
  }
  return out;
}

/** Inverse of {@link encodeDocFilenameStem} for the common-case mapping. */
export function decodeDocFilenameStem(stem: string): string {
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// ============================================================
// Path helpers
// ============================================================

/** Folder for one doc: `.atelier/docs/<source>/<encoded-docId>/`. */
function docFolderPath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).docs;
  return path.join(root, source, encodeDocFilenameStem(docId));
}

/** Path to summary.md inside the doc folder. */
function docSummaryPath(workspaceRoot: string, source: string, docId: string): string {
  return path.join(docFolderPath(workspaceRoot, source, docId), "summary.md");
}

async function ensureSourceDir(workspaceRoot: string, source: string): Promise<string> {
  const dir = path.join(workspacePaths(workspaceRoot).docs, source);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureDocFolder(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<string> {
  const dir = docFolderPath(workspaceRoot, source, docId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// Parse / serialize
// ============================================================

export function parseDocFile(text: string, filePath: string): DocEntry {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new DocFileError(
      filePath,
      "missing YAML front-matter (file must start with `---` on its first line)"
    );
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new DocFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateDocEntryFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new DocFileError(filePath, formatIssues(result.issues));
  }
  return { ...result.value, body: split.body };
}

export function serializeDocFile(doc: DocEntry): string {
  const fm: Record<string, unknown> = {
    source: doc.source,
    docId: doc.docId,
    title: doc.title,
  };
  if (doc.overview !== undefined && doc.overview !== "") fm.overview = doc.overview;
  if (doc.classification !== undefined) fm.classification = doc.classification;
  if (doc.link !== undefined) fm.link = doc.link;
  fm.createdAt = doc.createdAt;
  fm.updatedAt = doc.updatedAt;
  return buildFrontMatterFile(fm, doc.body);
}

function toFrontMatter(doc: DocEntry): DocEntryFrontMatter {
  return {
    source: doc.source,
    docId: doc.docId,
    title: doc.title,
    overview: doc.overview,
    classification: doc.classification,
    link: doc.link,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ============================================================
// CRUD
// ============================================================

export interface AddDocOptions {
  source: string;
  docId: string;
  title: string;
  /** Optional one-line elevator summary (front-matter). */
  overview?: string;
  classification?: DocClassification;
  /** Pointer the agent uses to fetch the full content. */
  link?: string;
  /** Markdown body — the agent-curated summary. */
  body?: string;
  /**
   * If true, skip the check that `source` is registered in
   * sources.yaml. Useful for tests and for the "manual" source
   * convention used by `/doc add` without arguments.
   */
  skipSourceValidation?: boolean;
}

export async function addDoc(
  workspaceRoot: string,
  opts: AddDocOptions
): Promise<DocEntry> {
  if (!opts.source) throw new Error("source is required");
  if (!opts.docId) throw new Error("docId is required");
  if (!opts.title) throw new Error("title is required");

  if (!opts.skipSourceValidation) {
    const cfg = await loadSourcesConfig(workspaceRoot);
    if (!cfg.sources.some((s) => s.id === opts.source)) {
      throw new DocReferenceValidationError([
        {
          path: "source",
          message: `source "${opts.source}" is not registered (run \`atelier source list\` to see registered sources)`,
        },
      ]);
    }
  }

  await ensureSourceDir(workspaceRoot, opts.source);
  const filePath = docSummaryPath(workspaceRoot, opts.source, opts.docId);
  try {
    await fs.access(filePath);
    throw new DocAlreadyExistsError(opts.source, opts.docId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const doc: DocEntry = {
    source: opts.source,
    docId: opts.docId,
    title: opts.title,
    overview: opts.overview,
    classification: opts.classification,
    link: opts.link,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? "",
  };

  const fmCheck = validateDocEntryFrontMatter(toFrontMatter(doc));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(filePath, formatIssues(fmCheck.issues));
  }

  await ensureDocFolder(workspaceRoot, opts.source, opts.docId);
  await fs.writeFile(filePath, serializeDocFile(doc), "utf8");
  return doc;
}

export async function loadDoc(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<DocEntry> {
  const filePath = docSummaryPath(workspaceRoot, source, docId);
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseDocFile(text, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DocNotFoundError(source, docId);
    }
    throw err;
  }
}

export interface DocListing {
  doc: DocEntry;
  filePath: string;
}

/**
 * List docs across the workspace. Without `source`, walks every
 * source folder under `.atelier/docs/`. Subdirectories that don't
 * contain a `summary.md` are skipped silently — agents may drop
 * unrelated state in there and that shouldn't crash listing.
 *
 * Parse errors are returned in `errors` rather than thrown so a
 * single broken file doesn't block the rest.
 */
export async function listDocs(
  workspaceRoot: string,
  source?: string
): Promise<{
  docs: DocListing[];
  errors: { filePath: string; error: Error }[];
}> {
  const docsRoot = workspacePaths(workspaceRoot).docs;
  const errors: { filePath: string; error: Error }[] = [];
  const docs: DocListing[] = [];

  let sourceDirs: string[];
  if (source) {
    sourceDirs = [path.join(docsRoot, source)];
  } else {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(docsRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { docs: [], errors: [] };
      }
      throw err;
    }
    sourceDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(docsRoot, e.name))
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
        docs.push({ doc: parseDocFile(text, filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        errors.push({ filePath, error: err as Error });
      }
    }
  }
  return { docs, errors };
}

export async function removeDoc(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<DocEntry> {
  const doc = await loadDoc(workspaceRoot, source, docId);
  const folder = docFolderPath(workspaceRoot, source, docId);
  await fs.rm(folder, { recursive: true, force: true });
  return doc;
}

export interface UpdateDocOptions {
  title?: string;
  /** Pass `""` to clear the overview field. */
  overview?: string;
  /** Pass `null` to clear the classification. */
  classification?: DocClassification | null;
  /** Pass `""` to clear the link. */
  link?: string;
  /** Replacement markdown summary body. */
  body?: string;
}

export async function updateDoc(
  workspaceRoot: string,
  source: string,
  docId: string,
  patch: UpdateDocOptions
): Promise<DocEntry> {
  const existing = await loadDoc(workspaceRoot, source, docId);
  const next: DocEntry = { ...existing };
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

  await ensureDocFolder(workspaceRoot, source, docId);
  const filePath = docSummaryPath(workspaceRoot, source, docId);
  await fs.writeFile(filePath, serializeDocFile(next), "utf8");
  return next;
}

/**
 * Rename a doc — change its docId. Used by `/doc rename`, which
 * the agent suggests after a manual /doc add when the doc's
 * filename should reflect its body better.
 */
export async function renameDoc(
  workspaceRoot: string,
  source: string,
  oldDocId: string,
  newDocId: string
): Promise<DocEntry> {
  if (!oldDocId) throw new Error("oldDocId is required");
  if (!newDocId) throw new Error("newDocId is required");
  if (oldDocId === newDocId) {
    return await loadDoc(workspaceRoot, source, oldDocId);
  }
  const existing = await loadDoc(workspaceRoot, source, oldDocId);

  const targetFolder = docFolderPath(workspaceRoot, source, newDocId);
  try {
    await fs.access(targetFolder);
    throw new DocAlreadyExistsError(source, newDocId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next: DocEntry = {
    ...existing,
    docId: newDocId,
    updatedAt: new Date().toISOString(),
  };
  const oldFolder = docFolderPath(workspaceRoot, source, oldDocId);
  await fs.rename(oldFolder, targetFolder);
  await fs.writeFile(
    docSummaryPath(workspaceRoot, source, newDocId),
    serializeDocFile(next),
    "utf8"
  );
  return next;
}
