import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateStakeholderFrontMatter, formatIssues } from "./validation.js";
import { WorkspaceValidationError } from "./workspace.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import type {
  Stakeholder,
  StakeholderFrontMatter,
} from "./types.js";

/**
 * Stakeholder map.
 *
 * Each tracked person is a folder under
 * `.atelier/stakeholders/<id>/` containing:
 *
 *   profile.md   — front-matter (name, role, organization, handles,
 *                  ownerships, …) + markdown body for the team-shared
 *                  narrative. Tracked by git.
 *   private.md   — optional, free-form markdown. Personal notes that
 *                  shouldn't leak through the shared repo. Atelier's
 *                  init step adds `stakeholders/**​/private.md` to the
 *                  workspace .gitignore so this file is never
 *                  accidentally committed.
 *
 * Loaders default to `includePrivate: false` — the private layer is
 * opt-in by construction, not by remembering to scrub. Commands that
 * could ever surface stakeholder info to a third party (export, sync,
 * agent prompts unless explicitly asked) just never set the flag.
 *
 * No source folder partitioning (unlike items): stakeholders live in
 * a flat namespace because a person isn't bound to one source —
 * Sarah-the-PM is the same Sarah whether you encountered her in
 * Linear, Slack, or Figma.
 */

// ============================================================
// Errors
// ============================================================

export class StakeholderNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No stakeholder with id "${id}".`);
    this.name = "StakeholderNotFoundError";
  }
}

export class StakeholderAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A stakeholder with id "${id}" already exists.`);
    this.name = "StakeholderAlreadyExistsError";
  }
}

