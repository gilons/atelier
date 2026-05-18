import {
  HttpClient,
  HttpError,
  resolveCredential,
  type FetchLike,
} from "../http-transport.js";
import { classifyDoc } from "../classify.js";
import { registerAdapter, type OnboardingFlow, type OnboardingStep, type TransportOption } from "../onboarding.js";
import {
  resolveSharePointLink,
  InvalidSharePointUrlError,
  type SharePointLinkResolution,
} from "./sharepoint-resolve.js";
import {
  searchSharePointSites,
  searchSharePointFiles,
} from "./sharepoint-search.js";
import {
  AzureClientCredentialsProvider,
  BearerTokenProvider,
  buildTokenProviderFromCredentials,
  type TokenProvider,
} from "./sharepoint-auth.js";
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
  /**
   * Static bearer token. Provided for tests and the legacy
   * onboarding path; production code should pass a
   * {@link tokenProvider} instead so tokens auto-refresh.
   * Exactly one of `token` / `tokenProvider` must be set.
   */
  token?: string;
  /**
   * Token provider — preferred input. The adapter calls
   * `tokenProvider.getToken()` before every Graph request, so
   * `AzureClientCredentialsProvider` instances refresh seamlessly
   * once the underlying token expires.
   */
  tokenProvider?: TokenProvider;
  /** Site identifier — see {@link SharePointScope}. */
  scope: SharePointScope;
  /** Optional fetch override for tests. */
  fetchImpl?: FetchLike;
}

/**
 * One pinned target within a SharePoint source. Each pin says
 * "from this site, look at this place." A source can have many
 * pins — different sites, different folders, individual files —
 * all syncing together under a single source id.
 *
 * The three pin shapes (folder / file / driveItem) cover every
 * way the onboarding wizard discovers a target:
 *
 *   - **folder** — comes from "paste a URL pointing at a folder"
 *     or from the manual-entry path. Atelier walks the folder.
 *   - **file** — comes from "paste a URL pointing at a single
 *     file." Atelier emits exactly that file.
 *   - **driveItem** — comes from search results or from resolving
 *     an opaque share URL. Identified by driveId + itemId; Atelier
 *     doesn't need to resolve a site path to use it.
 */
export type SharePointPin =
  | {
      kind: "folder";
      sitePath: string;
      driveName?: string;
      /** Empty string means the drive root. */
      folderPath: string;
      recursive?: boolean;
    }
  | {
      kind: "file";
      sitePath: string;
      driveName?: string;
      /** Path inside the drive, with leading slash. */
      itemPath: string;
    }
  | {
      kind: "driveItem";
      driveId: string;
      itemId: string;
      /** Optional human label kept around for the doc-map summary. */
      name?: string;
    };

export interface SharePointScope {
  /**
   * SharePoint hostname (e.g. `contoso.sharepoint.com`). Required —
   * Graph addresses sites by hostname plus path. All pins in a
   * single source must live on this hostname.
   */
  hostname: string;
  /**
   * One or more pinned targets. A pin can be a folder (walked),
   * a single file, or a driveItem reference. See {@link SharePointPin}.
   *
   * The schema also accepts the LEGACY single-target form via the
   * fields below (`sitePath`/`folderPath`/etc.). On load the
   * adapter normalizes the legacy fields into a one-element
   * `pins` array so the runtime path is unified.
   */
  pins?: SharePointPin[];
  /** Hard cap on items to index across all pins. Defaults to 1000. */
  maxItems?: number;
  /**
   * File extensions to include (without the leading dot).
   * Defaults to: docx, doc, txt, md, vtt, pdf. Office files use
   * Graph's plain-text conversion; .vtt is post-processed.
   */
  extensions?: string[];

  // ============================================================
  // Legacy single-target fields. Still accepted on load (and
  // normalized into pins[0]) so existing sources don't break.
  // The wizard writes the multi-pin shape from now on.
  // ============================================================

