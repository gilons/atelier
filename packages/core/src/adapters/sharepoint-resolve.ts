/**
 * SharePoint URL resolver.
 *
 * Turns a SharePoint or OneDrive URL — pasted by the user during
 * /source onboard — into the structured pin Atelier persists in
 * `scope.pins`. Pure parsing, no Graph calls. URLs Atelier can't
 * resolve locally (opaque tokenized share links: `/:f:/s/…`) are
 * surfaced with `kind: "opaqueShare"` so the onboarding flow can
 * fall back to Graph's `/shares/u!{b64}/driveItem` resolver.
 *
 * URL shapes we handle:
 *
 *     # site root
 *     https://contoso.sharepoint.com/sites/Marketing
 *
 *     # library (root of a document library inside a site)
 *     https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents
 *
 *     # folder
 *     https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans
 *
 *     # single file
 *     https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx
 *
 *     # personal OneDrive
 *     https://contoso-my.sharepoint.com/personal/giles_contoso_io/Documents/spec.docx
 *
 *     # transparent share link (the `/r/` variant)
 *     https://contoso.sharepoint.com/:f:/r/sites/Marketing/Shared%20Documents/Q3
 *     https://contoso.sharepoint.com/:b:/r/sites/Marketing/Shared%20Documents/spec.pdf
 *
 *     # opaque share link (needs Graph /shares to resolve)
 *     https://contoso.sharepoint.com/:f:/s/Marketing/Eabc123?e=xyz
 */

export type SharePointLinkResolution =
  | {
      kind: "site";
      hostname: string;
      sitePath: string;
    }
  | {
      kind: "library";
      hostname: string;
      sitePath: string;
      /** undefined when it's the site's default library ("Shared Documents"). */
      driveName: string | undefined;
    }
  | {
      kind: "folder";
      hostname: string;
      sitePath: string;
      driveName: string | undefined;
      folderPath: string;
    }
  | {
      kind: "file";
      hostname: string;
      sitePath: string;
      driveName: string | undefined;
      itemPath: string;
    }
  | {
      // The URL is a tokenized share (e.g. /:f:/s/...?e=...). We
      // can't resolve it without a Graph call to /shares.
      kind: "opaqueShare";
      hostname: string;
      url: string;
    };

/**
 * The "default library" is addressable in URLs as `Shared Documents`
 * but the Graph API calls it `Documents`. The adapter treats
 * `driveName: undefined` as "use the site's default drive" — that's
 * the natural Graph idiom (`/sites/{id}/drive`). When we see
 * `Shared Documents` in a URL, normalize it to undefined.
 */
const DEFAULT_LIBRARY_URL_SEGMENTS = new Set([
  "Shared Documents",
  "Documents",
]);

export class InvalidSharePointUrlError extends Error {
  constructor(message: string, public readonly url: string) {
    super(message);
    this.name = "InvalidSharePointUrlError";
  }
}

/**
 * Parse a SharePoint URL into a structured pin. Throws
 * {@link InvalidSharePointUrlError} when the URL isn't a SharePoint
 * URL at all; returns `kind: "opaqueShare"` (not a throw) when the
 * URL is a SharePoint URL but uses the tokenized `/:X:/s/` share
 * form that requires a Graph call to resolve.
 */
