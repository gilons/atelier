import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listRepos } from "./repos.js";

/**
 * Deterministic project structure inspection.
 *
 * The system-design agent needs to "pull out" the projects /
 * subsystems / microservices in a workspace before it can analyze
 * similarities and patterns. That enumeration is cheap, deterministic
 * file inspection — no judgement, no LLM — so atelier owns it (the
 * same way `git.ts` parses `.git/config` directly). The agent then
 * does the *analysis* on top of this structural map.
 *
 * For each registered repo that exists on disk we detect:
 *   - which language ecosystems are present (by manifest files),
 *   - whether it's a monorepo + its packages (workspaces, go modules),
 *   - obvious service/app boundaries (apps/, services/, cmd/, …),
 *   - container hints (Dockerfile / compose).
 *
 * The scan is bounded (root + a couple of levels) so it stays fast on
 * large trees and never walks node_modules / vendor / .git.
 */

// ============================================================
// Types
// ============================================================

export type Ecosystem =
  | "node"
  | "go"
  | "python"
  | "rust"
  | "java"
  | "ruby"
  | "php"
  | "dotnet";

/** One detected package / module / service inside a repo. */
export interface ProjectPackage {
  /** Path relative to the repo root ("." for the repo root itself). */
  path: string;
  /** Best-effort name (manifest name or directory name). */
  name: string;
  /** Ecosystems detected at this package. */
  ecosystems: Ecosystem[];
}

/** Structural fingerprint of one registered repo. */
export interface RepoInspection {
  /** Registered repo name. */
  repo: string;
  /** Absolute path on this machine. */
  absPath: string;
  /** False when the local clone is missing (nothing else is populated). */
  exists: boolean;
  /** Ecosystems present anywhere in the (bounded) scan. */
  ecosystems: Ecosystem[];
  /** True when more than one package/module was found (monorepo-ish). */
  monorepo: boolean;
  /** Detected packages / modules / services (includes the root when it has a manifest). */
  packages: ProjectPackage[];
  /** True when a Dockerfile / compose file was seen. */
  containerized: boolean;
}

export interface WorkspaceInspection {
  organization?: string;
  repos: RepoInspection[];
}

// ============================================================
// Manifest → ecosystem mapping
// ============================================================

const MANIFESTS: { file: string; ecosystem: Ecosystem }[] = [
  { file: "package.json", ecosystem: "node" },
  { file: "go.mod", ecosystem: "go" },
  { file: "pyproject.toml", ecosystem: "python" },
  { file: "setup.py", ecosystem: "python" },
  { file: "requirements.txt", ecosystem: "python" },
  { file: "Cargo.toml", ecosystem: "rust" },
  { file: "pom.xml", ecosystem: "java" },
  { file: "build.gradle", ecosystem: "java" },
  { file: "Gemfile", ecosystem: "ruby" },
  { file: "composer.json", ecosystem: "php" },
];

// Directories we never descend into.
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "coverage",
]);

// Conventional places monorepos keep their members.
const PACKAGE_PARENT_DIRS = ["packages", "apps", "services", "cmd", "modules", "libs"];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectEcosystemsAt(dir: string): Promise<Ecosystem[]> {
  const found = new Set<Ecosystem>();
  for (const { file, ecosystem } of MANIFESTS) {
    if (await exists(path.join(dir, file))) found.add(ecosystem);
  }
  // .NET projects: any *.csproj / *.sln at this level.
  try {
    const entries = await fs.readdir(dir);
    if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) {
      found.add("dotnet");
    }
  } catch {
    /* unreadable dir — ignore */
  }
  return Array.from(found);
}

async function packageName(dir: string, ecosystems: Ecosystem[]): Promise<string> {
  if (ecosystems.includes("node")) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      if (typeof pkg.name === "string" && pkg.name) return pkg.name;
    } catch {
      /* fall through */
    }
  }
  return path.basename(dir);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inspect a single repo directory. Bounded scan: the repo root, the
 * conventional monorepo parent dirs (one level of children inside
 * each), and a shallow sweep of other top-level dirs for manifests.
 */
