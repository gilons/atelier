import { classifyDocUrl, type ClassifiedDocUrl } from "./url-classifier.js";
import { listSources, updateSource, SourceNotFoundError } from "./sources.js";
import { buildTokenProviderFromCredentials } from "./adapters/sharepoint-auth.js";
import { resolveOpaqueShareUrl } from "./adapters/sharepoint-search.js";
import { syncWorkspace, type SyncReport } from "./sync.js";
import type {
  SharePointPin,
  SharePointScope,
} from "./adapters/sharepoint.js";
import type {
  GitHubDiscussionsScope,
} from "./adapters/github-discussions.js";
import type { Source } from "./types.js";

/**
 * URL-based document tracking.
 *
 * `/doc add <url>` (CLI: `atelier doc add <url>`) is the user-facing
 * entry point — they paste a URL and Atelier figures out which
 * registered source it belongs to, appends a pin to that source's
 * scope, then runs a one-source sync to materialize the doc in the
 * doc map.
 *
 * Design notes:
 *
 *   - The classifier (see `url-classifier.ts`) is hostname-based and
 *     fully local — no network needed to pick a kind. That keeps the
 *     "I just want to add this doc" flow snappy.
 *
 *   - For direct SharePoint URLs (file/folder) we can build the pin
 *     entirely from the parsed URL — no Graph call. Only opaque share
 *     URLs (the `/:b:/s/...` tokenized form) require a single Graph
 *     `/shares` round-trip to resolve to a driveItem.
 *
 *   - GitHub Discussions URLs need no network at all — the docId is
 *     `owner/name#number`, derivable from the URL itself.
 *
 *   - Source selection is the caller's responsibility. This module
 *     surfaces candidates; the CLI shows a picker when there are
 *     multiple. That keeps interactive UI out of the core layer.
 */

export class NoMatchingSourceError extends Error {
  constructor(
    public readonly kind: string,
    public readonly hostname: string | undefined,
    public readonly hint: string
  ) {
    super(
      hostname
        ? `No registered ${kind} source for hostname "${hostname}". ${hint}`
        : `No registered ${kind} source. ${hint}`
    );
    this.name = "NoMatchingSourceError";
  }
}

export class UnsupportedDocUrlError extends Error {
  constructor(public readonly url: string, message: string) {
    super(message);
    this.name = "UnsupportedDocUrlError";
  }
}

export interface DocUrlCandidates {
  /** The pasted URL, normalized. */
  url: string;
  /** Classifier output for downstream branching. */
  classified: ClassifiedDocUrl;
  /** Sources that could own this URL — caller picks one. */
  candidates: Source[];
}

/**
 * Inspect a URL and find the registered sources that could own it.
 * Returned candidates are pre-filtered by kind + (for SharePoint)
 * hostname; the caller decides how to pick when there are 2+.
 *
 * Throws {@link UnsupportedDocUrlError} when the URL is malformed or
 * its shape doesn't yet map to a supported source (e.g. a SharePoint
 * site root, or a github.com URL that isn't a discussion thread).
 *
 * Throws {@link NoMatchingSourceError} when the URL is recognized
 * but no compatible source is registered.
 */
export async function resolveDocUrlCandidates(
  workspaceRoot: string,
  rawUrl: string
): Promise<DocUrlCandidates> {
  const url = rawUrl.trim();
  if (!url) {
    throw new UnsupportedDocUrlError(rawUrl, "Empty URL.");
  }
  const classified = classifyDocUrl(url);
  if (classified.kind === "unknown") {
    throw new UnsupportedDocUrlError(
      url,
      `Couldn't classify "${url}" as a known source. Recognised forms: ` +
        `https://<tenant>.sharepoint.com/... (SharePoint), ` +
        `https://github.com/<owner>/<repo>/discussions/<n> (GitHub Discussions).`
    );
  }
  const sources = await listSources(workspaceRoot);

  if (classified.kind === "sharepoint") {
    const r = classified.resolved;
    // Reject targets that can't become a pin: a bare site root or
    // a library root pulls everything under it, which is the
    // exact "let's pull the world" UX we're moving away from.
    // Folder, file, and opaque-share all map cleanly to pins.
    if (r.kind === "site") {
      throw new UnsupportedDocUrlError(
        url,
        `URL points at a SharePoint site root. Paste a link to a specific document or folder instead — that's the unit Atelier tracks.`
      );
    }
    if (r.kind === "library") {
      throw new UnsupportedDocUrlError(
        url,
        `URL points at a SharePoint library root. Drill into a specific folder or file and paste that link instead.`
      );
    }
    const hostMatches = sources.filter(
      (s) =>
        s.kind === "sharepoint" &&
        getSharePointHostname(s) === classified.hostname
    );
    if (hostMatches.length === 0) {
      throw new NoMatchingSourceError(
        "sharepoint",
        classified.hostname,
        "Run `/source onboard sharepoint` first — Atelier needs credentials for that tenant before it can fetch this document."
      );
    }
    return { url, classified, candidates: hostMatches };
  }

  // github-discussions
  const ghMatches = sources.filter((s) => s.kind === "github-discussions");
  if (ghMatches.length === 0) {
    throw new NoMatchingSourceError(
      "github-discussions",
      undefined,
      "Run `/source onboard github-discussions` first — Atelier needs the source registered before it can track a discussion."
    );
  }
  // Prefer sources whose `scope.repos` already includes the
  // owner/repo. Lets a user with one source per project paste
  // a URL and have the right home picked automatically.
  const preferred = ghMatches.filter((s) => {
    const scope = (s.scope ?? {}) as Partial<GitHubDiscussionsScope>;
    const repos = scope.repos ?? [];
    const owned = `${classified.owner}/${classified.repo}`;
    return repos.includes(owned);
  });
  return {
    url,
    classified,
    candidates: preferred.length > 0 ? preferred : ghMatches,
  };
}

