import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listRepos } from "./repos.js";
import { detectApps, type DetectedApp } from "./ui-apps.js";

/**
 * Navigation extraction — the deterministic seed for an app's
 * navigation map.
 *
 * Routes live in code, and most modern UI frameworks use a *file-based
 * router* whose conventions are mechanical: a file at a path becomes a
 * route. atelier reads those conventions directly (no LLM) and emits a
 * route list per app — the ui-design agent builds the navigation map +
 * connects apps on top of this.
 *
 * Frameworks without a filesystem routing convention (plain React,
 * Vue, Solid, …) return no routes: the agent reads their routing code
 * itself. We only claim what we can know deterministically.
 */

export interface RouteEntry {
  /** Normalized route path, e.g. "/", "/blog/[slug]". */
  route: string;
  /** Source file (relative to the app dir) the route came from. */
  file: string;
  /** True when the route has a dynamic segment. */
  dynamic: boolean;
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".svelte-kit", "__tests__"]);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** First existing dir among candidates (relative to appDir). */
async function firstDir(appDir: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const abs = path.join(appDir, c);
    try {
      if ((await fs.stat(abs)).isDirectory()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Recursively collect files under root (relative paths, posix). */
async function walk(rootAbs: string, rel = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(rootAbs, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(rootAbs, childRel)));
    else out.push(childRel);
  }
  return out;
}

const ext = (f: string) => f.slice(f.lastIndexOf("."));
const PAGE_EXTS = new Set([".tsx", ".ts", ".jsx", ".js", ".mdx", ".md", ".astro", ".vue", ".svelte", ".html"]);

function isDynamic(route: string): boolean {
  return /\[|\]|:/.test(route);
}

function normalize(segments: string[]): string {
  const segs = segments.filter((s) => s.length > 0);
  return segs.length === 0 ? "/" : "/" + segs.join("/");
}

/** Drop Next/SvelteKit route groups like "(marketing)". */
function dropGroups(segs: string[]): string[] {
  return segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
}

// "dir-style" (app router): a page file marks its containing dir as a route.
function appDirRoutes(files: string[], isPageFile: (base: string) => boolean): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const f of files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (!isPageFile(base)) continue;
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    const route = normalize(dropGroups(dir.split("/")));
    out.push({ route, file: f, dynamic: isDynamic(route) });
  }
  return out;
}

// "file-style" (pages router): each page file's path (minus ext) is the
// route; an `index` basename collapses to its parent.
function fileRoutes(
  files: string[],
  opts: { exclude?: (rel: string) => boolean } = {}
): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const f of files) {
    if (!PAGE_EXTS.has(ext(f))) continue;
    if (opts.exclude?.(f)) continue;
    const noExt = f.slice(0, f.lastIndexOf("."));
    let segs = dropGroups(noExt.split("/"));
    if (segs[segs.length - 1] === "index") segs = segs.slice(0, -1);
    const route = normalize(segs);
    out.push({ route, file: f, dynamic: isDynamic(route) });
  }
  return out;
}

// Remix flat-routes (best effort): dots are separators, `$x` dynamic,
// `_index` is the index, leading-underscore segments are pathless.
function remixRoutes(files: string[]): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const f of files) {
    if (!PAGE_EXTS.has(ext(f))) continue;
    const base = f.slice(f.lastIndexOf("/") + 1, f.lastIndexOf("."));
    const segs: string[] = [];
    for (const p of base.split(".")) {
      if (p === "_index" || p === "") continue; // index route
      if (p.startsWith("_")) continue; // pathless layout segment
      if (p === "$") segs.push("[...]"); // splat
      else if (p.startsWith("$")) segs.push(`[${p.slice(1)}]`); // dynamic
      else segs.push(p);
    }
    const route = normalize(segs);
    out.push({ route, file: f, dynamic: isDynamic(route) });
  }
  return out;
}

