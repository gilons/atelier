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
