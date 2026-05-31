# @gilons-ai/atelier

> Plan your product where your coding agent can act on it.

Your coding agent is great at writing code and bad at remembering what your product actually is: how the pieces fit, what's been decided, what the last meeting changed. **Atelier is the memory and the map.** It keeps a living, version-controlled picture of your product across code, docs, design, and conversations, and hands your agent production-grade specs and a navigable map to work from.

It never calls an LLM itself. Your agent does the thinking; atelier keeps the facts straight, deterministically, in plain git-tracked markdown. It works with the tools you already use instead of replacing them.

## Install

```bash
npm install -g @gilons-ai/atelier
```

Single self-contained package, zero runtime dependencies. Node.js 20 or newer.

## Set it up with your coding agent

```bash
cd ~/your-project        # a repo, or an org folder with several repos inside
atelier init             # scaffold the workspace (version-controlled)
```

### Claude Code

```bash
atelier agent install discovery
atelier agent install system-design
atelier agent install ui-design
```

That's it. In Claude Code you now have slash commands (`/atelier:discovery`, `/atelier:system-design`, `/atelier:ui-design`) plus subagents Claude can delegate to. Start with `/atelier:discovery`; it maps your workspace and connects your docs, design, and tickets.

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
- **Agents that learn your codebase.** Atelier authors them, renders them into your tool, and they get sharper over time.
- **No lock-in, no black box.** Every fact is readable markdown and YAML you can diff and review.

## Learn more

Full docs, examples, and contributing guide: <https://github.com/gilons/atelier>

## License

[MIT](https://github.com/gilons/atelier/blob/main/LICENSE)
