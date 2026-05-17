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
