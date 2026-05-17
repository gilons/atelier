import {
  HttpClient,
  HttpError,
  resolveCredential,
  type FetchLike,
} from "../http-transport.js";
import { registerAdapter, type OnboardingFlow, type OnboardingStep, type TransportOption } from "../onboarding.js";
import type {
  AdapterAvailability,
  FetchedDoc,
  RemoteDocMetadata,
  SourceAdapter,
} from "../source-adapters.js";
import type { DocClassification, Source } from "../types.js";

/**
 * Notion adapter — REST transport using an integration token.
 *
 * Why REST as the first transport?
 *   - Simplest setup: one env var (`NOTION_TOKEN`), no subprocess
 *     wrangling, no MCP server config tax.
 *   - First-party Notion API. No third-party MCP server conventions
 *     to chase. Stable schema (`Notion-Version: 2022-06-28`).
 *
 * The MCP transport for Notion will plug into the same adapter shape
 * later; only the data-fetching half changes.
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";

export interface NotionAdapterOptions {
  /** The auth bearer token (the "Internal Integration Token"). */
  token: string;
  /** Optional fetch override for tests. */
  fetchImpl?: FetchLike;
  /** Optional scope filter — see {@link NotionScope}. */
  scope?: NotionScope;
  /** Override the API version header (rarely needed). */
  notionVersion?: string;
}

/**
 * What to include in the sync. Today: a simple substring filter on
 * the page title. Future work: workspace id, parent page tree, etc.
 */
export interface NotionScope {
  /**
   * Only include pages whose title contains this substring
   * (case-insensitive). Useful for narrowing to "docs/" or "PRD-"
   * sections of a large Notion workspace.
   */
  titleContains?: string;
  /**
   * Hard cap on number of pages to index. Defaults to 1000 — large
   * enough for any realistic product docs workspace.
   */
  maxPages?: number;
}

interface NotionRichText {
  plain_text?: string;
  type?: string;
}

interface NotionSearchPage {
  id: string;
  object: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
}

interface NotionSearchResponse {
  results: NotionSearchPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  // Per-type fields below. We only read .rich_text / .text / .checked
  // on the union member matching `type`, so this loose typing is fine.
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

export class NotionAdapter implements SourceAdapter {
  readonly kind = "notion";
  private readonly client: HttpClient;

  constructor(private readonly opts: NotionAdapterOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new Error(
        "NotionAdapter requires a token. Pass --token or set the env var pointed at by source.credentials.envVar."
      );
    }
    this.client = new HttpClient({
      baseUrl: NOTION_API_BASE,
      userAgent: "atelier",
      authHeaders: () => ({
        Authorization: `Bearer ${opts.token}`,
        "Notion-Version": opts.notionVersion ?? NOTION_API_VERSION,
      }),
      fetchImpl: opts.fetchImpl,
    });
  }

