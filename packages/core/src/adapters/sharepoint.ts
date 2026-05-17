import {
  HttpClient,
  HttpError,
  resolveCredential,
  type FetchLike,
} from "../http-transport.js";
import { classifyDoc } from "../classify.js";
import { registerAdapter, type OnboardingFlow, type OnboardingStep, type TransportOption } from "../onboarding.js";
import type {
  AdapterAvailability,
  FetchedDoc,
  RemoteDocMetadata,
  SourceAdapter,
} from "../source-adapters.js";
import type { Source } from "../types.js";

/**
 * SharePoint / OneDrive adapter via Microsoft Graph.
 *
 * Why ship this early? A lot of teams (the user's included) keep
 * their working knowledge as Teams meeting transcripts, Word docs,
 * and OneNote pages — all of which live in SharePoint document
 * libraries. Indexing them surfaces context that would otherwise
 * stay buried.
 *
 * Auth: a bearer access token for `https://graph.microsoft.com/.default`.
 * The user manages the OAuth dance externally (the Azure-CLI route is
 * simplest: `az account get-access-token --resource https://graph.microsoft.com`)
 * and exposes the result via env var. This keeps the adapter small
 * and avoids carrying OAuth state for v1. A `client_credentials`
 * flow inside the adapter is a planned follow-up.
 *
 * Content fetching: Graph's `?format=text/plain` content endpoint
 * returns plain text for Word docs, OneNote pages, and PDFs — saves
 * us from shelling out to a doc converter. Plain-text files
 * (.vtt, .md, .txt) are fetched raw. .vtt transcripts get a tiny
 * post-processor that strips timestamps and concatenates speakers.
 */

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

export interface SharePointAdapterOptions {
  /** Bearer access token for Microsoft Graph. */
  token: string;
  /** Site identifier — see {@link SharePointScope}. */
  scope: SharePointScope;
  /** Optional fetch override for tests. */
  fetchImpl?: FetchLike;
}

export interface SharePointScope {
  /**
   * SharePoint hostname (e.g. `contoso.sharepoint.com`). Required —
   * Graph addresses sites by hostname plus path.
   */
  hostname: string;
  /**
   * Site path within the hostname, with leading slash (e.g.
   * `/sites/marketing`). Use `/` for the root site.
   */
  sitePath: string;
  /**
   * Optional drive (document library) name within the site.
   * When omitted, the site's default drive is used.
   */
  driveName?: string;
  /**
   * Optional folder path inside the drive (e.g. `/Recordings`).
   * When omitted, the drive root is the indexing starting point.
   */
  folderPath?: string;
  /**
   * Recurse into subfolders. Defaults to true. Set false when you
   * want to index just one folder's children.
   */
  recursive?: boolean;
  /** Hard cap on items to index. Defaults to 1000. */
  maxItems?: number;
  /**
   * File extensions to include (without the leading dot).
   * Defaults to: docx, doc, txt, md, vtt, pdf. Office files use
   * Graph's plain-text conversion; .vtt is post-processed.
   */
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = ["docx", "doc", "txt", "md", "vtt", "pdf"];

interface GraphSite {
  id: string;
  displayName?: string;
  webUrl?: string;
}

interface GraphDrive {
  id: string;
  name?: string;
  driveType?: string;
}

interface GraphItem {
  id: string;
  name: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  size?: number;
  parentReference?: { path?: string };
  file?: { mimeType?: string };
  folder?: { childCount?: number };
}

interface GraphList<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export class SharePointAdapter implements SourceAdapter {
  readonly kind = "sharepoint";
  private readonly client: HttpClient;
  private cachedSiteId: string | null = null;
  private cachedDriveId: string | null = null;

  constructor(private readonly opts: SharePointAdapterOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new Error(
        "SharePointAdapter requires a token. Pass --token or set the env var pointed at by source.credentials.envVar."
      );
    }
    if (!opts.scope.hostname || !opts.scope.sitePath) {
      throw new Error(
        "SharePointAdapter requires scope.hostname and scope.sitePath (e.g. {hostname: 'contoso.sharepoint.com', sitePath: '/sites/marketing'})."
      );
    }
    this.client = new HttpClient({
      baseUrl: GRAPH_API_BASE,
      userAgent: "atelier",
      authHeaders: () => ({ Authorization: `Bearer ${opts.token}` }),
      fetchImpl: opts.fetchImpl,
    });
  }