export async function inspectRepoDir(
  repoName: string,
  absPath: string,
  exists_: boolean
): Promise<RepoInspection> {
  const result: RepoInspection = {
    repo: repoName,
    absPath,
    exists: exists_,
    ecosystems: [],
    monorepo: false,
    packages: [],
    containerized: false,
  };
  if (!exists_) return result;

  const ecosystems = new Set<Ecosystem>();
  const packages: ProjectPackage[] = [];

  // Root manifest(s).
  const rootEco = await detectEcosystemsAt(absPath);
  if (rootEco.length > 0) {
    rootEco.forEach((e) => ecosystems.add(e));
    packages.push({ path: ".", name: await packageName(absPath, rootEco), ecosystems: rootEco });
  }

  // Container hints at root.
  result.containerized =
    (await exists(path.join(absPath, "Dockerfile"))) ||
    (await exists(path.join(absPath, "docker-compose.yml"))) ||
    (await exists(path.join(absPath, "docker-compose.yaml"))) ||
    (await exists(path.join(absPath, "compose.yaml")));

  // Top-level directories: descend into conventional monorepo parents
  // (one level of children) and check other top-level dirs for a manifest.
  let topEntries: import("node:fs").Dirent[] = [];
  try {
    topEntries = await fs.readdir(absPath, { withFileTypes: true });
  } catch {
    /* ignore */
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const childAbs = path.join(absPath, entry.name);

    if (PACKAGE_PARENT_DIRS.includes(entry.name)) {
      // Enumerate members one level down (e.g. services/<svc>).
      let members: import("node:fs").Dirent[] = [];
      try {
        members = await fs.readdir(childAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const m of members) {
        if (!m.isDirectory() || IGNORE_DIRS.has(m.name) || m.name.startsWith(".")) continue;
        const memberAbs = path.join(childAbs, m.name);
        const eco = await detectEcosystemsAt(memberAbs);
        if (eco.length > 0) {
          eco.forEach((e) => ecosystems.add(e));
          packages.push({
            path: path.posix.join(entry.name, m.name),
            name: await packageName(memberAbs, eco),
            ecosystems: eco,
          });
        }
      }
    } else {
      // A plain top-level dir — record it only if it carries a manifest
      // (e.g. a flat repo with `frontend/` + `backend/`).
      const eco = await detectEcosystemsAt(childAbs);
      if (eco.length > 0) {
        eco.forEach((e) => ecosystems.add(e));
        packages.push({
          path: entry.name,
          name: await packageName(childAbs, eco),
          ecosystems: eco,
        });
      }
    }
  }

  result.ecosystems = Array.from(ecosystems).sort();
  result.packages = packages.sort((a, b) => a.path.localeCompare(b.path));
  // More than one distinct package/module unit → monorepo-ish (a root
  // app plus a sub-service counts; a lone root manifest does not).
  result.monorepo = packages.length > 1;
  return result;
}

/**
 * Inspect every registered repo in the workspace. Repos whose local
 * clone is missing are still returned (with `exists: false`) so the
 * caller can surface "clone this to inspect it".
 *
 * Optionally pass a single repo name to inspect just that one.
 */
export async function inspectProjects(
  workspaceRoot: string,
  opts: { repo?: string } = {}
): Promise<WorkspaceInspection> {
  const { organization, repos } = await listRepos(workspaceRoot);
  const selected = opts.repo ? repos.filter((r) => r.repo.name === opts.repo) : repos;
  const inspections: RepoInspection[] = [];
  for (const listing of selected) {
    inspections.push(
      await inspectRepoDir(listing.repo.name, listing.absPath, listing.exists)
    );
  }
  return { organization, repos: inspections };
}
