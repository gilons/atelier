import {
  resolveSharePointLink,
  InvalidSharePointUrlError,
  type SharePointLinkResolution,
} from "./adapters/sharepoint-resolve.js";

/**
 * Classify an arbitrary URL pasted by the user into a known
 * source kind. The `/doc add <url>` command uses this to route
 * the URL to the right adapter without making the user pick
 * which source it belongs to.
 *
 * The classifier is hostname-based and zero-network — we don't
 * call Graph / GitHub / Notion to confirm; we just look at the
 * URL's shape. Concrete resolution (e.g. resolving a SharePoint
 * URL to a driveItem id) happens later, after we've matched the
 * URL to a registered source.
 *
 * Extending this: drop a new branch in `classifyDocUrl` for the
 * kind you're adding. Tests in `url-classifier.test.js` should
 * cover every URL shape you accept (and at least one you don't).
 */

export type ClassifiedDocUrl =
  | {
      kind: "sharepoint";
      hostname: string;
      /** Local URL parse — file/folder/site/library/etc. */
      resolved: SharePointLinkResolution;
    }
  | {
      kind: "github-discussions";
      /** Owner part of `owner/name`. */
      owner: string;
      /** Repo name (no owner). */
      repo: string;
      /** Discussion number from the URL. */
      number: number;
      /** Canonical docId atelier persists. */
      docId: string;
    }
  | {
      kind: "unknown";
      /** The original URL, surfaced back so error messages can quote it. */
      url: string;
      /** Best-effort hostname for debug output, may be empty. */
      hostname: string;
    };

export function classifyDocUrl(input: string): ClassifiedDocUrl {
  const url = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unknown", url, hostname: "" };
  }
  const host = parsed.hostname.toLowerCase();

  // SharePoint / OneDrive — any *.sharepoint.com hostname. The
  // local link resolver knows the URL shapes; we just forward.
  if (host.endsWith(".sharepoint.com")) {
    try {
      const resolved = resolveSharePointLink(url);
      return { kind: "sharepoint", hostname: resolved.hostname, resolved };
    } catch (err) {
      if (err instanceof InvalidSharePointUrlError) {
        return { kind: "unknown", url, hostname: host };
      }
      throw err;
    }
  }

  // GitHub Discussions — github.com/<owner>/<repo>/discussions/<N>.
  if (host === "github.com" || host === "www.github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/discussions\/(\d+)/.exec(parsed.pathname);
    if (m) {
      const owner = m[1];
      const repo = m[2];
      const number = Number(m[3]);
      return {
        kind: "github-discussions",
        owner,
        repo,
        number,
        docId: `${owner}/${repo}#${number}`,
      };
    }
  }

  return { kind: "unknown", url, hostname: host };
}
