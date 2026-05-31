import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { readYamlFile } from "./yaml-io.js";
import {
  INDEX_FILE,
  readFolderIndex,
  writeFolderIndex,
  type FolderIndex,
  type IndexChild,
} from "./folder-index.js";

import { listAgents, loadAgent, AgentNotFoundError } from "./agents.js";
import { listItems } from "./items.js";
import { listDocs } from "./documentation.js";
import { listFeatures } from "./features.js";
import { listSessions } from "./sessions.js";
import { listStakeholders } from "./stakeholders.js";
import { listSources } from "./sources.js";
import { listRepos } from "./repos.js";

/**
 * Recursive workspace index — atelier's progressive-discovery layer.
 *
 * Core principle: every content folder carries a lightweight
 * `index.yaml` declaring what it is (name + kind/declaration + a
 * brief description) and listing its children (each with its own
 * title + description). An agent navigating the workspace reads ONE
 * level's index, sees summaries of what's below, and drills only into
 * the branch it actually needs — it never has to load the whole
 * workspace to find its way around.
 *
 * The index recurses: a folder's children may themselves be folders
 * with their own index.yaml. `buildWorkspaceMap` walks this tree to a
 * bounded depth and returns name/kind/description at each level.
 *
 * Resilience: when a folder has no `index.yaml`, atelier *derives* a
 * view from the content it already tracks (items, features, sessions,
 * …) so navigation works before anything is materialized.
 * `refreshWorkspaceIndex` persists those derived views as real
 * `index.yaml` sidecars (the canonical convention) so the tree is
 * self-describing on disk and survives outside atelier.
 */

// ============================================================
// Types
// ============================================================

/** A node in the navigable map returned by {@link buildWorkspaceMap}. */
export interface MapNode {
  /** Display name. */
  name: string;
  /** Kind/declaration. */
  kind: string;
  /** One-line description. */
  description?: string;
  /** Path relative to `.atelier/` ("" for the workspace root). */
  relPath: string;
  /** True when a real index.yaml backed this node (vs derived). */
  hasIndex: boolean;
  /** Expanded children (present when within the requested depth). */
  children?: MapNode[];
}

// ============================================================
// Section registry — how to derive a section's children from content
// ============================================================

function truncate(s: string | undefined, max = 120): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

interface SectionDef {
  /** Directory name under `.atelier/`. */
  dir: string;
  /** Display name for the section node. */
  name: string;
  /** One-line description of the section. */
  description: string;
  /** Derive the section's children from current content. */
  loadChildren: (workspaceRoot: string) => Promise<IndexChild[]>;
}

export const WORKSPACE_SECTIONS: readonly SectionDef[] = [
  {
    dir: "agents",
    name: "Agents",
    description: "Agents atelier authors for AI tools to discover and run.",
    async loadChildren(root) {
      const { agents } = await listAgents(root);
      return agents.map(({ agent }) => ({
        path: `${agent.id}/`,
        title: agent.name,
        kind: "agent",
        description: truncate(agent.purpose),
      }));
    },
  },
  {
    dir: "items",
    name: "Items",
    description: "Indexed knowledge — docs, design, PM items (agent-curated summaries).",
    async loadChildren(root) {
      const { items } = await listItems(root);
      return items.map(({ item }) => ({
        path: `${item.source}/`,
        title: `${item.source}:${item.docId}`,
        kind: item.classification ? `item/${item.classification}` : "item",
        description: truncate(item.overview ?? item.title),
      }));
    },
  },
  {
    dir: "documentation",
    name: "Documentation",
    description: "Indexed knowledge — PRDs, RFCs, runbooks, transcripts (agent-curated summaries).",
    async loadChildren(root) {
      const { docs } = await listDocs(root);
      return docs.map(({ doc }) => ({
        path: `${doc.source}/`,
        title: `${doc.source}:${doc.docId}`,
        kind: doc.classification ? `doc/${doc.classification}` : "doc",
        description: truncate(doc.overview ?? doc.title),
      }));
    },
  },
  {
    dir: "features",
    name: "Features",
    description: "The feature map — what the product does, conceptually.",
    async loadChildren(root) {
      const { features } = await listFeatures(root);
      return features.map(({ feature }) => ({
        path: `${feature.id}.md`,
        title: feature.name,
        kind: `feature/${feature.status}`,
        description: truncate(feature.description),
      }));
    },
  },
  {
    dir: "sessions",
    name: "Sessions",
    description: "Recorded conversations (the speaking module).",
    async loadChildren(root) {
      const { sessions } = await listSessions(root);
      return sessions.map(({ session }) => ({
        path: `${session.id}/`,
        title: session.title,
        kind: `session/${session.status}`,
        description: truncate(`${session.status}, started ${session.startedAt}`),
      }));
    },
  },
  {
    dir: "stakeholders",
    name: "Stakeholders",
    description: "People involved in the product (PMs, engineers, customers, …).",
    async loadChildren(root) {
      const { stakeholders } = await listStakeholders(root);
      return stakeholders.map(({ stakeholder }) => ({
        path: `${stakeholder.id}/`,
        title: stakeholder.name,
        kind: "stakeholder",
        description: truncate(
          [stakeholder.role, stakeholder.organization, stakeholder.summary]
            .filter(Boolean)
            .join(" · ")
        ),
      }));
    },
  },
];

