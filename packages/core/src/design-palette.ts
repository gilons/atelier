import { inspectProjects } from "./project-inspect.js";
import { detectApps } from "./ui-apps.js";
import { detectUiKit } from "./ui-kit.js";
import { listFeatures } from "./features.js";
import { listItems } from "./items.js";
import { listStakeholders } from "./stakeholders.js";

/**
 * The design palette — the reusable vocabulary the system-design
 * agent references during live mode.
 *
 * The live companion's one rule is "derive, don't generate": on the
 * hot path it must compose from things that ALREADY EXIST, never
 * invent and model a new system from scratch (slow + drifts out of
 * sync). The palette is that pre-built set of building blocks — the
 * subsystems, capabilities, existing designs, and owners atelier
 * already knows about — each with a stable `ref` the agent cites when
 * wiring a live sketch together.
 *
 * It's a pure derivation over existing content (repo inspect, the
 * feature map, system-design items, stakeholders), built once and
 * loaded into the agent's context at the start of a call so each live
 * update is a cheap lookup, not an essay.
 */

export interface PaletteEntry {
  /**
   * Stable reference the agent cites to wire this into a sketch:
   *   subsystem → "repo:<name>" or "repo:<name>/<pkg-path>"
   *   feature   → "feature:<id>"
   *   design    → "item:<source>:<docId>"
   *   owner     → "stakeholder:<id>"
   */
  ref: string;
  /** "subsystem" | "app" | "component" | "token" | "feature" | "design" | "owner". */
  kind: "subsystem" | "app" | "component" | "token" | "feature" | "design" | "owner";
  /** Display name. */
  name: string;
  /** One-line descriptor. */
  description?: string;
}

export interface DesignPalette {
  /** Deployable/runnable units derived from registered repos. */
  subsystems: PaletteEntry[];
  /** Frontend applications detected across the repos (UI discovery entry). */
  apps: PaletteEntry[];
  /** Reusable component sources (dirs/packages of components). */
  components: PaletteEntry[];
  /** Design-token sources (Tailwind config, tokens.json, theme files). */
  tokens: PaletteEntry[];
  /** Capabilities from the feature map. */
  features: PaletteEntry[];
  /** Existing design artifacts for the discipline (items classified accordingly). */
  designs: PaletteEntry[];
  /** People who own parts of the system. */
  owners: PaletteEntry[];
}

function truncate(s: string | undefined, max = 100): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export interface BuildPaletteOptions {
  /**
   * Discipline whose existing designs populate the `designs` section
   * (items whose classification includes this id). Defaults to
   * "system-design". Subsystems / features / owners are shared.
   */
  discipline?: string;
}

/**
 * Build the palette from current workspace content. Each section is
 * derived from an existing list function, so the palette is always a
 * faithful, deterministic view of what atelier already tracks — never
 * anything invented. The `designs` section is scoped to the requested
 * discipline so a UI-design live session derives from UI designs, a
 * system-design session from system designs, etc.
 */
export async function buildDesignPalette(
  workspaceRoot: string,
  opts: BuildPaletteOptions = {}
): Promise<DesignPalette> {
  const discipline = opts.discipline ?? "system-design";
  const subsystems: PaletteEntry[] = [];
  const { repos } = await inspectProjects(workspaceRoot).catch(() => ({ repos: [] as Awaited<ReturnType<typeof inspectProjects>>["repos"] }));
  for (const r of repos) {
    if (!r.exists) continue;
    const members = r.packages.filter((p) => p.path !== ".");
    if (members.length === 0) {
      subsystems.push({
        ref: `repo:${r.repo}`,
        kind: "subsystem",
        name: r.repo,
        description: truncate(
          [r.ecosystems.join(", "), r.containerized ? "containerized" : ""]
            .filter(Boolean)
            .join(" · ")
        ),
      });
    } else {
      // Monorepo: the repo is a container; each package is a subsystem.
      subsystems.push({
        ref: `repo:${r.repo}`,
        kind: "subsystem",
        name: r.repo,
        description: truncate(`${r.ecosystems.join(", ")}${r.monorepo ? " · monorepo" : ""}`),
      });
      for (const p of members) {
        subsystems.push({
          ref: `repo:${r.repo}/${p.path}`,
          kind: "subsystem",
          name: p.name,
          description: truncate(p.ecosystems.join(", ")),
        });
      }
    }
  }

  const apps: PaletteEntry[] = [];
  const detectedApps = await detectApps(workspaceRoot).catch(() => []);
  for (const a of detectedApps) {
    apps.push({ ref: a.ref, kind: "app", name: a.name, description: a.framework });
  }

  const components: PaletteEntry[] = [];
  const tokens: PaletteEntry[] = [];
  const kit = await detectUiKit(workspaceRoot).catch(() => ({ components: [], tokens: [] }));
  for (const c of kit.components) {
    const sample = c.samples.length > 0 ? `: ${c.samples.slice(0, 4).join(", ")}…` : "";
    components.push({
      ref: c.ref,
      kind: "component",
      name: c.dir,
      description: truncate(`${c.count} component${c.count === 1 ? "" : "s"}${sample}`),
    });
  }
  for (const t of kit.tokens) {
    tokens.push({
      ref: t.ref,
      kind: "token",
      name: t.file,
      description: t.kind,
    });
  }

  const features: PaletteEntry[] = [];
  const { features: feats } = await listFeatures(workspaceRoot).catch(() => ({ features: [] as Awaited<ReturnType<typeof listFeatures>>["features"] }));
  for (const { feature } of feats) {
    features.push({
      ref: `feature:${feature.id}`,
      kind: "feature",
      name: feature.name,
      description: truncate(feature.description ?? feature.status),
    });
  }

  const designs: PaletteEntry[] = [];
  const { items } = await listItems(workspaceRoot).catch(() => ({ items: [] as Awaited<ReturnType<typeof listItems>>["items"] }));
  for (const { item } of items) {
    if ((item.classification ?? "").includes(discipline)) {
      designs.push({
        ref: `item:${item.source}:${item.docId}`,
        kind: "design",
        name: item.title,
        description: truncate(item.overview),
      });
    }
  }

  const owners: PaletteEntry[] = [];
  const { stakeholders } = await listStakeholders(workspaceRoot).catch(() => ({ stakeholders: [] as Awaited<ReturnType<typeof listStakeholders>>["stakeholders"] }));
  for (const { stakeholder } of stakeholders) {
    owners.push({
      ref: `stakeholder:${stakeholder.id}`,
      kind: "owner",
      name: stakeholder.name,
      description: truncate(
        [stakeholder.role, stakeholder.organization].filter(Boolean).join(" · ")
      ),
    });
  }

  return { subsystems, apps, components, tokens, features, designs, owners };
}

/** Total number of entries across all sections. */
export function paletteSize(p: DesignPalette): number {
  return (
    p.subsystems.length +
    p.apps.length +
    p.components.length +
    p.tokens.length +
    p.features.length +
    p.designs.length +
    p.owners.length
  );
}