  async checkAvailability(): Promise<AdapterAvailability> {
    try {
      await this.resolveSiteId();
      return { available: true };
    } catch (err) {
      const e = err as Error;
      if (e instanceof HttpError && e.status === 401) {
        return {
          available: false,
          reason: "Graph rejected the token (401). It may have expired — get a fresh one via `az account get-access-token --resource https://graph.microsoft.com`.",
        };
      }
      if (e instanceof HttpError && e.status === 404) {
        return {
          available: false,
          reason: `SharePoint site not found at ${this.opts.scope.hostname}${this.opts.scope.sitePath}. Check the hostname and site path.`,
        };
      }
      return { available: false, reason: e.message };
    }
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const driveId = await this.resolveDriveId();
    const exts = (this.opts.scope.extensions ?? DEFAULT_EXTENSIONS).map((e) =>
      e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase()
    );
    const max = this.opts.scope.maxItems ?? 1000;
    const recursive = this.opts.scope.recursive ?? true;

    const startPath = this.opts.scope.folderPath ?? "";
    const collected: { item: GraphItem; parentPath: string }[] = [];

    const queue: string[] = [normalizeFolderPath(startPath)];
    while (queue.length > 0 && collected.length < max) {
      const path = queue.shift()!;
      const items = await this.listChildren(driveId, path);
      for (const item of items) {
        if (collected.length >= max) break;
        if (item.folder) {
          if (recursive) {
            queue.push(joinDrivePath(path, item.name));
          }
          continue;
        }
        if (!item.file) continue;
        const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
        if (!exts.includes(ext)) continue;
        collected.push({ item, parentPath: path });
      }
    }

    return collected.map(({ item, parentPath }) => ({
      docId: item.id,
      title: stripExtension(item.name),
      url: item.webUrl,
      lastModified: item.lastModifiedDateTime,
      classification: classifyDoc({
        kind: "sharepoint",
        title: item.name,
        filename: item.name,
      }),
      // Stash the relative path on the metadata for the renderer.
      // It's not part of the contract but adapters can attach arbitrary
      // extra fields; downstream code reads only the canonical ones.
      summary: parentPath ? `In: ${parentPath}` : undefined,
    }));
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    const driveId = await this.resolveDriveId();
    // Fetch metadata first so we have title/url.
    const meta = await this.client.request<GraphItem>({
      path: `/drives/${driveId}/items/${docId}`,
    });
    const ext = meta.name.split(".").pop()?.toLowerCase() ?? "";

    let body: string;
    if (ext === "vtt") {
      const raw = await this.fetchRawText(driveId, docId);
      body = renderVttAsMarkdown(raw, meta.name);
    } else if (ext === "md" || ext === "txt") {
      body = await this.fetchRawText(driveId, docId);
    } else {
      // Word docs, PDFs, etc. — ask Graph to convert to plain text.
      body = await this.fetchAsPlainText(driveId, docId);
    }

    return {
      docId,
      title: stripExtension(meta.name),
      body,
      url: meta.webUrl,
      classification: classifyDoc({
        kind: "sharepoint",
        title: meta.name,
        filename: meta.name,
        body,
      }),
    };
  }

  // ============================================================
  // Graph plumbing
  // ============================================================

  private async resolveSiteId(): Promise<string> {
    if (this.cachedSiteId) return this.cachedSiteId;
    // Graph addresses sites by `{hostname}:{path}:` (the trailing colon
    // ends the colon-syntax segment). Path with leading slash is fine.
    const cleanPath = this.opts.scope.sitePath.startsWith("/")
      ? this.opts.scope.sitePath
      : `/${this.opts.scope.sitePath}`;
    const idPath = `/sites/${this.opts.scope.hostname}:${cleanPath}`;
    const site = await this.client.request<GraphSite>({ path: idPath });
    this.cachedSiteId = site.id;
    return site.id;
  }

  private async resolveDriveId(): Promise<string> {
    if (this.cachedDriveId) return this.cachedDriveId;
    const siteId = await this.resolveSiteId();
    if (!this.opts.scope.driveName) {
      // Default drive is the site's primary document library.
      const drive = await this.client.request<GraphDrive>({
        path: `/sites/${siteId}/drive`,
      });
      this.cachedDriveId = drive.id;
      return drive.id;
    }
    const drives = await this.client.request<GraphList<GraphDrive>>({
      path: `/sites/${siteId}/drives`,
    });
    const match = drives.value.find((d) => d.name === this.opts.scope.driveName);
    if (!match) {
      throw new Error(
        `SharePoint drive "${this.opts.scope.driveName}" not found on site ${this.opts.scope.hostname}${this.opts.scope.sitePath}. Available: ${drives.value.map((d) => d.name).join(", ")}`
      );
    }
    this.cachedDriveId = match.id;
    return match.id;
  }

