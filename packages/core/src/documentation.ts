import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateDocFrontMatter, formatIssues } from "./validation.js";
import { loadSourcesConfig } from "./sources.js";
import { WorkspaceValidationError } from "./workspace.js";
import { encodeItemFilenameStem } from "./items.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type { Documentation, DocFrontMatter, ValidationIssue } from "./types.js";

/**
 * Documentation map — knowledge artifacts (PRDs, RFCs, runbooks,
 * transcripts). The first typed surface carved out of the generic
 * "item": one folder per indexed document under
 * `.atelier/documentation/<source>/<encoded-docId>/summary.md`,
 * holding an agent-curated summary + a `link` back to the source.
 *
 * Atelier doesn't store the source document — the agent fetches it via
 * its own integrations and writes the summary. Same model the item
 * map used; this just makes documentation a first-class surface with
 * its own command, storage, and doc-specific fields (e.g. `owner`).
 */

export class DocNotFoundError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`No documentation with id "${docId}" in source "${source}".`);
    this.name = "DocNotFoundError";
  }
}

export class DocAlreadyExistsError extends Error {
  constructor(public readonly source: string, public readonly docId: string) {
    super(`Documentation with id "${docId}" already exists in source "${source}".`);
    this.name = "DocAlreadyExistsError";
  }
}

export class DocFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid documentation file at ${filePath}:\n${detail}`);
    this.name = "DocFileError";
  }
}

export class DocReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Documentation references invalid:\n${formatIssues(issues)}`);
    this.name = "DocReferenceValidationError";
  }
}

// ============================================================
// Paths
// ============================================================

function docFolderPath(workspaceRoot: string, source: string, docId: string): string {
  const root = workspacePaths(workspaceRoot).documentation;
  return path.join(root, source, encodeItemFilenameStem(docId));
}
function docSummaryPath(workspaceRoot: string, source: string, docId: string): string {
  return path.join(docFolderPath(workspaceRoot, source, docId), "summary.md");
}
async function ensureSourceDir(workspaceRoot: string, source: string): Promise<string> {
  const dir = path.join(workspacePaths(workspaceRoot).documentation, source);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// Parse / serialize
// ============================================================

export function parseDocFile(text: string, filePath: string): Documentation {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new DocFileError(filePath, "missing YAML front-matter (file must start with `---`)");
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new DocFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateDocFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new DocFileError(filePath, formatIssues(result.issues));
  }
  return { ...result.value, body: split.body };
}

export function serializeDocFile(doc: Documentation): string {
  const fm: Record<string, unknown> = { source: doc.source, docId: doc.docId, title: doc.title };
  if (doc.overview !== undefined && doc.overview !== "") fm.overview = doc.overview;
  if (doc.classification !== undefined) fm.classification = doc.classification;
  if (doc.link !== undefined) fm.link = doc.link;
  if (doc.owner !== undefined) fm.owner = doc.owner;
  if (doc.fromSession !== undefined) fm.fromSession = doc.fromSession;
  fm.createdAt = doc.createdAt;
  fm.updatedAt = doc.updatedAt;
  return buildFrontMatterFile(fm, doc.body);
}

