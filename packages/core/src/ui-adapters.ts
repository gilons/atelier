import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { readYamlFile } from "./yaml-io.js";
import type { ValidationIssue, ValidationResult } from "./types.js";

/**
 * UI framework adapters — the "bring your own UI framework" layer.
 *
 * atelier's UI discovery (apps, navigation/screens, components) is
 * deterministic: it reads framework *conventions* off the filesystem,
 * never an LLM. The set of frameworks it understands used to be
 * hardcoded to the JS/web ecosystem (package.json deps + a switch over
 * Next/SvelteKit/…). An adapter generalizes that into **data**: a
 * declarative spec describing how to (1) recognize an app of a given
 * framework, (2) find its routes/screens, and (3) find its components.
 *
 * Two tiers ship together:
 *   - **Built-in adapters** ({@link BUILTIN_UI_ADAPTERS}) — first-party,
 *     covering the common frameworks. Native support.
 *   - **User adapters** — version-controlled YAML the user's AI agent
 *     authors in `.atelier/ui-adapters/<id>.yaml`. Bring-your-own
 *     framework (Flutter, Compose, MAUI, …) with zero code execution:
 *     atelier *interprets* the manifest deterministically.
 *
 * The unit of extension is **data, not code** — so the deterministic,
 * AI-free core stays exactly that. When a framework is too dynamic for
 * any declarative spec (routing defined imperatively in code), the
 * adapter declares `routes.strategy: none` and the ui-design agent
 * reads it by hand and writes screens directly — the agent is the
 * fallback. Over time the agent can crystallize what it learned into a
 * new adapter manifest, and the framework becomes deterministic + free.
 */

// ============================================================
// Model
// ============================================================

/**
 * Route-extraction strategy. The named strategies are first-party and
 * encode a specific framework's filesystem routing convention exactly.
 * `file-based` is the generic, declarative strategy a user adapter
 * uses (parameterized by globs). `none` means routing isn't on the
 * filesystem — defer to the agent.
 */
export type UiRouteStrategy =
  | "next"
  | "sveltekit"
  | "astro"
  | "nuxt"
  | "gatsby"
  | "remix"
  | "expo"
  | "file-based"
  | "none";

export const ROUTE_STRATEGIES: readonly UiRouteStrategy[] = [
  "next",
  "sveltekit",
  "astro",
  "nuxt",
  "gatsby",
  "remix",
  "expo",
  "file-based",
  "none",
];

/** How to recognize an app of this framework at a candidate directory. */
export interface UiDetectRule {
  /** A dependency name that must be present (exact match), JS ecosystem. */
  dependency?: string;
  /** A regex (as a string) tested against every dependency name. */
  dependencyPattern?: string;
  /** A manifest file that must exist (relative to the dir), with an
   *  optional regex (string) the file's contents must match. */
  manifest?: { file: string; contains?: string };
  /** At least one file matching this glob (relative to the dir) exists. */
  glob?: string;
}

/** How to derive the app's display name. */
export interface UiNameRule {
  /** File to read the name from (e.g. "package.json", "pubspec.yaml"). */
  file: string;
  /** Key to read — JSON key, or a `key:` line in a YAML-ish manifest. */
  key: string;
}

/** How routes/screens are discovered for this framework. */
export interface UiRouteRule {
  strategy: UiRouteStrategy;
  /** For `file-based`: directories to scan (first existing one wins). */
  roots?: string[];
  /** For `file-based`: glob(s) for files that count as a route/page. */
  include?: string[];
  /** For `file-based`: glob(s) to exclude. */
  exclude?: string[];
  /** For `file-based`: basename (no ext) that collapses to its parent dir. */
  indexBasename?: string;
}

/** How reusable components are discovered for this framework. */
export interface UiComponentRule {
  /** Directory candidates (relative to the app/package root) to scan. */
  dirs?: string[];
  /** File extensions counted as component files (e.g. [".tsx", ".dart"]). */
  extensions?: string[];
  /** Optional regex (string) a file's contents must match to count
   *  (e.g. "@Composable" for Jetpack Compose, "extends StatelessWidget"). */
  contains?: string;
  /** Require the component basename to start uppercase. Default true. */
  pascalCase?: boolean;
}

