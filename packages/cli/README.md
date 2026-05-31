# @gilons/atelier

> A planning companion for the spec-driven era.

Atelier is a CLI that sits at the **organization level** (not inside any one repo), maps your product across **code, docs, design, and conversations**, and hands production-grade specs off to whichever coding agent you already use (Claude Code, Codex, Copilot, Cursor, …).

It **never calls an LLM itself**. Deterministic work — git/project inspection, UI & route detection, the workspace map, validation — runs in plain code. Atelier indexes summaries + links; it never fetches source content or holds credentials. Your agent does the I/O and the judgment.

## Install

```bash
npm install -g @gilons/atelier
atelier --version
```

A single, self-contained package — no peer packages, zero runtime dependencies. Requires Node.js ≥ 20. (Optional macOS system-audio capture uses a bundled Swift helper; everything else is cross-platform.)

## Use it with your coding agent

Atelier is **agent-agnostic**: the deterministic CLI is the interface, so any coding agent that can run a shell command can drive it. Atelier *authors* its own agents (discovery, system-design, ui-design) as version-controlled markdown, and renders them into the formats your tool discovers.

**Claude Code** — first-class, auto-installed:

```bash
atelier agent install discovery        # writes .claude/commands/atelier/discovery.md
                                        #    +  .claude/agents/atelier-discovery.md
atelier agent install system-design
atelier agent install ui-design
```

You then get **slash commands** (`/atelier:discovery`, `/atelier:system-design`, …) and **subagents** Claude can delegate to — no extra config. Re-run any time; the `.claude/` files are regenerated from the canonical definitions in `.atelier/agents/`.

**Codex, Cursor, Copilot, and others** — point your agent at the workspace. The same agent instructions live as plain markdown at `.atelier/agents/<id>/instructions.md`, and every command is plain, scriptable CLI:

```bash
atelier map                       # the navigable index your agent reads first
atelier agent show system-design  # the full playbook for that agent, as markdown
```

Drop those instructions into your tool's rules/prompt (e.g. `AGENTS.md`, a Cursor rule, a Codex prompt) and it can run the same atelier-driven workflow. The agents also **improve over time** — `atelier agent learn <id> "…"` records durable learnings that fold back into the rendered instructions.

## Quick start

```bash
cd ~/workspace/myorg     # your org dir, with api/, web/, … inside
atelier                  # interactive REPL (or use one-shot subcommands)
```

```
atelier ❯ /init                         # scaffolds ./planning/.atelier/
atelier ❯ /repo                          # register repos (gh auto-discovery)
atelier ❯ /source register notion --name "Company Notion"
atelier ❯ /doc add notion:<page-id> --title "Onboarding PRD"
atelier ❯ /map                           # the navigable workspace index
atelier ❯ /agent install discovery       # render agents into .claude/
```

## What's inside

- **Typed surfaces** the agent indexes into: `feature`, `doc`, `ticket`, `design artifact`, `discrepancy`, `stakeholder`, `spec`.
- **The design engine**: disciplines (system-design / ui-design / custom), the live "derive, don't generate" palette, and deterministic UI discovery — `design apps | nav | screens | connections | kit | check`.
- **Bring-your-own UI framework**: declarative adapters (`design adapters scaffold`) teach atelier any framework — Next/SvelteKit/Flutter ship built in.
- **The agents layer**: atelier authors agents (`agent add | install | learn`) rendered into `.claude/` as slash commands + subagents that improve over time.
- **Sessions**: record/import conversations and see what they produced.

## Learn more

Full documentation, architecture, and contributing guide: <https://github.com/gilons/atelier>

## License

[MIT](https://github.com/gilons/atelier/blob/main/LICENSE)