  private async listChildren(driveId: string, folderPath: string): Promise<GraphItem[]> {
    // Graph addresses items by path with `:` syntax. Root is `/root`,
    // a subfolder is `/root:/Recordings:`.
    const itemPath = folderPath === ""
      ? `/drives/${driveId}/root/children`
      : `/drives/${driveId}/root:${folderPath}:/children`;
    const items: GraphItem[] = [];
    let nextPath: string | undefined = itemPath;
    let safety = 0;
    while (nextPath && safety < 50) {
      safety++;
      const resp: GraphList<GraphItem> = await this.client.request<GraphList<GraphItem>>({
        path: nextPath,
      });
      items.push(...resp.value);
      if (resp["@odata.nextLink"]) {
        // `@odata.nextLink` is a full URL. Strip the base since our
        // HttpClient prepends it.
        const url = resp["@odata.nextLink"];
        nextPath = url.startsWith(GRAPH_API_BASE) ? url.slice(GRAPH_API_BASE.length) : url;
      } else {
        nextPath = undefined;
      }
    }
    return items;
  }

  private async fetchRawText(driveId: string, itemId: string): Promise<string> {
    const url = `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/content`;
    const fetchImpl = (this.opts.fetchImpl ?? (globalThis.fetch as FetchLike));
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      // Graph redirects content requests; let fetch follow them.
      redirect: "follow",
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpError(response.status, response.statusText, url, text);
    }
    return await response.text();
  }

  private async fetchAsPlainText(driveId: string, itemId: string): Promise<string> {
    const url = `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/content?format=text/plain`;
    const fetchImpl = (this.opts.fetchImpl ?? (globalThis.fetch as FetchLike));
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      redirect: "follow",
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpError(response.status, response.statusText, url, text);
    }
    return await response.text();
  }
}

// ============================================================
// .vtt → markdown rendering
// ============================================================

/**
 * Render a WebVTT transcript as a readable markdown chunk.
 *
 * Teams transcripts look like:
 *   WEBVTT
 *
 *   00:00:01.000 --> 00:00:04.000
 *   <v Alice>Hi everyone, thanks for joining.</v>
 *
 *   00:00:05.000 --> 00:00:09.000
 *   <v Bob>Great to be here.</v>
 *
 * We strip the timestamps, pull the speaker from `<v Name>` tags,
 * and concatenate consecutive lines from the same speaker. The
 * result is much friendlier to read (and to feed to an agent).
 */
export function renderVttAsMarkdown(vtt: string, sourceName: string): string {
  const lines = vtt.split(/\r?\n/);
  const blocks: Array<{ speaker: string; text: string }> = [];
  let i = 0;
  // Skip the WEBVTT header and any metadata lines.
  while (i < lines.length && !/^\d{1,2}:\d{2}/.test(lines[i])) i++;

  while (i < lines.length) {
    // Skip blank lines.
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    // Skip the timestamp line if present.
    if (/-->/.test(lines[i])) i++;
    // Cue may have an id line before the timestamp — handle that too.
    while (i < lines.length && /-->/.test(lines[i])) i++;
    // Collect text lines until the next blank.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length === 0) continue;
    const joined = buf.join(" ").trim();
    const m = /^<v\s+([^>]+)>([\s\S]*?)<\/v>$/i.exec(joined) ?? /^<v\s+([^>]+)>([\s\S]*)$/i.exec(joined);
    if (m) {
      blocks.push({ speaker: m[1].trim(), text: stripVttTags(m[2]).trim() });
    } else {
      blocks.push({ speaker: "Speaker", text: stripVttTags(joined).trim() });
    }
  }

  // Merge consecutive blocks from the same speaker.
  const merged: typeof blocks = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === b.speaker) {
      last.text += " " + b.text;
    } else {
      merged.push({ ...b });
    }
  }

  const out: string[] = [`# ${stripExtension(sourceName)}`, ""];
  for (const b of merged) {
    out.push(`**${b.speaker}:** ${b.text}`);
    out.push("");
  }
  return out.join("\n");
}

