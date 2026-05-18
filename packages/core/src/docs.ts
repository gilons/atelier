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
 * Doc map: one markdown file per indexed document under
 * `.planning/docs/<source-id>/<safe-doc-id>.md`. Each file has a
 * YAML front-matter block holding the structured fields (source,
 * docId, title, summary, classification, lastFetched, contentHash)
 * and a markdown body containing the fetched document content.
 *
 * Why nested by source id?
 *   - Documents collide across sources (Notion and Confluence can
 *     both have a "introduction" page).
 *   - Listing all docs from a single source is a common operation
 *     (sync diffs, source-specific reports) — a flat directory
 *     would force filtering on every read.
 *   - Removing a source becomes a single `rm -rf` of its dir.
 *
 * Why filename encoding?
 *   - Source-side docIds can be Notion UUIDs, Confluence integers,
 *     filesystem paths, URLs, etc. We need a deterministic, reversible
 *     mapping from docId to filename.
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
 * for typical inputs (URLs, UUIDs, paths). Non-ASCII and shell-unsafe
 * characters are percent-encoded; an empty result is rejected.
 *
 * We avoid the typical `slugify` approach because it loses information
 * — collisions across docIds that differ only in case or punctuation
 * would silently overwrite. Reversibility means the disk encoding is
 * an injection from docId space into filename space.
 */
export function encodeDocFilenameStem(docId: string): string {
  if (!docId) throw new Error("docId must be a non-empty string");
  // Use a percent-encoded form but limit the alphabet kept verbatim.
  // We keep [A-Za-z0-9._-] which are filesystem-safe everywhere.
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
      // Percent-encode each byte of the UTF-8 representation.
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  // Filename safety: macOS/Linux limit a single component to 255 bytes.
  // If we'd exceed that, append a short hash to keep it unique.
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

function docFilePath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).docs;
  return path.join(root, source, encodeDocFilenameStem(docId) + ".md");
}

/**
 * Filesystem path for the preserved-original binary that sits
 * alongside the doc's markdown body. Built from the same encoded
 * docId stem, so the binary is always a discoverable sibling of
 * the `.md` (e.g. `Strategy.md` ↔ `Strategy.docx`).
 *
 * The `originalFile` front-matter field stores just the filename
 * (no path); this helper rebuilds the absolute path on demand.
 */
function docOriginalPath(
  workspaceRoot: string,
  source: string,
  docId: string,
  extension: string
): string {
  const root = workspacePaths(workspaceRoot).docs;
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return path.join(root, source, encodeDocFilenameStem(docId) + "." + ext);
}

async function ensureSourceDir(workspaceRoot: string, source: string): Promise<string> {
  const dir = path.join(workspacePaths(workspaceRoot).docs, source);
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
  if (doc.summary !== undefined && doc.summary !== "") fm.summary = doc.summary;
  if (doc.classification !== undefined) fm.classification = doc.classification;
  if (doc.url !== undefined) fm.url = doc.url;
  if (doc.lastFetched !== undefined) fm.lastFetched = doc.lastFetched;
  if (doc.contentHash !== undefined) fm.contentHash = doc.contentHash;
  if (doc.originalFile !== undefined) fm.originalFile = doc.originalFile;
  fm.createdAt = doc.createdAt;
  fm.updatedAt = doc.updatedAt;
  return buildFrontMatterFile(fm, doc.body);
}

// ============================================================
// CRUD
// ============================================================

export interface AddDocOptions {
  source: string;
  docId: string;
  title: string;
  summary?: string;
  classification?: DocClassification;
  url?: string;
  body?: string;
  /** When set, recorded as lastFetched + contentHash on disk. */
  fetchedAt?: string;
  /**
   * Optional original-source binary. When present we write the
   * bytes to a sibling file of the `.md` (extension preserved) and
   * record the filename in the doc's `originalFile` front-matter.
   * Lets a user open the source file (Word, Excel, …) without
   * re-downloading.
   */
  original?: {
    bytes: Buffer;
    /** Filename extension without leading dot, e.g. "docx". */
    extension: string;
  };
  /**
   * If true, skip the check that `source` is registered in
   * sources.yaml. Useful for tests and bulk-import flows that
   * pre-create entries.
   */
  skipSourceValidation?: boolean;
}

/**
 * Compute a stable content hash. Slice 8's sync engine uses this to
 * detect when a fetched body has changed since the last index pass.
 */
