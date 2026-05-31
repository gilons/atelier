# Atelier

> Plan your product where your coding agent can act on it.

Your coding agent is great at writing code and terrible at remembering what your product *is* — how the pieces fit, what's been decided, what the last meeting changed. **Atelier is the memory and the map.**

It keeps a living, version-controlled picture of your product — across **code, docs, design, and conversations** — and hands your agent production-grade **specs** and a navigable **map** to work from. It **never calls an LLM itself**: your agent does the thinking; atelier keeps the facts straight, in plain git-tracked markdown. It works *with* the tools you already use (Notion, Jira, Figma, GitHub) — your agent reaches them; atelier just remembers the summary and the link.

## Install

```bash
npm install -g @gilons/atelier
```

A single, self-contained package — zero runtime dependencies. Node.js ≥ 20.

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

You now have slash commands — **`/atelier:discovery`**, `/atelier:system-design`, `/atelier:ui-design` — plus subagents Claude can delegate to. Run `/atelier:discovery` first; it maps your workspace and connects your docs / design / tickets. Re-run install any time; the `.claude/` files are regenerated from the canonical definitions.

### Codex, Cursor, Copilot, or any agent

Atelier is just a CLI, so any agent that can run a shell command can drive it. Point your agent at the workspace once — add this to your **`AGENTS.md`** (Codex), a Cursor rule, or your system prompt:

```
This project uses atelier for planning. Run `atelier map` to orient,
then `atelier agent show system-design` (or discovery / ui-design) for
the playbook before making changes.
```

The agent playbooks are plain markdown (`atelier agent show <id>`), so they drop straight into any tool's rules.

## What you get

- **A living product map** — features, docs, tickets, designs, and recorded conversations, cross-linked and committed in git next to your code.
- **Specs your agent can build from** — `atelier spec new "Add SSO"` scaffolds a planned change with context and a clean handoff prompt.
- **Agents that learn your codebase** — atelier authors them, renders them into your tool, and they sharpen over time as they record what they learn.
- **No lock-in, no black box** — every fact is readable markdown/YAML you can diff and review. Atelier holds no credentials and fetches nothing; your agent does the I/O.

## Develop from source

```bash
git clone https://github.com/gilons/atelier.git
cd atelier && npm install && npm run build
cd packages/cli && npm link   # exposes `atelier` globally
```

Contributions welcome — open an issue or PR. [HANDOFF.md](HANDOFF.md) is the deep architectural tour.

## Status

Alpha, and moving fast. License: [MIT](LICENSE).
