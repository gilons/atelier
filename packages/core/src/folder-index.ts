import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import type { ValidationIssue, ValidationResult } from "./types.js";

/**
 * The folder-index primitive — atelier's progressive-discovery unit.
 *
 * Every content folder carries a lightweight `index.yaml` declaring
 * what it is (name + kind/declaration + a brief description) and
 * listing its children, each with its own title + description. An
 * agent navigating the workspace reads ONE level's index, sees
 * summaries of what's below, and drills only into the branch it
 * needs — it never loads the whole workspace to find its way around.
 *
 * This module is deliberately content-agnostic: just the type, the
 * validator, and read/write helpers. The workspace-wide map + content
 * derivation live in `index-tree.ts`, which builds on this. Keeping
 * the primitive separate lets content modules (agents, …) write their
 * own indexes without a circular import on the map layer.
 */

// ============================================================
// Types
// ============================================================

/** One child entry inside a folder's index.yaml. */
export interface IndexChild {
  /**
   * Path of the child relative to the folder holding this index.
   * A trailing slash hints "this is a directory" (e.g. "discovery/");
   * file children have no slash (e.g. "learnings.md").
   */
  path: string;
  /** Short human title. */
  title: string;
  /** One-line overview of what's inside the child. */
  description?: string;
  /** What kind of thing the child is ("agent", "instruction", "file", …). */
  kind?: string;
}

/** The shape persisted as `index.yaml` in a content folder. */
export interface FolderIndex {
  /** Name of THIS folder / content. */
  name: string;
  /** Declaration — what kind of thing this folder is. */
  kind: string;
  /** Brief high-level description of what's inside. */
  description?: string;
  /** Children entries, each with its own title + description. */
  children?: IndexChild[];
}

export const INDEX_FILE = "index.yaml";

const INDEX_HEADER =
  "Folder index — atelier's progressive-discovery layer. Declares what\n" +
  "this folder is (name + kind + description) and lists its children so\n" +
  "an agent can navigate by summaries instead of loading everything.\n" +
  "Regenerate with `atelier map --rebuild`.";

// ============================================================
// Validation
// ============================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function validateFolderIndex(raw: unknown): ValidationResult<FolderIndex> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "expected an object at the top level" }] };
  }
  const { name, kind, description, children } = raw;
  if (!isNonEmptyString(name)) issues.push({ path: "$.name", message: "must be a non-empty string" });
  if (!isNonEmptyString(kind)) issues.push({ path: "$.kind", message: "must be a non-empty string" });
  if (description !== undefined && typeof description !== "string") {
    issues.push({ path: "$.description", message: "if present, must be a string" });
  }
  const outChildren: IndexChild[] = [];
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      issues.push({ path: "$.children", message: "if present, must be a list" });
    } else {
      children.forEach((c, i) => {
        if (!isObject(c)) {
          issues.push({ path: `$.children[${i}]`, message: "expected an object" });
          return;
        }
        if (!isNonEmptyString(c.path)) {
          issues.push({ path: `$.children[${i}].path`, message: "must be a non-empty string" });
        }
        if (!isNonEmptyString(c.title)) {
          issues.push({ path: `$.children[${i}].title`, message: "must be a non-empty string" });
        }
        if (c.description !== undefined && typeof c.description !== "string") {
          issues.push({ path: `$.children[${i}].description`, message: "if present, must be a string" });
        }
        if (c.kind !== undefined && !isNonEmptyString(c.kind)) {
          issues.push({ path: `$.children[${i}].kind`, message: "if present, must be a non-empty string" });
        }
        if (issues.length === 0) {
          const child: IndexChild = { path: c.path as string, title: c.title as string };
          if (c.description !== undefined) child.description = c.description as string;
          if (c.kind !== undefined) child.kind = c.kind as string;
          outChildren.push(child);
        }
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const value: FolderIndex = { name: name as string, kind: kind as string };
  if (description !== undefined) value.description = description as string;
  if (outChildren.length > 0) value.children = outChildren;
  return { ok: true, value, issues: [] };
}

// ============================================================
// Read / write index.yaml
// ============================================================

/** Read a folder's index.yaml. Returns null when absent or invalid. */
export async function readFolderIndex(absDir: string): Promise<FolderIndex | null> {
  const raw = await readYamlFile(path.join(absDir, INDEX_FILE));
  if (raw === null) return null;
  const result = validateFolderIndex(raw);
  return result.ok && result.value ? result.value : null;
}

/** Write a folder's index.yaml (stable ordering for clean diffs). */
export async function writeFolderIndex(absDir: string, idx: FolderIndex): Promise<void> {
  await fs.mkdir(absDir, { recursive: true });
  const ordered: Record<string, unknown> = { name: idx.name, kind: idx.kind };
  if (idx.description !== undefined) ordered.description = idx.description;
  if (idx.children && idx.children.length > 0) {
    ordered.children = idx.children.map((c) => {
      const o: Record<string, unknown> = { path: c.path, title: c.title };
      if (c.kind !== undefined) o.kind = c.kind;
      if (c.description !== undefined) o.description = c.description;
      return o;
    });
  }
  await writeYamlFile(path.join(absDir, INDEX_FILE), ordered, INDEX_HEADER);
}
