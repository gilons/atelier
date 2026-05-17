# Atelier — Handoff

A planning companion for the spec-driven era. CLI tool, TypeScript on Node 22, one-time-license model, zero infrastructure, delegates all inference to the user's connected coding agent.

## Where things stand

**Phase 2.5 source onboarding extended to three sources.** Foundation + feature map + doc map + discrepancy log + sync engine + spec workflow + MCP stdio transport + a generalized source-onboarding architecture with three concrete officially-supported sources (Notion via REST, SharePoint via Microsoft Graph, GitHub Discussions via the `gh` CLI). **360 unit + integration tests, all passing.** End-to-end smoke-tested against real GitHub Discussions (pulled 5 discussions from `dinolabdev/dinorance` and indexed them with `discussion` classification).

**Project location:** `~/workspace/dino-lab/atelier/`

**Existing planning workspace (for the user's own dogfooding):** `~/workspace/dino-lab/planning/` — initialized, has all five `dinolabdev` repos registered.

## What ships today

| Slice | Status | Surface |
|-------|--------|---------|
| 1–4   | ✅ | `atelier init / repo add|list|remove|discover / source add|list|remove|enable|disable` |
| 5 — feature map | ✅ | `atelier feature add|list|show|remove` |
| 6 — doc map     | ✅ | `atelier doc add|list|show|update|remove` |
| 7 — discrepancy log | ✅ | `atelier discrepancy add|list|show|resolve|remove` |
| 8 — sync engine | ✅ for `local-folder`, `mcp`, `rest`, `cli` | `atelier sync` |
| 9 — spec workflow | ✅ | `atelier spec new|list|show|set-status|remove` |
| 2.5 — source onboarding | ✅ framework + Notion + SharePoint + GitHub Discussions | `atelier source onboard <kind>` |

The MCP stdio transport (`StdioMcpClient`) is now real. `MCP_TRANSPORT_READY = true`. Any MCP server you can spawn via stdio (Notion, Linear, custom) can be wired up via `~/.atelier/mcp-servers.json` and synced through `atelier sync`. The server needs to expose two tools — `atelier_list_docs` and `atelier_fetch_doc` — or override their names per-server in the config.

## Quick start

```bash
cd ~/workspace/dino-lab/atelier
npm install
npm run build
npm test            # 360/360 should pass

# Or run the CLI directly:
node packages/cli/dist/index.js --help
```

## End-to-end smoke flow that works today

```bash
cd ~/workspace/dino-lab/planning

# 1. Pick a folder of markdown to serve as a source
atelier source add local-folder --name "Internal Docs" \
  --scope-json '{"root":"../internal-docs"}'

# 2. Sync — discovers every .md and creates doc entries
atelier sync                          # +N created, ~0 updated, =0 unchanged

# 3. Catalog what the product does
atelier feature add "User Onboarding" --code coloyal-pulse:src/onboarding/

# 4. Plan a change
atelier spec new "Add SSO to onboarding" \
  --type new-feature \
  --feature user-onboarding \
  --doc internal-docs:onboarding-prd.md

# 5. Hand to your coding agent
cat .planning/issues/2026-05-16-add-sso-to-onboarding/prompt.md
```

## Architecture in one minute

```
packages/
├── core/                            # @atelier/core — deterministic logic, no AI
│   ├── src/
│   │   ├── types.ts                 # All persistent shapes (Source, RegisteredRepo, Feature, DocEntry, Discrepancy, SpecManifest)
│   │   ├── paths.ts                 # workspacePaths() — single source of truth for filenames
│   │   ├── yaml-io.ts               # thin wrapper around `yaml` lib
│   │   ├── front-matter.ts          # shared YAML-front-matter parser/serializer (features + docs)
│   │   ├── validation.ts            # hand-rolled validators (no zod/ajv — keeps deps minimal)
│   │   ├── workspace.ts             # initWorkspace, loadWorkspace
│   │   ├── workspace-finder.ts      # findWorkspaceRoot walks up for .planning/
│   │   ├── git.ts                   # parses .git/config directly (no git binary needed)
│   │   ├── repos.ts                 # addRepo/listRepos/removeRepo
│   │   ├── git-hosts.ts             # GitHostAdapter interface + GhAdapter (shells to `gh`)
│   │   ├── discovery.ts             # discoverRepos — diffs org repos vs registered
│   │   ├── sources.ts               # source registry
│   │   ├── features.ts              # feature map ops
│   │   ├── docs.ts                  # doc map ops (incl. filename encoding, content hashing)
│   │   ├── discrepancies.ts         # discrepancy log ops
│   │   ├── source-adapters.ts       # SourceAdapter interface
│   │   ├── local-folder-adapter.ts  # concrete adapter — walks markdown trees
│   │   ├── mcp-config.ts            # ~/.atelier/mcp-servers.json schema + loader
│   │   ├── mcp-adapter.ts           # MCP adapter (scaffolded — transport not yet wired)
│   │   ├── sync.ts                  # syncWorkspace — orchestrator
│   │   └── specs.ts                 # spec / issue folders, templates, context bundling
│   └── tests/                       # node --test, plain .js files (152 tests)
└── cli/                             # @atelier/cli — orchestration + UI only
    ├── src/
    │   ├── index.ts                 # bin entry
    │   ├── command.ts               # Command framework with nested subcommands + --help
    │   ├── ui.ts                    # ANSI helpers (dependency-free)
    │   └── commands/{init,repo,source,feature,doc,discrepancy,sync,spec}.ts
    └── tests/                       # CLI integration tests (120 tests)
```

## Artifact layout inside `.planning/`

```
.planning/
├── workspace.yaml                   # workspace metadata
├── sources.yaml                     # registered documentation sources
├── repos.yaml                       # registered code repos
├── discrepancies.yaml               # running discrepancy log (Slice 7)
├── features/                        # one md per feature (Slice 5)
│   └── csv-export.md
├── docs/                            # one md per indexed doc (Slice 6)
│   └── <source-id>/
│       └── <encoded-doc-id>.md
├── issues/                          # one folder per spec (Slice 9)
│   └── 2026-05-16-add-csv-export/
│       ├── README.md                # manifest + overview
│       ├── spec.md                  # adaptive template (per change type)
│       ├── context.md               # curated docs + code refs + features
│       └── prompt.md                # handoff prompt for the agent
├── ui/                              # reserved for Phase 3 (page graph)
└── cache/                           # gitignored local cache
```

## File shape — features

```markdown
---
id: csv-export
name: CSV Export
description: Export reports as CSV
status: planned                # planned | in-progress | shipped | deprecated
codeRefs:
  - repo: api                  # must exist in repos.yaml
    path: src/exports/
docRefs:
  - source: company-notion     # must exist in sources.yaml
    docId: page-abc-123
    title: "Export PRD"
createdAt: 2026-05-16T17:00:00.000Z
updatedAt: 2026-05-16T17:00:00.000Z
---

# CSV Export

Free-form prose preserved verbatim.
```

## File shape — docs

`.planning/docs/<source-id>/<encoded-doc-id>.md` — docIds are percent-encoded for filenames. Long ids get a hash-suffix. The body holds the fetched doc content; `contentHash` lets sync skip re-fetches when nothing changed.

```markdown
---
source: company-notion
docId: page-abc-123
title: Onboarding PRD
summary: Sign-up + first-run experience
classification: prd            # prd | rfc | design | runbook | policy | reference | meeting-notes | other
url: https://notion.so/...
lastFetched: 2026-05-16T12:00:00.000Z
contentHash: sha256:…
createdAt: 2026-05-16T11:00:00.000Z
updatedAt: 2026-05-16T12:00:00.000Z
---

# Onboarding PRD

The fetched body.
```

## File shape — discrepancies

`.planning/discrepancies.yaml`:

```yaml
version: 1
discrepancies:
  - id: auth-token-expiry
    feature: auth
    claim: Tokens last 24h
    observed: Tokens last 1h
    severity: high               # low | medium | high | critical
    status: open                 # open | acknowledged | resolved | wontfix
    docRef: { source: notion, docId: page-123 }
    codeRef: { repo: api, path: src/auth/ }
    notes: |
      Spotted during onboarding rewrite.
    createdAt: 2026-05-16T17:00:00.000Z
    updatedAt: 2026-05-16T17:00:00.000Z
```

## Source onboarding architecture (Phase 2.5)

The hard problem with sources is **bridging Atelier's expected shape to the source's native shape** while keeping onboarding painless. We landed on **source-kind as the primary abstraction, transport as a swappable secondary concern**, with a declarative `OnboardingFlow` per source kind that the CLI drives.

### Transport layer

Three reusable transports in core, each ~150 LOC of shared plumbing:

- **`McpClient` + `StdioMcpClient`** (existing) — JSON-RPC 2.0 stdio. Already used by `McpSourceAdapter`.
- **`HttpClient`** ([packages/core/src/http-transport.ts](packages/core/src/http-transport.ts)) — auth header injection, exponential backoff with `Retry-After` honoring, paginate-and-collect helper, JSON parse, `HttpError` with response body for diagnostics. `fetch` impl is injectable for tests.
- **`CliRunner`** ([packages/core/src/cli-transport.ts](packages/core/src/cli-transport.ts)) — subprocess spawn, stdout/stderr capture, JSON parse helper, `--version` probe for availability checks. `spawn` impl is injectable for tests.

### Adapter contract

Adapters compose transports and add source-specific knowledge:

```ts
// packages/core/src/source-adapters.ts (unchanged)
interface SourceAdapter {
  readonly kind: string;
  checkAvailability(): Promise<AdapterAvailability>;
  listDocs(): Promise<RemoteDocMetadata[]>;
  fetchDoc(docId: string): Promise<FetchedDoc>;
}
```

Each officially-supported adapter (only Notion ships today; Confluence/Drive/SharePoint to follow) registers itself at module load via `registerAdapter({kind, onboarding, build})`. The sync engine's factory resolves `Source → SourceAdapter` by dispatching on `(kind, transport)`:

```
(kind: "local-folder", *)          → LocalFolderAdapter
(*, transport: "mcp")              → McpSourceAdapter + StdioMcpClient
(*, transport: "rest" | "cli")     → built-in adapter from the registry
(*, transport: "external")         → dynamic import of adapter.adapterModule
```

### Onboarding flow contract

```ts
// packages/core/src/onboarding.ts
interface OnboardingFlow {
  kind: SourceKind | "external";
  displayName: string;
  description: string;
  availableTransports(): Promise<TransportOption[]>;  // auto-detect what's possible
  steps(transport: SourceTransport): OnboardingStep[]; // declarative questions
  verify(answers: OnboardingAnswers): Promise<VerifyResult>;
  toRegistryEntry(answers: OnboardingAnswers): OnboardingResult;
}
```

The flow is purely declarative — what to ask, how to validate, what to do with the answers. The CLI ([packages/cli/src/commands/source-onboard.ts](packages/cli/src/commands/source-onboard.ts)) drives prompts; tests construct `OnboardingAnswers` directly and call `verify` / `toRegistryEntry`.

### `atelier source onboard <kind>` — EAS-style UX

```
$ atelier source onboard notion

📚 Onboarding a Notion source

  Atelier connects to Notion using an Internal Integration Token. …

⠋ Detecting available transports…
  ✓ rest    Direct Notion API  (recommended)
  · mcp     Notion MCP server  (not configured)

? How would you like to connect? [1] Direct Notion API (recommended) ←

Configure
  Source id [notion]: company-notion
  Display name [Notion]: Company Notion
  Env var holding the token [NOTION_TOKEN]:
  Paste your Notion integration token: ********
  Only index pages whose title contains (optional):

⠋ Verifying connection…
  Found 47 page(s) the integration has access to.

📋 About to register
  id:            company-notion
  kind:          notion
  transport:     rest
  credentials:   $NOTION_TOKEN

Apply these changes? (Y/n): y

⠋ Writing sources.yaml…
✓ Source registered.

Next steps
  1. Add this to your shell rc:
       export NOTION_TOKEN='secret_xxx...'
  2. Try a sync:
       atelier sync --source company-notion --dry-run
       atelier sync --source company-notion
  3. Inspect what landed:
       atelier doc list --source company-notion
```

Polish details:
- **Spinners** during async work (transport detection, verification, writes); falls back to plain "·/✓" lines in non-TTY contexts.
- **Smart defaults** rendered as `[default]` in the prompt.
- **Secret masking** via raw-mode + `*` echo in TTY mode; falls back gracefully when stdin is piped.
- **Reentrant prompt session** — one readline interface for the whole flow, line-event-queue-based so it works with both TTY and piped stdin.
- **Verification step** — adapter actually probes the API before we save. Saves the user the surprise of "great, registered" → `atelier sync` "Skipped: 401."
- **Confirmation summary** before any disk write.
- **Next-steps block** with copy-pasteable commands.

### Non-interactive mode (CI / scripting)

```
atelier source onboard notion \
  --non-interactive --transport rest \
  --answer id=company-notion \
  --answer name="Company Notion" \
  --answer envVar=NOTION_TOKEN \
  --answer token=secret_xxx \
  --skip-verify   # optional, useful when CI doesn't have the token
```

Every question's `key` (from `OnboardingStep.key`) can be supplied via `--answer key=value`. Missing answers in non-interactive mode → exit 2 with a clear message naming the missing keys.

### Credential handling

`sources.yaml` never stores secrets. The Notion onboarding flow saves a `credentials: { envVar: "NOTION_TOKEN" }` reference and prints the user's token back in the "Next steps" block so they can add it to their shell rc themselves. We deliberately don't write `~/.zshrc` automatically — too easy to surprise a user, and shells differ.

### Third-party adapters (`external` transport)

A source with `transport: "external"` and `adapterModule: "@company/atelier-adapter-airtable"` loads the named module at sync time. The module must export a `build(source)` function returning a `SourceAdapter`. Power users install the adapter as an npm dep alongside Atelier and onboard with:

```
atelier source onboard --transport external --answer adapterModule=@company/atelier-adapter-airtable …
```

(Auto-discovery by package name convention is sketched in the code but not yet wired into `--list-kinds` — that's a small follow-up.)

### Three concrete adapters ship today

#### Notion ([packages/core/src/adapters/notion.ts](packages/core/src/adapters/notion.ts))

- **REST transport**, integration-token auth via `Authorization: Bearer …` + `Notion-Version: 2022-06-28`.
- **Search pagination** through `POST /v1/search` with `start_cursor` until `has_more: false`.
- **Title extraction** scans `properties` for the entry whose `type === "title"` (Notion's database items have a user-defined property name like "Name", not always `title`).
- **Block-to-markdown rendering** handles paragraphs, H1/H2/H3, bullets, numbered lists, to-do (checked + unchecked), toggles, quotes, callouts, code (with language), dividers, child-page placeholders. Media blocks become `<!-- video block omitted -->`-style placeholders so the user can see what's missing without losing structure. Nested blocks (sub-bullets, etc.) recurse up to depth 5.

The MCP variant of the Notion adapter is intentionally deferred — most Notion MCP servers expose `notion_search` / `notion_retrieve_page` shapes that don't map 1:1 to our adapter's expected `atelier_list_docs` / `atelier_fetch_doc`. Two ways to handle this when we do it: write a thin REST-equivalent translation inside the same `NotionAdapter` class, or document a small Atelier-bridge wrapper MCP server.

#### SharePoint ([packages/core/src/adapters/sharepoint.ts](packages/core/src/adapters/sharepoint.ts))

This is the adapter for "meeting transcripts + Word docs sitting in a SharePoint document library." Highlights:

- **Microsoft Graph REST** at `https://graph.microsoft.com/v1.0`. Auth via a bearer token in an env var. Token acquisition is delegated to the user — easiest path documented in the onboarding flow is `az login && az account get-access-token --resource https://graph.microsoft.com`. Programmatic `client_credentials` flow inside the adapter is a tracked follow-up.
- **Scope**: hostname + sitePath + (optional) drive name + (optional) folder path. The site resolver uses Graph's colon-syntax (`/sites/{hostname}:{path}:`) and caches the resolved site + drive ids per adapter instance.
- **Recursive folder walk** with `@odata.nextLink` pagination, filtering to a configurable extension allowlist (default: `docx, doc, txt, md, vtt, pdf`).
- **Content fetching**: `.vtt` and plain text fetched raw via `/content`; Word docs / PDFs / OneNote pages fetched via `/content?format=text/plain` (Graph does the conversion server-side, saving us from carrying a doc converter).
- **VTT post-processing** (`renderVttAsMarkdown`): strips WebVTT timestamps, pulls speakers out of `<v Name>…</v>` tags, merges consecutive cues from the same speaker, emits `**Alice:** Hi everyone. Today we'll talk about …` style markdown. Teams meeting transcripts come through this path.
- **Auto-classification**: filename `.vtt`/`.srt` → `transcript`; titles containing "meeting"/"standup"/"1:1" → `meeting-notes`; "roadmap"/"Q3 plan" → `roadmap`. Falls back to body inspection (first 500 chars for a `WEBVTT` header or speaker-timestamp fingerprint).

Not yet covered: OneNote section/page traversal (Graph treats those as `.one` files, which the plain-text endpoint actually handles fine), Excel/PowerPoint summarization (would need a different conversion path).

#### GitHub Discussions ([packages/core/src/adapters/github-discussions.ts](packages/core/src/adapters/github-discussions.ts))

This is the adapter for "the team's actual product thinking is buried in GitHub Discussions." First concrete CLI-transport adapter. Highlights:

- **`gh` CLI transport** — reuses the user's existing `gh auth status` credentials. No token to manage. Same auth path as `atelier repo discover`.
- **GraphQL via `gh api graphql`** — Discussions are GraphQL-only on GitHub's API; `gh api` is the cleanest invocation surface.
- **Scope**: list of `owner/name` repos + (optional) category filter + max-per-repo cap.
- **`docId` shape**: `owner/name#number` — round-trippable, human-readable, no collisions across repos.
- **Pagination** through GraphQL `pageInfo { hasNextPage endCursor }` until the cap or the end.
- **Rendering**: title as H1, then a blockquote citing repo / number / category / author / labels, then the discussion body verbatim. Body is already markdown so no conversion needed.
- **Auto-classification**: defaults to `discussion`; if any label matches `/roadmap/i`, reclassifies as `roadmap`. Note: classification ignores transcript-like title keywords because the source signal (it's a GitHub Discussion) is stronger than the title heuristic.

Smoke-tested against `dinolabdev/dinorance` discussions: real auth, real GraphQL, 5 discussions pulled and indexed.

### Classification ([packages/core/src/classify.ts](packages/core/src/classify.ts))

A small, pure heuristic module called by every adapter to seed `RemoteDocMetadata.classification`. Priority order:

1. **Source-kind defaults** — `github-discussions` → `discussion` (overridable to `roadmap` when a roadmap label is present).
2. **Filename extensions** — `.vtt` / `.srt` → `transcript`.
3. **Title regexes** — `transcript` / `meeting|standup|1:1` / `roadmap|Q[1-4] plan` / `prd` / `rfc` / `design` / `runbook|playbook|incident` / `policy|guideline`.
4. **Cheap body scan** (first 500 chars only) — `WEBVTT` header or `[hh:mm:ss] Name:` speaker-timestamp fingerprint → `transcript`.
5. Falls back to `undefined` — we deliberately don't claim `"other"` because that's an explicit user choice.

Existing classifications: `prd | rfc | design | runbook | policy | reference | meeting-notes | other`. **Added in this slice**: `transcript`, `discussion`, `roadmap`.

The synthesis layer in Phase 3 will refine these by asking the user's coding agent ("This doc is titled X, summary Y, first paragraph Z — what is it?"). The current heuristics are intentionally cheap and source-signal-driven so a sync of 1000+ docs doesn't cost an LLM call per doc.

## Slice 8 — sync engine details

**Source adapters live behind a single interface** ([packages/core/src/source-adapters.ts](packages/core/src/source-adapters.ts)):

```ts
interface SourceAdapter {
  readonly kind: string;
  checkAvailability(): Promise<AdapterAvailability>;
  listDocs(): Promise<RemoteDocMetadata[]>;
  fetchDoc(docId: string): Promise<FetchedDoc>;
}
```

**Two concrete adapters ship:**
- `LocalFolderAdapter` — walks a directory of `.md` files. The `scope.root` resolves against the workspace root, so `--scope-json '{"root":"../api/docs"}'` works the way `repo add ../api` does.
- `McpSourceAdapter` + `StdioMcpClient` — spawns a user-configured MCP server, completes the JSON-RPC 2.0 `initialize` handshake, calls `tools/call` for `atelier_list_docs` / `atelier_fetch_doc` (names overridable per server), unwraps `structuredContent` (with a fall-back to JSON-parsing the first text content block). Subprocess lifecycle, pending-request bookkeeping, server stderr capture (for diagnostics), and crash-mid-flight rejection are all handled.

**The sync engine itself** ([packages/core/src/sync.ts](packages/core/src/sync.ts)) is pure orchestration:
- For each enabled source, ask the factory for an adapter
- `listDocs()` from remote, diff against local doc map
- For new docs: `fetchDoc()` and `addDoc()`
- For changed docs (different contentHash): `fetchDoc()` and `updateDoc()`
- For orphans (local ∖ remote): preserve by default, delete with `--remove-orphans`
- Returns a `SyncReport` with per-source counts and a flat list of `SyncDocAction`s

**Wiring up a real MCP source.** Put a server definition in `~/.atelier/mcp-servers.json`:

```json
{
  "version": 1,
  "servers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@some-vendor/notion-mcp"],
      "env": { "NOTION_TOKEN": "secret_..." },
      "tools": {
        "list": "atelier_list_docs",
        "fetch": "atelier_fetch_doc"
      }
    }
  }
}
```

Then register the source: `atelier source add notion --name "Company Notion" --mcp notion` and run `atelier sync`.

**Server compatibility.** A server is Atelier-compatible if it exposes two tools that return the shapes in `McpListDocsResult` / `McpFetchDocResult` (`packages/core/src/mcp-adapter.ts`). Servers that wrap results in a text content block (instead of `structuredContent`) are supported too — the first text block is parsed as JSON. The test fixture at `packages/core/tests/fixtures/mcp-fake-server.mjs` is a 130-line reference implementation worth reading before writing your own.

## Slice 9 — spec workflow details

`atelier spec new "<title>" --type <type>` scaffolds `.planning/issues/<YYYY-MM-DD>-<slug>/` with four files:

- **`README.md`** — YAML front-matter manifest + overview pointing at the sibling files
- **`spec.md`** — adaptive template per `--type`: `new-feature` / `modification` / `ui` / `refactor` / `bug` / `integration`. Each template ships a fixed section set (e.g. bug → Symptom / Reproduce / Expected / Suspected cause / Acceptance criteria).
- **`context.md`** — curated bundle: pulled-in features with their refs, code refs resolved to absolute paths on this machine, doc refs annotated with summaries (or *not yet indexed* if the doc map doesn't know them).
- **`prompt.md`** — the handoff prompt the user feeds Claude Code (or any agent).

`--feature <id>` pulls a feature's codeRefs + docRefs into the bundle; `--code repo[:path]` and `--doc source:docId[:title]` add ad-hoc refs.

`updateSpec` rewrites the README's front-matter, leaving spec.md / context.md / prompt.md alone — those are owned by the user and the agent.

## Architectural principles (don't break these without thinking)

1. **Zero infrastructure.** No backend, no SaaS, no subscription. A binary you install.
2. **Agent-agnostic.** All inference goes to whichever agent the user has connected. Atelier itself never calls an LLM. Today the doc-map sync and spec workflow are entirely deterministic; "synthesis" (auto-classify docs, extract feature mentions from docs) is a Phase 3 layer that asks the user's agent.
3. **Code-first, AI for synthesis.** Every deterministic task (file ops, parsing, validation, sync diff, context bundling) is plain code.
4. **Org-level, not repo-level.** Atelier sits beside code repos, not inside one. `~/workspace/<org>/planning/` is the workspace; sibling repos register with relative paths like `../api`. Local-folder sources resolve their `scope.root` the same way.
5. **Everything important lives in version-controlled markdown/YAML.** `.planning/` is the artifact directory; committed alongside the planning repo. Cache (`.planning/cache/`) is gitignored.
6. **One-time license model.** No recurring API costs to absorb → no subscription needed.

## Bugs fixed during Phase 2

Three real issues turned up:

1. **`addRepo` symlink mismatch** (Phase-1 verification) — `os.tmpdir()` returns `/var/folders/...` but `process.cwd()` returns `/private/var/folders/...`, so registering an absolute path produced `../../../../../var/folders/...` instead of `../api`. Fixed in [packages/core/src/repos.ts](packages/core/src/repos.ts) by `realpath`-ing both sides before `path.relative`.
2. **Discovery URL mismatch** (Phase-1 verification) — `gh repo list --json url` returns HTTPS URLs *without* `.git`, but `.git/config` records it *with* the suffix. 5 already-registered repos showed as unregistered. Fixed with `normalizeRemoteUrl` in [packages/core/src/discovery.ts](packages/core/src/discovery.ts) — regression test added.
3. **Feature/doc front-matter round-trip** — initial parser kept a leading newline in the body; serializer added a blank line for readability. Fixed by treating one optional blank line after the closing `---` as part of the boundary, in [packages/core/src/front-matter.ts](packages/core/src/front-matter.ts) (extracted out of `features.ts` so docs reuse it).

## Open product decisions

- **Synthesis layer (Phase 3).** Today sync just records what the source says. The next slice is "ask the agent to classify each new doc and tag feature mentions." The protocol the planner uses to invoke the agent (stdin/stdout? MCP tool the planner registers? a `claude -p` shell-out?) is still undecided. Pick when you start the slice.
- **Discrepancy auto-detection (Phase 3).** Schema is in; detection is not. The classic shape is "scan code paths cited in doc refs, ask agent if claim matches observed behavior." Needs the synthesis layer first.
- **UI mapping (Phase 4).** Page graph + per-page layout extraction. Per-framework adapters (Next.js, React Router, Vue, SvelteKit). Reserved `.planning/ui/` directory already exists.
- **Transcript ingestion (Phase 5).** The audio + STT stuff we discussed; ship absolutely last.

## What's verified end-to-end

- `atelier init` — creates `.planning/` with correct structure (features/, docs/, issues/, ui/, cache/, discrepancies.yaml header)
- `atelier repo add/list/remove/discover` — works against real `.git/config` files + real `gh`
- HTTPS + SSH remote parsing, organization auto-detection
- `atelier source add/list/remove/enable/disable` — round-trips YAML
- `atelier feature add/list/show/remove` — front-matter round-trips losslessly; cross-validates repo/source refs
- `atelier doc add/list/show/update/remove` — filename-safe docId encoding; contentHash tracking
- `atelier discrepancy add/list/show/resolve/remove` — severity-ordered listing; append-notes semantics
- `atelier sync` — full create/update/unchanged/orphaned/removed flow against local-folder, MCP, REST, AND CLI sources; respects `--dry-run`, `--source <id>`, `--remove-orphans`, `--verbose`
- `atelier spec new/list/show/set-status/remove` — scaffolds the four-file folder, resolves feature refs into context, surfaces "not yet indexed" for missing doc refs
- **`StdioMcpClient`** — spawn subprocess, JSON-RPC 2.0 over stdio, `initialize` handshake, `tools/call` with `structuredContent` (or text-content fallback), error propagation, crash-during-call handling, subprocess cleanup
- **`HttpClient`** — auth headers, exponential backoff with `Retry-After`, pagination helper, mocked-fetch tested
- **`CliRunner`** — subprocess JSON helper, ENOENT-friendly availability probe
- **`atelier source onboard <kind>`** — EAS-style interactive flow with spinners, secret masking, confirmation summary, next-steps block; non-interactive mode via `--answer key=value`; piped-stdin tested
- **Notion REST adapter** — search pagination, block-to-markdown rendering, title extraction, classification inference
- **SharePoint Graph adapter** — site/drive resolution, recursive folder walk, plain-text content conversion for Office docs, `.vtt` transcript rendering (speakers + merged consecutive cues)
- **GitHub Discussions adapter** — uses the user's `gh auth`, GraphQL pagination, label-based roadmap reclassification
- **Classifier** — source-signal + filename + title + cheap-body heuristics, seeds `RemoteDocMetadata.classification` for every adapter
- Nested subcommand routing + `--help` at every level
- 360 unit + integration tests, including 11 that spawn a real MCP server subprocess via the test fixture
- Smoke-tested in `~/workspace/dino-lab/planning/` and `/tmp/` against the user's `dinolabdev` repos, a local-folder source, a real spawned MCP server, the Notion onboarding flow with piped stdin, AND real GitHub Discussions (5 discussions from `dinolabdev/dinorance` pulled live)

## Not yet verified

- **Notion adapter** is exercised by mocked-fetch tests but has not been talked to against a real `api.notion.com`. Shapes match the public docs (`Notion-Version: 2022-06-28`); first contact may still surface schema surprises (especially in less-common block types).
- **SharePoint adapter** is exercised by mocked-fetch tests but has not been talked to against a real `graph.microsoft.com`. The OAuth dance for getting a token is delegated to the user — `az account get-access-token --resource https://graph.microsoft.com` is the path documented in onboarding.
- **GitHub Discussions adapter** **HAS** been smoke-tested live against `dinolabdev/dinorance` and pulled 5 real discussions. Classification (everything came back as `discussion`) suggests the heuristic should grow — the German-language meeting-style discussions in this repo would benefit from per-content-pattern reclassification, which is exactly what Phase 3 synthesis is meant to do.
- `McpSourceAdapter` has only been talked to via the local test fixture — no real third-party MCP server has been wired up yet.

## Pickup checklist for the next agent

1. `npm test` — confirm the 360-test baseline.
2. Likely next moves, in priority order:
   - **Validate SharePoint adapter against real Graph** — `az login`, `az account get-access-token --resource https://graph.microsoft.com`, run `atelier source onboard sharepoint`. Use a tenant with Teams meeting transcripts in OneDrive/SharePoint to exercise the `.vtt` rendering path end-to-end.
   - **Validate Notion adapter against real `api.notion.com`** — set `NOTION_TOKEN`, run `atelier source onboard notion`, run `atelier sync`. Any schema surprises go straight into [packages/core/src/adapters/notion.ts](packages/core/src/adapters/notion.ts).
   - **Phase 3 synthesis** — auto-classify docs, extract feature mentions, populate discrepancy log. Open question to decide first: how does the planner invoke the user's coding agent (stdin/stdout? `claude -p` shell-out? MCP tool the planner registers back?). The classification gap in the live GitHub Discussions smoke test (everything labeled `discussion`, missing the meeting-notes character of some entries) is a concrete motivation.
   - **Confluence adapter** — fourth concrete REST adapter. Atlassian basic auth (email + API token). Same shape as Notion.
   - **GitHub roadmap items** — Projects v2 is GraphQL, would slot in alongside the discussions adapter (or as a `roadmap` adapter that pulls Projects v2). Issues-with-label is a cheaper alternative.
3. Lower-priority polish:
   - SharePoint `client_credentials` flow inside `HttpClient` so users don't need the Azure CLI.
   - Auto-discovery of `@*/atelier-adapter-*` packages so `--list-kinds` shows third-party adapters automatically.
   - A "Notion via MCP" path on the same `NotionAdapter` so users who already wire Notion through Claude Code can skip the integration-token setup.
   - Token refresh hook on `HttpClient.authHeaders` (it's already an async function, just need to wire it to a refresh callback).

## Conversation history

This codebase came out of a multi-session design + build effort:
- The full product design (org-level, sibling to repos, MCP-based source connections, agent-agnostic, code-first/AI-for-synthesis, one-time license)
- The "Atelier" name (Tessera → Primer → Atelier — picked for the "workshop where you plan before you build" metaphor)
- A 10-slide pitch deck at `~/workspace/dino-lab/atelier/Atelier.pptx` (from the original sandbox)
- This codebase: 272 tests, Phase 1 + Phase 2 complete, MCP transport pending