export class StakeholderFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid stakeholder file at ${filePath}:\n${detail}`);
    this.name = "StakeholderFileError";
  }
}

// ============================================================
// Slug helpers
// ============================================================

/**
 * Slugify a free-form name (or any string) into a folder-safe
 * stakeholder id. Lowercase, alnum + hyphens. Matches the pattern
 * the validator enforces, so callers can pass display names
 * ("Sarah Chen") and atelier handles the rest.
 */
export function slugifyStakeholderId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks (è → e, ñ → n) so slugs round-trip across
    // teammates with different keyboard layouts.
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

// ============================================================
// Path helpers
// ============================================================

function stakeholdersRoot(workspaceRoot: string): string {
  return workspacePaths(workspaceRoot).stakeholders;
}

function stakeholderFolderPath(workspaceRoot: string, id: string): string {
  return path.join(stakeholdersRoot(workspaceRoot), id);
}

function profilePath(workspaceRoot: string, id: string): string {
  return path.join(stakeholderFolderPath(workspaceRoot, id), "profile.md");
}

function privatePath(workspaceRoot: string, id: string): string {
  return path.join(stakeholderFolderPath(workspaceRoot, id), "private.md");
}

async function ensureFolder(workspaceRoot: string, id: string): Promise<string> {
  const dir = stakeholderFolderPath(workspaceRoot, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// Parse / serialize
// ============================================================

/**
 * Read profile.md text → front-matter + body. Throws
 * StakeholderFileError when the file's front-matter block is
 * missing or fails validation. Callers add the private layer (if
 * wanted) separately via {@link readPrivateBody}.
 */
export function parseProfileFile(
  text: string,
  filePath: string
): { frontMatter: StakeholderFrontMatter; body: string } {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new StakeholderFileError(
      filePath,
      "missing YAML front-matter (file must start with `---` on its first line)"
    );
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new StakeholderFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateStakeholderFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new StakeholderFileError(filePath, formatIssues(result.issues));
  }
  return { frontMatter: result.value, body: split.body };
}

export function serializeProfileFile(s: Stakeholder): string {
  const fm: Record<string, unknown> = {
    id: s.id,
    name: s.name,
  };
  if (s.role !== undefined) fm.role = s.role;
  if (s.organization !== undefined) fm.organization = s.organization;
  if (s.email !== undefined) fm.email = s.email;
  if (s.handles !== undefined && Object.keys(s.handles).length > 0) {
    fm.handles = s.handles;
  }
  if (s.ownerships !== undefined && s.ownerships.length > 0) {
    fm.ownerships = s.ownerships;
  }
  if (s.summary !== undefined && s.summary !== "") fm.summary = s.summary;
  if (s.fromSessions !== undefined && s.fromSessions.length > 0) {
    fm.fromSessions = s.fromSessions;
  }
  fm.createdAt = s.createdAt;
  fm.updatedAt = s.updatedAt;
  return buildFrontMatterFile(fm, s.profileBody);
}

// ============================================================
// CRUD
// ============================================================

export interface AddStakeholderOptions {
  /** Slug id; if omitted, derived from {@link AddStakeholderOptions.name}. */
  id?: string;
  /** Display name (required). */
  name: string;
  /** One-line role label ("PM", "Senior Engineer", …). */
  role?: string;
  /** Organisation / company / team. */
  organization?: string;
  /** Canonical email handle. */
  email?: string;
  /** Handle dictionary keyed by source (slack / github / linear / …). */
  handles?: Record<string, string>;
  /** What this person owns (feature ids, source:itemId pairs, repos). */
  ownerships?: string[];
  /** One-line elevator summary (long-form lives in profileBody). */
  summary?: string;
  /** Session ids that surfaced this stakeholder. */
  fromSessions?: string[];
  /** Markdown body for the shared profile.md (after front-matter). */
  profileBody?: string;
  /**
   * Optional markdown body for private.md. When supplied, atelier
   * writes private.md alongside profile.md. private.md is gitignored
   * via the workspace's .gitignore.
   */
  privateBody?: string;
}

export async function addStakeholder(
  workspaceRoot: string,
  opts: AddStakeholderOptions
): Promise<Stakeholder> {
  if (!opts.name) throw new Error("name is required");
  const id = (opts.id ?? slugifyStakeholderId(opts.name)).trim();
  if (!id) {
    throw new Error(
      'Could not derive a slug id from name — pass an explicit --id (lowercase, alphanumeric + hyphens).'
    );
  }

  const folder = stakeholderFolderPath(workspaceRoot, id);
  try {
    await fs.access(folder);
    throw new StakeholderAlreadyExistsError(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = new Date().toISOString();
  const stakeholder: Stakeholder = {
    id,
    name: opts.name,
    role: opts.role,
    organization: opts.organization,
    email: opts.email,
    handles: opts.handles,
    ownerships: opts.ownerships,
    summary: opts.summary,
    fromSessions: opts.fromSessions,
    createdAt: now,
    updatedAt: now,
    profileBody: opts.profileBody ?? "",
    privateBody: opts.privateBody,
  };

  const fmCheck = validateStakeholderFrontMatter(toFrontMatter(stakeholder));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(
      profilePath(workspaceRoot, id),
      formatIssues(fmCheck.issues)
    );
  }

  await ensureFolder(workspaceRoot, id);
  await fs.writeFile(
    profilePath(workspaceRoot, id),
    serializeProfileFile(stakeholder),
    "utf8"
  );
  if (opts.privateBody !== undefined && opts.privateBody !== "") {
    await fs.writeFile(privatePath(workspaceRoot, id), opts.privateBody, "utf8");
  }
  return stakeholder;
}

function toFrontMatter(s: Stakeholder): StakeholderFrontMatter {
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    organization: s.organization,
    email: s.email,
    handles: s.handles,
    ownerships: s.ownerships,
    summary: s.summary,
    fromSessions: s.fromSessions,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export interface LoadStakeholderOptions {
  /**
   * Read private.md alongside profile.md and attach it to the result.
   * Defaults to false — callers must explicitly opt in so the private
   * layer doesn't leak through code paths that forgot to scrub.
   */
  includePrivate?: boolean;
}

export async function loadStakeholder(
  workspaceRoot: string,
  id: string,
  opts: LoadStakeholderOptions = {}
): Promise<Stakeholder> {
  const filePath = profilePath(workspaceRoot, id);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StakeholderNotFoundError(id);
    }
    throw err;
  }
  const { frontMatter, body } = parseProfileFile(text, filePath);
  const stakeholder: Stakeholder = { ...frontMatter, profileBody: body };
  if (opts.includePrivate) {
    const priv = await readPrivateBody(workspaceRoot, id);
    if (priv !== null) stakeholder.privateBody = priv;
  }
  return stakeholder;
}

/**
 * Read just private.md for the given stakeholder. Returns null when
 * the file doesn't exist (the common case — most stakeholders never
 * accumulate private notes). Used by `loadStakeholder` when called
 * with `includePrivate: true`, and directly by the CLI's
 * `stakeholder note --private` flow.
 */
export async function readPrivateBody(
  workspaceRoot: string,
  id: string
): Promise<string | null> {
  try {
    return await fs.readFile(privatePath(workspaceRoot, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface StakeholderListing {
  stakeholder: Stakeholder;
  filePath: string;
  /** True when a private.md exists alongside, regardless of includePrivate. */
  hasPrivate: boolean;
}

/**
 * List every stakeholder under `.atelier/stakeholders/`. Skips
 * directory entries that don't have a profile.md (avoids surfacing
 * folders an agent dropped state into for reasons we don't care
 * about). Parse errors are returned in `errors` rather than thrown
 * so one bad file doesn't block the rest of the list.
 */
export async function listStakeholders(
  workspaceRoot: string,
  opts: LoadStakeholderOptions = {}
): Promise<{
  stakeholders: StakeholderListing[];
  errors: { filePath: string; error: Error }[];
}> {
  const root = stakeholdersRoot(workspaceRoot);
  const errors: { filePath: string; error: Error }[] = [];
  const results: StakeholderListing[] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { stakeholders: [], errors: [] };
    }
    throw err;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const filePath = profilePath(workspaceRoot, id);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push({ filePath, error: err as Error });
      continue;
    }
    try {
      const { frontMatter, body } = parseProfileFile(text, filePath);
      const stakeholder: Stakeholder = { ...frontMatter, profileBody: body };
      let hasPrivate = false;
      const priv = await readPrivateBody(workspaceRoot, id);
      if (priv !== null) {
        hasPrivate = true;
        if (opts.includePrivate) stakeholder.privateBody = priv;
      }
      results.push({ stakeholder, filePath, hasPrivate });
    } catch (err) {
      errors.push({ filePath, error: err as Error });
    }
  }
  return { stakeholders: results, errors };
}

export interface UpdateStakeholderOptions {
  /** Pass `""` to clear (where the field is optional). */
  name?: string;
  role?: string | null;
  organization?: string | null;
  email?: string | null;
  /**
   * When provided, replaces the handle dictionary wholesale. Pass an
   * empty object `{}` to clear all handles. Use {@link setHandle} for
   * the merge-in-place semantics.
   */
  handles?: Record<string, string>;
  /** When provided, replaces the ownership list wholesale. */
  ownerships?: string[];
  /** Pass `""` to clear summary. */
  summary?: string;
  /** Replacement markdown for profile.md. */
  profileBody?: string;
}

export async function updateStakeholder(
  workspaceRoot: string,
  id: string,
  patch: UpdateStakeholderOptions
): Promise<Stakeholder> {
  const existing = await loadStakeholder(workspaceRoot, id);
  const next: Stakeholder = { ...existing };
  if (patch.name !== undefined) {
    if (patch.name === "") throw new Error("name cannot be cleared (it's required)");
    next.name = patch.name;
  }
  if (patch.role !== undefined) {
    next.role = patch.role === null || patch.role === "" ? undefined : patch.role;
  }
  if (patch.organization !== undefined) {
    next.organization =
      patch.organization === null || patch.organization === ""
        ? undefined
        : patch.organization;
  }
  if (patch.email !== undefined) {
    next.email = patch.email === null || patch.email === "" ? undefined : patch.email;
  }
  if (patch.handles !== undefined) {
    next.handles = Object.keys(patch.handles).length === 0 ? undefined : patch.handles;
  }
  if (patch.ownerships !== undefined) {
    next.ownerships = patch.ownerships.length === 0 ? undefined : patch.ownerships;
  }
  if (patch.summary !== undefined) {
    next.summary = patch.summary === "" ? undefined : patch.summary;
  }
  if (patch.profileBody !== undefined) next.profileBody = patch.profileBody;
  next.updatedAt = new Date().toISOString();

  await ensureFolder(workspaceRoot, id);
  await fs.writeFile(profilePath(workspaceRoot, id), serializeProfileFile(next), "utf8");
  return next;
}

/**
 * Merge one handle into the stakeholder's `handles` dictionary
 * without touching the others. Pass `value: null` to delete a handle.
 * More ergonomic than calling {@link updateStakeholder} with a full
 * dictionary just to flip one entry.
 */
export async function setStakeholderHandle(
  workspaceRoot: string,
  id: string,
  kind: string,
  value: string | null
): Promise<Stakeholder> {
  if (!kind) throw new Error("handle kind cannot be empty");
  const existing = await loadStakeholder(workspaceRoot, id);
  const handles = { ...(existing.handles ?? {}) };
  if (value === null || value === "") {
    delete handles[kind];
  } else {
    handles[kind] = value;
  }
  return await updateStakeholder(workspaceRoot, id, { handles });
}

/**
 * Append one item to the stakeholder's `ownerships` list (deduped).
 * Useful for the agent's "Sarah owns the checkout feature" → CLI
 * call workflow without making the caller compute the union.
 */
export async function addStakeholderOwnership(
  workspaceRoot: string,
  id: string,
  ownership: string
): Promise<Stakeholder> {
  if (!ownership) throw new Error("ownership cannot be empty");
  const existing = await loadStakeholder(workspaceRoot, id);
  const ownerships = new Set(existing.ownerships ?? []);
  ownerships.add(ownership);
  return await updateStakeholder(workspaceRoot, id, {
    ownerships: Array.from(ownerships),
  });
}

export async function removeStakeholderOwnership(
  workspaceRoot: string,
  id: string,
  ownership: string
): Promise<Stakeholder> {
  const existing = await loadStakeholder(workspaceRoot, id);
  const ownerships = (existing.ownerships ?? []).filter((o) => o !== ownership);
  return await updateStakeholder(workspaceRoot, id, { ownerships });
}

/**
 * Append a free-form note to private.md (creating the file when
 * absent). When `header` is supplied, the appended block starts with
 * `## <header> — <timestamp>` so the file remains readable as a
 * running diary. The private file is gitignored at workspace level.
 */