/** Sections that are config-backed (not folders under .atelier/). */
async function configBackedChildren(workspaceRoot: string): Promise<{
  sources: IndexChild[];
  repos: IndexChild[];
}> {
  const sources = await listSources(workspaceRoot).then((ss) =>
    ss.map((s) => ({
      path: `sources/${s.id}/`,
      title: s.name,
      kind: `source/${s.category}`,
      description: truncate(`${s.enabled === false ? "disabled" : "enabled"} ${s.category} source`),
    }))
  );
  const repos = await listRepos(workspaceRoot).then(({ repos: rs }) =>
    rs.map((r) => ({
      path: r.repo.localPath ?? r.repo.name,
      title: r.repo.name,
      kind: "repo",
      description: truncate(r.repo.remote),
    }))
  );
  return { sources, repos };
}

// ============================================================
// Derivation — synthesize a FolderIndex when no sidecar exists
// ============================================================

async function workspaceName(workspaceRoot: string): Promise<string> {
  const raw = (await readYamlFile(workspacePaths(workspaceRoot).workspaceConfig)) as
    | { name?: string }
    | null;
  return raw?.name ?? "workspace";
}

/**
 * Synthesize a FolderIndex for a folder that has no index.yaml, using
 * atelier's content knowledge. Returns null when nothing is known
 * about the path (caller falls back to a bare directory listing).
 */
