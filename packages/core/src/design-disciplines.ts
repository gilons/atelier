import type { InstructionUnit } from "./agent-builtins.js";

/**
 * Design disciplines.
 *
 * "design" is an umbrella. Under it live design *disciplines* —
 * system-design, ui-design, and any the team adds later (service
 * design, space design, …). Every discipline gets the *same* engine:
 * tool selection, discovery/onboarding, the design palette, the live
 * two-track companion, refresh, prompted promotion, and
 * self-improvement — all on the progressive-index convention.
 *
 * The shared engine is encoded once, as a parameterized instruction
 * tree ({@link buildDesignDisciplineUnits}). A discipline is just a
 * small {@link DisciplineSpec} of what differs — what it designs, its
 * artifacts, example tools, and its item classification. Built-ins
 * (system-design, ui-design) and user-added disciplines all flow
 * through the same template, so adding a new discipline gives it the
 * whole engine for free.
 */

export interface DisciplineSpec {
  /** Slug id — also the agent id and the item classification tag. */
  id: string;
  /** Display name, e.g. "UI Design". */
  name: string;
  /** One phrase for what it designs, e.g. "user interfaces". */
  designs: string;
  /** The artifacts it produces (comma phrase). */
  artifacts: string;
  /** The units it enumerates when bootstrapping (comma phrase). */
  units: string;
  /** Example AI-drivable tools for this discipline. */
  toolExamples: string;
  /** True for atelier's built-in disciplines. */
  builtin?: boolean;
  /**
   * Optional discipline-specific instruction units, spliced into the
   * tree after "initial design". Lets a discipline add its own
   * mechanics (e.g. UI's app navigation map) on top of the shared
   * engine without forking the template.
   */
  extraUnits?: InstructionUnit[];
  /**
   * Optional note appended to the live-companion setup unit — e.g.
   * UI's "sketch into a separate draft project, not the main board".
   */
  liveDraftNote?: string;
}

// ============================================================
// UI-design — discipline-specific units
// ============================================================

/**
 * UI design's specialization on top of the shared engine: applications
 * are the discovery entry, each gets a documented navigation map, the
 * apps' connections are shown in the tool, and multiple design boards
 * (one per app/project) are first-class.
 */
