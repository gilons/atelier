import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { validateSpecManifest, formatIssues } from "./validation.js";
import { loadFeature, FeatureNotFoundError } from "./features.js";
import { loadDoc, DocNotFoundError } from "./docs.js";
import { loadReposConfig } from "./repos.js";
import {
  splitFrontMatter,
  parseFrontMatterYaml,
  buildFrontMatterFile,
} from "./front-matter.js";
import { WorkspaceValidationError } from "./workspace.js";
import type {
  Feature,
  FeatureCodeRef,
  FeatureDocRef,
  SpecChangeType,
  SpecManifest,
  SpecStatus,
  ValidationIssue,
} from "./types.js";

/**
 * Spec workflow (Slice 9).
 *
 * A spec is a folder under `.planning/issues/<id>/` that bundles:
 *   - README.md   — the manifest (front-matter) + a human-readable
 *                   overview that shows what's in the folder.
 *   - spec.md     — the detailed plan. Template chosen by change
 *                   type (new-feature, modification, ui, refactor,
 *                   bug, integration). The user/agent fleshes this out.
 *   - context.md  — a curated bundle: the feature descriptions,
 *                   doc references with their summaries, code refs
 *                   resolved to absolute paths on this machine.
 *   - prompt.md   — the handoff prompt to feed Claude Code (or any
 *                   agent) so it has everything it needs in one shot.
 *
 * Why a folder rather than a single file?
 *   - The manifest, spec, context, and prompt have different
 *     readers/writers. Splitting them keeps diffs small and lets
 *     each evolve independently.
 *   - When the change ships, additional artifacts (screenshots, test
 *     plans, migration notes) can live alongside without polluting
 *     the original spec file.
 */

// ============================================================
// Errors
// ============================================================

export class SpecAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A spec with id "${id}" already exists.`);
    this.name = "SpecAlreadyExistsError";
  }
}

export class SpecNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No spec with id "${id}".`);
    this.name = "SpecNotFoundError";
  }
}

export class SpecFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid spec file at ${filePath}:\n${detail}`);
    this.name = "SpecFileError";
  }
}

export class SpecReferenceValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Spec references invalid:\n${formatIssues(issues)}`);
    this.name = "SpecReferenceValidationError";
  }
}

// ============================================================
// ID derivation
// ============================================================

/**
 * `<YYYY-MM-DD>-<slug>` — date prefix gives natural sort order in
 * `ls`, slug is human-readable. We don't include a time component
 * because two specs created in the same minute almost always belong
 * together and the slug differentiates them.
 */
export function deriveSpecId(title: string, date: Date = new Date()): string {
  const datePart = date.toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  if (!slug) throw new Error("Could not derive slug from spec title");
  return `${datePart}-${slug}`;
}

// ============================================================
// Paths
// ============================================================

function specDir(workspaceRoot: string, id: string): string {
  return path.join(workspacePaths(workspaceRoot).issues, id);
}

function specFiles(workspaceRoot: string, id: string) {
  const root = specDir(workspaceRoot, id);
  return {
    root,
    readme: path.join(root, "README.md"),
    spec: path.join(root, "spec.md"),
    context: path.join(root, "context.md"),
    prompt: path.join(root, "prompt.md"),
  };
}

// ============================================================
// Templates
// ============================================================

/**
 * Return the body of spec.md for the given change type. Each template
 * is plain markdown — the agent (or human) fills in the sections.
 *
 * Adding a change type means editing this function and the type
 * definition; it's intentional rather than configurable.
 */