  /** @deprecated Use `pins`. */
  sitePath?: string;
  /** @deprecated Use `pins`. */
  driveName?: string;
  /** @deprecated Use `pins`. */
  folderPath?: string;
  /** @deprecated Use `pins`. */
  recursive?: boolean;
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
  private readonly tokenProvider: TokenProvider;
  // Per-pin cache: siteId + driveId resolved on demand. Keyed by
  // `${sitePath}::${driveName ?? "<default>"}` for folder/file
  // pins; driveItem pins skip this entirely.
  private readonly siteIdCache = new Map<string, string>();
  private readonly driveIdCache = new Map<string, string>();
  private readonly pins: SharePointPin[];

  constructor(private readonly opts: SharePointAdapterOptions) {
    if (!opts.token && !opts.tokenProvider) {
      throw new Error(
        "SharePointAdapter requires `token` or `tokenProvider`. Production code should use a tokenProvider so refresh is automatic."
      );
    }
    if (opts.token && opts.tokenProvider) {
      throw new Error(
        "SharePointAdapter: pass either `token` or `tokenProvider`, not both."
      );
    }
    this.tokenProvider =
      opts.tokenProvider ?? new BearerTokenProvider(opts.token!);
    if (!opts.scope.hostname) {
      throw new Error(
        "SharePointAdapter requires scope.hostname (e.g. {hostname: 'contoso.sharepoint.com', pins: [...]})."
      );
    }
    this.pins = normalizePins(opts.scope);
    if (this.pins.length === 0) {
      throw new Error(
        "SharePointAdapter requires at least one pin (or legacy sitePath). Got: " +
          JSON.stringify(opts.scope)
      );
    }
    this.client = new HttpClient({
      baseUrl: GRAPH_API_BASE,
      userAgent: "atelier",
      // Async authHeaders so a long-running listDocs can survive
      // a token rolling over — the provider's TTL cache means
      // most calls are zero-cost, but `getToken()` mints fresh
      // when needed.
      authHeaders: async () => {
        const token = await this.tokenProvider.getToken();
        return { Authorization: `Bearer ${token}` };
      },
      fetchImpl: opts.fetchImpl,
    });
  }

