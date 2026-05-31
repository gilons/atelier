import {
  requireWorkspaceRoot,
  buildDesignPalette,
  paletteSize,
  detectApps,
  detectNavigation,
  detectConnections,
  detectUiKit,
  buildScreens,
  buildUiOverview,
  loadDisciplineConfig,
  loadDesignConfig,
  setLiveConfig,
  listAgents,
  addAgent,
  BUILTIN_DISCIPLINES,
  buildDesignDisciplineUnits,
  disciplineAgentMeta,
  slugifyDisciplineId,
  DEFAULT_DISCIPLINE,
  DesignConfigError,
  AgentAlreadyExistsError,
  NotInsideWorkspaceError,
  type DesignPalette,
  type DisciplineSpec,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";
import { toolCommand } from "./design-tool.js";

/** The agent's built-in default when no stability gate is configured. */
const DEFAULT_STABILITY_CHUNKS = 2;

const DISCIPLINE_OPT = { type: "string" as const, short: "D" as const };

function disciplineOf(values: Record<string, unknown>): string {
  return (values.discipline as string | undefined)?.trim() || DEFAULT_DISCIPLINE;
}

async function resolveRoot(cwd: string): Promise<string | number> {
  try {
    return await requireWorkspaceRoot(cwd);
  } catch (err) {
    if (err instanceof NotInsideWorkspaceError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
}

/**
 * `atelier design` — the design engine.
 *
 * "design" is an umbrella over disciplines (system-design, ui-design,
 * + custom). Subcommands:
 *   tool        — which platform drives a discipline
 *   palette     — the reusable vocabulary the live agent derives from
 *   live        — tune a discipline's live-companion cadence
 *   discipline  — list / add design disciplines
 */

const SECTION_LABELS: Record<keyof DesignPalette, string> = {
  subsystems: "Subsystems",
  apps: "Apps",
  components: "Components",
  tokens: "Design tokens",
  features: "Features",
  designs: "Existing designs",
  owners: "Owners",
};

const paletteCmd: Command = {
  name: "palette",
  summary: "The reusable design vocabulary (subsystems, features, designs, owners).",
  description:
    "Derives — deterministically — the building blocks a design agent\n" +
    "references by `ref` when sketching live: subsystems (from `repo\n" +
    "inspect`), capabilities (features), existing designs (items in the\n" +
    "discipline), and owners. The live companion loads this once per call\n" +
    "and composes from it. --discipline scopes the `designs` section\n" +
    "(default system-design); --json for the agent.",
  options: {
    json: { type: "boolean" },
    discipline: DISCIPLINE_OPT,
  },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    const palette = await buildDesignPalette(root, { discipline });

    if (values.json === true) {
      process.stdout.write(JSON.stringify(palette, null, 2) + "\n");
      return 0;
    }

    if (paletteSize(palette) === 0) {
      ui.info("The design palette is empty.");
      ui.print(
        `  ${ui.dim("Register repos (`atelier repo add`), add features, or run a design")}`
      );
      ui.print(`  ${ui.dim("agent's initial pass to populate it.")}`);
      return 0;
    }

    for (const key of ["apps", "components", "tokens", "subsystems", "features", "designs", "owners"] as (keyof DesignPalette)[]) {
      const entries = palette[key];
      if (entries.length === 0) continue;
      const label = key === "designs" ? `Existing designs (${discipline})` : SECTION_LABELS[key];
      ui.print(ui.bold(`${label} (${entries.length})`));
      for (const e of entries) {
        const desc = e.description ? `  ${ui.dim("— " + e.description)}` : "";
        ui.print(`  ${ui.green("·")} ${ui.cyan(e.ref)}  ${e.name}${desc}`);
      }
      ui.blank();
    }
    ui.print(`  ${ui.dim("A design agent references these by `ref` during live mode.")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design check — one-shot UI overview (all detectors)
// ============================================================

const checkCmd: Command = {
  name: "check",
  summary: "One-shot UI overview — apps, screens, connections, components, tokens.",
  description:
    "Runs every UI detector at once for the lay of the land: how many\n" +
    "apps + their frameworks, total screens, cross-app connections, and\n" +
    "the design-system kit (components + tokens). The ui-design agent\n" +
    "reads this at the start of a cold run. --json for the agent.",
  options: { json: { type: "boolean" } },
  async run({ values, cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const o = await buildUiOverview(root);
    if (values.json === true) {
      process.stdout.write(JSON.stringify(o, null, 2) + "\n");
      return 0;
    }
    if (o.apps.length === 0) {
      ui.info("No frontend apps detected.");
      ui.print(`  ${ui.dim("Register the repos that hold your UI (`atelier repo add ../<dir>`), or run the discovery agent.")}`);
      return 0;
    }

    ui.print(ui.bold(`UI overview — ${o.apps.length} app${o.apps.length === 1 ? "" : "s"}`));
    const refW = Math.max(...o.apps.map((a) => a.ref.length));
    const fwW = Math.max(...o.apps.map((a) => a.framework.length));
    for (const a of o.apps) {
      const screens = a.fileBased ? `${a.screens} screen${a.screens === 1 ? "" : "s"}` : "routing in code";
      ui.print(`  ${ui.green("·")} ${ui.cyan(a.ref.padEnd(refW))}  ${a.framework.padEnd(fwW)}  ${ui.dim(screens)}`);
    }
    ui.blank();
    ui.print(`  ${ui.dim("Screens:")}     ${o.totalScreens} total`);
    ui.print(
      `  ${ui.dim("Connections:")} ${o.connections}${o.designSystemConnections ? ` (${o.designSystemConnections} design system)` : ""}`
    );
    ui.print(`  ${ui.dim("Components:")}  ${o.componentSources} source${o.componentSources === 1 ? "" : "s"} (${o.totalComponents} components)`);
    ui.print(`  ${ui.dim("Tokens:")}      ${o.tokenSources} source${o.tokenSources === 1 ? "" : "s"}`);
    ui.blank();
    const hint = mode === "repl" ? "/agent install ui-design" : "atelier agent install ui-design";
    ui.print(`  ${ui.dim(`Drill in: design apps · nav · screens · connections · kit. Run the agent: \`${hint}\`.`)}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design apps — the UI discovery entry
// ============================================================

const appsCmd: Command = {
  name: "apps",
  summary: "Detect the frontend applications across the workspace's repos.",
  description:
    "UI work is organized by application. This deterministically lists\n" +
    "the frontend apps (Next.js / React / Vue / SvelteKit / Angular /\n" +
    "Astro / Nuxt / React Native / …) across all registered repos — the\n" +
    "discovery entry the ui-design agent starts from. Handles the shapes\n" +
    "a workspace comes in: many apps across repos, one monorepo of apps,\n" +
    "or several separate projects. --json for the agent.",
  options: { json: { type: "boolean" } },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const apps = await detectApps(root);
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ apps }, null, 2) + "\n");
      return 0;
    }
    if (apps.length === 0) {
      ui.info("No frontend apps detected.");
      ui.print(`  ${ui.dim("Register the repos that hold your UI (`atelier repo add ../<dir>`).")}`);
      return 0;
    }
    const refWidth = Math.max(...apps.map((a) => a.ref.length));
    for (const a of apps) {
      ui.print(`  ${ui.green("·")} ${ui.cyan(a.ref.padEnd(refWidth))}  ${a.name}  ${ui.dim(a.framework)}`);
    }
    ui.blank();
    ui.print(`  ${ui.dim("The ui-design agent maps each app's navigation + connects them. `atelier agent install ui-design`.")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design nav — per-app navigation (route) map
// ============================================================

const navCmd: Command = {
  name: "nav",
  summary: "Extract each app's navigation (routes) from its file-based router.",
  description:
    "Reads routes deterministically from file-based routers (Next.js,\n" +
    "SvelteKit, Astro, Nuxt, Remix, Expo, Gatsby) — the seed for an app's\n" +
    "navigation map. Pass an app (ref / name / repo) to scope to one.\n" +
    "Apps whose routing lives in code (plain React/Vue/…) report no\n" +
    "routes — the ui-design agent reads those itself. --json for the agent.",
  positionals: ["app?"],
  options: { json: { type: "boolean" } },
  async run({ values, positionals, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const navs = await detectNavigation(root, { app: positionals[0] });
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ apps: navs }, null, 2) + "\n");
      return 0;
    }
    if (navs.length === 0) {
      ui.info("No frontend apps detected.");
      ui.print(`  ${ui.dim("Register the repos that hold your UI, then `atelier design apps`.")}`);
      return 0;
    }
    for (const { app, routes, fileBased } of navs) {
      ui.print(`${ui.bold(app.ref)}  ${ui.dim(app.framework)}`);
      if (!fileBased) {
        ui.print(`  ${ui.dim("(routing is in code — the ui-design agent reads it)")}`);
      } else if (routes.length === 0) {
        ui.print(`  ${ui.dim("(no routes found)")}`);
      } else {
        for (const r of routes) {
          ui.print(`  ${ui.green("·")} ${r.route}${r.dynamic ? ui.dim("  (dynamic)") : ""}`);
        }
      }
      ui.blank();
    }
    ui.print(`  ${ui.dim("The ui-design agent documents these as a navigation map + links to docs.")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design connections — how the apps connect (shared internal code)
// ============================================================

const connectionsCmd: Command = {
  name: "connections",
  summary: "Infer how the apps connect (shared internal/workspace packages).",
  description:
    "Reads the package graph to find apps that share internal code — a\n" +
    "shared design system, API client, or auth lib. Those are the\n" +
    "deterministic edges in the 'how do the apps connect' view; the\n" +
    "ui-design agent renders them in the tool. Connections that live in\n" +
    "URLs / deep links / APIs aren't inferable here — the agent reads\n" +
    "those from code. --json for the agent.",
  options: { json: { type: "boolean" } },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const graph = await detectConnections(root);
    if (values.json === true) {
      process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
      return 0;
    }
    if (graph.apps.length === 0) {
      ui.info("No frontend apps detected.");
      return 0;
    }
    if (graph.edges.length === 0) {
      ui.info(`No shared internal code across the ${graph.apps.length} app(s).`);
      ui.print(
        `  ${ui.dim("Apps may still connect via URLs / APIs — the ui-design agent reads those from code.")}`
      );
      return 0;
    }
    ui.print(ui.bold("Connections (apps sharing internal code)"));
    for (const e of graph.edges) {
      const tag = e.designSystem ? ui.cyan(" [design system]") : "";
      ui.print(`  ${ui.green("·")} ${e.package}${tag}`);
      ui.print(`      ${ui.dim(e.apps.join("  ·  "))}`);
    }
    ui.blank();
    ui.print(`  ${ui.dim("The ui-design agent renders these as the connected-apps view (`design discipline`: ui-design).")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design screens — the screen inventory (design checklist)
// ============================================================

const screensCmd: Command = {
  name: "screens",
  summary: "The per-app screen inventory (routes → screens to design).",
  description:
    "Reframes each app's routes as the screens it needs designed,\n" +
    "grouped by section — the deterministic checklist the design tool\n" +
    "should have a frame for. The ui-design agent uses it to find gaps\n" +
    "(screens with no frame) and drift. Pass an app to scope to one;\n" +
    "--json for the agent.",
  positionals: ["app?"],
  options: { json: { type: "boolean" } },
  async run({ values, positionals, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const screens = await buildScreens(root, { app: positionals[0] });
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ apps: screens }, null, 2) + "\n");
      return 0;
    }
    if (screens.length === 0) {
      ui.info("No frontend apps detected.");
      return 0;
    }
    for (const a of screens) {
      ui.print(`${ui.bold(a.app.ref)}  ${ui.dim(a.app.framework)}  ${ui.dim(a.total + " screen" + (a.total === 1 ? "" : "s"))}`);
      if (!a.fileBased) {
        ui.print(`  ${ui.dim("(routing is in code — the ui-design agent enumerates screens)")}`);
      } else if (a.total === 0) {
        ui.print(`  ${ui.dim("(no screens found)")}`);
      } else {
        for (const s of a.sections) {
          ui.print(`  ${ui.dim(s.section)}`);
          for (const sc of s.screens) {
            ui.print(`    ${ui.green("·")} ${sc.label}  ${ui.dim(sc.route)}${sc.dynamic ? ui.dim("  (dynamic)") : ""}`);
          }
        }
      }
      ui.blank();
    }
    ui.print(`  ${ui.dim("The ui-design agent ensures the design tool has a frame per screen.")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design kit — the UI building blocks (components + tokens)
// ============================================================

const kitCmd: Command = {
  name: "kit",
  summary: "Detect the UI building blocks — component sources + design tokens.",
  description:
    "Reads the reusable UI vocabulary from code: where components live\n" +
    "(component dirs across apps + shared packages, with counts +\n" +
    "samples) and where design tokens live (Tailwind config, tokens.json,\n" +
    "theme files). The ui-design live companion composes screens from\n" +
    "these — reference an existing component / token, don't reinvent one.\n" +
    "--json for the agent.",
  options: { json: { type: "boolean" } },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const kit = await detectUiKit(root);
    if (values.json === true) {
      process.stdout.write(JSON.stringify(kit, null, 2) + "\n");
      return 0;
    }
    if (kit.components.length === 0 && kit.tokens.length === 0) {
      ui.info("No components or design tokens detected.");
      ui.print(`  ${ui.dim("Register the repos that hold your UI; component dirs + token configs are picked up automatically.")}`);
      return 0;
    }
    if (kit.components.length > 0) {
      ui.print(ui.bold(`Component sources (${kit.components.length})`));
      for (const c of kit.components) {
        const samples = c.samples.length > 0 ? `  ${ui.dim(c.samples.slice(0, 4).join(", "))}` : "";
        ui.print(`  ${ui.green("·")} ${ui.cyan(c.ref)}  ${ui.dim(c.count + " components")}${samples}`);
      }
      ui.blank();
    }
    if (kit.tokens.length > 0) {
      ui.print(ui.bold(`Design tokens (${kit.tokens.length})`));
      for (const t of kit.tokens) {
        ui.print(`  ${ui.green("·")} ${ui.cyan(t.ref)}  ${ui.dim(t.kind)}`);
      }
      ui.blank();
    }
    ui.print(`  ${ui.dim("The ui-design agent composes screens from these (derive, don't reinvent).")}`);
    ui.blank();
    return 0;
  },
};

// ============================================================
// design live — per-discipline two-track tuning
// ============================================================

const liveShowCmd: Command = {
  name: "show",
  summary: "Show a discipline's live-companion tuning (stability gate, live STT model).",
  options: { discipline: DISCIPLINE_OPT },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);
    const cfg = await loadDisciplineConfig(root, discipline);
    const live = cfg?.live;
    const chunks = live?.stabilityChunks ?? DEFAULT_STABILITY_CHUNKS;
    ui.print(`  ${ui.dim("discipline:")}     ${discipline}`);
    ui.print(
      `  ${ui.dim("stability gate:")} ${chunks} chunk(s)${live?.stabilityChunks === undefined ? ui.dim(" (default)") : ""}`
    );
    ui.print(
      `  ${ui.dim("live STT model:")} ${live?.model ?? ui.dim("(agent default — fast model)")}`
    );
    return 0;
  },
};

const liveSetCmd: Command = {
  name: "set",
  summary: "Tune a discipline's live companion (stability gate / live STT model).",
  description:
    "The slow track renders only after a topic is stable for\n" +
    "--stability-chunks chunks (higher = calmer on volatile calls).\n" +
    "--model picks the fast STT model used live. --discipline targets\n" +
    "one (default system-design).",
  options: {
    "stability-chunks": { type: "string" },
    model: { type: "string", short: "m" },
    discipline: DISCIPLINE_OPT,
  },
  async run({ values, cwd }) {
    if (values["stability-chunks"] === undefined && values.model === undefined) {
      ui.error("Nothing to set. Pass --stability-chunks <n> and/or --model <name>.");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    let stabilityChunks: number | undefined;
    if (values["stability-chunks"] !== undefined) {
      const n = Number(values["stability-chunks"]);
      if (!Number.isInteger(n) || n < 1) {
        ui.error("--stability-chunks must be a positive integer.");
        return 2;
      }
      stabilityChunks = n;
    }

    try {
      const cfg = await setLiveConfig(root, {
        discipline,
        stabilityChunks,
        model: values.model as string | undefined,
      });
      ui.success(`Updated ${ui.bold(discipline)} live tuning.`);
      ui.print(`  ${ui.dim("stability gate:")} ${cfg.live?.stabilityChunks ?? DEFAULT_STABILITY_CHUNKS} chunk(s)`);
      if (cfg.live?.model) ui.print(`  ${ui.dim("live STT model:")} ${cfg.live.model}`);
      return 0;
    } catch (err) {
      if (err instanceof DesignConfigError) {
        ui.error(err.message);
        return 2;
      }
      throw err;
    }
  },
};

const liveCmd: Command = {
  name: "live",
  summary: "Tune a discipline's live-companion cadence (stability gate, live STT model).",
  description:
    "The live companion uses a two-track design: a cheap fast track\n" +
    "every chunk + a gated slow track that renders only once a topic is\n" +
    "stable. These knobs calibrate that gate per discipline.",
  subcommands: [liveShowCmd, liveSetCmd],
};

// ============================================================
// design discipline — list / add design disciplines
// ============================================================

/** Custom (non-built-in) disciplines are installed agents of kind "design". */
async function customDisciplineIds(workspaceRoot: string): Promise<string[]> {
  const { agents } = await listAgents(workspaceRoot).catch(() => ({ agents: [] as Awaited<ReturnType<typeof listAgents>>["agents"] }));
  const builtinIds = new Set(BUILTIN_DISCIPLINES.map((d) => d.id));
  return agents
    .filter((a) => a.agent.kind === "design" && !builtinIds.has(a.agent.id))
    .map((a) => a.agent.id);
}

const disciplineListCmd: Command = {
  name: "list",
  summary: "List design disciplines (built-in + custom) and their tool.",
  async run({ cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const cfg = await loadDesignConfig(root).catch(() => null);
    const customIds = await customDisciplineIds(root);
    const rows: { id: string; name: string; builtin: boolean }[] = [
      ...BUILTIN_DISCIPLINES.map((d) => ({ id: d.id, name: d.name, builtin: true })),
      ...customIds.map((id) => ({ id, name: id, builtin: false })),
    ];

    const idWidth = Math.max("ID".length, ...rows.map((r) => r.id.length));
    ui.print(`    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("TOOL")}`);
    for (const r of rows) {
      const tool = cfg?.disciplines[r.id]?.tool;
      const badge = r.builtin ? ui.dim(" [built-in]") : ui.dim(" [custom]");
      ui.print(
        `  ${ui.green("·")} ${r.id.padEnd(idWidth)}  ${tool ?? ui.dim("(none — infers / Markdown)")}${badge}`
      );
    }
    ui.blank();
    ui.print(`  ${ui.dim("Each discipline gets the full design engine. Install one: `atelier agent install <id>`.")}`);
    ui.print(`  ${ui.dim("Add your own: `atelier design discipline add <id> --name \"…\" --designs \"…\"`.")}`);
    ui.blank();
    return 0;
  },
};

const disciplineAddCmd: Command = {
  name: "add",
  summary: "Add a custom design discipline (generates its agent from the shared engine).",
  description:
    "Scaffolds a new discipline under the design umbrella with the same\n" +
    "engine as system-design / ui-design — tool-aware onboarding, the\n" +
    "palette, the live two-track companion, refresh, prompted promotion,\n" +
    "self-improvement. Generates the agent; install it with\n" +
    "`atelier agent install <id>`.",
  positionals: ["id?"],
  options: {
    id: { type: "string" },
    name: { type: "string", short: "n" },
    designs: { type: "string", short: "d" },
    artifacts: { type: "string", short: "a" },
    units: { type: "string", short: "u" },
    tools: { type: "string", short: "t" },
  },
  async run({ values, positionals, cwd }) {
    const name = values.name as string | undefined;
    if (!name) {
      ui.error("Missing --name.");
      ui.print(`  ${ui.dim('Usage: atelier design discipline add <id> --name "Service Design" --designs "service blueprints"')}`);
      return 2;
    }
    const designs = values.designs as string | undefined;
    if (!designs) {
      ui.error("Missing --designs (one phrase for what this discipline designs).");
      return 2;
    }
    const rawId = (values.id as string | undefined) ?? positionals[0] ?? name;
    const id = slugifyDisciplineId(rawId);
    if (!id) {
      ui.error(`Could not derive a slug id from "${rawId}".`);
      return 2;
    }
    if (BUILTIN_DISCIPLINES.some((d) => d.id === id)) {
      ui.error(`"${id}" is a built-in discipline — install it with \`atelier agent install ${id}\`.`);
      return 1;
    }

    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const spec: DisciplineSpec = {
      id,
      name,
      designs,
      artifacts: (values.artifacts as string | undefined) ?? designs,
      units: (values.units as string | undefined) ?? "pieces",
      toolExamples: (values.tools as string | undefined) ?? "any AI-drivable design tool",
    };

    try {
      const agent = await addAgent(root, {
        ...disciplineAgentMeta(spec),
        instructionUnits: buildDesignDisciplineUnits(spec),
      });
      ui.success(`Added design discipline ${ui.bold(agent.id)}.`);
      ui.blank();
      ui.print(`  ${ui.dim("→ Install it for Claude:")} atelier agent install ${agent.id}`);
      ui.print(`  ${ui.dim("→ Pick its tool:")} atelier design tool set <tool> --discipline ${agent.id}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof AgentAlreadyExistsError) {
        ui.error(`An agent "${id}" already exists. Pick a different id.`);
        return 1;
      }
      throw err;
    }
  },
};

const disciplineCmd: Command = {
  name: "discipline",
  summary: "List or add design disciplines (system-design, ui-design, custom).",
  description:
    "Disciplines are the kinds of design under the umbrella. Built-ins:\n" +
    "system-design, ui-design. Add your own (service design, space\n" +
    "design, …) — each gets the whole design engine from one template.",
  subcommands: [disciplineListCmd, disciplineAddCmd],
};

export const designCommand: Command = {
  name: "design",
  summary: "The design engine: disciplines, tool selection, palette, live tuning.",
  description:
    "design is an umbrella over disciplines (system-design, ui-design, +\n" +
    "custom), each sharing the same engine:\n" +
    "  discipline — list / add disciplines\n" +
    "  tool       — which platform drives a discipline\n" +
    "  check      — one-shot UI overview (apps + screens + connections + kit)\n" +
    "  apps       — detect the frontend apps (the UI discovery entry)\n" +
    "  nav        — extract each app's routes (navigation map seed)\n" +
    "  screens    — the per-app screen inventory (design checklist)\n" +
    "  connections— how the apps connect (shared internal code)\n" +
    "  kit        — the UI building blocks (components + design tokens)\n" +
    "  palette    — the reusable vocabulary the agent composes from live\n" +
    "  live       — tune a discipline's live two-track cadence",
  subcommands: [disciplineCmd, toolCommand, checkCmd, appsCmd, navCmd, screensCmd, connectionsCmd, kitCmd, paletteCmd, liveCmd],
};