function UI_DESIGN_EXTRA_UNITS(): InstructionUnit[] {
  return [
    {
      slug: "app-navigation-map",
      title: "Applications & navigation maps",
      description: "Enumerate apps (design apps); map each app's navigation; document + link to docs.",
      detail: `UI work is organized by **application**, and a workspace comes in
shapes: many apps across repos, one monorepo holding several apps, or
separate projects each with their own UI.

1. **Enumerate the apps first:** \`atelier design apps --json\` lists the
   frontend apps (Next.js / React / Vue / SvelteKit / …) across the
   registered repos. That's your inventory.
2. For **each app**, build a **complete navigation map** — its routes /
   screens and how you move between them. Start from
   \`atelier design nav <app> --json\`, which extracts routes from
   file-based routers (Next / SvelteKit / Astro / Nuxt / Remix / Expo /
   Gatsby). For apps whose routing lives in code (plain React/Vue/…),
   read it yourself. Then **document the map as a ui-design item**
   (\`atelier item add <source>:<id> --title "<app> — navigation"
   --classification ui-design\`), **linking to existing documentation**
   in the system (docRefs on the feature/item).
3. Do this **even without visuals** — the map + doc links come first.
   Visuals are added progressively (as you onboard a feature). Most
   screen designs **already exist** in the design tool — **connect to
   them and build on top**, don't redraw. When useful, split a screen
   set into its own ui-design item, or a new project.`,
    },
    {
      slug: "connected-apps",
      title: "Show how applications connect",
      description: "When a tool is onboarded, render the cross-app connections; else capture in Mermaid.",
      detail: `Once a design tool is onboarded, **visually show how the apps connect
to each other** — cross-app navigation, shared auth / session, deep
links, a shared design system.

Start from \`atelier design connections --json\`: it infers the
deterministic edges from the package graph — apps that share internal
code (a shared design system, API client, auth lib), with the
design-system ones flagged. Connections that live in URLs / deep links
/ API calls aren't in there — read those from the apps' code yourself
and add them.

Produce a **connections view** (apps as nodes, the links between them
as edges) directly in the tool, and mirror a summary item into atelier.
Without a tool yet, capture the connections in the navigation-map
markdown (Mermaid). This whole-product picture is the thing a team
rarely has in one place — lead with it.`,
    },
    {
      slug: "screen-coverage",
      title: "Screen coverage & drift",
      description: "Use design screens as the checklist; find gaps + drift vs the tool.",
      detail: `Keep the **screens that exist** and the **screens that are designed**
in sync.

- \`atelier design screens --json\` is the deterministic checklist —
  every route is a screen the design tool should have a frame for,
  grouped by section.
- **Coverage gaps:** screens in the inventory with **no frame** in the
  tool (and no ui-design item) — these are undesigned. List them so the
  team can prioritize.
- **Drift the other way:** frames / ui-design items that **don't map to
  any current screen** — likely stale (a removed route) or ahead of the
  code (designed, not yet built). Flag stale ones as discrepancies;
  note ahead-of-code ones as planned.
- Re-run after routes change; coverage is a moving target. Precise
  per-frame status needs the tool — you read its frames; atelier gives
  you the authoritative screen list to check against.`,
    },
    {
      slug: "design-system",
      title: "Design system — components & tokens",
      description: "Inventory the component sources + design tokens; compose screens from them.",
      detail: `Inventory the reusable UI building blocks before designing screens —
they're your "derive, don't reinvent" vocabulary.

- \`atelier design kit --json\` lists the **component sources** (the
  dirs / packages where components live, with counts + sample names)
  and the **design-token sources** (Tailwind config, tokens.json,
  theme files) across the workspace.
- Connect the **design tool's** component library + token styles to
  these **code sources** — they should be the same system, named the
  same way. Flag drift (a token in the tool that's not in code, or
  vice-versa) as a discrepancy.
- When you design or sketch a screen, **compose from the existing
  components + tokens** (reference them by name), don't invent new ones
  unless the screen genuinely needs them.
- Document the design system itself as a ui-design item, linking the
  code sources + the tool's library.`,
    },
    {
      slug: "multiple-boards",
      title: "Multiple design boards / sources",
      description: "Account for one board per app/project; map each app to its board.",
      detail: `Companies often run **multiple UI design boards** — one per app or
project. Account for that:

- Register **each board as its own \`design\` source\`** (the company may
  have several).
- **Map each app to its board** — note it in the app's ui-design item
  and the source's runbook.
- \`atelier design tool set <tool> --discipline ui-design\` records the
  default board; when apps use different boards, record the per-app
  board on the item. Never assume a single board for everything.`,
    },
  ];
}

// ============================================================
// Built-in discipline specs
// ============================================================

export const BUILTIN_DISCIPLINES: readonly DisciplineSpec[] = [
  {
    id: "system-design",
    name: "System Design",
    designs: "system architecture",
    artifacts: "context, containers, components, data models, and key sequences",
    units: "projects / subsystems / services",
    toolExamples: "Excalidraw / Lucidchart / Figma",
    builtin: true,
  },
  {
    id: "ui-design",
    name: "UI Design",
    designs: "user interfaces",
    artifacts: "applications, navigation maps, screens, flows, components, and design tokens",
    units: "applications (across repos / a monorepo / separate projects)",
    toolExamples: "Figma / Sketch / Penpot",
    builtin: true,
    liveDraftNote:
      "**UI live preview is a separate draft, never the main board.** " +
      "Create a separate draft project / page in the design tool (or a " +
      "separate design-draft.md) and sketch there during the call — " +
      "promote into the main board only at finalize, if the user approves.",
    extraUnits: UI_DESIGN_EXTRA_UNITS(),
  },
];

export function findBuiltinDiscipline(id: string): DisciplineSpec | undefined {
  return BUILTIN_DISCIPLINES.find((d) => d.id === id);
}