function toFrontMatter(doc: Documentation): DocFrontMatter {
  return {
    source: doc.source,
    docId: doc.docId,
    title: doc.title,
    overview: doc.overview,
    classification: doc.classification,
    link: doc.link,
    owner: doc.owner,
    fromSession: doc.fromSession,
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
  overview?: string;
  classification?: string;
  link?: string;
  owner?: string;
  fromSession?: string;
  body?: string;
  /** Skip the check that `source` is registered in sources.yaml. */
  skipSourceValidation?: boolean;
}

export async function addDoc(workspaceRoot: string, opts: AddDocOptions): Promise<Documentation> {
  if (!opts.source) throw new Error("source is required");
  if (!opts.docId) throw new Error("docId is required");
  if (!opts.title) throw new Error("title is required");

  if (!opts.skipSourceValidation) {
    const cfg = await loadSourcesConfig(workspaceRoot);
    if (!cfg.sources.some((s) => s.id === opts.source)) {
      throw new DocReferenceValidationError([
        { path: "source", message: `source "${opts.source}" is not registered` },
      ]);
    }
  }

  const filePath = docSummaryPath(workspaceRoot, opts.source, opts.docId);
  try {
    await fs.access(filePath);
    throw new DocAlreadyExistsError(opts.source, opts.docId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const doc: Documentation = {
    source: opts.source,
    docId: opts.docId,
    title: opts.title,
    overview: opts.overview,
    classification: opts.classification,
    link: opts.link,
    owner: opts.owner,
    fromSession: opts.fromSession,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? "",
  };

  const check = validateDocFrontMatter(toFrontMatter(doc));
  if (!check.ok || !check.value) {
    throw new WorkspaceValidationError(filePath, formatIssues(check.issues));
  }

  await ensureSourceDir(workspaceRoot, opts.source);
  await fs.mkdir(docFolderPath(workspaceRoot, opts.source, opts.docId), { recursive: true });
  await fs.writeFile(filePath, serializeDocFile(doc), "utf8");
  return doc;
}

export async function loadDoc(workspaceRoot: string, source: string, docId: string): Promise<Documentation> {
  const filePath = docSummaryPath(workspaceRoot, source, docId);
  try {
    return parseDocFile(await fs.readFile(filePath, "utf8"), filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DocNotFoundError(source, docId);
    throw err;
  }
}

export interface DocListing {
  doc: Documentation;
  filePath: string;
}

export async function listDocs(
  workspaceRoot: string,
  source?: string
): Promise<{ docs: DocListing[]; errors: { filePath: string; error: Error }[] }> {
  const root = workspacePaths(workspaceRoot).documentation;
  const errors: { filePath: string; error: Error }[] = [];
  const docs: DocListing[] = [];

  let sourceDirs: string[];
  if (source) {
    sourceDirs = [path.join(root, source)];
  } else {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { docs: [], errors: [] };
      throw err;
    }
    sourceDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
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
        docs.push({ doc: parseDocFile(await fs.readFile(filePath, "utf8"), filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        errors.push({ filePath, error: err as Error });
      }
    }
  }
  return { docs, errors };
}

export async function removeDoc(workspaceRoot: string, source: string, docId: string): Promise<Documentation> {
  const doc = await loadDoc(workspaceRoot, source, docId);
  await fs.rm(docFolderPath(workspaceRoot, source, docId), { recursive: true, force: true });
  return doc;
}

export interface UpdateDocOptions {
  title?: string;
  overview?: string;
  classification?: string | null;
  link?: string;
  owner?: string | null;
  body?: string;
}

export async function updateDoc(
  workspaceRoot: string,
  source: string,
  docId: string,
  patch: UpdateDocOptions
): Promise<Documentation> {
  const existing = await loadDoc(workspaceRoot, source, docId);
  const next: Documentation = { ...existing };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.overview !== undefined) next.overview = patch.overview === "" ? undefined : patch.overview;
  if (patch.classification !== undefined) next.classification = patch.classification === null ? undefined : patch.classification;
  if (patch.link !== undefined) next.link = patch.link === "" ? undefined : patch.link;
  if (patch.owner !== undefined) next.owner = patch.owner === null || patch.owner === "" ? undefined : patch.owner;
  if (patch.body !== undefined) next.body = patch.body;
  next.updatedAt = new Date().toISOString();

  await fs.mkdir(docFolderPath(workspaceRoot, source, docId), { recursive: true });
  await fs.writeFile(docSummaryPath(workspaceRoot, source, docId), serializeDocFile(next), "utf8");
  return next;
}

export async function renameDoc(
  workspaceRoot: string,
  source: string,
  oldDocId: string,
  newDocId: string
): Promise<Documentation> {
  if (!oldDocId || !newDocId) throw new Error("oldDocId and newDocId are required");
  if (oldDocId === newDocId) return loadDoc(workspaceRoot, source, oldDocId);
  const existing = await loadDoc(workspaceRoot, source, oldDocId);

  const targetFolder = docFolderPath(workspaceRoot, source, newDocId);
  try {
    await fs.access(targetFolder);
    throw new DocAlreadyExistsError(source, newDocId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next: Documentation = { ...existing, docId: newDocId, updatedAt: new Date().toISOString() };
  await fs.rename(docFolderPath(workspaceRoot, source, oldDocId), targetFolder);
  await fs.writeFile(docSummaryPath(workspaceRoot, source, newDocId), serializeDocFile(next), "utf8");
  return next;
}
