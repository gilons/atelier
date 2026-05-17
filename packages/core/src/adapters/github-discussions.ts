import { CliRunner, type SpawnLike } from "../cli-transport.js";
import { classifyDoc } from "../classify.js";
import {
  registerAdapter,
  type OnboardingChoice,
  type OnboardingFlow,
  type OnboardingStep,
  type TransportOption,
} from "../onboarding.js";
import type {
  AdapterAvailability,
  FetchedDoc,
  RemoteDocMetadata,
  SourceAdapter,
} from "../source-adapters.js";
import type { Source } from "../types.js";

/**
 * GitHub Discussions adapter via the `gh` CLI.
 *
 * Why `gh` instead of direct REST/GraphQL?
 *   - `gh` already handles auth (the user is authed; we never see a
 *     token). The same code path that powers `atelier repo discover`.
 *   - GitHub Discussions are GraphQL-only on the public API. The
 *     `gh api graphql` subcommand makes that one shell call instead
 *     of carrying a GraphQL client.
 *   - Rate-limiting + retries are handled by `gh`. Less for us to
 *     redo.
 *
 * Scope shape:
 *   { repos: ["owner/name", "owner/name", …], categories?: ["Q&A", "Ideas"] }
 *
 * Discussions are indexed with `discussion` classification by default;
 * roadmap-labeled discussions get reclassified to `roadmap`.
 */

export interface GitHubDiscussionsOptions {
  scope: GitHubDiscussionsScope;
  /** Optional spawn override for tests — passes through to CliRunner. */
  spawnImpl?: SpawnLike;
}

export interface GitHubDiscussionsScope {
  /** List of `owner/name` repos to index. */
  repos: string[];
  /**
   * Optional category names (case-insensitive) to restrict to.
   * Common Q&A-style categories: `["Q&A", "Ideas", "General"]`.
   */
  categories?: string[];
  /** Hard cap on discussions per repo. Defaults to 200. */
  maxPerRepo?: number;
  /** Include closed discussions. Defaults to true. */
  includeClosed?: boolean;
  /**
   * Optional whitelist of specific discussion docIds (in the
   * `owner/name#number` form). When present, sync ignores
   * everything else even if it would normally match the scope.
   * Empty/undefined means "every discussion that matches the
   * other scope rules".
   */
  discussionIds?: string[];
}

interface DiscussionGraphQL {
  id: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  body: string;
  category: { name: string };
  author: { login: string } | null;
  labels?: { nodes: Array<{ name: string }> };
}

interface DiscussionsPage {
  repository: {
    discussions: {
      nodes: DiscussionGraphQL[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } | null;
  };
}

const DISCUSSIONS_QUERY = `
  query($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          url
          updatedAt
          body
          category { name }
          author { login }
          labels(first: 20) { nodes { name } }
        }
      }
    }
  }
`;

export class GitHubDiscussionsAdapter implements SourceAdapter {
  readonly kind = "github-discussions";
  private readonly runner: CliRunner;

  constructor(private readonly opts: GitHubDiscussionsOptions) {
    if (!opts.scope.repos || opts.scope.repos.length === 0) {
      throw new Error(
        "GitHubDiscussionsAdapter requires scope.repos with at least one `owner/name`."
      );
    }
    this.runner = new CliRunner({ command: "gh", spawnImpl: opts.spawnImpl });
  }

