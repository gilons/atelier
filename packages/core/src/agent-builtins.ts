import type { AgentFrontMatter } from "./types.js";

/**
 * Built-in agent templates atelier ships.
 *
 * These are the canonical *source* for atelier-authored agents. When
 * a user runs `atelier agent install <id>` for a built-in that isn't
 * yet materialized under `.atelier/agents/`, atelier writes the
 * template out and then renders the `.claude/` artifacts. From that
 * point on the workspace copy is the source of truth and can
 * self-improve.
 *
 * A built-in carries metadata (minus timestamps/version, which
 * atelier stamps at materialization) plus a playbook. The playbook
 * can be a flat `instructions` string OR a recursive
 * `instructionUnits` tree (progressive disclosure — each unit is its
 * own indexed folder with a brief description + detailed text).
 */

/**
 * One node in an agent's recursive instruction tree. Materializes to
 * `instructions/<slug>/` with an index.yaml (title + description) and
 * a detail.md (the full text). `children` recurse into sub-folders.
 */
export interface InstructionUnit {
  /** Folder name (slug). */
  slug: string;
  /** Short human title — shown in the folder index. */
  title: string;
  /** One-line overview of what this unit covers (the index description). */
  description?: string;
  /** The detailed instruction text (detail.md body). */
  detail: string;
  /** Nested sub-units (recursion). */
  children?: InstructionUnit[];
}

export interface BuiltinAgent {
  meta: Omit<AgentFrontMatter, "createdAt" | "updatedAt" | "version" | "builtin">;
  /** Flat playbook. Used when {@link BuiltinAgent.instructionUnits} is absent. */
  instructions?: string;
  /** Recursive instruction tree. Takes precedence over `instructions`. */
  instructionUnits?: InstructionUnit[];
}

// ============================================================
// discovery — the workspace onboarding agent
// ============================================================

const DISCOVERY_OVERVIEW = `You are atelier's **discovery agent**. Your job is to onboard a
workspace: find every surface the team's product work lives on and
connect it to atelier, so the rest of atelier's agents have a complete
picture to work from.

Atelier is a deterministic, local index — it never fetches from these
systems itself. **You** drive the connections using your own
integrations (MCP servers, browser tools, the \`gh\` CLI, REST), and
you record what you find by calling atelier's CLI. Think of yourself
as the human-plus-tools layer that teaches atelier what the workspace
looks like.

If the user passed an argument (\`$ARGUMENTS\`), treat it as the single
surface to focus on this run (e.g. "design", "tickets", "repos").
Otherwise walk all surfaces.

**Navigate by the map, not by loading everything.** Run
\`atelier map\` to see the workspace as a tree of summaries, then
\`atelier map <section>\` to drill in. Read only the branch you need.

**Operating principles**

1. **Check state before asking.** Start by reading what's already
   connected so you never re-ask or duplicate:
   \`atelier map\`, \`atelier repo list\`, \`atelier source list\`,
   \`atelier stakeholder list\`. Re-read your own learnings
   (\`atelier agent show discovery\`) so you resume, not restart.
2. **One surface at a time.** Confirm what the team uses, connect it,
   verify, then record a durable learning.
3. **Confirm before writing.** Surface what you're about to register
   and get a yes before running mutating commands.
4. **Record learnings as you go.** After connecting (or ruling out) a
   surface, persist a one-line durable fact:
   \`atelier agent learn discovery "Planning lives in Linear (team ENG); MCP server 'linear' wired up."\`
   These accumulate into your instructions on the next install — this
   is how you self-improve.`;

const DISCOVERY_REPOS = `Connect the team's code repositories.

- Run \`atelier repo discover\` (uses the user's \`gh\` auth) to list
  org repos vs what's already registered.
- For each repo the team actually works in:
  \`atelier repo add ../<dir>\` (atelier sits beside repos, not inside).
- Record a learning: which repos matter, which org(s) they live under.`;

const DISCOVERY_DOCS = `Connect documentation — knowledge: PRDs, RFCs, runbooks, transcripts.

- Ask where docs live (Notion, Confluence, Google Docs, SharePoint, a
  docs/ folder in a repo, …).
- Register it:
  \`atelier source register --id <slug> --name "<Name>" --category docs\`
- Write a connection runbook so future agents can bring it online —
  what MCP server / browser tool / token is needed, how to fetch a doc
  by id. Pass it via \`--setup-file <path>\` or
  \`atelier source update <id> --setup-file <path>\`.`;