export interface AddDocByUrlResult {
  /** The source we mutated. */
  source: Source;
  /** Was this URL already pinned? (Then we skipped the write.) */
  alreadyPinned: boolean;
  /** docId we expect to see in the doc map after sync. */
  docId: string;
  /** Sync report — undefined if `runSync: false`. */
  sync?: SyncReport;
}

export interface AddDocByUrlOptions {
  /**
   * Source to write the pin into. Caller picks this from
   * `resolveDocUrlCandidates(...).candidates`. If you already know
   * the URL is supported and there's exactly one candidate, you can
   * skip the pre-call and pass the source straight in.
   */
  source: Source;
  /**
   * After writing the pin, run sync filtered to this source so the
   * new doc lands in the doc map. Defaults to true. Tests can pass
   * false to assert pin shape without the sync engine in the loop.
   */
  runSync?: boolean;
}

/**
 * Append a pin derived from the URL into the source's scope and
 * (optionally) run a one-source sync so the doc materializes in the
 * doc map.
 *
 * The URL → pin mapping is:
 *
 *   SharePoint file URL    → file pin (sitePath / driveName / itemPath)
 *   SharePoint folder URL  → folder pin (sitePath / driveName / folderPath)
 *   SharePoint opaque share→ driveItem pin (resolved via Graph /shares)
 *   GitHub Discussion URL  → append to scope.discussionIds + ensure
 *                             owner/repo in scope.repos
 *
 * Duplicate pins are detected (by a kind-specific key) and silently
 * skipped — the operation is idempotent.
 */
export async function addDocByUrl(
  workspaceRoot: string,
  rawUrl: string,
  opts: AddDocByUrlOptions
): Promise<AddDocByUrlResult> {
  const { source } = opts;
  const runSync = opts.runSync ?? true;
  const url = rawUrl.trim();
  const classified = classifyDocUrl(url);
  if (classified.kind === "unknown") {
    throw new UnsupportedDocUrlError(url, `URL "${url}" is not recognized.`);
  }
  if (classified.kind === "sharepoint" && source.kind === "sharepoint") {
    return await addSharePointPin(workspaceRoot, source, classified, runSync);
  }
  if (
    classified.kind === "github-discussions" &&
    source.kind === "github-discussions"
  ) {
    return await addGitHubDiscussionPin(workspaceRoot, source, classified, runSync);
  }
  throw new UnsupportedDocUrlError(
    url,
    `URL kind "${classified.kind}" doesn't match source kind "${source.kind}".`
  );
}

// ============================================================
// SharePoint
// ============================================================