  async checkAvailability(): Promise<AdapterAvailability> {
    const probe = await this.runner.checkAvailable();
    if (!probe.available) return probe;
    // Also confirm gh is authed.
    try {
      await this.runner.run(["auth", "status"]);
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `gh CLI not authenticated (run \`gh auth login\`). Detail: ${(err as Error).message}`,
      };
    }
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const whitelist = this.opts.scope.discussionIds
      ? new Set(this.opts.scope.discussionIds)
      : null;
    const out: RemoteDocMetadata[] = [];
    for (const repo of this.opts.scope.repos) {
      const items = await this.listForRepo(repo);
      for (const d of items) {
        const docId = encodeDiscussionDocId(repo, d.number);
        if (whitelist && !whitelist.has(docId)) continue;
        out.push({
          docId,
          title: d.title,
          url: d.url,
          lastModified: d.updatedAt,
          classification: classifyDoc({
            kind: "github-discussions",
            title: d.title,
            labels: d.labels?.nodes?.map((l) => l.name) ?? [],
          }),
        });
      }
    }
    return out;
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    const { owner, name, number } = decodeDiscussionDocId(docId);
    // Pull the single discussion by number — cheaper than re-running
    // the list query.
    const result = await this.runGraphQL<{
      repository: { discussion: DiscussionGraphQL | null };
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
         repository(owner: $owner, name: $name) {
           discussion(number: $number) {
             id number title url updatedAt body
             category { name }
             author { login }
             labels(first: 20) { nodes { name } }
           }
         }
       }`,
      { owner, name, number }
    );
    const d = result.repository.discussion;
    if (!d) {
      throw new Error(
        `GitHub discussion ${owner}/${name}#${number} not found (or no access).`
      );
    }
    const body = renderDiscussionMarkdown(d, owner, name);
    return {
      docId,
      title: d.title,
      body,
      url: d.url,
      classification: classifyDoc({
        kind: "github-discussions",
        title: d.title,
        labels: d.labels?.nodes?.map((l) => l.name) ?? [],
        body,
      }),
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async listForRepo(repo: string): Promise<DiscussionGraphQL[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) {
      throw new Error(`scope.repos entry "${repo}" must be in the form "owner/name".`);
    }
    const max = this.opts.scope.maxPerRepo ?? 200;
    const categories = this.opts.scope.categories?.map((c) => c.toLowerCase());
    const collected: DiscussionGraphQL[] = [];
    let cursor: string | null = null;
    while (collected.length < max) {
      const page: DiscussionsPage = await this.runGraphQL<DiscussionsPage>(DISCUSSIONS_QUERY, {
        owner,
        name,
        first: Math.min(50, max - collected.length),
        after: cursor,
      });
      const discussions: DiscussionsPage["repository"]["discussions"] = page.repository.discussions;
      if (!discussions) break;
      for (const d of discussions.nodes) {
        if (categories && !categories.includes(d.category.name.toLowerCase())) {
          continue;
        }
        collected.push(d);
        if (collected.length >= max) break;
      }
      if (!discussions.pageInfo.hasNextPage || !discussions.pageInfo.endCursor) break;
      cursor = discussions.pageInfo.endCursor;
    }
    return collected;
  }

  private async runGraphQL<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    // `gh api graphql -f query=… -F var=value …` is the idiomatic shape;
    // for arbitrary JSON-typed values we pipe them in via stdin to avoid
    // shell-quote dramas. CliRunner doesn't support stdin yet, so we
    // build a single `--raw-field` chain and treat strings/numbers as
    // string args (gh coerces back).
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "number" || typeof v === "boolean") {
        // -F for typed (numeric/boolean) variables.
        args.push("-F", `${k}=${v}`);
      } else {
        args.push("-f", `${k}=${String(v)}`);
      }
    }
    const result = await this.runner.json<{ data?: T; errors?: Array<{ message: string }> }>(args);
    if (result.errors && result.errors.length > 0) {
      const msgs = result.errors.map((e) => e.message).join("; ");
      throw new Error(`GitHub GraphQL error: ${msgs}`);
    }
    if (!result.data) throw new Error("GitHub GraphQL returned no data.");
    return result.data;
  }
}

// ============================================================
// docId encoding
// ============================================================

/**
 * docId = `owner/name#number`. Round-trippable, human-readable, no
 * collisions across repos. The doc-map filename encoder takes care
 * of any disk-unsafe characters.
 */
function encodeDiscussionDocId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function decodeDiscussionDocId(docId: string): {
  owner: string;
  name: string;
  number: number;
} {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(docId);
  if (!m) {
    throw new Error(
      `Invalid GitHub discussion docId "${docId}" — expected "owner/name#number".`
    );
  }
  return { owner: m[1], name: m[2], number: parseInt(m[3], 10) };
}

// ============================================================
// Markdown rendering
// ============================================================

function renderDiscussionMarkdown(
  d: DiscussionGraphQL,
  owner: string,
  name: string
): string {
  const lines: string[] = [];
  lines.push(`# ${d.title}`);
  lines.push("");
  lines.push(
    `> ${owner}/${name} discussion #${d.number} · ${d.category.name}` +
      (d.author ? ` · by @${d.author.login}` : "")
  );
  if (d.labels && d.labels.nodes.length > 0) {
    lines.push(`> labels: ${d.labels.nodes.map((l) => l.name).join(", ")}`);
  }
  lines.push("");
  lines.push(d.body || "*(empty body)*");
  return lines.join("\n");
}