function stripVttTags(s: string): string {
  return s.replace(/<\/?[a-z][^>]*>/gi, "");
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function normalizeFolderPath(p: string): string {
  if (!p) return "";
  let out = p.startsWith("/") ? p : `/${p}`;
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function joinDrivePath(parent: string, name: string): string {
  if (parent === "") return `/${name}`;
  return `${parent}/${name}`;
}

// ============================================================
// Onboarding flow + registration
// ============================================================

const sharepointOnboarding: OnboardingFlow = {
  kind: "sharepoint",
  displayName: "SharePoint / OneDrive (Microsoft Graph)",
  description:
    "Atelier indexes SharePoint document libraries via Microsoft Graph. " +
    "You need a bearer access token for `https://graph.microsoft.com/.default`. " +
    "The simplest way to get one for testing is the Azure CLI:\n\n" +
    "  az login\n" +
    "  az account get-access-token --resource https://graph.microsoft.com\n\n" +
    "(That gives you a delegated token tied to your account. Production " +
    "deployments should use an Azure AD app + client_credentials flow — " +
    "a follow-up on the adapter.)",
  async availableTransports(): Promise<TransportOption[]> {
    return [
      {
        transport: "rest",
        label: "Microsoft Graph REST (recommended)",
        ready: true,
        note: "Needs a bearer token in an env var",
        recommended: true,
      },
      {
        transport: "mcp",
        label: "Microsoft Graph MCP server (if you already have one configured)",
        ready: false,
        note: "Wire it up in ~/.atelier/mcp-servers.json first",
      },
    ];
  },
  steps(transport) {
    if (transport === "mcp") {
      return [
        {
          key: "id",
          prompt: "Source id (slug)",
          default: "sharepoint",
          validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        },
        { key: "name", prompt: "Display name", default: "SharePoint" },
        {
          key: "mcpServer",
          prompt: "MCP server id (from ~/.atelier/mcp-servers.json)",
          validate: /^[a-z0-9_-]+$/i,
        },
      ];
    }
    return [
      {
        key: "id",
        prompt: "Source id (slug)",
        default: "sharepoint",
        validate: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      },
      { key: "name", prompt: "Display name", default: "SharePoint" },
      {
        key: "hostname",
        prompt: "SharePoint hostname (e.g. contoso.sharepoint.com)",
        validate: /^[a-z0-9.-]+\.[a-z]{2,}$/i,
      },
      {
        key: "sitePath",
        prompt: "Site path (e.g. /sites/marketing — or / for the root site)",
        default: "/",
        validate: /^\/.*$/,
      },
      {
        key: "driveName",
        prompt: "Drive name (leave blank for the default document library)",
        default: "",
      },
      {
        key: "folderPath",
        prompt: "Folder path inside the drive (leave blank for the drive root)",
        default: "",
      },
      {
        key: "envVar",
        prompt: "Env var holding the Graph bearer token",
        default: "SHAREPOINT_TOKEN",
        validate: /^[A-Z_][A-Z0-9_]*$/,
      },
      {
        key: "token",
        prompt: "Paste your Graph bearer token (will be exported, not stored)",
        secret: true,
        help: "Token is shown back to you at the end so you can add it to your shell rc.",
      },
    ];
  },
  async verify(answers) {
    if (answers.transport !== "rest") {
      return { ok: true, message: "MCP transport — verification deferred to `atelier sync`." };
    }
    const token = answers.values.token;
    const hostname = answers.values.hostname;
    const sitePath = answers.values.sitePath;
    if (!token || !hostname || !sitePath) {
      return { ok: false, error: "Missing token / hostname / sitePath." };
    }
    try {
      const adapter = new SharePointAdapter({
        token,
        scope: {
          hostname,
          sitePath,
          driveName: answers.values.driveName || undefined,
          folderPath: answers.values.folderPath || undefined,
          maxItems: 5,
        },
      });
      const a = await adapter.checkAvailability();
      if (!a.available) return { ok: false, error: a.reason };
      const docs = await adapter.listDocs();
      return {
        ok: true,
        message: `Found ${docs.length} file(s) (capped at 5 for the probe). Sync uses scope.maxItems.`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  toRegistryEntry(answers) {
    const id = answers.values.id || "sharepoint";
    const name = answers.values.name || "SharePoint";
    if (answers.transport === "mcp") {
      return {
        source: {
          id,
          kind: "sharepoint",
          name,
          transport: "mcp",
          mcpServer: answers.values.mcpServer,
        },
      };
    }
    const envVar = answers.values.envVar || "SHAREPOINT_TOKEN";
    const scope: Record<string, unknown> = {
      hostname: answers.values.hostname,
      sitePath: answers.values.sitePath,
    };
    if (answers.values.driveName) scope.driveName = answers.values.driveName;
    if (answers.values.folderPath) scope.folderPath = answers.values.folderPath;
    return {
      source: {
        id,
        kind: "sharepoint",
        name,
        transport: "rest",
        credentials: { envVar },
        scope,
      },
      envVarsToSet: answers.values.token
        ? [
            {
              name: envVar,
              value: answers.values.token,
              description: "Microsoft Graph bearer token (expires; refresh via az CLI)",
            },
          ]
        : undefined,
    };
  },
};

registerAdapter({
  kind: "sharepoint",
  onboarding: sharepointOnboarding,
  async build(source: Source) {
    if (source.transport === "rest" || !source.transport) {
      const token = await resolveCredential(source.credentials, { sourceId: source.id });
      const scope = (source.scope ?? {}) as unknown as SharePointScope;
      return new SharePointAdapter({ token, scope });
    }
    throw new Error(
      `SharePointAdapter.build: transport "${source.transport}" not handled by the REST adapter (the sync factory should have dispatched elsewhere).`
    );
  },
});

export { sharepointOnboarding };
