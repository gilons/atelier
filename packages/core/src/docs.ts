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

/**
 * On-disk layout for a single doc.
 *
 *   .atelier/docs/<source>/<encoded-docId>/
 *     parsed.md       — the doc body Atelier indexes (front-matter +
 *                       markdown content). The canonical file.
 *     original.<ext>  — when the source file was binary (Word, PDF,
 *                       Excel, …) we preserve a verbatim copy here.
 *     summary.md      — Atelier doesn't write this. Agents who read
 *                       the doc produce it: a 1-paragraph summary
 *                       plus keywords so future agents can discover
 *                       the doc by topic without re-reading the full
 *                       body. `/doc add` prints an instruction
 *                       requesting exactly this artifact.
 *
 * Why a folder per doc rather than the older flat layout? Three
 * reasons:
 *   - Agent-generated artifacts (summary.md, maybe later anchors,
 *     embeddings, etc.) need a home, and putting them next to the
 *     parsed body is the natural place.
 *   - When a user wants to look at the original file, having both
 *     versions in the same folder beats hunting for a sibling.
 *   - `removeDoc` becomes "rm -rf the folder" instead of needing to
 *     know every file we might have written.
 *
 * Legacy flat layout (`<encoded>.md` + `<encoded>.docx` at the
 * source-dir level) is still read transparently — workspaces written
 * by older atelier builds keep working until the next /sync rewrites
 * each doc into the new layout.
 */
function docFolderPath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).docs;
  return path.join(root, source, encodeDocFilenameStem(docId));
}

/**
 * Absolute path to the parsed body file for a doc, in the new
 * folder layout. `loadDoc` falls back to the legacy flat path when
 * this one doesn't exist.
 */
function docParsedPath(workspaceRoot: string, source: string, docId: string): string {
  return path.join(docFolderPath(workspaceRoot, source, docId), "parsed.md");
}

/**
 * Legacy flat-layout path: `.atelier/docs/<source>/<encoded>.md`.
 * Workspaces created before the per-doc-folder change still have
 * these. We read them transparently and rewrite into the new layout
 * on the next update.
 */
function legacyDocFilePath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).docs;
  return path.join(root, source, encodeDocFilenameStem(docId) + ".md");
}

/**
 * Path to the preserved-original binary inside the doc folder.
 * Filename is always `original.<ext>` — predictable, no docId
 * encoding in the name (the folder above already carries that).
 *
 * `originalFile` in the front-matter stores just the basename
 * (`original.docx`); this helper rebuilds the absolute path.
 */
function docOriginalPath(
  workspaceRoot: string,
  source: string,
  docId: string,
  extension: string
): string {
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return path.join(docFolderPath(workspaceRoot, source, docId), "original." + ext);
}

/**
 * Legacy original path — sibling of the legacy `.md`, named with the
 * docId stem and the file extension.
 */
