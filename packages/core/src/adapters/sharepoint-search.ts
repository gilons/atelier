/**
 * Microsoft Graph search + share-URL resolution for the SharePoint
 * onboarding flow. Atelier doesn't list a tenant's full SharePoint —
 * the user finds what they want either by pasting a URL (see
 * {@link ./sharepoint-resolve}) or by typing a query that gets
 * forwarded to Graph and trimmed to a small picker.
 *
 * Endpoints used:
 *
 *   - `GET /sites?search={q}` for site search. Returns up to ~100
 *     hits with `displayName`, `webUrl`, `id`. Cheap; one call.
 *
 *   - `POST /search/query` with `entityTypes:["driveItem"]` for
 *     file search. The `/v1.0/search/query` endpoint is the modern
 *     replacement for `/me/drive/search`. Scoped to the caller's
 *     app permissions, so with `Files.Read.All` it covers every
 *     drive in the tenant.
 *
 *   - `GET /shares/{u!b64}/driveItem` for resolving opaque
 *     `/:f:/s/...` share links into a real driveItem reference.
 *
 * Each helper swallows errors into a clear message rather than
 * letting Graph's verbose JSON propagate. The onboarding wizard
 * shows these messages directly to the user.
 */

import { encodeShareUrlForGraph } from "./sharepoint-resolve.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface SiteSearchResult {
  /** Graph site id — opaque, hostname-prefixed. */
  id: string;
  /** Human label (e.g. "Marketing"). */
  displayName: string;
  /** Browser URL (e.g. https://contoso.sharepoint.com/sites/Marketing). */
  webUrl: string;
  /** Stripped sitePath (e.g. "/sites/Marketing") parsed from webUrl. */
  sitePath: string;
  /** Hostname (e.g. "contoso.sharepoint.com"). */
  hostname: string;
}

export interface FileSearchResult {
  /** Graph driveItem id. */
  itemId: string;
  /** Drive id the item lives in — needed for follow-up fetches. */
  driveId: string;
  /** File name (e.g. "Q3-Plan.docx"). */
  name: string;
  /** Browser URL. */
  webUrl: string;
  /** Last-modified ISO timestamp. */
  lastModified?: string;
  /** Resolved sitePath when Graph returned a parentReference path. */
  sitePath?: string;
  /** Resolved hostname when Graph returned one. */
  hostname?: string;
}

/**
 * Search SharePoint sites by name across the tenant. Empty/short
 * queries (< 2 chars) early-return without a Graph call — Graph
 * returns nonsensical results for one-letter searches.
 */