async function deriveIndex(
  workspaceRoot: string,
  relPath: string
): Promise<FolderIndex | null> {
  // Root of the workspace.
  if (relPath === "") {
    const children: IndexChild[] = [];
    for (const sec of WORKSPACE_SECTIONS) {
      const kids = await sec.loadChildren(workspaceRoot).catch(() => []);
      children.push({
        path: `${sec.dir}/`,
        title: sec.name,
        kind: "section",
        description: `${sec.description} (${kids.length})`,
      });
    }
    const { sources, repos } = await configBackedChildren(workspaceRoot);
    children.push({
      path: "sources/",
      title: "Sources",
      kind: "section",
      description: `Where agents fetch content from (${sources.length}).`,
    });
    children.push({
      path: "repos",
      title: "Repos",
      kind: "section",
      description: `Code repositories registered with this workspace (${repos.length}).`,
    });
    return {
      name: await workspaceName(workspaceRoot),
      kind: "workspace",
      description: "Atelier workspace — navigate by section.",
      children,
    };
  }

  // A known content section.
  const section = WORKSPACE_SECTIONS.find((s) => s.dir === relPath);
  if (section) {
    return {
      name: section.name,
      kind: "section",
      description: section.description,
      children: await section.loadChildren(workspaceRoot).catch(() => []),
    };
  }
  if (relPath === "sources") {
    const { sources } = await configBackedChildren(workspaceRoot);
    return {
      name: "Sources",
      kind: "section",
      description: "Documentation / design / PM sources agents fetch from.",
      children: sources.map((s) => ({ ...s, path: s.path.replace(/^sources\//, "") })),
    };
  }

  // An agent folder (agents/<id>) — derive its parts even before a
  // sidecar is materialized, so `atelier map agents/<id>` works.
  const agentMatch = /^agents\/([^/]+)$/.exec(relPath);
  if (agentMatch) {
    try {
      const agent = await loadAgent(workspaceRoot, agentMatch[1]);
      const atelier = workspacePaths(workspaceRoot).atelier;
      const children = await agentPartChildren(path.join(atelier, relPath));
      return {
        name: agent.name,
        kind: "agent",
        description: agent.purpose,
        children,
      };
    } catch (err) {
      if (!(err instanceof AgentNotFoundError)) throw err;
    }
  }

  return null;
}

// ============================================================
// Build the navigable map
// ============================================================

export interface BuildMapOptions {
  /** Start path relative to `.atelier/` (default: root). */
  path?: string;
  /** How many levels of children to expand (default 2). */
  depth?: number;
}

/**
 * Walk the index tree starting at `path` (relative to `.atelier/`)
 * to the requested depth. Prefers real index.yaml files; falls back
 * to deriving from content; falls back again to a bare directory
 * listing. Pure read — never writes.
 */
export async function buildWorkspaceMap(
  workspaceRoot: string,
  opts: BuildMapOptions = {}
): Promise<MapNode> {
  const startRel = normalizeRel(opts.path ?? "");
  const depth = opts.depth ?? 2;
  return buildNode(workspaceRoot, startRel, depth);
}

function normalizeRel(rel: string): string {
  return rel.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
}

async function buildNode(
  workspaceRoot: string,
  relPath: string,
  depth: number
): Promise<MapNode> {
  const atelier = workspacePaths(workspaceRoot).atelier;
  const absDir = relPath === "" ? atelier : path.join(atelier, relPath);

  // Prefer LIVE derivation over the on-disk sidecar wherever atelier
  // can derive the node from current content (the workspace root, the
  // content sections, agent folders, sources). That keeps `atelier
  // map` always-fresh without anyone running `--rebuild` after every
  // change. Only fall back to the sidecar where nothing is derivable
  // — instruction-tree units and arbitrary folders, whose index.yaml
  // IS the source of truth. `--rebuild` still materializes the
  // derivable sidecars for a committed, self-describing snapshot.
  const derived = await deriveIndex(workspaceRoot, relPath);
  let idx: FolderIndex | null;
  let hasIndex: boolean;
  if (derived) {
    idx = derived;
    hasIndex = await fileExists(path.join(absDir, INDEX_FILE));
  } else {
    const sidecar = await readFolderIndex(absDir);
    idx = sidecar;
    hasIndex = sidecar !== null;
  }

  // Last-resort: a bare directory we know nothing about.
  if (!idx) {
    const fallbackName = relPath === "" ? "workspace" : path.basename(relPath);
    const node: MapNode = {
      name: fallbackName,
      kind: "folder",
      relPath,
      hasIndex: false,
    };
    if (depth > 0) {
      node.children = await bareDirChildren(workspaceRoot, absDir, relPath, depth);
    }
    return node;
  }

  const node: MapNode = {
    name: idx.name,
    kind: idx.kind,
    description: idx.description,
    relPath,
    hasIndex,
  };

  if (depth > 0 && idx.children && idx.children.length > 0) {
    node.children = [];
    for (const child of idx.children) {
      const childRel = joinRel(relPath, child.path);
      const isDir = child.path.endsWith("/") || (await isDirectory(path.join(atelier, childRel)));
      if (isDir && depth > 1) {
        // Recurse so the child's own index/derivation fills it in.
        node.children.push(await buildNode(workspaceRoot, childRel, depth - 1));
      } else {
        node.children.push({
          name: child.title,
          kind: child.kind ?? (isDir ? "folder" : "file"),
          description: child.description,
          relPath: childRel,
          hasIndex: false,
        });
      }
    }
  }
  return node;
}

function joinRel(base: string, child: string): string {
  const c = normalizeRel(child);
  return base === "" ? c : `${base}/${c}`;
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

async function bareDirChildren(
  workspaceRoot: string,
  absDir: string,
  relPath: string,
  depth: number
): Promise<MapNode[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: MapNode[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === INDEX_FILE || e.name.startsWith(".")) continue;
    const childRel = joinRel(relPath, e.name);
    if (e.isDirectory()) {
      out.push(await buildNode(workspaceRoot, childRel, depth - 1));
    } else {
      out.push({ name: e.name, kind: "file", relPath: childRel, hasIndex: false });
    }
  }
  return out;
}

// ============================================================
// Refresh — materialize index.yaml sidecars across the workspace
// ============================================================

export interface RefreshResult {
  /** Absolute paths of index.yaml files written. */
  written: string[];
}

/**
 * Materialize the recursive index.yaml convention across the whole
 * workspace from current content. Writes:
 *   - `.atelier/index.yaml`            (workspace root → sections)
 *   - `.atelier/<section>/index.yaml`  (section → entries)
 *   - `.atelier/agents/<id>/index.yaml`(agent → its parts: recursion demo)
 *
 * Idempotent — safe to run repeatedly; always reflects current state.
 * Leaf content (items, features, …) keeps its summary in its existing
 * files; the section index carries each child's title + description so
 * one read per level is enough for progressive discovery.
 */
export async function refreshWorkspaceIndex(workspaceRoot: string): Promise<RefreshResult> {
  const atelier = workspacePaths(workspaceRoot).atelier;
  const written: string[] = [];

  // Root index.
  const root = await deriveIndex(workspaceRoot, "");
  if (root) {
    await writeFolderIndex(atelier, root);
    written.push(path.join(atelier, INDEX_FILE));
  }

  // Per-section index (only for sections whose dir exists).
  for (const sec of WORKSPACE_SECTIONS) {
    const dir = path.join(atelier, sec.dir);
    if (!(await isDirectory(dir))) continue;
    const idx = await deriveIndex(workspaceRoot, sec.dir);
    if (idx) {
      await writeFolderIndex(dir, idx);
      written.push(path.join(dir, INDEX_FILE));
    }
  }

  // Per-agent index — demonstrates recursion: agent folder → its parts.
  const { agents } = await listAgents(workspaceRoot).catch(() => ({ agents: [] as Awaited<ReturnType<typeof listAgents>>["agents"] }));
  for (const { agent } of agents) {
    const dir = path.join(atelier, "agents", agent.id);
    await writeFolderIndex(dir, {
      name: agent.name,
      kind: "agent",
      description: agent.purpose,
      children: await agentPartChildren(dir),
    });
    written.push(path.join(dir, INDEX_FILE));
  }

  return { written };
}

/**
 * Children entries for an agent folder: its playbook (the
 * `instructions/` tree when present, else the flat `instructions.md`)
 * and its learnings, when they exist. Shared by derivation + refresh
 * so both describe an agent the same way.
 */
async function agentPartChildren(agentAbsDir: string): Promise<IndexChild[]> {
  const children: IndexChild[] = [];
  if (await isDirectory(path.join(agentAbsDir, "instructions"))) {
    children.push({
      path: "instructions/",
      title: "Playbook",
      kind: "instructions",
      description: "How this agent works — a navigable tree of instruction units.",
    });
  } else {
    children.push({
      path: "instructions.md",
      title: "Playbook",
      kind: "instructions",
      description: "How this agent works — its system prompt / instructions.",
    });
  }
  if (await fileExists(path.join(agentAbsDir, "learnings.md"))) {
    children.push({
      path: "learnings.md",
      title: "Learnings",
      kind: "notes",
      description: "Durable facts atelier has learned about this workspace.",
    });
  }
  return children;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
