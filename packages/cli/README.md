# @gilons-ai/atelier

> Plan your product where your coding agent can act on it.

**[See how it works (the story, visualized) →](https://gilons.github.io/atelier/)**

Your coding agent is great at writing code and bad at remembering what your product actually is: how the pieces fit, what's been decided, what the last meeting changed. **Atelier is the memory and the map.** It keeps a living, version-controlled picture of your product across code, docs, design, and conversations, and hands your agent production-grade specs and a navigable map to work from.

It never calls an LLM itself. Your agent does the thinking; atelier keeps the facts straight, deterministically, in plain git-tracked markdown. It works with the tools you already use instead of replacing them.

## Install

```bash
npm install -g @gilons-ai/atelier
```

Single self-contained package, zero runtime dependencies. Node.js 20 or newer.

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

Start with `/atelier:discovery`. (Re-render any time with `atelier agent install --all`.)

### Codex, Cursor, Copilot, or any agent

Atelier is just a CLI, so any agent that can run a shell command can drive it. Point your agent at the workspace once. For example, add this to your `AGENTS.md` (Codex), a Cursor rule, or your system prompt:

```
This project uses atelier for planning. Run `atelier map` to orient,
then `atelier agent show system-design` (or discovery / ui-design) for
the playbook before making changes.
```

The agent playbooks are plain markdown (`atelier agent show <id>`), so they drop straight into any tool's rules.

## What you get

- **A living product map.** Features, docs, tickets, designs, and recorded conversations, cross-linked and kept in git next to your code.
- **Specs your agent can build from.** `atelier spec new "Add SSO"` scaffolds a change with context and a clean handoff prompt.
- **Agents that learn your codebase.** Atelier authors them, renders them into your tool, and they get sharper over time: each one proposes the patterns and standards it notices, and records them only with your sign-off, so you teach a convention once instead of every session.
- **No lock-in, no black box.** Every fact is readable markdown and YAML you can diff and review.
- **Multiple projects in one workspace.** Agencies and multi-product teams scope each client or product line into its own project (`atelier project add`, `atelier project use`), with shared sources and components kept global. Commands and agents scope to the active project plus global; `--project all` shows everything.

## Learn more

Full docs, examples, and contributing guide: <https://github.com/gilons/atelier>

## License

[MIT](https://github.com/gilons/atelier/blob/main/LICENSE)
