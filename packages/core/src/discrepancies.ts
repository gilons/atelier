import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { validateDiscrepancyLog, formatIssues } from "./validation.js";
import { workspacePaths } from "./paths.js";
import { WorkspaceValidationError } from "./workspace.js";
import type {
  Discrepancy,
  DiscrepancyCodeRef,
  DiscrepancyDocRef,
  DiscrepancyLog,
  DiscrepancySeverity,
  DiscrepancyStatus,
} from "./types.js";

/**
 * Discrepancy log: a single YAML file recording every observed
 * mismatch between what a doc claims and what the code does. Slice 7
 * establishes the schema and CRUD — detection (Phase 3) writes batches
 * to this log; the sync engine and review flows read it.
 *
 * Why one file vs. per-entry files (like features/docs)?
 *   - Discrepancies are short, structured records; a tabular view is
 *     the primary use case (severity x status pivot).
 *   - Phase 3 detection writes many entries at once; per-file would
 *     thrash the filesystem and the diff.
 *   - Free-form prose for notes lives in a single field, so the
 *     "markdown body" affordance that features/docs need isn't useful
 *     here.
 */

const HEADER =
  "Discrepancies between documented behavior and observed behavior.\n" +
  "Use `atelier discrepancy add/resolve` rather than hand-editing where possible.";

// ============================================================
// Errors
// ============================================================

export class DiscrepancyAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A discrepancy with id "${id}" already exists.`);
    this.name = "DiscrepancyAlreadyExistsError";
  }
}

export class DiscrepancyNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No discrepancy with id "${id}".`);
    this.name = "DiscrepancyNotFoundError";
  }
}

// ============================================================
// Load / save
// ============================================================

export async function loadDiscrepancyLog(
  workspaceRoot: string
): Promise<DiscrepancyLog> {
  const p = workspacePaths(workspaceRoot);
  const raw = (await readYamlFile(p.discrepanciesLog)) ?? {
    version: 1,
    discrepancies: [],
  };
  const result = validateDiscrepancyLog(raw);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(
      p.discrepanciesLog,
      formatIssues(result.issues)
    );
  }
  return result.value;
}

export async function saveDiscrepancyLog(
  workspaceRoot: string,
  log: DiscrepancyLog
): Promise<void> {
  const p = workspacePaths(workspaceRoot);
  const result = validateDiscrepancyLog(log);
  if (!result.ok || !result.value) {
    throw new WorkspaceValidationError(
      p.discrepanciesLog,
      formatIssues(result.issues)
    );
  }
  await writeYamlFile(p.discrepanciesLog, result.value, HEADER);
}

// ============================================================
// CRUD
// ============================================================

/**
 * Derive a discrepancy id from the claim or feature. We don't auto-id
 * by timestamp because the log is small enough that slug ids are more
 * useful in the CLI ("resolve auth-expiry-mismatch" beats "resolve
 * d-2026-05-16-001").
 */
