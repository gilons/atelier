import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateDesignArtifactFrontMatter, formatIssues } from "./validation.js";
import { WorkspaceValidationError } from "./workspace.js";
import { encodeItemFilenameStem } from "./items.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type { DesignArtifact, DesignArtifactFrontMatter } from "./types.js";

/**
 * Design store — the design engine's output, the third typed surface
 * carved out of the generic "item". Keyed by *discipline*
 * (system-design / ui-design / custom) rather than a source: a design
 * belongs to a discipline, the visual lives in the design tool (or
 * Markdown), and atelier holds the summary + a `link`.
 *
 * One folder per artifact under
 * `.atelier/designs/<discipline>/<encoded-id>/summary.md`.
 */

export class DesignNotFoundError extends Error {
  constructor(public readonly discipline: string, public readonly id: string) {
    super(`No design "${id}" in discipline "${discipline}".`);
    this.name = "DesignNotFoundError";
  }
}
export class DesignAlreadyExistsError extends Error {
  constructor(public readonly discipline: string, public readonly id: string) {
    super(`A design "${id}" already exists in discipline "${discipline}".`);
    this.name = "DesignAlreadyExistsError";
  }
}
export class DesignFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid design file at ${filePath}:\n${detail}`);
    this.name = "DesignFileError";
  }
}

function designFolderPath(workspaceRoot: string, discipline: string, id: string): string {
  return path.join(workspacePaths(workspaceRoot).designs, discipline, encodeItemFilenameStem(id));
}
function designSummaryPath(workspaceRoot: string, discipline: string, id: string): string {
  return path.join(designFolderPath(workspaceRoot, discipline, id), "summary.md");
}

export function parseDesignFile(text: string, filePath: string): DesignArtifact {
  const split = splitFrontMatter(text);
  if (!split) throw new DesignFileError(filePath, "missing YAML front-matter (file must start with `---`)");
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new DesignFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateDesignArtifactFrontMatter(raw);
  if (!result.ok || !result.value) throw new DesignFileError(filePath, formatIssues(result.issues));
  return { ...result.value, body: split.body };
}

export function serializeDesignFile(d: DesignArtifact): string {
  const fm: Record<string, unknown> = { discipline: d.discipline, id: d.id, title: d.title };
  if (d.overview !== undefined && d.overview !== "") fm.overview = d.overview;
  if (d.kind !== undefined) fm.kind = d.kind;
  if (d.link !== undefined) fm.link = d.link;
  if (d.app !== undefined) fm.app = d.app;
  if (d.fromSession !== undefined) fm.fromSession = d.fromSession;
  fm.createdAt = d.createdAt;
  fm.updatedAt = d.updatedAt;
  return buildFrontMatterFile(fm, d.body);
}

function toFrontMatter(d: DesignArtifact): DesignArtifactFrontMatter {
  return {
    discipline: d.discipline,
    id: d.id,
    title: d.title,
    overview: d.overview,
    kind: d.kind,
    link: d.link,
    app: d.app,
    fromSession: d.fromSession,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export interface AddDesignOptions {
  discipline: string;
  id: string;
  title: string;
  overview?: string;
  kind?: string;
  link?: string;
  app?: string;
  fromSession?: string;
  body?: string;
}

export async function addDesign(workspaceRoot: string, opts: AddDesignOptions): Promise<DesignArtifact> {
  if (!opts.discipline) throw new Error("discipline is required");
  if (!opts.id) throw new Error("id is required");
  if (!opts.title) throw new Error("title is required");

  const filePath = designSummaryPath(workspaceRoot, opts.discipline, opts.id);
  try {
    await fs.access(filePath);
    throw new DesignAlreadyExistsError(opts.discipline, opts.id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const design: DesignArtifact = {
    discipline: opts.discipline,
    id: opts.id,
    title: opts.title,
    overview: opts.overview,
    kind: opts.kind,
    link: opts.link,
    app: opts.app,
    fromSession: opts.fromSession,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? "",
  };
  const check = validateDesignArtifactFrontMatter(toFrontMatter(design));
  if (!check.ok || !check.value) throw new WorkspaceValidationError(filePath, formatIssues(check.issues));

  await fs.mkdir(designFolderPath(workspaceRoot, opts.discipline, opts.id), { recursive: true });
  await fs.writeFile(filePath, serializeDesignFile(design), "utf8");
  return design;
}

export async function loadDesign(workspaceRoot: string, discipline: string, id: string): Promise<DesignArtifact> {
  const filePath = designSummaryPath(workspaceRoot, discipline, id);
  try {
    return parseDesignFile(await fs.readFile(filePath, "utf8"), filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DesignNotFoundError(discipline, id);
    throw err;
  }
}

export interface DesignListing {
  design: DesignArtifact;
  filePath: string;
}

/** List designs across all disciplines, or one discipline. */
export async function listDesigns(
  workspaceRoot: string,
  discipline?: string
): Promise<{ designs: DesignListing[]; errors: { filePath: string; error: Error }[] }> {
  const root = workspacePaths(workspaceRoot).designs;
  const errors: { filePath: string; error: Error }[] = [];
  const designs: DesignListing[] = [];

  let disciplineDirs: string[];
  if (discipline) {
    disciplineDirs = [path.join(root, discipline)];
  } else {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { designs: [], errors: [] };
      throw err;
    }
    disciplineDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
  }

  for (const dir of disciplineDirs) {
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
        designs.push({ design: parseDesignFile(await fs.readFile(filePath, "utf8"), filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        errors.push({ filePath, error: err as Error });
      }
    }
  }
  return { designs, errors };
}

export async function removeDesign(workspaceRoot: string, discipline: string, id: string): Promise<DesignArtifact> {
  const design = await loadDesign(workspaceRoot, discipline, id);
  await fs.rm(designFolderPath(workspaceRoot, discipline, id), { recursive: true, force: true });
  return design;
}

export interface UpdateDesignOptions {
  title?: string;
  overview?: string;
  kind?: string | null;
  link?: string;
  app?: string | null;
  body?: string;
}

export async function updateDesign(
  workspaceRoot: string,
  discipline: string,
  id: string,
  patch: UpdateDesignOptions
): Promise<DesignArtifact> {
  const existing = await loadDesign(workspaceRoot, discipline, id);
  const next: DesignArtifact = { ...existing };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.overview !== undefined) next.overview = patch.overview === "" ? undefined : patch.overview;
  if (patch.kind !== undefined) next.kind = patch.kind === null || patch.kind === "" ? undefined : patch.kind;
  if (patch.link !== undefined) next.link = patch.link === "" ? undefined : patch.link;
  if (patch.app !== undefined) next.app = patch.app === null || patch.app === "" ? undefined : patch.app;
  if (patch.body !== undefined) next.body = patch.body;
  next.updatedAt = new Date().toISOString();

  await fs.mkdir(designFolderPath(workspaceRoot, discipline, id), { recursive: true });
  await fs.writeFile(designSummaryPath(workspaceRoot, discipline, id), serializeDesignFile(next), "utf8");
  return next;
}