export function resolveSharePointLink(
  url: string
): SharePointLinkResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidSharePointUrlError(
      `Not a valid URL: ${url}`,
      url
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.endsWith(".sharepoint.com")) {
    throw new InvalidSharePointUrlError(
      `Expected a *.sharepoint.com URL, got ${hostname}`,
      url
    );
  }
  // Strip query string + fragment — they're navigation hints, never
  // part of the resource identity (`?web=1`, `?csf=1`, `?d=…`).
  //
  // Exception: Word/Excel/PowerPoint Online viewer URLs carry the
  // actual file identity in `?sourcedoc={GUID}` instead of in the
  // path. The path itself points at `_layouts/15/Doc.aspx` which is
  // SharePoint's viewer shim, not the document. We treat those as
  // opaque shares so Graph's `/shares` endpoint can resolve them —
  // it accepts any SharePoint URL and returns the underlying
  // driveItem.
  if (
    parsed.searchParams.has("sourcedoc") ||
    /\/_layouts\//i.test(parsed.pathname) ||
    /\/Doc\.aspx$/i.test(parsed.pathname)
  ) {
    return { kind: "opaqueShare", hostname, url };
  }
  let pathname = decodeURIComponent(parsed.pathname);
  // Tokenized share links: `/:[a-z]:/s/...` — opaque. Surface them
  // so the caller can choose to resolve via Graph or skip.
  if (/^\/:[a-z]:\/s\//i.test(pathname)) {
    return { kind: "opaqueShare", hostname, url };
  }
  // Transparent share links: `/:[a-z]:/r/...`. Strip the prefix —
  // what remains IS the canonical path (it's the same content,
  // just routed through the share infrastructure).
  pathname = pathname.replace(/^\/:[a-z]:\/r\//i, "/");
  // Empty path → tenant root site.
  if (pathname === "" || pathname === "/") {
    return { kind: "site", hostname, sitePath: "/" };
  }

  // Recognise the three site shapes:
  //   /sites/<siteId>...
  //   /teams/<teamId>...   (Teams-channel-backed sites use /teams/ not /sites/)
  //   /personal/<user>...
  // Anything else falls back to "tenant root site, the path is
  // under it" — rare but legal for the very first library on the
  // root site (e.g. /Shared Documents/Foo).
  let sitePath: string;
  let afterSite: string;
  const siteMatch =
    /^\/(sites|teams|personal)\/([^/]+)/.exec(pathname);
  if (siteMatch) {
    sitePath = `/${siteMatch[1]}/${siteMatch[2]}`;
    afterSite = pathname.slice(sitePath.length);
  } else {
    sitePath = "/";
    afterSite = pathname;
  }

  // No path under the site → it's just the site root.
  if (!afterSite || afterSite === "/") {
    return { kind: "site", hostname, sitePath };
  }

  // Split the post-site path into segments. First segment is the
  // document library, the rest is the path inside that library.
  const segs = afterSite.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) {
    return { kind: "site", hostname, sitePath };
  }
  const driveName = normalizeDriveName(segs[0]);
  const rest = segs.slice(1);
  if (rest.length === 0) {
    return { kind: "library", hostname, sitePath, driveName };
  }
  const last = rest[rest.length - 1];
  // Heuristic: a final segment with an extension we recognise as a
  // doc file means "this URL points at a single file." Anything
  // else is treated as a folder. (SharePoint URLs don't carry a
  // trailing slash to disambiguate folders from files.)
  const isFile = /\.[a-z0-9]{1,8}$/i.test(last);
  if (isFile) {
    return {
      kind: "file",
      hostname,
      sitePath,
      driveName,
      itemPath: "/" + rest.join("/"),
    };
  }
  return {
    kind: "folder",
    hostname,
    sitePath,
    driveName,
    folderPath: "/" + rest.join("/"),
  };
}

function normalizeDriveName(name: string): string | undefined {
  return DEFAULT_LIBRARY_URL_SEGMENTS.has(name) ? undefined : name;
}

/**
 * Base64-url encode a share URL into the `u!{b64}` form Graph's
 * `/shares` endpoint accepts:
 *
 *     1. base64 the URL
 *     2. trim trailing `=` padding
 *     3. swap `/` → `_` and `+` → `-`
 *     4. prefix with `u!`
 *
 * Used by the (Graph-call-required) follow-up to resolve opaque
 * `/:X:/s/...` share links into a real driveItem we can then store
 * as a pin.
 */
export function encodeShareUrlForGraph(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  const urlSafe = b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${urlSafe}`;
}