export async function searchSharePointSites(
  token: string,
  query: string,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {}
): Promise<SiteSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const limit = opts.limit ?? 25;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${GRAPH_BASE}/sites?search=${encodeURIComponent(q)}&$top=${limit}`;
  const r = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(
      `Graph /sites?search returned ${r.status} ${r.statusText}`
    );
  }
  const data = (await r.json()) as { value?: Array<Record<string, unknown>> };
  const sites = data.value ?? [];
  const out: SiteSearchResult[] = [];
  for (const s of sites) {
    const webUrl = typeof s.webUrl === "string" ? s.webUrl : "";
    if (!webUrl) continue;
    let hostname = "";
    let sitePath = "/";
    try {
      const parsed = new URL(webUrl);
      hostname = parsed.hostname;
      sitePath = parsed.pathname || "/";
    } catch {
      // Skip rows with malformed URLs. Graph rarely returns these.
      continue;
    }
    out.push({
      id: String(s.id ?? ""),
      displayName: String(s.displayName ?? s.name ?? webUrl),
      webUrl,
      sitePath,
      hostname,
    });
  }
  return out;
}

/**
 * Full-text search across drive items. Uses the modern
 * `/search/query` endpoint with `entityTypes:["driveItem"]`. Pulls
 * a small page (default 25) — the picker is meant for "I know what
 * I want, find it for me," not "browse my whole tenant."
 *
 * Returns results normalized for the onboarding picker. We
 * deliberately don't surface every Graph field — the picker only
 * needs label + drive + item id.
 */
export async function searchSharePointFiles(
  token: string,
  query: string,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {}
): Promise<FileSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const limit = opts.limit ?? 25;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const body = {
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString: q },
        from: 0,
        size: limit,
      },
    ],
  };
  const r = await fetchImpl(`${GRAPH_BASE}/search/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(
      `Graph /search/query returned ${r.status} ${r.statusText}`
    );
  }
  const data = (await r.json()) as {
    value?: Array<{ hitsContainers?: Array<{ hits?: Array<{ resource?: Record<string, unknown>; summary?: string }> }> }>;
  };
  const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
  const out: FileSearchResult[] = [];
  for (const hit of hits) {
    const res = hit.resource ?? {};
    // Drive items have `parentReference.driveId` + `id` we can use.
    const ref = (res.parentReference ?? {}) as Record<string, unknown>;
    const driveId = typeof ref.driveId === "string" ? ref.driveId : "";
    const itemId = typeof res.id === "string" ? res.id : "";
    const name = typeof res.name === "string" ? res.name : "(untitled)";
    const webUrl = typeof res.webUrl === "string" ? res.webUrl : "";
    const lastModified =
      typeof res.lastModifiedDateTime === "string"
        ? res.lastModifiedDateTime
        : undefined;
    if (!driveId || !itemId) continue;
    let hostname: string | undefined;
    let sitePath: string | undefined;
    if (webUrl) {
      try {
        const parsed = new URL(webUrl);
        hostname = parsed.hostname;
        // Best-effort sitePath extraction — the webUrl path is
        // `/sites/X/Shared Documents/...`, we want `/sites/X`.
        const segs = parsed.pathname.split("/").filter(Boolean);
        if (segs[0] === "sites" || segs[0] === "teams" || segs[0] === "personal") {
          sitePath = `/${segs[0]}/${segs[1]}`;
        } else {
          sitePath = "/";
        }
      } catch {
        /* leave undefined */
      }
    }
    out.push({ itemId, driveId, name, webUrl, lastModified, sitePath, hostname });
  }
  return out;
}

/**
 * Drive-item listing for a specific folder. Used by the
 * onboarding link-mode drill-down: when the user pastes a
 * folder URL (or a site/library root), we don't assume they
 * want every doc under it — we list the contents and let them
 * multi-select the specific files they care about.
 *
 * Returns each file (not folder) as a `FileSearchResult` so the
 * downstream code path is identical to the Graph search picker.
 * The wizard wraps these into `driveItem` pins.
 *
 * The endpoint:
 *   `GET /sites/{host}:{sitePath}:/drive/root:/{folder}:/children`
 *
 * (Or the driveId form when `driveName` resolves to something
 * other than the default library.) Bounded to `limit` items
 * total — a folder with 10k files isn't fun to pick from, and
 * if a user really wants the whole thing they have the explicit
 * "Pull entire folder" opt-in.
 */