export function specTemplate(type: SpecChangeType, title: string): string {
  const header = `# ${title}\n\n`;
  switch (type) {
    case "new-feature":
      return (
        header +
        "## Goal\n\nWhy do we want this? What user problem does it solve?\n\n" +
        "## User journey\n\nWalk through the happy path step by step.\n\n" +
        "## States\n\n- Empty state\n- Loading state\n- Error state\n- Success state\n\n" +
        "## Acceptance criteria\n\n- [ ] …\n\n" +
        "## Out of scope\n\nThings we explicitly aren't doing in this slice.\n"
      );
    case "modification":
      return (
        header +
        "## Current behavior\n\nWhat happens today.\n\n" +
        "## Desired behavior\n\nWhat we want to happen instead.\n\n" +
        "## Why this change\n\nThe motivating need or feedback.\n\n" +
        "## Acceptance criteria\n\n- [ ] …\n\n" +
        "## Risks\n\nWhat could go wrong; how we mitigate.\n"
      );
    case "ui":
      return (
        header +
        "## Layout\n\nDescribe (or sketch) the page layout.\n\n" +
        "## Components needed\n\nList components — reuse existing ones where possible.\n\n" +
        "## States\n\n- Loading\n- Empty\n- Error\n- Populated\n\n" +
        "## Interactions\n\nWhat each click/keystroke does.\n\n" +
        "## Acceptance criteria\n\n- [ ] …\n"
      );
    case "refactor":
      return (
        header +
        "## Current shape\n\nWhere the code lives today and why it's a problem.\n\n" +
        "## Desired shape\n\nThe target structure.\n\n" +
        "## Why now\n\nThe debt being paid; the unlock this enables.\n\n" +
        "## Migration plan\n\nStep-by-step, keeping the system green at each step.\n\n" +
        "## Acceptance criteria\n\n- [ ] Functional parity (no behavior change)\n- [ ] …\n"
      );
    case "bug":
      return (
        header +
        "## Symptom\n\nWhat the user observes.\n\n" +
        "## Steps to reproduce\n\n1. …\n2. …\n\n" +
        "## Expected behavior\n\nWhat should happen instead.\n\n" +
        "## Suspected root cause\n\nWhere the bug likely lives.\n\n" +
        "## Acceptance criteria\n\n- [ ] Symptom no longer reproduces\n- [ ] Regression test added\n"
      );
    case "integration":
      return (
        header +
        "## External system\n\nWhat we're integrating with.\n\n" +
        "## Auth model\n\nHow we authenticate; where credentials live.\n\n" +
        "## Data flow\n\nWhat data crosses the boundary, in which direction.\n\n" +
        "## Failure modes\n\nNetwork errors, rate limits, schema drift; how we handle each.\n\n" +
        "## Acceptance criteria\n\n- [ ] …\n"
      );
  }
}

/**
 * Render the README.md for a spec folder. Includes the manifest as
 * front-matter and a human-readable overview pointing at the
 * sibling files.
 */
function renderReadme(manifest: SpecManifest): string {
  const fm: Record<string, unknown> = {
    id: manifest.id,
    title: manifest.title,
    type: manifest.type,
    status: manifest.status,
  };
  if (manifest.features.length > 0) fm.features = manifest.features;
  if (manifest.codeRefs.length > 0) fm.codeRefs = manifest.codeRefs;
  if (manifest.docRefs.length > 0) fm.docRefs = manifest.docRefs;
  fm.createdAt = manifest.createdAt;
  fm.updatedAt = manifest.updatedAt;

  const body =
    `# ${manifest.title}\n\n` +
    `**Type:** ${manifest.type}  ·  **Status:** ${manifest.status}\n\n` +
    `Files in this folder:\n` +
    `- \`spec.md\` — the detailed plan\n` +
    `- \`context.md\` — curated docs, code refs, related features\n` +
    `- \`prompt.md\` — handoff prompt to feed your coding agent\n`;
  return buildFrontMatterFile(fm, body);
}

interface RenderContextInput {
  manifest: SpecManifest;
  features: Feature[];
  /** Resolved local paths for each codeRef. */
  resolvedCodeRefs: Array<{ repo: string; path?: string; absPath: string }>;
  /**
   * For each docRef, the doc entry we found (if any). Lets the
   * agent skim summaries without re-fetching.
   */
  resolvedDocs: Array<{
    ref: FeatureDocRef;
    title?: string;
    summary?: string;
    classification?: string;
    found: boolean;
  }>;
}

