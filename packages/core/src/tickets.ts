import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateTicketFrontMatter, formatIssues } from "./validation.js";
import { loadSourcesConfig } from "./sources.js";
import { WorkspaceValidationError } from "./workspace.js";
import { encodeItemFilenameStem } from "./items.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type { Ticket, TicketFrontMatter, ValidationIssue } from "./types.js";

/**
 * Ticket map — issues / epics / initiatives / stories from a planning
 * tool. A typed surface carved out of the generic "item".
 *
 * Lightweight by design: an agent-curated summary + a link + light
 * status, NOT a reimplemented tracker. The planning tool stays the
 * source of truth; atelier indexes enough to cross-reference tickets
 * with code, docs, and design. One folder per ticket under
 * `.atelier/tickets/<source>/<encoded-ticketId>/summary.md`.
 */

export class TicketNotFoundError extends Error {
  constructor(public readonly source: string, public readonly ticketId: string) {
    super(`No ticket with id "${ticketId}" in source "${source}".`);
    this.name = "TicketNotFoundError";
  }
}
export class TicketAlreadyExistsError extends Error {
  constructor(public readonly source: string, public readonly ticketId: string) {
    super(`Ticket with id "${ticketId}" already exists in source "${source}".`);
    this.name = "TicketAlreadyExistsError";
  }
}
export class TicketFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid ticket file at ${filePath}:\n${detail}`);
    this.name = "TicketFileError";
  }
}
export class TicketReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Ticket references invalid:\n${formatIssues(issues)}`);
    this.name = "TicketReferenceValidationError";
  }
}

function ticketFolderPath(workspaceRoot: string, source: string, ticketId: string): string {
  return path.join(workspacePaths(workspaceRoot).tickets, source, encodeItemFilenameStem(ticketId));
}
function ticketSummaryPath(workspaceRoot: string, source: string, ticketId: string): string {
  return path.join(ticketFolderPath(workspaceRoot, source, ticketId), "summary.md");
}

export function parseTicketFile(text: string, filePath: string): Ticket {
  const split = splitFrontMatter(text);
  if (!split) throw new TicketFileError(filePath, "missing YAML front-matter (file must start with `---`)");
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new TicketFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateTicketFrontMatter(raw);
  if (!result.ok || !result.value) throw new TicketFileError(filePath, formatIssues(result.issues));
  return { ...result.value, body: split.body };
}

export function serializeTicketFile(t: Ticket): string {
  const fm: Record<string, unknown> = { source: t.source, ticketId: t.ticketId, title: t.title };
  if (t.overview !== undefined && t.overview !== "") fm.overview = t.overview;
  if (t.status !== undefined) fm.status = t.status;
  if (t.assignee !== undefined) fm.assignee = t.assignee;
  if (t.link !== undefined) fm.link = t.link;
  if (t.parent !== undefined) fm.parent = t.parent;
  if (t.fromSession !== undefined) fm.fromSession = t.fromSession;
  fm.createdAt = t.createdAt;
  fm.updatedAt = t.updatedAt;
  return buildFrontMatterFile(fm, t.body);
}

