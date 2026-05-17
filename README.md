# Atelier

> A planning companion for the spec-driven era.

Atelier is a CLI tool that sits at the **organization level** (not inside any one repo), maps your product across **code, docs, and conversations**, and hands production-grade specs off to whichever coding agent you already use (Claude Code, Copilot, Codex, Cursor, …).

It never calls an LLM itself. Every deterministic task — git config parsing, doc indexing, sync, validation — runs in plain code. Inference is delegated to the agent you've already connected.

## What works today

| Capability | Command | Status |
|---|---|---|
| Initialize an org-level planning workspace | `atelier init` | ✅ |
| Register code repos that belong to this org | `atelier repo add`, `repo discover` | ✅ |
| Map features (with code + doc refs) | `atelier feature add\|list\|show\|remove` | ✅ |
| Map docs (with content + classification) | `atelier doc add\|list\|show\|update\|remove` | ✅ |
| Log doc-vs-code discrepancies | `atelier discrepancy add\|list\|resolve` | ✅ |
| Onboard a documentation source interactively | `atelier source onboard <kind>` | ✅ |
| Pull docs from registered sources | `atelier sync` | ✅ |
| Scaffold a spec folder for a planned change | `atelier spec new\|list\|show` | ✅ |

### Supported source kinds

| Kind | Transport | Auth | Status |
|---|---|---|---|
| `local-folder` | filesystem | — | ✅ |
| `notion` | Notion REST API | Integration token | ✅ |
| `sharepoint` | Microsoft Graph | Bearer token (az CLI) | ✅ |
| `github-discussions` | `gh` CLI + GraphQL | `gh auth` | ✅ |
| any kind | MCP stdio (JSON-RPC) | server-defined | ✅ |
| third-party adapter | `external` (npm module) | adapter-defined | ✅ |

Run `atelier source onboard --list-kinds` to see what's available on your install.

## Install

Atelier is in alpha. Install from source:

```bash
git clone https://github.com/gilons/atelier.git
cd atelier
npm install
npm run build
cd packages/cli && npm link  # exposes `atelier` globally
```

You should now have an `atelier` command:

```bash
atelier --version
atelier --help
```

Requirements: Node.js ≥ 20.

## Quick start

```bash
# 1. Set up the org-level planning workspace as a sibling to your code repos.
#    Convention: ~/workspace/<org>/planning/ sits next to ../api, ../web, …
mkdir -p ~/workspace/myorg/planning
cd ~/workspace/myorg/planning
atelier init --name "MyOrg"

# 2. Register your code repos.
atelier repo add ../api
atelier repo add ../web
atelier repo discover                 # finds repos in your GitHub org

# 3. Onboard a doc source. Walks you through transport, auth, scope.
atelier source onboard notion         # or: sharepoint, github-discussions

# 4. Pull docs.
atelier sync --dry-run                # preview
atelier sync                          # actually fetch

# 5. Catalog what your product does.
atelier feature add "User Onboarding" --code api:src/auth/ --code web:components/Auth/

# 6. Plan a change. Scaffolds .planning/issues/<id>/{README,spec,context,prompt}.md
atelier spec new "Add SSO to onboarding" \
  --type new-feature \
  --feature user-onboarding

# 7. Hand the prompt to your coding agent.
cat .planning/issues/2026-05-17-add-sso-to-onboarding/prompt.md
```

## Source onboarding

The `atelier source onboard <kind>` flow is the recommended way to add a source. It detects available transports, walks you through auth, verifies the connection live, and prints next-steps with copy-pasteable commands.

```
$ atelier source onboard notion

📚 Onboarding a Notion source

  Atelier connects to Notion using an Internal Integration Token. …

⠋ Detecting available transports…
  ✓ rest    Direct Notion API  (recommended)
  · mcp     Notion MCP server  (not configured)

? How would you like to connect? [1] Direct Notion API (recommended)
? Source id [notion]: company-notion
? Paste your Notion integration token: ********
⠋ Verifying connection…
  Found 47 page(s) the integration has access to.

📋 About to register
  id: company-notion · transport: rest · credentials: $NOTION_TOKEN

? Apply these changes? (Y/n): y
✓ Source registered.

Next steps
  1. export NOTION_TOKEN='secret_xxx…'
  2. atelier sync --source company-notion
```

Non-interactive (CI-friendly) mode:

```bash
atelier source onboard notion \
  --non-interactive --transport rest --skip-verify \
  --answer id=company-notion \
  --answer name="Company Notion" \
  --answer envVar=NOTION_TOKEN \
  --answer token=secret_xxx
```

## Architecture in one minute

- **`packages/core`** — deterministic logic. Workspace IO, validation, source adapters, sync engine, spec scaffolding. No LLM calls.
- **`packages/cli`** — `atelier` binary. Nested-subcommand framework, ANSI-light UI, interactive prompts.

Everything important is stored in version-controlled markdown / YAML under `.planning/`:

```
.planning/
├── workspace.yaml
├── sources.yaml
├── repos.yaml
├── discrepancies.yaml
├── features/         # one .md per feature
├── docs/             # one .md per indexed doc (nested by source)
├── issues/           # one folder per planned change
└── cache/            # gitignored
```

The planning workspace itself is committed alongside your code repos as `<org>/planning/`.

## Writing a custom source adapter

A source adapter is a TypeScript module that exports `{ build, onboarding }`:

```ts
import {
  registerAdapter,
  type SourceAdapter,
  type OnboardingFlow,
} from "@atelier/core";

const adapter: SourceAdapter = {
  kind: "my-source",
  async checkAvailability() { /* … */ },
  async listDocs() { /* … */ },
  async fetchDoc(docId: string) { /* … */ },
};

const onboarding: OnboardingFlow = {
  kind: "external",
  displayName: "My Source",
  description: "…",
  async availableTransports() { /* … */ },
  steps(transport) { /* … */ },
  async verify(answers) { /* … */ },
  toRegistryEntry(answers) { /* … */ },
};

export default { build: async () => adapter, onboarding };
```

Distribute as an npm package; users add it with `transport: external` and `adapterModule: "@you/atelier-adapter-…"`. See `packages/core/src/adapters/notion.ts` for a worked example.

## Status

Alpha. Phase 2 is shipped; Phase 3 (the synthesis layer — delegating classification, feature extraction, and discrepancy detection to the user's coding agent) is the next major slice.

**360 unit + integration tests** cover the surface today.

Contributions are welcome — please open an issue or PR. See [HANDOFF.md](HANDOFF.md) for a deep architectural tour.

## License

[MIT](LICENSE)