export interface UiFrameworkAdapter {
  /** Manifest schema version. */
  version: number;
  /** Unique id (slug). A user adapter with the same id overrides a built-in. */
  id: string;
  /** Display framework name shown in the app inventory (e.g. "Flutter"). */
  framework: string;
  /** Higher wins when several adapters match one dir (meta-frameworks high). */
  priority: number;
  /** True for atelier's shipped adapters. */
  builtin?: boolean;
  /** How to recognize an app of this framework. */
  detect: UiDetectRule;
  /** How to derive the app's display name (else the directory name). */
  name?: UiNameRule;
  /** How routes/screens are discovered. */
  routes: UiRouteRule;
  /** How components are discovered (optional). */
  components?: UiComponentRule;
}

// ============================================================
// Built-in adapters (first-party native support)
// ============================================================

/** The JS/TS component-detection rule shared by all web framework adapters. */
const JS_COMPONENT_RULE: UiComponentRule = {
  dirs: [
    "components",
    "src/components",
    "app/components",
    "ui",
    "src/ui",
    "lib/components",
    "src/lib/components",
  ],
  extensions: [".tsx", ".jsx", ".vue", ".svelte"],
  pascalCase: true,
};

const js = (
  id: string,
  framework: string,
  priority: number,
  detect: UiDetectRule,
  strategy: UiRouteStrategy
): UiFrameworkAdapter => ({
  version: 1,
  id,
  framework,
  priority,
  builtin: true,
  detect,
  name: { file: "package.json", key: "name" },
  routes: { strategy },
  components: JS_COMPONENT_RULE,
});

/**
 * Built-in adapters, ported 1:1 from the previous hardcoded
 * FRAMEWORK_DEPS table + extractRoutes switch. Priority descending
 * reproduces the old "meta-frameworks win over base libraries" order
 * (Next over React, SvelteKit over Svelte, Expo over React Native).
 */
export const BUILTIN_UI_ADAPTERS: readonly UiFrameworkAdapter[] = [
  js("next", "Next.js", 100, { dependency: "next" }, "next"),
  js("remix", "Remix", 95, { dependencyPattern: "^@remix-run/" }, "remix"),
  js("gatsby", "Gatsby", 90, { dependency: "gatsby" }, "gatsby"),
  js("nuxt", "Nuxt", 85, { dependency: "nuxt" }, "nuxt"),
  js("sveltekit", "SvelteKit", 80, { dependency: "@sveltejs/kit" }, "sveltekit"),
  js("astro", "Astro", 75, { dependency: "astro" }, "astro"),
  js("angular", "Angular", 70, { dependency: "@angular/core" }, "none"),
  js("expo", "React Native (Expo)", 65, { dependency: "expo" }, "expo"),
  js("react-native", "React Native", 60, { dependency: "react-native" }, "none"),
  js("ionic", "Ionic", 55, { dependency: "@ionic/react" }, "none"),
  js("qwik", "Qwik", 50, { dependency: "qwik" }, "none"),
  js("solid", "Solid", 45, { dependency: "solid-js" }, "none"),
  js("svelte", "Svelte", 40, { dependency: "svelte" }, "none"),
  js("vue", "Vue", 35, { dependency: "vue" }, "none"),
  js("preact", "Preact", 30, { dependency: "preact" }, "none"),
  js("react", "React", 25, { dependency: "react" }, "none"),
  // Non-JS native support. Flutter has no filesystem routing convention
  // by default (navigation is code-defined via MaterialApp / go_router),
  // so routes are `none` — the ui-design agent reads navigation from the
  // code, or a team that adopts a folder convention authors a file-based
  // override adapter. App existence + widget components are deterministic.
  {
    version: 1,
    id: "flutter",
    framework: "Flutter",
    priority: 60,
    builtin: true,
    detect: { manifest: { file: "pubspec.yaml", contains: "(^|\\n)flutter:" } },
    name: { file: "pubspec.yaml", key: "name" },
    routes: { strategy: "none" },
    components: {
      dirs: ["lib/widgets", "lib/components", "lib/ui", "lib/src/widgets"],
      extensions: [".dart"],
      pascalCase: false,
      contains: "extends (StatelessWidget|StatefulWidget|ConsumerWidget|HookWidget)|State<",
    },
  },
];

// ============================================================
// Detection (filesystem-agnostic, for testability)
// ============================================================

/**
 * The facts about a candidate directory an adapter's detect rule is
 * evaluated against. Kept abstract so the matching logic is pure and
 * unit-testable without touching the filesystem; ui-apps builds a
 * real, FS-backed context.
 */
