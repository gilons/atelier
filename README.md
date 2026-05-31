# Atelier

> A planning companion for the spec-driven era.

Atelier is a CLI tool that sits at the **organization level** (not inside any one repo), maps your product across **code, docs, design, and conversations**, and hands production-grade specs off to whichever coding agent you already use (Claude Code, Copilot, Codex, Cursor, …).

It **never calls an LLM itself**. Every deterministic task — git config parsing, project inspection, UI/route detection, validation, the workspace map — runs in plain code. Inference is delegated to the agent you've already connected.

## The model in one minute

Atelier **indexes summaries and links; it never fetches source content or holds credentials.** It doesn't talk to Notion, Jira, or Figma — your agent does, through whatever MCP servers / browser extensions / integrations are already wired up. Atelier just stores the agent-curated summary + a link back, in version-controlled markdown/YAML.

That split is the whole design:

- **Atelier (deterministic core)** owns the cheap, certain facts: which repos exist, which apps/routes/components are in them, the feature map, the workspace index.
- **Your agent** owns everything that needs judgment or I/O: fetching a doc, classifying it, driving a design tool, writing a spec.

Atelier also **authors agents** for you — discovery, system-design, ui-design — rendered into `.claude/` as slash commands + subagents, and they get smarter over time via recorded learnings.

## What it does today

**Workspace & code**
| Capability | Command |
|---|---|
| Interactive REPL with slash commands | `atelier` (no args) |
| Initialize an org-level workspace | `atelier init` |
| Register code repos (with auto-discovery via `gh`) | `atelier repo add` / `repo discover` |
| Inspect repo structure (ecosystems, packages, services) | `atelier repo inspect` |
| Generate a navigable workspace map | `atelier map` |

**Typed surfaces** (the agent indexes into these; each is a summary + link)
| Capability | Command |
|---|---|
| Feature map (with code + doc refs) | `atelier feature add\|list\|show\|remove` |
| Documentation (PRDs, RFCs, runbooks) | `atelier doc add\|list\|show\|update\|remove` |
| Tickets (Linear/Jira/… issues & epics) | `atelier ticket add\|list\|show\|update\|remove` |
| Design artifacts (keyed by discipline) | `atelier design artifact add\|list\|show\|…` |
| Doc-vs-code discrepancies | `atelier discrepancy add\|list\|resolve` |
| Stakeholders (shared + private notes) | `atelier stakeholder add\|note\|…` |
| Specs for planned changes | `atelier spec new\|list\|show` |

**Sources** (connectors, not content)
| Capability | Command |
|---|---|
| Register a source the agent drives | `atelier source register` |
| Attach / read a connection runbook | `atelier source update\|show` |

A source is just an `id` + a `config` blob + an optional `setup.md` runbook the agent follows to connect. It carries no "kind" or category — what it feeds is decided per entry by which surface the agent indexes into (`doc add` vs `ticket add`), so one Notion source can feed both docs and tickets.

**Conversations** (the speaking module)
| Capability | Command |
|---|---|
| Record / import a session + transcript | `atelier session start\|record\|import\|note\|end` |
| See what a session produced (docs/tickets/designs/specs) | `atelier session show` |

**The design engine**
| Capability | Command |
|---|---|
| Disciplines (system-design, ui-design, + custom) | `atelier design discipline` |
| Pin the tool that drives a discipline | `atelier design tool set` |
| Detect frontend apps / routes / screens / components | `atelier design apps\|nav\|screens\|connections\|kit\|check` |
| Bring-your-own UI framework adapters | `atelier design adapters list\|show\|scaffold` |
| The live "derive, don't generate" palette | `atelier design palette` / `design live` |

**Agents**
| Capability | Command |
|---|---|
| Author / install agents into `.claude/` | `atelier agent add\|install\|instruction` |
| Record durable learnings | `atelier agent learn` |

## Bring your own UI framework

UI discovery (apps, navigation, components) is driven by **framework adapters** — declarative specs atelier interprets, never code it runs. Common frameworks ship built in (Next.js, SvelteKit, Astro, Remix, Expo, Flutter, …). For anything else, your agent authors a small YAML adapter:

```bash
atelier design adapters scaffold compose --framework "Jetpack Compose"
# edit .atelier/ui-adapters/compose.yaml — detect / routes / components
atelier design apps        # now discovers Compose apps too
```

The unit of extension is **data, not code**, so the deterministic core stays AI-free. When a framework's structure is too dynamic for a declarative spec, the adapter declares `routes: none` and the ui-design agent reads it by hand.

## Install

Atelier is in alpha. Install from source:

```bash
git clone https://github.com/gilons/atelier.git
cd atelier
npm install
npm run build
cd packages/cli && npm link  # exposes `atelier` globally
```

```bash
atelier --version
atelier --help
```

Requirements: Node.js ≥ 20.

## Quick start

The fastest path: run `atelier` with no args in a directory near your code repos. It drops you into an interactive REPL.

```bash
cd ~/workspace/myorg     # your org directory (with api/, web/, etc. inside)
atelier
```

```
Atelier — a planning companion

  No workspace found at /Users/you/workspace/myorg
  Detected 4 git repo(s) in this directory (org: myorg)
    · api  · web  · marketing-site  · ops
  → Type /init to scaffold a workspace here.

atelier ❯
```

A typical first session:

```
atelier ❯ /init                         # creates ./planning/.atelier/
atelier ❯ /repo                          # multi-select with gh auto-discovery
atelier ❯ /source register notion --name "Company Notion"
atelier ❯ /doc add notion:<page-id> --title "Onboarding PRD"
atelier ❯ /feature add "User Onboarding" --code api:src/auth/
atelier ❯ /map                           # the navigable workspace index
atelier ❯ /agent install discovery       # render agents into .claude/
atelier ❯ /spec new "Add SSO" --type new-feature --feature user-onboarding
```

### Auto-register

Start `atelier` inside a code repo that sits next to a planning workspace and it offers to register the current repo:

```
  Workspace: MyOrg
  Location:  /Users/you/workspace/myorg/planning
  Inventory: 2 repo(s) · 3 source(s) · 8 feature(s) · 47 doc(s) · 12 ticket(s) · 5 design(s)

  · You're inside a git repo at api that isn't registered.
    Register it with workspace planning? (Y/n) y
✓ Registered api
```

Everything is also a one-shot command for scripts and CI (`atelier init --name "MyOrg"`, `atelier repo add ../api`, …).

## Architecture

- **`packages/core`** — deterministic logic: workspace IO, validation, project/UI inspection, the typed surfaces, the design engine, the agent authoring layer, the workspace index. No LLM calls, no network.
- **`packages/cli`** — the `atelier` binary: a nested-subcommand framework, ANSI-light UI, the interactive REPL, and the audio/recorder integration.

Everything important is version-controlled markdown / YAML under `.atelier/`:

```
.atelier/
├── workspace.yaml
├── sources.yaml          # connectors the agent drives
├── repos.yaml
├── discrepancies.yaml
├── features/             # one .md per feature
├── documentation/        # doc summaries + links, nested by source
├── tickets/              # tracker items, nested by source
├── designs/              # design artifacts, nested by discipline
├── sessions/             # recorded conversations + transcripts
├── stakeholders/         # people (shared profile.md + gitignored private.md)
├── agents/               # agent definitions atelier authors
├── ui-adapters/          # bring-your-own UI framework adapters
└── cache/                # gitignored
```

The planning workspace is committed alongside your code repos as `<org>/planning/`. (Workspaces created before the rename still load from a `.planning/` directory.)

## Status

Alpha. The deterministic spine — workspaces, repos, the typed surfaces (docs / tickets / designs), the feature map, the design engine, the agents layer, sessions/recording, and the workspace map — is in place. The synthesis work (classification, feature extraction, discrepancy detection) is delegated to the agent rather than built into atelier.

**~590 unit + integration tests** (343 core + 245 CLI) cover the surface today.

Contributions are welcome — open an issue or PR. See [HANDOFF.md](HANDOFF.md) for a deep architectural tour.

## License

[MIT](LICENSE)