export async function listFilesInSharePointFolder(
  token: string,
  args: {
    hostname: string;
    sitePath: string;
    driveName?: string;
    /** Path inside the drive, with leading slash. Empty means drive root. */
    folderPath?: string;
  },
  opts: { fetchImpl?: typeof fetch; limit?: number } = {}
): Promise<FileSearchResult[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const limit = opts.limit ?? 250;

  // Resolve the site id first — Graph addresses sites by
  // `{host}:{path}:`; getting the id once and reusing it for
  // the drive lookup is a single round-trip vs threading a
  // colon-syntax through every endpoint.
  const cleanSitePath = args.sitePath.startsWith("/")
    ? args.sitePath
    : `/${args.sitePath}`;
  const siteResp = await fetchImpl(
    `${GRAPH_BASE}/sites/${encodeURIComponent(args.hostname)}:${encodeURIComponent(cleanSitePath)}`.replace(/%2F/g, "/"),
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!siteResp.ok) {
    throw new Error(
      `Graph /sites returned ${siteResp.status} ${siteResp.statusText} for ${args.hostname}${cleanSitePath}`
    );
  }
  const site = (await siteResp.json()) as { id?: string };
  if (!site.id) {
    throw new Error("Graph returned no site id");
  }

  // Build the drive-item children URL. Prefer the default drive
  // when no driveName given (matches the URL-resolver default
  // for "Shared Documents"). When a named drive is requested,
  // resolve its id first.
  let drivePrefix: string;
  if (args.driveName) {
    const drivesResp = await fetchImpl(`${GRAPH_BASE}/sites/${site.id}/drives`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!drivesResp.ok) {
      throw new Error(
        `Graph /sites/{id}/drives returned ${drivesResp.status}`
      );
    }
    const drives = (await drivesResp.json()) as {
      value: Array<{ id: string; name: string }>;
    };
    const match = drives.value.find((d) => d.name === args.driveName);
    if (!match) {
      throw new Error(
        `Drive "${args.driveName}" not found on ${args.hostname}${cleanSitePath}. Available: ${drives.value.map((d) => d.name).join(", ")}`
      );
    }
    drivePrefix = `/drives/${match.id}`;
  } else {
    drivePrefix = `/sites/${site.id}/drive`;
  }

  const folder = args.folderPath?.replace(/^\/+|\/+$/g, "") ?? "";
  const childrenUrl =
    folder.length === 0
      ? `${GRAPH_BASE}${drivePrefix}/root/children?$top=${limit}`
      : `${GRAPH_BASE}${drivePrefix}/root:/${encodeURIComponent(folder).replace(/%2F/g, "/")}:/children?$top=${limit}`;

  const childrenResp = await fetchImpl(childrenUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!childrenResp.ok) {
    throw new Error(
      `Graph drive-items request returned ${childrenResp.status} ${childrenResp.statusText}`
    );
  }
  const data = (await childrenResp.json()) as {
    value?: Array<{
      id: string;
      name: string;
      webUrl?: string;
      lastModifiedDateTime?: string;
      size?: number;
      file?: { mimeType?: string };
      folder?: { childCount?: number };
      parentReference?: { driveId?: string };
    }>;
  };

  const out: FileSearchResult[] = [];
  for (const item of data.value ?? []) {
    // Skip folders — the picker is for files. (A future
    // enhancement could let the user drill into subfolders;
    // for now we keep the picker flat.)
    if (!item.file) continue;
    const driveId = item.parentReference?.driveId ?? "";
    if (!driveId) continue;
    out.push({
      itemId: item.id,
      driveId,
      name: item.name,
      webUrl: item.webUrl ?? "",
      lastModified: item.lastModifiedDateTime,
      sitePath: cleanSitePath,
      hostname: args.hostname,
    });
  }
  return out;
}

/**
 * Resolve an opaque SharePoint share URL (the `/:X:/s/...?e=...`
 * tokenized form) into a real driveItem reference via Graph's
 * `/shares/{encodedUrl}/driveItem` endpoint. Called only when the
 * local URL parser returns `kind: "opaqueShare"` — direct URLs
 * never need this round-trip.
 */
export async function resolveOpaqueShareUrl(
  token: string,
  shareUrl: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<FileSearchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const encoded = encodeShareUrlForGraph(shareUrl);
  const r = await fetchImpl(
    `${GRAPH_BASE}/shares/${encoded}/driveItem`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) {
    throw new Error(
      `Graph /shares/.../driveItem returned ${r.status} ${r.statusText}`
    );
  }
  const item = (await r.json()) as Record<string, unknown>;
  const ref = (item.parentReference ?? {}) as Record<string, unknown>;
  const driveId = typeof ref.driveId === "string" ? ref.driveId : "";
  const itemId = typeof item.id === "string" ? item.id : "";
  const name = typeof item.name === "string" ? item.name : "(untitled)";
  const webUrl = typeof item.webUrl === "string" ? item.webUrl : "";
  if (!driveId || !itemId) {
    throw new Error(
      `Graph /shares returned no driveItem ref. Body: ${JSON.stringify(item).slice(0, 200)}`
    );
  }
  let hostname: string | undefined;
  let sitePath: string | undefined;
  if (webUrl) {
    try {
      const parsed = new URL(webUrl);
      hostname = parsed.hostname;
      const segs = parsed.pathname.split("/").filter(Boolean);
      if (segs[0] === "sites" || segs[0] === "teams" || segs[0] === "personal") {
        sitePath = `/${segs[0]}/${segs[1]}`;
      } else {
        sitePath = "/";
      }
    } catch {
      /* leave undefined */
    }
  }
  return {
    itemId,
    driveId,
    name,
    webUrl,
    lastModified: typeof item.lastModifiedDateTime === "string"
      ? item.lastModifiedDateTime
      : undefined,
    sitePath,
    hostname,
  };
}
