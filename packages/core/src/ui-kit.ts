import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inspectProjects } from "./project-inspect.js";

/**
 * UI kit detection — the reusable building blocks of the UI:
 * components and design tokens.
 *
 * These live in code, so atelier reads them deterministically: where
 * components live (component directories across apps + shared
 * packages, with counts + a few sample names) and where design tokens
 * live (Tailwind config, tokens.json, theme files). They become the
 * "derive, don't generate" vocabulary the ui-design live companion
 * composes screens from — reference an existing component / token,
 * don't reinvent one.
 *
 * Bounded + conservative: we check conventional locations and walk a
 * couple of levels, never deep-scanning the whole tree.
 */

export interface ComponentSource {
  /** "kit:<repo>/<relDir>" — a directory of reusable components. */
  ref: string;
  repo: string;
  /** Directory (relative to the repo) holding the components. */
  dir: string;
  /** Number of component files found (capped). */
  count: number;
  /** Up to a few sample component names. */
  samples: string[];
}

export interface TokenSource {
  /** "tokens:<repo>/<relFile>". */
  ref: string;
  repo: string;
  /** File (relative to the repo) that defines tokens/theme. */
  file: string;
  /** "tailwind" | "tokens-json" | "theme" | "style-dictionary". */
  kind: string;
}

export interface UiKit {
  components: ComponentSource[];
  tokens: TokenSource[];
}

const COMPONENT_EXTS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);
const COMPONENT_DIR_CANDIDATES = [
  "components",
  "src/components",
  "app/components",
  "ui",
  "src/ui",
  "lib/components",
  "src/lib/components",
];
const WALK_IGNORE = new Set(["node_modules", ".git", "dist", "build", "__tests__", "__snapshots__"]);

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const isComponentName = (base: string): boolean => /^[A-Z]/.test(base) && !/\.(test|spec|stories)\./.test(base);

/** Walk a component dir (bounded) counting component files + samples. */
async function scanComponents(
  absDir: string,
  depth = 0,
  acc: { count: number; samples: string[] } = { count: 0, samples: [] }
): Promise<{ count: number; samples: string[] }> {
  if (depth > 3 || acc.count >= 500) return acc;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.count >= 500) break;
    if (e.name.startsWith(".") || WALK_IGNORE.has(e.name)) continue;
    if (e.isDirectory()) {
      await scanComponents(path.join(absDir, e.name), depth + 1, acc);
    } else {
      const ext = e.name.slice(e.name.lastIndexOf("."));
      if (!COMPONENT_EXTS.has(ext)) continue;
      const base = e.name.slice(0, e.name.lastIndexOf("."));
      // Skip framework sentinels (Next/SvelteKit/Remix routing files).
      if (base.startsWith("+") || base.startsWith("_") || base === "index" || base === "page" || base === "layout") {
        continue;
      }
      if (!isComponentName(base)) continue;
      acc.count++;
      if (acc.samples.length < 6) acc.samples.push(base);
    }
  }
  return acc;
}

const TOKEN_FILES: { file: string; kind: string }[] = [
  { file: "tailwind.config.js", kind: "tailwind" },
  { file: "tailwind.config.ts", kind: "tailwind" },
  { file: "tailwind.config.cjs", kind: "tailwind" },
  { file: "tailwind.config.mjs", kind: "tailwind" },
  { file: "tokens.json", kind: "tokens-json" },
  { file: "design-tokens.json", kind: "tokens-json" },
  { file: "src/tokens.json", kind: "tokens-json" },
  { file: "tokens/tokens.json", kind: "tokens-json" },
  { file: "theme.ts", kind: "theme" },
  { file: "theme.js", kind: "theme" },
  { file: "src/theme.ts", kind: "theme" },
  { file: "style-dictionary.config.js", kind: "style-dictionary" },
  { file: "style-dictionary.config.json", kind: "style-dictionary" },
];

/** Shallow-scan for *.tokens.json at the package root + src/. */
async function findTokenJsonGlobs(pkgAbs: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["", "src"]) {
    const dir = sub ? path.join(pkgAbs, sub) : pkgAbs;
    try {
      for (const name of await fs.readdir(dir)) {
        if (name.endsWith(".tokens.json")) out.push(sub ? `${sub}/${name}` : name);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Detect the workspace's UI kit — component sources + token sources —
 * across every registered repo (apps + shared packages).
 */
export async function detectUiKit(workspaceRoot: string): Promise<UiKit> {
  const { repos } = await inspectProjects(workspaceRoot);
  const components: ComponentSource[] = [];
  const tokens: TokenSource[] = [];
  const seenComponentDirs = new Set<string>();

  for (const r of repos) {
    if (!r.exists) continue;
    for (const p of r.packages) {
      const pkgRel = p.path === "." ? "" : p.path;
      const pkgAbs = pkgRel ? path.join(r.absPath, pkgRel) : r.absPath;

      // Components.
      for (const cand of COMPONENT_DIR_CANDIDATES) {
        const relDir = pkgRel ? `${pkgRel}/${cand}` : cand;
        const key = `${r.repo}:${relDir}`;
        if (seenComponentDirs.has(key)) continue;
        const abs = path.join(pkgAbs, cand);
        if (!(await isDir(abs))) continue;
        const { count, samples } = await scanComponents(abs);
        if (count === 0) continue;
        seenComponentDirs.add(key);
        components.push({
          ref: `kit:${r.repo}/${relDir}`,
          repo: r.repo,
          dir: relDir,
          count,
          samples: samples.sort(),
        });
      }

      // Tokens (fixed candidates).
      for (const { file, kind } of TOKEN_FILES) {
        const relFile = pkgRel ? `${pkgRel}/${file}` : file;
        if (await fileExists(path.join(pkgAbs, file))) {
          tokens.push({ ref: `tokens:${r.repo}/${relFile}`, repo: r.repo, file: relFile, kind });
        }
      }
      // Tokens (*.tokens.json glob).
      for (const g of await findTokenJsonGlobs(pkgAbs)) {
        const relFile = pkgRel ? `${pkgRel}/${g}` : g;
        tokens.push({ ref: `tokens:${r.repo}/${relFile}`, repo: r.repo, file: relFile, kind: "tokens-json" });
      }
    }
  }

  components.sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref));
  tokens.sort((a, b) => a.ref.localeCompare(b.ref));
  return { components, tokens };
}