// ============================================================
// Onboarding flow + registration
// ============================================================

const githubDiscussionsOnboarding: OnboardingFlow = {
  kind: "github-discussions",
  displayName: "GitHub Discussions",
  description:
    "Atelier pulls GitHub Discussions via the `gh` CLI — it reuses your " +
    "existing auth, so there's no token to manage. Make sure `gh` is " +
    "installed and authenticated (`gh auth status`) before onboarding.",
  async availableTransports(): Promise<TransportOption[]> {
    return [
      {
        transport: "cli",
        label: "gh CLI (recommended)",
        ready: true,
        note: "Reuses your `gh auth status` credentials",
        recommended: true,
      },
    ];
  },
  steps(_transport): OnboardingStep[] {
    return [
      {
        key: "id",
        prompt: "Source id (slug)",
        default: "github-discussions",
        validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        // No need to ask — the slug is derived from the kind. User
        // can override with --answer id=… or edit sources.yaml later.
        auto: true,
      },
      {
        key: "name",
        prompt: "Display name",
        default: "GitHub Discussions",
        // Same reasoning — display name maps 1:1 to the adapter's
        // own displayName. Removing the Enter-through friction.
        auto: true,
      },
      {
        key: "repos",
        prompt: "Which repos should I pull discussions from?",
        help:
          "Atelier scanned your workspace orgs for repos with Discussions enabled. " +
          'Select one or more — or leave blank to type "owner/name" entries manually.',
        multiSelect: true,
        // The CLI shows a multi-select picker; the joined CSV must
        // still match the same regex as a manually-typed answer so
        // the rest of the pipeline (verify, toRegistryEntry) stays
        // unchanged.
        validate: /^[^,]+\/[^,]+(?:\s*,\s*[^,]+\/[^,]+)*$/,
        discoverChoices: async (ctx) =>
          discoverDiscussionRepos(ctx.orgs, {
            excludeRepos: collectLinkedRepos(ctx.existingSources),
          }),
      },
      {
        key: "discussionIds",
        prompt: "Which discussions should I sync? (leave empty for ALL in the chosen repos)",
        help:
          "Optional. Pick specific threads you care about, or skip this step (Enter without selecting anything) to sync every discussion in the repos you chose.",
        // `default: ""` signals to the CLI's empty-picker fallback
        // that no selection is fine — it stores the empty string
        // and moves on. (toRegistryEntry treats empty as "sync all".)
        default: "",
        multiSelect: true,
        // Skip the drill-down when the user typed repos manually
        // and we have no easy way to enumerate the discussions, OR
        // when no repos were chosen at all.
        applies: (answers) => parseRepoList(answers.values.repos).length > 0,
        discoverChoices: async (ctx, answers) =>
          listDiscussionsForRepos(parseRepoList(answers.values.repos), {
            excludeDocIds: collectLinkedDiscussionIds(ctx.existingSources),
          }),
      },
      {
        key: "categories",
        prompt:
          "Optional comma-separated category names to restrict to (leave blank for all — e.g. Ideas, Q&A)",
        default: "",
      },
      {
        key: "maxPerRepo",
        prompt: "Maximum discussions per repo (the most-recent N)",
        default: "200",
        validate: /^\d+$/,
      },
    ];
  },
  async verify(answers) {
    const repos = parseRepoList(answers.values.repos);
    if (repos.length === 0) {
      return { ok: false, error: "No repos provided." };
    }
    try {
      const adapter = new GitHubDiscussionsAdapter({
        scope: {
          repos,
          categories: parseCsv(answers.values.categories),
          maxPerRepo: 1,
        },
      });
      const a = await adapter.checkAvailability();
      if (!a.available) return { ok: false, error: a.reason };
      const docs = await adapter.listDocs();
      return {
        ok: true,
        message: `Connected. Most recent discussion(s): ${docs.length === 0 ? "(none in scope)" : docs.map((d) => d.title).slice(0, 3).join(", ")}`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  toRegistryEntry(answers) {
    const id = answers.values.id || "github-discussions";
    const name = answers.values.name || "GitHub Discussions";
    const repos = parseRepoList(answers.values.repos);
    const categories = parseCsv(answers.values.categories);
    const maxPerRepo = parseInt(answers.values.maxPerRepo || "200", 10);
    const discussionIds = parseRepoList(answers.values.discussionIds);
    const scope: Record<string, unknown> = { repos };
    if (categories.length > 0) scope.categories = categories;
    if (Number.isFinite(maxPerRepo) && maxPerRepo > 0) scope.maxPerRepo = maxPerRepo;
    // Only persist the docId whitelist when the user actually
    // narrowed it down. An empty/skipped step means "sync all" —
    // we leave it off so future discussions added in the repo
    // are picked up automatically.
    if (discussionIds.length > 0) scope.discussionIds = discussionIds;
    return {
      source: {
        id,
        kind: "github-discussions",
        name,
        transport: "cli",
        scope,
      },
    };
  },
  merge(existing, answers) {
    // Build the "new only" result the normal way, then fold its
    // scope into the existing entry. Union semantics for the list
    // fields, latest-value-wins for the scalar settings.
    const incoming = githubDiscussionsOnboarding.toRegistryEntry(answers);
    const inScope = (incoming.source.scope ?? {}) as Partial<GitHubDiscussionsScope>;
    const exScope = (existing.scope ?? {}) as Partial<GitHubDiscussionsScope>;

    const repos = unique([...(exScope.repos ?? []), ...(inScope.repos ?? [])]);

    // discussionIds rules:
    //   · If either side has no pin, the result has no pin
    //     ("sync everything in scope.repos"). A specific list on
    //     one side + sync-all on the other resolves to sync-all
    //     because sync-all is the broader subscription.
    //   · Otherwise union the pinned ids.
    const exPinned = exScope.discussionIds ?? [];
    const inPinned = inScope.discussionIds ?? [];
    const exFull = exScope.repos && exScope.repos.length > 0 && exPinned.length === 0;
    const inFull = inScope.repos && inScope.repos.length > 0 && inPinned.length === 0;
    let mergedDiscussionIds: string[] | undefined;
    if (exFull || inFull) {
      mergedDiscussionIds = undefined;
    } else {
      const u = unique([...exPinned, ...inPinned]);
      mergedDiscussionIds = u.length > 0 ? u : undefined;
    }

    const categories = unique([
      ...(exScope.categories ?? []),
      ...(inScope.categories ?? []),
    ]);
    // For the cap, take the larger value — the user is broadening,
    // not narrowing, with each merge.
    const maxPerRepo = Math.max(
      exScope.maxPerRepo ?? 0,
      inScope.maxPerRepo ?? 0
    );

    const scope: Record<string, unknown> = { repos };
    if (mergedDiscussionIds) scope.discussionIds = mergedDiscussionIds;
    if (categories.length > 0) scope.categories = categories;
    if (maxPerRepo > 0) scope.maxPerRepo = maxPerRepo;

    return {
      source: {
        id: existing.id,
        kind: "github-discussions",
        name: existing.name,
        transport: existing.transport ?? "cli",
        scope,
      },
    };
  },
};

function parseRepoList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ============================================================
// Exclusion helpers — derive "already-linked" sets from the
// workspace's existing sources so the onboarding picker doesn't
// re-offer items the user has already onboarded somewhere.
// ============================================================

/**
 * Repos *fully* covered by another github-discussions source —
 * those that subscribe to every discussion in the repo (no
 * `scope.discussionIds` pin). Hiding these from the repo picker
 * prevents the user from creating an exact-duplicate source.
 *
 * Repos that are only *partially* covered (the existing source
 * pinned specific discussion ids) are deliberately NOT excluded.
 * The user may want to onboard additional threads from the same
 * repo into a new source; the drill-down picker handles the
 * per-discussion deduping via `collectLinkedDiscussionIds`.
 */
function collectLinkedRepos(existingSources: Source[]): Set<string> {
  const out = new Set<string>();
  for (const s of existingSources) {
    if (s.kind !== "github-discussions") continue;
    const scope = (s.scope ?? {}) as Partial<GitHubDiscussionsScope>;
    // Partial coverage → leave the repo in the picker so the
    // user can pick more discussions from it.
    if (scope.discussionIds && scope.discussionIds.length > 0) continue;
    for (const repo of scope.repos ?? []) {
      out.add(repo);
    }
  }
  return out;
}

/**
 * Discussion docIds already linked by another source. Two paths:
 *
 *   1. An explicit pin: `scope.discussionIds` lists the docId.
 *   2. A blanket repo subscription: `scope.repos` contains the
 *      repo and `scope.discussionIds` is empty/undefined (means
 *      "sync every discussion in that repo"). For this case we
 *      can't enumerate the docIds upfront — the listing step will
 *      surface them at scan time. We return the explicit set
 *      only; the picker also filters by repo presence below.
 *
 * We track both so the drill-down picker hides what's already
 * covered, by repo or by pin.
 */
function collectLinkedDiscussionIds(existingSources: Source[]): Set<string> {
  const out = new Set<string>();
  for (const s of existingSources) {
    if (s.kind !== "github-discussions") continue;
    const scope = (s.scope ?? {}) as Partial<GitHubDiscussionsScope>;
    for (const docId of scope.discussionIds ?? []) {
      out.add(docId);
    }
  }
  return out;
}

// ============================================================
// Workspace-aware repo discovery (used by the onboarding wizard)
// ============================================================

/**
 * GraphQL response shape for the per-owner repo listing we run
 * below. We use `repositoryOwner` (matches both User and
 * Organization) instead of the `search` API because GitHub's
 * `has:discussions` search qualifier returns repos that *had*
 * discussions even when they're now disabled — unreliable. The
 * owner endpoint gives us authoritative `hasDiscussionsEnabled`.
 */
interface OwnerRepoNode {
  nameWithOwner: string;
  description: string | null;
  hasDiscussionsEnabled: boolean;
  discussions: { totalCount: number };
}

interface OwnerReposPage {
  repositoryOwner: {
    repositories: {
      totalCount: number;
      nodes: OwnerRepoNode[];
    };
  } | null;
}

const OWNER_REPOS_QUERY = `
  query($owner: String!, $first: Int!) {
    repositoryOwner(login: $owner) {
      repositories(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        nodes {
          nameWithOwner
          description
          hasDiscussionsEnabled
          discussions(first: 1) { totalCount }
        }
      }
    }
  }
`;

/**
 * For each org/user the workspace knows about, query GitHub for
 * repos that have Discussions enabled. Returns a flat list shaped
 * for the onboarding multi-select picker — labels are
 * `owner/name`, notes carry the discussion count + description.
 *
 * Returns an empty list when:
 *   - no orgs were discovered (caller should fall back to free-text)
 *   - `gh` isn't installed or isn't authed
 *   - the search returns no matches across all orgs
 *
 * Errors are swallowed (returning `[]`) rather than thrown: this is
 * a convenience for the wizard, not a hard requirement. If gh blows
 * up we want the user to fall through to manual entry, not see a
 * crash mid-onboarding.
 *
 * `excludeRepos` lets the wizard skip `owner/name` entries the user
 * already covered in another source — keeps the picker from
 * offering duplicates of work that's already onboarded.
 */
export async function discoverDiscussionRepos(
  orgs: string[],
  opts: { spawnImpl?: SpawnLike; perOrgLimit?: number; excludeRepos?: Set<string> } = {}
): Promise<OnboardingChoice[]> {
  if (orgs.length === 0) return [];
  const runner = new CliRunner({ command: "gh", spawnImpl: opts.spawnImpl });
  const probe = await runner.checkAvailable();
  if (!probe.available) return [];
  // Don't crash if the user isn't authed; just no choices.
  try {
    await runner.run(["auth", "status"]);
  } catch {
    return [];
  }

  const perOrgLimit = opts.perOrgLimit ?? 100;
  const excludeRepos = opts.excludeRepos ?? new Set<string>();
  const seen = new Set<string>();
  const out: OnboardingChoice[] = [];
  // `repositoryOwner` resolves to either a User or an Organization
  // and exposes a unified `repositories` connection. We filter
  // client-side on `hasDiscussionsEnabled` because GraphQL doesn't
  // expose it as a query filter. Note: when the login is a member
  // of multiple orgs, the connection may surface repos from those
  // related owners too — we keep them all and dedupe by
  // `nameWithOwner`, which is the right UX (the user gets a single
  // flat picker across everything they can see).
  for (const org of orgs) {
    try {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${OWNER_REPOS_QUERY}`,
        "-f",
        `owner=${org}`,
        "-F",
        `first=${perOrgLimit}`,
      ];
      const result = await runner.json<{ data?: OwnerReposPage; errors?: Array<{ message: string }> }>(args);
      if (result.errors && result.errors.length > 0) continue;
      const owner = result.data?.repositoryOwner;
      if (!owner) continue;
      for (const node of owner.repositories.nodes) {
        if (!node.hasDiscussionsEnabled) continue;
        if (seen.has(node.nameWithOwner)) continue;
        if (excludeRepos.has(node.nameWithOwner)) continue;
        seen.add(node.nameWithOwner);
        const count = node.discussions.totalCount;
        const desc = node.description?.trim();
        const note =
          (count > 0 ? `${count} discussion${count === 1 ? "" : "s"}` : "no discussions yet") +
          (desc ? ` · ${desc}` : "");
        out.push({
          label: node.nameWithOwner,
          value: node.nameWithOwner,
          note,
        });
      }
    } catch {
      // Per-org failure shouldn't sink the others.
      continue;
    }
  }
  return out;
}

// ============================================================
// Per-repo discussion listing (used by the drill-down step)
// ============================================================

const REPO_DISCUSSIONS_QUERY = `
  query($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      discussions(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          number
          title
          updatedAt
          category { name }
        }
      }
    }
  }
`;

interface RepoDiscussionsPage {
  repository: {
    discussions: {
      nodes: Array<{
        number: number;
        title: string;
        updatedAt: string;
        category: { name: string };
      }>;
    } | null;
  } | null;
}

/**
 * Given a list of `owner/name` repos, fetch the most-recent
 * discussions in each and return them as a flat picker list keyed
 * by docId (`owner/name#number`). The wizard uses this for the
 * "drill into specific discussions" step that follows the repo
 * multi-select.
 *
 * `perRepoLimit` defaults to 50 — large enough to cover most
 * active repos but bounded so we don't make the picker unusable.
 * Anyone with more discussions than that probably wants the
 * default ("sync everything") path anyway.
 *
 * `excludeDocIds` hides discussions already covered by another
 * registered source (either pinned via scope.discussionIds, or
 * fully covered by a scope.repos entry without an id filter).
 * Keeps the picker focused on net-new threads.
 */
export async function listDiscussionsForRepos(
  repos: string[],
  opts: { spawnImpl?: SpawnLike; perRepoLimit?: number; excludeDocIds?: Set<string> } = {}
): Promise<OnboardingChoice[]> {
  if (repos.length === 0) return [];
  const runner = new CliRunner({ command: "gh", spawnImpl: opts.spawnImpl });
  const probe = await runner.checkAvailable();
  if (!probe.available) return [];
  try {
    await runner.run(["auth", "status"]);
  } catch {
    return [];
  }
  const perRepoLimit = opts.perRepoLimit ?? 50;
  const excludeDocIds = opts.excludeDocIds ?? new Set<string>();
  const out: OnboardingChoice[] = [];
  for (const repo of repos) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) continue;
    try {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${REPO_DISCUSSIONS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `first=${perRepoLimit}`,
      ];
      const result = await runner.json<{ data?: RepoDiscussionsPage; errors?: Array<{ message: string }> }>(args);
      if (result.errors && result.errors.length > 0) continue;
      const repository = result.data?.repository;
      if (!repository || !repository.discussions) continue;
      for (const d of repository.discussions.nodes) {
        const docId = `${repo}#${d.number}`;
        if (excludeDocIds.has(docId)) continue;
        const updated = d.updatedAt.slice(0, 10); // YYYY-MM-DD
        out.push({
          label: `${repo}#${d.number}  ${d.title}`,
          value: docId,
          note: `${d.category.name} · updated ${updated}`,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function parseCsv(raw: string | undefined): string[] {
  return parseRepoList(raw);
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

registerAdapter({
  kind: "github-discussions",
  onboarding: githubDiscussionsOnboarding,
  async build(source: Source) {
    if (source.transport === "cli" || !source.transport) {
      const scope = (source.scope ?? {}) as unknown as GitHubDiscussionsScope;
      return new GitHubDiscussionsAdapter({ scope });
    }
    throw new Error(
      `GitHubDiscussionsAdapter.build: transport "${source.transport}" not handled by the gh-CLI adapter.`
    );
  },
});

export { githubDiscussionsOnboarding };