export interface DetectContext {
  /** All dependency names declared at this dir (deps + dev + peer). */
  deps: string[];
  /** Whether a file exists relative to the dir. */
  hasFile(rel: string): Promise<boolean>;
  /** Read a file's contents relative to the dir, or null if absent. */
  readFile(rel: string): Promise<string | null>;
  /** Whether at least one file matches a simple glob under the dir. */
  hasGlob(glob: string): Promise<boolean>;
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** Does this adapter's detect rule match the candidate directory? */
export async function adapterMatches(
  adapter: UiFrameworkAdapter,
  ctx: DetectContext
): Promise<boolean> {
  const d = adapter.detect;
  // An adapter needs at least one positive signal. Every declared
  // signal must hold (AND), so a spec can require "manifest X AND glob Y".
  let signals = 0;

  if (d.dependency !== undefined) {
    signals++;
    if (!ctx.deps.includes(d.dependency)) return false;
  }
  if (d.dependencyPattern !== undefined) {
    signals++;
    const re = safeRegExp(d.dependencyPattern);
    if (!re || !ctx.deps.some((n) => re.test(n))) return false;
  }
  if (d.manifest !== undefined) {
    signals++;
    if (!(await ctx.hasFile(d.manifest.file))) return false;
    if (d.manifest.contains !== undefined) {
      const text = await ctx.readFile(d.manifest.file);
      const re = safeRegExp(d.manifest.contains);
      if (text === null || !re || !re.test(text)) return false;
    }
  }
  if (d.glob !== undefined) {
    signals++;
    if (!(await ctx.hasGlob(d.glob))) return false;
  }

  return signals > 0;
}

/**
 * Pick the matching adapter with the highest priority for a candidate
 * dir, or null if none match. `adapters` need not be pre-sorted.
 */
export async function findAdapterForContext(
  adapters: readonly UiFrameworkAdapter[],
  ctx: DetectContext
): Promise<UiFrameworkAdapter | null> {
  let best: UiFrameworkAdapter | null = null;
  for (const a of adapters) {
    if (await adapterMatches(a, ctx)) {
      if (!best || a.priority > best.priority) best = a;
    }
  }
  return best;
}

/** Derive an app name from a manifest per the adapter's name rule. */
export async function deriveAppName(
  adapter: UiFrameworkAdapter,
  ctx: DetectContext,
  fallback: string
): Promise<string> {
  if (!adapter.name) return fallback;
  const text = await ctx.readFile(adapter.name.file);
  if (text === null) return fallback;
  // JSON manifests (package.json): parse + read the key.
  if (adapter.name.file.endsWith(".json")) {
    try {
      const obj = JSON.parse(text);
      const v = obj?.[adapter.name.key];
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      /* fall through */
    }
    return fallback;
  }
  // YAML-ish manifests (pubspec.yaml, …): a top-level `key: value` line.
  const m = new RegExp(`^${adapter.name.key}:\\s*(.+?)\\s*$`, "m").exec(text);
  if (m) return m[1].replace(/^["']|["']$/g, "").trim() || fallback;
  return fallback;
}

// ============================================================
// Validation (for user-authored YAML adapters)
// ============================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Validate a raw object as a {@link UiFrameworkAdapter}. */
export function validateUiAdapter(raw: unknown): ValidationResult<UiFrameworkAdapter> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: "$", message: "expected an object at the top level" }] };
  }

  const { version, id, framework, priority, detect, name, routes, components } = raw;

  if (version !== undefined && typeof version !== "number") {
    issues.push({ path: "$.version", message: "if present, must be a number" });
  }
  if (!isNonEmptyString(id)) {
    issues.push({ path: "$.id", message: "must be a non-empty string" });
  } else if (!ID_PATTERN.test(id)) {
    issues.push({ path: "$.id", message: "must be a slug ([a-z0-9-], not edge-dashed)" });
  }
  if (!isNonEmptyString(framework)) {
    issues.push({ path: "$.framework", message: "must be a non-empty string" });
  }
  if (priority !== undefined && typeof priority !== "number") {
    issues.push({ path: "$.priority", message: "if present, must be a number" });
  }

  // detect
  if (!isObject(detect)) {
    issues.push({ path: "$.detect", message: "must be an object" });
  } else {
    const { dependency, dependencyPattern, manifest, glob } = detect;
    if (dependency !== undefined && !isNonEmptyString(dependency)) {
      issues.push({ path: "$.detect.dependency", message: "if present, must be a non-empty string" });
    }
    if (dependencyPattern !== undefined && !isNonEmptyString(dependencyPattern)) {
      issues.push({ path: "$.detect.dependencyPattern", message: "if present, must be a non-empty string (regex)" });
    }
    if (manifest !== undefined) {
      if (!isObject(manifest) || !isNonEmptyString(manifest.file)) {
        issues.push({ path: "$.detect.manifest", message: "if present, must be { file, contains? } with a file" });
      } else if (manifest.contains !== undefined && !isNonEmptyString(manifest.contains)) {
        issues.push({ path: "$.detect.manifest.contains", message: "if present, must be a non-empty string (regex)" });
      }
    }
    if (glob !== undefined && !isNonEmptyString(glob)) {
      issues.push({ path: "$.detect.glob", message: "if present, must be a non-empty string" });
    }
    if (
      dependency === undefined &&
      dependencyPattern === undefined &&
      manifest === undefined &&
      glob === undefined
    ) {
      issues.push({ path: "$.detect", message: "needs at least one signal (dependency / dependencyPattern / manifest / glob)" });
    }
  }

  // name
  if (name !== undefined) {
    if (!isObject(name) || !isNonEmptyString(name.file) || !isNonEmptyString(name.key)) {
      issues.push({ path: "$.name", message: "if present, must be { file, key }" });
    }
  }

  // routes
  if (!isObject(routes)) {
    issues.push({ path: "$.routes", message: "must be an object with a strategy" });
  } else {
    const { strategy, roots, include, exclude, indexBasename } = routes;
    if (!isNonEmptyString(strategy) || !ROUTE_STRATEGIES.includes(strategy as UiRouteStrategy)) {
      issues.push({ path: "$.routes.strategy", message: `must be one of: ${ROUTE_STRATEGIES.join(", ")}` });
    }
    if (strategy === "file-based") {
      if (!isStringArray(roots) || roots.length === 0) {
        issues.push({ path: "$.routes.roots", message: "file-based strategy needs a non-empty roots array" });
      }
      if (include !== undefined && !isStringArray(include)) {
        issues.push({ path: "$.routes.include", message: "if present, must be an array of glob strings" });
      }
    }
    if (roots !== undefined && !isStringArray(roots)) {
      issues.push({ path: "$.routes.roots", message: "if present, must be an array of strings" });
    }
    if (exclude !== undefined && !isStringArray(exclude)) {
      issues.push({ path: "$.routes.exclude", message: "if present, must be an array of strings" });
    }
    if (indexBasename !== undefined && !isNonEmptyString(indexBasename)) {
      issues.push({ path: "$.routes.indexBasename", message: "if present, must be a non-empty string" });
    }
  }

  // components
  if (components !== undefined) {
    if (!isObject(components)) {
      issues.push({ path: "$.components", message: "if present, must be an object" });
    } else {
      const { dirs, extensions, contains, pascalCase } = components;
      if (dirs !== undefined && !isStringArray(dirs)) {
        issues.push({ path: "$.components.dirs", message: "if present, must be an array of strings" });
      }
      if (extensions !== undefined && !isStringArray(extensions)) {
        issues.push({ path: "$.components.extensions", message: "if present, must be an array of strings" });
      }
      if (contains !== undefined && !isNonEmptyString(contains)) {
        issues.push({ path: "$.components.contains", message: "if present, must be a non-empty string (regex)" });
      }
      if (pascalCase !== undefined && typeof pascalCase !== "boolean") {
        issues.push({ path: "$.components.pascalCase", message: "if present, must be a boolean" });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const value: UiFrameworkAdapter = {
    version: typeof version === "number" ? version : 1,
    id: id as string,
    framework: framework as string,
    priority: typeof priority === "number" ? priority : 10,
    detect: detect as UiDetectRule,
    routes: routes as UiRouteRule,
  };
  if (name !== undefined) value.name = name as UiNameRule;
  if (components !== undefined) value.components = components as UiComponentRule;
  return { ok: true, value, issues: [] };
}

// ============================================================
// Loading (built-ins + user YAML, user overrides built-in by id)
// ============================================================

export interface LoadedUiAdapters {
  /** Effective adapter set, sorted by priority descending then id. */
  adapters: UiFrameworkAdapter[];
  /** User adapter files that failed to load/validate (non-fatal). */
  errors: { file: string; error: Error }[];
}

/**
 * Load the effective adapter set for a workspace: the built-ins, with
 * any user adapter in `.atelier/ui-adapters/<id>.yaml` taking
 * precedence over a built-in of the same id. Malformed user files are
 * skipped (reported in `errors`) so one bad manifest can't blind the
 * whole UI discovery.
 */
export async function loadUiAdapters(workspaceRoot: string): Promise<LoadedUiAdapters> {
  const dir = workspacePaths(workspaceRoot).uiAdapters;
  const byId = new Map<string, UiFrameworkAdapter>();
  for (const a of BUILTIN_UI_ADAPTERS) byId.set(a.id, a);

  const errors: { file: string; error: Error }[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { adapters: sortAdapters([...byId.values()]), errors };
    }
    throw err;
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.ya?ml$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    try {
      const raw = await readYamlFile(file);
      const result = validateUiAdapter(raw);
      if (!result.ok || !result.value) {
        const msg = result.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
        errors.push({ file, error: new Error(`invalid UI adapter — ${msg}`) });
        continue;
      }
      // User adapter wins over a built-in of the same id.
      byId.set(result.value.id, { ...result.value, builtin: false });
    } catch (err) {
      errors.push({ file, error: err as Error });
    }
  }

  return { adapters: sortAdapters([...byId.values()]), errors };
}

function sortAdapters(adapters: UiFrameworkAdapter[]): UiFrameworkAdapter[] {
  return adapters.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

// ============================================================
// Scaffolding a new user adapter
// ============================================================

export class UiAdapterExistsError extends Error {
  constructor(public readonly file: string) {
    super(`A UI adapter already exists at ${file} (use --force to overwrite)`);
    this.name = "UiAdapterExistsError";
  }
}

/** A commented, fill-in-the-blanks adapter manifest for the agent/user. */
export function uiAdapterTemplate(id: string, framework: string): string {
  return `# UI framework adapter for ${framework}.
#
# atelier interprets this declaratively — NO code runs. Fill in the
# fields below, then \`atelier design apps\` / \`nav\` / \`kit\` discover
# this framework like any built-in. Validate with \`atelier design
# adapters show ${id}\`.
version: 1
id: ${id}
framework: ${framework}
# Higher priority wins when several adapters match one app directory
# (meta-frameworks should outrank the base libraries they build on).
priority: 50

# How to recognize an app of this framework at a candidate directory.
# Provide at least one signal; every signal you provide must hold.
detect:
  # A manifest file that must exist, optionally matching a regex:
  manifest:
    file: pubspec.yaml
    contains: 'flutter:'
  # ...or a dependency declared in package.json:
  # dependency: react
  # dependencyPattern: '^@remix-run/'
  # ...or at least one file matching a glob:
  # glob: '**/*.dart'

# Where to read the app's display name (omit to use the directory name).
name:
  file: pubspec.yaml
  key: name

# How routes / screens are discovered.
#   file-based : scan roots, map each file's path to a route
#   none       : routing lives in code — the agent reads it by hand
routes:
  strategy: none
  # roots: [lib/pages, lib/screens]
  # include: ['**/*.dart']
  # exclude: ['**/*.g.dart']
  # indexBasename: index

# Where reusable components live (optional). \`contains\` is a regex the
# file's text must match; \`pascalCase\` requires an uppercase filename.
components:
  dirs: [lib/widgets]
  extensions: ['.dart']
  pascalCase: false
  contains: 'extends (StatelessWidget|StatefulWidget)'
`;
}

/**
 * Write a starter adapter manifest to `.atelier/ui-adapters/<id>.yaml`.
 * Refuses to overwrite unless `force`. Returns the file path written.
 */
export async function scaffoldUiAdapter(
  workspaceRoot: string,
  opts: { id: string; framework?: string; force?: boolean }
): Promise<string> {
  const dir = workspacePaths(workspaceRoot).uiAdapters;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${opts.id}.yaml`);
  if (!opts.force) {
    try {
      await fs.access(file);
      throw new UiAdapterExistsError(file);
    } catch (err) {
      if (err instanceof UiAdapterExistsError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await fs.writeFile(file, uiAdapterTemplate(opts.id, opts.framework ?? opts.id), "utf8");
  return file;
}