export async function appendPrivateNote(
  workspaceRoot: string,
  id: string,
  body: string,
  opts: { header?: string } = {}
): Promise<string> {
  // Loading first ensures the stakeholder actually exists — we don't
  // create private notes for ghosts.
  await loadStakeholder(workspaceRoot, id);
  await ensureFolder(workspaceRoot, id);
  const file = privatePath(workspaceRoot, id);
  const now = new Date().toISOString();
  const header = opts.header
    ? `## ${opts.header} — ${now}\n\n`
    : `## ${now}\n\n`;
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n\n" : "";
  const next = existing + separator + header + body.trimEnd() + "\n";
  await fs.writeFile(file, next, "utf8");
  return file;
}

/**
 * Append a free-form note to profile.md's body (creating the section
 * when absent). Mirrors {@link appendPrivateNote} but writes to the
 * shared layer.
 */
export async function appendProfileNote(
  workspaceRoot: string,
  id: string,
  body: string,
  opts: { header?: string } = {}
): Promise<Stakeholder> {
  const existing = await loadStakeholder(workspaceRoot, id);
  const now = new Date().toISOString();
  const header = opts.header
    ? `## ${opts.header} — ${now}\n\n`
    : `## ${now}\n\n`;
  const separator =
    existing.profileBody.length > 0 && !existing.profileBody.endsWith("\n\n")
      ? "\n\n"
      : "";
  const nextBody = existing.profileBody + separator + header + body.trimEnd() + "\n";
  return await updateStakeholder(workspaceRoot, id, { profileBody: nextBody });
}