async function addSharePointPin(
  workspaceRoot: string,
  source: Source,
  classified: Extract<ClassifiedDocUrl, { kind: "sharepoint" }>,
  runSync: boolean
): Promise<AddDocByUrlResult> {
  const scope = (source.scope ?? {}) as Partial<SharePointScope>;
  if (!scope.hostname) {
    throw new UnsupportedDocUrlError(
      classified.resolved.kind,
      `Source "${source.id}" is missing scope.hostname. Re-run /source onboard sharepoint to fix.`
    );
  }
  const r = classified.resolved;
  let pin: SharePointPin;
  let docIdHint = "";
  if (r.kind === "file") {
    pin = {
      kind: "file",
      sitePath: r.sitePath,
      driveName: r.driveName,
      itemPath: r.itemPath,
    };
    docIdHint = `${r.sitePath}${r.itemPath}`;
  } else if (r.kind === "folder") {
    pin = {
      kind: "folder",
      sitePath: r.sitePath,
      driveName: r.driveName,
      folderPath: r.folderPath,
      recursive: true,
    };
    docIdHint = `${r.sitePath}${r.folderPath}/*`;
  } else if (r.kind === "opaqueShare") {
    // The opaque tokenized share URL — needs a Graph /shares lookup
    // to resolve to a driveItem. We mint a token using the same
    // credentials path the adapter uses at sync time so anything
    // that works for sync works here too.
    const tokenProvider = buildTokenProviderFromCredentials(
      source.credentials,
      { sourceId: source.id }
    );
    const token = await tokenProvider.getToken();
    const item = await resolveOpaqueShareUrl(token, r.url);
    pin = {
      kind: "driveItem",
      driveId: item.driveId,
      itemId: item.itemId,
      name: item.name,
    };
    docIdHint = `${item.driveId}::${item.itemId}`;
  } else {
    // site / library — already rejected upstream, but keep this
    // exhaustive for type narrowing.
    throw new UnsupportedDocUrlError(
      classified.resolved.kind,
      `Cannot pin a SharePoint ${r.kind} — paste a folder or file URL instead.`
    );
  }

  const existingPins = scope.pins ?? [];
  const newKey = sharePointPinKey(pin);
  const alreadyPinned = existingPins.some((p) => sharePointPinKey(p) === newKey);
  if (alreadyPinned) {
    return {
      source,
      alreadyPinned: true,
      docId: docIdHint,
      sync: runSync ? await syncWorkspace(workspaceRoot, { source: source.id }) : undefined,
    };
  }
  const nextScope: Record<string, unknown> = {
    ...scope,
    hostname: scope.hostname,
    pins: [...existingPins, pin],
  };
  const updated: Source = { ...source, scope: nextScope };
  const persisted = await persistSource(workspaceRoot, source.id, updated);
  return {
    source: persisted,
    alreadyPinned: false,
    docId: docIdHint,
    sync: runSync ? await syncWorkspace(workspaceRoot, { source: source.id }) : undefined,
  };
}

function sharePointPinKey(p: SharePointPin): string {
  if (p.kind === "driveItem") return `di:${p.driveId}:${p.itemId}`;
  if (p.kind === "file") {
    return `f:${p.sitePath}:${p.driveName ?? ""}:${p.itemPath}`;
  }
  return `fo:${p.sitePath}:${p.driveName ?? ""}:${p.folderPath}`;
}

function getSharePointHostname(s: Source): string | undefined {
  const scope = (s.scope ?? {}) as Partial<SharePointScope>;
  return scope.hostname;
}

// ============================================================
// GitHub Discussions
// ============================================================

async function addGitHubDiscussionPin(
  workspaceRoot: string,
  source: Source,
  classified: Extract<ClassifiedDocUrl, { kind: "github-discussions" }>,
  runSync: boolean
): Promise<AddDocByUrlResult> {
  const scope = (source.scope ?? {}) as Partial<GitHubDiscussionsScope>;
  const repo = `${classified.owner}/${classified.repo}`;
  const docId = classified.docId;
  const repos = scope.repos ?? [];
  const discussionIds = scope.discussionIds ?? [];

  const repoIncluded = repos.includes(repo);
  const idIncluded = discussionIds.includes(docId);

  // Already-fully-pinned: this exact discussion is in scope.discussionIds.
  // OR the source covers the whole repo (no discussionIds whitelist) AND
  // we wouldn't be narrowing it by adding the id — that case we just
  // run the sync; the doc will land in the doc map naturally.
  const fullRepoCoverage =
    repoIncluded && discussionIds.length === 0;
  if (idIncluded || fullRepoCoverage) {
    return {
      source,
      alreadyPinned: idIncluded,
      docId,
      sync: runSync ? await syncWorkspace(workspaceRoot, { source: source.id }) : undefined,
    };
  }

  const nextScope: Record<string, unknown> = {
    ...scope,
    repos: repoIncluded ? repos : [...repos, repo],
    discussionIds: [...discussionIds, docId],
  };
  if (scope.categories) nextScope.categories = scope.categories;
  if (scope.maxPerRepo) nextScope.maxPerRepo = scope.maxPerRepo;
  if (scope.includeClosed !== undefined) nextScope.includeClosed = scope.includeClosed;

  const updated: Source = { ...source, scope: nextScope };
  const persisted = await persistSource(workspaceRoot, source.id, updated);
  return {
    source: persisted,
    alreadyPinned: false,
    docId,
    sync: runSync ? await syncWorkspace(workspaceRoot, { source: source.id }) : undefined,
  };
}

// ============================================================
// Persistence helper
// ============================================================

async function persistSource(
  workspaceRoot: string,
  id: string,
  next: Source
): Promise<Source> {
  try {
    return await updateSource(workspaceRoot, id, next);
  } catch (err) {
    if (err instanceof SourceNotFoundError) {
      // The source vanished between our list and update — very
      // unlikely (single-process, single workspace), but a clearer
      // error is friendlier than the bare ENOENT/validation noise.
      throw new Error(
        `Source "${id}" was removed during /doc add. Re-run /source list to confirm and retry.`
      );
    }
    throw err;
  }
}