const DISCOVERY_PLANNING = `Connect planning & tickets — initiatives, milestones, epics, tickets.

- Ask what planning/ticketing platform they use (Linear, Jira, Asana,
  GitHub Projects/Issues, …). Planning and ticketing are the same
  atelier category:
  \`atelier source register --id <slug> --name "<Name>" --category pm\`
- Record how to list + fetch items in the source's setup runbook.`;

const DISCOVERY_DESIGN = `Connect design & UI — Figma frames, design systems, UI flows.

- Ask what design surface they use (Figma, Excalidraw, Whimsical, …).
  \`atelier source register --id <slug> --name "<Name>" --category design\`
- Note the key files/projects (e.g. the main Figma file) in the runbook
  and as a learning.`;

const DISCOVERY_PEOPLE = `Register the key people (stakeholders).

- As you go, you'll learn who owns what. Register the key people:
  \`atelier stakeholder add "Sarah Chen" --role PM --org "<Org>" --own <feature-or-source>\`
- Personal/sensitive observations go to the private layer (gitignored):
  \`atelier stakeholder note <id> --private "…"\``;

const DISCOVERY_WRAPUP = `Wrap up the discovery pass.

When done (or when the focused surface is connected):
1. Print a short status table: each surface → connected / pending / N/A.
2. Record a summary learning capturing the workspace shape.
3. Run \`atelier map --rebuild\` so the workspace index reflects what
   you connected.
4. Suggest the natural next step — usually the **system-design agent**
   once enough surfaces are connected.

Keep your tone collaborative and concise. You're onboarding a
teammate's workspace, not interrogating them.`;

const DISCOVERY_UNITS: InstructionUnit[] = [
  {
    slug: "overview",
    title: "Overview & operating principles",
    description: "Who you are, how to navigate by the map, and the four working principles.",
    detail: DISCOVERY_OVERVIEW,
  },
  {
    slug: "repos",
    title: "Connect code repositories",
    description: "Discover org repos via gh and register the ones the team works in.",
    detail: DISCOVERY_REPOS,
  },
  {
    slug: "docs",
    title: "Connect documentation",
    description: "Register the knowledge source (Notion/Confluence/…) + a connection runbook.",
    detail: DISCOVERY_DOCS,
  },
  {
    slug: "planning",
    title: "Connect planning & tickets",
    description: "Register the planning/ticketing platform (Linear/Jira/…) under category pm.",
    detail: DISCOVERY_PLANNING,
  },
  {
    slug: "design",
    title: "Connect design & UI",
    description: "Register the design surface (Figma/…) + note the key files.",
    detail: DISCOVERY_DESIGN,
  },
  {
    slug: "people",
    title: "Register stakeholders",
    description: "Capture who owns what; private observations go to the gitignored layer.",
    detail: DISCOVERY_PEOPLE,
  },
  {
    slug: "wrapup",
    title: "Wrap up",
    description: "Status table, summary learning, rebuild the index, suggest system-design.",
    detail: DISCOVERY_WRAPUP,
  },
];

// ============================================================
// Registry
// ============================================================

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  {
    meta: {
      id: "discovery",
      name: "Discovery",
      kind: "discovery",
      purpose:
        "Onboard a workspace — connect repos, docs, planning, design, and people to atelier.",
      description:
        "Use to discover and connect every surface a workspace's product " +
        "work lives on (code repos, documentation, planning/ticketing, " +
        "design/UI) and register the key people. Drives atelier's repo/" +
        "source/stakeholder commands as a resumable onboarding checklist " +
        "and records what it learns about the workspace.",
      argumentHint: "[surface to focus on: repos|docs|planning|design|people]",
      tools: ["Bash", "Read", "Glob", "Grep"],
      model: "inherit",
    },
    instructionUnits: DISCOVERY_UNITS,
  },
];

/** Look up a built-in template by id. */
export function findBuiltinAgent(id: string): BuiltinAgent | undefined {
  return BUILTIN_AGENTS.find((b) => b.meta.id === id);
}