export async function removeStakeholder(
  workspaceRoot: string,
  id: string
): Promise<Stakeholder> {
  const existing = await loadStakeholder(workspaceRoot, id);
  const folder = stakeholderFolderPath(workspaceRoot, id);
  await fs.rm(folder, { recursive: true, force: true });
  return existing;
}

/**
 * Rename a stakeholder — change their slug id. Useful when the agent
 * initially derived a placeholder slug and a better one (matching
 * the canonical github handle, say) becomes obvious later.
 */
export async function renameStakeholder(
  workspaceRoot: string,
  oldId: string,
  newId: string
): Promise<Stakeholder> {
  if (!oldId) throw new Error("oldId is required");
  if (!newId) throw new Error("newId is required");
  if (oldId === newId) {
    return await loadStakeholder(workspaceRoot, oldId);
  }

  const existing = await loadStakeholder(workspaceRoot, oldId, { includePrivate: false });

  const targetFolder = stakeholderFolderPath(workspaceRoot, newId);
  try {
    await fs.access(targetFolder);
    throw new StakeholderAlreadyExistsError(newId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const next: Stakeholder = {
    ...existing,
    id: newId,
    updatedAt: new Date().toISOString(),
  };
  const fmCheck = validateStakeholderFrontMatter(toFrontMatter(next));
  if (!fmCheck.ok || !fmCheck.value) {
    throw new WorkspaceValidationError(
      profilePath(workspaceRoot, newId),
      formatIssues(fmCheck.issues)
    );
  }

  const oldFolder = stakeholderFolderPath(workspaceRoot, oldId);
  await fs.rename(oldFolder, targetFolder);
  await fs.writeFile(
    profilePath(workspaceRoot, newId),
    serializeProfileFile(next),
    "utf8"
  );
  return next;
}
