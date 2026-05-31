import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inspectProjects } from "./project-inspect.js";
import { listRepos } from "./repos.js";
import { detectApps } from "./ui-apps.js";

/**
 * App connection inference — the deterministic seed for the
 * "show how the apps connect" view.
 *
 * What can atelier know about app↔app connections without an LLM? The
 * reliable signal is **shared internal code**: when two apps depend on
 * the same workspace package (a shared design system, an API client,
 * an auth lib), that's a real edge. We read the package graph directly
 * — apps as nodes, shared internal packages as the edges — and flag
 * the ones that look like a shared design system (the connection a UI
 * designer cares most about).
 *
 * Connections that live in URLs / deep links / API calls aren't
 * reliably inferable from the filesystem; the ui-design agent reads
 * those from code itself. We only claim the package graph.
 */

export interface ConnectionEdge {
  /** The shared internal package name. */
  package: string;
  /** Location ref when it's a known workspace package, else undefined. */
  ref?: string;
  /** Apps (refs) that depend on this package. */
  apps: string[];
  /** True when the package looks like a shared design system / UI kit. */
  designSystem: boolean;
}

export interface AppInternalDeps {
  app: string;
  internal: string[];
}

export interface ConnectionGraph {
  apps: { ref: string; name: string; framework: string }[];
  /** Internal packages shared by 2+ apps — the connections. */
  edges: ConnectionEdge[];
  /** Each app's internal deps (incl. those used by only one app). */
  appDeps: AppInternalDeps[];
}

const DESIGN_SYSTEM_RE = /(?:^|[/@_-])(ui|design[-_]?system|design|components?|tokens?|theme|kit|primitives)(?:[/_-]|$)/i;

async function readPkg(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function depsOf(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const d = pkg[key];
    if (d && typeof d === "object") {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
    }
  }
  return out;
}

function isInternalVersion(v: string): boolean {
  return v.startsWith("workspace:") || v.startsWith("file:") || v.startsWith("link:");
}

/**
 * Infer the cross-app connection graph from the workspace's package
 * graph. Edges are internal packages shared by 2+ apps.
 */
export async function detectConnections(workspaceRoot: string): Promise<ConnectionGraph> {
  const { repos } = await inspectProjects(workspaceRoot);
  const { repos: repoListings } = await listRepos(workspaceRoot);
  const absByRepo = new Map(repoListings.map((r) => [r.repo.name, r.absPath]));

  // Every package name atelier can see across the workspace, → its ref.
  const nameToRef = new Map<string, string>();
  for (const r of repos) {
    for (const p of r.packages) {
      const ref = p.path === "." ? `repo:${r.repo}` : `repo:${r.repo}/${p.path}`;
      nameToRef.set(p.name, ref);
    }
  }
  const internalNames = new Set(nameToRef.keys());

  const apps = await detectApps(workspaceRoot);
  const appDeps: AppInternalDeps[] = [];
  // package name → set of app refs using it
  const usage = new Map<string, Set<string>>();

  for (const app of apps) {
    const repoAbs = absByRepo.get(app.repo);
    if (!repoAbs) continue;
    const dir = app.path === "." ? repoAbs : path.join(repoAbs, app.path);
    const pkg = await readPkg(dir);
    if (!pkg) {
      appDeps.push({ app: app.ref, internal: [] });
      continue;
    }
    const deps = depsOf(pkg);
    const internal: string[] = [];
    for (const [name, version] of Object.entries(deps)) {
      if (name === pkg.name) continue;
      if (internalNames.has(name) || isInternalVersion(version)) {
        internal.push(name);
        if (!usage.has(name)) usage.set(name, new Set());
        usage.get(name)!.add(app.ref);
      }
    }
    internal.sort();
    appDeps.push({ app: app.ref, internal });
  }

  const edges: ConnectionEdge[] = [];
  for (const [pkg, appSet] of usage) {
    if (appSet.size < 2) continue; // a connection needs 2+ apps
    edges.push({
      package: pkg,
      ref: nameToRef.get(pkg),
      apps: [...appSet].sort(),
      designSystem: DESIGN_SYSTEM_RE.test(pkg),
    });
  }
  // Design-system edges first, then by reach (most-shared), then name.
  edges.sort(
    (a, b) =>
      Number(b.designSystem) - Number(a.designSystem) ||
      b.apps.length - a.apps.length ||
      a.package.localeCompare(b.package)
  );

  return {
    apps: apps.map((a) => ({ ref: a.ref, name: a.name, framework: a.framework })),
    edges,
    appDeps,
  };
}