export function deriveDiscrepancyId(seed: string): string {
  return seed
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export interface AddDiscrepancyOptions {
  /** Optional explicit id. Derived from claim/feature otherwise. */
  id?: string;
  /** Feature this is associated with (optional). */
  feature?: string;
  /** What the doc claims. */
  claim: string;
  /** What the code actually does. */
  observed: string;
  /** Severity (default "medium"). */
  severity?: DiscrepancySeverity;
  /** Initial status (default "open"). */
  status?: DiscrepancyStatus;
  /** Pointer to the doc making the claim. */
  docRef?: DiscrepancyDocRef;
  /** Pointer to the contradicting code. */
  codeRef?: DiscrepancyCodeRef;
  /** Free-form notes. */
  notes?: string;
}

export async function addDiscrepancy(
  workspaceRoot: string,
  opts: AddDiscrepancyOptions
): Promise<Discrepancy> {
  if (!opts.claim || opts.claim.trim().length === 0) {
    throw new Error("claim is required");
  }
  if (!opts.observed || opts.observed.trim().length === 0) {
    throw new Error("observed is required");
  }

  const log = await loadDiscrepancyLog(workspaceRoot);

  let id = opts.id ?? deriveDiscrepancyId(opts.feature ?? opts.claim);
  if (!id) {
    throw new Error(
      "Could not derive a slug id from claim/feature. Pass --id explicitly."
    );
  }

  // De-duplicate the id by appending -2, -3 when auto-derived.
  if (log.discrepancies.some((d) => d.id === id)) {
    if (opts.id !== undefined) {
      throw new DiscrepancyAlreadyExistsError(id);
    }
    let suffix = 2;
    while (log.discrepancies.some((d) => d.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const now = new Date().toISOString();
  const entry: Discrepancy = {
    id,
    claim: opts.claim,
    observed: opts.observed,
    severity: opts.severity ?? "medium",
    status: opts.status ?? "open",
    createdAt: now,
    updatedAt: now,
  };
  if (opts.feature !== undefined) entry.feature = opts.feature;
  if (opts.docRef !== undefined) entry.docRef = opts.docRef;
  if (opts.codeRef !== undefined) entry.codeRef = opts.codeRef;
  if (opts.notes !== undefined) entry.notes = opts.notes;

  log.discrepancies.push(entry);
  await saveDiscrepancyLog(workspaceRoot, log);
  return entry;
}

export interface DiscrepancyFilter {
  status?: DiscrepancyStatus;
  severity?: DiscrepancySeverity;
  feature?: string;
}

/**
 * List discrepancies, optionally filtered. Returns entries in
 * descending severity (critical → low), then ascending createdAt for
 * stable sort.
 */
export async function listDiscrepancies(
  workspaceRoot: string,
  filter: DiscrepancyFilter = {}
): Promise<Discrepancy[]> {
  const log = await loadDiscrepancyLog(workspaceRoot);
  const severityOrder: Record<DiscrepancySeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return log.discrepancies
    .filter((d) => !filter.status || d.status === filter.status)
    .filter((d) => !filter.severity || d.severity === filter.severity)
    .filter((d) => !filter.feature || d.feature === filter.feature)
    .slice()
    .sort((a, b) => {
      const s = severityOrder[a.severity] - severityOrder[b.severity];
      if (s !== 0) return s;
      return a.createdAt.localeCompare(b.createdAt);
    });
}

export async function loadDiscrepancy(
  workspaceRoot: string,
  id: string
): Promise<Discrepancy> {
  const log = await loadDiscrepancyLog(workspaceRoot);
  const entry = log.discrepancies.find((d) => d.id === id);
  if (!entry) throw new DiscrepancyNotFoundError(id);
  return entry;
}

export interface UpdateDiscrepancyOptions {
  status?: DiscrepancyStatus;
  severity?: DiscrepancySeverity;
  /** Append text to the notes field (with a separating newline). */
  appendNotes?: string;
  /** Replace the notes field entirely. */
  notes?: string;
}

/**
 * Update lifecycle fields on a discrepancy. Used by both manual review
 * (`atelier discrepancy resolve <id>`) and Phase 3 auto-detection
 * (which can mark previously-open entries as resolved when the
 * claim/code mismatch goes away).
 */
export async function updateDiscrepancy(
  workspaceRoot: string,
  id: string,
  patch: UpdateDiscrepancyOptions
): Promise<Discrepancy> {
  const log = await loadDiscrepancyLog(workspaceRoot);
  const idx = log.discrepancies.findIndex((d) => d.id === id);
  if (idx === -1) throw new DiscrepancyNotFoundError(id);
  const entry = log.discrepancies[idx];
  if (patch.status !== undefined) entry.status = patch.status;
  if (patch.severity !== undefined) entry.severity = patch.severity;
  if (patch.notes !== undefined) entry.notes = patch.notes;
  if (patch.appendNotes !== undefined) {
    const sep = entry.notes && entry.notes.length > 0 ? "\n" : "";
    entry.notes = (entry.notes ?? "") + sep + patch.appendNotes;
  }
  entry.updatedAt = new Date().toISOString();
  await saveDiscrepancyLog(workspaceRoot, log);
  return entry;
}

export async function removeDiscrepancy(
  workspaceRoot: string,
  id: string
): Promise<Discrepancy> {
  const log = await loadDiscrepancyLog(workspaceRoot);
  const idx = log.discrepancies.findIndex((d) => d.id === id);
  if (idx === -1) throw new DiscrepancyNotFoundError(id);
  const [removed] = log.discrepancies.splice(idx, 1);
  await saveDiscrepancyLog(workspaceRoot, log);
  return removed;
}