/** Slugify a free-form discipline name into an id. */
export function slugifyDisciplineId(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ============================================================
// Shared instruction-tree template
// ============================================================

/**
 * Build the full design engine instruction tree for one discipline.
 * Every discipline (built-in or custom) shares these mechanisms; only
 * the {@link DisciplineSpec} fields differ.
 */
export function buildDesignDisciplineUnits(spec: DisciplineSpec): InstructionUnit[] {
  const D = spec.designs; // "user interfaces"
  const id = spec.id;

  const overview = `You are atelier's **${spec.name.toLowerCase()} agent**. You help the team
design and document ${D} — ${spec.artifacts} — and the decisions behind
them. You are one *discipline* under atelier's design umbrella; you
share the same engine as the other design agents.

You work with whatever **${spec.name} tool** the workspace uses
(${spec.toolExamples}, or Markdown when there's none). Three cases,
handled in order:

1. **A tool is configured** for this discipline
   (\`atelier design tool show --discipline ${id}\` / a \`design\`
   source) — drive it to create/update the designs, and mirror a short
   text summary back into atelier so the work is discoverable without
   opening the tool.
2. **No tool configured, but the team uses one** — onboard it (see
   "Onboard a tool"): register a \`design\` source + connection runbook,
   then proceed as case 1.
3. **No tool at all** — fall back to **Markdown** (Mermaid where it
   helps); index it in atelier. Zero dependencies; the default.

Navigate by the map, don't load everything: \`atelier map\`, then
\`atelier map agents/${id}/instructions\`. If the workspace looks empty,
run the **discovery agent** (\`/atelier:discovery\`) first.

Modes: **bootstrap** an initial ${D} design when there's none yet;
**refresh** (diff, don't rebuild) when one exists; run as a **live
companion** on a call. Record durable facts with
\`atelier agent learn ${id} "…"\` so your knowledge compounds.`;

  const detectTool = `Find the configured tool for this discipline before acting.

- **Check the explicit setting first:**
  \`atelier design tool show --discipline ${id}\`. If it names a tool,
  that's authoritative — use it (read its backing \`design\` source
  runbook if linked).
- Otherwise \`atelier source list\` for \`design\` sources, and re-read
  your learnings (\`atelier agent show ${id}\`).
- If none exists, go to "Onboard a tool". Pin the choice once made:
  \`atelier design tool set <tool> --discipline ${id} --source <id>\`.`;

  const onboardTool = `No tool is configured for ${spec.name}. Ask what the team uses
(${spec.toolExamples}, or none → Markdown). To onboard one:

1. \`atelier source register --id <slug> --name "<Name>" --category design\`
2. Write a connection runbook (how you'll drive it — MCP server,
   browser tool, or API) and attach it
   (\`atelier source update <slug> --setup-file <path>\`).
3. Verify you can create/read a ${D.replace(/s$/, "")} artifact.
4. Pin it: \`atelier design tool set <name> --discipline ${id} --source <slug>\`.

Confirm before registering. Never store API tokens in sources.yaml —
reference an env var in the runbook.`;

  const driveTool = `With a tool configured, produce the design:

1. Read context first: \`atelier map\`, relevant features, items, repos.
2. Create/update the ${D} in the tool (${spec.artifacts}).
3. Mirror a concise summary into atelier so it's discoverable without
   opening the tool:
   \`atelier item add <source>:<id> --title "…" --classification ${id} --link <tool-url>\`.
4. Link the design to the features / specs it serves.

Keep the tool as the source of truth for visuals; atelier holds the
summary + links.`;

  const markdown = `When the team uses no dedicated tool, author the ${D} design as
**Markdown** (Mermaid where a diagram helps) — always available,
diffable, version-controlled.

1. Write it as markdown covering ${spec.artifacts}. Store it in the
   repo (e.g. \`docs/design/<name>.md\`) and index it as an item with
   \`--classification ${id}\`.
2. If there's no \`design\` source yet, register a local one
   (\`atelier source register --id markdown-${id} --name "Markdown ${spec.name}" --category design\`).
3. Link it to the features / specs it serves. Markdown is the default —
   never block on tooling.`;

  const bootstrap = `Generate the **initial ${D} design** for the workspace — the
cold-start pass; run once, then refresh.

1. **Enumerate** the ${spec.units} (use \`atelier repo inspect --json\`
   + \`atelier map\` + existing items). Produce a flat inventory.
2. **Analyze** similarities + patterns across them (shared pieces,
   conventions, integration/composition points, anti-patterns).
3. **Document** — register the major capabilities as features, add
   ${id} items (\`--classification ${id}\`) for the overview + each
   significant piece, log decisions/risks as discrepancies, record a
   learning capturing the shape.
4. **Diagram** — a landscape/overview plus per-piece views, in the
   configured tool or Markdown (Mermaid). Mirror each into atelier as a
   ${id} item with a link.

Keep every artifact in the title + one-line-description index shape so
the map stays scannable. \`atelier map --rebuild\` when done.`;

  const refresh = `**Refresh** an existing ${D} design instead of rebuilding it —
diff, don't regenerate. Same "derive, don't generate" discipline over
time.

1. **Detect changes:** read the existing ${id} items (the baseline)
   and diff against today's reality — code (\`atelier repo inspect\` +
   git), docs/planning items, and tool edits since the item's
   updatedAt. Produce a change list with evidence.
2. **Apply the delta in place:** \`atelier item update <source>:<docId>\`
   for the affected designs + targeted diagram edits; reference
   existing palette \`ref\`s; keep prior decisions + history.
3. **Record:** log real divergences as discrepancies
   (\`atelier discrepancy add\`), record a learning, \`atelier map
   --rebuild\`.`;

  const synthesize = `Build a **reconciled, whole-workspace ${D} picture** by pulling
together everything that already exists:

- **Design tool** — pull existing ${D} designs already drawn.
- **Documentation** (\`docs\` sources) — what it's supposed to be.
- **Planning** (\`pm\` sources) — what's being built and why.
- **Code** — what's actually built (ground truth).

Map each capability across these, **reconcile** where intent and
reality diverge (log discrepancies), and produce one navigable map —
many small, well-titled ${id} items, not one giant doc.`;

  // Live companion (two-track). Children keep it tight.
  const liveOverview = `Run as a **live planning companion** during a recorded call about
${D}. You consume the transcript (atelier's recorder + chunked
transcription) and react — *near*-real-time (a few seconds of lag), a
glanceable evolving picture, not a mirror.

**The rule that keeps it fast: derive, don't generate.** Everything you
put on screen live must be a derivative of something that already
exists — reference the **design palette**
(\`atelier design palette --discipline ${id} --json\`, loaded ONCE at
the start) by its \`ref\`. A genuinely-new thing is a single "proposed"
stub now; full modeling is deferred to finalize.

**Two tracks:** a cheap **fast track** every chunk (match the palette,
classify new-vs-modification, keep a "Discussing now" anchor +
follow-up questions current) and a gated **slow track** that renders
only when a topic is stable for the configured **stability gate**
(\`atelier design live show --discipline ${id}\` — default ~2 chunks),
or on request. On volatile calls the gate stays quiet.`;

  const liveSetup = `Pre-flight: pre-compute the substrate (bootstrap/synthesize if the
map is thin); load the palette once
(\`atelier design palette --discipline ${id} --json\`); find the active
recording (\`atelier session list\`; else \`atelier session record
--chunk 45\`) and use a fast STT model live. Set up the view: if a tool
is connected, share its live link; else seed the session's
\`design-draft.md\` and tell the user to run \`atelier session watch
<id>\`. Put a top anchor line (\`> **Discussing:** … · _as of …_\`) so
the view shows what it reflects.`;

  const liveLoop = `Loop while the call runs. **Fast track** every chunk:
\`atelier session check <id>\` → transcribe pending chunks with the fast
model → \`atelier session note <id> --chunk <name> --text "…"\`; read
the delta; match it to palette \`ref\`s; classify **new vs
modification**; refresh the anchor + the top 3–5 follow-up questions.
Don't redraw here. **Slow track** (gated): when a topic is stable
(per the stability gate) or the user asks, render by **overlaying
deltas on the base** — highlight the palette nodes under discussion,
add new things as "proposed" stubs; push to the tool, or rewrite
\`design-draft.md\` (Mermaid) which \`session watch\` auto-refreshes.`;

  const liveFinalize = `Finalize when the call ends (\`status: ended\`). Re-transcribe
accurately + drain. Surface the **substantial outcomes**, then
**prompt the user per outcome** — don't auto-create:
- **Fold into the existing design** → update the ${id} item(s) +
  diagram (\`--from-session <id>\`).
- **Create a new spec** → \`atelier spec new "<title>" --type <type>
  --from-session <id>\`.
- **Park it** → an open item or discrepancy.
Then **improve the engine**: \`atelier agent learn ${id} "…"\`; the
palette grows from the new items; refine your own playbook
(\`atelier agent instruction add ${id} <slug> …\`) if a better pattern
emerged; \`atelier map --rebuild\`. Tell the user what was promoted vs
parked, with the session id.`;

  const deliverables = `A good ${D} design covers ${spec.artifacts}, plus the decisions and
trade-offs behind them. Tie each piece to the features it implements
(\`atelier feature list\`) and the specs that plan changes
(\`atelier spec list\`). Capture open questions as items or
discrepancies so they aren't lost. Keep everything in the title +
one-line-description index shape.`;

  const setupDetail = spec.liveDraftNote ? `${liveSetup}\n\n${spec.liveDraftNote}` : liveSetup;

  const units: InstructionUnit[] = [
    {
      slug: "overview",
      title: `Overview — ${spec.name} as a design discipline`,
      description: `Who you are; tool-aware (drive / onboard / Markdown); the modes.`,
      detail: overview,
    },
    {
      slug: "detect-tool",
      title: "Detect the configured tool",
      description: `Find this discipline's selected tool before acting.`,
      detail: detectTool,
    },
    {
      slug: "onboard-tool",
      title: "Onboard a tool",
      description: `Register the platform the team uses (${spec.toolExamples}) as a design source.`,
      detail: onboardTool,
    },
    {
      slug: "drive-tool",
      title: "Drive the configured tool",
      description: `Produce the ${D} in the tool; mirror a summary + link into atelier.`,
      detail: driveTool,
    },
    {
      slug: "markdown-fallback",
      title: "Markdown fallback (no tool)",
      description: `Author the ${D} as Markdown/Mermaid and index it.`,
      detail: markdown,
    },
    {
      slug: "initial-design",
      title: `Initial ${spec.name.toLowerCase()}`,
      description: `Cold-start: enumerate ${spec.units}, analyze, document, diagram.`,
      detail: bootstrap,
    },
    // Discipline-specific units (e.g. UI's app navigation map) splice in here.
    ...(spec.extraUnits ?? []),
    {
      slug: "refresh-design",
      title: "Refresh an existing design (diff, don't rebuild)",
      description: `Diff today's reality vs the recorded design; update only the delta.`,
      detail: refresh,
    },
    {
      slug: "synthesize-map",
      title: "Synthesize the deep picture",
      description: `Reconcile design ⇄ code ⇄ docs ⇄ planning into one map.`,
      detail: synthesize,
    },
    {
      slug: "live-companion",
      title: "Live companion mode (on a call)",
      description: `Derive-fast, two-track: keep a live draft + follow-up questions.`,
      detail: liveOverview,
      children: [
        { slug: "setup", title: "Set up the live session", description: "Load the palette, set up the view + anchor.", detail: setupDetail },
        { slug: "loop", title: "The two-track loop", description: "Fast track every chunk; gated slow-track render.", detail: liveLoop },
        { slug: "finalize", title: "Finalize on call end", description: "Prompt: fold into design / new spec / park; then improve the engine.", detail: liveFinalize },
      ],
    },
    {
      slug: "deliverables",
      title: "What a good design covers",
      description: `${spec.artifacts}, tied to features/specs.`,
      detail: deliverables,
    },
  ];
  return units;
}

/** Metadata for the agent generated from a discipline spec. */
export function disciplineAgentMeta(spec: DisciplineSpec) {
  return {
    id: spec.id,
    name: spec.name,
    kind: "design",
    purpose: `Design & document ${spec.designs} with the team's tool — or Markdown if none.`,
    description:
      `Use to design or document ${spec.designs} (${spec.artifacts}). ` +
      `Drives the configured ${spec.name} tool (${spec.toolExamples}); ` +
      `onboards one if the team uses a tool but hasn't connected it; ` +
      `falls back to Markdown. Bootstraps an initial design, refreshes ` +
      `an existing one, and runs as a live companion on calls.`,
    argumentHint: `[what to design, or an area to focus on]`,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    model: "inherit",
  };
}