function renderContext(input: RenderContextInput): string {
  const lines: string[] = [];
  lines.push(`# Context for ${input.manifest.id}`);
  lines.push("");
  if (input.features.length > 0) {
    lines.push("## Related features");
    for (const f of input.features) {
      lines.push("");
      lines.push(`### \`${f.id}\` — ${f.name}`);
      if (f.description) lines.push(f.description);
      if (f.codeRefs.length > 0) {
        lines.push("");
        lines.push("Code refs (from feature):");
        for (const r of f.codeRefs) {
          const tail = r.path ? `:${r.path}` : "";
          lines.push(`- \`${r.repo}${tail}\``);
        }
      }
      if (f.docRefs.length > 0) {
        lines.push("");
        lines.push("Doc refs (from feature):");
        for (const r of f.docRefs) {
          const ttl = r.title ? ` — ${r.title}` : "";
          lines.push(`- \`${r.source}:${r.docId}\`${ttl}`);
        }
      }
    }
    lines.push("");
  }
  if (input.resolvedCodeRefs.length > 0) {
    lines.push("## Code references");
    lines.push("");
    for (const r of input.resolvedCodeRefs) {
      const tail = r.path ? `:${r.path}` : "";
      lines.push(`- \`${r.repo}${tail}\` → \`${r.absPath}\``);
    }
    lines.push("");
  }
  if (input.resolvedDocs.length > 0) {
    lines.push("## Doc references");
    lines.push("");
    for (const d of input.resolvedDocs) {
      const ttl = d.title ?? d.ref.title ?? d.ref.docId;
      const cls = d.classification ? ` (${d.classification})` : "";
      const note = d.found ? "" : " — *not yet indexed*";
      lines.push(`- \`${d.ref.source}:${d.ref.docId}\`${cls} — ${ttl}${note}`);
      if (d.summary) lines.push(`  - ${d.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderPrompt(manifest: SpecManifest, contextPath: string): string {
  return [
    `# Handoff prompt — ${manifest.id}`,
    "",
    `You are working on the following change:`,
    "",
    `> ${manifest.title}`,
    "",
    `Type: **${manifest.type}**`,
    "",
    `Please read this folder before starting:`,
    `- \`spec.md\` — the detailed plan`,
    `- \`${path.basename(contextPath)}\` — curated context (related features, docs, code refs)`,
    "",
    `Then:`,
    `1. Confirm you've read the spec and context.`,
    `2. Outline your plan and flag any open questions.`,
    `3. Implement the change against the referenced code refs.`,
    `4. Update \`spec.md\` with anything that turned out to be different from the plan.`,
    "",
  ].join("\n");
}

// ============================================================
// Create / read / update / remove
// ============================================================

export interface CreateSpecOptions {
  title: string;
  type: SpecChangeType;
  /** Optional explicit id (overrides date+slug derivation). */
  id?: string;
  /** Initial status. Defaults to "drafting". */
  status?: SpecStatus;
  /** Feature ids to bundle into context (must exist). */
  features?: string[];
  /** Additional code refs (must reference registered repos). */
  codeRefs?: FeatureCodeRef[];
  /** Additional doc refs. */
  docRefs?: FeatureDocRef[];
  /**
   * Skip cross-reference validation (used by tests and bulk imports).
   * Doc refs are always tolerant — missing docs are reported in
   * context.md as "not yet indexed" rather than failing the create.
   */
  skipReferenceValidation?: boolean;
  /** Inject a `now` for deterministic tests. */
  now?: Date;
}

async function validateRefs(
  workspaceRoot: string,
  features: string[],
  codeRefs: FeatureCodeRef[]
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const [i, fid] of features.entries()) {
    try {
      await loadFeature(workspaceRoot, fid);
    } catch (err) {
      if (err instanceof FeatureNotFoundError) {
        issues.push({
          path: `features[${i}]`,
          message: `feature "${fid}" is not registered`,
        });
      } else {
        throw err;
      }
    }
  }
  if (codeRefs.length > 0) {
    const cfg = await loadReposConfig(workspaceRoot);
    const known = new Set(cfg.repos.map((r) => r.name));
    codeRefs.forEach((ref, idx) => {
      if (!known.has(ref.repo)) {
        issues.push({
          path: `codeRefs[${idx}].repo`,
          message: `repo "${ref.repo}" is not registered`,
        });
      }
    });
  }
  return issues;
}

export async function createSpec(
  workspaceRoot: string,
  opts: CreateSpecOptions
): Promise<{ manifest: SpecManifest; paths: ReturnType<typeof specFiles> }> {
  if (!opts.title || opts.title.trim().length === 0) {
    throw new Error("title is required");
  }
  const id = opts.id ?? deriveSpecId(opts.title, opts.now);
  const features = opts.features ?? [];
  const codeRefs = opts.codeRefs ?? [];
  const docRefs = opts.docRefs ?? [];

  if (!opts.skipReferenceValidation) {
    const issues = await validateRefs(workspaceRoot, features, codeRefs);
    if (issues.length > 0) throw new SpecReferenceValidationError(issues);
  }

  const paths = specFiles(workspaceRoot, id);
  try {
    await fs.access(paths.root);
    throw new SpecAlreadyExistsError(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const now = (opts.now ?? new Date()).toISOString();
  const manifest: SpecManifest = {
    id,
    title: opts.title,
    type: opts.type,
    status: opts.status ?? "drafting",
    features,
    codeRefs,
    docRefs,
    createdAt: now,
    updatedAt: now,
  };

  // Sanity-check the manifest once more.
  const check = validateSpecManifest(manifest);
  if (!check.ok) {
    throw new WorkspaceValidationError(paths.readme, formatIssues(check.issues));
  }

  await fs.mkdir(paths.root, { recursive: true });

  // Resolve referenced features for context.md.
  const loadedFeatures: Feature[] = [];
  for (const fid of features) {
    try {
      loadedFeatures.push(await loadFeature(workspaceRoot, fid));
    } catch {
      // Skip silently — validation already ran above (or was skipped).
    }
  }

  // Resolve code refs to absolute paths.
  const repoCfg = await loadReposConfig(workspaceRoot);
  const reposByName = new Map(repoCfg.repos.map((r) => [r.name, r]));
  const resolvedCodeRefs = [
    ...new Set(
      [...codeRefs, ...loadedFeatures.flatMap((f) => f.codeRefs)].map(
        (r) => `${r.repo}:${r.path ?? ""}`
      )
    ),
  ].map((key) => {
    const [repo, refPath] = splitOnce(key, ":");
    const reg = reposByName.get(repo);
    const localPath = reg?.localPath ?? repo;
    const absRoot = path.resolve(workspaceRoot, localPath);
    const absPath = refPath ? path.join(absRoot, refPath) : absRoot;
    return { repo, path: refPath || undefined, absPath };
  });

  // Resolve doc refs — look each one up in the doc map.
  const allDocRefs = [
    ...docRefs,
    ...loadedFeatures.flatMap((f) => f.docRefs),
  ];
  // Dedupe by (source, docId).
  const seenDocKeys = new Set<string>();
  const uniqueDocRefs = allDocRefs.filter((r) => {
    const k = `${r.source}::${r.docId}`;
    if (seenDocKeys.has(k)) return false;
    seenDocKeys.add(k);
    return true;
  });
  const resolvedDocs = [] as RenderContextInput["resolvedDocs"];
  for (const ref of uniqueDocRefs) {
    try {
      const doc = await loadDoc(workspaceRoot, ref.source, ref.docId);
      resolvedDocs.push({
        ref,
        title: doc.title,
        summary: doc.overview,
        classification: doc.classification,
        found: true,
      });
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        resolvedDocs.push({ ref, found: false });
      } else {
        throw err;
      }
    }
  }

  await fs.writeFile(paths.readme, renderReadme(manifest), "utf8");
  await fs.writeFile(paths.spec, specTemplate(opts.type, opts.title), "utf8");
  await fs.writeFile(
    paths.context,
    renderContext({ manifest, features: loadedFeatures, resolvedCodeRefs, resolvedDocs }),
    "utf8"
  );
  await fs.writeFile(paths.prompt, renderPrompt(manifest, paths.context), "utf8");

  return { manifest, paths };
}

function splitOnce(s: string, delim: string): [string, string] {
  const idx = s.indexOf(delim);
  if (idx === -1) return [s, ""];
  return [s.slice(0, idx), s.slice(idx + delim.length)];
}

export async function loadSpec(
  workspaceRoot: string,
  id: string
): Promise<SpecManifest> {
  const paths = specFiles(workspaceRoot, id);
  let text: string;
  try {
    text = await fs.readFile(paths.readme, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpecNotFoundError(id);
    }
    throw err;
  }
  const split = splitFrontMatter(text);
  if (!split) {
    throw new SpecFileError(paths.readme, "missing front-matter");
  }
  let raw: unknown;
  try {
    raw = parseFrontMatterYaml(split.frontMatterRaw);
  } catch (err) {
    throw new SpecFileError(paths.readme, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateSpecManifest(raw);
  if (!result.ok || !result.value) {
    throw new SpecFileError(paths.readme, formatIssues(result.issues));
  }
  return result.value;
}

export interface SpecListing {
  manifest: SpecManifest;
  dir: string;
}

export async function listSpecs(workspaceRoot: string): Promise<{
  specs: SpecListing[];
  errors: { dir: string; error: Error }[];
}> {
  const root = workspacePaths(workspaceRoot).issues;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { specs: [], errors: [] };
    }
    throw err;
  }
  const specs: SpecListing[] = [];
  const errors: { dir: string; error: Error }[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      specs.push({ manifest: await loadSpec(workspaceRoot, e.name), dir });
    } catch (err) {
      errors.push({ dir, error: err as Error });
    }
  }
  return { specs, errors };
}

export interface UpdateSpecOptions {
  status?: SpecStatus;
  title?: string;
}

export async function updateSpec(
  workspaceRoot: string,
  id: string,
  patch: UpdateSpecOptions
): Promise<SpecManifest> {
  const current = await loadSpec(workspaceRoot, id);
  const next: SpecManifest = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const paths = specFiles(workspaceRoot, id);
  await fs.writeFile(paths.readme, renderReadme(next), "utf8");
  return next;
}

export async function removeSpec(workspaceRoot: string, id: string): Promise<SpecManifest> {
  const manifest = await loadSpec(workspaceRoot, id);
  await fs.rm(specDir(workspaceRoot, id), { recursive: true, force: true });
  return manifest;
}