function toFrontMatter(t: Ticket): TicketFrontMatter {
  return {
    source: t.source,
    ticketId: t.ticketId,
    title: t.title,
    overview: t.overview,
    status: t.status,
    assignee: t.assignee,
    link: t.link,
    parent: t.parent,
    fromSession: t.fromSession,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export interface AddTicketOptions {
  source: string;
  ticketId: string;
  title: string;
  overview?: string;
  status?: string;
  assignee?: string;
  link?: string;
  parent?: string;
  fromSession?: string;
  body?: string;
  skipSourceValidation?: boolean;
}

export async function addTicket(workspaceRoot: string, opts: AddTicketOptions): Promise<Ticket> {
  if (!opts.source) throw new Error("source is required");
  if (!opts.ticketId) throw new Error("ticketId is required");
  if (!opts.title) throw new Error("title is required");

  if (!opts.skipSourceValidation) {
    const cfg = await loadSourcesConfig(workspaceRoot);
    if (!cfg.sources.some((s) => s.id === opts.source)) {
      throw new TicketReferenceValidationError([
        { path: "source", message: `source "${opts.source}" is not registered` },
      ]);
    }
  }

  const filePath = ticketSummaryPath(workspaceRoot, opts.source, opts.ticketId);
  try {
    await fs.access(filePath);
    throw new TicketAlreadyExistsError(opts.source, opts.ticketId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const ticket: Ticket = {
    source: opts.source,
    ticketId: opts.ticketId,
    title: opts.title,
    overview: opts.overview,
    status: opts.status,
    assignee: opts.assignee,
    link: opts.link,
    parent: opts.parent,
    fromSession: opts.fromSession,
    createdAt: now,
    updatedAt: now,
    body: opts.body ?? "",
  };
  const check = validateTicketFrontMatter(toFrontMatter(ticket));
  if (!check.ok || !check.value) throw new WorkspaceValidationError(filePath, formatIssues(check.issues));

  await fs.mkdir(ticketFolderPath(workspaceRoot, opts.source, opts.ticketId), { recursive: true });
  await fs.writeFile(filePath, serializeTicketFile(ticket), "utf8");
  return ticket;
}

export async function loadTicket(workspaceRoot: string, source: string, ticketId: string): Promise<Ticket> {
  const filePath = ticketSummaryPath(workspaceRoot, source, ticketId);
  try {
    return parseTicketFile(await fs.readFile(filePath, "utf8"), filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new TicketNotFoundError(source, ticketId);
    throw err;
  }
}

export interface TicketListing {
  ticket: Ticket;
  filePath: string;
}

export async function listTickets(
  workspaceRoot: string,
  source?: string
): Promise<{ tickets: TicketListing[]; errors: { filePath: string; error: Error }[] }> {
  const root = workspacePaths(workspaceRoot).tickets;
  const errors: { filePath: string; error: Error }[] = [];
  const tickets: TicketListing[] = [];

  let sourceDirs: string[];
  if (source) {
    sourceDirs = [path.join(root, source)];
  } else {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tickets: [], errors: [] };
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
        tickets.push({ ticket: parseTicketFile(await fs.readFile(filePath, "utf8"), filePath), filePath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        errors.push({ filePath, error: err as Error });
      }
    }
  }
  return { tickets, errors };
}

export async function removeTicket(workspaceRoot: string, source: string, ticketId: string): Promise<Ticket> {
  const ticket = await loadTicket(workspaceRoot, source, ticketId);
  await fs.rm(ticketFolderPath(workspaceRoot, source, ticketId), { recursive: true, force: true });
  return ticket;
}

export interface UpdateTicketOptions {
  title?: string;
  overview?: string;
  status?: string | null;
  assignee?: string | null;
  link?: string;
  parent?: string | null;
  body?: string;
}

export async function updateTicket(
  workspaceRoot: string,
  source: string,
  ticketId: string,
  patch: UpdateTicketOptions
): Promise<Ticket> {
  const existing = await loadTicket(workspaceRoot, source, ticketId);
  const next: Ticket = { ...existing };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.overview !== undefined) next.overview = patch.overview === "" ? undefined : patch.overview;
  if (patch.status !== undefined) next.status = patch.status === null || patch.status === "" ? undefined : patch.status;
  if (patch.assignee !== undefined) next.assignee = patch.assignee === null || patch.assignee === "" ? undefined : patch.assignee;
  if (patch.link !== undefined) next.link = patch.link === "" ? undefined : patch.link;
  if (patch.parent !== undefined) next.parent = patch.parent === null || patch.parent === "" ? undefined : patch.parent;
  if (patch.body !== undefined) next.body = patch.body;
  next.updatedAt = new Date().toISOString();

  await fs.mkdir(ticketFolderPath(workspaceRoot, source, ticketId), { recursive: true });
  await fs.writeFile(ticketSummaryPath(workspaceRoot, source, ticketId), serializeTicketFile(next), "utf8");
  return next;
}