  async checkAvailability(): Promise<AdapterAvailability> {
    try {
      // `users/me` returns the bot user when the token is valid; cheap
      // and authenticated, so it doubles as an auth probe.
      await this.client.request({ path: "/users/me" });
      return { available: true };
    } catch (err) {
      const e = err as Error;
      if (e instanceof HttpError && e.status === 401) {
        return {
          available: false,
          reason: "Notion API rejected the token (401). Check the integration token is valid and shared with at least one page.",
        };
      }
      return { available: false, reason: e.message };
    }
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const max = this.opts.scope?.maxPages ?? 1000;
    const titleFilter = this.opts.scope?.titleContains?.toLowerCase();
    const collected: NotionSearchPage[] = [];
    let cursor: string | null = null;
    while (collected.length < max) {
      const body: Record<string, unknown> = {
        filter: { value: "page", property: "object" },
        page_size: Math.min(100, max - collected.length),
      };
      if (cursor) body.start_cursor = cursor;
      const resp = await this.client.request<NotionSearchResponse>({
        method: "POST",
        path: "/search",
        body,
      });
      for (const page of resp.results) {
        if (page.object !== "page") continue;
        const title = extractPageTitle(page) ?? "(Untitled)";
        if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
        collected.push(page);
        if (collected.length >= max) break;
      }
      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    return collected.map((p) => ({
      docId: p.id,
      title: extractPageTitle(p) ?? "(Untitled)",
      url: p.url,
      lastModified: p.last_edited_time,
      classification: inferClassification(extractPageTitle(p) ?? ""),
    }));
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    const page = await this.client.request<NotionSearchPage>({
      path: `/pages/${encodeURIComponent(docId)}`,
    });
    const title = extractPageTitle(page) ?? "(Untitled)";

    const blocks = await this.fetchAllBlocks(docId);
    const body = renderBlocksAsMarkdown(blocks, title);

    return {
      docId,
      title,
      body,
      url: page.url,
      classification: inferClassification(title),
    };
  }

  private async fetchAllBlocks(blockId: string, depth = 0): Promise<NotionBlock[]> {
    // Notion limits child-block recursion to a few levels in practice;
    // we cap depth to avoid pathological cycles.
    if (depth > 5) return [];
    const out: NotionBlock[] = [];
    let cursor: string | null = null;
    while (true) {
      const resp: NotionBlocksResponse = await this.client.request<NotionBlocksResponse>({
        path: `/blocks/${encodeURIComponent(blockId)}/children`,
        query: cursor ? { start_cursor: cursor } : undefined,
      });
      for (const b of resp.results) {
        out.push(b);
        if (b.has_children) {
          const children = await this.fetchAllBlocks(b.id, depth + 1);
          // Attach under a synthetic key so the renderer can indent.
          (b as Record<string, unknown>)._children = children;
        }
      }
      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    return out;
  }
}

// ============================================================
// Title extraction
// ============================================================

/**
 * Notion stores the title in whichever property has type === "title".
 * Database items have a user-defined property name (often "Name");
 * top-level pages have a `title` property. Find it dynamically rather
 * than guessing.
 */
function extractPageTitle(page: NotionSearchPage): string | null {
  if (!page.properties) return null;
  for (const prop of Object.values(page.properties)) {
    if (prop && prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? "").join("").trim() || null;
    }
  }
  return null;
}

/**
 * Best-effort classification from the page title. Used to seed the
 * doc map; the synthesis layer (Phase 3) will refine these.
 */
function inferClassification(title: string): DocClassification | undefined {
  const t = title.toLowerCase();
  if (t.includes("prd") || t.includes("product requirement")) return "prd";
  if (t.startsWith("rfc") || t.includes(" rfc ")) return "rfc";
  if (t.includes("design")) return "design";
  if (t.includes("runbook") || t.includes("incident")) return "runbook";
  if (t.includes("policy") || t.includes("guideline")) return "policy";
  return undefined;
}

// ============================================================
// Block → Markdown rendering
// ============================================================

function richTextToString(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((t) => (t && typeof t === "object" ? ((t as NotionRichText).plain_text ?? "") : ""))
    .join("");
}

/**
 * Render a flat list of Notion blocks as markdown. Handles the common
 * block types verbatim; unknown types are emitted as a placeholder
 * comment so the user can spot them in `atelier doc show`.
 */
function renderBlocksAsMarkdown(blocks: NotionBlock[], pageTitle: string): string {
  const lines: string[] = [`# ${pageTitle}`, ""];
  for (const b of blocks) {
    lines.push(...renderBlock(b, 0));
  }
  return lines.join("\n");
}

function renderBlock(b: NotionBlock, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const data = (b as Record<string, unknown>)[b.type] as Record<string, unknown> | undefined;
  const rt = data ? richTextToString(data.rich_text) : "";
  const out: string[] = [];

  switch (b.type) {
    case "paragraph":
      if (rt.trim()) out.push(pad + rt, "");
      else out.push("");
      break;
    case "heading_1":
      out.push(pad + "## " + rt, "");
      break;
    case "heading_2":
      out.push(pad + "### " + rt, "");
      break;
    case "heading_3":
      out.push(pad + "#### " + rt, "");
      break;
    case "bulleted_list_item":
      out.push(pad + "- " + rt);
      break;
    case "numbered_list_item":
      out.push(pad + "1. " + rt);
      break;
    case "to_do": {
      const checked = data && data.checked === true;
      out.push(pad + `- [${checked ? "x" : " "}] ` + rt);
      break;
    }
    case "toggle":
      out.push(pad + "<details><summary>" + rt + "</summary>", "");
      break;
    case "quote":
      out.push(pad + "> " + rt, "");
      break;
    case "callout":
      out.push(pad + "> " + rt, "");
      break;
    case "code": {
      const language = (data?.language as string | undefined) ?? "";
      out.push(pad + "```" + language);
      for (const line of rt.split("\n")) out.push(pad + line);
      out.push(pad + "```", "");
      break;
    }
    case "divider":
      out.push("---", "");
      break;
    case "child_page": {
      const child = (data?.title as string | undefined) ?? "(untitled child page)";
      out.push(pad + `- 📄 *${child}* (child page — not inlined)`);
      break;
    }
    case "image":
    case "video":
    case "file":
    case "pdf":
    case "embed":
      out.push(pad + `<!-- ${b.type} block omitted -->`);
      break;
    default:
      // Unknown block type — surface it without losing content.
      if (rt.trim()) out.push(pad + rt);
      else out.push(pad + `<!-- ${b.type} block -->`);
      break;
  }

  const children = (b as Record<string, unknown>)._children as
    | NotionBlock[]
    | undefined;
  if (children && children.length > 0) {
    for (const c of children) {
      out.push(...renderBlock(c, indent + 1));
    }
    if (b.type === "toggle") out.push(pad + "</details>", "");
  }
  return out;
}

// ============================================================
// Onboarding flow + registration
// ============================================================

const notionOnboarding: OnboardingFlow = {
  kind: "notion",
  displayName: "Notion",
  description:
    "Atelier connects to Notion using an Internal Integration Token. " +
    "Create one at https://www.notion.so/profile/integrations, then " +
    "share the pages/databases you want to index with that integration.",
  async availableTransports(): Promise<TransportOption[]> {
    return [
      {
        transport: "rest",
        label: "Direct Notion API (recommended)",
        ready: true,
        note: "Just needs an integration token from notion.so/profile/integrations",
        recommended: true,
      },
      {
        transport: "mcp",
        label: "Notion MCP server (if you already have one configured)",
        ready: false,
        note: "Set up a Notion MCP server in ~/.atelier/mcp-servers.json first",
      },
    ];
  },
  steps(transport) {
    if (transport === "rest") {
      const steps: OnboardingStep[] = [
        {
          key: "id",
          prompt: 'Source id (slug, e.g. "company-notion")',
          default: "notion",
          validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        },
        {
          key: "name",
          prompt: "Display name",
          default: "Notion",
        },
        {
          key: "envVar",
          prompt: "Env var holding the token",
          default: "NOTION_TOKEN",
          validate: /^[A-Z_][A-Z0-9_]*$/,
          help: "Atelier reads the token from this env var at sync time. The value is not stored in sources.yaml.",
        },
        {
          key: "token",
          prompt: "Paste your Notion integration token (will be exported, not stored)",
          secret: true,
          validate: /^secret_|^ntn_/,
          help: "Token is shown back to you at the end so you can add it to your shell rc.",
        },
        {
          key: "titleContains",
          prompt: "Optional: only index pages whose title contains (leave blank for all)",
          default: "",
        },
      ];
      return steps;
    }
    // MCP path — minimal, until a Notion MCP-server adapter ships.
    return [
      {
        key: "id",
        prompt: 'Source id (slug)',
        default: "notion",
        validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      },
      {
        key: "name",
        prompt: "Display name",
        default: "Notion",
      },
      {
        key: "mcpServer",
        prompt: "MCP server id (from ~/.atelier/mcp-servers.json)",
        validate: /^[a-z0-9_-]+$/i,
      },
    ];
  },
  async verify(answers) {
    if (answers.transport === "rest") {
      const token = answers.values.token;
      if (!token) return { ok: false, error: "No token provided" };
      try {
        const adapter = new NotionAdapter({ token });
        const a = await adapter.checkAvailability();
        if (!a.available) return { ok: false, error: a.reason };
        // Tiny probe: list one page so we can report a count.
        const docs = await adapter.listDocs();
        return {
          ok: true,
          message: `Found ${docs.length} page(s) the integration has access to.`,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    // MCP path is exercised by the existing MCP adapter pipeline.
    return { ok: true, message: "MCP transport — verification deferred to `atelier sync`." };
  },
  toRegistryEntry(answers) {
    const id = answers.values.id || "notion";
    const name = answers.values.name || "Notion";
    if (answers.transport === "rest") {
      const envVar = answers.values.envVar || "NOTION_TOKEN";
      const scope: Record<string, unknown> = {};
      if (answers.values.titleContains) scope.titleContains = answers.values.titleContains;
      return {
        source: {
          id,
          kind: "notion",
          name,
          transport: "rest",
          credentials: { envVar },
          scope: Object.keys(scope).length > 0 ? scope : undefined,
        },
        envVarsToSet: answers.values.token
          ? [
              {
                name: envVar,
                value: answers.values.token,
                description: "Notion integration token (do not commit)",
              },
            ]
          : undefined,
      };
    }
    return {
      source: {
        id,
        kind: "notion",
        name,
        transport: "mcp",
        mcpServer: answers.values.mcpServer,
      },
    };
  },
};

registerAdapter({
  kind: "notion",
  onboarding: notionOnboarding,
  async build(source: Source) {
    if (source.transport === "rest" || !source.transport) {
      const token = await resolveCredential(source.credentials, { sourceId: source.id });
      return new NotionAdapter({
        token,
        scope: (source.scope ?? {}) as NotionScope,
      });
    }
    // For non-rest transports we let the sync engine's other branches
    // handle it — but we shouldn't be called for those because the
    // factory dispatches before this point.
    throw new Error(
      `NotionAdapter.build: transport "${source.transport}" not handled by the REST adapter (the sync factory should have dispatched elsewhere).`
    );
  },
});

export { notionOnboarding };