function legacyDocOriginalPath(
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
  const filePath = docParsedPath(workspaceRoot, opts.source, opts.docId);
  const legacyPath = legacyDocFilePath(workspaceRoot, opts.source, opts.docId);
  // Existence check covers BOTH layouts so we don't accidentally
  // shadow a legacy-layout doc by writing a new-layout one.
  for (const p of [filePath, legacyPath]) {
    try {
      await fs.access(p);
      throw new DocAlreadyExistsError(opts.source, opts.docId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const now = new Date().toISOString();
  const body = opts.body ?? "";
  // originalFile is the basename inside the doc folder. Predictable
  // name (`original.docx`, `original.pdf`) instead of repeating the
  // encoded docId — the docId is already encoded in the folder name.
  const originalFile = opts.original
    ? "original." + opts.original.extension.replace(/^\./, "")
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

  await ensureDocFolder(workspaceRoot, opts.source, opts.docId);
  await fs.writeFile(filePath, serializeDocFile(doc), "utf8");
  // Write the binary alongside parsed.md in the doc's folder. Done
  // after the markdown write so a binary-write failure doesn't leave
  // us with an orphaned-but-recorded `originalFile`.
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
  // Try the new folder-layout path first, then fall back to the
  // legacy flat-file layout. Workspaces written by older atelier
  // builds keep working — the next update will rewrite them into
  // the new layout.
  const filePath = docParsedPath(workspaceRoot, source, docId);
  const legacyPath = legacyDocFilePath(workspaceRoot, source, docId);
  for (const candidate of [filePath, legacyPath]) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      return parseDocFile(text, candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new DocNotFoundError(source, docId);
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
    // Two layouts coexist during the transition:
    //   - Folder-per-doc (new): each subdirectory contains
    //     `parsed.md` plus optional sidecars (original.<ext>,
    //     summary.md). We read parsed.md.
    //   - Flat-file (legacy): a `.md` at the source-dir level
    //     names the doc directly. Keep reading these so old
    //     workspaces keep working until /sync rewrites them.
    const candidates: string[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        candidates.push(path.join(dir, e.name, "parsed.md"));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        candidates.push(path.join(dir, e.name));
      }
    }
    for (const filePath of candidates) {
      try {
        const text = await fs.readFile(filePath, "utf8");
        docs.push({ doc: parseDocFile(text, filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // A subdirectory without `parsed.md` isn't a doc — it
          // might be an unrelated folder a user dropped in. Skip
          // silently rather than surfacing as an error.
          continue;
        }
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
  // New layout: nuke the whole folder (parsed.md, original.<ext>,
  // summary.md, anything else an agent created in there).
  const folder = docFolderPath(workspaceRoot, source, docId);
  await fs.rm(folder, { recursive: true, force: true });
  // Legacy layout: also clean up the flat files if they exist.
  // We can't tell from `loadDoc`'s return which layout we read,
  // so just unlink both best-effort.
  await fs.rm(legacyDocFilePath(workspaceRoot, source, docId), { force: true });
  if (doc.originalFile) {
    const ext = doc.originalFile.split(".").pop() ?? "";
    await fs.rm(legacyDocOriginalPath(workspaceRoot, source, docId, ext), { force: true });
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
      // Remove from both the new folder layout AND any legacy
      // location — best-effort either way.
      await fs.rm(docOriginalPath(workspaceRoot, source, docId, ext), { force: true });
      await fs.rm(legacyDocOriginalPath(workspaceRoot, source, docId, ext), { force: true });
      next.originalFile = undefined;
    }
  } else if (patch.original !== undefined) {
    next.originalFile = "original." + patch.original.extension.replace(/^\./, "");
  }
  next.updatedAt = new Date().toISOString();

  // Always write the new folder layout. If the existing doc was
  // in the legacy flat layout, this effectively migrates it on
  // first update — we also unlink the old flat files so they
  // don't shadow the new layout on the next read.
  await ensureDocFolder(workspaceRoot, source, docId);
  const filePath = docParsedPath(workspaceRoot, source, docId);
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
  // Clean up legacy flat files if they existed — we've now got
  // the canonical copy in the new folder layout, so the flat
  // files become stale duplicates.
  await fs.rm(legacyDocFilePath(workspaceRoot, source, docId), { force: true });
  if (existing.originalFile && !existing.originalFile.startsWith("original.")) {
    // Pre-migration originalFile names included the encoded
    // docId stem; the new convention is just `original.<ext>`.
    // Strip the legacy file too.
    const ext = existing.originalFile.split(".").pop() ?? "";
    await fs.rm(
      legacyDocOriginalPath(workspaceRoot, source, docId, ext),
      { force: true }
    );
  }
  return next;
}

/**
 * Rename a doc — change its docId. Used by `/doc rename`, which
 * is the agent-suggested step after a manual /doc add when the
 * doc's filename should reflect its body better.
 *
 * Mechanics:
 *   1. Validate the new docId doesn't conflict with an existing
 *      doc in the same source.
 *   2. Move the folder atomically: `<source>/<old-encoded>/` →
 *      `<source>/<new-encoded>/`. fs.rename is atomic on the same
 *      filesystem; we never end up with a half-moved state.
 *   3. Rewrite parsed.md so the front-matter's `docId` field
 *      reflects the new id. (The folder name + the docId have to
 *      agree — otherwise listDocs would show one and loadDoc
 *      would address the other.)
 *
 * Legacy flat-file docs: if the existing doc lives at
 * `<source>/<old-encoded>.md` (pre-folder layout), we route
 * through updateDoc-style migration: write the new folder
 * layout, delete the legacy file. Same effect as updateDoc's
 * migration path.
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
    // No-op rename — return the existing doc so callers can
    // proceed without special-casing.
    return await loadDoc(workspaceRoot, source, oldDocId);
  }

  const existing = await loadDoc(workspaceRoot, source, oldDocId);

  // Conflict check: refuse to clobber an existing doc at the
  // target. We probe BOTH layouts (new folder + legacy flat) so
  // a half-migrated workspace can't silently lose data.
  const targetFolder = docFolderPath(workspaceRoot, source, newDocId);
  const targetLegacy = legacyDocFilePath(workspaceRoot, source, newDocId);
  for (const p of [targetFolder, targetLegacy]) {
    try {
      await fs.access(p);
      throw new DocAlreadyExistsError(source, newDocId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const next: DocEntry = {
    ...existing,
    docId: newDocId,
    updatedAt: new Date().toISOString(),
  };

  // Move the folder if it exists at the new layout. fs.rename
  // is atomic across-renames-within-fs; if the source dir was a
  // legacy flat file we skip this and write the new folder
  // fresh from `next` below.
  const oldFolder = docFolderPath(workspaceRoot, source, oldDocId);
  let oldFolderExists = false;
  try {
    const stat = await fs.stat(oldFolder);
    oldFolderExists = stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (oldFolderExists) {
    await fs.rename(oldFolder, targetFolder);
  } else {
    // Legacy flat-file source — make sure the parent source dir
    // exists, then write the new folder from scratch below.
    await ensureDocFolder(workspaceRoot, source, newDocId);
  }

  // Rewrite parsed.md with the updated front-matter (docId,
  // updatedAt).
  await fs.writeFile(
    docParsedPath(workspaceRoot, source, newDocId),
    serializeDocFile(next),
    "utf8"
  );

  // Clean up the legacy flat file if it existed — same logic as
  // updateDoc's migration cleanup.
  await fs.rm(legacyDocFilePath(workspaceRoot, source, oldDocId), { force: true });
  if (existing.originalFile && !existing.originalFile.startsWith("original.")) {
    const ext = existing.originalFile.split(".").pop() ?? "";
    await fs.rm(
      legacyDocOriginalPath(workspaceRoot, source, oldDocId, ext),
      { force: true }
    );
  }

  return next;
}
