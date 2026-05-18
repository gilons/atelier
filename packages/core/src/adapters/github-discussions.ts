import { CliRunner, type SpawnLike } from "../cli-transport.js";
import { classifyDoc } from "../classify.js";
import {
  registerAdapter,
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
    // scope.repos may be empty for freshly-onboarded sources that
    // haven't tracked any discussions yet. Sync over such a source
    // is a no-op; the user adds discussions one URL at a time via
    // `/doc add <url>`, which appends to scope.repos and
    // scope.discussionIds. The old "at least one repo" guard
    // prevented this credentials-first onboarding flow.
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
    const repos = this.opts.scope.repos ?? [];
    for (const repo of repos) {
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
    // Onboarding is credentials-only now. The wizard's job is to
    // confirm `gh` is installed and authed; nothing else needs to
    // be configured up-front. Specific discussions land in
    // scope.discussionIds (and the parent repo in scope.repos)
    // later, one URL at a time, via `/doc add <url>`.
    //
    // Side benefits of going this minimal:
    //   - No GraphQL round-trip on onboarding (the old repo /
    //     discussion discovery pickers did one call per org).
    //   - No "pick from 50 unrelated repos" picker for users who
    //     just want to track a single thread.
    //   - The flow looks identical for a brand-new workspace and
    //     for re-onboarding to a different gh account.
    return [
      {
        key: "id",
        prompt: "Source id (slug)",
        default: "github-discussions",
        validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        auto: true,
      },
      {
        key: "name",
        prompt: "Display name",
        default: "GitHub Discussions",
        auto: true,
      },
    ];
  },
  async verify(_answers) {
    // The only thing to verify at this point is that `gh` is
    // installed and authed — exactly what an empty-scope adapter's
    // checkAvailability checks. No repos walked, no GraphQL
    // calls.
    try {
      const adapter = new GitHubDiscussionsAdapter({ scope: { repos: [] } });
      const a = await adapter.checkAvailability();
      if (!a.available) return { ok: false, error: a.reason };
      return {
        ok: true,
        message:
          "gh CLI is installed and authenticated. Add discussions with `/doc add <url>`.",
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  toRegistryEntry(answers) {
    const id = answers.values.id || "github-discussions";
    const name = answers.values.name || "GitHub Discussions";
    // Brand-new source starts with no repos / no pinned discussions.
    // `/doc add <discussion-url>` will populate both fields as the
    // user tracks individual threads.
    return {
      source: {
        id,
        kind: "github-discussions",
        name,
        transport: "cli",
        scope: { repos: [] },
      },
    };
  },
  merge(existing, _answers) {
    // Re-onboarding a github-discussions source is now a no-op as
    // far as scope is concerned — onboarding doesn't ask for any
    // scope details, so there's nothing to merge in. We return
    // the existing record verbatim; the user adds new discussions
    // via /doc add rather than re-running onboard.
    return {
      source: {
        id: existing.id,
        kind: "github-discussions",
        name: existing.name,
        transport: existing.transport ?? "cli",
        scope: existing.scope ?? { repos: [] },
      },
    };
  },
};

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