function dedupeSort(routes: RouteEntry[]): RouteEntry[] {
  const seen = new Map<string, RouteEntry>();
  for (const r of routes) if (!seen.has(r.route)) seen.set(r.route, r);
  return [...seen.values()].sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Extract routes from an app directory given its framework. Returns []
 * for frameworks without a filesystem routing convention.
 */
export async function extractRoutes(appDir: string, framework: string): Promise<RouteEntry[]> {
  switch (framework) {
    case "Next.js": {
      const appRoot = await firstDir(appDir, ["app", "src/app"]);
      if (appRoot) {
        const files = await walk(path.join(appDir, appRoot));
        const routes = appDirRoutes(files, (b) => /^page\.(tsx|ts|jsx|js|mdx)$/.test(b));
        if (routes.length) return dedupeSort(routes);
      }
      const pagesRoot = await firstDir(appDir, ["pages", "src/pages"]);
      if (pagesRoot) {
        const files = await walk(path.join(appDir, pagesRoot));
        return dedupeSort(
          fileRoutes(files, {
            exclude: (rel) => /^_/.test(rel.slice(rel.lastIndexOf("/") + 1)) || rel.startsWith("api/") || rel.includes("/api/"),
          })
        );
      }
      return [];
    }
    case "SvelteKit": {
      const root = await firstDir(appDir, ["src/routes"]);
      if (!root) return [];
      const files = await walk(path.join(appDir, root));
      return dedupeSort(appDirRoutes(files, (b) => b === "+page.svelte"));
    }
    case "Astro": {
      const root = await firstDir(appDir, ["src/pages"]);
      if (!root) return [];
      return dedupeSort(fileRoutes(await walk(path.join(appDir, root))));
    }
    case "Nuxt": {
      const root = await firstDir(appDir, ["pages", "app/pages"]);
      if (!root) return [];
      return dedupeSort(fileRoutes(await walk(path.join(appDir, root))));
    }
    case "Gatsby": {
      const root = await firstDir(appDir, ["src/pages"]);
      if (!root) return [];
      return dedupeSort(
        fileRoutes(await walk(path.join(appDir, root)), {
          exclude: (rel) => /^_/.test(rel.slice(rel.lastIndexOf("/") + 1)),
        })
      );
    }
    case "Remix": {
      const root = await firstDir(appDir, ["app/routes"]);
      if (!root) return [];
      return dedupeSort(remixRoutes(await walk(path.join(appDir, root))));
    }
    case "React Native (Expo)": {
      const root = await firstDir(appDir, ["app", "src/app"]);
      if (!root) return [];
      return dedupeSort(
        fileRoutes(await walk(path.join(appDir, root)), {
          exclude: (rel) => {
            const b = rel.slice(rel.lastIndexOf("/") + 1);
            return b.startsWith("_") || b.startsWith("+");
          },
        })
      );
    }
    default:
      // React / Vue / Solid / Qwik / Preact / Ionic / RN-CLI: routing is
      // in code, not the filesystem — the agent reads it.
      return [];
  }
}

export interface AppNavigation {
  app: DetectedApp;
  /** Routes extracted, or [] when the framework isn't file-based-routed. */
  routes: RouteEntry[];
  /** True when extraction is supported for this framework (vs agent-read). */
  fileBased: boolean;
}

const FILE_BASED = new Set([
  "Next.js",
  "SvelteKit",
  "Astro",
  "Nuxt",
  "Gatsby",
  "Remix",
  "React Native (Expo)",
]);

/**
 * Detect navigation (routes) for every app in the workspace, or one
 * app when `app` (a ref / name / repo) is given.
 */
export async function detectNavigation(
  workspaceRoot: string,
  opts: { app?: string } = {}
): Promise<AppNavigation[]> {
  const { repos } = await listRepos(workspaceRoot);
  const absByRepo = new Map(repos.map((r) => [r.repo.name, r.absPath]));
  let apps = await detectApps(workspaceRoot);
  if (opts.app) {
    const needle = opts.app;
    apps = apps.filter((a) => a.ref === needle || a.name === needle || a.repo === needle);
  }
  const out: AppNavigation[] = [];
  for (const app of apps) {
    const repoAbs = absByRepo.get(app.repo);
    if (!repoAbs) continue;
    const appDir = app.path === "." ? repoAbs : path.join(repoAbs, app.path);
    const routes = await extractRoutes(appDir, app.framework);
    out.push({ app, routes, fileBased: FILE_BASED.has(app.framework) });
  }
  return out;
}
