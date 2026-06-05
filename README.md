# Atelier

> Plan your product where your coding agent can act on it.

**[See how it works (the story, visualized) →](https://gilons.github.io/atelier/)**

Your coding agent is great at writing code and bad at remembering what your product actually is: how the pieces fit, what's been decided, what the last meeting changed. **Atelier is the memory and the map.**

It keeps a living, version-controlled picture of your product across **code, docs, design, and conversations**, and hands your agent production-grade **specs** and a navigable **map** to work from. It never calls an LLM itself: your agent does the thinking, while atelier keeps the facts straight in plain git-tracked markdown. It works with the tools you already use (Notion, Jira, Figma, GitHub). Your agent reaches them; atelier just remembers the summary and the link.

## Install

```bash
npm install -g @gilons-ai/atelier
```

A single, self-contained package with zero runtime dependencies. Node.js 20 or newer.

## Set it up with your coding agent

One command scaffolds the workspace and installs every agent:

```bash
cd ~/your-project                  # a repo, or an org folder with several repos inside
atelier init --name "My Product"   # workspace + all agents, version-controlled
```

### Claude Code

`atelier init` already rendered the agents into `.claude/`, so there's nothing else to run. You now have slash commands plus subagents Claude can delegate to, following the delivery pipeline:

- `/atelier:discovery` maps your workspace and connects your docs, design, and tickets.
- `/atelier:system-design` and `/atelier:ui-design` document the architecture and the UI.
- `/atelier:spec` writes grounded, right-sized specs for a feature or change (what's in, what's out, how you know it's done).
- `/atelier:planning` plans how to build each spec and the order to build them (approach, steps, tests, rollout, dependencies).

Run `/atelier:discovery` first. Re-render any time with `atelier agent install --all`; the `.claude/` files are regenerated from the canonical definitions.

### Codex, Cursor, Copilot, or any agent

Atelier is just a CLI, so any agent that can run a shell command can drive it. Point your agent at the workspace once. Add this to your `AGENTS.md` (Codex), a Cursor rule, or your system prompt:

```
This project uses atelier for planning. Run `atelier map` to orient,
then `atelier agent show system-design` (or discovery / ui-design) for
the playbook before making changes.
```

The agent playbooks are plain markdown (`atelier agent show <id>`), so they drop straight into any tool's rules.

## What you get

- **A living product map.** Features, docs, tickets, designs, and recorded conversations, cross-linked and committed in git next to your code.
- **Specs your agent can build from.** `atelier spec new "Add SSO"` scaffolds a planned change with context and a clean handoff prompt.
- **Agents that learn your codebase.** Atelier authors them, renders them into your tool, and they sharpen over time: each one proposes the patterns and standards it notices, and records them only with your sign-off, so you teach a convention once instead of every session.
- **No lock-in, no black box.** Every fact is readable markdown and YAML you can diff and review. Atelier holds no credentials and fetches nothing; your agent does the I/O.

## Multiple projects (agencies, product lines)

One workspace can hold several **projects**, each with its own sources, repos, features, designs, and specs. An agency running many clients, or a company with several product lines, keeps them in one place without mixing realities. Entries with no project are **global**: shared across all of them (a component library, internal people, house standards).

```bash
atelier project add "Acme Corp" --id acme   # register a project
atelier project use acme                     # pin it for this session (local, gitignored)
atelier feature add "Dashboard"              # new entries default into the active project
atelier feature add "Design tokens" --project global   # shared across every project
```

Commands and agents scope to the active project plus global by default. `--project <id>` peeks at another; `--project all` shows everything. `atelier map --project acme` renders just that client's world. The active project is pinned locally per developer, so teammates aren't forced into your context.

## Develop from source

```bash
git clone https://github.com/gilons/atelier.git
cd atelier && npm install && npm run build
cd packages/cli && npm link   # exposes `atelier` globally
```

## Status

Alpha, and moving fast. License: [MIT](LICENSE).