  async checkAvailability(): Promise<AdapterAvailability> {
    // Resolve the FIRST pin to surface auth / hostname errors early.
    // We don't loop every pin here — sync will surface per-pin
    // problems when it walks them.
    try {
      await this.resolveDriveIdForPin(this.pins[0]);
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
          reason: `SharePoint pin not found on ${this.opts.scope.hostname}: ${describePin(this.pins[0])}. Check the URL and that the app has read access.`,
        };
      }
      return { available: false, reason: e.message };
    }
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const exts = (this.opts.scope.extensions ?? DEFAULT_EXTENSIONS).map((e) =>
      e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase()
    );
    const max = this.opts.scope.maxItems ?? 1000;
    const collected: RemoteDocMetadata[] = [];
    for (const pin of this.pins) {
      if (collected.length >= max) break;
      const remaining = max - collected.length;
      const items = await this.listForPin(pin, exts, remaining);
      collected.push(...items);
    }
    return collected;
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    // docId is encoded as `{driveId}::{itemId}` (see listForPin).
    // Decoding here keeps fetchDoc fully self-contained — no need
    // to recompute drive resolution.
    const { driveId, itemId } = decodeDocId(docId);
    const meta = await this.client.request<GraphItem>({
      path: `/drives/${driveId}/items/${itemId}`,
    });
    const ext = meta.name.split(".").pop()?.toLowerCase() ?? "";

    let body: string;
    if (ext === "vtt") {
      const raw = await this.fetchRawText(driveId, itemId);
      body = renderVttAsMarkdown(raw, meta.name);
    } else if (ext === "md" || ext === "txt") {
      body = await this.fetchRawText(driveId, itemId);
    } else {
      // Word docs, PDFs, etc. — ask Graph to convert to plain
      // text. Some MIME types (notably older .doc and some PDFs)
      // come back as 406 Not Acceptable when the conversion isn't
      // supported. Fall back to a stub body so sync continues
      // instead of failing the whole run on one unconvertible
      // file — the doc still lands in the doc map with title +
      // URL so the user can open it externally.
      try {
        body = await this.fetchAsPlainText(driveId, itemId);
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr instanceof HttpError && httpErr.status === 406) {
          body =
            `> ${meta.name} couldn't be converted to text by Microsoft Graph ` +
            `(HTTP 406). Open the file directly: ${meta.webUrl ?? "(no url)"}\n`;
        } else {
          throw err;
        }
      }
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

  /** Walk one pin and emit metadata for every matching file under it. */
  private async listForPin(
    pin: SharePointPin,
    exts: string[],
    cap: number
  ): Promise<RemoteDocMetadata[]> {
    if (pin.kind === "driveItem") {
      // Pinned single item — emit it directly without walking.
      const meta = await this.client.request<GraphItem>({
        path: `/drives/${pin.driveId}/items/${pin.itemId}`,
      });
      if (!meta.file) return [];
      return [
        {
          docId: encodeDocId(pin.driveId, meta.id),
          title: stripExtension(meta.name),
          url: meta.webUrl,
          lastModified: meta.lastModifiedDateTime,
          classification: classifyDoc({
            kind: "sharepoint",
            title: meta.name,
            filename: meta.name,
          }),
        },
      ];
    }
    const driveId = await this.resolveDriveIdForPin(pin);
    if (pin.kind === "file") {
      // Resolve the itemPath to an item first, then emit.
      const itemPath = pin.itemPath.startsWith("/")
        ? pin.itemPath
        : `/${pin.itemPath}`;
      const meta = await this.client.request<GraphItem>({
        path: `/drives/${driveId}/root:${itemPath}`,
      });
      if (!meta.file) return [];
      return [
        {
          docId: encodeDocId(driveId, meta.id),
          title: stripExtension(meta.name),
          url: meta.webUrl,
          lastModified: meta.lastModifiedDateTime,
          classification: classifyDoc({
            kind: "sharepoint",
            title: meta.name,
            filename: meta.name,
          }),
        },
      ];
    }
    // folder pin — walk it.
    const recursive = pin.recursive ?? true;
    const startPath = normalizeFolderPath(pin.folderPath);
    const queue: string[] = [startPath];
    const out: RemoteDocMetadata[] = [];
    while (queue.length > 0 && out.length < cap) {
      const path = queue.shift()!;
      const items = await this.listChildren(driveId, path);
      for (const item of items) {
        if (out.length >= cap) break;
        if (item.folder) {
          if (recursive) queue.push(joinDrivePath(path, item.name));
          continue;
        }
        if (!item.file) continue;
        const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
        if (!exts.includes(ext)) continue;
        out.push({
          docId: encodeDocId(driveId, item.id),
          title: stripExtension(item.name),
          url: item.webUrl,
          lastModified: item.lastModifiedDateTime,
          classification: classifyDoc({
            kind: "sharepoint",
            title: item.name,
            filename: item.name,
          }),
          summary: path ? `In: ${path}` : undefined,
        });
      }
    }
    return out;
  }

  // ============================================================
  // Graph plumbing
  // ============================================================

  private async resolveSiteIdForPath(sitePath: string): Promise<string> {
    const key = sitePath;
    const cached = this.siteIdCache.get(key);
    if (cached) return cached;
    // Graph addresses sites by `{hostname}:{path}:` (the trailing colon
    // ends the colon-syntax segment). Path with leading slash is fine.
    const cleanPath = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;
    const idPath = `/sites/${this.opts.scope.hostname}:${cleanPath}`;
    const site = await this.client.request<GraphSite>({ path: idPath });
    this.siteIdCache.set(key, site.id);
    return site.id;
  }

  private async resolveDriveIdForPin(pin: SharePointPin): Promise<string> {
    if (pin.kind === "driveItem") return pin.driveId;
    const cacheKey = `${pin.sitePath}::${pin.driveName ?? "<default>"}`;
    const cached = this.driveIdCache.get(cacheKey);
    if (cached) return cached;
    const siteId = await this.resolveSiteIdForPath(pin.sitePath);
    let driveId: string;
    if (!pin.driveName) {
      const drive = await this.client.request<GraphDrive>({
        path: `/sites/${siteId}/drive`,
      });
      driveId = drive.id;
    } else {
      const drives = await this.client.request<GraphList<GraphDrive>>({
        path: `/sites/${siteId}/drives`,
      });
      const match = drives.value.find((d) => d.name === pin.driveName);
      if (!match) {
        throw new Error(
          `SharePoint drive "${pin.driveName}" not found on site ${this.opts.scope.hostname}${pin.sitePath}. Available: ${drives.value.map((d) => d.name).join(", ")}`
        );
      }
      driveId = match.id;
    }
    this.driveIdCache.set(cacheKey, driveId);
    return driveId;
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
    const token = await this.tokenProvider.getToken();
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
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
    const token = await this.tokenProvider.getToken();
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
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

/**
 * Coerce a scope into a normalized {@link SharePointPin}[] —
 * folding the legacy single-target fields into a synthetic pin so
 * the runtime path is unified and old sources don't break.
 */
function normalizePins(scope: SharePointScope): SharePointPin[] {
  const pins = Array.isArray(scope.pins) ? scope.pins.slice() : [];
  // Legacy form: sitePath + folderPath at the top level.
  if (pins.length === 0 && scope.sitePath) {
    pins.push({
      kind: "folder",
      sitePath: scope.sitePath,
      driveName: scope.driveName,
      folderPath: scope.folderPath ?? "",
      recursive: scope.recursive,
    });
  }
  return pins;
}

/**
 * Encode a stable docId from `(driveId, itemId)`. Atelier persists
 * this id in the doc-map; the adapter needs to be able to decode it
 * during sync to fetch the file. We use `driveId::itemId` because
 * Graph item ids are unique only within a drive, and a single
 * SharePoint source can span multiple drives.
 */
function encodeDocId(driveId: string, itemId: string): string {
  return `${driveId}::${itemId}`;
}

function decodeDocId(docId: string): { driveId: string; itemId: string } {
  const idx = docId.indexOf("::");
  if (idx === -1) {
    // Legacy docs were stored as bare itemIds. Surface a clear error
    // — the sync engine catches this and skips the doc with a hint
    // pointing at the migration path.
    throw new Error(
      `SharePoint docId "${docId}" is in the legacy bare-itemId form. ` +
        `Re-run /source onboard to regenerate scope.pins, then sync again.`
    );
  }
  return { driveId: docId.slice(0, idx), itemId: docId.slice(idx + 2) };
}

/** Human-readable summary of a pin for error messages. */
function describePin(pin: SharePointPin): string {
  if (pin.kind === "driveItem") return `driveItem ${pin.driveId}/${pin.itemId}`;
  const lib = pin.driveName ?? "Documents";
  if (pin.kind === "folder") {
    return `${pin.sitePath} → ${lib}${pin.folderPath || ""}`;
  }
  return `${pin.sitePath} → ${lib}${pin.itemPath} (file)`;
}

// ============================================================
// Onboarding flow + registration
// ============================================================

const sharepointOnboarding: OnboardingFlow = {
  kind: "sharepoint",
  displayName: "SharePoint / OneDrive (Microsoft Graph)",
  description:
    "Atelier indexes SharePoint document libraries via Microsoft Graph. " +
    "Recommended setup: register an Azure AD app (one-time, takes 5min) " +
    "and Atelier will mint + auto-refresh tokens for you. As a quick path " +
    "you can also paste a bearer token from `az account get-access-token` " +
    "— that token expires every ~1h so re-pasting becomes a chore.",
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
        auto: true,
      },
      {
        key: "name",
        prompt: "Display name",
        default: "SharePoint",
        auto: true,
      },
      {
        key: "authType",
        prompt: "Authenticate via?",
        help: "Azure AD app auto-refreshes. Bearer token works once but expires hourly.",
        // discoverChoices: the OnboardingStep contract doesn't
        // ship a static `choices` field yet, so we synthesize one
        // here. The function is called once per onboarding run;
        // the values it returns power the multi/single-select
        // picker pipeline that other steps already use.
        discoverChoices: async () => [
          {
            label: "azure-app",
            value: "azure-app",
            note: "auto-refresh, recommended",
          },
          {
            label: "bearer token",
            value: "bearer",
            note: "expires hourly, quick path",
          },
        ],
      },
      // ----- bearer auth -----
      {
        key: "envVar",
        prompt: "Env var holding the Graph bearer token",
        default: "SHAREPOINT_TOKEN",
        validate: /^[A-Z_][A-Z0-9_]*$/,
        applies: (a) => (a.values.authType ?? "bearer") === "bearer",
        auto: true,
      },
      {
        key: "token",
        prompt: "Paste your Graph bearer token",
        secret: true,
        applies: (a) => (a.values.authType ?? "bearer") === "bearer",
        help:
          "Get one with `az account get-access-token --resource https://graph.microsoft.com`. " +
          "Expires in ~1 hour.",
      },
      // ----- azure-app auth (client_credentials) -----
      {
        key: "azureTenantId",
        prompt: "Microsoft Entra tenant id (GUID)",
        applies: (a) => a.values.authType === "azure-app",
        validate: /^[0-9a-f-]{36}$/i,
        help:
          "Microsoft Entra ID → Overview → Tenant ID. Or it's the GUID in " +
          "your portal URL right after `tenants/`.",
      },
      {
        key: "azureClientId",
        prompt: "App (client) id",
        applies: (a) => a.values.authType === "azure-app",
        validate: /^[0-9a-f-]{36}$/i,
        help:
          "App registrations → your-app → Overview → Application (client) ID.",
      },
      {
        key: "azureClientSecretEnvVar",
        prompt: "Env var holding the client secret VALUE",
        default: "SHAREPOINT_CLIENT_SECRET",
        applies: (a) => a.values.authType === "azure-app",
        validate: /^[A-Z_][A-Z0-9_]*$/,
        help:
          "Atelier reads the secret from this env var at sync time — the " +
          "value itself is never written to sources.yaml.",
        auto: true,
      },
      {
        key: "azureClientSecret",
        prompt: "Paste the client secret VALUE",
        secret: true,
        applies: (a) => a.values.authType === "azure-app",
        help:
          "Used for verification + the env-var hint shown at the end. " +
          "Atelier doesn't persist this value in sources.yaml.",
      },
      {
        key: "mode",
        prompt: "How do you want to add this SharePoint source?",
        help: "Paste a URL, search by name, or type addresses manually.",
        discoverChoices: async () => [
          {
            label: "link",
            value: "link",
            note: "paste a SharePoint URL — site / library / folder / file",
          },
          {
            label: "search",
            value: "search",
            note: "Graph searches matching sites + docs across the tenant",
          },
          {
            label: "manual",
            value: "manual",
            note: "type hostname / site path / folder path by hand",
          },
        ],
      },
      // ----- link mode -----
      {
        key: "linkUrl",
        prompt:
          "Paste a SharePoint URL (e.g. https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans)",
        applies: (a) => a.values.mode === "link",
        validate: /^https?:\/\//,
      },
      // ----- search mode -----
      {
        key: "searchQuery",
        prompt: "Search SharePoint by name (2+ chars)",
        applies: (a) => a.values.mode === "search",
        validate: /.{2,}/,
      },
      {
        key: "searchPins",
        prompt: "Pick one or more results to onboard",
        applies: (a) => a.values.mode === "search",
        multiSelect: true,
        validate: /.+/,
        discoverChoices: async (_ctx, answers) =>
          searchAndShape(
            answers.values.token,
            answers.values.searchQuery
          ),
      },
      // ----- manual mode (legacy) -----
      {
        key: "hostname",
        prompt: "SharePoint hostname (e.g. contoso.sharepoint.com)",
        applies: (a) => a.values.mode === "manual",
        validate: /^[a-z0-9.-]+\.[a-z]{2,}$/i,
      },
      {
        key: "sitePath",
        prompt: "Site path (e.g. /sites/marketing — or / for the root site)",
        applies: (a) => a.values.mode === "manual",
        default: "/",
        validate: /^\/.*$/,
      },
      {
        key: "driveName",
        prompt: "Drive name (leave blank for the default document library)",
        applies: (a) => a.values.mode === "manual",
        default: "",
      },
      {
        key: "folderPath",
        prompt: "Folder path inside the drive (leave blank for the drive root)",
        applies: (a) => a.values.mode === "manual",
        default: "",
      },
    ];
  },
  async verify(answers) {
    if (answers.transport !== "rest") {
      return { ok: true, message: "MCP transport — verification deferred to `atelier sync`." };
    }
    let tokenProvider: TokenProvider;
    try {
      tokenProvider = providerFromAnswers(answers.values);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    let scope: SharePointScope;
    try {
      scope = scopeFromAnswers(answers.values);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      const adapter = new SharePointAdapter({
        tokenProvider,
        scope: { ...scope, maxItems: 5 },
      });
      const a = await adapter.checkAvailability();
      if (!a.available) return { ok: false, error: a.reason };
      const docs = await adapter.listDocs();
      const authMsg =
        answers.values.authType === "azure-app"
          ? "(token auto-minted from Azure AD app — refreshes on expiry)"
          : "(static bearer token — expires hourly)";
      return {
        ok: true,
        message: `Found ${docs.length} file(s) across ${scope.pins?.length ?? 0} pin(s) (probe capped at 5). ${authMsg}`,
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
    const scope = scopeFromAnswers(answers.values);
    // Auth branching: azure-app produces a structured credentials
    // record + a hint to export the secret; bearer keeps the
    // existing envVar reference shape.
    if (answers.values.authType === "azure-app") {
      const secretEnvVar =
        answers.values.azureClientSecretEnvVar || "SHAREPOINT_CLIENT_SECRET";
      return {
        source: {
          id,
          kind: "sharepoint",
          name,
          transport: "rest",
          credentials: {
            kind: "azureClientCredentials",
            tenantId: answers.values.azureTenantId,
            clientId: answers.values.azureClientId,
            clientSecretEnvVar: secretEnvVar,
          },
          scope: scope as unknown as Record<string, unknown>,
        },
        envVarsToSet: answers.values.azureClientSecret
          ? [
              {
                name: secretEnvVar,
                value: answers.values.azureClientSecret,
                description:
                  "Azure AD app client secret — Atelier mints fresh Graph tokens from it on every sync.",
              },
            ]
          : undefined,
      };
    }
    const envVar = answers.values.envVar || "SHAREPOINT_TOKEN";
    return {
      source: {
        id,
        kind: "sharepoint",
        name,
        transport: "rest",
        credentials: { envVar },
        scope: scope as unknown as Record<string, unknown>,
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
  merge(existing, answers) {
    const incoming = sharepointOnboarding.toRegistryEntry(answers);
    const exScope = (existing.scope ?? {}) as Partial<SharePointScope>;
    const inScope = (incoming.source.scope ?? {}) as Partial<SharePointScope>;
    // Existing source may still be in the legacy shape — normalize
    // it through the adapter's helper so the merge sees a uniform
    // list of pins on both sides.
    const exPins = normalizePins({
      hostname: exScope.hostname ?? "",
      pins: exScope.pins,
      sitePath: exScope.sitePath,
      driveName: exScope.driveName,
      folderPath: exScope.folderPath,
      recursive: exScope.recursive,
    });
    const inPins = inScope.pins ?? [];
    // De-dupe by a stable key per pin kind.
    const seen = new Set<string>(exPins.map(pinKey));
    const merged = exPins.slice();
    for (const p of inPins) {
      const k = pinKey(p);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(p);
      }
    }
    const mergedScope: Record<string, unknown> = {
      hostname: inScope.hostname ?? exScope.hostname,
      pins: merged,
    };
    if (inScope.maxItems ?? exScope.maxItems) {
      mergedScope.maxItems = Math.max(
        exScope.maxItems ?? 0,
        inScope.maxItems ?? 0
      );
    }
    if (inScope.extensions ?? exScope.extensions) {
      mergedScope.extensions = unique([
        ...(exScope.extensions ?? []),
        ...(inScope.extensions ?? []),
      ]);
    }
    return {
      source: {
        id: existing.id,
        kind: "sharepoint",
        name: existing.name,
        transport: existing.transport ?? "rest",
        credentials: existing.credentials,
        scope: mergedScope,
      },
    };
  },
};

/**
 * Build a {@link SharePointScope} from the wizard's collected
 * answers — branching on `mode`. Each branch produces at least one
 * pin; the multi-select in search mode can produce many.
 *
 * Throws when the URL parser can't resolve a pasted link (we want
 * the wizard's confirm step to see the failure as a clear error,
 * not a silent fallthrough).
 */
/**
 * Build a {@link TokenProvider} from the wizard's answers — used
 * during the verify step so the live probe goes through the same
 * auth path the persisted source will use after onboarding
 * completes. azure-app branch builds the auto-refresh provider;
 * bearer branch wraps the static token in BearerTokenProvider.
 */
function providerFromAnswers(values: Record<string, string>): TokenProvider {
  const authType = values.authType || "bearer";
  if (authType === "azure-app") {
    if (!values.azureTenantId || !values.azureClientId || !values.azureClientSecret) {
      throw new Error(
        "Azure auth: tenantId, clientId, and clientSecret are all required."
      );
    }
    return new AzureClientCredentialsProvider({
      tenantId: values.azureTenantId,
      clientId: values.azureClientId,
      clientSecret: values.azureClientSecret,
    });
  }
  if (!values.token) {
    throw new Error("Bearer auth: token is required.");
  }
  return new BearerTokenProvider(values.token);
}

function scopeFromAnswers(
  values: Record<string, string>
): SharePointScope {
  const mode = values.mode || "manual";
  if (mode === "link") {
    return scopeFromLink(values.linkUrl);
  }
  if (mode === "search") {
    return scopeFromSearchPicks(values.searchPins);
  }
  // Manual / legacy.
  if (!values.hostname) {
    throw new Error("Manual mode: hostname is required.");
  }
  return {
    hostname: values.hostname,
    pins: [
      {
        kind: "folder",
        sitePath: values.sitePath || "/",
        driveName: values.driveName || undefined,
        folderPath: values.folderPath || "",
      },
    ],
  };
}

function scopeFromLink(url: string | undefined): SharePointScope {
  if (!url) throw new Error("Link mode: linkUrl is required.");
  let r: SharePointLinkResolution;
  try {
    r = resolveSharePointLink(url);
  } catch (err) {
    if (err instanceof InvalidSharePointUrlError) {
      throw new Error(`Couldn't parse "${url}": ${err.message}`);
    }
    throw err;
  }
  if (r.kind === "opaqueShare") {
    // Could be resolved via Graph /shares — that's a follow-up.
    throw new Error(
      `That URL is a tokenized share link (/:f:/s/...). Atelier can't resolve it locally yet — paste the canonical URL from the file's "Open in browser" link instead, or use search mode.`
    );
  }
  if (r.kind === "site" || r.kind === "library") {
    // Treat as "the default library's root folder."
    return {
      hostname: r.hostname,
      pins: [
        {
          kind: "folder",
          sitePath: r.sitePath,
          driveName: r.kind === "library" ? r.driveName : undefined,
          folderPath: "",
        },
      ],
    };
  }
  if (r.kind === "folder") {
    return {
      hostname: r.hostname,
      pins: [
        {
          kind: "folder",
          sitePath: r.sitePath,
          driveName: r.driveName,
          folderPath: r.folderPath,
        },
      ],
    };
  }
  // file
  return {
    hostname: r.hostname,
    pins: [
      {
        kind: "file",
        sitePath: r.sitePath,
        driveName: r.driveName,
        itemPath: r.itemPath,
      },
    ],
  };
}

function scopeFromSearchPicks(csv: string | undefined): SharePointScope {
  if (!csv) throw new Error("Search mode: at least one result must be picked.");
  // Each picked value is a JSON-encoded pin produced by
  // `searchAndShape` below. Decode and aggregate.
  const pins: SharePointPin[] = [];
  let hostname = "";
  for (const part of csv.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let decoded: { hostname: string; pin: SharePointPin };
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Search mode: couldn't decode a picked result: ${trimmed.slice(0, 80)}`
      );
    }
    if (!hostname) hostname = decoded.hostname;
    if (hostname !== decoded.hostname) {
      throw new Error(
        `Search picks span multiple hostnames (${hostname} + ${decoded.hostname}). A single source can only target one hostname — split into separate sources.`
      );
    }
    pins.push(decoded.pin);
  }
  return { hostname, pins };
}

/**
 * Run a Graph search for the user's query and shape the results
 * into picker choices. Each choice's `value` is a JSON-encoded
 * `{hostname, pin}` blob — the picker round-trips it through
 * `scopeFromSearchPicks`. (We could store an integer index and a
 * side map, but JSON-in-value keeps the discoverChoices return
 * type pure and stateless.)
 */
async function searchAndShape(
  token: string | undefined,
  query: string | undefined
): Promise<Array<{ label: string; value: string; note?: string }>> {
  if (!token || !query || query.length < 2) return [];
  const out: Array<{ label: string; value: string; note?: string }> = [];
  // Sites first, then files, capped to a reasonable picker size.
  try {
    const sites = await searchSharePointSites(token, query, { limit: 10 });
    for (const s of sites) {
      const pin: SharePointPin = {
        kind: "folder",
        sitePath: s.sitePath,
        folderPath: "",
      };
      out.push({
        label: `[site] ${s.displayName}`,
        value: JSON.stringify({ hostname: s.hostname, pin }),
        note: s.webUrl,
      });
    }
  } catch {
    /* surface a "no site results" silently — file search may still work */
  }
  try {
    const files = await searchSharePointFiles(token, query, { limit: 15 });
    for (const f of files) {
      if (!f.driveId || !f.itemId) continue;
      const pin: SharePointPin = {
        kind: "driveItem",
        driveId: f.driveId,
        itemId: f.itemId,
        name: f.name,
      };
      out.push({
        label: `[file] ${f.name}`,
        value: JSON.stringify({
          hostname: f.hostname ?? "",
          pin,
        }),
        note: f.webUrl ?? "",
      });
    }
  } catch {
    /* same — both being empty just yields an empty picker */
  }
  return out;
}

function pinKey(p: SharePointPin): string {
  if (p.kind === "driveItem") return `di:${p.driveId}:${p.itemId}`;
  if (p.kind === "file") {
    return `f:${p.sitePath}:${p.driveName ?? ""}:${p.itemPath}`;
  }
  return `fo:${p.sitePath}:${p.driveName ?? ""}:${p.folderPath}`;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

registerAdapter({
  kind: "sharepoint",
  onboarding: sharepointOnboarding,
  async build(source: Source) {
    if (source.transport === "rest" || !source.transport) {
      // The new credentials shape (`{kind: "azureClientCredentials"}`)
      // builds an AzureClientCredentialsProvider that mints + caches
      // tokens for the lifetime of this adapter instance. Legacy
      // `{envVar}` credentials produce a BearerTokenProvider — same
      // behavior as before, just routed through the abstraction.
      const tokenProvider = buildTokenProviderFromCredentials(
        source.credentials,
        { sourceId: source.id }
      );
      const scope = (source.scope ?? {}) as unknown as SharePointScope;
      return new SharePointAdapter({ tokenProvider, scope });
    }
    throw new Error(
      `SharePointAdapter.build: transport "${source.transport}" not handled by the REST adapter (the sync factory should have dispatched elsewhere).`
    );
  },
});

export { sharepointOnboarding };
