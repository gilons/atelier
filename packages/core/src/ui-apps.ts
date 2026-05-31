import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inspectProjects } from "./project-inspect.js";

/**
 * Frontend application detection — the UI-design discovery entry.
 *
 * UI work is organized by *application*, and a workspace comes in
 * several shapes: multiple apps across separate repos, one monorepo
 * holding several apps, or several independent projects each with
 * their own UI. This deterministically enumerates the frontend apps
 * across all registered repos (root + monorepo packages) by their
 * framework dependency — the same "atelier owns the cheap structural
 * facts" principle as `repo inspect`. The ui-design agent starts from
 * this inventory; the palette surfaces it.
 */

export interface DetectedApp {
  /** "app:<repo>" or "app:<repo>/<package-path>". */
  ref: string;
  /** Registered repo the app lives in. */
  repo: string;
  /** Path within the repo ("." for the repo root). */
  path: string;
  /** package.json name, or the directory name. */
  name: string;
  /** Detected UI framework, e.g. "Next.js", "React", "SvelteKit". */
  framework: string;
}

// Priority order matters: meta-frameworks before the base libraries
// they build on, so Next.js wins over React, SvelteKit over Svelte.
const FRAMEWORK_DEPS: { dep: string | RegExp; framework: string }[] = [
  { dep: "next", framework: "Next.js" },
  { dep: /^@remix-run\//, framework: "Remix" },
  { dep: "gatsby", framework: "Gatsby" },
  { dep: "nuxt", framework: "Nuxt" },
  { dep: "@sveltejs/kit", framework: "SvelteKit" },
  { dep: "astro", framework: "Astro" },
  { dep: "@angular/core", framework: "Angular" },
  { dep: "expo", framework: "React Native (Expo)" },
  { dep: "react-native", framework: "React Native" },
  { dep: "@ionic/react", framework: "Ionic" },
  { dep: "qwik", framework: "Qwik" },
  { dep: "solid-js", framework: "Solid" },
  { dep: "svelte", framework: "Svelte" },
  { dep: "vue", framework: "Vue" },
  { dep: "preact", framework: "Preact" },
  { dep: "react", framework: "React" },
];

function detectFramework(pkg: Record<string, unknown>): string | null {
  const deps: Record<string, unknown> = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
    ...((pkg.peerDependencies as Record<string, unknown>) ?? {}),
  };
  const names = Object.keys(deps);
  for (const { dep, framework } of FRAMEWORK_DEPS) {
    if (typeof dep === "string") {
      if (names.includes(dep)) return framework;
    } else if (names.some((n) => dep.test(n))) {
      return framework;
    }
  }
  return null;
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Detect the frontend applications across all registered repos.
 * Optionally restrict to one repo by name.
 */
export async function detectApps(
  workspaceRoot: string,
  opts: { repo?: string } = {}
): Promise<DetectedApp[]> {
  const { repos } = await inspectProjects(workspaceRoot, { repo: opts.repo });
  const apps: DetectedApp[] = [];
  for (const r of repos) {
    if (!r.exists) continue;
    // Candidate locations: every node package the inspector found
    // (the root counts as path ".").
    const nodePackages = r.packages.filter((p) => p.ecosystems.includes("node"));
    // If the inspector found no node package at all, still probe the
    // root (a flat app the package scan may have skipped).
    const candidates = nodePackages.length > 0 ? nodePackages : [{ path: ".", name: r.repo, ecosystems: [] }];
    for (const p of candidates) {
      const dir = p.path === "." ? r.absPath : path.join(r.absPath, p.path);
      const pkg = await readPackageJson(dir);
      if (!pkg) continue;
      const framework = detectFramework(pkg);
      if (!framework) continue;
      const ref = p.path === "." ? `app:${r.repo}` : `app:${r.repo}/${p.path}`;
      apps.push({
        ref,
        repo: r.repo,
        path: p.path,
        name: typeof pkg.name === "string" && pkg.name ? pkg.name : p.name,
        framework,
      });
    }
  }
  return apps;
}