export function hashBody(body: string): string {
  return "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
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
  const filePath = docFilePath(workspaceRoot, opts.source, opts.docId);
  try {
    await fs.access(filePath);
    throw new DocAlreadyExistsError(opts.source, opts.docId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const body = opts.body ?? "";
  const originalFile = opts.original
    ? encodeDocFilenameStem(opts.docId) +
      "." +
      opts.original.extension.replace(/^\./, "")
    : undefined;
  const doc: DocEntry = {
    source: opts.source,
    docId: opts.docId,
    title: opts.title,
    summary: opts.summary,
    classification: opts.classification,
    url: opts.url,
    lastFetched: opts.fetchedAt,
    contentHash: opts.fetchedAt && body ? hashBody(body) : undefined,
    originalFile,
    createdAt: now,
    updatedAt: now,
    body,
  };

  // Validate the front-matter once more in case the caller passed
  // something invalid (e.g. a classification we don't know about).
  const fmCheck = validateDocEntryFrontMatter(toFrontMatter(doc));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(filePath, formatIssues(fmCheck.issues));
  }

  await fs.writeFile(filePath, serializeDocFile(doc), "utf8");
  // Write the binary alongside the markdown — same stem, different
  // extension. Done after the markdown write so a binary-write failure
  // doesn't leave us with an orphaned-but-recorded `originalFile`.
  if (opts.original) {
    const binaryPath = docOriginalPath(
      workspaceRoot,
      opts.source,
      opts.docId,
      opts.original.extension
    );
    await fs.writeFile(binaryPath, opts.original.bytes);
  }
  return doc;
}

function toFrontMatter(doc: DocEntry): DocEntryFrontMatter {
  return {
    source: doc.source,
    docId: doc.docId,
    title: doc.title,
    summary: doc.summary,
    classification: doc.classification,
    url: doc.url,
    lastFetched: doc.lastFetched,
    contentHash: doc.contentHash,
    originalFile: doc.originalFile,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function loadDoc(
  workspaceRoot: string,
  source: string,
  docId: string
): Promise<DocEntry> {
  const filePath = docFilePath(workspaceRoot, source, docId);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DocNotFoundError(source, docId);
    }
    throw err;
  }
  return parseDocFile(text, filePath);
}

export interface DocListing {
  doc: DocEntry;
  filePath: string;
}

/**
 * List docs in the workspace. Without arguments, lists every doc
 * across every source. With `source`, lists only that source's docs.
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
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    for (const name of files) {
      const filePath = path.join(dir, name);
      try {
        const text = await fs.readFile(filePath, "utf8");
        docs.push({ doc: parseDocFile(text, filePath), filePath });
      } catch (err) {
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
  await fs.unlink(docFilePath(workspaceRoot, source, docId));
  // Best-effort delete of the preserved original (if any). Don't
  // fail the call if the binary was already removed by hand —
  // the doc entry has been deleted regardless, which is the
  // user's intent.
  if (doc.originalFile) {
    const ext = doc.originalFile.split(".").pop() ?? "";
    try {
      await fs.unlink(docOriginalPath(workspaceRoot, source, docId, ext));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return doc;
}

export interface UpdateDocOptions {
  /** Replacement title, if changing. */
  title?: string;
  /** Replacement summary, if changing. Pass `""` to clear. */
  summary?: string;
  /** Replacement classification. Pass `null` to clear. */
  classification?: DocClassification | null;
  /** Replacement URL. Pass `""` to clear. */
  url?: string;
  /**
   * Replacement body. When provided, recomputes `contentHash` and
   * sets `lastFetched` to now unless an explicit `fetchedAt` is given.
   */
  body?: string;
  /** Explicit lastFetched timestamp (ISO). */
  fetchedAt?: string;
  /**
   * Replacement original-source binary. When set, overwrites the
   * sibling-binary file. Pass null to delete a previously-stored
   * original.
   */
  original?:
    | {
        bytes: Buffer;
        extension: string;
      }
    | null;
}

/**
 * Update an existing doc entry. Slice 8's sync engine is the primary
 * user of this — when a fetch returns a new body, update the entry's
 * body+hash+lastFetched in a single call.
 */
export async function updateDoc(
  workspaceRoot: string,
  source: string,
  docId: string,
  patch: UpdateDocOptions
): Promise<DocEntry> {
  const existing = await loadDoc(workspaceRoot, source, docId);
  const next: DocEntry = { ...existing };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.summary !== undefined) {
    next.summary = patch.summary === "" ? undefined : patch.summary;
  }
  if (patch.classification !== undefined) {
    next.classification = patch.classification === null ? undefined : patch.classification;
  }
  if (patch.url !== undefined) {
    next.url = patch.url === "" ? undefined : patch.url;
  }
  if (patch.body !== undefined) {
    next.body = patch.body;
    next.contentHash = patch.body ? hashBody(patch.body) : undefined;
    next.lastFetched = patch.fetchedAt ?? new Date().toISOString();
  } else if (patch.fetchedAt !== undefined) {
    next.lastFetched = patch.fetchedAt;
  }
  // Resolve the original-binary update first so we know what filename
  // to record on disk before serializing the front-matter.
  if (patch.original === null) {
    if (next.originalFile) {
      const ext = next.originalFile.split(".").pop() ?? "";
      try {
        await fs.unlink(docOriginalPath(workspaceRoot, source, docId, ext));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      next.originalFile = undefined;
    }
  } else if (patch.original !== undefined) {
    next.originalFile =
      encodeDocFilenameStem(docId) + "." + patch.original.extension.replace(/^\./, "");
  }
  next.updatedAt = new Date().toISOString();

  const filePath = docFilePath(workspaceRoot, source, docId);
  await fs.writeFile(filePath, serializeDocFile(next), "utf8");
  if (patch.original && patch.original !== null) {
    const binaryPath = docOriginalPath(
      workspaceRoot,
      source,
      docId,
      patch.original.extension
    );
    await fs.writeFile(binaryPath, patch.original.bytes);
  }
  return next;
}
